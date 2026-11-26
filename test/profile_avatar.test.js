'use strict';
// POST /profile/avatar — the lightweight picture push.
//
// A profile edit used to run a full scoring round on both boards. This route
// must touch ONLY the avatar, and only on rows that already exist: it must never
// put an account on a board it never joined, never create a league row for a
// non-member, and never write into a week the row does not belong to.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const lb = require('../leaderboard');

// ── In-memory Firestore (honours merge, unlike a plain overwrite) ────────
const store = new Map(); // "collection/doc/..." -> data

function mergeInto(path, data, opts) {
  const merged = opts && opts.merge
    ? { ...(store.get(path) || {}), ...data }
    : { ...data };
  store.set(path, merged);
}

function docRef(path) {
  return {
    path,
    id: path.split('/').pop(),
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data, opts) {
      mergeInto(path, data, opts);
    },
    async delete() {
      store.delete(path);
    },
    collection: (name) => collectionRef(path + '/' + name),
  };
}

function collectionRef(path) {
  return {
    doc: (id) => docRef(path + '/' + id),
    async get() {
      const prefix = path + '/';
      const docs = [];
      for (const [key, data] of store) {
        if (!key.startsWith(prefix)) continue;
        if (key.slice(prefix.length).includes('/')) continue;
        docs.push({ id: key.slice(prefix.length), data: () => data });
      }
      return { docs, empty: docs.length === 0 };
    },
  };
}

const db = {
  collection: (name) => collectionRef(name),
  batch() {
    const ops = [];
    return {
      set(ref, data, opts) {
        ops.push(() => mergeInto(ref.path, data, opts));
      },
      delete(ref) {
        ops.push(() => store.delete(ref.path));
      },
      async commit() {
        ops.forEach((op) => op());
      },
    };
  },
};

const firestoreStub = {
  init: () => true,
  isEnabled: () => true,
  getAdmin: () => null,
  resolveUid: async () => 'uid1',
  getDb: () => db,
  async get(path) {
    return store.get(path) || null;
  },
  async set(path, data, opts) {
    mergeInto(path, data, opts);
    return true;
  },
  async del(path) {
    store.delete(path);
    return true;
  },
};

const routes = { get: {}, post: {} };
const appStub = {
  use: () => {},
  get: (p, ...fns) => {
    routes.get[p] = fns[fns.length - 1];
  },
  post: (p, ...fns) => {
    routes.post[p] = fns[fns.length - 1];
  },
  delete: () => {},
  listen: () => {},
};
function express() {
  return appStub;
}
const passThrough = () => (req, res, next) => next();
express.json = passThrough;
express.raw = passThrough;
express.text = passThrough;
express.urlencoded = passThrough;
express.static = () => () => {};

const origLoad = Module._load;
Module._load = function (request) {
  switch (request) {
    case 'dotenv':
      return { config: () => ({}) };
    case 'express':
      return express;
    case 'multer':
      return Object.assign(() => ({ single: () => (r, s, n) => n() }), {
        memoryStorage: () => ({}),
      });
    case 'sharp':
      return () => ({
        rotate: () => ({
          resize: () => ({ jpeg: () => ({ toBuffer: async () => Buffer.from('') }) }),
        }),
      });
    case 'pg':
      return {
        Pool: class {
          query() {
            return { rows: [] };
          }
        },
      };
    case './firestore':
      return firestoreStub;
    case './auth':
      return {
        requireAuth: (req, res, next) => next(),
        identityOf: () => ({ uid: 'uid1', isAdmin: false }),
      };
    default:
      return origLoad.apply(this, arguments);
  }
};

require('../server.js');
Module._load = origLoad;

function makeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (o) => {
    res.body = o;
    return res;
  };
  return res;
}

async function pushAvatar(avatar) {
  const res = makeRes();
  // The handler is async: awaiting it is what makes its writes and its
  // response visible to the assertions below.
  await routes.post['/profile/avatar']({ body: { avatar }, headers: {} }, res);
  return res;
}

const WEEK = lb.isoWeek().week;
const LAST_WEEK = '2020-W01';
const STATE = 'maharashtra';
const DISTRICT = 'pune';

function boardPath(scope) {
  return `leaderboard/${WEEK}/scopes/${scope}/entries/uid1`;
}

function seedJoined(week = WEEK) {
  store.set('leaderboardMeta/uid1', {
    week,
    stateKey: STATE,
    districtKey: DISTRICT,
    joined: true,
    name: 'Sanjay',
    avatar: '',
  });
  for (const scope of lb.boardsFor(STATE, DISTRICT)) {
    store.set(`leaderboard/${week}/scopes/${scope}/entries/uid1`, {
      uid: 'uid1',
      name: 'Sanjay',
      avatar: '',
      points: 72,
      week,
      scope,
    });
  }
}

beforeEach(() => store.clear());

test('a joined account gets the new picture on all three board rows', async () => {
  seedJoined();
  const res = await pushAvatar('art:panda');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, boards: 3, leagues: 0 });
  for (const scope of lb.boardsFor(STATE, DISTRICT)) {
    const row = store.get(boardPath(scope));
    assert.equal(row.avatar, 'art:panda', scope);
    // The picture push must not disturb the score or the unique name.
    assert.equal(row.points, 72, scope);
    assert.equal(row.name, 'Sanjay', scope);
  }
  assert.equal(store.get('leaderboardMeta/uid1').avatar, 'art:panda');
});

test('an account that never joined writes nothing and joins nothing', async () => {
  store.set('leaderboardMeta/uid1', {
    week: WEEK,
    stateKey: STATE,
    districtKey: DISTRICT,
    joined: false,
  });
  const res = await pushAvatar('art:panda');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, boards: 0, leagues: 0 });
  assert.equal(store.get('leaderboardMeta/uid1').avatar, undefined);
  for (const scope of lb.boardsFor(STATE, DISTRICT)) {
    assert.equal(store.get(boardPath(scope)), undefined);
  }
});

test('a row from an earlier week is left alone', async () => {
  seedJoined(LAST_WEEK);
  const res = await pushAvatar('art:cat');
  assert.deepEqual(res.body, { ok: true, boards: 0, leagues: 0 });
  for (const scope of lb.boardsFor(STATE, DISTRICT)) {
    const old = store.get(`leaderboard/${LAST_WEEK}/scopes/${scope}/entries/uid1`);
    assert.equal(old.avatar, '', 'an old week must not be rewritten');
    assert.equal(store.get(boardPath(scope)), undefined);
  }
});

test('league membership and the week row are updated, a non-member is not', async () => {
  store.set('friendIndex/uid1', { ids: ['leagueA', 'leagueB'] });
  store.set('friendLeagues/leagueA/members/uid1', {
    uid: 'uid1',
    name: 'Sanjay',
    avatar: '',
  });
  store.set(`friendLeagues/leagueA/weeks/${WEEK}/entries/uid1`, {
    uid: 'uid1',
    name: 'Sanjay',
    avatar: '',
    points: 30,
  });
  // leagueB is listed in the index but has no member document for this uid.
  store.set('friendLeagues/leagueB', { name: 'Old league', memberCount: 2 });

  const res = await pushAvatar('art:shade-violet');
  assert.deepEqual(res.body, { ok: true, boards: 0, leagues: 1 });
  assert.equal(store.get('friendLeagues/leagueA/members/uid1').avatar, 'art:shade-violet');
  const row = store.get(`friendLeagues/leagueA/weeks/${WEEK}/entries/uid1`);
  assert.equal(row.avatar, 'art:shade-violet');
  assert.equal(row.points, 30, 'the score must survive a picture change');
  assert.equal(store.get('friendLeagues/leagueB/members/uid1'), undefined);
});

test('a value the app must not publish is stored as no picture', async () => {
  seedJoined();
  await pushAvatar('javascript:alert(1)');
  assert.equal(store.get(boardPath('india')).avatar, '');
});
