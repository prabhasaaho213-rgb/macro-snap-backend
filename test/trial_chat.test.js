'use strict';
// 30-day free trial + /chat nutrition-assistant tests. Same zero-dep harness
// as payment.test.js: express and friends are stubbed through Module._load,
// Firestore is an in-memory fake, and Gemini's HTTP call is a scripted fetch.
//
// Run: node --test test/
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// ── In-memory Firestore fake ────────────────────────────────────────────
const fsDocs = {}; // collection -> docId -> data
const fsSets = []; // every firestore.set(path, data, opts) call
const uidMap = { 'u1@test.com': 'uid1', '9999999999': 'uid2' };
const firestoreStub = {
  init: () => true,
  isEnabled: () => true,
  resolveUid: async (id) => (id && uidMap[id.toLowerCase()]) || null,
  set: async (path, data, opts) => {
    fsSets.push({ path, data, opts });
    const [col, id] = path.split('/');
    fsDocs[col] = fsDocs[col] || {};
    fsDocs[col][id] = { ...(fsDocs[col][id] || {}), ...(data || {}) };
    return true;
  },
  del: async () => true,
  getDb: () => ({
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          const d = (fsDocs[name] || {})[id];
          return { exists: !!d, data: () => d || {} };
        },
      }),
    }),
  }),
};

// ── express / multer / pg / sharp / dotenv fakes ────────────────────────
const routes = { get: {}, post: {} };
const appStub = {
  use: () => {},
  get: (p, ...fns) => { routes.get[p] = fns[fns.length - 1]; },
  post: (p, ...fns) => { routes.post[p] = fns[fns.length - 1]; },
  listen: () => {},
};
function express() { return appStub; }
express.json = () => (req, res, next) => next();
express.static = () => () => {};
function multer() { return { single: () => (req, res, next) => next() }; }
multer.memoryStorage = () => ({});
const pgStub = { Pool: class { query() { return { rows: [] }; } } };
const sharpStub = (buf) => ({ jpeg: () => ({ toBuffer: async () => buf }) });

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  switch (request) {
    case 'dotenv': return { config: () => ({}) };
    case 'express': return express;
    case 'multer': return multer;
    case 'sharp': return sharpStub;
    case 'pg': return pgStub;
    case 'razorpay': return { subscriptions: { create: async () => ({}) }, payments: { fetch: async () => ({}) } };
    case './firestore': return firestoreStub;
    default: return origLoad.apply(this, arguments);
  }
};

process.env.GEMINI_KEY = 'test-key';
delete process.env.DATABASE_URL;

// ── Fake Gemini: records request bodies, replies from a queue ───────────
const gemini = { bodies: [], replies: [] };
const origFetch = global.fetch;
global.fetch = async (url, opts) => {
  gemini.bodies.push(JSON.parse(opts.body));
  const reply = gemini.replies.shift();
  if (reply === undefined) throw new Error('no scripted Gemini reply left');
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] } }],
    }),
  };
};

const app = require('../server.js');
const trialStatus = routes.get['/trial/status'];
const chat = routes.post['/chat'];
const subStatus = routes.get['/subscription/status'];
assert.ok(trialStatus, '/trial/status handler must be registered');
assert.ok(chat, '/chat handler must be registered');
assert.ok(subStatus, '/subscription/status handler must be registered');

const DAY = 24 * 60 * 60 * 1000;

function makeReq(body, query) { return { body: body || {}, query: query || {} }; }
function makeRes() {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.payload = p; return res; };
  return res;
}

beforeEach(() => {
  for (const k of Object.keys(fsDocs)) delete fsDocs[k];
  fsSets.length = 0;
  gemini.bodies.length = 0;
  gemini.replies.length = 0;
});

test('trial: granted on first check, one time only, for 30 days', async () => {
  const res1 = makeRes();
  await trialStatus(makeReq({}, { phone: '9999999999' }), res1);
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.payload.active, true);
  assert.equal(res1.payload.daysLeft, 30, 'a fresh trial lasts 30 days');
  assert.ok(res1.payload.endsAt, 'expiry date must be reported');
  assert.equal(fsDocs.users.uid2.trial_started_at != null, true, 'trial start persisted to Firestore');

  const started = fsDocs.users.uid2.trial_started_at;
  const writesAfterFirst = fsSets.filter((s) => s.data.trial_started_at).length;

  // Second check (same user) must NOT restart or re-grant the trial.
  const res2 = makeRes();
  await trialStatus(makeReq({}, { phone: '9999999999' }), res2);
  assert.equal(res2.payload.active, true);
  assert.equal(fsDocs.users.uid2.trial_started_at, started, 'trial start must not change');
  assert.equal(
    fsSets.filter((s) => s.data.trial_started_at).length,
    writesAfterFirst,
    'no second trial_started_at write ever happens'
  );
});

test('trial: expires after 30 days and never comes back', async () => {
  fsDocs.users = { uid2: { trial_started_at: new Date(Date.now() - 31 * DAY).toISOString() } };
  const res = makeRes();
  await trialStatus(makeReq({}, { phone: '9999999999' }), res);
  assert.equal(res.payload.active, false);
  assert.equal(res.payload.expired, true);
  assert.equal(res.payload.daysLeft, 0);
  const writes = fsSets.filter((s) => s.data.trial_started_at);
  assert.equal(writes.length, 0, 'an expired trial is never re-granted');
});

test('trial: day 29 still active with 1-2 days left', async () => {
  fsDocs.users = { uid2: { trial_started_at: new Date(Date.now() - 29 * DAY - 1000).toISOString() } };
  const res = makeRes();
  await trialStatus(makeReq({}, { phone: '9999999999' }), res);
  assert.equal(res.payload.active, true);
  assert.ok(res.payload.daysLeft >= 1 && res.payload.daysLeft <= 2, `daysLeft=${res.payload.daysLeft}`);
});

test('subscription/status: active trial reports subscribed with days left', async () => {
  fsDocs.users = { uid2: { trial_started_at: new Date(Date.now() - 2 * DAY).toISOString() } };
  const res = makeRes();
  await subStatus(makeReq({}, { phone: '9999999999' }), res);
  assert.equal(res.payload.subscribed, true);
  assert.equal(res.payload.trial_days_left, 28);
});

test('subscription/status: expired trial is not subscribed', async () => {
  fsDocs.users = { uid2: { trial_started_at: new Date(Date.now() - 40 * DAY).toISOString() } };
  const res = makeRes();
  await subStatus(makeReq({}, { phone: '9999999999' }), res);
  assert.equal(res.payload.subscribed, false);
});

test('chat: rejects an empty message', async () => {
  const res = makeRes();
  await chat(makeReq({ message: '' }), res);
  assert.equal(res.statusCode, 400);
});

test('chat: food-only system instruction + capped history + reply passthrough', async () => {
  gemini.replies.push('Paneer has about 18g protein per 100g.');
  const history = [];
  for (let i = 0; i < 15; i++) history.push({ role: i % 2 ? 'model' : 'user', text: `turn ${i}` });
  const res = makeRes();
  await chat(makeReq({ message: 'x'.repeat(5000), history }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.reply, 'Paneer has about 18g protein per 100g.');
  assert.equal(gemini.bodies.length, 1);

  const body = gemini.bodies[0];
  const instruction = body.systemInstruction.parts[0].text;
  assert.match(instruction, /ONLY questions about food, nutrition and protein/);
  assert.match(instruction, /I can only help with food, nutrition and protein questions/);

  assert.ok(body.contents.length <= 11, 'history capped at 10 turns + current message');
  assert.equal(body.contents[body.contents.length - 1].parts[0].text.length, 2000, 'message truncated to 2000 chars');
  assert.ok(body.contents.every((c) => c.role === 'user' || c.role === 'model'), 'Gemini role names preserved');
});

test('restored after tests', () => { global.fetch = origFetch; });
