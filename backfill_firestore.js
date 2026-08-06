// One-time Postgres -> Firestore backfill (Phase 2 of the Firestore migration).
//
// Reads every row from the Postgres tables (users, meals, habit_data,
// subscriptions, payments) and writes the equivalent Firestore docs using the
// same schema as docs/firestore-migration.md and the Phase-1 dual-write in
// server.js. Referrals + userIndex are derived from the users table.
//
// Idempotent: every write uses merge:true, so re-running is safe. It will
// never delete or overwrite docs that Phase-1 dual-write created.
//
// Usage:
//   node backfill_firestore.js            # backfill everything
//   node backfill_firestore.js --dry-run  # count only, write nothing
//
// Requires the same env as the server: DATABASE_URL + Firestore credentials
// (FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS).
require('dotenv').config();
const { Pool } = require('pg');
const firestore = require('./firestore');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_MAX = 450; // Firestore batches cap at 500 operations

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const counts = {
  users: 0,
  userIndex: 0,
  referrals: 0,
  meals: 0,
  habitData: 0,
  subscriptions: 0,
  payments: 0,
  skippedNoUid: 0,
};

// Reuse the Phase-1 helper: lazy firebase-admin init + identifier -> uid.
firestore.init();

function fsDb() {
  const db = firestore.getDb();
  if (!db) {
    console.error(
      'Firestore is not enabled. Set FIREBASE_SERVICE_ACCOUNT_JSON ' +
        '(or GOOGLE_APPLICATION_CREDENTIALS) and DATABASE_URL, then retry.'
    );
    process.exit(1);
  }
  return db;
}

function toDate(v) {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

// pg returns JSONB columns as parsed objects; guard against strings anyway.
function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch (_) {
      return fallback;
    }
  }
  return v;
}

async function backfillUsers() {
  console.log('users...');
  const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
  for (const u of rows) {
    const identifier = u.phone;
    if (!identifier) continue;
    const uid = await firestore.resolveUid(identifier);
    if (!uid) {
      counts.skippedNoUid++;
      console.log('  skip user ' + identifier + ': no Firebase user (guest/deleted)');
      continue;
    }
    const doc = { identifier, name: u.name || '', subscribed: !!u.subscribed };
    if (u.email) doc.email = u.email;
    if (u.scan_count != null) doc.scanCount = u.scan_count;
    if (u.scan_month != null) doc.scanMonth = u.scan_month;
    if (u.referral_code) doc.referralCode = u.referral_code;
    if (u.referred_by) doc.referredBy = u.referred_by;
    if (u.subscription_id) doc.subscriptionId = u.subscription_id;
    const created = toDate(u.created_at);
    if (created) doc.createdAt = created;

    if (!DRY_RUN) {
      await firestore.set('users/' + uid, doc, { merge: true });
      await firestore.set(
        'userIndex/' + identifier,
        { uid, name: doc.name },
        { merge: true }
      );
      if (u.referral_code) {
        await firestore.set(
          'referrals/' + u.referral_code,
          { uid, identifier, createdAt: created || new Date() },
          { merge: true }
        );
      }
    }
    counts.users++;
    counts.userIndex++;
    if (u.referral_code) counts.referrals++;
  }
}

async function backfillMeals() {
  console.log('meals...');
  const { rows } = await pool.query('SELECT * FROM meals ORDER BY date ASC');
  const col = fsDb().collection('meals');
  let batch = null;
  let ops = 0;
  const flush = async () => {
    if (batch && ops > 0) {
      if (!DRY_RUN) await batch.commit();
      batch = null;
      ops = 0;
    }
  };
  for (const m of rows) {
    const uid = await firestore.resolveUid(m.phone);
    if (!uid) {
      counts.skippedNoUid++;
      continue;
    }
    if (!batch) batch = fsDb().batch();
    batch.set(col.doc(m.id), {
      uid,
      date: toDate(m.date) || new Date(),
      name: m.name || '',
      category: m.category || '',
      calories: m.calories || 0,
      protein: m.protein || 0,
      carbs: m.carbs || 0,
      fats: m.fats || 0,
      fiber: m.fiber || 0,
      serving: m.serving || '',
      createdAt: toDate(m.created_at) || new Date(),
    });
    ops++;
    counts.meals++;
    if (ops >= BATCH_MAX) await flush();
  }
  await flush();
}

async function backfillHabitData() {
  console.log('habit_data...');
  const { rows } = await pool.query('SELECT * FROM habit_data');
  for (const h of rows) {
    const uid = await firestore.resolveUid(h.phone);
    if (!uid) {
      counts.skippedNoUid++;
      continue;
    }
    const doc = {
      habits: parseJson(h.habits, []),
      waterLog: parseJson(h.water_log, {}),
      waterGoal: h.water_goal || 8,
      updatedAt: toDate(h.updated_at) || new Date(),
    };
    if (!DRY_RUN) {
      await firestore.set('habitData/' + uid, doc, { merge: true });
    }
    counts.habitData++;
  }
}

async function backfillSubscriptions() {
  console.log('subscriptions...');
  const { rows } = await pool.query('SELECT * FROM subscriptions');
  for (const s of rows) {
    const uid = s.phone ? await firestore.resolveUid(s.phone) : null;
    if (s.phone && !uid) counts.skippedNoUid++;
    const doc = {
      uid: uid || null,
      identifier: s.phone || null,
      status: s.status || 'created',
    };
    const created = toDate(s.created_at);
    const updated = toDate(s.updated_at);
    if (created) doc.createdAt = created;
    if (updated) doc.updatedAt = updated;
    if (!DRY_RUN) {
      await firestore.set('subscriptions/' + s.id, doc, { merge: true });
    }
    counts.subscriptions++;
  }
}

async function backfillPayments() {
  console.log('payments...');
  const { rows } = await pool.query('SELECT * FROM payments ORDER BY created_at ASC');
  for (const p of rows) {
    const uid = await firestore.resolveUid(p.phone);
    if (!uid) counts.skippedNoUid++;
    const doc = {
      uid: uid || null,
      identifier: p.phone,
      transactionRef: p.transaction_ref,
      amount: p.amount,
      status: p.status,
    };
    const created = toDate(p.created_at);
    if (created) doc.createdAt = created;
    // Doc id: pg_<serial> - deterministic and distinct from the razorpay
    // payment ids written by Phase-1 dual-write (payments/{payment_id}).
    if (!DRY_RUN) {
      await firestore.set('payments/pg_' + p.id, doc, { merge: true });
    }
    counts.payments++;
  }
}

async function main() {
  if (!firestore.isEnabled()) {
    console.error(
      'Firestore is not enabled. Set FIREBASE_SERVICE_ACCOUNT_JSON ' +
        '(or GOOGLE_APPLICATION_CREDENTIALS) and DATABASE_URL, then retry.'
    );
    await pool.end();
    process.exit(1);
  }
  console.log(
    DRY_RUN
      ? 'DRY RUN - counting only, no writes'
      : 'Backfilling Postgres -> Firestore'
  );
  await backfillUsers();
  await backfillMeals();
  await backfillHabitData();
  await backfillSubscriptions();
  await backfillPayments();
  console.log('\nSummary:');
  console.log(JSON.stringify(counts, null, 2));
  console.log(
    DRY_RUN
      ? 'DRY RUN complete - rerun without --dry-run to write.'
      : 'Backfill complete.'
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error('Backfill failed:', e);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
