'use strict';
// /generate-diet-plan diet-preference tests. Same zero-dep harness as
// payment.test.js: express and friends are stubbed through Module._load and
// the Gemini HTTP call is replaced with a canned fetch, so the handler's
// prompt construction and output verification are exercised directly.
//
// Run: node --test test/
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// ── express / multer / pg / sharp / dotenv fakes ────────────────────────
const routes = { get: {}, post: {}, delete: {} };
const appStub = {
  use: () => {},
  get: (p, ...fns) => { routes.get[p] = fns[fns.length - 1]; },
  post: (p, ...fns) => { routes.post[p] = fns[fns.length - 1]; },
  delete: (p, ...fns) => { routes['delete'][p] = fns[fns.length - 1]; },
  listen: () => {},
};
function express() { return appStub; }
express.json = () => (req, res, next) => next();
express.static = () => () => {};
function multer() { return { single: () => (req, res, next) => next() }; }
multer.memoryStorage = () => ({});
const pgStub = { Pool: class { query() { return { rows: [] }; } } };
const sharpStub = (buf) => ({ jpeg: () => ({ toBuffer: async () => buf }) });
// /generate-diet-plan is Pro-only, so the harness has to be able to produce a
// SUBSCRIBED user. entitlementsFor reads Firestore users/{uid}.subscribed, so
// the stub reports exactly that for the uids in `subscribedUids` (and an empty
// doc for everyone else, i.e. a free user).
const subscribedUids = new Set(['uidPro']);
const firestoreStub = {
  init: () => true,
  isEnabled: () => true,
  resolveUid: async () => null,
  set: async () => true,
  del: async () => true,
  getDb: () => ({
    collection: () => ({
      doc: (id) => ({
        get: async () => {
          const subscribed = subscribedUids.has(id);
          return { exists: subscribed, data: () => (subscribed ? { subscribed: true } : {}) };
        },
      }),
    }),
  }),
};

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

// ── Fake Gemini: records every prompt, replies from a scripted queue ────
const gemini = { prompts: [], replies: [] };
const origFetch = global.fetch;
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  gemini.prompts.push(body.contents[0].parts[0].text);
  const reply = gemini.replies.shift();
  if (reply === undefined) throw new Error('no scripted Gemini reply left');
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }],
    }),
  };
};

const app = require('../server.js');
const handler = routes.post['/generate-diet-plan'];
assert.ok(handler, '/generate-diet-plan handler must be registered');

const vegPlan = {
  meals: [
    { name: 'Breakfast', time: '8:00 AM', description: '2 paneer parathas with curd', calories: 500, protein_g: 22, carbs_g: 60, fats_g: 18 },
    { name: 'Lunch', time: '1:00 PM', description: 'Dal tadka, rice, mixed veg sabzi, salad', calories: 650, protein_g: 20, carbs_g: 100, fats_g: 15 },
  ],
  water: '3 liters',
  tips: ['Add curd at lunch for probiotics'],
};
const meatPlan = JSON.parse(JSON.stringify(vegPlan));
meatPlan.meals[1].description = '1 cup chicken breast curry (150g chicken) with rice';
meatPlan.tips = ['Swap paneer for chicken to hit protein faster'];

// Stands in for requireAuth: auth.js reads the caller's identity from
// `req.user`, so the harness sets verified claims directly. `user` defaults to
// a paying subscriber so the prompt tests below exercise the real path; the
// free-user 403 has its own test.
const PRO_USER = { uid: 'uidPro', email: 'pro@example.com', email_verified: true };
const FREE_USER = { uid: 'uidFree', email: 'free@example.com', email_verified: true };
function makeReq(body, user = PRO_USER) { return { body, user }; }
function makeRes() {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.payload = p; return res; };
  return res;
}

beforeEach(() => {
  gemini.prompts.length = 0;
  gemini.replies.length = 0;
});

test('vegetarian request puts a strict vegetarian constraint in the prompt', async () => {
  gemini.replies.push(vegPlan);
  const res = makeRes();
  await handler(makeReq({ weight: 70, height: 170, age: 25, gender: 'male', goal: 'maintain', activity: 'moderate', diet: 'vegetarian' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(gemini.prompts.length, 1);
  assert.match(gemini.prompts[0], /STRICTLY VEGETARIAN/);
  assert.doesNotMatch(gemini.prompts[0], /NON-VEGETARIAN/);
});

test('a meat-containing plan is rejected and retried once, retry result is served', async () => {
  gemini.replies.push(meatPlan, vegPlan);
  const res = makeRes();
  await handler(makeReq({ weight: 70, height: 170, age: 25, gender: 'male', goal: 'maintain', activity: 'moderate', diet: 'vegetarian' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(gemini.prompts.length, 2, 'one violation must trigger exactly one retry');
  assert.match(gemini.prompts[1], /rejected/, 'retry prompt must name the rejection');
  assert.match(gemini.prompts[1], /chicken/, 'retry prompt must cite the offending item');
  assert.equal(res.payload.plan.meals[1].description, vegPlan.meals[1].description, 'the clean retry plan must be served');
});

test('two violating plans fail loudly instead of serving meat to a vegetarian', async () => {
  gemini.replies.push(meatPlan, meatPlan);
  const res = makeRes();
  await handler(makeReq({ weight: 70, height: 170, age: 25, gender: 'male', goal: 'maintain', activity: 'moderate', diet: 'vegetarian' }), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.payload.error, /vegetarian plan/);
});

test('nonVegetarian request allows meat and skips the strict clause', async () => {
  gemini.replies.push(meatPlan);
  const res = makeRes();
  await handler(makeReq({ weight: 70, height: 170, age: 25, gender: 'male', goal: 'maintain', activity: 'moderate', diet: 'nonVegetarian' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(gemini.prompts.length, 1, 'no retry loop for non-veg');
  assert.match(gemini.prompts[0], /NON-VEGETARIAN/);
  assert.doesNotMatch(gemini.prompts[0], /STRICTLY VEGETARIAN/);
});

test('a missing diet field is treated as vegetarian (safe default)', async () => {
  gemini.replies.push(vegPlan);
  const res = makeRes();
  await handler(makeReq({ weight: 70, height: 170, age: 25, gender: 'male', goal: 'maintain', activity: 'moderate' }), res);
  assert.equal(res.statusCode, 200);
  assert.match(gemini.prompts[0], /STRICTLY VEGETARIAN/);
});

test('prompt demands inline plain-English glosses for Indian dish names', async () => {
  gemini.replies.push(vegPlan);
  const res = makeRes();
  await handler(makeReq({ weight: 70, height: 170, age: 25, gender: 'female', goal: 'loseWeight', activity: 'light', diet: 'vegetarian' }), res);
  assert.equal(res.statusCode, 200);
  assert.match(gemini.prompts[0], /simple English/);
  assert.match(gemini.prompts[0], /plain-English explanation in parentheses/);
  assert.match(gemini.prompts[0], /right after the term/);
});

test('a free user gets 403 pro_required and no Gemini call is made', async () => {
  // The loudest half of the paywall: the app hides the plan builder from a
  // free user, but the server must refuse even if that is bypassed — every
  // plan is a Gemini call we pay for.
  gemini.replies.push(vegPlan);
  const res = makeRes();
  await handler(
    makeReq({ weight: 70, height: 170, age: 25, gender: 'male', goal: 'maintain', activity: 'moderate', diet: 'vegetarian' }, FREE_USER),
    res
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, 'pro_required');
  assert.equal(gemini.prompts.length, 0, 'a refused request must not cost a Gemini call');
});

test('a malformed request is still reported as malformed, not as Pro-gated', async () => {
  // Input validation runs before the entitlement check, matching /chat.
  const res = makeRes();
  await handler(makeReq({ height: 170, age: 25 }, FREE_USER), res);
  assert.equal(res.statusCode, 400);
  assert.equal(gemini.prompts.length, 0);
});

test('a subscribed user is not Pro-gated (the gate is not a blanket refusal)', async () => {
  gemini.replies.push(vegPlan);
  const res = makeRes();
  await handler(
    makeReq({ weight: 70, height: 170, age: 25, gender: 'male', goal: 'maintain', activity: 'moderate', diet: 'vegetarian' }, PRO_USER),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(gemini.prompts.length, 1);
});

test('restored after tests', () => { global.fetch = origFetch; });
