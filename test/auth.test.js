'use strict';
// Authentication + server-authoritative scan-limit tests.
//
// Unlike payment/trial_chat, this harness RUNS THE FULL MIDDLEWARE CHAIN for
// every route (express is stubbed to capture all handlers, not just the last
// one), so it proves that:
//   - every backend route the app calls demands a valid Firebase ID token,
//   - a missing / invalid / unverifiable token is a 401,
//   - the account is taken from the token and the client's phone/email/uid is
//     ignored,
//   - /analyze allows 3 free scans per IST day and then 403s, while Pro/admin
//     are unlimited.
//
// Run: node --test test/
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// ── In-memory Firestore + Admin fakes ───────────────────────────────────
const fsDocs = {}; // collection -> docId -> data
const fsSets = []; // every firestore.set(path, data, opts) call
const uidMap = { 'a@example.com': 'uidA', 'b@example.com': 'uidB' };
const firestoreStub = {
  init: () => true,
  isEnabled: () => true,
  resolveUid: async (id) =>
    id && typeof id === 'string' ? uidMap[id.toLowerCase()] || null : null,
  set: async (path, data, opts) => {
    fsSets.push({ path, data, opts });
    const [col, id] = path.split('/');
    fsDocs[col] = fsDocs[col] || {};
    fsDocs[col][id] = { ...(fsDocs[col][id] || {}), ...(data || {}) };
    return true;
  },
  del: async (path) => {
    const [col, id] = path.split('/');
    if (fsDocs[col]) delete fsDocs[col][id];
    return true;
  },
  get: async (path) => {
    const [col, ...rest] = path.split('/');
    const id = rest.join('/');
    const d = (fsDocs[col] || {})[id];
    return d || null;
  },
  getDb: () => ({
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          const d = (fsDocs[name] || {})[id];
          return { exists: !!d, data: () => d || {} };
        },
        // Ref markers so runTransaction's tx.get/tx.set can resolve the doc.
        _col: name,
        _id: id,
      }),
      where: () => ({
        get: async () => ({ empty: true, docs: [] }),
      }),
    }),
    // Single-doc transaction, matching how /analyze and shared rate limits
    // read -> decide -> write against the same in-memory doc.
    runTransaction: async (fn) => {
      const tx = {
        get: async (ref) => {
          const d = (fsDocs[ref._col] || {})[ref._id];
          return { exists: !!d, data: () => d || {} };
        },
        set: async (ref, data, opts) => {
          fsSets.push({ path: `${ref._col}/${ref._id}`, data, opts });
          fsDocs[ref._col] = fsDocs[ref._col] || {};
          fsDocs[ref._col][ref._id] = { ...(fsDocs[ref._col][ref._id] || {}), ...(data || {}) };
        },
      };
      return fn(tx);
    },
  }),
  getAdmin: () => (adminAvailable ? adminStub : null),
};

// Tokens the fake Admin SDK accepts. Anything else is invalid.
// `email_verified: true` mirrors Google sign-in, which always arrives verified.
// The admin Pro override does NOT look at the email at all — it requires the
// `admin` custom claim, which only the Admin SDK can mint.
const tokenClaims = {
  'token-a': { uid: 'uidA', email: 'a@example.com', email_verified: true },
  'token-b': { uid: 'uidB', email: 'b@example.com', email_verified: true },
  'token-phone': { uid: 'uidP', phone_number: '+919000000001' },
};
let adminAvailable = true;
const adminStub = {
  auth: () => ({
    verifyIdToken: async (token) => {
      const claims = tokenClaims[token];
      if (!claims) throw new Error('auth/invalid-id-token');
      return claims;
    },
  }),
};

// ── express / multer / pg / sharp / dotenv fakes ────────────────────────
// The chain is captured in full so the middleware is actually executed.
const routes = { get: {}, post: {}, delete: {}, chains: { get: {}, post: {}, delete: {} } };
const appStub = {
  use: () => {},
  get: (p, ...fns) => {
    routes.get[p] = fns[fns.length - 1];
    routes.chains.get[p] = fns;
  },
  post: (p, ...fns) => {
    routes.post[p] = fns[fns.length - 1];
    routes.chains.post[p] = fns;
  },
  delete: (p, ...fns) => {
    routes['delete'][p] = fns[fns.length - 1];
    routes.chains['delete'][p] = fns;
  },
  listen: () => {},
};
function express() { return appStub; }
express.json = () => (req, res, next) => next();
express.static = () => () => {};
function multer() {
  return {
    single: () => (req, res, next) => {
      req.file = { buffer: Buffer.from('fake-image'), mimetype: 'image/jpeg' };
      next();
    },
  };
}
multer.memoryStorage = () => ({});
const pgStub = { Pool: class { query() { return { rows: [] }; } } };
const sharpStub = (buf) => {
  // Chainable: /analyze's prepareImage uses .jpeg().toBuffer(), the meal-photo
  // uploader uses .rotate().resize(..).jpeg(..).toBuffer(). Both must resolve.
  const chain = {
    rotate() { return chain; },
    resize() { return chain; },
    jpeg: () => ({ toBuffer: async () => buf }),
  };
  return chain;
};

const origLoad = Module._load;
Module._load = function (request) {
  switch (request) {
    case 'dotenv': return { config: () => ({}) };
    case 'express': return express;
    case 'multer': return multer;
    case 'sharp': return sharpStub;
    case 'pg': return pgStub;
    case 'razorpay': return class { constructor() { this.plans = {}; this.subscriptions = {}; this.payments = {}; this.customers = {}; } };
    case './firestore': return firestoreStub;
    default: return origLoad.apply(this, arguments);
  }
};

process.env.GEMINI_KEY = 'test-key';
delete process.env.DATABASE_URL;

// Fake Gemini: every /analyze call returns a confidently-identified dish.
// Named so individual tests can temporarily swap in a low-confidence answer
// and then restore this default.
const origFetch = global.fetch;
const confidentGeminiFetch = async () => ({
  ok: true,
  json: async () => ({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                description: 'poha',
                confidence: 0.92,
                dishes: [
                  {
                    name: 'Poha',
                    portion_description: '1 bowl',
                    calories_per_100g: 130,
                    protein_g_per_100g: 2.6,
                    carbs_g_per_100g: 25,
                    fats_g_per_100g: 3,
                    fiber_g_per_100g: 1,
                    sugar_g_per_100g: 1,
                    suitable_for: 'both',
                  },
                ],
              }),
            },
          ],
        },
      },
    ],
  }),
});
global.fetch = confidentGeminiFetch;

const app = require('../server.js');

beforeEach(() => {
  for (const k of Object.keys(fsDocs)) delete fsDocs[k];
  fsSets.length = 0;
  adminAvailable = true;
});

// ── helpers ─────────────────────────────────────────────────────────────
function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  res.send = (s) => { res.body = s; return res; };
  return res;
}

// `token` undefined = a guest request (no Authorization header at all).
function makeReq({ body, query, params } = {}, token) {
  const headers = {};
  if (token !== undefined && token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  return { body: body || {}, query: query || {}, params: params || {}, headers };
}

// Runs the route's FULL chain. Stops as soon as a handler answers without
// calling next() — exactly how express behaves.
async function callRoute(method, path, req, res) {
  const chain = (routes.chains[method] || {})[path] || [];
  for (const fn of chain) {
    let nexted = false;
    await fn(req, res, () => { nexted = true; });
    if (!nexted) return;
  }
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDay = (t = Date.now()) => new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);

// ── Every backend route requires a valid token ──────────────────────────
// The list is exhaustive on purpose: a new endpoint that forgets requireAuth
// fails this test instead of quietly shipping as an open door.
const PROTECTED = [
  ['post', '/analyze'],
  ['post', '/generate-diet-plan'],
  ['post', '/register'],
  ['get', '/user/profile'],
  ['post', '/referral/generate'],
  ['get', '/me/referral-code'],
  ['post', '/referral/apply'],
  ['get', '/meals/:phone'],
  ['post', '/meals/sync'],
  ['post', '/payment/create-subscription'],
  ['post', '/payment/verify'],
  ['get', '/me/payment/status'],
  ['get', '/payment/status/:phone'],
  ['get', '/me/entitlements'],
  ['get', '/trial/status'],
  ['post', '/account/delete'],
  ['post', '/chat'],
  ['get', '/subscription/status'],
  ['post', '/meals/:mealId/photo'],
  ['get', '/meals/:mealId/photo'],
  ['delete', '/meals/:mealId/photo'],
];

// Routes the audit removed. Kept as a list so a "helpful" re-addition of any
// of them fails the suite below instead of quietly reopening the hole.
const REMOVED = [
  ['post', '/subscribe'], // any signed-in user could self-grant permanent Pro
  ['post', '/unsubscribe'],
  ['get', '/referral/my-code/:phone'],
  ['get', '/meals/list/:phone'],
  ['post', '/meals/remove'],
  ['post', '/habits/sync'],
  ['get', '/habits/list/:phone'],
];

test('auth: removed routes are gone — nothing may re-add them', () => {
  for (const [method, path] of REMOVED) {
    assert.ok(!routes[method][path], `${method.toUpperCase()} ${path} must NOT exist`);
  }
});

test('auth: every protected route is registered and 401s a guest with no token', async () => {
  for (const [method, path] of PROTECTED) {
    assert.ok(routes[method][path], `${method.toUpperCase()} ${path} must be registered`);
    const res = makeRes();
    await callRoute(method, path, makeReq({ body: {}, query: {} }), res);
    assert.equal(res.statusCode, 401, `${method.toUpperCase()} ${path} must reject a guest`);
    assert.equal(res.body.error, 'unauthenticated');
  }
});

test('auth: an invalid or malformed token is a 401', async () => {
  for (const bad of ['not-a-real-token', '', '   ']) {
    const res = makeRes();
    await callRoute('get', '/me/entitlements', makeReq({}, bad), res);
    assert.equal(res.statusCode, 401, `token ${JSON.stringify(bad)} must be rejected`);
  }
  // A non-bearer scheme is not a token either.
  const res = makeRes();
  const req = makeReq({});
  req.headers.authorization = 'Basic dXNlcjpwYXNz';
  await callRoute('get', '/me/entitlements', req, res);
  assert.equal(res.statusCode, 401);
});

test('auth: fails closed when the Admin SDK cannot verify anything', async () => {
  adminAvailable = false;
  const res = makeRes();
  await callRoute('get', '/me/entitlements', makeReq({}, 'token-a'), res);
  assert.equal(res.statusCode, 401, 'no verifier means no access');
  adminAvailable = true;
});

test('auth: a valid token passes and identifies the caller', async () => {
  const res = makeRes();
  await callRoute('get', '/me/entitlements', makeReq({}, 'token-a'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scans_limit, 3);
});

test('auth: the unprotected endpoints stay unprotected', () => {
  // Health check, and the Razorpay webhook (Razorpay's servers call it; it is
  // authenticated by its HMAC signature instead of a Firebase token). A single
  // entry in the chain means "no middleware" — just the handler.
  assert.equal((routes.chains.get['/'] || []).length, 1, 'GET / is a health check');
  assert.equal((routes.chains.post['/payment/webhook'] || []).length, 1,
    'the webhook authenticates by HMAC signature');
});

// ── Client-supplied identity is ignored ─────────────────────────────────
test('auth: a client-sent phone/email can never act as another account', async () => {
  // The trial grant this test used to ride on is gone (trials are removed);
  // the same guarantee now lives in every state-writing route. /me/referral-code
  // mints a code for the TOKEN's user (uidB) and writes it to THEIR doc — a
  // claimed identity in the query must never redirect that write to uidA.
  const res = makeRes();
  await callRoute(
    'get',
    '/me/referral-code',
    makeReq({ query: { phone: 'a@example.com', email: 'a@example.com' } }, 'token-b'),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.ok(fsSets.some((s) => s.path === 'users/uidB'), 'must write the token owner');
  assert.ok(!fsSets.some((s) => s.path === 'users/uidA'), 'must not touch the claimed account');
});

test('auth: /me/referral-code ignores any identifier in the URL', async () => {
  const res = makeRes();
  await callRoute(
    'get',
    '/me/referral-code',
    makeReq({}, 'token-b'),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.referral_code, fsDocs.users.uidB.referralCode);
  assert.equal(fsDocs.users.uidA, undefined, 'the URL identifier must be ignored');
});

// ── Server-authoritative scan limits: 3 free per IST day ────────────────
test('entitlements: reports the free daily allowance and the IST reset', async () => {
  const res = makeRes();
  await callRoute('get', '/me/entitlements', makeReq({}, 'token-a'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subscribed, false);
  assert.equal(res.body.scans_used, 0);
  assert.equal(res.body.scans_limit, 3);
  assert.equal(res.body.scans_remaining, 3);
  assert.equal(res.body.scan_day, istDay(), 'the day key is the IST day');

  // The reset is the next IST midnight — not UTC midnight, which would hand
  // Indian users their new allowance at 5:30 AM.
  const istReset = new Date(new Date(res.body.reset_at).getTime() + IST_OFFSET_MS);
  assert.equal(istReset.toISOString().slice(11, 19), '00:00:00');
  assert.ok(new Date(res.body.reset_at).getTime() > Date.now());
});

test('analyze: 3 free scans per day, then 403 scan_limit_reached', async () => {
  for (let i = 1; i <= 3; i++) {
    const res = makeRes();
    await callRoute('post', '/analyze', makeReq({}, 'token-a'), res);
    assert.equal(res.statusCode, 200, `scan ${i} must be allowed`);
    assert.equal(res.body.scans_used, i);
    assert.equal(res.body.scans_limit, 3);
    assert.equal(res.body.scans_remaining, 3 - i);
    assert.equal(res.body.subscribed, false);
    assert.ok(res.body.reset_at, 'the response must carry the reset time');
  }
  assert.equal(fsDocs.users.uidA.scanCount, 3);
  assert.equal(fsDocs.users.uidA.scanDay, istDay());

  const fourth = makeRes();
  await callRoute('post', '/analyze', makeReq({}, 'token-a'), fourth);
  assert.equal(fourth.statusCode, 403);
  assert.equal(fourth.body.error, 'scan_limit_reached');
  assert.equal(fourth.body.scans_used, 3);
  assert.equal(fourth.body.scans_limit, 3);
  assert.equal(fourth.body.scans_remaining, 0);
});

test('analyze: the AI total weight becomes the starting serving', async () => {
  geminiSays({
    description: 'two boiled eggs',
    confidence: 0.94,
    total_grams: 95,
    dishes: [{
      name: 'Chicken egg',
      calories_per_100g: 143,
      protein_g_per_100g: 12.6,
      carbs_g_per_100g: 0.6,
      fats_g_per_100g: 9.6,
    }],
  });
  try {
    const res = makeRes();
    await callRoute('post', '/analyze', makeReq({}, 'token-a'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.grams, 95, 'the portion estimate must ride along');
  } finally {
    global.fetch = confidentGeminiFetch;
  }
});

test('analyze: a wild or missing total_grams is clamped, never trusted blindly', async () => {
  geminiSays({
    description: 'comically large plate',
    confidence: 0.9,
    total_grams: 99999,
    dishes: [{
      name: 'Rice',
      calories_per_100g: 130,
      protein_g_per_100g: 2.7,
      carbs_g_per_100g: 28,
      fats_g_per_100g: 0.3,
    }],
  });
  try {
    const huge = makeRes();
    await callRoute('post', '/analyze', makeReq({}, 'token-a'), huge);
    assert.equal(huge.body.grams, 3000, 'clamped to the 3 kg ceiling');
  } finally {
    global.fetch = confidentGeminiFetch;
  }

  geminiSays({
    description: 'no weight supplied',
    confidence: 0.9,
    dishes: [{
      name: 'Rice',
      calories_per_100g: 130,
      protein_g_per_100g: 2.7,
      carbs_g_per_100g: 28,
      fats_g_per_100g: 0.3,
    }],
  });
  try {
    const missing = makeRes();
    await callRoute('post', '/analyze', makeReq({}, 'token-a'), missing);
    assert.equal(missing.body.grams, 100, 'no weight → the old 100 g default');
  } finally {
    global.fetch = confidentGeminiFetch;
  }
});

test('analyze: a stale count from yesterday (IST) never blocks today', async () => {
  fsDocs.users = { uidA: { scanCount: 3, scanDay: '2020-01-01' } };
  const res = makeRes();
  await callRoute('post', '/analyze', makeReq({}, 'token-a'), res);

  assert.equal(res.statusCode, 200, 'yesterday\'s used-up allowance must not block today');
  assert.equal(res.body.scans_used, 1, 'the counter restarts at the IST day boundary');
  assert.equal(fsDocs.users.uidA.scanDay, istDay());
});

test('analyze: a Pro user is never blocked and reports no limit', async () => {
  fsDocs.users = { uidA: { subscribed: true, scanCount: 99, scanDay: istDay() } };
  const res = makeRes();
  await callRoute('post', '/analyze', makeReq({}, 'token-a'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subscribed, true);
  assert.equal(res.body.scans_limit, null, 'Pro means unlimited');
  assert.equal(res.body.scans_remaining, null);
  assert.equal(fsDocs.users.uidA.scanCount, 99, 'Pro scans are not counted against the free cap');
});

test('analyze: the owner/admin account is exempt from the limit', async () => {
  const adminToken = {
    uid: 'uidAdmin',
    email: 'owner@example.com',
    email_verified: true,
    admin: true, // custom claim, set with the Admin SDK
  };
  tokenClaims['token-admin'] = adminToken;
  try {
    const res = makeRes();
    await callRoute('post', '/analyze', makeReq({}, 'token-admin'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.subscribed, true);
    assert.equal(res.body.scans_limit, null);
  } finally {
    delete tokenClaims['token-admin'];
  }
});

// An email address is not a credential. Even a VERIFIED address must grant
// nothing: the old email match meant anyone who registered the owner's address
// inherited free Pro.
test('analyze: a verified admin email without the claim gets no Pro override', async () => {
  tokenClaims['token-fake-admin'] = {
    uid: 'uidFakeAdmin',
    email: 'owner@example.com',
    email_verified: true,
  };
  try {
    const res = makeRes();
    await callRoute('post', '/analyze', makeReq({}, 'token-fake-admin'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.subscribed, false, 'no claim means no Pro, whatever the email');
    assert.equal(res.body.scans_limit, 3, 'a free user still has the normal limit');
  } finally {
    delete tokenClaims['token-fake-admin'];
  }
});

test('analyze: scans are counted per user, not per device or body', async () => {
  const first = makeRes();
  // A body phone is a claim, not an identity — it must not split the counter.
  await callRoute('post', '/analyze', makeReq({ body: { phone: 'b@example.com' } }, 'token-a'), first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.scans_used, 1);
  assert.equal(fsDocs.users.uidA.scanCount, 1);
  assert.equal(fsDocs.users.uidB, undefined, 'the claimed account must be untouched');
});

// ── Unidentified results must not cost the user a scan ──────────────────
// The app's low-confidence banner tells the user the scan was NOT counted, so
// the server must refund its reservation for the SAME cases (confidence < 0.5,
// or an "Unknown" dish). Otherwise the app shows a scan as free while the
// server has already spent it, the two counts drift apart, and a later scan
// 403s with no warning.
function geminiSays(payload) {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    }),
  });
}

test('analyze: a low-confidence result refunds the scan and reports it as free', async () => {
  geminiSays({
    description: 'unclear photo',
    confidence: 0.2,
    dishes: [{
      name: 'Something brown',
      calories_per_100g: 100,
      protein_g_per_100g: 1,
      carbs_g_per_100g: 1,
      fats_g_per_100g: 1,
    }],
  });
  try {
    const res = makeRes();
    await callRoute('post', '/analyze', makeReq({}, 'token-a'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.scans_used, 0, 'a low-confidence scan is not charged');
    assert.equal(res.body.scans_limit, 3);
    assert.equal(res.body.scans_remaining, 3, 'the allowance is unchanged');
    assert.equal(fsDocs.users.uidA.scanCount, 0, 'the reservation was handed back');
  } finally {
    global.fetch = confidentGeminiFetch;
  }
});

test('analyze: an "Unknown" dish also refunds the scan (confidence high)', async () => {
  geminiSays({
    description: 'unclear photo',
    confidence: 0.9,
    dishes: [{
      name: 'Unknown',
      calories_per_100g: 0,
      protein_g_per_100g: 0,
      carbs_g_per_100g: 0,
      fats_g_per_100g: 0,
    }],
  });
  try {
    const res = makeRes();
    await callRoute('post', '/analyze', makeReq({}, 'token-a'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.scans_used, 0, '"Unknown" is not a real identification');
    assert.equal(res.body.scans_remaining, 3);
    assert.equal(fsDocs.users.uidA.scanCount, 0);
  } finally {
    global.fetch = confidentGeminiFetch;
  }
});

test('analyze: a real identification is still charged (the refund is not a free pass)', async () => {
  const res = makeRes();
  await callRoute('post', '/analyze', makeReq({}, 'token-a'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scans_used, 1, 'a confident result still spends a scan');
  assert.equal(res.body.scans_remaining, 2);
  assert.equal(fsDocs.users.uidA.scanCount, 1);
});

// ── Referral reward is a 30-day window, never a permanent flag ──────────
// The old version wrote `subscribed: true` with no end date and only checked
// "already used" against Postgres — which production does not run, so that
// guard never fired on the live path.
const DAY_MS = 24 * 60 * 60 * 1000;

test('referral/apply: grants ~30 days of Pro and never writes a permanent flag', async () => {
  fsDocs.referrals = { ABCD: { uid: 'uidB' } }; // uidB owns the code
  const res = makeRes();
  await callRoute('post', '/referral/apply', makeReq({ body: { code: 'abcd' } }, 'token-a'), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subscribed, true, 'the app reads this field as the reward');

  const proUntil = Date.parse(res.body.pro_until);
  assert.ok(proUntil > Date.now() + 28 * DAY_MS && proUntil <= Date.now() + 31 * DAY_MS,
    'the reward must be about 30 days, not forever');

  // THE BUG BEING FIXED: a permanent `subscribed: true` must never be written.
  assert.notEqual(fsDocs.users.uidA.subscribed, true,
    'a referral must not grant permanent Pro');
  assert.equal(fsDocs.users.uidA.referredBy, 'ABCD');
  assert.ok(fsDocs.users.uidB.pro_until, 'the referrer earns the window too');
  assert.ok(fsDocs.users.uidA.pro_until_at instanceof Date,
    'Firestore rules need a timestamp for the invitee entitlement');
  assert.ok(fsDocs.users.uidB.pro_until_at instanceof Date,
    'Firestore rules need a timestamp for the referrer entitlement');
  assert.notEqual(fsDocs.users.uidB.subscribed, true,
    'the referrer is capped too — one code must not buy forever Pro');
});

test('referral/apply: a code cannot be applied twice (Firestore is the guard)', async () => {
  fsDocs.referrals = { ABCD: { uid: 'uidB' } };
  const first = makeRes();
  await callRoute('post', '/referral/apply', makeReq({ body: { code: 'abcd' } }, 'token-a'), first);
  assert.equal(first.statusCode, 200);

  const second = makeRes();
  await callRoute('post', '/referral/apply', makeReq({ body: { code: 'ABCD' } }, 'token-a'), second);
  assert.equal(second.statusCode, 400);
  assert.equal(second.body.error, 'Already used a referral code');
  assert.ok(Date.parse(fsDocs.users.uidB.pro_until) <= Date.now() + 31 * DAY_MS,
    'the referrer earns ONE window, not one per submission');
});

test('referral/apply: your own code is rejected on the Firestore path', async () => {
  // The old guard compared the referrer's PHONE, which is NULL when Postgres
  // is absent, against a non-null identifier — so it could never fire here.
  fsDocs.referrals = { OWN: { uid: 'uidA' } };
  const res = makeRes();
  await callRoute('post', '/referral/apply', makeReq({ body: { code: 'own' } }, 'token-a'), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Cannot use your own code');
  // The whole `users` collection must still be untouched — the guard fires
  // before any write, so there is no users doc to assert on.
  assert.ok(!fsDocs.users || fsDocs.users.uidA === undefined,
    'nothing may be granted to a self-referral');
});

test('subscription/status: a live referral window is Pro, an expired one is not', async () => {
  fsDocs.users = { uidA: { pro_until: new Date(Date.now() + DAY_MS).toISOString() } };
  const live = makeRes();
  await callRoute('get', '/subscription/status', makeReq({}, 'token-a'), live);
  assert.equal(live.body.subscribed, true, 'a live window must unlock Pro');
  assert.ok(fsDocs.users.uidA.pro_until_at instanceof Date,
    'existing referral windows must be backfilled for Firestore rules');

  fsDocs.users = { uidA: { pro_until: new Date(Date.now() - DAY_MS).toISOString() } };
  const expired = makeRes();
  await callRoute('get', '/subscription/status', makeReq({}, 'token-a'), expired);
  assert.equal(expired.body.subscribed, false,
    'an expired referral must drop the user back to free');
});

// ── Meal photo backup (Pro, Firestore blob) ────────────────────────────
test('meal photos: a free account cannot upload; Pro can, and the doc carries its uid', async () => {
  const free = makeRes();
  await callRoute('post', '/meals/:mealId/photo', makeReq({ params: { mealId: 'm1' } }, 'token-a'), free);
  assert.equal(free.statusCode, 403);
  assert.equal(free.body.error, 'pro_required');
  assert.ok(!fsDocs.mealPhotos || !fsDocs.mealPhotos.m1, 'no photo may be written for a free user');

  fsDocs.users = { uidA: { subscribed: true } };
  const pro = makeRes();
  await callRoute('post', '/meals/:mealId/photo', makeReq({ params: { mealId: 'm1' } }, 'token-a'), pro);
  assert.equal(pro.statusCode, 200);
  assert.ok(pro.body.ok);
  assert.equal(fsDocs.mealPhotos.m1.uid, 'uidA');
  assert.equal(fsDocs.mealPhotos.m1.contentType, 'image/jpeg');
  assert.ok(fsDocs.mealPhotos.m1.data.length > 0, 'the doc carries the image payload');
});

test('meal photos: reads and deletes are owner-only by the STORAGE uid, not the client claim', async () => {
  fsDocs.users = { uidA: { subscribed: true } };
  fsDocs.mealPhotos = { m1: { uid: 'uidA', data: 'ZmFrZQ==', contentType: 'image/jpeg' } };

  const foreign = makeRes();
  await callRoute('get', '/meals/:mealId/photo', makeReq({ params: { mealId: 'm1' } }, 'token-b'), foreign);
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.body.error, 'not_your_photo');

  const mine = makeRes();
  await callRoute('get', '/meals/:mealId/photo', makeReq({ params: { mealId: 'm1' } }, 'token-a'), mine);
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.body.data, 'ZmFrZQ==');

  // A foreign uid on the doc is not trusted either: b cannot read a photo
  // whose doc claims uidB unless b is the caller — the caller always is, so
  // the real check is that uidB's OWN photo reads fine and uidA's does not.
  const foreignOther = makeRes();
  await callRoute('get', '/meals/:mealId/photo', makeReq({ params: { mealId: 'm2' } }, 'token-a'), foreignOther);
  assert.equal(foreignOther.statusCode, 404);

  const foreignDel = makeRes();
  await callRoute('delete', '/meals/:mealId/photo', makeReq({ params: { mealId: 'm1' } }, 'token-b'), foreignDel);
  assert.equal(foreignDel.statusCode, 403);
  assert.equal(fsDocs.mealPhotos.m1.uid, 'uidA', 'a foreign token must not delete the backup');

  fsDocs.mealPhotos.m2 = { uid: 'uidB', data: 'eA==' };
  const selfDel = makeRes();
  await callRoute('delete', '/meals/:mealId/photo', makeReq({ params: { mealId: 'm2' } }, 'token-b'), selfDel);
  assert.equal(selfDel.statusCode, 200);
  assert.equal((fsDocs.mealPhotos.m2 || {}).data, undefined, 'delete removes the doc');

  const again = makeRes();
  await callRoute('delete', '/meals/:mealId/photo', makeReq({ params: { mealId: 'm2' } }, 'token-b'), again);
  assert.equal(again.statusCode, 404);
});

test('restored after tests', () => { global.fetch = origFetch; });
