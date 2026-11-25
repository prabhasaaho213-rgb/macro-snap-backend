'use strict';
// Route tests for private friends leagues (Pro): create, join, list, sync,
// leave.
//
// Same harness as test/leaderboard_routes.test.js: the express app is stubbed
// so only the LAST handler of each route is captured (auth and rate limiting
// need the Firebase Admin SDK), and Firestore is an in-memory Map.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const lb = require('../leaderboard');

// ── In-memory Firestore ─────────────────────────────────────────────────
const store = new Map(); // "collection/doc/..." -> data

function docsUnder(path) {
  const prefix = path + '/';
  const out = [];
  for (const [key, data] of store) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest.includes('/')) continue; // subcollection, not a document here
    out.push({ id: rest, data: () => data, ref: docRef(key) });
  }
  return out;
}

function docRef(path) {
  return {
    path,
    id: path.split('/').pop(),
    async get() {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data) {
      store.set(path, { ...data });
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
      return { docs: docsUnder(path), empty: docsUnder(path).length === 0 };
    },
    where(field, _op, value) {
      return {
        async get() {
          return {
            docs: docsUnder(path).filter(
              (d) => (d.data() || {})[field] === value
            ),
          };
        },
      };
    },
  };
}

const db = {
  collection: (name) => collectionRef(name),
  batch() {
    const ops = [];
    return {
      set(ref, data) {
        ops.push(() => store.set(ref.path, { ...data }));
      },
      delete(ref) {
        ops.push(() => store.delete(ref.path));
      },
      async commit() {
        ops.forEach((op) => op());
      },
    };
  },
  async recursiveDelete(ref) {
    const prefix = ref.path + '/';
    for (const key of [...store.keys()]) {
      if (key === ref.path || key.startsWith(prefix)) store.delete(key);
    }
  },
};

const firestoreStub = {
  init: () => true,
  isEnabled: () => true,
  getDb: () => db,
  getAdmin: () => null,
  resolveUid: async () => 'uid1',
  async get(path) {
    return store.get(path) || null;
  },
  async set(path, data) {
    store.set(path, { ...(store.get(path) || {}), ...(data || {}) });
    return true;
  },
  async del(path) {
    store.delete(path);
    return true;
  },
};

// ── express stub: capture the handler that does the work ────────────────
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
express.json = () => (req, res, next) => next();
express.static = () => () => {};

// The caller's verified identity. Tests switch it to act as a second account.
let currentIdentity = null;
function asUser(uid, email) {
  currentIdentity = {
    uid,
    identifier: email,
    phone: null,
    email,
    emailVerified: true,
    isAdmin: false,
  };
}

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
        identityOf: () => currentIdentity,
      };
    default:
      return origLoad.apply(this, arguments);
  }
};

require('../server.js');
Module._load = origLoad;

function makeRes() {
  const res = { statusCode: 200, body: undefined };
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

function makeReq(body) {
  return { body: body || {}, headers: {}, query: {}, params: {} };
}

function proUser(uid, name) {
  store.set('users/' + uid, {
    identifier: uid + '@example.com',
    name,
    subscribed: true,
  });
}

async function createLeague(name = 'Gym Buddies') {
  const res = makeRes();
  await routes.post['/friends/league'](
    makeReq({ name, displayName: 'Asha' }),
    res
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.league;
}

beforeEach(() => {
  store.clear();
  asUser('uid1', 'a@example.com');
  proUser('uid1', 'Asha');
});

test('creating a league requires Pro', async () => {
  store.set('users/uid1', { identifier: 'a@example.com', name: 'Asha' });

  const res = makeRes();
  await routes.post['/friends/league'](makeReq({ name: 'Free league' }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'pro_required');
  assert.equal(
    [...store.keys()].some((k) => k.startsWith('friendLeagues/')),
    false,
    'a refused create must not leave a league behind'
  );
});

test('a Pro account can create a league with a shareable code', async () => {
  const res = makeRes();
  await routes.post['/friends/league'](
    makeReq({ name: '  Gym   Buddies ', displayName: 'Asha' }),
    res
  );

  assert.equal(res.statusCode, 200);
  const league = res.body.league;
  assert.equal(league.name, 'Gym Buddies');
  // No 0/O/1/I: the alphabet is meant to be read aloud.
  assert.match(league.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(league.memberCount, 1);
  assert.equal(league.isOwner, true);
  assert.equal(league.rank, 1);
  assert.equal(league.rows.length, 1);
  assert.equal(league.rows[0].isMe, true);
  assert.equal(league.rows[0].name, 'Asha');

  assert.ok(store.get('friendLeagues/' + league.id));
  assert.ok(store.get('friendLeagues/' + league.id + '/members/uid1'));
  assert.equal(store.get('friendCodes/' + league.code).leagueId, league.id);
  assert.deepEqual(store.get('friendIndex/uid1').ids, [league.id]);
});

test('a friend joins with the code, once', async () => {
  const league = await createLeague();
  asUser('uid2', 'b@example.com');
  proUser('uid2', 'Ravi');

  const first = makeRes();
  await routes.post['/friends/join'](
    makeReq({ code: league.code.toLowerCase(), displayName: 'Ravi' }),
    first
  );
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal(first.body.league.memberCount, 2);
  assert.equal(first.body.league.rows.length, 2);
  assert.equal(first.body.league.isOwner, false);
  assert.deepEqual(store.get('friendIndex/uid2').ids, [league.id]);
  assert.equal(store.get('friendLeagues/' + league.id).memberCount, 2);

  // The same code again is a no-op, not a second membership.
  const again = makeRes();
  await routes.post['/friends/join'](makeReq({ code: league.code }), again);
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.alreadyMember, true);
  assert.equal(again.body.league.memberCount, 2);
  assert.deepEqual(store.get('friendIndex/uid2').ids, [league.id]);
});

test('joining needs Pro, a real code and a well-formed one', async () => {
  const league = await createLeague();
  asUser('uid2', 'b@example.com');
  store.set('users/uid2', { identifier: 'b@example.com', name: 'Ravi' });

  const free = makeRes();
  await routes.post['/friends/join'](makeReq({ code: league.code }), free);
  assert.equal(free.statusCode, 403);
  assert.equal(free.body.error, 'pro_required');

  proUser('uid2', 'Ravi');
  const missing = makeRes();
  await routes.post['/friends/join'](makeReq({ code: 'ZZZZZZ' }), missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error, 'code_not_found');

  const malformed = makeRes();
  await routes.post['/friends/join'](makeReq({ code: 'abc' }), malformed);
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.error, 'invalid_code');
});

test('the board is private to its members', async () => {
  const league = await createLeague();
  asUser('uid2', 'b@example.com');
  proUser('uid2', 'Ravi');

  const res = makeRes();
  await routes.get['/friends/leagues'](makeReq(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.leagues, [], 'a non-member sees no league');
  assert.equal(store.get('friendIndex/uid2'), undefined);
});

test('syncing writes one server-scored row per league', async () => {
  const league = await createLeague();
  const today = lb.todayKey();
  store.set('meals/m1', { uid: 'uid1', date: today + 'T09:00:00.000', calories: 500 });
  store.set('meals/m2', { uid: 'uid1', date: today + 'T13:00:00.000', calories: 500 });
  store.set('meals/m3', { uid: 'uid1', date: today + 'T20:00:00.000', calories: 500 });

  const res = makeRes();
  await routes.post['/friends/sync'](
    makeReq({
      name: 'Asha',
      days: [{ dateKey: today, steps: 5000 }],
    }),
    res
  );

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // Meals 30 + 5,000 steps 10 = 40, the same table the public board uses.
  assert.equal(res.body.points, 40);
  assert.equal(res.body.leagues.length, 1);
  assert.equal(res.body.leagues[0].id, league.id);
  assert.equal(res.body.leagues[0].points, 40);
  assert.equal(res.body.leagues[0].rank, 1);

  const entry = store.get(
    `friendLeagues/${league.id}/weeks/${res.body.week}/entries/uid1`
  );
  assert.ok(entry);
  assert.equal(entry.points, 40);
  assert.equal(entry.name, 'Asha');
});

test('leaving hands the league on, and the last member deletes it', async () => {
  const league = await createLeague();
  asUser('uid2', 'b@example.com');
  proUser('uid2', 'Ravi');
  await routes.post['/friends/join'](
    makeReq({ code: league.code, displayName: 'Ravi' }),
    makeRes()
  );

  // The owner leaves: the remaining member inherits it.
  asUser('uid1', 'a@example.com');
  const ownerLeaves = makeRes();
  await routes.post['/friends/leave'](makeReq({ leagueId: league.id }), ownerLeaves);
  assert.equal(ownerLeaves.statusCode, 200);
  assert.equal(ownerLeaves.body.deleted, false);
  assert.equal(store.get('friendLeagues/' + league.id).ownerUid, 'uid2');
  assert.equal(store.get('friendLeagues/' + league.id).memberCount, 1);
  assert.equal(store.get('friendLeagues/' + league.id + '/members/uid1'), undefined);
  assert.deepEqual(store.get('friendIndex/uid1').ids, []);

  // The last member leaves: the league and its code are gone.
  asUser('uid2', 'b@example.com');
  const lastLeaves = makeRes();
  await routes.post['/friends/leave'](makeReq({ leagueId: league.id }), lastLeaves);
  assert.equal(lastLeaves.statusCode, 200);
  assert.equal(lastLeaves.body.deleted, true);
  assert.equal(store.get('friendLeagues/' + league.id), undefined);
  assert.equal(store.get('friendCodes/' + league.code), undefined);
});

test('a removed member cannot write a row back', async () => {
  const league = await createLeague();
  // Simulate a stale index entry on a device that was removed from the group.
  store.delete('friendLeagues/' + league.id + '/members/uid1');

  const res = makeRes();
  await routes.post['/friends/sync'](makeReq({ name: 'Asha', days: [] }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.leagues, []);
  assert.deepEqual(store.get('friendIndex/uid1').ids, []);
});
