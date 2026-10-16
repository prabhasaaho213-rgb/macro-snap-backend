require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { Pool } = require('pg');
const firestore = require('./firestore');
const { requireAuth, identityOf } = require('./auth');

const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
// Uploads are buffered in MEMORY, so an unbounded body is an unbounded RAM
// allocation per request — one oversized file could take the process down.
// Cap it well above anything the app actually sends (the client compresses to
// a ~1024px JPEG) and let multer reject anything bigger with LIMIT_FILE_SIZE,
// which the error handler below turns into a clean 413.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

// Capture the raw request body for every request so the Razorpay payment
// webhook can verify its HMAC signature against the exact bytes sent
// (express.json alone would only give us the parsed object).
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Postgres is now OPTIONAL. When DATABASE_URL is unset (e.g. Vercel free
// tier) the server runs fully on Firestore: every Postgres call degrades
// gracefully through the safe dbq() helper below and scan limits /
// subscription state are read from Firestore instead.
const dbAvailable = !!process.env.DATABASE_URL;
const pool = dbAvailable
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
firestore.init();

// Safe DB query: never throws when Postgres is absent or down.
async function dbq(sql, params) {
  if (!pool) return { rows: [] };
  try {
    return await pool.query(sql, params);
  } catch (e) {
    console.error('DB query failed (continuing without Postgres):', e.message);
    // _failed lets callers distinguish "query errored" from "clean miss" —
    // security checks (the deletion tombstone) must fail closed on errors.
    return { rows: [], _failed: true };
  }
}

// Gemini model — the 2.5 generation is retired for new API keys (2026), so
// the default is a current vision-capable lite model. Override via GEMINI_MODEL.
//
// Verify what YOUR key can actually use with the Models API (the listing lives
// under v1beta, not v1):
//   curl 'https://generativelanguage.googleapis.com/v1beta/models' \
//     -H "x-goog-api-key: $GEMINI_KEY"
// then pick an id whose supportedGenerationMethods include generateContent.
// A model that is in the public catalogue can still be unavailable to a given
// key, so this is the only real confirmation.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// The API version is configurable because the newest models are not always
// served on every version: the Models API itself is documented under v1beta,
// while v1 is the long-stable surface. If a key reports the model as not found
// on v1, switch to v1beta (or another model) with an env var rather than a
// code change — no redeploy of logic, just a variable.
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1';

// One call site for Gemini's generateContent, so the API key lives in exactly
// one place. The key goes in the x-goog-api-key HEADER, never the URL: a
// ?key= query string leaks into request logs, proxies, and any error message
// that echoes the URL. (Authorization: Bearer is for OAuth access tokens, not
// for API keys, so it is deliberately not used here.)
async function geminiGenerate(body) {
  return fetch(
    `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': String(process.env.GEMINI_KEY || ''),
      },
      // Accepts a pre-stringified body or a plain object, whichever the
      // caller already has (the /analyze prompt is built as a string).
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }
  );
}

// ─── Per-user rate limiting ──────────────────────────────────────────────
// Every route below calls Gemini on our API key, so an unthrottled endpoint
// is an open-ended bill. This is a simple fixed-window counter per user per
// route — no dependency, and no state to lose on serverless cold starts
// (worst case a burst gets one extra window, which is still bounded).
//
// Keyed on the VERIFIED uid, never on a client-supplied field, so one user
// cannot evade the cap by rotating a header. Guests (no uid) are keyed by
// remote address, which is the only identity we have for them.
const RATE_WINDOWS = {
  // route            per-minute cap
  '/chat': 30,
  '/analyze': 20,
  '/generate-diet-plan': 6,
};
const RATE_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map(); // key -> { windowStart, count }

// Test seam: lets a test reset the counters without reaching into the Map.
function resetRateLimits() {
  rateBuckets.clear();
}

// Returns null when the caller may proceed, or the number of ms until the
// next window when they have exceeded the cap.
function rateLimitFor(bucketKey, limit) {
  const now = Date.now();
  let b = rateBuckets.get(bucketKey);
  if (!b || now - b.windowStart >= RATE_WINDOW_MS) {
    b = { windowStart: now, count: 0 };
    rateBuckets.set(bucketKey, b);
  }
  b.count += 1;
  return b.count > limit ? b.windowStart + RATE_WINDOW_MS - now : null;
}

// Express guard for one of the RATE_WINDOWS routes. 429 with Retry-After.
function rateLimit(route) {
  const limit = RATE_WINDOWS[route];
  return (req, res, next) => {
    const uid = (req.user && req.user.uid) || null;
    const key = uid || (req.ip || 'anon') + ':' + route;
    const retryAfterMs = rateLimitFor(key + ':' + route, limit);
    if (retryAfterMs == null) return next();
    res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    return res.status(429).json({
      error: 'rate_limited',
      message: 'Too many requests. Please wait a moment and try again.',
      retry_after_ms: retryAfterMs,
    });
  };
}

// ─── Safe error replies ──────────────────────────────────────────────────
// A raw e.message can leak internals: Gemini's own error text, a Postgres
// column name, a filesystem path. Known, deliberate messages (thrown as
// SafeError) reach the user; everything else becomes a generic apology and
// is logged server-side instead.
class SafeError extends Error {}

// Every catch block below funnels through here. `req.route.path` names the
// route in the server log (falling back to 'api' when the harness omits it),
// so an operator can still trace a failure without the client seeing guts.
function sendFailure(req, res, e) {
  if (e instanceof SafeError) {
    return res.status(500).json({ error: e.message });
  }
  const route = (req && req.route && req.route.path) || (req && req.originalUrl) || 'api';
  console.error(`[${route}]`, e && e.stack ? e.stack : e);
  return res.status(500).json({
    error: 'Something went wrong. Please try again.',
  });
}

// Razorpay is optional: when the keys are unset the server still runs (the
// payment endpoints return a clear 'not configured' error instead).
const razorpay =
  process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      })
    : null;

app.get('/', (req, res) => res.send('OK'));

// ─── Razorpay Subscription plan (created once, cached in memory) ───────
// Real recurring billing needs a monthly plan. We reuse an existing matching
// plan if present (idempotent across redeploys) and create one otherwise.
let cachedPlanId = null;
async function getPlanId() {
  if (!razorpay) return null;
  if (cachedPlanId) return cachedPlanId;
  try {
    const plans = await razorpay.plans.all({ count: 100 });
    const match = (plans.items || []).find(
      (p) =>
        p.item &&
        p.item.amount === 2900 &&
        p.item.name === 'MacroSnap Pro' &&
        p.period === 'monthly' &&
        p.interval === 1
    );
    if (match) {
      cachedPlanId = match.id;
      return match.id;
    }
  } catch (_) {}
  const plan = await razorpay.plans.create({
    period: 'monthly',
    interval: 1,
    item: {
      name: 'MacroSnap Pro',
      amount: 2900, // ₹29 in paise
      currency: 'INR',
      description: 'MacroSnap Pro monthly subscription',
    },
    notes: { app: 'macrosnap' },
  });
  cachedPlanId = plan.id;
  return plan.id;
}

// A malformed JSON body is a CLIENT BUG, not a success. This used to answer
// 200 {ok:true}, which quietly hid broken requests — worst on /payment/verify,
// where an "ok" response reads like a verified payment. It is a 400 now.
//
// Registered as error middleware, so Express routes everything that calls
// next(err) here, including express.json() above and multer's body limits.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body must be valid JSON.' });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'image_too_large', message: 'Image is too large. Please send a photo under 10 MB.' });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'too_many_files', message: 'Send exactly one image.' });
  }
  next(err);
});

async function initDB(retries = 5) {
  if (!dbAvailable) {
    console.log('DATABASE_URL not set — running without Postgres (Firestore only)');
    return;
  }
  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS users (
            phone TEXT PRIMARY KEY,
            email TEXT,
            name TEXT DEFAULT '',
            subscribed BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS meals (
            id TEXT PRIMARY KEY,
            phone TEXT REFERENCES users(phone),
            date TIMESTAMPTZ NOT NULL,
            name TEXT NOT NULL,
            category TEXT DEFAULT '',
            calories INTEGER NOT NULL,
            protein DOUBLE PRECISION NOT NULL,
            carbs DOUBLE PRECISION NOT NULL,
            fats DOUBLE PRECISION NOT NULL,
            fiber DOUBLE PRECISION NOT NULL,
            serving TEXT DEFAULT '',
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS habit_data (
            phone TEXT PRIMARY KEY,
            habits JSONB NOT NULL DEFAULT '[]'::jsonb,
            water_log JSONB NOT NULL DEFAULT '{}'::jsonb,
            water_goal INTEGER DEFAULT 8,
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE TABLE IF NOT EXISTS subscriptions (
            id TEXT PRIMARY KEY,
            phone TEXT,
            status TEXT DEFAULT 'created',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
        `);;
        try { await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT'); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT DEFAULT ''"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS scan_count INTEGER DEFAULT 0"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS scan_month INTEGER DEFAULT 0"); } catch (_) {}
        // The free-scan counter is per IST DAY now (YYYY-MM-DD), not per
        // calendar month — see istDayKey().
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS scan_day TEXT"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_id TEXT"); } catch (_) {}
        // trial_started_at was missing from both CREATE TABLE and this ALTER
        // list, so every Postgres trial read/grant silently failed and
        // /trial/status re-issued an UNPERSISTED fresh 30-day window on each
        // check. Adding it makes the one-time grant actually persist.
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ"); } catch (_) {}
        try { await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_code ON users (referral_code)"); } catch (_) {}
        await client.query(`
          CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            phone TEXT NOT NULL,
            transaction_ref TEXT NOT NULL,
            amount INTEGER DEFAULT 29,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
        `);
        // Deletion tombstone: remembers an account's identifier (phone/email)
        // and its ORIGINAL trial start AFTER the account is deleted. This is
        // what stops a delete -> re-login -> fresh free-trial loop — see
        // getDeletionTombstone()/getOrGrantTrial(). Never wiped.
        await client.query(`
          CREATE TABLE IF NOT EXISTS deleted_accounts (
            identifier TEXT PRIMARY KEY,
            phone TEXT,
            email TEXT,
            trial_started_at TIMESTAMPTZ,
            deleted_at TIMESTAMPTZ DEFAULT NOW()
          );
        `);
        console.log('Database tables ready');
        return;
      } finally {
        client.release();
      }
    } catch (e) {
      console.log(`DB init attempt ${i + 1}/${retries} failed: ${e.message}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.log('DB init failed after all retries, running without database');
}
initDB();

async function prepareImage(buffer, mimetype) {
  if (mimetype === 'image/jpeg') return buffer;
  return sharp(buffer).jpeg().toBuffer();
}

// Free AI scans per IST day, per verified user. THE SERVER IS THE AUTHORITY:
// the app's counter is only a display estimate (lib/services/scan_gate.dart).
const SCAN_LIMIT_FREE = 3;

// Asia/Kolkata is UTC+5:30 year-round (no DST), so IST is just a fixed
// offset. Everything about the daily reset is derived from it — a UTC reset
// would hand Indian users a fresh allowance at 5:30 AM instead of midnight.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// The IST calendar day ('YYYY-MM-DD') a scan counts against.
function istDayKey(now = Date.now()) {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// The instant the current IST day ends (next IST midnight) as a UTC ISO
// string, so the app can show a countdown to the reset.
function istDayEndsAt(now = Date.now()) {
  const start = Date.parse(`${istDayKey(now)}T00:00:00.000Z`) - IST_OFFSET_MS;
  return new Date(start + 24 * 60 * 60 * 1000).toISOString();
}

// The owner/admin account is always Pro — exempt from the free scan limit.
// Mirrors SubscriptionService.adminEmail in the Flutter app. After Google
// sign-in the app sends the user's email as the `phone` field, so a simple
// case-insensitive match identifies the admin here.
//
// REQUIRES A VERIFIED EMAIL. `email_verified` is true for Google sign-in but
// false for a brand-new email/password account — so without this check anyone
// who enables that sign-in method and registers with the admin's address gets
// free Pro. An unverified address must never claim the owner's privileges.
const ADMIN_EMAIL = 'prabhasaaho213@gmail.com';

function isAdminUser(identifier, emailVerified) {
  if (emailVerified !== true) return false;
  return typeof identifier === 'string' &&
    identifier.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

// ── 30-day free trial ────────────────────────────────────────────────────
// Every user — new signups and existing users after they update + log in —
// gets ONE 30-day free Pro plan. The grant is one-time: trial_started_at is
// written only when absent and is never reset, so the trial can only ever be
// claimed once per account. Firestore users/{uid}.trial_started_at is the
// source of truth; Postgres is a best-effort fallback for legacy
// deployments (the column may not exist there, which we swallow).
const TRIAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function trialState(startedAt, now = Date.now()) {
  if (!startedAt) return { active: false, expired: false, daysLeft: 0 };
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return { active: false, expired: false, daysLeft: 0 };
  const ends = started + TRIAL_DAYS * DAY_MS;
  const endsAt = new Date(ends).toISOString();
  if (now >= ends) return { active: false, expired: true, daysLeft: 0, endsAt };
  return {
    active: true,
    expired: false,
    daysLeft: Math.max(1, Math.ceil((ends - now) / DAY_MS)),
    endsAt,
  };
}

// Reads the deletion tombstone for an identifier (Postgres + Firestore).
// Returns { found, trialStartedAt, errored }:
//   found   = this account was deleted; trialStartedAt is the trial it had
//             already consumed (null if it never claimed one).
//   errored = a configured tombstone store could NOT be read, so "no
//             tombstone" cannot be proven — getOrGrantTrial then fails
//             closed and mints no fresh trial.
// getOrGrantTrial uses this to never re-grant a fresh trial to a
// deleted-and-re-registered account.
async function getDeletionTombstone(identifier) {
  const out = { found: false, trialStartedAt: null, errored: false };
  // Firestore tombstone (deletedAccounts/{identifier}) — survives on the
  // DB-less deployment and is keyed (lowercased) by identifier so it holds
  // even after the Firebase Auth user (and its uid-keyed docs) are gone.
  if (firestore.isEnabled()) {
    try {
      const idKey = String(identifier).toLowerCase();
      const snap = await firestore.getDb().collection('deletedAccounts').doc(idKey).get();
      if (snap.exists) {
        const d = snap.data() || {};
        return { found: true, trialStartedAt: d.trial_started_at || null, errored: false };
      }
    } catch (_) {
      out.errored = true; // store unreachable — absence is unproven
    }
  }
  // Postgres tombstone. Matched CASE-INSENSITIVELY: the same mail can
  // arrive as 'User@x.com' at deletion time and 'user@x.com' at re-login,
  // and an exact match would miss the tombstone and re-open the trial loop.
  if (dbAvailable) {
    const r = await dbq(
      'SELECT trial_started_at FROM deleted_accounts WHERE LOWER(identifier) = LOWER($1) OR LOWER(phone) = LOWER($1) OR LOWER(email) = LOWER($1) LIMIT 1',
      [identifier]
    );
    if (r._failed) out.errored = true;
    else if (r.rows && r.rows.length > 0) {
      return { found: true, trialStartedAt: r.rows[0].trial_started_at || null, errored: false };
    }
  }
  return out;
}

// Reads the trial start for an identifier, granting the one-time trial when
// no record exists yet. Returns the ISO start or null when nothing can be
// stored (no Firestore doc and no DB) — the caller then reports no trial.
async function getOrGrantTrial(identifier) {
  // A deleted account can NEVER claim a fresh free trial. The tombstone
  // preserves the ORIGINAL trial start (or null), so re-login after deletion
  // reports the already-consumed trial (usually expired) instead of a new
  // 30 days — this closes the delete -> re-register trial-abuse loop.
  const tomb = await getDeletionTombstone(identifier);
  if (tomb.found) return tomb.trialStartedAt;
  // Fail closed: when the tombstone store could not be READ we cannot prove
  // this identity never deleted its account — never mint a fresh trial.
  // (Existing trials are still returned below, so a transient error never
  // strips a legit countdown.)
  const refuseFreshGrant = tomb.errored;
  const fUid = await firestore.resolveUid(identifier);
  if (fUid && firestore.isEnabled()) {
    try {
      const ref = firestore.getDb().collection('users').doc(fUid);
      const doc = await ref.get();
      const existing = doc.exists ? doc.data().trial_started_at : null;
      if (existing) return existing;
      if (refuseFreshGrant) return null;
      const nowIso = new Date().toISOString();
      await firestore.set('users/' + fUid, { trial_started_at: nowIso }, { merge: true });
      return nowIso;
    } catch (_) {}
  }
  try {
    const r = await dbq('SELECT trial_started_at FROM users WHERE phone = $1 OR email = $1 LIMIT 1', [identifier]);
    const existing = r.rows[0] && r.rows[0].trial_started_at;
    if (existing) return existing;
    if (refuseFreshGrant) return null;
    const nowIso = new Date().toISOString();
    // Persist the grant so it stays ONE-TIME. The old bare UPDATE matched
    // no row for a brand-new identity, so every check silently re-issued a
    // fresh 30-day window. Write only while absent, create the row when the
    // identity has none, then report what actually got stored (null if
    // nothing did — an unpersisted start would roll forever).
    await dbq(
      'UPDATE users SET trial_started_at = $2 WHERE (phone = $1 OR email = $1) AND trial_started_at IS NULL',
      [identifier, nowIso]
    );
    await dbq(
      'INSERT INTO users (phone, trial_started_at) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM users WHERE phone = $1 OR email = $1)',
      [identifier, nowIso]
    );
    const back = await dbq('SELECT trial_started_at FROM users WHERE phone = $1 OR email = $1 LIMIT 1', [identifier]);
    return (back.rows[0] && back.rows[0].trial_started_at) || null;
  } catch (_) {
    return null; // DB-less legacy deployment without Firestore — no trial.
  }
}

// Postgres-only trial lookup (never grants). Swallows a missing column.
async function pgTrial(identifier) {
  try {
    const r = await dbq('SELECT trial_started_at FROM users WHERE phone = $1 OR email = $1 LIMIT 1', [identifier]);
    return trialState(r.rows[0] && r.rows[0].trial_started_at);
  } catch (_) {
    return { active: false, expired: false, daysLeft: 0 };
  }
}

// ─── Free-scan entitlements — the SERVER is the authority ─────────────────
//
// Reads this user's subscription/trial state and their daily scan counter in
// ONE place, so /analyze, GET /me/entitlements and the 403 response can never
// disagree. Identity comes from the verified token (see auth.js) — never from
// anything the client typed.
//
// The counter resets at IST midnight: a value stored for a previous IST day
// is stale and reads as zero, so a user gets a fresh 3 every Indian morning.
async function entitlementsFor({ uid, identifier, emailVerified }) {
  const day = istDayKey();
  const resetAt = istDayEndsAt();
  // The owner/admin account is always Pro — exempt from the free limit.
  let subscribed = !!identifier && isAdminUser(identifier, emailVerified);
  let trialEndsAt = null;
  let storedDay = null;
  let count = 0;

  // Firestore users/{uid} is the source of truth (production runs DB-less).
  if (uid && firestore.isEnabled()) {
    try {
      const doc = await firestore.getDb().collection('users').doc(uid).get();
      const d = (doc.exists ? doc.data() : {}) || {};
      if (d.subscribed === true) subscribed = true;
      const ts = trialState(d.trial_started_at);
      if (ts.active) {
        subscribed = true;
        trialEndsAt = ts.endsAt;
      }
      storedDay = d.scanDay || null;
      count = Number(d.scanCount) || 0;
    } catch (_) {}
  }

  // Postgres fallback (legacy deployments).
  if (dbAvailable && identifier) {
    if (!subscribed) {
      const u = await dbq(
        'SELECT subscribed, trial_started_at FROM users WHERE phone = $1 OR email = $1 LIMIT 1',
        [identifier]
      );
      const row = u.rows[0];
      if (row && row.subscribed) subscribed = true;
      const ts = trialState(row && row.trial_started_at);
      if (ts.active) {
        subscribed = true;
        trialEndsAt = ts.endsAt;
      }
    }
    if (storedDay === null) {
      const r = await dbq('SELECT scan_count, scan_day FROM users WHERE phone = $1 LIMIT 1', [identifier]);
      const row = r.rows[0] || {};
      storedDay = row.scan_day || null;
      count = Number(row.scan_count) || 0;
    }
  }

  const used = storedDay === day ? count : 0;
  return {
    subscribed,
    scans_used: used,
    // null = no limit (Pro/admin). The app shows "Unlimited" then.
    scans_limit: subscribed ? null : SCAN_LIMIT_FREE,
    scans_remaining: subscribed ? null : Math.max(0, SCAN_LIMIT_FREE - used),
    scan_day: day,
    reset_at: resetAt,
    trial_ends_at: trialEndsAt,
  };
}

// ── Atomic scan reservation ────────────────────────────────────────────────
//
// The old flow checked the count up front and only incremented AFTER Gemini
// answered. Two requests in flight at the same moment both read "2 of 3
// used", both passed the check, and both got a scan — so parallel requests
// walked straight past the free limit. The increment was also a plain
// read-then-write, which loses updates under concurrency.
//
// Fix: take the scan BEFORE the expensive call, in ONE atomic step that both
// checks and increments. If the analysis later fails, [releaseScan] hands the
// scan back, so a Gemini error never costs the user an allowance.
//
// Firestore uses a real transaction (read -> decide -> write), so two
// concurrent requests serialise and cannot both pass the same limit check.
// Postgres does the same check-and-increment in a single conditional
// statement, which is atomic by construction.

// Reserves one free scan for today. Returns { ok, used } — used is the count
// AFTER the reservation, or the unchanged count when ok is false.
async function reserveScan({ uid, identifier, day }) {
  if (uid && firestore.isEnabled()) {
    const db = firestore.getDb();
    const ref = db.collection('users').doc(uid);
    try {
      return await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const d = (doc.exists ? doc.data() : {}) || {};
        const used = d.scanDay === day ? (Number(d.scanCount) || 0) : 0;
        if (used >= SCAN_LIMIT_FREE) return { ok: false, used };
        tx.set(ref, { scanCount: used + 1, scanDay: day }, { merge: true });
        return { ok: true, used: used + 1 };
      });
    } catch (_) {
      // Unreachable / no transaction support — fail closed: no scan granted.
      return { ok: false, used: null };
    }
  }
  if (dbAvailable && identifier) {
    // One statement: insert-or-conditionally-increment. The WHERE on the
    // DO UPDATE clause is what makes the limit check atomic — when it fails,
    // no row comes back and the caller treats it as "limit reached".
    const r = await dbq(
      `INSERT INTO users (phone, scan_day, scan_count) VALUES ($1, $2, 1)
       ON CONFLICT (phone) DO UPDATE SET
         scan_day = EXCLUDED.scan_day,
         scan_count = CASE WHEN users.scan_day = EXCLUDED.scan_day
                           THEN COALESCE(users.scan_count, 0) + 1 ELSE 1 END
       WHERE users.scan_day IS DISTINCT FROM EXCLUDED.scan_day
          OR COALESCE(users.scan_count, 0) < $3
       RETURNING scan_count`,
      [identifier, day, SCAN_LIMIT_FREE]
    );
    if (r._failed) return { ok: false, used: null };
    if (r.rows && r.rows[0]) return { ok: true, used: r.rows[0].scan_count };
    return { ok: false, used: null }; // limit genuinely reached
  }
  // No counter store at all — allow the scan but count nothing (legacy
  // DB-less deployments keep working exactly as before).
  return { ok: true, used: null };
}

// Hands a reserved scan back after a failed analysis. Best-effort: a lost
// refund only over-counts by one, which is strictly better than the old
// behaviour of granting extra scans.
async function releaseScan({ uid, identifier, day }) {
  if (uid && firestore.isEnabled()) {
    const db = firestore.getDb();
    const ref = db.collection('users').doc(uid);
    try {
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const d = (doc.exists ? doc.data() : {}) || {};
        if (d.scanDay !== day) return;
        const used = Number(d.scanCount) || 0;
        if (used <= 0) return;
        tx.set(ref, { scanCount: used - 1, scanDay: day }, { merge: true });
      });
    } catch (_) {}
    return;
  }
  if (dbAvailable && identifier) {
    await dbq(
      'UPDATE users SET scan_count = GREATEST(COALESCE(scan_count, 0) - 1, 0) WHERE phone = $1 AND scan_day = $2',
      [identifier, day]
    );
  }
}

app.post('/analyze', requireAuth, upload.single('image'), rateLimit('/analyze'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    // Identity comes from the VERIFIED TOKEN (auth.js) — the name is not
    // taken from req.body, so one user can never spend another user's scans
    // (or dodge their own limit) by sending a different phone/email.
    const id = identityOf(req);
    const ent = await entitlementsFor(id);
    if (!ent.subscribed && ent.scans_used >= SCAN_LIMIT_FREE) {
      return res.status(403).json({
        error: 'scan_limit_reached',
        scans_used: ent.scans_used,
        scans_limit: SCAN_LIMIT_FREE,
        scans_remaining: 0,
        scan_day: ent.scan_day,
        reset_at: ent.reset_at,
      });
    }

    // Take the scan BEFORE the expensive AI call, in one atomic
    // check-and-increment. Reserving up front is what closes the parallel
    // request hole: N simultaneous requests can no longer all read "2 of 3
    // used" and all pass. Pro/admin never reserve (no limit to spend).
    let reservation = null;
    if (!ent.subscribed) {
      const r = await reserveScan({ uid: id.uid, identifier: id.identifier, day: ent.scan_day });
      if (!r.ok) {
        // Either the allowance is genuinely gone, or the counter store
        // could not be written. Both fail closed — no free analysis.
        const usedCount = r.used == null ? SCAN_LIMIT_FREE : r.used;
        return res.status(403).json({
          error: 'scan_limit_reached',
          scans_used: usedCount,
          scans_limit: SCAN_LIMIT_FREE,
          scans_remaining: Math.max(0, SCAN_LIMIT_FREE - usedCount),
          scan_day: ent.scan_day,
          reset_at: ent.reset_at,
        });
      }
      reservation = r;
    }

    // From here on the scan is paid for. Any failure below must hand it
    // back, so a Gemini error never burns a user's allowance.
    const refundScan = () => {
      if (reservation) releaseScan({ uid: id.uid, identifier: id.identifier, day: ent.scan_day });
    };

    let json;
    try {
      const jpegBuffer = await prepareImage(req.file.buffer, req.file.mimetype);
      const base64 = jpegBuffer.toString('base64');

      const body = JSON.stringify({
        contents: [{
          parts: [
            { text: `You are a professional nutritionist. The photo shows food — it may be from ANY cuisine: Indian, South Asian, Western, bakery & desserts, street food, fruits, packaged foods, etc. Name EVERY visible food item ACCURATELY as it actually is (for example "Chocolate cake", "Donut", "Rice with dal", "Butter chicken", "Pizza", "Banana"). NEVER force a food into a different dish: a cake is a cake, a cookie is a cookie — do NOT relabel desserts or baked goods as Indian sweets. If the food is a dessert, baked good, snack, or any non-Indian item, identify it precisely and use its standard nutrition data. Return ONLY valid JSON:
{
  "description": "brief summary of what was detected",
  "confidence": estimated accuracy 0-1,
  "dishes": [
    {
      "name": "accurate food name in English",
      "portion_description": "estimated portion like '1 small bowl' or '1 slice (80g)'",
      "calories_per_100g": integer,
      "protein_g_per_100g": number,
      "carbs_g_per_100g": number,
      "fats_g_per_100g": number,
      "fiber_g_per_100g": number,
      "sugar_g_per_100g": number,
      "suitable_for": "bulk"/"diet"/"both"
    }
  ]
}
Rules: 1 dish entry per visible item. Be specific about the portion. Use standard nutrition data. If unsure, name the most likely food rather than guessing an Indian equivalent. Return ONLY raw JSON. No markdown. No backticks.` },
            { inlineData: { mimeType: 'image/jpeg', data: base64 } }
          ]
        }]
      });

      const resp = await geminiGenerate(body);

      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) throw new Error('Empty response from AI');

      const cleaned = text.replace(/```json?/g, '').replace(/```/g, '').trim();
      json = JSON.parse(cleaned.substring(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
    } catch (e) {
      // The analysis failed AFTER the scan was reserved — hand it back so a
      // Gemini/parse error never costs the user an allowance.
      refundScan();
      throw e;
    }

    // The scan was already reserved up front, so there is nothing left to
    // increment here — these are just the numbers the reservation produced.
    // Pro/admin never reserved, so they still report the untouched count.
    let scansUsed = reservation ? reservation.used : ent.scans_used;
    let scansLimit = ent.subscribed ? null : SCAN_LIMIT_FREE;

    let dishes = json.dishes;
    if (!dishes || !Array.isArray(dishes) || dishes.length === 0) {
      dishes = [{
        name: json.meal_name || 'Unknown',
        portion_description: json.portion_description || '',
        calories_per_100g: json.calories_per_100g ?? json.calories ?? 0,
        protein_g_per_100g: json.protein_g_per_100g ?? json.protein_g ?? 0,
        carbs_g_per_100g: json.carbs_g_per_100g ?? json.carbs_g ?? 0,
        fats_g_per_100g: json.fats_g_per_100g ?? json.fats_g ?? 0,
        fiber_g_per_100g: json.fiber_g_per_100g ?? json.fiber_g ?? 0,
        sugar_g_per_100g: json.sugar_g_per_100g ?? 0,
        suitable_for: json.suitable_for || 'both'
      }];
    }

    const normalized = {
      description: json.description || '',
      confidence: json.confidence ?? 0.7,
      dishes: dishes.map(d => ({
        name: d.name || 'Unknown',
        portion_description: d.portion_description || '',
        calories_per_100g: d.calories_per_100g ?? d.calories ?? 0,
        protein_g_per_100g: d.protein_g_per_100g ?? d.protein_g ?? 0,
        carbs_g_per_100g: d.carbs_g_per_100g ?? d.carbs_g ?? 0,
        fats_g_per_100g: d.fats_g_per_100g ?? d.fats_g ?? 0,
        fiber_g_per_100g: d.fiber_g_per_100g ?? d.fiber_g ?? 0,
        sugar_g_per_100g: d.sugar_g_per_100g ?? 0,
        suitable_for: d.suitable_for || 'both'
      })),
      scans_used: scansUsed,
      scans_limit: scansLimit,
      scans_remaining: scansLimit == null ? null : Math.max(0, scansLimit - scansUsed),
      subscribed: ent.subscribed,
      scan_day: ent.scan_day,
      reset_at: ent.reset_at
    };

    // A low-confidence or "Unknown" result is not a real identification. The
    // app's low-confidence banner tells the user such a scan is NOT counted,
    // so honour that promise: hand the reservation back and report the
    // corrected numbers. Without this the server kept the scan while the app
    // showed it as free, so the user's remaining count drifted below the
    // server's and a later scan 403'd with no warning.
    //
    // The rule mirrors the app EXACTLY (confidence < 0.5, or an "Unknown"
    // dish) so the two sides never disagree. Pro/admin hold no reservation,
    // so this is a no-op for them. The /analyze rate limit still bounds how
    // much Gemini work a stream of unidentified images can trigger.
    if (reservation) {
      const unidentified =
        normalized.confidence < 0.5 ||
        normalized.dishes.some((d) => String(d.name || '').toLowerCase() === 'unknown');
      if (unidentified) {
        await releaseScan({ uid: id.uid, identifier: id.identifier, day: ent.scan_day });
        const used = Math.max(0, reservation.used - 1);
        reservation = null;
        scansUsed = used;
        normalized.scans_used = used;
        normalized.scans_remaining = Math.max(0, SCAN_LIMIT_FREE - used);
      }
    }

    res.json(normalized);
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// Keyword scan used to verify /generate-diet-plan output. Kept broad on
// purpose: a false positive costs one retry, a false negative serves meat to
// a vegetarian user.
const NON_VEG_RE = /\b(chicken|mutton|fish|prawn|shrimp|crab|lobster|lamb|beef|pork|bacon|sausage|keema|egg|omlet|omelette|salmon|tuna|meat)\b/i;
const planText = (plan) => [
  ...((plan && plan.meals) || []).map((m) => `${m.name || ''} ${m.description || ''}`),
  ...((plan && plan.tips) || []).map(String),
].join('\n');

app.post('/generate-diet-plan', requireAuth, rateLimit('/generate-diet-plan'), async (req, res) => {
  try {
    const { weight, height, age, gender, goal, activity, diet } = req.body;
    if (!weight || !height || !age) return res.status(400).json({ error: 'Weight, height & age required' });

    // The AI meal plan is a PRO feature, gated exactly like /chat: a plan is a
    // Gemini call we pay for, so a signed-in free user must not be able to
    // generate one. The app already shows free users the subscribe screen
    // instead of the plan builder, but the client is not the authority — this
    // is what makes that paywall real rather than cosmetic.
    //
    // Placed after the input check (matching /chat's order) so a malformed
    // request is still reported as malformed, and before any work is done.
    const ent = await entitlementsFor(identityOf(req));
    if (!ent.subscribed) {
      return res.status(403).json({
        error: 'pro_required',
        message: 'The AI meal plan is a Pro feature. Upgrade to build your plan.',
      });
    }

    const bmr = gender === 'male' ? 10 * weight + 6.25 * height - 5 * age + 5 : 10 * weight + 6.25 * height - 5 * age - 161;
    const multipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, veryActive: 1.9 };
    const tdee = bmr * (multipliers[activity] || 1.2);
    const bmi = weight / ((height / 100) * (height / 100));
    const calTarget = goal === 'loseWeight' ? tdee - 500 : goal === 'gainMuscle' ? tdee + 300 : tdee;
    const proteinTarget = goal === 'gainMuscle' ? weight * 2.2 : goal === 'loseWeight' ? weight * 2.0 : weight * 1.6;
    const fatTarget = calTarget * 0.25 / 9;
    const carbTarget = (calTarget - (proteinTarget * 4) - (fatTarget * 9)) / 4;

    // Diet preference: the app sends DietPreference.name — 'vegetarian' or
    // 'nonVegetarian'. Absent/unknown values fall back to vegetarian: offering
    // meat to someone who never opted in is the worse failure mode.
    const wantsVeg = !String(diet ?? 'vegetarian').toLowerCase().includes('non');
    const dietLine = wantsVeg
      ? 'Diet: STRICTLY VEGETARIAN (lacto-vegetarian). No chicken, mutton, fish, prawns, other seafood, eggs or any animal flesh in ANY meal, snack or tip. Dairy is allowed (paneer, curd, milk, ghee, lassi, chaas). Never suggest swapping in meat or eggs.'
      : 'Diet: NON-VEGETARIAN. Chicken, fish, eggs and other meat are allowed.';

    // The app is used by a global audience — every traditional Indian dish
    // name must carry an inline plain-English gloss so nobody has to guess
    // what "dal tadka" or "khichdi" is.
    const languageLine =
      'Language: use simple English that anyone worldwide understands. ' +
      'When you name a traditional Indian food or dish (for example dal tadka, roti, idli, sabzi, khichdi, rasam, curd, paneer, lassi), immediately follow its name with a short plain-English explanation in parentheses — e.g. "dal tadka (spiced yellow lentil stew)", "roti (whole-wheat flatbread)", "curd (yogurt)". ' +
      'Never leave a regional or Hindi word unexplained, and put the explanation right after the term — not at the end of the sentence.';

    const prompt = `You are an Indian nutritionist. Generate a personalized ONE-DAY Indian diet plan.
User: ${gender}, ${age} yrs, ${weight}kg, ${height}cm, BMI ${bmi.toFixed(1)}.
Goal: ${goal}, Activity: ${activity}.
${dietLine}
${languageLine}
TDEE: ${Math.round(tdee)} kcal, Target: ${Math.round(calTarget)} kcal/day.
Macros: Protein ${proteinTarget.toFixed(0)}g, Carbs ${carbTarget.toFixed(0)}g, Fats ${fatTarget.toFixed(0)}g.

Return ONLY valid JSON (no markdown, no backticks) with this exact structure:
{
  "meals": [
    { "name": "Meal name", "time": "7:00 AM", "description": "detailed food items with Indian portions",
      "calories": number, "protein_g": number, "carbs_g": number, "fats_g": number },
    ... 4-5 meals total (breakfast, snack, lunch, snack, dinner)
  ],
  "water": "recommended water intake",
  "tips": ["tip1", "tip2", "tip3"]
}`;

    const callGemini = async (p) => {
      const resp = await geminiGenerate({ contents: [{ parts: [{ text: p }] }] });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) throw new Error('Empty response from AI');
      const cleaned = text.replace(/```json?/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned.substring(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
    };

    let plan = await callGemini(prompt);

    // An instruction alone is not a guarantee — verify the returned plan and
    // retry once with the offending items called out. If the retry still
    // violates the diet, fail loudly rather than serve meat to a vegetarian.
    if (wantsVeg && NON_VEG_RE.test(planText(plan))) {
      const offender = NON_VEG_RE.exec(planText(plan))[0];
      const retry = await callGemini(
        `${prompt}\n\nYour previous plan was rejected: it contained non-vegetarian items ` +
        `("${offender}"). Regenerate the same one-day plan but strictly ` +
        'vegetarian — no meat, fish, poultry, eggs or seafood in any meal, snack or tip.'
      );
      if (NON_VEG_RE.test(planText(retry))) {
        // Deliberate, user-facing message — sent as SafeError so it survives
        // the sanitizing catch below (diet_plan.test.js pins this wording).
        throw new SafeError('The AI could not produce a vegetarian plan. Please try again.');
      }
      plan = retry;
    }

    res.json({ bmi: bmi.toFixed(1), bmr: Math.round(bmr), tdee: Math.round(tdee), targetCalories: Math.round(calTarget), targetProtein: proteinTarget.toFixed(0), targetCarbs: carbTarget.toFixed(0), targetFats: fatTarget.toFixed(0), plan });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.post('/register', requireAuth, async (req, res) => {
  try {
    // The name is user data the client may choose; the IDENTITY is not — it
    // comes from the verified token (auth.js), never from the request body.
    const { name } = req.body;
    const id = identityOf(req);
    const identifier = id.identifier;
    const email = id.email;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    if (email && name) {
      await dbq(
        'INSERT INTO users (phone, email, name) VALUES ($1, $2, $3) ON CONFLICT (phone) DO UPDATE SET email = $2, name = $3',
        [identifier, email, name]
      );
    } else {
      await dbq('INSERT INTO users (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING', [identifier]);
    }
    const user = await dbq('SELECT * FROM users WHERE phone = $1', [identifier]);
    const row = user.rows[0] || {};
    // Firestore mirror: user doc + identifier index (best-effort). NOTE: the
    // mirror never writes `subscribed` — registration must not touch an
    // existing user's paid state, and on the DB-less deployment the Postgres
    // row is empty so `row.subscribed` would be undefined (which the Admin
    // SDK rejects as an invalid field value).
    {
      const fUid = await firestore.resolveUid(identifier);
      if (fUid) {
        await firestore.set('users/' + fUid, {
          identifier: identifier,
          email: email || null,
          name: name || '',
        }, { merge: true });
        await firestore.set('userIndex/' + identifier, { uid: fUid, name: name || '' }, { merge: true });
      }
    }
    res.json({ phone: row.phone || identifier, subscribed: row.subscribed || false });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// Returns the stored profile name for an identifier (phone or email) so the
// app can restore a previously-chosen nickname after a reinstall / on a new
// device — an existing user must never be re-asked for a nickname.
app.get('/user/profile', requireAuth, async (req, res) => {
  try {
    // Query params are ignored: the profile returned is always the caller's.
    const identifier = identityOf(req).identifier;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    // Firestore first (the DB-less deployment's source of truth): the
    // /register mirror writes userIndex/{identifier}.name so a nickname is
    // never lost after reinstall. Falls back to Postgres when absent.
    let name = null;
    try {
      const fUid = await firestore.resolveUid(identifier);
      if (fUid && firestore.isEnabled()) {
        const idx = await firestore.getDb().collection('userIndex').doc(identifier).get();
        if (idx.exists && typeof idx.data().name === 'string') {
          name = idx.data().name;
        }
      }
    } catch (_) {}
    if (name === null) {
      const user = await dbq('SELECT name FROM users WHERE phone = $1', [identifier]);
      name = (user.rows[0] || {}).name || null;
    }
    res.json({ name });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Referral code helper: Firestore-first (DB-less deployment), then Postgres,
// then generate — so the same code is always returned for the same user and
// the Firestore-only production never regenerates codes on every call.
async function getOrCreateReferralCode(identifier) {
  try {
    const fUid = await firestore.resolveUid(identifier);
    if (fUid && firestore.isEnabled()) {
      const doc = await firestore.getDb().collection('users').doc(fUid).get();
      if (doc.exists && doc.data().referralCode) return doc.data().referralCode;
    }
  } catch (_) {}
  try {
    const existing = await dbq('SELECT referral_code FROM users WHERE phone = $1', [identifier]);
    if (existing.rows[0]?.referral_code) return existing.rows[0].referral_code;
  } catch (_) {}
  let code;
  for (let attempt = 0; attempt < 10; attempt++) {
    code = generateReferralCode();
    const dup = await dbq('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    if (dup.rows.length === 0) break;
  }
  await dbq('UPDATE users SET referral_code = $1 WHERE phone = $2', [code, identifier]);
  try {
    const fUid = await firestore.resolveUid(identifier);
    if (fUid) {
      await firestore.set('users/' + fUid, { referralCode: code }, { merge: true });
      await firestore.set('referrals/' + code, { uid: fUid, identifier, createdAt: new Date() }, { merge: true });
    }
  } catch (_) {}
  return code;
}

app.post('/referral/generate', requireAuth, async (req, res) => {
  try {
    // A referral code belongs to the caller — the body's phone is ignored.
    const identifier = identityOf(req).identifier;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    res.json({ referral_code: await getOrCreateReferralCode(identifier) });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// Phase 2: the identifier is out of the URL. The old path still answers (its
// param is ignored) so already-installed app versions keep working, but the
// code returned is always the token owner's.
app.get('/referral/my-code/:phone', requireAuth, async (req, res) => {
  try {
    const identifier = identityOf(req).identifier;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    res.json({ referral_code: await getOrCreateReferralCode(identifier) });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.get('/me/referral-code', requireAuth, async (req, res) => {
  try {
    const identifier = identityOf(req).identifier;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    res.json({ referral_code: await getOrCreateReferralCode(identifier) });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.post('/referral/apply', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    // The reward is applied to the signed-in account, never to a phone/email
    // the client claims.
    const phone = identityOf(req).identifier;
    if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });
    const upper = code.toUpperCase();
    let referrerPhone = null;
    let referrerUid = null;

    // Postgres lookup first (legacy), then the Firestore referrals index.
    const referrer = await dbq('SELECT phone FROM users WHERE referral_code = $1', [upper]);
    if (referrer.rows[0]?.phone) {
      referrerPhone = referrer.rows[0].phone;
      referrerUid = await firestore.resolveUid(referrerPhone);
    } else if (firestore.isEnabled()) {
      try {
        const refDoc = await firestore.getDb().collection('referrals').doc(upper).get();
        if (refDoc.exists) {
          referrerUid = refDoc.data().uid || null;
        }
      } catch (_) {}
    }
    if (!referrerPhone && !referrerUid) return res.status(404).json({ error: 'Invalid referral code' });
    if (referrerPhone === phone) return res.status(400).json({ error: 'Cannot use your own code' });

    const newUser = await dbq('SELECT referred_by FROM users WHERE phone = $1', [phone]);
    if (newUser.rows[0]?.referred_by) return res.status(400).json({ error: 'Already used a referral code' });
    await dbq('UPDATE users SET referred_by = $1, subscribed = true WHERE phone = $2', [upper, phone]);
    if (referrerPhone) {
      await dbq('UPDATE users SET subscribed = true WHERE phone = $1', [referrerPhone]);
    }

    // Firestore mirror: grant both users Pro + mark referredBy (best-effort,
    // and the only path when Postgres is absent).
    {
      const fUid = await firestore.resolveUid(phone);
      if (fUid) {
        await firestore.set('users/' + fUid, { subscribed: true, referredBy: upper }, { merge: true });
      }
      if (referrerUid) {
        await firestore.set('users/' + referrerUid, { subscribed: true }, { merge: true });
      }
    }
    res.json({ subscribed: true, referrer: referrerPhone || 'referred' });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.get('/meals/:phone', requireAuth, async (req, res) => {
  try {
    // Legacy route: the path identifier is ignored, so a valid token can only
    // ever read its OWN meals.
    const phone = identityOf(req).identifier;
    const result = await dbq('SELECT * FROM meals WHERE phone = $1 ORDER BY date DESC', [phone]);
    res.json(result.rows);
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// ─── Meal restore/remove aliases the app actually calls ─────────────────
// The app's MealSyncService always used GET /meals/list/:phone and
// POST /meals/remove, which never existed on the server (restore and delete
// were silently 404ing). These mirror the Postgres + Firestore behaviour.
app.get('/meals/list/:phone', requireAuth, async (req, res) => {
  try {
    // Legacy route — identity comes from the token, not the path.
    const phone = identityOf(req).identifier;
    const result = await dbq('SELECT * FROM meals WHERE phone = $1 ORDER BY date DESC', [phone]);
    res.json(result.rows);
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.post('/meals/remove', requireAuth, async (req, res) => {
  try {
    const { meal_id } = req.body;
    const phone = identityOf(req).identifier;
    if (!phone || !meal_id) return res.status(400).json({ error: 'Phone and meal_id required' });
    await dbq('DELETE FROM meals WHERE id = $1 AND phone = $2', [meal_id, phone]);
    // Firestore mirror (best-effort)
    const fUid = await firestore.resolveUid(phone);
    if (fUid) {
      await firestore.del('meals/' + meal_id);
    }
    res.json({ removed: true });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.post('/meals/sync', requireAuth, async (req, res) => {
  try {
    const { meals, meal } = req.body;
    const phone = identityOf(req).identifier;
    // The app's single-meal sync posts { phone, meal }; the bulk path posts
    // { phone, meals: [...] }. Accept both so Firestore mirrors real traffic.
    const mealList = Array.isArray(meals) ? meals : (meal ? [meal] : null);
    if (!phone || !mealList) return res.status(400).json({ error: 'Phone and meals required' });
    if (dbAvailable) {
      const client = await pool.connect();
      try {
        await client.query('DELETE FROM meals WHERE phone = $1', [phone]);
        for (const meal of mealList) {
          await client.query(
            `INSERT INTO meals (id, phone, date, name, category, calories, protein, carbs, fats, fiber, serving)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
            [meal.id, phone, meal.date, meal.name, meal.category, meal.calories, meal.protein, meal.carbs, meal.fats, meal.fiber, meal.serving]
          );
        }
      } finally {
        client.release();
      }
    }

    // Firestore mirror: replace the user's meal docs to match Postgres
    // (best-effort — Postgres stays the source of truth in Phase 1).
    {
      const fUid = await firestore.resolveUid(phone);
      if (fUid) {
        try {
          const col = firestore.getDb().collection('meals');
          const snap = await col.where('uid', '==', fUid).get();
          const batch = firestore.getDb().batch();
          snap.docs.forEach((d) => batch.delete(d.ref));
          for (const m of mealList) {
            batch.set(col.doc(m.id), {
              uid: fUid,
              date: m.date ? new Date(m.date) : new Date(),
              name: m.name || '',
              category: m.category || '',
              calories: m.calories || 0,
              protein: m.protein || 0,
              carbs: m.carbs || 0,
              fats: m.fats || 0,
              fiber: m.fiber || 0,
              serving: m.serving || '',
              createdAt: new Date(),
            });
          }
          await batch.commit();
        } catch (e) {
          console.error('Firestore meals mirror failed:', e.message);
        }
      }
    }
    res.json({ synced: true });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// ─── Habits & Water Log backup ────────────────────────────────────────
// Stores the user's full habit list + water log as JSON so the app can
// restore them after a reinstall. The Flutter app's MealSyncService hits
// /habits/sync and /habits/list/:phone — these were MISSING, which is why
// synced habits never came back after reinstalling the app.
app.post('/habits/sync', requireAuth, async (req, res) => {
  try {
    const { habits, water_log, water_goal } = req.body;
    const phone = identityOf(req).identifier;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    if (!Array.isArray(habits)) return res.status(400).json({ error: 'habits must be an array' });
    await dbq(
      `INSERT INTO habit_data (phone, habits, water_log, water_goal, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         habits = EXCLUDED.habits,
         water_log = EXCLUDED.water_log,
         water_goal = EXCLUDED.water_goal,
         updated_at = NOW()`,
      [phone, JSON.stringify(habits), JSON.stringify(water_log || {}), water_goal || 8]
    );

    // Firestore mirror: upsert the user's habitData doc (matches the
    // Postgres ON CONFLICT upsert; best-effort).
    {
      const fUid = await firestore.resolveUid(phone);
      if (fUid) {
        await firestore.set('habitData/' + fUid, {
          habits: habits,
          waterLog: water_log || {},
          waterGoal: water_goal || 8,
          updatedAt: new Date(),
        });
      }
    }
    res.json({ synced: true });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.get('/habits/list/:phone', requireAuth, async (req, res) => {
  try {
    // Legacy route — identity comes from the token, not the path.
    const phone = identityOf(req).identifier;
    const result = await dbq(
      'SELECT habits, water_log, water_goal FROM habit_data WHERE phone = $1',
      [phone]
    );
    const row = result.rows[0];
    if (!row) {
      return res.json({ habits: [], water_log: {}, water_goal: 8 });
    }
    res.json({
      habits: row.habits || [],
      water_log: row.water_log || {},
      water_goal: row.water_goal || 8,
    });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// Legacy admin/test hook: only ever flips the CALLER's own subscription.
app.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const phone = identityOf(req).identifier;
    if (!phone) return res.status(400).json({ error: 'Identity required' });
    await dbq('INSERT INTO users (phone, subscribed) VALUES ($1, true) ON CONFLICT (phone) DO UPDATE SET subscribed = true', [phone]);
    // Firestore mirror (best-effort).
    {
      const fUid = await firestore.resolveUid(phone);
      if (fUid) await firestore.set('users/' + fUid, { subscribed: true }, { merge: true });
    }
    res.json({ subscribed: true });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.post('/unsubscribe', requireAuth, async (req, res) => {
  try {
    const phone = identityOf(req).identifier;
    if (!phone) return res.status(400).json({ error: 'Identity required' });
    await dbq('UPDATE users SET subscribed = false WHERE phone = $1', [phone]);
    // Firestore mirror (best-effort).
    {
      const fUid = await firestore.resolveUid(phone);
      if (fUid) await firestore.set('users/' + fUid, { subscribed: false }, { merge: true });
    }
    res.json({ subscribed: false });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// ─── Razorpay: Create Recurring Subscription ───────────────────────────────
// Real ₹29/month recurring billing: creates a Razorpay Subscription (auto-
// charges every month) instead of a one-time order. The app opens checkout
// with the returned subscription_id; Razorpay then charges the customer
// automatically each billing cycle and fires webhooks we verify below.
// Turn a user-supplied identifier into a Razorpay contact (+<country><10
// digits>) when it actually looks like a mobile number. Email logins are
// common here, so anything that isn't a plain number returns undefined — the
// hosted page then asks only for the mobile (required for UPI) and prefills
// the email from the attached customer.
function normalizeContact(phone) {
  if (!phone || typeof phone !== 'string') return undefined;
  const digits = phone.replace(/\D/g, '');
  if (/^\d{10}$/.test(digits)) return '+91' + digits;
  if (/^91\d{10}$/.test(digits)) return '+91' + digits.slice(-10);
  if (/^\+\d{7,15}$/.test(phone)) return phone;
  return undefined;
}

app.post('/payment/create-subscription', requireAuth, async (req, res) => {
  try {
    // The subscription is created for the TOKEN's user: a client-sent phone
    // would otherwise let anyone attach a payment to someone else's account.
    const id = identityOf(req);
    const phone = id.identifier;
    const name = typeof req.body.name === 'string' ? req.body.name : '';
    const email = id.email;
    if (!phone) return res.status(400).json({ error: 'Identity required' });
    if (!process.env.RAZORPAY_KEY_ID) {
      return res.status(500).json({ error: 'Razorpay not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env' });
    }

    const planId = await getPlanId();

    // Attach a Razorpay customer so the hosted payment page prefills the
    // user's email (and mobile when we have one) instead of asking for them
    // — the user already logged in with their email, so it should never be
    // re-typed. Best-effort: a customer failure never blocks the payment;
    // without a customer the page simply asks for the details as before.
    let customerId;
    try {
      const customerPayload = {
        name: (name && name.trim()) || 'MacroSnap User',
        fail_existing: 0, // reuse the existing customer for repeat subscribers
      };
      if (email && email.trim()) customerPayload.email = email.trim();
      const contact = normalizeContact(phone);
      if (contact) customerPayload.contact = contact;
      if (customerPayload.email || customerPayload.contact) {
        const customer = await razorpay.customers.create(customerPayload);
        customerId = customer.id;
      }
    } catch (e) {
      console.error('Customer prefill failed (continuing without it):', e.message);
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 12, // 12 monthly auto-renewing charges
      customer_notify: 1,
      ...(customerId ? { customer_id: customerId } : {}),
      // NOTE: do NOT pass an inline `customer` block here — Razorpay's
      // Subscriptions API rejects it ("customer is/are not required and
      // should not be sent"). Attach a pre-created customer via `customer_id`
      // instead (verified live) so the hosted page prefills the user's
      // email/contact. The phone travels in `notes` so webhooks can still
      // map the subscription back to the user.
      notes: { phone },
    });

    // Track the subscription → user mapping so webhooks can find the user.
    // Write BOTH Postgres (legacy) and Firestore — the Firestore-only
    // deployment has no Postgres, and the webhook falls back to Firestore.
    await dbq(
      `INSERT INTO subscriptions (id, phone, status) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone, status = EXCLUDED.status`,
      [subscription.id, phone, subscription.status || 'created']
    );
    try {
      const fUid = await firestore.resolveUid(phone);
      await firestore.set(
        'subscriptions/' + subscription.id,
        {
          uid: fUid || null,
          phone: phone,
          status: subscription.status || 'created',
          updatedAt: new Date(),
        },
        { merge: true }
      );
    } catch (_) {}

    res.json({
      subscription_id: subscription.id,
      amount: 2900,
      currency: 'INR',
      razorpay_key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// ─── Razorpay: Verify Payment (order or subscription) ──────────────────────
// Supports both the legacy one-time order flow and the new recurring
// subscription flow. Signature format differs:
//   order:        HMAC(order_id|payment_id)
//   subscription: HMAC(subscription_id|payment_id)
app.post('/payment/verify', requireAuth, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;
    if (!razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify signature using HMAC SHA256
    const signingId = razorpay_subscription_id || razorpay_order_id;
    if (!signingId) {
      return res.status(400).json({ error: 'Missing order or subscription id' });
    }
    // NOTE: the signature field order DIFFERS between flows (Razorpay docs +
    // official SDKs):
    //   orders:        HMAC(order_id|payment_id)
    //   subscriptions: HMAC(payment_id|subscription_id)
    // Getting this backwards makes valid payments fail verification.
    const body = razorpay_subscription_id
      ? `${razorpay_payment_id}|${signingId}`
      : `${signingId}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Fetch the payment to get the phone from order notes
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    const phone = payment.notes?.phone;
    if (!phone) {
      console.error('Could not determine phone from payment notes', { payment_id: razorpay_payment_id });
      return res.status(400).json({ error: 'Could not identify user for this payment' });
    }

    // The subscription was created for a specific account; only that account
    // may verify it. (notes.phone comes from Razorpay, written by
    // create-subscription from the verified token — not from this request.)
    const id = identityOf(req);
    if (id.identifier && phone !== id.identifier) {
      return res.status(403).json({ error: 'Payment does not belong to this account' });
    }

    // Store payment in database
    try {
      await dbq(
        `INSERT INTO payments (phone, transaction_ref, amount, status)
         VALUES ($1, $2, $3, 'approved')`,
        [phone, razorpay_payment_id, (payment.amount || 2900) / 100]
      );
    } catch (e) {
      console.error('Payment insert failed:', e.message);
    }

    // Activate subscription
    await dbq(
      'INSERT INTO users (phone, subscribed) VALUES ($1, true) ON CONFLICT (phone) DO UPDATE SET subscribed = true',
      [phone]
    );

    // Save the active subscription id on the user row
    if (razorpay_subscription_id) {
      try {
        await dbq(
          'UPDATE users SET subscription_id = $1 WHERE phone = $2',
          [razorpay_subscription_id, phone]
        );
      } catch (e) {
        console.error('subscription_id save failed:', e.message);
      }
    }

    // Firestore mirror: activation + subscription + payment records
    // (best-effort — Postgres stays authoritative in Phase 1).
    {
      const fUid = await firestore.resolveUid(phone);
      if (fUid) {
        await firestore.set('users/' + fUid, { subscribed: true, subscriptionId: razorpay_subscription_id || null }, { merge: true });
        if (razorpay_subscription_id) {
          await firestore.set('subscriptions/' + razorpay_subscription_id, {
            uid: fUid,
            identifier: phone,
            status: 'active',
            createdAt: new Date(),
          }, { merge: true });
        }
        await firestore.set('payments/' + razorpay_payment_id, {
          uid: fUid,
          identifier: phone,
          transactionRef: razorpay_payment_id,
          amount: (payment.amount || 2900) / 100,
          status: 'approved',
          createdAt: new Date(),
        }, { merge: true });
      }
    }
    res.json({ success: true, subscribed: true });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// ─── Razorpay: Webhook (recurring billing lifecycle) ───────────────────────
// Razorpay calls this on every subscription event: initial charge, monthly
// auto-charges, pauses, cancellations, failures. We verify the HMAC signature
// against the raw body, then update the user's Pro status accordingly so
// access stays in sync even when the app never re-opens.
//
// Events handled:
//   subscription.activated / payment.captured / subscription.charged → Pro ON
//   subscription.completed (all 12 charges paid)                      → Pro ON
//   subscription.cancelled / subscription.paused / subscription.halted→ Pro OFF
app.post('/payment/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) return res.status(400).json({ error: 'Missing signature' });
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error('Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not set — add it to Railway env and register this URL in the Razorpay dashboard.');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    const rawBody = (req.rawBody || Buffer.from(JSON.stringify(req.body))).toString();
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest();
    const received = Buffer.from(signature, 'hex');
    // Timing-safe comparison (constant length guard first so mismatched
    // lengths can't throw in timingSafeEqual).
    if (received.length !== expected.length ||
        !crypto.timingSafeEqual(received, expected)) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const event = req.body;
    const sub = event?.payload?.subscription?.entity;
    const payment = event?.payload?.payment?.entity;
    const subscriptionId = sub?.id || payment?.subscription_id;
    // Every processed event is recorded in webhookLog/{id} — a payment that
    // never activates (or an event we can't map to a user) is visible within
    // minutes instead of silently returning { received: true }.
    const logEventId =
      event?.id || ('evt_' + (event?.created_at || Date.now()) + '_' + (subscriptionId || 'none'));
    if (!subscriptionId) {
      try {
        await firestore.set('webhookLog/' + logEventId, {
          event: event?.event || '',
          outcome: 'no_subscription',
          receivedAt: new Date(),
        }, { merge: true });
      } catch (_) {}
      return res.json({ received: true });
    }

    // Find the phone for this subscription. Try, in order: Postgres (legacy),
    // payment notes, the subscription entity's own notes, and finally the
    // Firestore subscriptions/{id} mapping written by create-subscription.
    // The Firestore-only deployment has no Postgres rows, so the Firestore
    // mapping (or the subscription's notes) is what actually resolves the
    // user — without it the webhook would silently do nothing.
    let phone = null;
    try {
      const row = await dbq('SELECT phone FROM subscriptions WHERE id = $1', [subscriptionId]);
      phone = row.rows[0]?.phone || null;
    } catch (_) {}
    if (!phone && payment?.notes?.phone) phone = payment.notes.phone;
    if (!phone && sub?.notes?.phone) phone = sub.notes.phone;
    if (!phone) {
      try {
        const subDoc = await firestore
          .getDb()
          .collection('subscriptions')
          .doc(subscriptionId)
          .get();
        if (subDoc.exists) phone = (subDoc.data() || {}).phone || null;
      } catch (_) {}
    }
    const eventType = event?.event || '';
    // Activate on first charge + each monthly auto-charge. NOTE: Razorpay
    // subscriptions have a max of 12 charges, then subscription.completed
    // fires — we treat that as the term ending (Pro off, user re-subscribes)
    // rather than giving free Pro forever after month 12.
    const turnOn =
      eventType.includes('activated') ||
      eventType.includes('captured') ||
      eventType === 'subscription.charged';
    const turnOff =
      eventType === 'subscription.completed' ||
      eventType.includes('cancelled') ||
      eventType.includes('paused') ||
      eventType.includes('halted') ||
      eventType.includes('failed');

    let outcome;
    if (!phone) {
      outcome = 'unresolved';
    } else if (turnOn) {
      await dbq(
        'INSERT INTO users (phone, subscribed) VALUES ($1, true) ON CONFLICT (phone) DO UPDATE SET subscribed = true, subscription_id = $2',
        [phone, subscriptionId]
      );
      try {
        await dbq('UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE id = $2', [sub?.status || 'active', subscriptionId]);
      } catch (_) {}
      // Firestore mirror: activate user + subscription doc (best-effort).
      {
        const fUid = await firestore.resolveUid(phone);
        if (fUid) {
          await firestore.set('users/' + fUid, { subscribed: true, subscriptionId: subscriptionId || null }, { merge: true });
        }
        if (subscriptionId) {
          await firestore.set('subscriptions/' + subscriptionId, { uid: fUid || null, identifier: phone, status: sub?.status || 'active', updatedAt: new Date() }, { merge: true });
        }
      }
      outcome = 'activated';
    } else if (turnOff) {
      await dbq('UPDATE users SET subscribed = false WHERE phone = $1', [phone]);
      try {
        await dbq('UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE id = $2', [sub?.status || 'cancelled', subscriptionId]);
      } catch (_) {}
      // Firestore mirror: deactivate user + subscription doc (best-effort).
      {
        const fUid = await firestore.resolveUid(phone);
        if (fUid) {
          await firestore.set('users/' + fUid, { subscribed: false }, { merge: true });
        }
        if (subscriptionId) {
          await firestore.set('subscriptions/' + subscriptionId, { status: sub?.status || 'cancelled', updatedAt: new Date() }, { merge: true });
        }
      }
      outcome = 'deactivated';
    } else {
      // Known event but no state change required (e.g. subscription.created).
      outcome = 'ignored';
    }

    try {
      const fUid = phone ? await firestore.resolveUid(phone) : null;
      await firestore.set('webhookLog/' + logEventId, {
        event: eventType,
        subscriptionId,
        phone: phone || null,
        uid: fUid || null,
        outcome,
        status: sub?.status || null,
        receivedAt: new Date(),
      }, { merge: true });
    } catch (_) {}

    res.json({ received: true });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});



async function paymentStatusHandler(req, res) {
  try {
    // Identity from the token — the URL no longer carries an identifier.
    const phone = identityOf(req).identifier;
    // Firestore first (DB-less deployment's source of truth), Postgres
    // fallback — same pattern as /subscription/status.
    let subscribed = false;
    let payment = null;
    try {
      const fUid = await firestore.resolveUid(phone);
      if (fUid && firestore.isEnabled()) {
        const doc = await firestore.getDb().collection('users').doc(fUid).get();
        if (doc.exists) subscribed = doc.data().subscribed === true;
        const snap = await firestore
          .getDb()
          .collection('payments')
          .where('identifier', '==', phone)
          .get();
        let newest = null;
        (snap.docs || []).forEach((d) => {
          const data = d.data();
          const t = data.createdAt ? new Date(data.createdAt).getTime() : 0;
          if (!newest || t > newest._t) newest = { ...data, _t: t };
        });
        if (newest) {
          payment = {
            transactionRef: newest.transactionRef || null,
            amount: newest.amount || null,
            status: newest.status || null,
            createdAt: newest.createdAt ? new Date(newest.createdAt).toISOString() : null,
          };
        }
      }
    } catch (_) {}
    if (!subscribed && !payment) {
      const user = await dbq('SELECT subscribed FROM users WHERE phone = $1', [phone]);
      const payments = await dbq(
        'SELECT * FROM payments WHERE phone = $1 ORDER BY created_at DESC LIMIT 1',
        [phone]
      );
      subscribed = user.rows[0]?.subscribed || false;
      payment = payments.rows[0] || null;
    }
    res.json({ subscribed, payment });
  } catch (e) {
    return sendFailure(req, res, e);
  }
}

// Phase 2: the user's own payment status, identified by the token alone. The
// legacy path still answers (its param is ignored) for installed versions.
app.get('/me/payment/status', requireAuth, paymentStatusHandler);
app.get('/payment/status/:phone', requireAuth, paymentStatusHandler);

// Everything the app needs to show the free-scan allowance: the server is
// the authority, the app's local counter is only a display estimate.
// `scans_limit`/`scans_remaining` are null for Pro/admin (no limit), and
// `reset_at` is the next IST midnight (the daily reset) as a UTC ISO string.
app.get('/me/entitlements', requireAuth, async (req, res) => {
  try {
    const id = identityOf(req);
    if (!id.identifier && !id.uid) return res.status(400).json({ error: 'Identity required' });
    res.json(await entitlementsFor(id));
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// --- Subscription verification (Firestore first, Postgres fallback) ------
// Grants or reports the one-time 30-day free plan. Called by the app at
// startup and after login — that is also what hands existing users their
// trial after an app update.
app.get('/trial/status', requireAuth, async (req, res) => {
  try {
    // Query params are ignored — the trial reported is always the caller's.
    const id = identityOf(req);
    const identifier = id.identifier;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    if (isAdminUser(identifier, id.emailVerified)) return res.json({ admin: true, active: false, daysLeft: 0 });
    const startedAt = await getOrGrantTrial(identifier);
    if (!startedAt) return res.json({ active: false, expired: false, daysLeft: 0 });
    res.json(trialState(startedAt));
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// In-app self-service account deletion.
//
// Wipes ALL of the user's data (Postgres + Firestore) but keeps a tombstone
// that remembers the identifier (phone/email) AND the original trial start.
// That tombstone is what prevents a delete -> re-login -> fresh free-trial
// loop: getOrGrantTrial() checks it first and never re-grants. The user can
// sign up again with the same phone/email, but they will NOT get another
// free trial.
app.post('/account/delete', requireAuth, async (req, res) => {
  try {
    // You can only delete the account you are signed in as.
    const id = identityOf(req);
    const phone = id.phone || id.identifier;
    const email = id.email;
    const identifier = phone || email;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    if (isAdminUser(identifier, id.emailVerified)) return res.status(403).json({ error: 'Admin account cannot be deleted' });

    // 1) Capture the original trial start BEFORE wiping anything.
    let trialStartedAt = null;
    const fUid = await firestore.resolveUid(identifier);
    if (fUid && firestore.isEnabled()) {
      try {
        const doc = await firestore.getDb().collection('users').doc(fUid).get();
        trialStartedAt = doc.exists ? (doc.data().trial_started_at || null) : null;
      } catch (_) {}
    }
    if (!trialStartedAt && dbAvailable) {
      try {
        const r = await dbq('SELECT trial_started_at FROM users WHERE phone = $1 OR email = $1 LIMIT 1', [identifier]);
        trialStartedAt = (r.rows[0] && r.rows[0].trial_started_at) || null;
      } catch (_) {}
    }

    // 2) Write the tombstone — remember the mail/phone so the free trial can
    //    never be claimed again by this identity. This is NEVER deleted.
    if (firestore.isEnabled()) {
      await firestore.set('deletedAccounts/' + String(identifier).toLowerCase(), {
        identifier,
        phone: phone || null,
        email: email || null,
        trial_started_at: trialStartedAt,
        deleted_at: new Date().toISOString(),
      });
    }
    if (dbAvailable) {
      try {
        await dbq(
          `INSERT INTO deleted_accounts (identifier, phone, email, trial_started_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (identifier) DO UPDATE SET
             phone = COALESCE(EXCLUDED.phone, deleted_accounts.phone),
             email = COALESCE(EXCLUDED.email, deleted_accounts.email),
             trial_started_at = COALESCE(deleted_accounts.trial_started_at, EXCLUDED.trial_started_at),
             deleted_at = NOW()`,
          [identifier, phone || null, email || null, trialStartedAt]
        );
      } catch (_) {}
    }

    // 3) Wipe personal data — Postgres.
    if (dbAvailable) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM meals WHERE phone = $1', [identifier]);
        await client.query('DELETE FROM habit_data WHERE phone = $1', [identifier]);
        await client.query('DELETE FROM subscriptions WHERE phone = $1', [identifier]);
        await client.query('DELETE FROM payments WHERE phone = $1', [identifier]);
        await client.query('DELETE FROM users WHERE phone = $1 OR email = $1', [identifier]);
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        client.release();
      }
    }

    // 4) Wipe personal data — Firestore (best-effort). users/{uid} goes too:
    //    its trial marker now lives on in the tombstone.
    if (fUid && firestore.isEnabled()) {
      const db = firestore.getDb();
      for (const col of ['habitData', 'dietProfiles', 'recentFoods', 'userPreferences', 'recipes']) {
        await firestore.del(col + '/' + fUid);
      }
      // meals where uid matches (docs keyed by meal id)
      try {
        const snap = await db.collection('meals').where('uid', '==', fUid).get();
        const batch = db.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        if (snap.docs.length > 0) await batch.commit();
      } catch (_) {}
      // money records keyed by uid
      for (const col of ['subscriptions', 'payments']) {
        try {
          const snap = await db.collection(col).where('uid', '==', fUid).get();
          const batch = db.batch();
          snap.docs.forEach((d) => batch.delete(d.ref));
          if (snap.docs.length > 0) await batch.commit();
        } catch (_) {}
      }
      // identifier -> uid index + the profile doc itself
      await firestore.del('userIndex/' + identifier);
      await firestore.del('users/' + fUid);
    }

    res.json({ ok: true, trialPreserved: !!trialStartedAt });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// In-app nutrition chatbot. Answers ONLY food/nutrition/protein questions —
// the system instruction makes Gemini refuse everything else, which the
// backend tests lock in.
const CHAT_SYSTEM_PROMPT =
  'You are Guru, MacroSnap\u2019s in-app nutrition assistant inside a calorie-tracking app. ' +
  'Answer ONLY questions about food, nutrition and protein: calories, macros (protein, carbs, fat), ' +
  'vitamins, minerals, hydration, ingredients, recipes, Indian and global dishes, veg and non-veg meal ideas, ' +
  'meal planning, portion sizes, and food-related fitness nutrition. ' +
  'When the user asks about their OWN day (intake so far, remaining calories or protein, whether their targets are met, their habits or water), answer from the USER DATA SNAPSHOT appended below when one is provided, using only the numbers it contains. ' +
  'If (and only if) the question is NOT about food, nutrition or protein, reply exactly once with: ' +
  '\u201CI can only help with food, nutrition and protein questions \u2014 ask me anything about what to eat!\u201D ' +
  'and suggest one example of a food question. Never answer unrelated topics (code, news, politics, personal advice, medical diagnoses). ' +
  'Keep answers under 120 words, friendly and practical. When you name a traditional Indian dish, add a short English explanation in parentheses.';

// Renders the app-supplied snapshot of the user's OWN day (meals, macro
// totals, targets, habits, water) into a compact block appended to Guru's
// system instruction. It is untrusted client input: strings are collapsed to
// a single line and clipped, numbers are coerced and clamped, lists are
// capped — so a buggy or hostile client can neither smuggle in fresh
// instructions (a value containing newlines would otherwise read as new
// prompt lines) nor inflate the prompt.
const GURU_LIMITS = { label: 40, meal: 60, habit: 40, meals: 12, habits: 8 };

function guruStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, max);
}

function guruNum(v, min, max) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

function guruNum1(v, min, max) {
  const n = guruNum(v, min, max);
  return n == null ? null : Math.round(n * 10) / 10;
}

function guruMacroLine(prefix, src) {
  if (!src || typeof src !== 'object') return null;
  const c = guruNum(src.calories, 0, 100000);
  const p = guruNum1(src.protein_g, 0, 5000);
  const cb = guruNum1(src.carbs_g, 0, 5000);
  const f = guruNum1(src.fats_g, 0, 5000);
  const bits = [];
  if (c != null) bits.push(`${Math.round(c)} kcal`);
  if (p != null) bits.push(`${p}g protein`);
  if (cb != null) bits.push(`${cb}g carbs`);
  if (f != null) bits.push(`${f}g fat`);
  return bits.length ? `${prefix}: ${bits.join(', ')}` : null;
}

function guruContextBlock(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const lines = [];

  const name = guruStr(raw.name, GURU_LIMITS.label);
  if (name) lines.push(`Name: ${name}`);

  const profileBits = [];
  const goal = guruStr(raw.goal, GURU_LIMITS.label);
  const diet = guruStr(raw.diet, GURU_LIMITS.label);
  if (goal) profileBits.push(`goal ${goal}`);
  if (diet) profileBits.push(`diet ${diet}`);
  if (profileBits.length) lines.push(`Profile: ${profileBits.join(', ')}`);

  const targets = guruMacroLine('Daily targets', raw.targets);
  if (targets) lines.push(targets);

  const eaten = guruMacroLine('Eaten today', raw.today);
  if (eaten) lines.push(eaten);

  const today = raw.today && typeof raw.today === 'object' ? raw.today : null;
  const meals = today && Array.isArray(today.meals)
    ? today.meals.slice(0, GURU_LIMITS.meals)
    : [];
  const mealBits = [];
  for (const m of meals) {
    if (!m || typeof m !== 'object') continue;
    const mn = guruStr(m.name, GURU_LIMITS.meal);
    if (!mn) continue;
    const mc = guruNum(m.calories, 0, 20000);
    const mp = guruNum1(m.protein_g, 0, 1000);
    const extras = [];
    if (mc != null) extras.push(`${Math.round(mc)} kcal`);
    if (mp != null) extras.push(`${mp}g protein`);
    mealBits.push(extras.length ? `${mn} (${extras.join(', ')})` : mn);
  }
  if (mealBits.length) lines.push(`Meals logged today: ${mealBits.join('; ')}`);

  const habits = raw.habits && typeof raw.habits === 'object' ? raw.habits : null;
  if (habits) {
    const due = guruNum(habits.due, 0, 500);
    const done = guruNum(habits.completed, 0, 500);
    const names = (Array.isArray(habits.names) ? habits.names : [])
      .slice(0, GURU_LIMITS.habits)
      .map((h) => guruStr(h, GURU_LIMITS.habit))
      .filter(Boolean);
    const bits = [];
    if (done != null && due != null) bits.push(`${done} of ${due} due habits done`);
    if (names.length) bits.push(`habits: ${names.join(', ')}`);
    if (bits.length) lines.push(`Habits: ${bits.join(' — ')}`);
  }

  const water = raw.water && typeof raw.water === 'object' ? raw.water : null;
  if (water) {
    const drunk = guruNum(water.glasses, 0, 100);
    const goalGlasses = guruNum(water.goal, 0, 100);
    if (drunk != null && goalGlasses != null) {
      lines.push(`Water today: ${Math.round(drunk)} of ${Math.round(goalGlasses)} glasses`);
    }
  }

  if (!lines.length) return '';
  return '\n\nUSER DATA SNAPSHOT (app-provided, for this signed-in user only; use it to answer their own intake, target, habit and water questions and never invent values that are not in it):\n' +
    lines.map((l) => `- ${l}`).join('\n') +
    '\nUse the snapshot ONLY for this user\u2019s own food, nutrition, habit and water questions. If it does not cover what they asked, say you cannot see that yet and suggest they log it. All other restrictions still apply.';
}

app.post('/chat', requireAuth, rateLimit('/chat'), async (req, res) => {
  try {
    const { message, history, context } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message required' });
    }

    // Guru is a PRO feature. Every chat turn is billed to us through Gemini,
    // so it is gated on the same entitlements the scans use (paid OR the
    // one-time 30-day free plan OR the owner account). The app mirrors this
    // by only opening the assistant for Pro users, but the check lives here
    // because the client is not the authority.
    const ent = await entitlementsFor(identityOf(req));
    if (!ent.subscribed) {
      return res.status(403).json({
        error: 'pro_required',
        message: 'Guru is a Pro feature. Upgrade to keep chatting.',
      });
    }

    const userMsg = message.trim().slice(0, 2000);
    const turns = (Array.isArray(history) ? history : [])
      .slice(-10)
      .filter((t) => t && (t.role === 'user' || t.role === 'model') && typeof t.text === 'string')
      .map((t) => ({ role: t.role, parts: [{ text: String(t.text).slice(0, 500) }] }));
    turns.push({ role: 'user', parts: [{ text: userMsg }] });

    const resp = await geminiGenerate({
      systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT + guruContextBlock(context) }] },
      contents: turns,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Empty response from AI');
    res.json({ reply: text.slice(0, 2000) });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.get('/subscription/status', requireAuth, async (req, res) => {
  try {
    // Identity from the token; query params are ignored.
    const id = identityOf(req);
    const phone = id.phone || id.identifier;
    const email = id.email;
    if (!phone && !email) return res.status(400).json({ error: 'Identity required' });
    const identifier = phone || email;

    // The owner is always subscribed.
    if (isAdminUser(identifier, id.emailVerified)) return res.json({ subscribed: true });

    // Firestore is the source of truth (Phase 3) — check users/{uid} first.
    const fUid = await firestore.resolveUid(identifier);
    if (fUid && firestore.isEnabled()) {
      try {
        const doc = await firestore.getDb().collection('users').doc(fUid).get();
        if (doc.exists && doc.data().subscribed === true) {
          return res.json({ subscribed: true });
        }
        // An active 30-day free trial counts as Pro until it expires.
        if (doc.exists) {
          const ts = trialState(doc.data().trial_started_at);
          if (ts.active) return res.json({ subscribed: true, trial_days_left: ts.daysLeft, trial_ends_at: ts.endsAt });
        }
      } catch (_) {}
    }

    // Postgres fallback (legacy / when Firestore has no user doc).
    let user = null;
    if (phone) {
      const r = await dbq('SELECT subscribed FROM users WHERE phone = $1 LIMIT 1', [phone]);
      user = r.rows[0] || null;
    }
    if (!user && email) {
      const r = await dbq('SELECT subscribed FROM users WHERE email = $1 LIMIT 1', [email]);
      user = r.rows[0] || null;
    }
    if (user?.subscribed) return res.json({ subscribed: true });
    const ts = await pgTrial(identifier);
    if (ts.active) return res.json({ subscribed: true, trial_days_left: ts.daysLeft, trial_ends_at: ts.endsAt });
    res.json({ subscribed: false });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// Vercel (serverless) imports this module as the request handler; local /
// Railway runs call listen() directly.
if (require.main === module) {
  const port = process.env.PORT || 3000;
  // Say which model is actually in use. A wrong or unavailable Gemini model
  // shows up as a generic 500 on /analyze and /chat, so naming it here turns a
  // opaque failure into an obvious one at the first log line of a boot.
  console.log(
    `Gemini model in use: ${GEMINI_API_VERSION}/models/${GEMINI_MODEL} ` +
      '(override with GEMINI_MODEL / GEMINI_API_VERSION)'
  );
  app.listen(port, () => console.log(`MacroSnap server on port ${port}`));
}

module.exports = app;
// Exposed so the test harness can reset the per-user rate-limit counters
// between tests (they live in module scope and would otherwise carry over).
module.exports._resetRateLimits = resetRateLimits;
module.exports._rateLimits = RATE_WINDOWS;
