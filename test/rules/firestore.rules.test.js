'use strict';

// Real Firestore rules tests, run against the emulator.
//
// test/firestore_rules_test.dart in the app only greps the rules TEXT, so it
// would pass while a client write actually succeeded. These assertions run the
// rules themselves:
//
//   npx firebase-tools emulators:exec --only firestore \
//     --project demo-macrosnap "node --test test/rules"
//
// (npm run test:rules does exactly that.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(
  path.join(__dirname, '..', '..', 'app', 'firestore.rules'),
  'utf8'
);

let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-macrosnap',
    firestore: { rules: RULES },
  });
});

test.after(async () => {
  if (env) await env.cleanup();
});

test.beforeEach(async () => {
  await env.clearFirestore();
});

const WEEK = '2026-W47';

function asUser(uid, token = {}) {
  return env.authenticatedContext(uid, token).firestore();
}

async function seed(fn) {
  await env.withSecurityRulesDisabled(async (context) => {
    await fn(context.firestore());
  });
}

const boardDoc = (db, uid, scope = 'india') =>
  db.doc(`leaderboard/${WEEK}/scopes/${scope}/entries/${uid}`);

const entry = (uid) => ({
  uid,
  name: 'Rahul',
  week: WEEK,
  scope: 'india',
  points: 90,
  stateKey: 'maharashtra',
  district: 'pune',
  districtKey: 'pune',
});

// ─── The board is server-write-only ──────────────────────────────────────

test('a signed-in user cannot write their own board row', async () => {
  const db = asUser('uid-a');
  await assertFails(boardDoc(db, 'uid-a').set(entry('uid-a')));
  await assertFails(boardDoc(db, 'uid-a').update({ points: 630 }));
  await assertFails(boardDoc(db, 'uid-a').delete());
});

test('a user cannot write someone else\'s board row either', async () => {
  const db = asUser('uid-a');
  await assertFails(boardDoc(db, 'uid-b').set(entry('uid-b')));
});

test('a signed-in user can read the board, a signed-out one cannot', async () => {
  await seed((db) => boardDoc(db, 'uid-b').set(entry('uid-b')));
  await assertSucceeds(boardDoc(asUser('uid-a'), 'uid-b').get());
  await assertFails(
    boardDoc(env.unauthenticatedContext().firestore(), 'uid-b').get()
  );
});

test('the server score documents are invisible to clients', async () => {
  const db = asUser('uid-a');
  await seed(async (admin) => {
    await admin.doc('leaderboardDays/uid-a/days/2026-11-16').set({
      date: '2026-11-16',
      points: 90,
    });
    await admin.doc('leaderboardPublish/uid-a').set({
      week: WEEK,
      scopes: ['india'],
    });
  });
  await assertFails(db.doc('leaderboardDays/uid-a/days/2026-11-16').get());
  await assertFails(db.doc('leaderboardPublish/uid-a').get());
  await assertFails(
    db.doc('leaderboardDays/uid-a/days/2026-11-16').set({ points: 630 })
  );
});

// ─── Entitlements stay server-side ───────────────────────────────────────

test('nobody can grant themselves Pro on users/{uid}', async () => {
  const db = asUser('uid-a');
  await seed((admin) =>
    admin.doc('users/uid-a').set({ subscribed: false, referralCode: 'ABC123' })
  );
  await assertSucceeds(db.doc('users/uid-a').get());
  await assertFails(db.doc('users/uid-a').update({ subscribed: true }));
  await assertFails(db.doc('users/uid-a').set({ subscribed: true }));
});

// ─── Meals keep their owner ──────────────────────────────────────────────

const meal = (uid) => ({
  uid,
  name: 'Dal',
  calories: 220,
  date: '2026-11-22',
});

test('a meal can only be created as yourself', async () => {
  const db = asUser('uid-a');
  await assertSucceeds(db.doc('meals/m1').set(meal('uid-a')));
  await assertFails(db.doc('meals/m2').set(meal('uid-b')));
});

test('a meal cannot be moved to another account on update', async () => {
  await seed((admin) => admin.doc('meals/m1').set(meal('uid-a')));
  await assertFails(asUser('uid-a').doc('meals/m1').update({ uid: 'uid-b' }));
});

// ─── Weigh-in evidence ───────────────────────────────────────────────────

test('today\'s weight document is owner-only and bounded', async () => {
  const db = asUser('uid-a');
  const own = db.doc('weightLog/uid-a/days/2026-11-22');
  const other = asUser('uid-b').doc('weightLog/uid-a/days/2026-11-22');

  await assertSucceeds(own.set({ date: '2026-11-22', kg: 72.5 }));
  await assertSucceeds(own.get());

  // A nonsensical weight, a bad date or another account's document is refused.
  await assertFails(own.set({ date: '2026-11-22', kg: 600 }));
  await assertFails(own.set({ date: '2026-11-22', kg: -1 }));
  await assertFails(own.set({ date: 'yesterday', kg: 72 }));
  await assertFails(other.set({ date: '2026-11-22', kg: 72 }));
  await assertFails(other.get());
});

// ─── Weight evidence is not a leaderboard back door ──────────────────────

test('a bogus extra field is refused on the weight document', async () => {
  const db = asUser('uid-a');
  await assertFails(
    db.doc('weightLog/uid-a/days/2026-11-22').set({
      date: '2026-11-22',
      kg: 72,
      points: 630,
      note: 'x'.repeat(500),
    })
  );
});
