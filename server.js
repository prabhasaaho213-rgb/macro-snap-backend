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
// A 100 KB (Express's default) body cap is too small for /meals/sync, which
// posts the user's whole history on a first login: ~200 bytes per meal means a
// few hundred meals is already past it, and the client would get a 413 that
// looks like a server fault. 1 MB is far above any legitimate batch and still
// bounds the parse. (Images never come through here — they are multipart.)
app.use(
  express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── CORS: allowlist, not `*` ──────────────────────────────────────────
// The Flutter app is not a browser and sends no Origin header, so it needs no
// CORS at all. Only the web build (and the marketing/docs pages) do, and
// `Access-Control-Allow-Origin: *` on an API that authenticates with a Bearer
// token lets ANY site a user visits call it with that user's token.
//
// CORS_ORIGINS is a comma-separated allowlist. When it is unset nothing is
// echoed, which is correct for the app and fails closed for the web.
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    // Any response can differ per Origin, so caches must key on it.
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    res.header('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Postgres is now OPTIONAL. When DATABASE_URL is unset (e.g. Vercel free
// tier) the server runs fully on Firestore: every Postgres call degrades
// gracefully through the safe dbq() helper below and scan limits /
// subscription state are read from Firestore instead.
const dbAvailable = !!process.env.DATABASE_URL;
// TLS to Postgres is VERIFIED by default. `rejectUnauthorized: false` accepted
// any certificate, so anyone able to answer on the database host could present
// their own and read every query (IDs, payment rows, subscription state) in
// clear. Managed providers ship a trusted CA, so verification normally just
// works; PG_SSL_NO_VERIFY=1 is the escape hatch for a provider with a private
// CA (mount its CA and pass it in PGSSLROOTCERT instead when possible).
const pgSsl = process.env.DATABASE_SSL === 'disable'
  ? false
  : {
      rejectUnauthorized: process.env.PG_SSL_NO_VERIFY !== '1',
      ca: process.env.PGSSLROOTCERT || undefined,
    };
const pool = dbAvailable
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgSsl })
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
// Every Gemini call is bounded. Without a timeout a hung upstream connection
// held the request open until the platform killed the function — and on a
// serverless host that kill also took the scan refund with it, so the user
// paid an allowance for a photo that was never analysed. 25 s leaves room for
// a large image plus the model's thinking, and short of Vercel's 60 s cap.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 25000;

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
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    }
  );
}

// ─── Shared per-user rate limiting ───────────────────────────────────────
// Gemini spending must be capped across serverless instances, so counters
// live in Firestore and are incremented atomically. If the shared store is
// unavailable, these expensive routes fail closed instead of falling back to
// per-instance limits that can be bypassed by instance fan-out.
const RATE_WINDOWS = {
  // route            per-minute cap
  '/chat': 30,
  '/analyze': 20,
  '/generate-diet-plan': 6,
};
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_COLLECTION = 'rateLimits';

// Returns null when allowed, or milliseconds until the window resets.
async function sharedRateLimitFor(bucketKey, limit) {
  if (!firestore.isEnabled()) throw new Error('Firestore rate-limit store is disabled');
  const db = firestore.getDb();
  if (!db || typeof db.runTransaction !== 'function') {
    throw new Error('Firestore transactions are unavailable');
  }

  const docId = crypto.createHash('sha256').update(bucketKey).digest('hex');
  const ref = db.collection(RATE_LIMIT_COLLECTION).doc(docId);
  let retryAfterMs = null;

  await db.runTransaction(async (tx) => {
    const now = Date.now();
    const snapshot = await tx.get(ref);
    const data = snapshot.exists ? snapshot.data() || {} : {};
    const windowStartMs = Number(data.windowStartMs);
    const count = Number(data.count) || 0;

    if (!Number.isFinite(windowStartMs) || now < windowStartMs || now - windowStartMs >= RATE_WINDOW_MS) {
      tx.set(ref, {
        windowStartMs: now,
        count: 1,
        expiresAt: new Date(now + RATE_WINDOW_MS * 2),
      });
      retryAfterMs = null;
      return;
    }

    if (count >= limit) {
      retryAfterMs = windowStartMs + RATE_WINDOW_MS - now;
      return;
    }

    tx.set(ref, {
      count: count + 1,
      expiresAt: new Date(windowStartMs + RATE_WINDOW_MS * 2),
    }, { merge: true });
    retryAfterMs = null;
  });

  return retryAfterMs;
}

// Express guard for one of the RATE_WINDOWS routes. 429 with Retry-After.
function rateLimit(route) {
  const limit = RATE_WINDOWS[route];
  return async (req, res, next) => {
    const uid = (req.user && req.user.uid) || null;
    const key = uid || (req.ip || 'anon') + ':' + route;
    let retryAfterMs;
    try {
      retryAfterMs = await sharedRateLimitFor(key + ':' + route, limit);
    } catch (e) {
      console.error('Shared rate-limit check failed:', e.message);
      return res.status(503).json({
        error: 'rate_limit_unavailable',
        message: 'This service is temporarily unavailable. Please try again shortly.',
      });
    }
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
        p.item.amount === 4900 &&
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
      amount: 4900, // ₹49 in paise
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
        // pro_until: a 30-day Pro window (referral reward). A paid subscription
        // sets `subscribed`; a referral only ever sets a date.
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_until TIMESTAMPTZ"); } catch (_) {}
        try { await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_code ON users (referral_code)"); } catch (_) {}
        await client.query(`
          CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            phone TEXT NOT NULL,
            transaction_ref TEXT NOT NULL,
            amount INTEGER DEFAULT 49,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT NOW()
          );
        `);
        // Deleted-account tombstone: remembers an account's identifier
        // (phone/email) and its PRE-REMOVAL trial metadata AFTER the account
        // is deleted. The free trial no longer exists, so the tombstone is
        // passive now — it is still written so a future pricing experiment
        // can never be farmed by delete -> re-register loops. Never wiped.
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
//
// The privilege is a Firebase CUSTOM CLAIM (`admin: true`), minted with the
// Admin SDK right here by ensureAdminClaim() and mirrored by `hasPro()` in
// firestore.rules. It used to be an email string compared against the token:
// the address sat in the source of both the server and the app, and anyone who
// could register that address held the same "proof". A custom claim is signed
// by Google into the ID token, so a client cannot mint it.
function isAdminUser(identity) {
  return !!identity && identity.isAdmin === true;
}

// Grants the `admin` claim to the owner account(s) at boot.
//
// Set ADMIN_EMAIL (comma-separated) in the environment — this is the ONE place
// the owner's address lives, it never ships in the app, and removing it from
// the env revokes nothing by itself: run `ensureAdminClaim` with the claim set
// to false, or clear custom claims, to revoke. No-op when Firebase Admin is not
// configured (local/dev without a service account).
async function ensureAdminClaim() {
  const emails = String(process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!emails.length) return;
  const admin = firestore.getAdmin ? firestore.getAdmin() : null;
  if (!admin) {
    console.warn('ADMIN_EMAIL is set but Firebase Admin is unavailable — admin claim not applied');
    return;
  }
  for (const email of emails) {
    try {
      const user = await admin.auth().getUserByEmail(email);
      const claims = user.customClaims || {};
      if (claims.admin !== true) {
        await admin.auth().setCustomUserClaims(user.uid, { ...claims, admin: true });
        console.log(`admin claim granted to ${email}`);
      }
    } catch (e) {
      console.warn(`admin claim for ${email} failed: ${e.message}`);
    }
  }
}

// ── Run the admin-claim sync on the FIRST REQUEST ────────────────────────
// ensureAdminClaim() used to run only inside `if (require.main === module)`,
// which is the `node server.js` path (local / Railway). Vercel IMPORTS this
// module as its handler and never executes that block, so on Vercel the
// owner's `admin` claim was never minted: no free Pro, no scan-limit
// exemption, and firestore.rules denied the owner's admin writes. Running it
// once, lazily, on the first request works on every host.
//
// It needs ADMIN_EMAIL in the environment to do anything; without it the call
// returns immediately (and this is a no-op).
let adminClaimStarted = false;
function startAdminClaimOnce() {
  if (adminClaimStarted) return;
  adminClaimStarted = true;
  ensureAdminClaim().catch((e) =>
    console.warn(`ensureAdminClaim failed: ${e.message}`)
  );
}
app.use((req, res, next) => {
  startAdminClaimOnce();
  next();
});

// ── Pricing: first month free ──────────────────────────────────────────
// The old 30-day free trial is GONE — for new and existing users alike (the
// owner/admin account keeps its permanent claim-based Pro). Pro now starts
// with a Razorpay subscription whose FIRST MONTH IS ₹0: at checkout the
// customer approves the ₹49/month autopay mandate, and the first ₹49 charge
// only happens after day 30. The approval — not a price break — is what
// both user and Razorpay see up front.
const FIRST_MONTH_FREE_DAYS = 30;

// A referral grants a 30-DAY Pro WINDOW (`pro_until`), not a permanent
// `subscribed` flag — an expired referral therefore drops the user back to
// free instead of giving away Pro forever. True for a parseable future date.
function proUntilActive(iso) {
  if (!iso) return false;
  const t = Date.parse(typeof iso === 'string' ? iso : String(iso));
  return Number.isFinite(t) && t > Date.now();
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
async function entitlementsFor({ uid, identifier, emailVerified, isAdmin }) {
  const day = istDayKey();
  const resetAt = istDayEndsAt();
  // The owner/admin account is always Pro — exempt from the free limit.
  // The paid flag comes from the Razorpay webhook/verify (subscribed:true).
  // The old 30-day trial no longer applies to anyone: trial_started_at may
  // still exist on old docs and is ignored everywhere now.
  let subscribed = isAdminUser({ isAdmin });
  let storedDay = null;
  let count = 0;

  // Firestore users/{uid} is the source of truth (production runs DB-less).
  if (uid && firestore.isEnabled()) {
    try {
      const doc = await firestore.getDb().collection('users').doc(uid).get();
      const d = (doc.exists ? doc.data() : {}) || {};
      if (d.subscribed === true) subscribed = true;
      // A referral's 30-day window counts as Pro until it passes.
      if (!subscribed && proUntilActive(d.pro_until)) subscribed = true;
      storedDay = d.scanDay || null;
      count = Number(d.scanCount) || 0;
    } catch (_) {}
  }

  // Postgres fallback (legacy deployments).
  if (dbAvailable && identifier) {
    if (!subscribed) {
      const u = await dbq(
        'SELECT subscribed, trial_started_at, pro_until FROM users WHERE phone = $1 OR email = $1 LIMIT 1',
        [identifier]
      );
      const row = u.rows[0];
      if (row && row.subscribed) subscribed = true;
      if (!subscribed && proUntilActive(row && row.pro_until)) subscribed = true;
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

// ─── Unidentified-scan refund budget ──────────────────────────────────
// A low-confidence or "Unknown" scan is refunded below, which is right for the
// user and free for them — and that is the problem. A stream of photos that
// are not food keeps being refunded, so ONE account can drive unlimited Gemini
// spend at our cost, bounded only by 20 requests a minute. Each account gets
// REFUND_CAP_PER_DAY refunds a day; past that an unidentified photo simply
// counts as a scan, so the worst case is REFUND_CAP + SCAN_LIMIT_FREE model
// calls per account per day.
const REFUND_CAP_PER_DAY = 15;

// Claims one refund from today's budget. Returns true when the refund may be
// given. Never throws: when the counter store cannot be read or written it
// returns true, because a wrongly withheld refund is a user-visible bug while
// an extra Gemini call is only money.
async function takeRefundBudget({ uid, day }) {
  if (!uid || !firestore.isEnabled()) return true;
  const db = firestore.getDb();
  const ref = db.collection('users').doc(uid);
  try {
    return await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const d = (doc.exists ? doc.data() : {}) || {};
      const count = d.refundDay === day ? (Number(d.refundCount) || 0) : 0;
      if (count >= REFUND_CAP_PER_DAY) return false;
      tx.set(ref, { refundCount: count + 1, refundDay: day }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error('Refund budget check failed (allowing the refund):', e.message);
    return true;
  }
}

// Meal weight in grams, or 0 when the AI did not send a usable number.
// Clamped to the same 5–5000 g range the card can render.
function clampGrams(value) {
  // numOr, not Number: the model writes "150 g" as often as 150, and Number
  // turned every one of those into 0 — which silently fell back to the whole
  // dish's weight for that component.
  const n = numOr(value, 0);
  if (n <= 0) return 0;
  return Math.min(5000, Math.round(n));
}

// ─── AI output is untrusted input ──────────────────────────────────────
// The model is asked for numbers, and it usually sends numbers — but it also
// sends "250 kcal", "~12", null, or an object, depending on the day. The app
// casts these with `as num`, so ONE bad value used to throw a TypeError while
// building the result card, stranding the user on a blank screen after a scan
// they had already paid for. Everything below coerces and clamps so the shape
// is guaranteed, whatever the model produced.
const MAX_DISHES = 12;
const MAX_NAME_LEN = 60;

// A number, or [fallback]. Accepts a numeric string ("250") and a string that
// merely starts with one ("250 kcal"), which is the common model slip.
function numOr(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const parsed = parseFloat(String(value == null ? '' : value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampRange(value, min, max, fallback = 0) {
  const n = numOr(value, fallback);
  return Math.min(max, Math.max(min, n));
}

// A trimmed, bounded string. Non-strings (objects, arrays, numbers) collapse to
// [fallback] rather than reaching the app as the wrong JSON type.
function cleanText(value, fallback = '', maxLen = MAX_NAME_LEN) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : fallback;
}

// A dish's weight, with a fallback the prompt cannot always guarantee: when

// the model sent no usable dish weight but DID name component weights (which
// it must, per the prompt, sum to the dish), their sum is the dish weight.
function dishGramsFrom(d, ingredients) {
  const direct = clampGrams(d.grams);
  if (direct > 0) return direct;
  const sum = ingredients.reduce((s, i) => s + i.grams, 0);
  return sum > 0 ? Math.min(5000, Math.round(sum)) : 0;
}

// Total edible weight of EVERYTHING visible — the app opens its serving here.
// Trust the model's total when it sent one; otherwise the sum of the per-dish
// weights (already clamped). 0 means "unknown": the caller keeps the
// historical 100 g baseline so old prompts behave exactly as before.
function totalGramsFrom(json, normalizedDishes) {
  const raw = numOr(json.total_grams, 0);
  if (raw > 0) {
    return Math.min(3000, Math.max(5, Math.round(raw)));
  }
  const sum = normalizedDishes.reduce((s, d) => s + Math.max(0, d.grams || 0), 0);
  return sum > 0 ? Math.min(3000, Math.max(5, Math.round(sum))) : 0;
}

const SUITABLE_FOR = new Set(['bulk', 'diet', 'both']);
function cleanSuitableFor(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SUITABLE_FOR.has(v) ? v : 'both';
}

// Per-100 g nutrition, clamped to what is physically possible: no food is
// above 900 kcal/100 g (pure fat) and no macronutrient is above 100 g/100 g.
function macrosFrom(d) {
  return {
    calories_per_100g: Math.round(clampRange(d.calories_per_100g ?? d.calories, 0, 900)),
    protein_g_per_100g: clampRange(d.protein_g_per_100g ?? d.protein_g, 0, 100),
    carbs_g_per_100g: clampRange(d.carbs_g_per_100g ?? d.carbs_g, 0, 100),
    fats_g_per_100g: clampRange(d.fats_g_per_100g ?? d.fats_g, 0, 100),
    fiber_g_per_100g: clampRange(d.fiber_g_per_100g ?? d.fiber_g, 0, 100),
    sugar_g_per_100g: clampRange(d.sugar_g_per_100g ?? d.sugar_g, 0, 100),
  };
}

// The visible components of one dish. Optional and defensive: the model is
// asked for them, but a photo of a smoothie genuinely has none, and a bad
// shape from the model must never turn into a 500 or a card full of zeros.
function normalizeIngredients(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((i) => i && typeof i === 'object' && cleanText(i.name, ''))
    .slice(0, 12)
    .map((i) => ({
      name: cleanText(i.name, ''),
      grams: clampGrams(i.grams),
      health_score: Number.isFinite(numOr(i.health_score, NaN))
        ? Math.min(5, Math.max(0, Math.round(numOr(i.health_score))))
        : null
    }));
}

app.post('/analyze', requireAuth, rateLimit('/analyze'), upload.single('image'), async (req, res) => {
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
    //
    // AWAITED, deliberately: on a serverless host the function is frozen the
    // moment the response is sent, and an un-awaited refund is simply lost —
    // which is exactly the "paid for a photo that failed" bug the refund was
    // added to prevent. The write is a single transaction, so the wait is
    // milliseconds.
    const refundScan = async () => {
      if (!reservation) return;
      try {
        await releaseScan({ uid: id.uid, identifier: id.identifier, day: ent.scan_day });
      } catch (e) {
        console.error('Scan refund failed:', e.message);
      }
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
  "total_grams": REAL edible weight of ALL food PHYSICALLY VISIBLE in THIS photo, in grams (number). Never a nutrition-per-100 g figure and never a round default: weigh the actual items (ONE whole egg ≈ 55 g; TWO boiled eggs ≈ 110 g),
  "dishes": [
    {
      "name": "accurate food name in English",
      "portion_description": "estimated portion like '1 small bowl' or '1 slice (80g)' (for a single food say how many, e.g. '1 whole egg (55g)')",
      "calories_per_100g": integer,
      "protein_g_per_100g": number,
      "carbs_g_per_100g": number,
      "fats_g_per_100g": number,
      "fiber_g_per_100g": number,
      "sugar_g_per_100g": number,
      "suitable_for": "bulk"/"diet"/"both",
      "grams": REAL edible weight of THIS dish ALONE as seen in THIS photo (number) — count the items and scale from visible references (a hand, a plate, a bowl): ONE whole egg ≈ 55 g, ONE small roti ≈ 40 g, ONE banana ≈ 105 g, ONE small bowl of dal ≈ 150 g,
      "ingredients": [
        { "name": "component VISIBLE in THIS photo, e.g. Chicken egg", "grams": its real weight in grams (number), "health_score": integer 0-5 for that component }
      ]
    }
  ]
}
Rules: 1 dish entry per visible item. Be specific about the portion. Weights must describe THIS photo: total_grams is the sum of every visible item's real weight and each dish's grams is that dish alone — estimate them item by item from what you can SEE (ONE whole egg ≈ 55 g, TWO whole eggs ≈ 110 g, ONE small roti ≈ 40 g, ONE small bowl of dal ≈ 150 g); never report a nutrition per-100 g weight and never a guessed round default such as 100 g. Nutrition data (per 100 g) stays standard. For each dish, grams must be that dish alone and ingredients must list ONLY the components physically visible in THIS photo: a single-item food has exactly ONE ingredient (one egg = one "Chicken egg"; one banana = one "Banana"), so list 1–8 of them, never split one food into several ingredients and never add anything you cannot see in the photo — no guesses, no classical recipes, no other egg varieties. A duck egg appears only when a duck egg is truly in the photo. Component weights must sum to roughly the dish's grams. health_score rewards protein, fibre and vegetables and penalises added sugar, deep frying and very high fat. If you cannot see individual components, return an empty ingredients array. If unsure, name the most likely food rather than guessing an Indian equivalent. Return ONLY raw JSON. No markdown. No backticks.` },
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
      await refundScan();
      throw e;
    }

    // The scan was already reserved up front, so there is nothing left to
    // increment here — these are just the numbers the reservation produced.
    // Pro/admin never reserved, so they still report the untouched count.
    let scansUsed = reservation ? reservation.used : ent.scans_used;
    let scansLimit = ent.subscribed ? null : SCAN_LIMIT_FREE;

    // A single dish is the common case; a model that returns a non-array (or
    // an array of junk) falls back to the flat top-level shape, which older
    // prompts produced.
    let dishes = Array.isArray(json.dishes)
      ? json.dishes.filter((d) => d && typeof d === 'object').slice(0, MAX_DISHES)
      : [];
    if (dishes.length === 0) {
      dishes = [{ ...json, name: json.meal_name || json.name }];
    }

    // Total edible weight of EVERYTHING visible — the app uses it as the
    // starting serving, so one egg opens at ~55 g instead of a fixed 100 g.
    // The model's total wins; without one, the per-dish weights are summed;
    // 100 g preserves the old behaviour when neither was sent. Clamped so a
    // wild AI number can't wreck the log.
    const normalizedDishes = dishes.map((d) => {
      const ingredients = normalizeIngredients(d.ingredients);
      return {
        name: cleanText(d.name, 'Unknown'),
        portion_description: cleanText(d.portion_description, '', 80),
        ...macrosFrom(d),
        suitable_for: cleanSuitableFor(d.suitable_for),
        // Per-dish weight and component list (see the prompt above). Both are
        // optional: an older prompt, or a photo where the components cannot be
        // told apart, sends nothing and the app falls back to the dish itself.
        // When the dish has no weight of its own but its components do, the
        // components' sum is the dish — a single "one egg" scan stays one egg.
        grams: dishGramsFrom(d, ingredients),
        ingredients,
      };
    });
    const totalGrams = totalGramsFrom(json, normalizedDishes) || 100;

    const normalized = {
      description: cleanText(json.description, '', 200),
      confidence: clampRange(json.confidence, 0, 1, 0.7),
      grams: totalGrams,
      dishes: normalizedDishes,
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
      // Refunds are budgeted per account per day (REFUND_CAP_PER_DAY): the
      // first few unidentified shots are free, after that they count, which
      // is what stops one account from feeding us non-food photos forever.
      const withinBudget = unidentified
        ? await takeRefundBudget({ uid: id.uid, day: ent.scan_day })
        : false;
      if (withinBudget) {
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

app.get('/me/referral-code', requireAuth, async (req, res) => {
  try {
    const identifier = identityOf(req).identifier;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    res.json({ referral_code: await getOrCreateReferralCode(identifier) });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// ─── Referral reward ───────────────────────────────────────────────────────
// A referral buys BOTH accounts 30 days of Pro — which is what the app has
// always told the user ("both get Pro free for a month", ReferralService
// returns 'free_month'). The old version wrote `subscribed: true` with NO end
// date, so one code made two accounts Pro forever.
//
// It had two more holes:
//   - The "already used a code" guard read only Postgres. Production runs
//     Firestore-only, so that query always came back empty and the guard never
//     fired — a code could be applied again and again, and the referrer earned
//     permanent Pro each time.
//   - Self-referral was only blocked by comparing the referrer's PHONE, which
//     is NULL on the Firestore-only path, against a non-null identifier — so
//     the check could never succeed there.
//
// Now the Firestore transaction is the authority: it checks "already used"
// and grants the window in one atomic step, and self-referral is blocked by
// UID as well as by identifier.
const REFERRAL_PRO_DAYS = 30;

// Later of two Pro end dates — extending a Pro window must never shorten one
// the user already has (paid, an earlier referral, ...).
function laterOfProUntil(a, b) {
  const ta = Date.parse(a || '') || 0;
  const tb = Date.parse(b || '') || 0;
  return new Date(Math.max(ta, tb)).toISOString();
}

app.post('/referral/apply', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const id = identityOf(req);
    // The reward is applied to the signed-in account, never to a phone/email
    // the client claims.
    const phone = id.identifier;
    const upper = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!phone || !upper) return res.status(400).json({ error: 'Phone and code required' });

    let referrerPhone = null;
    let referrerUid = null;

    // The Firestore referrals index is the live path; Postgres is legacy.
    if (firestore.isEnabled()) {
      try {
        const refDoc = await firestore.getDb().collection('referrals').doc(upper).get();
        if (refDoc.exists) referrerUid = refDoc.data().uid || null;
      } catch (_) {}
    }
    if (!referrerUid) {
      const referrer = await dbq('SELECT phone FROM users WHERE referral_code = $1', [upper]);
      if (referrer.rows[0]?.phone) {
        referrerPhone = referrer.rows[0].phone;
        referrerUid = await firestore.resolveUid(referrerPhone);
      }
    }
    if (!referrerPhone && !referrerUid) return res.status(404).json({ error: 'Invalid referral code' });

    // Self-referral: blocked by UID (authoritative on Firestore) as well as by
    // identifier, so the Firestore-only path can no longer slip through.
    if ((referrerUid && id.uid && referrerUid === id.uid) ||
        (referrerPhone && referrerPhone === phone)) {
      return res.status(400).json({ error: 'Cannot use your own code' });
    }

    const proUntil = new Date(Date.now() + REFERRAL_PRO_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Legacy deployments: this check has to happen BEFORE the Firestore grant,
    // not after, or a Postgres-only user could be granted and then rejected.
    if (dbAvailable && phone) {
      const newUser = await dbq('SELECT referred_by FROM users WHERE phone = $1', [phone]);
      if (newUser.rows[0]?.referred_by) {
        return res.status(400).json({ error: 'Already used a referral code' });
      }
    }

    // Firestore is authoritative. ONE transaction does the check and the
    // grant, so the guard cannot be skipped when Postgres is absent, and two
    // concurrent submissions cannot both win. A transaction failure fails
    // closed: no reward is granted.
    if (firestore.isEnabled() && id.uid) {
      const db = firestore.getDb();
      let alreadyUsed = false;
      await db.runTransaction(async (tx) => {
        const myRef = db.collection('users').doc(id.uid);
        const myDoc = await tx.get(myRef);
        const mine = (myDoc.exists ? myDoc.data() : {}) || {};
        if (mine.referredBy || mine.referred_by) {
          alreadyUsed = true;
          return;
        }
        tx.set(myRef, {
          referredBy: upper,
          pro_until: laterOfProUntil(mine.pro_until, proUntil),
          pro_until_at: new Date(laterOfProUntil(mine.pro_until, proUntil)),
        }, { merge: true });

        // The referrer is rewarded only once the invitee has actually
        // redeemed, so a code cannot be farmed from a second account.
        if (referrerUid) {
          const theirRef = db.collection('users').doc(referrerUid);
          const theirDoc = await tx.get(theirRef);
          const theirs = (theirDoc.exists ? theirDoc.data() : {}) || {};
          const referrerProUntil = laterOfProUntil(theirs.pro_until, proUntil);
          tx.set(theirRef, {
            pro_until: referrerProUntil,
            pro_until_at: new Date(referrerProUntil),
          }, { merge: true });
        }
      });
      if (alreadyUsed) return res.status(400).json({ error: 'Already used a referral code' });
    }

    // Legacy Postgres mirror. It records the referral and the WINDOW — never a
    // permanent `subscribed = true`, which is the bug being fixed here.
    if (dbAvailable && phone) {
      await dbq('UPDATE users SET referred_by = $1 WHERE phone = $2', [upper, phone]);
      await dbq(
        'UPDATE users SET pro_until = GREATEST(COALESCE(pro_until, NOW()), $1::timestamptz) WHERE phone = $2',
        [proUntil, phone]
      );
      if (referrerPhone) {
        await dbq(
          'UPDATE users SET pro_until = GREATEST(COALESCE(pro_until, NOW()), $1::timestamptz) WHERE phone = $2',
          [proUntil, referrerPhone]
        );
      }
    }

    res.json({
      subscribed: true,
      referrer: referrerPhone || 'referred',
      pro_until: proUntil,
    });
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

// ─── Meal backup ───────────────────────────────────────────────────────────
// REMOVED: GET /meals/list/:phone and POST /meals/remove (audit).
// A comment here used to claim "the app's MealSyncService always used" them,
// which is false: MealSyncService writes and reads the `meals` COLLECTION IN
// CLOUD FIRESTORE directly (lib/services/meal_sync_service.dart), and there is
// not a single `meals/list` or `meals/remove` string anywhere in the app. They
// date from Phase 1 (f2ff4c5), before that migration. Dead routes are attack
// surface for nothing in return, so they are gone.
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

// ─── Habits & Water Log ─────────────────────────────────────────────────────
// REMOVED: POST /habits/sync and GET /habits/list/:phone (audit).
// The comment that used to sit here said the Flutter app's MealSyncService
// "hits" these routes. It does not: habits are written to and read from the
// `habitData` COLLECTION IN CLOUD FIRESTORE (MealSyncService ->
// _db.collection('habitData')), and the app contains no '/habits/sync' or
// '/habits/list' call anywhere. They were dead, so they are removed.

// ─── Razorpay: Create Recurring Subscription ───────────────────────────────
// Real ₹49/month recurring billing (first month ₹0): creates a Razorpay
// Subscription (auto-
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

    // One auto-charging subscription per account. Razorpay happily creates a
    // second one, so without this a second device (or a second tap after a
    // slow network) begins billing the same person twice — and nothing in the
    // app would show it until the statement arrived. With the free trial
    // gone, no skipped path remains: any subscribed account is told
    // "already subscribed" instead of being double-billed.
    const ent = await entitlementsFor(id);
    if (ent.subscribed) {
      return res.status(409).json({
        error: 'already_subscribed',
        message: 'This account already has an active Pro subscription.',
      });
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
      // FIRST MONTH FREE (₹0): billing starts 30 days out. This is Razorpay's
      // documented way to defer the first charge — during those 30 days the
      // customer only AUTHORIZES the ₹49/month autopay mandate at checkout
      // (plus a tiny auto-refunded token payment); the first ₹49 charge
      // happens at/start of the future cycle, reported by
      // subscription.activated / subscription.charged via the webhook below.
      start_at: Math.floor((Date.now() + FIRST_MONTH_FREE_DAYS * 24 * 60 * 60 * 1000) / 1000),
      plan_id: planId,
      // Razorpay stops charging after total_count cycles, so 12 silently
      // ended Pro (and the billing) one year after signup. 100 is Razorpay's
      // own maximum — effectively open-ended — and the webhook still reacts to
      // `halted`/`cancelled`, so a failed card ends the subscription properly.
      total_count: 100,
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
      // The token's uid first: resolveUid(phone) is a lookup that misses for an
      // email identity (or a number Firebase does not hold), and this mapping
      // is what /payment/verify trusts to decide who owns the payment.
      const fUid = id.uid || (await firestore.resolveUid(phone));
      await firestore.set(
        'subscriptions/' + subscription.id,
        {
          uid: fUid || null,
          identifier: phone,
          phone: phone,
          status: subscription.status || 'created',
          updatedAt: new Date(),
        },
        { merge: true }
      );
    } catch (_) {}

    res.json({
      subscription_id: subscription.id,
      amount: 4900, // what auto-charges once the free first month is over
      currency: 'INR',
      // Month 1 costs nothing, but the ₹49 autopay mandate is approved now.
      first_month_free: true,
      first_month_free_days: FIRST_MONTH_FREE_DAYS,
      first_charge_at:
        subscription.start_at
          ? new Date(subscription.start_at * 1000).toISOString()
          : null,
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

    // Timing-safe, like the webhook: `!==` on two strings returns at the first
    // differing byte, which leaks how much of a forged signature was correct
    // to anyone who can time the response.
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const receivedBuf = Buffer.from(
      typeof razorpay_signature === 'string' ? razorpay_signature : '',
      'hex'
    );
    if (
      receivedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(receivedBuf, expectedBuf)
    ) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const id = identityOf(req);
    const payment = await razorpay.payments.fetch(razorpay_payment_id);

    // ── Who owns this payment? ──────────────────────────────────────────
    // This used to REQUIRE payment.notes.phone and answer 400 without it.
    // Razorpay does not reliably copy a subscription's notes onto its
    // payments, so real subscription payments could be rejected before the
    // webhook ever got a chance to activate them.
    //
    // Sources, most trustworthy first:
    //   1. our own subscriptions/{id} document, written by
    //      create-subscription from the VERIFIED token — it holds uid + phone;
    //   2. the payment's own notes (the legacy order flow puts the phone here);
    //   3. the subscription object, whose notes we set at creation.
    // The token's identity is the last resort: it is verified, and the
    // signature check above already proved the payment is genuine.
    let ownerPhone = null;
    let ownerUid = null;
    if (razorpay_subscription_id) {
      const mapping = await firestore.get(
        'subscriptions/' + razorpay_subscription_id
      );
      if (mapping) {
        if (typeof mapping.uid === 'string' && mapping.uid) ownerUid = mapping.uid;
        if (typeof mapping.identifier === 'string' && mapping.identifier) {
          ownerPhone = mapping.identifier;
        } else if (typeof mapping.phone === 'string' && mapping.phone) {
          ownerPhone = mapping.phone;
        }
      }
    }
    if (!ownerPhone && typeof payment.notes?.phone === 'string' && payment.notes.phone) {
      ownerPhone = payment.notes.phone;
    }
    if (!ownerPhone && payment.subscription_id) {
      try {
        const sub = await razorpay.subscriptions.fetch(payment.subscription_id);
        if (typeof sub?.notes?.phone === 'string' && sub.notes.phone) {
          ownerPhone = sub.notes.phone;
        }
      } catch (e) {
        console.warn(
          'Could not read subscription ' + payment.subscription_id + ':',
          e.message
        );
      }
    }

    const phone = ownerPhone || id.identifier;
    if (!phone) {
      console.error('Could not determine the owner of payment', {
        payment_id: razorpay_payment_id,
        subscription_id: razorpay_subscription_id || null,
      });
      return res.status(400).json({ error: 'Could not identify user for this payment' });
    }

    // Only the account that paid may verify this payment. The uid from our own
    // mapping is definitive; the identifier comparison is the fallback for a
    // subscription created before that mapping existed. When the mapping names
    // the caller, a different identifier must NOT lock them out (the same
    // person can have both a phone and an email identity).
    const foreignByUid = !!(ownerUid && id.uid && ownerUid !== id.uid);
    const foreignById = !!(
      !ownerUid &&
      ownerPhone &&
      id.identifier &&
      ownerPhone !== id.identifier
    );
    if (foreignByUid || foreignById) {
      return res.status(403).json({ error: 'Payment does not belong to this account' });
    }

    // Where the activation actually landed. A response of success:true means
    // "you are Pro", and the app unlocks Pro locally on it — so it may only be
    // sent when a store really recorded the subscription.
    let activatedIn = null;

    // Postgres rows are keyed by the identifier and only exist where Postgres
    // is configured; dbq() is a silent no-op without it.
    if (dbAvailable) {
      const p = await dbq(
        `INSERT INTO payments (phone, transaction_ref, amount, status)
         VALUES ($1, $2, $3, 'approved')`,
        [phone, razorpay_payment_id, (payment.amount || 4900) / 100]
      );
      if (p._failed) {
        console.error('Payment insert failed for', razorpay_payment_id);
      }
      const u = await dbq(
        'INSERT INTO users (phone, subscribed) VALUES ($1, true) ON CONFLICT (phone) DO UPDATE SET subscribed = true',
        [phone]
      );
      if (!u._failed) activatedIn = 'postgres';
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
    }

    // Firestore is the source of truth in production, and its docs are keyed
    // by the Firebase UID. That UID comes from the VERIFIED TOKEN — not from
    // resolveUid(payment.notes.phone), which returns null for an email login
    // or a number Firebase does not know. That miss used to skip activation
    // entirely while the response still said success:true, so a paying user
    // stayed on the free tier and nothing anywhere recorded a failure.
    const fUid = ownerUid || id.uid || (await firestore.resolveUid(phone));
    if (fUid && firestore.isEnabled()) {
      const userDocs = await firestore.set(
        'users/' + fUid,
        { subscribed: true, subscriptionId: razorpay_subscription_id || null },
        { merge: true }
      );
      if (userDocs) activatedIn = 'firestore';
      // The subscription/payment records are audit trail, not activation, so
      // they do not decide the response.
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
        amount: (payment.amount || 4900) / 100,
        status: 'approved',
        createdAt: new Date(),
      }, { merge: true });
    }

    if (!activatedIn) {
      console.error('Payment verified but not persisted', {
        payment_id: razorpay_payment_id,
        uid: id.uid || null,
        firestore: firestore.isEnabled(),
        postgres: dbAvailable,
      });
      // 202 (not 5xx): the money DID go through, and the webhook may still
      // activate the account. The client shows "payment received, Pro will
      // activate shortly" instead of pretending everything is fine.
      return res.status(202).json({
        error: 'activation_pending',
        message:
          'Payment received but the subscription could not be saved yet. ' +
          'It will activate automatically; quote this payment id to support if it does not.',
        payment_id: razorpay_payment_id,
      });
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
    // FREE TRIALS ARE REMOVED — for existing and new users alike. The endpoint
    // still answers so older installed app versions receive a clean "no
    // trial" answer and drop their stored countdown (the server's no-trial
    // verdict is authoritative) instead of erroring on the removed grant.
    // The owner/admin account is the only always-free Pro tier.
    const id = identityOf(req);
    if (isAdminUser(id)) return res.json({ admin: true, active: false, daysLeft: 0 });
    res.json({ active: false, expired: false, daysLeft: 0 });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// In-app self-service account deletion.
//
// Wipes ALL of the user's data (Postgres + Firestore) but keeps a tombstone
// that remembers the identifier (phone/email) AND the original trial start.
// That tombstone is what prevents a delete -> re-login -> fresh free-trial
// that remembers the identifier (phone/email) — never wiped.
// The free trial no longer exists, so the tombstone's trial fields only
// matter as historical bookkeeping; nothing re-grants off them.
app.post('/account/delete', requireAuth, async (req, res) => {
  try {
    // You can only delete the account you are signed in as.
    const id = identityOf(req);
    const phone = id.phone || id.identifier;
    const email = id.email;
    const identifier = phone || email;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    if (isAdminUser(id)) return res.status(403).json({ error: 'Admin account cannot be deleted' });

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
      for (const col of ['habitData', 'dietProfiles', 'recentFoods', 'userPreferences']) {
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
    // resolveUid() looks the account up in userIndex by its primary identifier.
    const identifier = id.identifier || email || phone;

    // The owner is always subscribed (custom claim, never an email match).
    if (isAdminUser(id)) return res.json({ subscribed: true });

    // Firestore is the source of truth (Phase 3) — check users/{uid} first.
    const fUid = await firestore.resolveUid(identifier);
    if (fUid && firestore.isEnabled()) {
      try {
        const doc = await firestore.getDb().collection('users').doc(fUid).get();
        if (doc.exists && doc.data().subscribed === true) {
          // pro_until rides along so the app can show the end date.
          return res.json({
            subscribed: true,
            ...(doc.data().pro_until ? { pro_until: doc.data().pro_until } : {}),
          });
        }
        // A referral's 30-day window counts as Pro until pro_until passes.
        if (doc.exists && proUntilActive(doc.data().pro_until)) {
          const proUntil = doc.data().pro_until;
          if (!doc.data().pro_until_at) {
            await firestore.set('users/' + fUid, {
              pro_until_at: new Date(proUntil),
            }, { merge: true });
          }
          return res.json({ subscribed: true, pro_until: proUntil });
        }
        // The old 30-day free trial no longer applies to anyone — a stored
        // trial_started_at on an old doc is ignored here, exactly like in
        // entitlementsFor(). Only a paid/referral/admin account is Pro.
      } catch (_) {}
    }

    // Postgres fallback (legacy / when Firestore has no user doc).
    let user = null;
    if (phone) {
      const r = await dbq('SELECT subscribed, pro_until FROM users WHERE phone = $1 LIMIT 1', [phone]);
      user = r.rows[0] || null;
    }
    if (!user && email) {
      const r = await dbq('SELECT subscribed, pro_until FROM users WHERE email = $1 LIMIT 1', [email]);
      user = r.rows[0] || null;
    }
    if (user?.subscribed) {
      return res.json({
        subscribed: true,
        ...(user.pro_until ? { pro_until: user.pro_until } : {}),
      });
    }
    if (proUntilActive(user && user.pro_until)) return res.json({ subscribed: true, pro_until: user.pro_until });
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
  // Make sure the owner's `admin` claim exists (no-op without ADMIN_EMAIL).
  // On serverless hosts the first-request middleware above does this instead.
  startAdminClaimOnce();
}

module.exports = app;
module.exports._rateLimits = RATE_WINDOWS;
// Test hook: the pure AI-output sanitizers. They are the only thing standing
// between a hallucinated "250 kcal" and a result card that throws, so they are
// unit-tested directly (test/scan_output.test.js).
module.exports._scanSanitizers = {
  numOr,
  clampRange,
  cleanText,
  cleanSuitableFor,
  macrosFrom,
  clampGrams,
  normalizeIngredients,
  dishGramsFrom,
  totalGramsFrom,
};
