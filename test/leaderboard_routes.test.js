'use strict';
// Route tests for the server-scored leaderboard: /leaderboard/sync,
// /leaderboard/leave and /cron/leaderboard-gc.
//
// The express app is stubbed the same way the other suites do it — only the
// LAST handler of each route is captured, so auth and rate limiting (which need
// the Firebase Admin SDK) are out of the way and the route body is what runs.
//
// Run: node --test test/
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
      const query = {
        async get() {
          return {
            docs: docsUnder(path).filter(
              (d) => (d.data() || {})[field] === value
            ),
          };
        },
      };
      return query;
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
  delete: (p, ...fns) => {},
  listen: () => {},
};
function express() {
  return appStub;
}
express.json = () => (req, res, next) => next();
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
      return () => ({ rotate: () => ({ resize: () => ({ jpeg: () => ({ toBuffer: async () => Buffer.from('') }) }) }) });
    case 'pg':
      return { Pool: class { query() { return { rows: [] }; } } };
    case './firestore':
      return firestoreStub;
    case './auth':
      return {
        requireAuth: (req, res, next) => next(),
        identityOf: () => ({
          uid: 'uid1',
          identifier: 'a@example.com',
          phone: null,
          email: 'a@example.com',
          isAdmin: false,
        }),
      };
    default:
      return origLoad.apply(this, arguments);
  }
};

process.env.CRON_SECRET = 'test-cron-secret';
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

function makeReq(body, headers) {
  return { body: body || {}, headers: headers || {}, query: {}, params: {} };
}

function mealDoc(date, calories) {
  return { uid: 'uid1', date, calories, name: 'Test meal' };
}

beforeEach(() => {
  store.clear();
  store.set('users/uid1', { identifier: 'a@example.com', name: 'Asha' });
});

test('sync scores meals, habits and water from Firestore, not the client', async () => {
  const today = lb.todayKey();
  store.set('meals/m1', mealDoc(today + 'T09:00:00.000', 600));
  store.set('meals/m2', mealDoc(today + 'T13:00:00.000', 600));
  store.set('meals/m3', mealDoc(today + 'T20:00:00.000', 600));
  store.set('habitData/uid1', {
    habits: [
      { completedDates: [today] },
      { completedDates: [today] },
      { completedDates: [today] },
    ],
    waterLog: { [today]: 8 },
    waterGoal: 8,
  });

  const res = makeRes();
  await routes.post['/leaderboard/sync'](
    makeReq({
      name: 'Asha',
      stateKey: 'maharashtra',
      districtKey: 'pune',
      days: [{ dateKey: today, steps: 12000, stepGoal: 10000, weighIn: true }],
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.week, /^\d{4}-W\d{2}$/);

  // Meals 30 + habits 15 + water 10 + steps 20 + weigh-in 5 = 80.
  assert.equal(res.body.points, 80);
  assert.deepEqual(res.body.scopes, [
    'india',
    'state_maharashtra',
    'district_maharashtra_pune',
  ]);
  assert.equal(res.body.name, 'Asha');

  // Three board rows, all server-written.
  for (const scope of res.body.scopes) {
    const entry = store.get(
      `leaderboard/${res.body.week}/scopes/${scope}/entries/uid1`
    );
    assert.ok(entry, `missing entry for ${scope}`);
    assert.equal(entry.points, 80);
    assert.equal(entry.name, 'Asha');
    assert.equal(entry.uid, 'uid1');
  }
});

test('client-claimed meals do not count when Firestore has none', async () => {
  const today = lb.todayKey();
  const res = makeRes();
  await routes.post['/leaderboard/sync'](
    makeReq({
      name: 'Asha',
      stateKey: 'maharashtra',
      districtKey: 'pune',
      days: [{ dateKey: today, meals: 3, habits: 3, water: 8, weighIn: true }],
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  // No meals, habits or water in Firestore → only the weigh-in scores.
  assert.equal(res.body.points, 5);
});

test('an absurd step count cannot exceed the daily cap', async () => {
  const today = lb.todayKey();
  const res = makeRes();
  await routes.post['/leaderboard/sync'](
    makeReq({
      stateKey: 'maharashtra',
      districtKey: 'pune',
      days: [{ dateKey: today, steps: 200000, stepGoal: 5000 }],
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  const todayPoints = res.body.dayPoints.find((d) => d.dateKey === today);
  // `stepCeiling()` trims whatever the phone claims, and no day can out-score
  // the per-day maximum, so a doctored payload cannot buy extra points.
  assert.ok(todayPoints.points <= lb.DAILY_MAX);
});

test('sync rejects a missing or unknown area', async () => {
  for (const body of [
    { name: 'Asha' },
    { name: 'Asha', stateKey: 'atlantis', districtKey: 'pune' },
    { name: 'Asha', stateKey: 'maharashtra' },
  ]) {
    const res = makeRes();
    await routes.post['/leaderboard/sync'](makeReq(body), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'area_required');
  }
});

test('moving district three times in a week is refused', async () => {
  const today = lb.todayKey();
  const week = lb.isoWeek().week;
  store.set('leaderboardMeta/uid1', {
    week,
    stateKey: 'maharashtra',
    districtKey: 'pune',
    moves: 3,
    name: 'Asha',
  });

  const res = makeRes();
  await routes.post['/leaderboard/sync'](
    makeReq({
      name: 'Asha',
      stateKey: 'maharashtra',
      districtKey: 'nagpur',
      days: [{ dateKey: today, weighIn: true }],
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.locationLocked, true);
  assert.equal(res.body.districtKey, 'pune');
  assert.ok(
    store.get(`leaderboard/${week}/scopes/district_maharashtra_pune/entries/uid1`)
  );
  assert.equal(
    store.get(`leaderboard/${week}/scopes/district_maharashtra_nagpur/entries/uid1`),
    undefined
  );
});

test('leave removes every entry for this week', async () => {
  const week = lb.isoWeek().week;
  for (const scope of ['india', 'state_maharashtra', 'district_maharashtra_pune']) {
    store.set(`leaderboard/${week}`, { week });
    store.set(`leaderboard/${week}/scopes/${scope}`, { scope, week });
    store.set(`leaderboard/${week}/scopes/${scope}/entries/uid1`, {
      uid: 'uid1',
      points: 10,
    });
  }
  store.set('leaderboardMeta/uid1', { week, stateKey: 'maharashtra' });

  const res = makeRes();
  await routes.post['/leaderboard/leave'](makeReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(
    store.get(`leaderboard/${week}/scopes/india/entries/uid1`),
    undefined
  );
  assert.equal(store.get('leaderboardMeta/uid1'), undefined);
});

test('the cleanup cron fails closed without the secret', async () => {
  const res = makeRes();
  await routes.get['/cron/leaderboard-gc'](makeReq({}, {}), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'forbidden');
});

test('the cleanup cron deletes boards older than four weeks', async () => {
  const today = lb.todayKey();
  const oldWeek = lb.isoWeek(Date.now() - 60 * 24 * 3600 * 1000).week;
  const thisWeek = lb.isoWeek().week;
  store.set(`leaderboard/${oldWeek}`, { week: oldWeek });
  store.set(`leaderboard/${thisWeek}`, { week: thisWeek });
  store.set(`leaderboard/${oldWeek}/scopes/india/entries/uid1`, {
    uid: 'uid1',
    points: 5,
  });
  store.set(`leaderboard/${thisWeek}/scopes/india/entries/uid1`, {
    uid: 'uid1',
    points: 5,
  });

  const res = makeRes();
  await routes.get['/cron/leaderboard-gc'](
    makeReq({}, { 'x-cron-secret': 'test-cron-secret' }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.deleted, [oldWeek]);
  assert.equal(
    store.get(`leaderboard/${oldWeek}/scopes/india/entries/uid1`),
    undefined
  );
  assert.ok(store.get(`leaderboard/${thisWeek}/scopes/india/entries/uid1`));
  assert.ok(today);
});
