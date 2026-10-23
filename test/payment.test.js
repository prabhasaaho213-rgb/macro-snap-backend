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
  // Reads a doc from the fake, like the real firestore.get(): data or null.
  get: async (path) => {
    const [col, id] = path.split('/');
    return (fsDocs[col] || {})[id] || null;
  },
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
  lastCustomer: null,
  subscriptionsCreate: null,
  customersCreate: null,
  paymentsFetch: null,
};
class RazorpayStub {
  constructor() {
    this.plans = {
      all: async () => ({ items: [] }),
      create: async () => ({ id: 'plan_test_1' }),
    };
    this.customers = {
      create: async (payload) => {
        razorpayState.lastCustomer = payload;
        if (razorpayState.customersCreate) {
          return razorpayState.customersCreate(payload);
        }
        return { id: 'cust_test_1' };
      },
    };
    this.subscriptions = {
      fetch: async (id) =>
        razorpayState.subscriptionsFetch
          ? razorpayState.subscriptionsFetch(id)
          : { id, status: 'active', notes: {} },
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
const paymentStatus = routes.get['/me/payment/status'];

assert.ok(paymentStatus, '/me/payment/status must be registered');

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
  razorpayState.subscriptionsFetch = null;
  razorpayState.paymentsFetch = null;
}
beforeEach(resetState);

function sign(body, secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}
// Every protected route now takes its identity from the verified Firebase ID
// token (auth.js sets req.user) and IGNORES any phone/email/uid in the request.
// This harness stands in for that middleware, deriving the same identity from
// the identifier each existing test already passes, so these tests keep
// covering handler logic. The middleware itself — missing/invalid tokens, the
// 401s and the "client identifiers are ignored" rule — is covered by
// test/auth.test.js.
function actAs(req, identifier, adminClaim) {
  req.user = identifier
    ? {
        uid:
          uidMap[String(identifier).toLowerCase()] ||
          'uid_' + String(identifier).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16),
        email: String(identifier).includes('@')
          ? String(identifier).toLowerCase()
          : undefined,
        // Google sign-in always arrives verified; phone/uid-only identities
        // carry no email claim, so they read as unverified.
        email_verified: String(identifier).includes('@'),
        phone_number: String(identifier).includes('@') ? undefined : String(identifier),
        // The owner's privilege is this custom claim and nothing else — see
        // ensureAdminClaim() in server.js.
        ...(adminClaim === true ? { admin: true } : {}),
      }
    : null;
  return req;
}
// `as` forces the TOKEN's identity (independently of what the body claims) —
// that is how the "client-sent identifiers are ignored" cases are written.
function makeReq(body, { sig, query, as, admin } = {}) {
  const req = { body: body || {}, query: query || {} };
  req.headers = {};
  if (sig !== undefined) req.headers['x-razorpay-signature'] = sig;
  req.rawBody = Buffer.from(JSON.stringify(body));
  const b = req.body;
  const q = req.query;
  const identifier =
    as !== undefined ? as : b.phone || b.email || q.phone || q.email || null;
  return actAs(req, identifier, admin);
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
test('create-subscription: the TOKEN identity is used — a client-sent phone/email is ignored', async () => {
  uidMap['spandana@example.com'] = 'uid_email';
  const res = makeRes();
  await createSubscription(makeReq({
    // Any caller could put ANY identifier here; neither may be trusted.
    phone: '+919876543210',
    name: 'Spandana',
    email: 'attacker@example.com',
  }, { as: 'spandana@example.com' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subscription_id, 'sub_test_1');
  assert.equal(res.body.razorpay_key, 'rzp_test_key');
  // 100 cycles, not 12: Razorpay stops charging at total_count, so 12 quietly
  // ended Pro (and the renewal) exactly one year after signup.
  assert.equal(razorpayState.lastCreate.total_count, 100);
  // The subscription is mapped to the signed-in user, not to the body's phone.
  assert.equal(razorpayState.lastCreate.notes.phone, 'spandana@example.com');
  assert.equal(razorpayState.lastCustomer.name, 'Spandana');
  assert.equal(razorpayState.lastCustomer.email, 'spandana@example.com',
    'the customer email comes from the verified token');
  assert.ok(!('contact' in razorpayState.lastCustomer), 'no contact for an email identity');
  assert.equal(razorpayState.lastCustomer.fail_existing, 0);
  assert.equal(razorpayState.lastCreate.customer_id, 'cust_test_1');
  assert.ok(!('customer' in razorpayState.lastCreate), 'customer block must never be sent');
  assert.ok(!('max_retries' in razorpayState.lastCreate), 'max_retries must never be sent');
  const mapping = lastFsSet((s) => s.path === 'subscriptions/sub_test_1');
  assert.equal(mapping.data.phone, 'spandana@example.com');
  assert.ok(
    !JSON.stringify(fsSets).includes('+919876543210'),
    'the body-supplied phone must never reach a stored record'
  );
});

test('create-subscription: first month is a ₹1 addon, ₹49 autopay starts 30 days out', async () => {
  const before = Math.floor(Date.now() / 1000);
  const res = makeRes();
  await createSubscription(makeReq({ phone: '+919876543210' }), res);

  assert.equal(res.statusCode, 200);
  const created = razorpayState.lastCreate;
  assert.equal(created.plan_id, 'plan_test_1', 'the recurring plan is the ₹49 one');

  // ₹1 is collected as an upfront addon during authorisation — NOT by making
  // the plan ₹1. A ₹1 first cycle cannot be upgraded to ₹49 later on UPI,
  // which is how most users pay.
  assert.equal(created.addons.length, 1);
  assert.equal(created.addons[0].item.amount, 100, 'first month costs ₹1, not ₹0');
  assert.equal(created.addons[0].item.currency, 'INR');

  const days = (created.start_at - before) / 86400;
  assert.ok(days > 29.9 && days < 30.1, `₹49 autopay starts 30 days out (got ${days})`);

  assert.equal(res.body.amount, 4900, 'the recurring amount stays ₹49');
  assert.equal(res.body.first_month_price, 100);
  assert.equal(res.body.first_month_days, 30);
});

test('create-subscription: a phone identity prefills the customer contact', async () => {
  uidMap['+919876543210'] = 'uid_phone';
  const res = makeRes();
  await createSubscription(makeReq({ phone: '+919876543210', name: 'Spandana' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(razorpayState.lastCreate.notes.phone, '+919876543210');
  assert.equal(razorpayState.lastCustomer.contact, '+919876543210');
  assert.equal(lastFsSet((s) => s.path === 'subscriptions/sub_test_1').data.phone, '+919876543210');
});

test('create-subscription: email login → customer has email, no contact (page asks only for mobile)', async () => {
  const res = makeRes();
  await createSubscription(makeReq({
    phone: 'user@example.com',
    name: 'User',
    email: 'user@example.com',
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(razorpayState.lastCustomer.email, 'user@example.com');
  assert.equal(razorpayState.lastCustomer.name, 'User');
  assert.ok(!('contact' in razorpayState.lastCustomer), 'no contact for an email identifier');
  assert.equal(razorpayState.lastCreate.customer_id, 'cust_test_1');
});

test('create-subscription: customer prefill failure never blocks the subscription', async () => {
  razorpayState.customersCreate = async () => {
    throw new Error('customer boom');
  };
  const res = makeRes();
  await createSubscription(makeReq({ phone: '+919876543210', email: 'a@b.com' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subscription_id, 'sub_test_1');
  assert.ok(!('customer_id' in razorpayState.lastCreate), 'subscription proceeds without a customer');
});

test('create-subscription: Razorpay rejection → generic 500, internals logged not leaked', async () => {
  razorpayState.subscriptionsCreate = async () => {
    throw new Error('max_retries is/are not required and should not be sent');
  };
  // A third-party error string is not ours to show: Razorpay's internals
  // must stay in the server log while the client gets a generic failure.
  // (This test previously asserted the opposite — that the raw text was
  // echoed back — which is the leak this guards against.)
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  let res;
  try {
    res = makeRes();
    await createSubscription(makeReq({ phone: '+919876543210' }), res);
  } finally {
    console.error = realError;
  }
  assert.equal(res.statusCode, 500, 'the failure must still surface as a 500');
  assert.match(res.body.error, /Something went wrong/, 'client sees a generic message');
  assert.ok(!/max_retries/.test(res.body.error), 'Razorpay internals must NOT reach the client');
  assert.ok(logged.some((l) => l.includes('max_retries')), 'the real error must be logged server-side');
});

// Razorpay will happily create a second auto-charging subscription for the
// same person, so the guard has to be here or the user is billed twice.
test('create-subscription: an active subscription is refused with 409', async () => {
  uidMap['pro@example.com'] = 'uid_pro';
  fsDocs.users = { uid_pro: { subscribed: true } };
  const res = makeRes();
  await createSubscription(makeReq({}, { as: 'pro@example.com' }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'already_subscribed');
  assert.equal(razorpayState.lastCreate, null, 'no second subscription may be created');
});

// A user in a free trial must still be able to pay before it ends.
test('create-subscription: a user on trial may still subscribe', async () => {
  uidMap['trial@example.com'] = 'uid_trial';
  fsDocs.users = { uid_trial: { trial_started_at: new Date().toISOString() } };
  const res = makeRes();
  await createSubscription(makeReq({}, { as: 'trial@example.com' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.subscription_id, 'sub_test_1');
});

test('create-subscription: no verifiable identity → 400, no payment is created', async () => {
  const res = makeRes();
  await createSubscription(makeReq({ phone: '+919876543210' }, { as: null }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Identity required');
  assert.equal(razorpayState.lastCreate, null, 'nothing may be created without an identity');
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
  const user = lastFsSet((s) => s.path === 'users/uid_pay');
  assert.equal(user.data.subscribed, true);
  assert.equal(user.data.intro_used, true,
    'a verified payment spends the ₹1 intro for this account');
});

// The activation must use the TOKEN's uid. resolveUid(payment.notes.phone) is
// only a fallback: it misses whenever the Firebase user was created by email
// sign-in or by a number in another format, and that miss used to skip the
// write entirely while still answering success:true.
test('verify: activation writes the TOKEN uid even when the phone lookup misses', async () => {
  razorpayState.paymentsFetch = async (id) => ({ id, amount: 2900, notes: { phone: 'brandnew@example.com' } });
  const sig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update('pay_new|sub_new')
    .digest('hex');
  const res = makeRes();
  await verify(makeReq({
    razorpay_subscription_id: 'sub_new',
    razorpay_payment_id: 'pay_new',
    razorpay_signature: sig,
  }, { as: 'brandnew@example.com' }), res);

  assert.equal(res.statusCode, 200);
  const user = lastFsSet((s) => s.path === 'users/uid_brandnewexamplec');
  assert.ok(user, 'the user doc must be written for the token uid');
  assert.equal(user.data.subscribed, true);
});

// success:true means "you are Pro" in the app, so it may only be answered when
// a store actually recorded the subscription.
test('verify: nothing persisted → 202, never success', async () => {
  razorpayState.paymentsFetch = async (id) => ({ id, amount: 2900, notes: { phone: 'ghost@example.com' } });
  const sig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update('pay_ghost|sub_ghost')
    .digest('hex');

  // No Postgres, and Firestore refusing the write — the exact DB-less state
  // where the old code answered success:true after writing nothing.
  const realIsEnabled = firestoreStub.isEnabled;
  const realSet = firestoreStub.set;
  firestoreStub.isEnabled = () => false;
  firestoreStub.set = async () => false;
  try {
    const res = makeRes();
    await verify(makeReq({
      razorpay_subscription_id: 'sub_ghost',
      razorpay_payment_id: 'pay_ghost',
      razorpay_signature: sig,
    }, { as: 'ghost@example.com' }), res);

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.error, 'activation_pending');
    assert.equal(res.body.payment_id, 'pay_ghost');
    assert.notEqual(res.body.subscribed, true);
  } finally {
    firestoreStub.isEnabled = realIsEnabled;
    firestoreStub.set = realSet;
  }
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

// Razorpay does not reliably copy a subscription's notes onto its payments, so
// requiring payment.notes.phone answered 400 for real subscriptions — a paying
// user told "could not identify user". Our own mapping is the fallback.
test('verify: a payment with no notes verifies via our subscriptions mapping', async () => {
  razorpayState.paymentsFetch = async (id) => ({ id, amount: 2900, notes: {} });
  // The mapping is written from the token at create-subscription, so its uid
  // IS the caller's uid — that is what makes it definitive.
  uidMap['owner@example.com'] = 'uid_own';
  fsDocs.subscriptions = {
    sub_own: { uid: 'uid_own', identifier: 'owner@example.com' },
  };
  const sig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update('pay_own|sub_own')
    .digest('hex');

  const res = makeRes();
  await verify(makeReq({
    razorpay_subscription_id: 'sub_own',
    razorpay_payment_id: 'pay_own',
    razorpay_signature: sig,
  }, { as: 'owner@example.com' }), res);

  assert.equal(res.statusCode, 200, 'a genuine payment must not be rejected');
  assert.equal(res.body.subscribed, true);
  assert.equal(lastFsSet((s) => s.path === 'users/uid_own').data.subscribed, true);
});

test('verify: no notes and no mapping falls back to the verified token', async () => {
  razorpayState.paymentsFetch = async (id) => ({ id, amount: 2900, notes: {} });
  const sig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update('pay_bare|sub_bare')
    .digest('hex');

  const res = makeRes();
  await verify(makeReq({
    razorpay_subscription_id: 'sub_bare',
    razorpay_payment_id: 'pay_bare',
    razorpay_signature: sig,
  }, { as: 'bare@example.com' }), res);

  assert.equal(res.statusCode, 200);
  const user = lastFsSet((s) => s.path === 'users/uid_bareexamplecom');
  assert.equal(user.data.subscribed, true);
});

// The mapping names the owner, so a different signed-in account must not be
// able to claim the payment — even though the signature is valid.
test('verify: another account cannot verify a subscription it does not own', async () => {
  razorpayState.paymentsFetch = async (id) => ({ id, amount: 2900, notes: {} });
  fsDocs.subscriptions = {
    sub_theirs: { uid: 'uid_theirs', identifier: 'them@example.com' },
  };
  const sig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update('pay_theirs|sub_theirs')
    .digest('hex');

  const res = makeRes();
  await verify(makeReq({
    razorpay_subscription_id: 'sub_theirs',
    razorpay_payment_id: 'pay_theirs',
    razorpay_signature: sig,
  }, { as: 'me@example.com' }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Payment does not belong to this account');
  assert.ok(!fsSets.some((s) => s.path.startsWith('users/')));
});

// ── subscription/status ─────────────────────────────────────────────────
test('subscription/status: the admin CLAIM is always subscribed', async () => {
  const res = makeRes();
  await subscriptionStatus(
    makeReq({}, { as: 'owner@example.com', admin: true }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { subscribed: true });
});

// An address must not be a password: the same identity without the claim is an
// ordinary free user, which is what closes the "register the owner's email" hole.
test('subscription/status: an email alone is not the admin', async () => {
  const res = makeRes();
  await subscriptionStatus(makeReq({}, { as: 'owner@example.com' }), res);
  assert.equal(res.statusCode, 200);
  assert.notDeepEqual(res.body, { subscribed: true });
});

test('subscription/status: Firestore users doc is authoritative', async () => {
  uidMap['a@b.com'] = 'uid_a';
  fsDocs.users = { uid_a: { subscribed: true } };
  const res = makeRes();
  await subscriptionStatus(makeReq({}, { query: { phone: 'a@b.com' } }), res);
  assert.deepEqual(res.body, { subscribed: true });
});

test('subscription/status: nothing on record → not subscribed, intro still open', async () => {
  const res = makeRes();
  await subscriptionStatus(makeReq({}, { query: { phone: 'nobody@example.com' } }), res);
  assert.deepEqual(res.body, { subscribed: false, intro_eligible: true });
});

test('subscription/status: a cancelled ex-subscriber is free but NOT intro-eligible', async () => {
  uidMap['ex@example.com'] = 'uid_ex';
  fsDocs.users = { uid_ex: { subscribed: false, intro_used: true } };
  const res = makeRes();
  await subscriptionStatus(makeReq({}, { as: 'ex@example.com' }), res);
  assert.equal(res.body.subscribed, false);
  assert.equal(res.body.intro_eligible, false,
    'the ₹1 month was spent — the paywall must not promise it again');
});

// ── intro offer: ₹1 once per ACCOUNT ─────────────────────────────────────
// Every subscription app limits its intro price with a durable per-account
// record (Spotify: never again; YouTube: 6-month window; Apple: one per
// subscription group). Razorpay has no such check, so ours lives in the
// users doc and this is what stops cancel → re-subscribe costing ₹1 forever.

test('create-subscription: a returning account pays ₹49 from day one — no ₹1 addon', async () => {
  uidMap['returner@example.com'] = 'uid_ret';
  fsDocs.users = { uid_ret: { intro_used: true } };
  const res = makeRes();
  await createSubscription(makeReq({}, { as: 'returner@example.com' }), res);

  assert.equal(res.statusCode, 200);
  const created = razorpayState.lastCreate;
  assert.ok(!('addons' in created), 'no ₹1 addon for an account that used it');
  assert.ok(!('start_at' in created), 'the first ₹49 cycle starts immediately');
  assert.equal(created.plan_id, 'plan_test_1', 'the ₹49 plan still bills');
  assert.equal(res.body.intro_offer, false);
  assert.equal(res.body.first_month_price, 4900, 'month one costs ₹49, not ₹1');
  assert.equal(res.body.first_month_days, 0);
});

test('create-subscription: a legacy payer (payment record, no flag) does not get ₹1 again', async () => {
  // Accounts that paid before intro_used existed: their payment record is
  // the proof, so the flag's absence must not re-open the intro price.
  uidMap['legacy@example.com'] = 'uid_leg';
  fsDocs.payments = { pay_old: { identifier: 'legacy@example.com', status: 'approved' } };
  const res = makeRes();
  await createSubscription(makeReq({}, { as: 'legacy@example.com' }), res);

  assert.equal(res.statusCode, 200);
  const created = razorpayState.lastCreate;
  assert.ok(!('addons' in created), 'a previous payer must never be re-offered ₹1');
  assert.equal(res.body.intro_offer, false);
});

test('webhook: the first charge marks the ₹1 intro as used', async () => {
  uidMap['123spandana88@gmail.com'] = 'uid1';
  const body = chargedEvent('sub_intro', { phone: '123spandana88@gmail.com' });
  const res = makeRes();
  await webhook(makeReq(body, { sig: sign(body) }), res);
  assert.equal(res.statusCode, 200);
  const user = lastFsSet((s) => s.path === 'users/uid1');
  assert.equal(user.data.intro_used, true,
    'a successful charge is what spends the intro price');
});

test('payment/status: intro_eligible is true for an account that never paid', async () => {
  uidMap['fresh@example.com'] = 'uid_fresh';
  const res = makeRes();
  await paymentStatus(makeReq({}, { as: 'fresh@example.com' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.intro_eligible, true);
  assert.equal(res.body.subscribed, false);
});

test('payment/status: intro_eligible is false once the intro month was paid', async () => {
  uidMap['used@example.com'] = 'uid_used';
  fsDocs.users = { uid_used: { subscribed: false, intro_used: true } };
  const res = makeRes();
  await paymentStatus(makeReq({}, { as: 'used@example.com' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.intro_eligible, false);
});

test('payment/status: any payment record also closes the intro', async () => {
  uidMap['paid@example.com'] = 'uid_paid';
  fsDocs.payments = { pay_x: { identifier: 'paid@example.com', status: 'approved' } };
  const res = makeRes();
  await paymentStatus(makeReq({}, { as: 'paid@example.com' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.intro_eligible, false);
});

test('subscription/status: pro_until rides along so the app can show the end date', async () => {
  uidMap['a@b.com'] = 'uid_a';
  const until = new Date(Date.now() + 20 * 86400000).toISOString();
  fsDocs.users = { uid_a: { subscribed: true, pro_until: until } };
  const res = makeRes();
  await subscriptionStatus(makeReq({}, { query: { phone: 'a@b.com' } }), res);
  assert.equal(res.body.subscribed, true);
  assert.equal(res.body.pro_until, until);
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
