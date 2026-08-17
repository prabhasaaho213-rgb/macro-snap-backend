'use strict';
// Payment/subscription backend tests. Runs with zero installed deps: every
// third-party module (express, razorpay, firebase-admin via ./firestore, pg,
// multer, sharp, dotenv) is stubbed through Module._load, so the real
// handlers are exercised against an in-memory Firestore fake.
//
// Run: node --test test/
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

// ── In-memory Firestore fake ────────────────────────────────────────────
const fsDocs = {}; // collection -> docId -> data
const fsSets = []; // every firestore.set(path, data, opts) call
const uidMap = {}; // identifier -> uid
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
  getDb: () => ({
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          const d = (fsDocs[name] || {})[id];
          return { exists: !!d, data: () => d || {} };
        },
      }),
      where: (field, op, value) => ({
        get: async () => {
          const col = fsDocs[name] || {};
          const docs = Object.keys(col)
            .filter((k) => op === '==' && col[k][field] === value)
            .map((k) => ({ id: k, data: () => col[k] }));
          return { empty: docs.length === 0, docs };
        },
      }),
    }),
  }),
};

// ── Razorpay fake ───────────────────────────────────────────────────────
const razorpayState = {
  lastCreate: null,
  subscriptionsCreate: null,
  paymentsFetch: null,
};
class RazorpayStub {
  constructor() {
    this.plans = {
      all: async () => ({ items: [] }),
      create: async () => ({ id: 'plan_test_1' }),
    };
    this.subscriptions = {
      create: async (payload) => {
        razorpayState.lastCreate = payload;
        if (razorpayState.subscriptionsCreate) {
          return razorpayState.subscriptionsCreate(payload);
        }
        return { id: 'sub_test_1', status: 'created' };
      },
    };
    this.payments = {
      fetch: async (id) =>
        razorpayState.paymentsFetch
          ? razorpayState.paymentsFetch(id)
          : { id, amount: 2900, notes: { phone: 'payment@example.com' } },
    };
  }
}

// ── express / multer / pg / sharp / dotenv fakes ────────────────────────
const routes = { get: {}, post: {} };
const appStub = {
  use: () => {},
  get: (p, ...fns) => { routes.get[p] = fns[fns.length - 1]; },
  post: (p, ...fns) => { routes.post[p] = fns[fns.length - 1]; },
  listen: () => {},
};
function express() { return appStub; }
express.json = () => (req, res, next) => {
  if (!req.rawBody) req.rawBody = Buffer.from(JSON.stringify(req.body || {}));
  next();
};
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
    case 'razorpay': return RazorpayStub;
    case './firestore': return firestoreStub;
    default: return origLoad.apply(this, arguments);
  }
};

// ── Environment + module load (must happen before handlers are used) ────
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
delete process.env.DATABASE_URL;

const app = require('../server.js');
const webhook = routes.post['/payment/webhook'];
const createSubscription = routes.post['/payment/create-subscription'];
const verify = routes.post['/payment/verify'];
const subscriptionStatus = routes.get['/subscription/status'];
const userProfile = routes.get['/user/profile'];
const referralGenerate = routes.post['/referral/generate'];

assert.ok(webhook, '/payment/webhook handler must be registered');
assert.ok(createSubscription, '/payment/create-subscription must be registered');
assert.ok(verify, '/payment/verify must be registered');
assert.ok(subscriptionStatus, '/subscription/status must be registered');
assert.ok(app, 'server.js must export the app');

// ── helpers ─────────────────────────────────────────────────────────────
function resetState() {
  for (const k of Object.keys(fsDocs)) delete fsDocs[k];
  fsSets.length = 0;
  for (const k of Object.keys(uidMap)) delete uidMap[k];
  razorpayState.lastCreate = null;
  razorpayState.subscriptionsCreate = null;
  razorpayState.paymentsFetch = null;
}
beforeEach(resetState);

function sign(body, secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}
function makeReq(body, { sig, query } = {}) {
  const req = { body, query: query || {} };
  req.headers = {};
  if (sig !== undefined) req.headers['x-razorpay-signature'] = sig;
  req.rawBody = Buffer.from(JSON.stringify(body));
  return req;
}
function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  res.send = (s) => { res.body = s; return res; };
  return res;
}
function chargedEvent(subId, notes) {
  return {
    entity: 'event',
    id: 'evt_' + subId,
    event: 'subscription.charged',
    contains: ['subscription', 'payment'],
    payload: {
      payment: { entity: { id: 'pay_' + subId, entity: 'payment', status: 'captured', subscription_id: subId, notes } },
      subscription: { entity: { id: subId, entity: 'subscription', status: 'active', notes } },
    },
    created_at: 1700000000,
  };
}
const lastFsSet = (pred) => fsSets.filter(pred).slice(-1)[0];

// ── Webhook: signature gate ─────────────────────────────────────────────
test('webhook: missing signature → 400', async () => {
  const res = makeRes();
  await webhook(makeReq({ event: 'subscription.charged', payload: {} }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Missing signature');
});

test('webhook: invalid signature → 400', async () => {
  const res = makeRes();
  await webhook(makeReq({ event: 'subscription.charged', payload: {} }, { sig: 'deadbeef' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Invalid webhook signature');
});

test('webhook: event without subscription id is logged, never activates', async () => {
  const body = { entity: 'event', id: 'evt_none', event: 'payment.failed', payload: {} };
  const res = makeRes();
  await webhook(makeReq(body, { sig: sign(body) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, true);
  assert.equal(lastFsSet((s) => s.path === 'webhookLog/evt_none').data.outcome, 'no_subscription');
  assert.ok(!fsSets.some((s) => s.path.startsWith('users/')), 'must not touch user docs');
});

// ── Webhook: activation ─────────────────────────────────────────────────
test('webhook: subscription.charged activates the user via payment notes', async () => {
  uidMap['123spandana88@gmail.com'] = 'uid1';
  const body = chargedEvent('sub_1', { phone: '123spandana88@gmail.com' });
  const res = makeRes();
  await webhook(makeReq(body, { sig: sign(body) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, true);
  const user = lastFsSet((s) => s.path === 'users/uid1');
  assert.equal(user.data.subscribed, true);
  assert.equal(user.data.subscriptionId, 'sub_1');
  assert.equal(lastFsSet((s) => s.path === 'webhookLog/evt_sub_1').data.outcome, 'activated');
});

test('webhook: resolves the user via the Firestore subscriptions mapping when notes are absent', async () => {
  // The real Razorpay payload carries no notes — the mapping written by
  // create-subscription is what resolves the user (the ffd4c55 regression).
  uidMap['123spandana88@gmail.com'] = 'uid1';
  fsDocs.subscriptions = { sub_map: { phone: '123spandana88@gmail.com' } };
  const body = chargedEvent('sub_map', {});
  const res = makeRes();
  await webhook(makeReq(body, { sig: sign(body) }), res);
  assert.equal(res.statusCode, 200);
  const user = lastFsSet((s) => s.path === 'users/uid1');
  assert.equal(user.data.subscribed, true);
  assert.equal(lastFsSet((s) => s.path === 'webhookLog/evt_sub_map').data.outcome, 'activated');
});

test('webhook: unresolvable subscription is logged, silently never activates', async () => {
  const body = chargedEvent('sub_ghost', {});
  const res = makeRes();
  await webhook(makeReq(body, { sig: sign(body) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, true);
  assert.equal(lastFsSet((s) => s.path === 'webhookLog/evt_sub_ghost').data.outcome, 'unresolved');
  assert.ok(!fsSets.some((s) => s.path.startsWith('users/')), 'must not activate anyone');
});

test('webhook: subscription.cancelled deactivates the user', async () => {
  uidMap['u@example.com'] = 'uid2';
  fsDocs.users = { uid2: { subscribed: true } };
  const body = {
    entity: 'event', id: 'evt_cancel', event: 'subscription.cancelled',
    payload: { subscription: { entity: { id: 'sub_2', status: 'cancelled', notes: { phone: 'u@example.com' } } } },
  };
  const res = makeRes();
  await webhook(makeReq(body, { sig: sign(body) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(lastFsSet((s) => s.path === 'users/uid2').data.subscribed, false);
  assert.equal(lastFsSet((s) => s.path === 'webhookLog/evt_cancel').data.outcome, 'deactivated');
});

test('webhook: non-state events are logged as ignored', async () => {
  const body = {
    entity: 'event', id: 'evt_created', event: 'subscription.created',
    payload: { subscription: { entity: { id: 'sub_3', status: 'created', notes: { phone: 'u@example.com' } } } },
  };
  const res = makeRes();
  await webhook(makeReq(body, { sig: sign(body) }), res);
  assert.equal(lastFsSet((s) => s.path === 'webhookLog/evt_created').data.outcome, 'ignored');
});

// ── create-subscription ─────────────────────────────────────────────────
test('create-subscription: payload is correct (no customer, no max_retries) and mapping is mirrored', async () => {
  uidMap['+919876543210'] = 'uid_phone';
  const res = makeRes();
  await createSubscription(makeReq({ phone: '+919876543210' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subscription_id, 'sub_test_1');
  assert.equal(res.body.razorpay_key, 'rzp_test_key');
  assert.equal(razorpayState.lastCreate.total_count, 12);
  assert.equal(razorpayState.lastCreate.notes.phone, '+919876543210');
  assert.ok(!('customer' in razorpayState.lastCreate), 'customer block must never be sent');
  assert.ok(!('max_retries' in razorpayState.lastCreate), 'max_retries must never be sent');
  const mapping = lastFsSet((s) => s.path === 'subscriptions/sub_test_1');
  assert.equal(mapping.data.phone, '+919876543210');
});

test('create-subscription: rejects when Razorpay rejects the payload (keeps the error visible)', async () => {
  razorpayState.subscriptionsCreate = async () => {
    throw new Error('max_retries is/are not required and should not be sent');
  };
  const res = makeRes();
  await createSubscription(makeReq({ phone: '+919876543210' }), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /max_retries/);
});

test('create-subscription: missing phone → 400', async () => {
  const res = makeRes();
  await createSubscription(makeReq({}), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Phone required');
});

// ── verify: subscription signature order ────────────────────────────────
test('verify: subscription signature is HMAC(payment_id|subscription_id)', async () => {
  uidMap['pay@example.com'] = 'uid_pay';
  razorpayState.paymentsFetch = async (id) => ({ id, amount: 2900, notes: { phone: 'pay@example.com' } });
  const sig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update('pay_p|sub_s')
    .digest('hex');
  const res = makeRes();
  await verify(makeReq({
    razorpay_subscription_id: 'sub_s',
    razorpay_payment_id: 'pay_p',
    razorpay_signature: sig,
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subscribed, true);
  assert.equal(lastFsSet((s) => s.path === 'users/uid_pay').data.subscribed, true);
});

test('verify: wrong signature order (subscription_id|payment_id) is rejected', async () => {
  razorpayState.paymentsFetch = async (id) => ({ id, amount: 2900, notes: { phone: 'pay@example.com' } });
  const sig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update('sub_s|pay_p')
    .digest('hex');
  const res = makeRes();
  await verify(makeReq({
    razorpay_subscription_id: 'sub_s',
    razorpay_payment_id: 'pay_p',
    razorpay_signature: sig,
  }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Invalid signature');
});

// ── subscription/status ─────────────────────────────────────────────────
test('subscription/status: admin is always subscribed', async () => {
  const res = makeRes();
  await subscriptionStatus(makeReq({}, { query: { phone: 'prabhasaaho213@gmail.com' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { subscribed: true });
});

test('subscription/status: Firestore users doc is authoritative', async () => {
  uidMap['a@b.com'] = 'uid_a';
  fsDocs.users = { uid_a: { subscribed: true } };
  const res = makeRes();
  await subscriptionStatus(makeReq({}, { query: { phone: 'a@b.com' } }), res);
  assert.deepEqual(res.body, { subscribed: true });
});

test('subscription/status: nothing on record → not subscribed', async () => {
  const res = makeRes();
  await subscriptionStatus(makeReq({}, { query: { phone: 'nobody@example.com' } }), res);
  assert.deepEqual(res.body, { subscribed: false });
});

// ── user/profile (nickname restore) ─────────────────────────────────────
test('user/profile: reads the nickname from Firestore userIndex', async () => {
  uidMap['a@b.com'] = 'uid_a';
  fsDocs.userIndex = { 'a@b.com': { name: 'Alice' } };
  const res = makeRes();
  await userProfile(makeReq({}, { query: { email: 'a@b.com' } }), res);
  assert.deepEqual(res.body, { name: 'Alice' });
});

test('user/profile: no record anywhere → null, never an error', async () => {
  const res = makeRes();
  await userProfile(makeReq({}, { query: { email: 'nobody@example.com' } }), res);
  assert.deepEqual(res.body, { name: null });
});

// ── referrals ───────────────────────────────────────────────────────────
test('referral/generate: returns the existing Firestore code (idempotent)', async () => {
  uidMap['a@b.com'] = 'uid_a';
  fsDocs.users = { uid_a: { referralCode: 'ABC123' } };
  const res = makeRes();
  await referralGenerate(makeReq({ phone: 'a@b.com' }), res);
  assert.equal(res.body.referral_code, 'ABC123');
});

test('referral/generate: creates a code and mirrors it to Firestore', async () => {
  uidMap['a@b.com'] = 'uid_a';
  const res = makeRes();
  await referralGenerate(makeReq({ phone: 'a@b.com' }), res);
  assert.match(res.body.referral_code, /^[A-Z2-9]{6}$/);
  assert.ok(fsSets.some((s) => s.path === 'users/uid_a' && typeof s.data.referralCode === 'string'));
});
