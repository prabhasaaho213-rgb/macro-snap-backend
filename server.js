require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { Pool } = require('pg');
const firestore = require('./firestore');
const { requireAuth, identityOf } = require('./auth');
const lb = require('./leaderboard');

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
  // Referral codes are 6 characters from a 32-symbol alphabet. Nothing stopped
  // a signed-in script from trying thousands a minute until one hit, and each
  // hit is a month of Pro for the guesser (and for the referrer). A tight cap
  // makes enumeration impractical while a real user, who types one code once,
  // never notices.
  '/referral/apply': 10,
  // Each call creates a Razorpay customer and subscription, so an unlimited
  // loop is a way to fill the merchant account with junk mandates.
  '/payment/create-subscription': 5,
  // Each sync reads a week of meals/habits and writes three board rows.
  '/leaderboard/sync': 12,
  // Account-scoped step history. The app pushes after a step batch (throttled
  // to a few a minute), so this only has to stop a runaway loop.
  '/steps/sync': 20,
  // A rename happens a handful of times in an account's life.
  '/user/profile': 10,
  // A profile edit is cheap, but it is still a write: enough for someone
  // trying names and avatars out, far too few to be used as a write pump.
  '/profile/publish': 15,
  // Creating a league mints a unique code, so it is the route worth capping.
  '/friends/league': 5,
  // Joining is a 6-character code typed by hand; the cap makes guessing a
  // stranger's league impractical while a real invite never notices.
  '/friends/join': 10,
  '/friends/sync': 12,
  '/friends/leave': 10,
  // Unauthenticated install/join analytics: each call writes a new
  // inviteEvents document, so an open loop is a way to inflate the database
  // and the bill. A real client sends a handful per install; this cap stops
  // spam without touching a legitimate flow.
  '/join/event': 20,
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

// Per-process fallback for the shared limiter. Failing closed turned a
// Firestore hiccup into a 503 on every limited route, so the API went down
// whenever its rate-limit store did. A local counter still stops a runaway
// client on this instance; it is per instance, so the cap is weaker while the
// shared store is unavailable — an acceptable trade for availability.
const memoryLimits = new Map();
function memoryRateLimitFor(bucketKey, limit) {
  const now = Date.now();
  if (memoryLimits.size > 10000) memoryLimits.clear();
  const entry = memoryLimits.get(bucketKey);
  if (!entry || now - entry.startMs >= RATE_WINDOW_MS) {
    memoryLimits.set(bucketKey, { startMs: now, count: 1 });
    return null;
  }
  entry.count += 1;
  if (entry.count > limit) return entry.startMs + RATE_WINDOW_MS - now;
  return null;
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
      // Fail OPEN to the local counter: a store outage must not take every
      // limited route offline.
      console.warn('Shared rate-limit check failed, using local counter:', e.message);
      retryAfterMs = memoryRateLimitFor(key + ':' + route, limit);
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

// Liveness probe. Deliberately says nothing sensitive — no keys, no counts of
// users, no configuration values — just whether the process is up, whether the
// Firestore Admin SDK initialised, and for how long. Vercel and uptime checks
// need this; a 404 here made a healthy deployment look down.
const BOOTED_AT = Date.now();
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    firestore: firestore.isEnabled(),
    postgres: dbAvailable,
    uptimeSeconds: Math.round((Date.now() - BOOTED_AT) / 1000),
  });
});

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
        // intro_used: this account has already collected the ₹1 first month;
        // every later subscription bills ₹49 from day one.
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS intro_used BOOLEAN DEFAULT false"); } catch (_) {}
        // FREE TRIALS ARE GONE: erase every leftover trial marker so no code
        // path — old or new — can ever reinterpret one as an entitlement.
        try { await client.query("UPDATE users SET trial_started_at = NULL WHERE trial_started_at IS NOT NULL"); } catch (_) {}
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
        // Deleted-account tombstone: an HMAC fingerprint of the account's
        // identifier plus its PRE-REMOVAL trial metadata, written when the
        // account is deleted. phone/email are legacy columns left over from
        // the cleartext version and are no longer written; the identifier
        // column now holds the fingerprint. Rows expire after
        // TOMBSTONE_RETENTION_MONTHS, so this is not kept forever.
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
// Month 1 costs a token ₹1, collected as Razorpay's `addons` upfront charge
// during the authorisation transaction; the ₹49 autopay then begins 30 days
// later via a future `start_at`. Charging ₹1 as the *first cycle* instead is
// not an option: Razorpay refuses to update a plan on a subscription
// authorised by UPI or e-mandate, and most Indian users pay by UPI.
const FIRST_MONTH_DAYS = 30;
const FIRST_MONTH_PRICE = 100; // ₹1 in paise

// ── Intro offer eligibility: ₹1 once per ACCOUNT, not once per signup ───
// Every subscription app that runs an intro price enforces it against a
// durable record of the person, not their current state: Spotify excludes
// anyone who ever subscribed, YouTube re-qualifies only after 6 months,
// Apple allows one intro offer per subscription group. Razorpay offers no
// such check — nothing stops the same customer creating a new subscription
// — so the ledger lives here.
//
// An account has "used" the ₹1 month when EITHER:
//   * intro_used was recorded on a previous successful charge, or
//   * any payment record exists for the identifier (accounts that paid
//     before this flag existed — the flag is only written from this release
//     on, and a legacy payer must not be handed ₹1 again), or
//   * a deletion tombstone exists for it — the payment records are wiped by
//     /account/delete, so for a deleted account this is the only evidence.
//
// Fail-open: when the stores cannot be read, the intro price is offered
// rather than withheld — wrongly charging a first-timer ₹49 at checkout
// (after the app already showed them ₹1) is the worse mismatch, and the
// abuse costs at most one ₹1 month per incident.

// ── Deletion tombstone: a fingerprint, never an address ─────────────
// The tombstone has exactly one purpose (see /account/delete): stop the ₹1
// first month being collected twice by deleting and re-registering. Keeping an
// email address for that is both unnecessary and the most sensitive thing in
// the database — an identifier retained with no expiry is precisely what an
// erasure request targets.
//
// It was also never read by any code path, so the record enforced nothing while
// being stored forever. Both halves are fixed here: what is stored is an HMAC
// of the normalised identifier, keyed with a server secret, so the same input
// always matches and nothing can be read back out of it; and rows older than
// TOMBSTONE_RETENTION_MONTHS are deleted, so the record has a defined lifetime
// instead of "indefinitely".
const TOMBSTONE_RETENTION_MONTHS = 24;

// A DEDICATED key, never the Razorpay secret. Reusing that one would silently
// re-key every fingerprint the day the payment keys rotate — and every deleted
// account would then be offered ₹1 again, because their tombstone no longer
// matches. The fallback chain also used to include a constant in this file,
// which made "cannot be reversed without our key" false: anyone with the source
// could hash a guessed address and check the table for a match.
const TOMBSTONE_SECRET = (process.env.TOMBSTONE_SECRET || '').trim();
const IS_PRODUCTION_ENV =
  process.env.VERCEL_ENV === 'production' ||
  process.env.NODE_ENV === 'production';

if (!TOMBSTONE_SECRET && IS_PRODUCTION_ENV) {
  // Refuse to serve rather than quietly weaken. This throws at module load, so
  // the deployment fails its health check instead of writing fingerprints
  // nobody can reproduce.
  throw new Error(
    'TOMBSTONE_SECRET is required in production. Generate one with ' +
      '`openssl rand -hex 32` and set it as an environment variable; it keys ' +
      'the deletion-tombstone fingerprints and must stay stable (changing it ' +
      'lets every deleted account claim the ₹1 month again).'
  );
}

// Development and tests only: a fixed key, loudly labelled, so local
// fingerprints are reproducible but can never be mistaken for production's.
const TOMBSTONE_KEY = TOMBSTONE_SECRET || 'insecure-development-key';
if (!TOMBSTONE_SECRET) {
  console.warn(
    'TOMBSTONE_SECRET not set — using an insecure development key. ' +
      'Fingerprints created here will not match production.'
  );
}

// ── Key canary ─────────────────────────────────────────────────────
// A migration run with the wrong TOMBSTONE_SECRET writes fingerprints the
// server will never match, and that mistake is invisible from the data: in the
// normal case no legacy record's fingerprint already exists (the delete handler
// removes the legacy document when that account deletes again), so a correct run
// looks exactly like a wrong one.
//
// So the server publishes a value only the right key can produce, and the
// migration compares. The constant is not a secret — the HMAC is.
const TOMBSTONE_CANARY_CONSTANT = 'macrosnap-tombstone-key-check-v1';
const TOMBSTONE_CANARY_COLLECTION = 'meta';
const TOMBSTONE_CANARY_DOC = 'tombstone_key_check';

function tombstoneCanary() {
  return crypto
    .createHmac('sha256', TOMBSTONE_KEY)
    .update(TOMBSTONE_CANARY_CONSTANT)
    .digest('hex');
}

/// Publishes meta/tombstone_key_check so the migration can prove which key is
/// in force. Best effort: a failure is logged, never thrown, and nothing else in
/// the server depends on it.
///
/// It only ever writes when the document is ABSENT. A stored value that does
/// not match is a key change — deliberate or not — and overwriting it would
/// make the canary vouch for whatever key this instance holds, which is the one
/// thing it exists to prevent. So a mismatch is reported loudly and the document
/// is left alone; rotating the key means deleting the document on purpose,
/// after which the next instance publishes the new value.
async function ensureTombstoneCanary() {
  // Only a real key may vouch for itself. A preview deployment or a laptop run
  // that shares production credentials has no TOMBSTONE_SECRET and falls back
  // to the development key; if it published first, production would then see a
  // mismatch and (correctly) refuse to overwrite it — leaving a document that
  // vouches for the wrong key and a migration nothing can verify. So without a
  // real key the canary is not touched at all.
  if (!TOMBSTONE_SECRET) {
    console.log(
      "tombstone canary not published: TOMBSTONE_SECRET is unset (the development key cannot vouch for anything)"
    );
    return false;
  }
  if (!firestore.isEnabled()) return false;
  try {
    const ref = firestore.getDb().collection(TOMBSTONE_CANARY_COLLECTION).doc(TOMBSTONE_CANARY_DOC);
    const doc = await ref.get();
    const current = (doc && doc.exists && (doc.data() || {}).canary) || null;
    const expected = tombstoneCanary();
    if (current === expected) {
      // Logged once per instance so "the canary is in place" is answerable from
      // the logs, not inferred from silence.
      console.log('tombstone canary already matches this key');
      return true;
    }
    if (current) {
      // Two ways to get here, and both must stay visible: TOMBSTONE_SECRET was
      // changed in production, or this code was run locally with production
      // credentials and no secret (so the development key was used). Writing
      // here would erase the only evidence of the correct key.
      console.error(
        'tombstone canary MISMATCH: meta/tombstone_key_check holds a value from ' +
          'a different TOMBSTONE_SECRET. Left unchanged (fingerprints made with ' +
          'this key will not match). If the key was rotated on purpose, delete ' +
          'meta/tombstone_key_check so the next request publishes the new value.'
      );
      return false;
    }
    await ref.set(
      { canary: expected, updated_at: new Date().toISOString() },
      { merge: true }
    );
    // Observable on purpose: "did this deployment publish the canary" is a
    // question worth being able to answer from the logs alone.
    console.log('tombstone canary written to meta/tombstone_key_check');
    return true;
  } catch (e) {
    console.error(
      'tombstone canary write failed:',
      e && e.message ? e.message : e
    );
    return false;
  }
}

// The canary is written during the first request, not at module load. A
// serverless instance is frozen as soon as it answers, and an un-awaited write
// started at import time is exactly the work that gets dropped — the earlier
// version logged nothing either way, which is the worst of both. It is awaited
// once per instance with a short cap, so a slow Firestore costs one request a
// few hundred milliseconds rather than delaying every request.
const CANARY_WAIT_MS = 750;
let tombstoneCanaryPromise = null;

function canaryOnce() {
  if (!tombstoneCanaryPromise) {
    tombstoneCanaryPromise = Promise.race([
      ensureTombstoneCanary(),
      new Promise((resolve) => setTimeout(() => resolve(false), CANARY_WAIT_MS)),
    ]).catch(() => false);
  }
  return tombstoneCanaryPromise;
}

app.use((req, res, next) => {
  canaryOnce().then(() => next(), () => next());
});

function tombstoneFingerprint(identifier) {
  return crypto
    .createHmac('sha256', TOMBSTONE_KEY)
    .update(String(identifier).trim().toLowerCase())
    .digest('hex');
}

// How long a fingerprint still counts against the ₹1 offer. The purge only runs
// when an account is deleted, so a document can outlive its own window by
// weeks; this is what makes the policy's "24 months" describe behaviour rather
// than a cleanup schedule. A missing or unparseable date counts as NOT expired:
// when in doubt, withhold the offer rather than hand out a second one.
function tombstoneExpired(deletedAt) {
  if (!deletedAt) return false;
  const t =
    deletedAt instanceof Date
      ? deletedAt.getTime()
      : Date.parse(typeof deletedAt === 'string' ? deletedAt : String(deletedAt));
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > TOMBSTONE_RETENTION_MONTHS * 30.44 * 24 * 3600 * 1000;
}

async function introUsedFor({ uid, identifier }) {
  // Checked first, and deliberately: every other record of a payment is wiped
  // by /account/delete, so for a deleted account this is the only thing that
  // still remembers the ₹1 was taken.
  if (identifier) {
    const fp = tombstoneFingerprint(identifier);
    if (firestore.isEnabled()) {
      try {
        const d = await firestore
          .getDb()
          .collection('deletedAccounts')
          .doc(fp)
          .get();
        if (d.exists && !tombstoneExpired((d.data() || {}).deleted_at)) {
          return true;
        }
      } catch (_) {}
    }
    if (dbAvailable) {
      const t = await dbq(
        'SELECT deleted_at FROM deleted_accounts WHERE identifier = $1 LIMIT 1',
        [fp]
      );
      if (t.rows[0] && !tombstoneExpired(t.rows[0].deleted_at)) return true;
    }
  }
  if (uid && firestore.isEnabled()) {
    try {
      const doc = await firestore.getDb().collection('users').doc(uid).get();
      if (doc.exists && (doc.data() || {}).intro_used === true) return true;
    } catch (_) {}
  }
  // Payments are only ever written by /payment/verify after a genuine
  // signature check, so any record here means this identity has paid.
  if (identifier && firestore.isEnabled()) {
    try {
      const snap = await firestore
        .getDb()
        .collection('payments')
        .where('identifier', '==', identifier)
        .get();
      if (snap && !snap.empty) return true;
    } catch (_) {}
  }
  if (dbAvailable && identifier) {
    const u = await dbq(
      'SELECT intro_used FROM users WHERE phone = $1 OR email = $1 LIMIT 1',
      [identifier]
    );
    if (u.rows[0] && u.rows[0].intro_used) return true;
    const p = await dbq(
      "SELECT id FROM payments WHERE phone = $1 AND status = 'approved' LIMIT 1",
      [identifier]
    );
    if (p.rows[0]) return true;
  }
  return false;
}

// A referral grants a 30-DAY Pro WINDOW (`pro_until`), not a permanent
// `subscribed` flag — an expired referral therefore drops the user back to
// free instead of giving away Pro forever. True for a parseable future date.
function proUntilActive(iso) {
  if (!iso) return false;
  const t = Date.parse(typeof iso === 'string' ? iso : String(iso));
  return Number.isFinite(t) && t > Date.now();
}

// End of the billing period the customer has ALREADY paid for, as an ISO
// string — null when Razorpay reported no cycle, or the cycle is already over.
//
// `current_end` is the end of the running cycle; `start_at` is the day the
// ₹49 autopay begins, which for a new account is exactly the end of the ₹1
// first month it just paid for. Cancelling a mandate used to switch Pro off on
// the spot and take those paid days with it, so both dates count here.
function paidCycleEnd(sub) {
  if (!sub) return null;
  const future = [sub.current_end, sub.start_at]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0)
    // Razorpay sends unix seconds; a millisecond value (a fixture, or a newer
    // API) would otherwise read as the year 55000.
    .map((v) => (v > 1e12 ? v : v * 1000))
    .filter((ms) => ms > Date.now());
  if (!future.length) return null;
  return new Date(Math.max(...future)).toISOString();
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
    const { weight, height, age, gender, goal, activity, diet } = req.body || {};
    // Presence was the only check here, so a Pro client could post "abc" or a
    // 5 cm height and get a plan for BMI NaN — a paid Gemini call wasted on a
    // nonsensical answer. Bound the numbers before any arithmetic runs.
    const num = (v) => (typeof v === 'number' ? v : Number(v));
    const w = num(weight);
    const h = num(height);
    const a = num(age);
    const validBody =
      Number.isFinite(w) && w >= 20 && w <= 300 &&
      Number.isFinite(h) && h >= 80 && h <= 250 &&
      Number.isFinite(a) && a >= 13 && a <= 120;
    if (!validBody) {
      return res.status(400).json({
        error: 'invalid_body',
        message: 'Weight, height and age must be within a realistic range.',
      });
    }

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

    const sex = gender === 'female' ? 'female' : 'male';
    const bmr = sex === 'male'
      ? 10 * w + 6.25 * h - 5 * a + 5
      : 10 * w + 6.25 * h - 5 * a - 161;
    const multipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, veryActive: 1.9 };
    const activityKey = Object.prototype.hasOwnProperty.call(multipliers, activity) ? activity : 'sedentary';
    const tdee = bmr * multipliers[activityKey];
    const bmi = w / ((h / 100) * (h / 100));

    // The same 18.5 floor the app enforces with a dialog. The client is not the
    // authority: a crafted request could otherwise buy a deficit plan for an
    // underweight user.
    const goalKey = goal === 'gainMuscle' || goal === 'loseWeight' ? goal : 'maintain';
    // Compare the PRINTED BMI (one decimal), exactly like the app: 18.46 shows
    // as "18.5" and a plan built from the raw value would refuse a goal the
    // app itself allows.
    const shownBmi = Math.round(bmi * 10) / 10;
    const safeGoal = goalKey === 'loseWeight' && shownBmi < 18.5 ? 'maintain' : goalKey;

    // Mirrors lib/models/diet_profile.dart, because the app prints its OWN
    // targets next to this plan: the plan's meals have to add up to the numbers
    // on that screen. The old figures (2.0 g/kg on a loss goal, and a plain
    // TDEE − 500 with no floor) disagreed with it on both counts — the header
    // said 1.8 g/kg and 1,200 kcal while the meals were built for a lower
    // protein target and, for a small sedentary user, a sub-1,200 deficit.
    const SAFE_MIN_KCAL = sex === 'female' ? 1200 : 1500;
    const proteinPerKg = safeGoal === 'gainMuscle' ? 2.2 : safeGoal === 'loseWeight' ? 1.8 : 1.6;
    const proteinTarget = Math.min(w * proteinPerKg, 180);

    const rawCalTarget =
      safeGoal === 'loseWeight' ? tdee - 500 : safeGoal === 'gainMuscle' ? tdee + 300 : tdee;
    const calTarget = safeGoal === 'loseWeight'
      ? Math.max(rawCalTarget, Math.round(bmr), SAFE_MIN_KCAL)
      : rawCalTarget;
    const fatTarget = calTarget * 0.25 / 9;
    // Protein + fat can overshoot a low calorie target; a negative carb figure
    // would go straight into the prompt and the app's numbers row.
    const carbTarget = Math.max(0, (calTarget - (proteinTarget * 4) - (fatTarget * 9)) / 4);

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
User: ${sex}, ${a} yrs, ${w}kg, ${h}cm, BMI ${bmi.toFixed(1)}.
Goal: ${safeGoal}, Activity: ${activityKey}.
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
    // Bounded: the app caps a nickname at 15 characters, but this is a public
    // endpoint and the value is mirrored into userIndex for every future
    // restore, so an unbounded string (up to the 1 MB body limit) would be
    // stored and replayed onto every device.
    const safeName =
      typeof name === 'string' ? name.trim().slice(0, 40) : '';
    const id = identityOf(req);
    const identifier = id.identifier;
    const email = id.email;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    if (email && safeName) {
      await dbq(
        'INSERT INTO users (phone, email, name) VALUES ($1, $2, $3) ON CONFLICT (phone) DO UPDATE SET email = $2, name = $3',
        [identifier, email, safeName]
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
          name: safeName,
        }, { merge: true });
        await firestore.set('userIndex/' + identifier, { uid: fUid, name: safeName }, { merge: true });
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

// Saves a renamed profile to the ACCOUNT.
//
// GET /user/profile above is what a fresh install calls to restore the name,
// and it reads `userIndex` — which only /register ever wrote. A rename never
// reached it, so uninstalling and signing in again fetched the registration
// name and visibly undid the rename. This writes every copy the restore path
// and the boards read, so the name follows the account, not the device.
app.post('/user/profile', requireAuth, rateLimit('/user/profile'), async (req, res) => {
  try {
    const raw = (req.body || {}).name;
    const safeName = typeof raw === 'string' ? raw.trim().slice(0, 40) : '';
    if (!safeName) return res.status(400).json({ error: 'name_required' });

    const id = identityOf(req);
    const identifier = id.identifier;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });

    // Postgres is the non-Firestore deployment's store; best-effort here so a
    // DB-less host still saves the Firestore copies below.
    try {
      await dbq(
        'INSERT INTO users (phone, name) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET name = $2',
        [identifier, safeName]
      );
    } catch (e) {
      console.warn('name save (postgres) failed:', e && e.message);
    }

    const fUid = await firestore.resolveUid(identifier);
    if (fUid && firestore.isEnabled()) {
      await firestore.set(
        'userIndex/' + identifier,
        { uid: fUid, name: safeName },
        { merge: true }
      );
      await firestore.set('users/' + fUid, { name: safeName }, { merge: true });
      // A member's leaderboard row carries its own copy of the name. Update it
      // in place, but never create meta for an account that never joined.
      const meta = await firestore.get(LEADERBOARD_META + '/' + fUid);
      if (meta) {
        await firestore.set(
          LEADERBOARD_META + '/' + fUid,
          { name: safeName, updatedAt: new Date() },
          { merge: true }
        );
      }
    }
    res.json({ name: safeName });
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

app.post('/referral/apply', requireAuth, rateLimit('/referral/apply'), async (req, res) => {
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
        // ONE transaction: the old code deleted every meal and then inserted
        // them one by one on autocommit, so a failure midway (a bad date, a
        // dropped connection) left the user's history truncated with no way
        // back. Either the whole sync lands or nothing changes.
        await client.query('BEGIN');
        await client.query('DELETE FROM meals WHERE phone = $1', [phone]);
        for (const meal of mealList) {
          if (!meal || typeof meal !== 'object') continue;
          await client.query(
            `INSERT INTO meals (id, phone, date, name, category, calories, protein, carbs, fats, fiber, serving)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
            [meal.id, phone, meal.date, meal.name, meal.category, meal.calories, meal.protein, meal.carbs, meal.fats, meal.fiber, meal.serving]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
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
            if (!m || typeof m !== 'object' || !m.id) continue;
            // The doc id is namespaced by uid. This write goes through the
            // Admin SDK, which bypasses firestore.rules: a client that sent
            // another user's meal id would otherwise overwrite a stranger's
            // meal document, because `uid` in the body is what the rule would
            // have checked and there is no rule here to check it.
            batch.set(col.doc(fUid + ':' + m.id), {
              uid: fUid,
              mealId: m.id,
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

// ─── Meal photo cloud backup (Pro, opt-in) ─────────────────────────────────
// The app (lib/services/meal_photo_sync.dart) uploads, restores and deletes a
// meal's photo through THESE routes. They were missing from this backend, so
// the whole feature silently did nothing: every upload answered 404 and the app
// treats a failed upload as best-effort, so nobody was told the backup was
// never happening. Photos live in `mealPhotos/{uid}:{mealId}` — a Firestore
// document written only by the Admin SDK, which is also where the Pro gate
// lives (firestore.rules denies clients the collection outright).
const PHOTO_DOC_MAX_BYTES = 700 * 1024; // Firestore caps a document at 1 MiB
const MEAL_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;

function photoDocId(uid, mealId) {
  return uid + ':' + mealId;
}

// True only when the meal document is this account's. /meals/sync keys meal
// documents `{uid}:{mealId}`, so the direct get covers today's writes; the
// query covers documents written by other paths. The URL's meal id is never
// trusted on its own.
async function ownedMeal(uid, mealId) {
  const db = firestore.getDb();
  try {
    const doc = await db.collection('meals').doc(photoDocId(uid, mealId)).get();
    if (doc.exists) return true;
  } catch (_) {}
  try {
    const snap = await db.collection('meals').where('uid', '==', uid).limit(400).get();
    return snap.docs.some((d) => {
      const data = d.data() || {};
      return data.uid === uid && (data.mealId === mealId || data.id === mealId);
    });
  } catch (_) {
    return false;
  }
}

app.post(
  '/meals/:mealId/photo',
  requireAuth,
  rateLimit('/meals/photo'),
  upload.single('image'),
  async (req, res) => {
    try {
      const id = identityOf(req);
      const mealId = String(req.params.mealId || '');
      if (!id.uid) return res.status(400).json({ error: 'identity_required' });
      if (!MEAL_ID_RE.test(mealId)) {
        return res.status(400).json({ error: 'bad_meal_id' });
      }
      if (!firestore.isEnabled()) {
        return res.status(503).json({ error: 'photo_backup_unavailable' });
      }
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ error: 'No image uploaded' });
      }
      // Pro gate: the Settings toggle is cosmetic on its own, so the server
      // decides. A lapsed Pro account keeps the copies it already has and can
      // still delete them — it just cannot store new ones.
      const ent = await entitlementsFor(id);
      if (!ent.subscribed) return res.status(403).json({ error: 'pro_required' });
      if (!(await ownedMeal(id.uid, mealId))) {
        return res.status(404).json({ error: 'meal_not_found' });
      }
      // Re-encode instead of storing what arrived: a camera original would not
      // fit in a Firestore document, and EXIF (GPS included) has no business in
      // a backup.
      let jpeg;
      try {
        jpeg = await sharp(req.file.buffer)
          .rotate()
          .resize({
            width: 1280,
            height: 1280,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 72, mozjpeg: true })
          .toBuffer();
      } catch (_) {
        return res.status(400).json({ error: 'not_an_image' });
      }
      if (jpeg.length > PHOTO_DOC_MAX_BYTES) {
        return res.status(413).json({ error: 'image_too_large' });
      }
      const saved = await firestore.set('mealPhotos/' + photoDocId(id.uid, mealId), {
        uid: id.uid,
        mealId: mealId,
        contentType: 'image/jpeg',
        bytes: jpeg.length,
        data: jpeg.toString('base64'),
        updatedAt: new Date(),
      });
      if (!saved) return res.status(503).json({ error: 'photo_not_saved' });
      res.json({ ok: true, bytes: jpeg.length });
    } catch (e) {
      return sendFailure(req, res, e);
    }
  }
);

app.get('/meals/:mealId/photo', requireAuth, async (req, res) => {
  try {
    const id = identityOf(req);
    const mealId = String(req.params.mealId || '');
    if (!id.uid) return res.status(400).json({ error: 'identity_required' });
    if (!MEAL_ID_RE.test(mealId)) {
      return res.status(400).json({ error: 'bad_meal_id' });
    }
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'photo_backup_unavailable' });
    }
    const doc = await firestore
      .getDb()
      .collection('mealPhotos')
      .doc(photoDocId(id.uid, mealId))
      .get();
    const data = doc.exists ? doc.data() || {} : null;
    // Someone else's photo answers 404, same as a missing one: the owner check
    // must not tell a stranger which meal ids have backups.
    if (!data || data.uid !== id.uid || typeof data.data !== 'string') {
      return res.status(404).json({ error: 'not_found' });
    }
    res.json({
      data: data.data,
      contentType: data.contentType || 'image/jpeg',
      bytes: typeof data.bytes === 'number' ? data.bytes : null,
    });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.delete('/meals/:mealId/photo', requireAuth, async (req, res) => {
  try {
    const id = identityOf(req);
    const mealId = String(req.params.mealId || '');
    if (!id.uid) return res.status(400).json({ error: 'identity_required' });
    if (!MEAL_ID_RE.test(mealId)) {
      return res.status(400).json({ error: 'bad_meal_id' });
    }
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'photo_backup_unavailable' });
    }
    // Deleting rides on ownership only, never on the Pro flag: a lapsed
    // account must still be able to remove the backups it already has.
    const ref = firestore
      .getDb()
      .collection('mealPhotos')
      .doc(photoDocId(id.uid, mealId));
    const doc = await ref.get();
    if (doc.exists && (doc.data() || {}).uid === id.uid) {
      try {
        await ref.delete();
      } catch (e) {
        console.error('mealPhotos delete failed:', e && e.message ? e.message : e);
        return res.status(503).json({ error: 'photo_not_deleted' });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// ─── Leaderboard: server-scored weekly boards ───────────────────────────────
// The app posts its raw activity once per sync; the SERVER scores it with
// `leaderboard.js` and writes the board entries through the Admin SDK (which
// bypasses firestore.rules, so clients cannot write points at all).
//
// What the client sends (field names taken from the shipped 1.5.22 build):
//   { name, stateKey, districtKey, weekId?, days: [
//       { dateKey|date, steps, stepGoal, weighIn, meals?, habits?, water?,
//         waterGoal? } ] }
// Meals, habits and water are re-read from Firestore here and only fall back to
// the client's numbers when that read fails, so a modified app cannot inflate
// them. Steps and weigh-ins exist only on the phone, so they are asserted — and
// bounded (`stepCeiling` refuses "20,000 steps at 00:30").
const MAX_MOVES_PER_WEEK = 3;
const LEADERBOARD_META = 'leaderboardMeta';
// The free plan's daily step ceiling. Must match StepLimit.freeDaily in the app.
const FREE_STEP_CAP = 5000;

function dayKeyOf(value) {
  if (typeof value === 'string') {
    const direct = value.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
    return lb.mealDayKey({ date: value });
  }
  return lb.mealDayKey({ date: value });
}

// Meals for this account, grouped by IST day. `ok:false` means the read failed
// (the caller then falls back to the client's counts rather than scoring zero).
async function readMealDays(db, uid) {
  const byDay = new Map();
  try {
    const snap = await db.collection('meals').where('uid', '==', uid).get();
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (data.uid !== uid) continue;
      const key = lb.mealDayKey(data);
      if (!key) continue;
      const entry = byDay.get(key) || { count: 0, calories: 0 };
      entry.count += 1;
      entry.calories += Math.max(0, Number(data.calories) || 0);
      byDay.set(key, entry);
    }
    return { ok: true, byDay };
  } catch (e) {
    console.error(
      '[leaderboard/sync] meal read failed:',
      e && e.message ? e.message : e
    );
    return { ok: false, byDay };
  }
}

async function readHabitDay(db, uid) {
  try {
    const doc = await db.collection('habitData').doc(uid).get();
    return { ok: true, data: (doc.exists ? doc.data() : null) || null };
  } catch (e) {
    console.error(
      '[leaderboard/sync] habit read failed:',
      e && e.message ? e.message : e
    );
    return { ok: false, data: null };
  }
}

async function readDietProfile(db, uid) {
  try {
    const doc = await db.collection('dietProfiles').doc(uid).get();
    return (doc.exists ? doc.data() : null) || null;
  } catch (_) {
    return null;
  }
}

// Weigh-ins, from the weightLog the app mirrors. Both shapes are accepted: a
// `days` subcollection and a `days` map on the parent document.
async function readWeighInDays(db, uid) {
  const days = new Set();
  try {
    const snap = await db
      .collection('weightLog')
      .doc(uid)
      .collection('days')
      .get();
    for (const doc of snap.docs) {
      const key = doc.id.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) days.add(key);
    }
  } catch (_) {}
  if (days.size === 0) {
    try {
      const doc = await db.collection('weightLog').doc(uid).get();
      const map = doc.exists ? (doc.data() || {}).days : null;
      if (map && typeof map === 'object') {
        for (const key of Object.keys(map)) {
          const day = key.slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.add(day);
        }
      }
    } catch (_) {}
  }
  return days;
}

// Steps are the one activity the server has to REMEMBER on its own: the phone's
// own step sensor counts them, and no other stored document knows them. Keeping
// the day totals here is what makes yesterday's movement points survive a
// reinstall, a new phone, or a day the app was never opened — the board is
// recomputed from this log plus Firestore (meals, habits, water, weigh-ins).
const STEP_LOG = 'stepLog';
const STEP_LOG_DAYS = 60;

function normalizeDayMap(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, raw] of Object.entries(value)) {
    const day = String(key).slice(0, 10);
    const steps = Number(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!Number.isFinite(steps) || steps <= 0) continue;
    out[day] = Math.min(Math.max(0, Math.trunc(steps)), 200000);
  }
  return out;
}

async function readStepDays(db, uid) {
  try {
    const doc = await db.collection(STEP_LOG).doc(uid).get();
    return normalizeDayMap(doc.exists ? (doc.data() || {}).days : null);
  } catch (e) {
    console.error(
      '[leaderboard] step log read failed:',
      e && e.message ? e.message : e
    );
    return {};
  }
}

// The whole map is rewritten (not merged field by field) so old days are
// pruned in the same write; `firestore.set` does not merge.
async function writeStepDays(db, uid, days) {
  const kept = {};
  for (const key of Object.keys(days).sort().slice(-STEP_LOG_DAYS)) {
    kept[key] = days[key];
  }
  const ok = await firestore.set(STEP_LOG + '/' + uid, {
    days: kept,
    updatedAt: new Date(),
  });
  if (!ok) console.error('[leaderboard] step log write failed for', uid);
  return ok;
}

// ── Account-scoped step history ──────────────────────────────────────────
//
// Steps used to reach the server only through /leaderboard/sync, which rejects
// an account that has not joined a board (`area_required`). So a non-member's
// walking lived on one phone only and a reinstall destroyed it. These two
// routes store the per-day totals against the verified account instead, which
// is what makes "delete and reinstall, sign in, steps are back" true — with or
// without Health Connect and with or without a leaderboard entry.
app.post('/steps/sync', requireAuth, rateLimit('/steps/sync'), async (req, res) => {
  try {
    const uid = identityOf(req).uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'steps_unavailable' });
    }
    const db = firestore.getDb();
    const incoming = normalizeDayMap((req.body || {}).days);
    const stored = await readStepDays(db, uid);
    const merged = { ...stored };
    let changed = false;
    for (const [day, steps] of Object.entries(incoming)) {
      // A day only grows. A device that has been offline for a week must not
      // overwrite a fuller history another device already uploaded.
      if (steps > (merged[day] || 0)) {
        merged[day] = steps;
        changed = true;
      }
    }
    if (changed) await writeStepDays(db, uid, merged);
    res.json({ ok: true, stepDays: merged });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.get('/steps/me', requireAuth, async (req, res) => {
  try {
    const uid = identityOf(req).uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'steps_unavailable' });
    }
    const stepDays = await readStepDays(firestore.getDb(), uid);
    res.json({ stepDays });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

function habitsCompletedOn(habitData, key) {
  const list =
    habitData && Array.isArray(habitData.habits) ? habitData.habits : [];
  let done = 0;
  for (const habit of list) {
    if (!habit || typeof habit !== 'object' || habit.paused === true) continue;
    const dates = Array.isArray(habit.completedDates)
      ? habit.completedDates
      : [];
    if (dates.some((d) => typeof d === 'string' && d.slice(0, 10) === key)) {
      done += 1;
    }
  }
  return done;
}

function waterOn(habitData, key) {
  const log =
    habitData && habitData.waterLog && typeof habitData.waterLog === 'object'
      ? habitData.waterLog
      : {};
  const value = Number(log[key]);
  return Number.isFinite(value) ? value : 0;
}

// ─── Week scoring, shared by the public board and friends leagues ────────
// The facts and the table must be the same on both boards: a private league
// is a smaller audience, never an easier set of rules. Extracted verbatim
// from /leaderboard/sync so there is exactly one scoring path.
async function scoreWeekFacts(db, uid, body, week, today, stepCap = null) {
  // ── Per-day client facts ────────────────────────────────────────────
  const clientDays = new Map();
  const rawDays = Array.isArray(body.days)
    ? body.days
    : Array.isArray(body.facts)
      ? body.facts
      : Array.isArray(body.entries)
        ? body.entries
        : [];
  for (const day of rawDays) {
    if (!day || typeof day !== 'object') continue;
    const key = dayKeyOf(day.dateKey || day.date || day.key || day.day);
    if (key) clientDays.set(key, day);
  }
  // A client that posts a single flat day still gets its steps counted.
  if (clientDays.size === 0 && typeof body.steps !== 'undefined') {
    clientDays.set(today, body);
  }

  // ── Server-side truth ───────────────────────────────────────────────
  const [meals, habits, profile, weighIns, storedSteps] = await Promise.all([
    readMealDays(db, uid),
    readHabitDay(db, uid),
    readDietProfile(db, uid),
    readWeighInDays(db, uid),
    readStepDays(db, uid),
  ]);
  const stepLog = { ...storedSteps };
  const calorieTarget = lb.dietTargetCalories(profile);
  const habitData = habits.ok ? habits.data : null;
  const waterGoal = lb.clampInt(habitData && habitData.waterGoal, 0, 5000);

  const dayPoints = [];
  let weekPoints = 0;
  for (const key of week.dates) {
    if (key > today) {
      dayPoints.push({ dateKey: key, points: 0, buckets: {} });
      continue;
    }
    const client = clientDays.get(key) || {};
    const mealsForDay = meals.ok
      ? meals.byDay.get(key) || { count: 0, calories: 0 }
      : { count: 0, calories: 0 };
    const mealCount = meals.ok
      ? mealsForDay.count
      : lb.clampInt(client.meals, 0, 3);
    const completedHabits = habits.ok
      ? habitsCompletedOn(habitData, key)
      : lb.clampInt(client.habits, 0, 3);
    const glasses = habits.ok
      ? waterOn(habitData, key)
      : lb.clampInt(client.water, 0, 100);
    const stepGoal = lb.normalizeStepGoal(
      client.stepGoal !== undefined
        ? client.stepGoal
        : client.goal !== undefined
          ? client.goal
          : body.stepGoal
    );
    void stepGoal; // Scoring no longer depends on a chosen target.
    const ceiling = key === today ? lb.stepCeiling() : 200000;
    const claimed = lb.clampInt(
      client.steps !== undefined ? client.steps : client.stepCount,
      0,
      200000
    );
    // Keep the HIGHEST figure seen for the day. The sensor only counts up,
    // so a later sync reporting fewer steps (a reboot, a reinstall, a
    // client that started late) must not walk yesterday's points back.
    const rawSteps = Math.min(
      Math.max(claimed, stepLog[key] || 0),
      ceiling
    );
    // The RAW total is what the account keeps: a free user who upgrades later
    // must see the steps already walked, not a history rewritten to 5,000.
    if (rawSteps > 0) stepLog[key] = rawSteps;
    // What this week may be SCORED on. A free account is capped at 5,000 steps
    // a day; the cap is applied to the score, never to the stored history.
    const steps = stepCap == null ? rawSteps : Math.min(rawSteps, stepCap);
    const weighedIn =
      weighIns.has(key) ||
      client.weighIn === true ||
      client.weighedIn === true;
    const calorieGoalMet =
      calorieTarget > 0 && mealsForDay.calories >= calorieTarget;

    const scored = lb.scoreDay({
      mealCount,
      completedHabits,
      waterGlasses: glasses,
      waterGoal: lb.clampInt(client.waterGoal, 0, 5000) || waterGoal,
      steps,
      stepGoal,
      weighedIn,
      calorieGoalMet,
    });
    weekPoints += scored.points;
    dayPoints.push({
      dateKey: key,
      points: scored.points,
      buckets: scored.buckets,
    });
  }
  weekPoints = Math.min(weekPoints, lb.WEEK_MAX);
  return { dayPoints, weekPoints, stepLog };
}

app.post(
  '/leaderboard/sync',
  requireAuth,
  rateLimit('/leaderboard/sync'),
  async (req, res) => {
    try {
      const id = identityOf(req);
      const uid = id.uid;
      if (!uid) return res.status(400).json({ error: 'identity_required' });
      if (!firestore.isEnabled()) {
        return res.status(503).json({ error: 'leaderboard_unavailable' });
      }
      const db = firestore.getDb();
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      // Field names as seen in the shipped 1.5.22 build, with the obvious
      // aliases tolerated so an app build that nests them still syncs.
      const area = body.location || body.area || body.profile || {};
      const state = lb.stateKey(
        body.stateKey || body.state || area.stateKey || area.state
      );
      const district = lb.slug(
        body.districtKey || body.district || area.districtKey || area.district || ''
      );
      if (!state || !district) {
        return res.status(400).json({ error: 'area_required' });
      }

      const week = lb.isoWeek();
      const today = lb.todayKey();

      // ── Where this account competes, with the 3-moves-a-week limit ──────
      let meta = null;
      try {
        const doc = await db.collection(LEADERBOARD_META).doc(uid).get();
        meta = (doc.exists ? doc.data() : null) || null;
      } catch (_) {}
      let moves = Number(meta && meta.week === week.week ? meta.moves : 0) || 0;
      let finalState = state;
      let finalDistrict = district;
      let locationLocked = false;
      const sameArea =
        !!meta && meta.stateKey === state && meta.districtKey === district;
      if (
        meta &&
        meta.week === week.week &&
        !sameArea &&
        moves >= MAX_MOVES_PER_WEEK
      ) {
        // Out of moves: keep them on the board they already compete in.
        finalState = lb.stateKey(meta.stateKey) || state;
        finalDistrict = lb.slug(meta.districtKey || '') || district;
        locationLocked = true;
      } else if (!sameArea) {
        moves = Math.min(moves + 1, MAX_MOVES_PER_WEEK);
      }

      const scopes = lb.boardsFor(finalState, finalDistrict);

      // Movement is the one bucket no stored document proves, so the free
      // tier's step ceiling is enforced server-side too: a modified client
      // must not be able to buy the whole 100 movement points.
      const pro = await isProAccount(id);
      const { dayPoints, weekPoints, stepLog } = await scoreWeekFacts(
        db,
        uid,
        body,
        week,
        today,
        pro ? null : FREE_STEP_CAP
      );

      // ── Display name, unique on the board it lands on ──────────────────
      const claimedName =
        typeof body.name === 'string' && body.name.trim()
          ? body.name
          : typeof body.displayName === 'string' && body.displayName.trim()
            ? body.displayName
            : (meta && meta.name) || '';
      let name = lb.publicName(claimedName);
      // The picture rides with the row: the boards are read straight from
      // these documents by every other phone, so the avatar has to be in them.
      const avatar = lb.publicAvatar(body.avatar);
      try {
        const snap = await db
          .collection('leaderboard')
          .doc(week.week)
          .collection('scopes')
          .doc(scopes[2])
          .collection('entries')
          .get();
        const taken = snap.docs
          .filter((d) => d.id !== uid)
          .map((d) => (d.data() || {}).name)
          .filter((n) => typeof n === 'string');
        name = lb.uniqueName(name, uid, taken);
      } catch (_) {}

      // Persist the merged step history BEFORE the board write: a board that
      // survives without its steps would score zero tomorrow.
      await writeStepDays(db, uid, stepLog);

      // ── Write the three boards ─────────────────────────────────────────
      const batch = db.batch();
      // Marker documents: a scope (or week) that only holds subcollections is
      // invisible to `.get()`, and both the stale-scope cleanup below and the
      // cleanup cron enumerate these collections.
      const weekRef = db.collection('leaderboard').doc(week.week);
      batch.set(weekRef, {
        week: week.week,
        startDate: week.dates[0],
        updatedAt: new Date(),
      });
      for (const scope of scopes) {
        batch.set(
          weekRef.collection('scopes').doc(scope),
          { scope, week: week.week, updatedAt: new Date() },
        );
        batch.set(
          db
            .collection('leaderboard')
            .doc(week.week)
            .collection('scopes')
            .doc(scope)
            .collection('entries')
            .doc(uid),
          {
            uid,
            name,
            avatar,
            points: weekPoints,
            week: week.week,
            scope,
            stateKey: finalState,
            districtKey: finalDistrict,
            updatedAt: new Date(),
          }
        );
      }
      // Leaving a district must not leave a row behind on the old board.
      try {
        const scopesSnap = await db
          .collection('leaderboard')
          .doc(week.week)
          .collection('scopes')
          .get();
        for (const doc of scopesSnap.docs) {
          if (scopes.includes(doc.id)) continue;
          batch.delete(
            db
              .collection('leaderboard')
              .doc(week.week)
              .collection('scopes')
              .doc(doc.id)
              .collection('entries')
              .doc(uid)
          );
        }
      } catch (_) {}
      await batch.commit();

      const metaSet = await firestore.set(LEADERBOARD_META + '/' + uid, {
        week: week.week,
        stateKey: finalState,
        districtKey: finalDistrict,
        moves,
        name,
        avatar,
        joined: true,
        updatedAt: new Date(),
      });
      if (!metaSet) {
        console.error('[leaderboard/sync] meta write failed for', uid);
      }

      res.json({
        ok: true,
        status: 'ok',
        week: week.week,
        weekId: week.week,
        scopes,
        points: weekPoints,
        todayPoints: dayPoints
          .filter((d) => d.dateKey === today)
          .reduce((sum, d) => sum + d.points, 0),
        dayPoints,
        stepDays: stepLog,
        name,
        stateKey: finalState,
        districtKey: finalDistrict,
        locationLocked,
      });
    } catch (e) {
      return sendFailure(req, res, e);
    }
  }
);

// ─── Restore this account's leaderboard state ──────────────────────────────
// Join state, area and step history used to live ONLY in the phone's
// SharedPreferences, so uninstalling the app (or signing in on a new phone)
// lost all three: the page asked a joined user to join again, and yesterday's
// movement points vanished because the step totals that produced them were
// gone. This route is the restore path for a fresh install.
app.get('/leaderboard/me', requireAuth, async (req, res) => {
  try {
    const id = identityOf(req);
    const uid = id.uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'leaderboard_unavailable' });
    }
    const db = firestore.getDb();
    const week = lb.isoWeek();
    const today = lb.todayKey();

    const meta = await firestore.get(LEADERBOARD_META + '/' + uid);
    const name = meta && typeof meta.name === 'string' ? meta.name : '';
    const state = meta ? lb.stateKey(meta.stateKey) : null;
    const district = meta ? lb.slug(meta.districtKey || '') : '';

    let joined = !!(meta && meta.joined === true);
    // Meta documents written by the OLD sync had no `joined` field, and that
    // sync only ever wrote one for an account that had joined. Absence of the
    // flag is therefore a join, not a leave (a leave deleted the document).
    if (meta && typeof meta.joined === 'undefined' && state && district) {
      joined = true;
    }
    if (!joined && state && district) {
      // Legacy rows (written before `joined` existed) still count as joined
      // while this week's entry is on the India board.
      try {
        const entry = await db
          .collection('leaderboard')
          .doc(week.week)
          .collection('scopes')
          .doc('india')
          .collection('entries')
          .doc(uid)
          .get();
        joined = entry.exists;
      } catch (_) {}
    }

    res.json({
      ok: true,
      joined,
      name,
      stateKey: state,
      districtKey: district,
      week: week.week,
      weekId: week.week,
      today,
      stepDays: await readStepDays(db, uid),
    });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.post('/leaderboard/leave', requireAuth, async (req, res) => {
  try {
    const id = identityOf(req);
    const uid = id.uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'leaderboard_unavailable' });
    }
    const db = firestore.getDb();
    const week = lb.isoWeek().week;
    try {
      const scopesSnap = await db
        .collection('leaderboard')
        .doc(week)
        .collection('scopes')
        .get();
      for (const doc of scopesSnap.docs) {
        await firestore.del(
          'leaderboard/' + week + '/scopes/' + doc.id + '/entries/' + uid
        );
      }
    } catch (e) {
      console.error(
        '[leaderboard/leave] board read failed:',
        e && e.message ? e.message : e
      );
      return res.status(503).json({ error: 'leaderboard_unavailable' });
    }
    // Keep the meta document, marked as left. Deleting it (what this used to
    // do) threw away the only server-side memory of the join, so a reinstall
    // could not tell "never joined" from "joined and left" and asked the user
    // to join again with an account that was already on the board.
    const meta = await firestore.get(LEADERBOARD_META + '/' + uid);
    await firestore.set(LEADERBOARD_META + '/' + uid, {
      ...(meta || {}),
      joined: false,
      week,
      updatedAt: new Date(),
    });
    res.json({ ok: true, joined: false });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// ─── Private friends leagues (Pro) ─────────────────────────────────────────
//
// A small, invite-only weekly board for people who already know each other.
// The score is NOT a separate number: the same `scoreWeekFacts()` pass that
// ranks the public board writes these rows, so a private league can never pay
// more (or less) than the public one — a "friends" board is a smaller
// audience, not an easier set of rules.
//
// Collections:
//   friendLeagues/{id}                              league meta (name, code, owner)
//   friendLeagues/{id}/members/{uid}                membership + display name
//   friendLeagues/{id}/weeks/{week}/entries/{uid}   the scored row
//   friendCodes/{CODE}                              code -> league id (unique)
//   friendIndex/{uid}                               the leagues this account is in
//
// Pro gate: creating and joining are the paid acts. An account that is already
// a member keeps reading and scoring after a lapse, because one expired card
// must not silently drop a person off a league their friends still see.
const FRIEND_LEAGUE = 'friendLeagues';
const FRIEND_CODES = 'friendCodes';
const FRIEND_INDEX = 'friendIndex';
const FRIEND_MAX_LEAGUES = 5;
const FRIEND_MAX_MEMBERS = 50;
const FRIEND_NAME_MAX = 30;
const FRIEND_CODE_LENGTH = 6;
// No 0/O/1/I: a code is read aloud and typed by hand.
const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function friendCode() {
  let out = '';
  for (let i = 0; i < FRIEND_CODE_LENGTH; i++) {
    out += FRIEND_CODE_ALPHABET[crypto.randomInt(FRIEND_CODE_ALPHABET.length)];
  }
  return out;
}

function normalizeFriendCode(value) {
  if (typeof value !== 'string') return null;
  const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length === FRIEND_CODE_LENGTH ? clean : null;
}

// The league name is the only free text a user writes here. Clamped and
// stripped the same way a board name is, with a default that cannot impersonate
// the app.
function cleanLeagueName(value) {
  const clean = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'Friends league';
  return clean.length > FRIEND_NAME_MAX ? clean.slice(0, FRIEND_NAME_MAX) : clean;
}

// Pro, from the verified identity: the admin claim, or users/{uid} saying the
// account paid (or is inside a referral window). Same truth the paywall uses.
async function isProAccount(id) {
  if (!id || !id.uid) return false;
  if (isAdminUser(id)) return true;
  const ent = await entitlementsFor({
    uid: id.uid,
    identifier: id.identifier,
    emailVerified: id.emailVerified,
    isAdmin: id.isAdmin,
  });
  return ent.subscribed === true;
}

// Days of Pro granted to a free account that joins through an invite, or 0.
//
// An invite is the highest-intent moment a free account will ever have, and
// the old answer was a paywall. Off unless INVITE_TRIAL_DAYS is set: this is a
// pricing decision, so the code ships inert and the owner turns it on.
const INVITE_TRIAL_DAYS = Math.max(0, Number(process.env.INVITE_TRIAL_DAYS) || 0);

async function grantInviteTrial(uid) {
  if (!(INVITE_TRIAL_DAYS > 0) || !uid || !firestore.isEnabled()) return 0;
  try {
    const ref = firestore.getDb().collection('users').doc(uid);
    const doc = await ref.get();
    const d = (doc.exists ? doc.data() : {}) || {};
    // One window per ACCOUNT, so reinstalling does not farm trials.
    if (d.invite_trial_used === true) return 0;
    const until = new Date(Date.now() + INVITE_TRIAL_DAYS * 86400000);
    await ref.set(
      { pro_until: until, invite_trial_used: true },
      { merge: true }
    );
    return INVITE_TRIAL_DAYS;
  } catch (e) {
    console.error('[friends] invite trial failed:', e && e.message);
    return 0;
  }
}

// Members who arrived through an invite, newest first — what the inviter sees
// as "Riya joined with your invite". Capped and name-only: the league board
// already shows points, this is the social half.
async function friendInvites(leagueId, uid) {
  try {
    const members = await friendMembers(leagueId);
    return members
      .filter((m) => m.via === 'invite' && m.id !== uid)
      .sort((a, b) => joinedMs(b.joinedAt) - joinedMs(a.joinedAt))
      .slice(0, 5)
      .map((m) => ({
        name:
          typeof m.name === 'string' && m.name.trim()
            ? m.name.trim()
            : 'MacroSnap user',
        at: joinedMs(m.joinedAt),
      }));
  } catch (_) {
    return [];
  }
}

async function friendIndexIds(uid) {
  const doc = await firestore.get(FRIEND_INDEX + '/' + uid);
  const ids = doc && Array.isArray(doc.ids)
    ? doc.ids.filter((v) => typeof v === 'string')
    : [];
  return [...new Set(ids)].slice(0, 20);
}

async function saveFriendIndexIds(uid, ids) {
  return firestore.set(FRIEND_INDEX + '/' + uid, {
    ids: [...new Set(ids)].slice(0, 20),
    updatedAt: new Date(),
  });
}

async function friendMembers(leagueId) {
  const snap = await firestore
    .getDb()
    .collection(FRIEND_LEAGUE)
    .doc(leagueId)
    .collection('members')
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
}

function joinedMs(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// The league's board for this week. Sorted here rather than by a Firestore
// orderBy: a league holds at most 50 rows, and this keeps the collection free
// of an index to deploy.
async function friendRows(leagueId, week, uid) {
  const snap = await firestore
    .getDb()
    .collection(FRIEND_LEAGUE)
    .doc(leagueId)
    .collection('weeks')
    .doc(week)
    .collection('entries')
    .get();
  const rows = snap.docs.map((d) => {
    const data = d.data() || {};
    return {
      uid: d.id,
      name: typeof data.name === 'string' && data.name.trim()
        ? data.name
        : 'MacroSnap user',
      avatar: lb.publicAvatar(data.avatar),
      points: Number(data.points) || 0,
    };
  });
  rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  const mine = rows.findIndex((r) => r.uid === uid);
  return {
    rows: rows.map((r) => ({ ...r, isMe: r.uid === uid })),
    rank: mine >= 0 ? mine + 1 : null,
    points: mine >= 0 ? rows[mine].points : 0,
  };
}

async function friendLeagueView(leagueId, league, week, uid) {
  const board = await friendRows(leagueId, week, uid);
  return {
    id: leagueId,
    name: league.name || 'Friends league',
    code: league.code || '',
    ownerUid: league.ownerUid || '',
    isOwner: league.ownerUid === uid,
    memberCount: Number(league.memberCount) || board.rows.length,
    week,
    points: board.points,
    rank: board.rank,
    rows: board.rows,
    invites: await friendInvites(leagueId, uid),
  };
}

async function listFriendLeagues(uid) {
  const ids = await friendIndexIds(uid);
  const week = lb.isoWeek().week;
  const out = [];
  const alive = [];
  for (const id of ids) {
    const league = await firestore.get(FRIEND_LEAGUE + '/' + id);
    if (!league) continue; // deleted: drop the stale pointer
    alive.push(id);
    out.push(await friendLeagueView(id, league, week, uid));
  }
  if (alive.length !== ids.length) await saveFriendIndexIds(uid, alive);
  return out;
}

async function removeFriendLeague(leagueId, code) {
  try {
    const db = firestore.getDb();
    const ref = db.collection(FRIEND_LEAGUE).doc(leagueId);
    if (typeof db.recursiveDelete === 'function') {
      await db.recursiveDelete(ref);
    } else {
      await ref.delete();
    }
  } catch (e) {
    console.error('[friends] league delete failed:', e && e.message);
  }
  if (code) await firestore.del(FRIEND_CODES + '/' + code);
}

// ─── Friends-league invite links ──────────────────────────────────────────
// A shared invite is a plain https link: https://<host>/join/ABC123.
//
// Android intercepts it when MacroSnap is installed (the app registers this
// host as an app link and applies the code), so this route is what runs when
// the app is NOT installed: it sends the visitor to the Play Store with the
// code carried in the install referrer, so a fresh install can still land on
// the right league.
//
// Deliberately unauthenticated and side-effect free: it stores nothing, so a
// guessed code reveals nothing and a broken link still installs the app.
const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.macrosnap.macro_snap';

// Android App Links verification. Without this file Android refuses to open
// https://<host>/join/CODE in the app and every invite falls through to the
// browser, even for someone who already has MacroSnap.
//
// The fingerprints are the app-signing certificate SHA-256s (Play Console →
// App integrity → App signing key certificate), a comma-separated list so the
// upload key and Play's signing key can both be trusted during a rollout. The
// variable is configuration, not code: the certificate is public, so no
// secret material lives here.
// The certificate that signs the APKs published with each release. Its digest is
// public — it ships inside every APK — so it belongs in the repo rather than in
// configuration nobody remembers to set. This file used to answer `[]` whenever
// ASSETLINKS_SHA256 was unset, which is a valid App Links response that verifies
// NOTHING: Android therefore sent every /join link to the browser, and the
// browser (identifying as Android) was redirected to the Play Store.
//
// Play-installed builds are signed by Google's app-signing key instead, so that
// digest still has to be added through ASSETLINKS_SHA256 (Play Console → App
// integrity → App signing key certificate). Both keys are trusted at once, which
// is what a rollout needs anyway.
const KNOWN_SIGNING_SHA256 = [
  '24:0F:92:80:E7:47:23:71:93:AF:36:7B:54:90:15:F8:DC:EB:B2:78:1A:30:8D:2F:CD:56:36:04:B7:9F:84:4F',
];

app.get('/.well-known/assetlinks.json', (req, res) => {
  const fromEnv = String(process.env.ASSETLINKS_SHA256 || '')
    .split(/[,\s]+/)
    .map((v) => v.trim().toUpperCase())
    .filter((v) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(v));
  const fingerprints = [...new Set([...fromEnv, ...KNOWN_SIGNING_SHA256])];
  res.set('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  return res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.macrosnap.macro_snap',
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

// The page an invitee sees when the link is opened anywhere but Android: the
// store link is useless on an iPhone or a laptop, so show the code itself and
// let them type it into the app (or send it to an Android phone).
function joinLandingPage(code) {
  const codeLine = code
    ? `<p class="code" id="code">${code}</p>
       <button onclick="navigator.clipboard&&navigator.clipboard.writeText('${code}');this.textContent='Copied'">Copy code</button>`
    : `<p class="muted">This invite link is incomplete. Ask your friend to share it again.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join a MacroSnap league</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0B0B0F;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:380px;padding:32px 24px;text-align:center}
h1{font-size:20px;margin:0 0 8px}
p{font-size:14px;line-height:1.5;color:#B9B4C7;margin:0 0 18px}
.code{font-size:34px;letter-spacing:8px;font-weight:800;color:#FF6B2B;margin:18px 0}
button{background:#FF6B2B;color:#0B0B0F;border:0;border-radius:12px;padding:12px 22px;
font-size:15px;font-weight:700}
a{display:block;margin-top:22px;color:#B9B4C7;font-size:13px}
</style></head><body><main>
<h1>You have a MacroSnap league invite</h1>
${codeLine}
<p>Open MacroSnap and enter this code under Friends league to join.</p>
<a href="${PLAY_STORE_URL}">Get MacroSnap for Android</a>
</main></body></html>`;
}

// Android visitors need the app, not the store. This page asks Android to start
// MacroSnap through an `intent://` URL that names the package, which starts the
// app WITHOUT Digital Asset Links verification — the case that matters while a
// build is signed by a key assetlinks.json does not list. With no app installed
// Chrome follows `browser_fallback_url` to the store, still carrying the invite
// as the install referrer, so nothing is lost.
//
// This used to be a bare 302 to the Play Store, which is what made a tapped
// invite "open in the browser, then jump to Play" even for someone who already
// had the app installed.
function androidJoinPage(code, storeUrl) {
  const intentUrl =
    `intent://join/${code}#Intent;scheme=macrosnap;` +
    `package=com.macrosnap.macro_snap;` +
    `S.browser_fallback_url=${encodeURIComponent(storeUrl)};end`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join a MacroSnap league</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0B0B0F;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:380px;padding:32px 24px;text-align:center}
h1{font-size:20px;margin:0 0 8px}
p{font-size:14px;line-height:1.5;color:#B9B4C7;margin:0 0 18px}
.code{font-size:34px;letter-spacing:8px;font-weight:800;color:#FF6B2B;margin:18px 0}
.btn{display:block;box-sizing:border-box;background:#FF6B2B;color:#0B0B0F;border:0;
border-radius:12px;padding:14px 22px;font-size:15px;font-weight:700;text-align:center;
text-decoration:none}
.btn.alt{background:transparent;color:#B9B4C7;border:1px solid #2A2A2A;margin-top:10px}
</style></head><body><main>
<h1>You have a MacroSnap league invite</h1>
<p class="code">${code}</p>
<p id="hint">Opening MacroSnap…</p>
<a class="btn" href="${intentUrl}">Open MacroSnap</a>
<a class="btn alt" href="${storeUrl}">Get it on Google Play</a>
<script>
// One automatic attempt, then the buttons stay for anyone Chrome would not
// launch into the app (a blocked intent, or no app installed).
setTimeout(function(){ window.location.href = '${intentUrl}'; }, 60);
setTimeout(function(){
  var hint = document.getElementById('hint');
  if (hint) hint.textContent = 'Tap to open MacroSnap, or install it below.';
}, 1500);
</script>
</main></body></html>`;
}

app.get('/join/:code', (req, res) => {
  const raw = String(req.params.code || '').trim();
  const code = /^[A-Za-z0-9]{6}$/.test(raw) ? raw.toUpperCase() : null;
  res.set('Cache-Control', 'no-store');
  // A link without a usable code cannot open anything: show the page that
  // explains that, on every platform.
  if (!code) {
    res.type('html').send(joinLandingPage(null));
    return;
  }
  // The store link carries the invite as the install referrer, so an install
  // from here still joins the league on first launch.
  const storeUrl = `${PLAY_STORE_URL}&referrer=${encodeURIComponent(`join_code=${code}`)}`;
  const isAndroid = /android/i.test(String(req.headers['user-agent'] || ''));
  res.type('html').send(
    isAndroid ? androidJoinPage(code, storeUrl) : joinLandingPage(code)
  );
});

// Invite-funnel counters. One document per event, so the owner can count
// installs→opens→joins with a Firestore query instead of guessing whether the
// link, the referrer or the paywall is where invites die. Unauthenticated on
// purpose: the referrer is read before anyone signs in. Only the fixed event
// names below are accepted, and the body is never trusted for anything else.
const INVITE_EVENTS = new Set([
  'referrer',
  'link_open',
  'screen_open',
  'join_attempt',
  'join_ok',
  'join_fail',
]);

app.post('/join/event', rateLimit('/join/event'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const event = typeof body.event === 'string' ? body.event : '';
    // Validate before anything else, so the contract holds even where
    // Firestore is not configured.
    if (!INVITE_EVENTS.has(event)) {
      return res.status(400).json({ error: 'invalid_event' });
    }
    if (!firestore.isEnabled()) return res.json({ ok: true, skipped: true });
    const code = normalizeFriendCode(body.code) || '';
    const id = crypto.randomBytes(8).toString('hex');
    await firestore.set('inviteEvents/' + id, {
      event,
      code,
      at: new Date(),
    });
    return res.json({ ok: true });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.post('/friends/league', requireAuth, rateLimit('/friends/league'), async (req, res) => {
  try {
    const id = identityOf(req);
    const uid = id.uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'friends_unavailable' });
    }
    if (!(await isProAccount(id))) {
      return res.status(403).json({ error: 'pro_required' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const ids = await friendIndexIds(uid);
    if (ids.length >= FRIEND_MAX_LEAGUES) {
      return res.status(409).json({
        error: 'too_many_leagues',
        limit: FRIEND_MAX_LEAGUES,
      });
    }

    // A code must be unique FOREVER: friendCodes is the lookup, so a collision
    // would deliver an invite to a stranger's league.
    let code = null;
    for (let attempt = 0; attempt < 6 && !code; attempt++) {
      const candidate = friendCode();
      const taken = await firestore.get(FRIEND_CODES + '/' + candidate);
      if (!taken) code = candidate;
    }
    if (!code) return res.status(503).json({ error: 'code_unavailable' });

    const week = lb.isoWeek().week;
    const leagueId = crypto.randomBytes(9).toString('hex');
    const league = {
      name: cleanLeagueName(body.name),
      code,
      ownerUid: uid,
      createdAt: new Date(),
      week,
      memberCount: 1,
    };
    const displayName = lb.publicName(
      typeof body.displayName === 'string' ? body.displayName : ''
    );
    const ownerAvatar = lb.publicAvatar(body.avatar);

    await firestore.set(FRIEND_LEAGUE + '/' + leagueId, league);
    await firestore.set(FRIEND_CODES + '/' + code, {
      leagueId,
      createdAt: new Date(),
    });
    await firestore.set(FRIEND_LEAGUE + '/' + leagueId + '/members/' + uid, {
      uid,
      name: displayName,
      avatar: ownerAvatar,
      joinedAt: new Date(),
    });
    // A zero row now, so the owner sees themselves on the board before the
    // first score sync rather than an "empty" league.
    await firestore.set(
      FRIEND_LEAGUE + '/' + leagueId + '/weeks/' + week + '/entries/' + uid,
      {
        uid,
        name: displayName,
        avatar: ownerAvatar,
        points: 0,
        week,
        updatedAt: new Date(),
      }
    );
    await saveFriendIndexIds(uid, [...ids, leagueId]);

    res.json({
      ok: true,
      league: await friendLeagueView(leagueId, league, week, uid),
    });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// What a code points at, without joining. Lets the app say "that invite
// expired" or "that league is full" before it opens a league screen or sends
// a free account into the paywall, instead of failing after the fact.
app.get('/friends/invite/:code', requireAuth, async (req, res) => {
  try {
    const uid = identityOf(req).uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'friends_unavailable' });
    }
    const code = normalizeFriendCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'invalid_code' });
    const pointer = await firestore.get(FRIEND_CODES + '/' + code);
    const leagueId =
      pointer && typeof pointer.leagueId === 'string' ? pointer.leagueId : null;
    const league = leagueId
      ? await firestore.get(FRIEND_LEAGUE + '/' + leagueId)
      : null;
    if (!leagueId || !league) {
      return res.status(404).json({ error: 'code_not_found' });
    }
    const members = await friendMembers(leagueId);
    const ids = await friendIndexIds(uid);
    return res.json({
      ok: true,
      valid: true,
      code,
      name: cleanLeagueName(league.name),
      memberCount: members.length,
      full: members.length >= FRIEND_MAX_MEMBERS,
      alreadyMember: ids.includes(leagueId),
    });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.post('/friends/join', requireAuth, rateLimit('/friends/join'), async (req, res) => {
  try {
    const id = identityOf(req);
    const uid = id.uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'friends_unavailable' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const code = normalizeFriendCode(body.code);
    if (!code) return res.status(400).json({ error: 'invalid_code' });
    let trialDays = 0;
    if (!(await isProAccount(id))) {
      // A free account that came here through an invite gets the configured
      // window instead of a paywall — one per account, and 0 (paywall) when
      // INVITE_TRIAL_DAYS is unset.
      trialDays = await grantInviteTrial(uid);
      if (!trialDays) return res.status(403).json({ error: 'pro_required' });
    }

    const pointer = await firestore.get(FRIEND_CODES + '/' + code);
    const leagueId =
      pointer && typeof pointer.leagueId === 'string' ? pointer.leagueId : null;
    const league = leagueId
      ? await firestore.get(FRIEND_LEAGUE + '/' + leagueId)
      : null;
    if (!leagueId || !league) {
      return res.status(404).json({ error: 'code_not_found' });
    }

    const week = lb.isoWeek().week;
    const ids = await friendIndexIds(uid);
    if (ids.includes(leagueId)) {
      return res.json({
        ok: true,
        alreadyMember: true,
        league: await friendLeagueView(leagueId, league, week, uid),
      });
    }
    if (ids.length >= FRIEND_MAX_LEAGUES) {
      return res.status(409).json({
        error: 'too_many_leagues',
        limit: FRIEND_MAX_LEAGUES,
      });
    }

    const members = await friendMembers(leagueId);
    if (members.length >= FRIEND_MAX_MEMBERS) {
      return res.status(409).json({ error: 'league_full' });
    }

    const joinerName = lb.publicName(
      typeof body.displayName === 'string' ? body.displayName : ''
    );
    const joinerAvatar = lb.publicAvatar(body.avatar);
    await firestore.set(FRIEND_LEAGUE + '/' + leagueId + '/members/' + uid, {
      uid,
      name: joinerName,
      avatar: joinerAvatar,
      joinedAt: new Date(),
      // How this member arrived: what the inviter's "joined with your invite"
      // line is built from.
      via: 'invite',
      invitedByCode: code,
    });
    // A zero row now, so a new member appears on the board immediately.
    await firestore.set(
      FRIEND_LEAGUE + '/' + leagueId + '/weeks/' + week + '/entries/' + uid,
      {
        uid,
        name: joinerName,
        avatar: joinerAvatar,
        points: 0,
        week,
        updatedAt: new Date(),
      }
    );
    await firestore.set(
      FRIEND_LEAGUE + '/' + leagueId,
      { memberCount: members.length + 1 },
      { merge: true }
    );
    await saveFriendIndexIds(uid, [...ids, leagueId]);

    const fresh =
      (await firestore.get(FRIEND_LEAGUE + '/' + leagueId)) || league;
    res.json({
      ok: true,
      trialDays,
      league: await friendLeagueView(leagueId, fresh, week, uid),
    });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.get('/friends/leagues', requireAuth, async (req, res) => {
  try {
    const uid = identityOf(req).uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'friends_unavailable' });
    }
    res.json({
      ok: true,
      week: lb.isoWeek().week,
      leagues: await listFriendLeagues(uid),
    });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// Scores the week once and writes the row into every league this account is
// still a member of. The phone sends the same raw facts as the public sync; the
// server decides every point.
app.post('/friends/sync', requireAuth, rateLimit('/friends/sync'), async (req, res) => {
  try {
    const id = identityOf(req);
    const uid = id.uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'friends_unavailable' });
    }
    const db = firestore.getDb();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const week = lb.isoWeek();
    const today = lb.todayKey();

    const ids = await friendIndexIds(uid);
    if (!ids.length) {
      return res.json({ ok: true, week: week.week, points: 0, leagues: [] });
    }

    // A member whose Pro lapsed keeps scoring, but on the free ceiling: the
    // league must not become a way around the step limit.
    const pro = await isProAccount(id);
    const scored = await scoreWeekFacts(
      db,
      uid,
      body,
      week,
      today,
      pro ? null : FREE_STEP_CAP
    );
    // Persist the merged step history before the rows, exactly like the public
    // sync: a row that survives without its steps would score zero tomorrow.
    await writeStepDays(db, uid, scored.stepLog);
    const name = lb.publicName(
      typeof body.name === 'string' ? body.name : ''
    );
    const avatar = lb.publicAvatar(body.avatar);

    const leagues = [];
    const alive = [];
    for (const leagueId of ids) {
      const league = await firestore.get(FRIEND_LEAGUE + '/' + leagueId);
      if (!league) continue;
      const memberPath = FRIEND_LEAGUE + '/' + leagueId + '/members/' + uid;
      const member = await firestore.get(memberPath);
      if (!member) continue; // removed from the group: never write a row back
      alive.push(leagueId);
      await firestore.set(memberPath, { name, avatar }, { merge: true });
      await firestore.set(
        FRIEND_LEAGUE + '/' + leagueId + '/weeks/' + week.week +
          '/entries/' + uid,
        {
          uid,
          name,
          avatar,
          points: scored.weekPoints,
          week: week.week,
          updatedAt: new Date(),
        }
      );
      leagues.push(await friendLeagueView(leagueId, league, week.week, uid));
    }
    if (alive.length !== ids.length) await saveFriendIndexIds(uid, alive);

    res.json({
      ok: true,
      week: week.week,
      points: scored.weekPoints,
      dayPoints: scored.dayPoints,
      leagues,
    });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// A profile edit is not a scoring round.
//
// Renaming or changing the picture used to call /leaderboard/sync AND
// /friends/sync — two full passes that re-read a week of meals, habits, water
// and weigh-ins to recompute points a label cannot move, and that wrote board
// rows for an account which had never joined. This route writes only the fields
// that changed, and only onto rows that ALREADY EXIST: an account with no board
// and no league costs a single document read and writes nothing at all.
//
// The display name is de-duplicated exactly as the scoring sync does it, so a
// rename cannot put two identical names on one board.
app.post('/profile/publish', requireAuth, rateLimit('/profile/publish'), async (req, res) => {
  try {
    const uid = identityOf(req).uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'profile_unavailable' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Presence, not truthiness: an EMPTY avatar is a real edit that clears the
    // picture, while an absent field means "leave it alone".
    const hasAvatar = Object.prototype.hasOwnProperty.call(body, 'avatar');
    const hasName =
      typeof body.name === 'string' && body.name.trim().length > 0;
    if (!hasAvatar && !hasName) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }
    const fields = {};
    if (hasAvatar) fields.avatar = lb.publicAvatar(body.avatar);

    const db = firestore.getDb();
    const week = lb.isoWeek().week;

    // ── Where this account is, if anywhere ─────────────────────────────────
    const meta = await firestore.get(LEADERBOARD_META + '/' + uid);
    const stateKey = meta ? lb.stateKey(meta.stateKey) : null;
    const districtKey = meta ? lb.slug(meta.districtKey || '') : '';
    const onBoard =
      !!meta && meta.joined === true && meta.week === week && stateKey && districtKey;
    const scopes = onBoard ? lb.boardsFor(stateKey, districtKey) : [];

    // ── Display name, unique on the board it lands on ──────────────────────
    if (hasName) {
      let name = lb.publicName(body.name);
      if (onBoard) {
        try {
          // The same check as the sync, narrowed to the one board a clash can
          // happen on. A failed read publishes the plain name rather than
          // failing the rename.
          const snap = await db
            .collection('leaderboard')
            .doc(week)
            .collection('scopes')
            .doc(scopes[2])
            .collection('entries')
            .get();
          const taken = snap.docs
            .filter((d) => d.id !== uid)
            .map((d) => (d.data() || {}).name)
            .filter((n) => typeof n === 'string');
          name = lb.uniqueName(name, uid, taken);
        } catch (_) {}
      }
      fields.name = name;
    }

    const batch = db.batch();
    let writes = 0;
    let boards = 0;
    let leagues = 0;

    // ── Public board: this week's rows, where the account already has one ──
    for (const scope of scopes) {
      const ref = db
        .collection('leaderboard')
        .doc(week)
        .collection('scopes')
        .doc(scope)
        .collection('entries')
        .doc(uid);
      const snap = await ref.get();
      // Never create a row from a profile edit: that would be joining a board
      // through the name or picture editor.
      if (!snap.exists) continue;
      batch.set(ref, { ...fields, updatedAt: new Date() }, { merge: true });
      writes += 1;
      boards += 1;
    }

    // ── Private leagues: membership and this week's league row ─────────────
    for (const leagueId of await friendIndexIds(uid)) {
      const members = db
        .collection(FRIEND_LEAGUE)
        .doc(leagueId)
        .collection('members');
      const memberSnap = await members.doc(uid).get();
      if (memberSnap.exists) {
        batch.set(members.doc(uid), fields, { merge: true });
        writes += 1;
        leagues += 1;
      }
      const rowRef = db
        .collection(FRIEND_LEAGUE)
        .doc(leagueId)
        .collection('weeks')
        .doc(week)
        .collection('entries')
        .doc(uid);
      const rowSnap = await rowRef.get();
      if (rowSnap.exists) {
        batch.set(rowRef, fields, { merge: true });
        writes += 1;
      }
    }

    if (writes) await batch.commit();
    // Keep the meta copy in step even when there is no row yet, so the next
    // scoring sync does not write the old label or picture back over this one.
    if (meta && meta.joined === true) {
      await firestore.set(
        LEADERBOARD_META + '/' + uid,
        fields,
        { merge: true }
      );
    }
    // `name` only when a name was published, so an avatar-only push answers
    // exactly what it did before (and never sends an undefined field).
    const out = { ok: true, boards, leagues };
    if (fields.name) out.name = fields.name;
    return res.json(out);
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

app.post('/friends/leave', requireAuth, rateLimit('/friends/leave'), async (req, res) => {
  try {
    const uid = identityOf(req).uid;
    if (!uid) return res.status(400).json({ error: 'identity_required' });
    if (!firestore.isEnabled()) {
      return res.status(503).json({ error: 'friends_unavailable' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const leagueId = typeof body.leagueId === 'string' ? body.leagueId : '';
    if (!/^[a-f0-9]{8,32}$/.test(leagueId)) {
      return res.status(400).json({ error: 'invalid_league' });
    }

    const ids = await friendIndexIds(uid);
    if (!ids.includes(leagueId)) {
      return res.status(404).json({ error: 'not_a_member' });
    }
    const league = await firestore.get(FRIEND_LEAGUE + '/' + leagueId);

    await firestore.del(FRIEND_LEAGUE + '/' + leagueId + '/members/' + uid);
    await saveFriendIndexIds(uid, ids.filter((v) => v !== leagueId));

    const remaining = await friendMembers(leagueId);
    if (!league || remaining.length === 0) {
      // The last member leaving takes the league and its code with them.
      await removeFriendLeague(leagueId, league && league.code);
      return res.json({ ok: true, deleted: true });
    }

    // An owner who leaves hands the league to its longest-standing member
    // rather than stranding a group with nobody able to administer it.
    if (league.ownerUid === uid) {
      const next = remaining
        .slice()
        .sort((a, b) => joinedMs(a.joinedAt) - joinedMs(b.joinedAt))[0];
      await firestore.set(
        FRIEND_LEAGUE + '/' + leagueId,
        { ownerUid: next.id },
        { merge: true }
      );
    }
    await firestore.set(
      FRIEND_LEAGUE + '/' + leagueId,
      { memberCount: remaining.length },
      { merge: true }
    );
    res.json({ ok: true, deleted: false });
  } catch (e) {
    return sendFailure(req, res, e);
  }
});

// ─── Leaderboard cleanup (cron) ─────────────────────────────────────────────
// Weekly boards are disposable: a row is a name and a number for one week. This
// removes boards older than four weeks so the collection cannot grow forever.
// Fail closed: without a matching CRON_SECRET nothing is deleted.
const LEADERBOARD_RETENTION_DAYS = 28;

async function leaderboardGc(req, res) {
  const secret = process.env.CRON_SECRET;
  const header = String(req.headers['x-cron-secret'] || '');
  const bearer = String(req.headers.authorization || '').replace(
    /^Bearer\s+/i,
    ''
  );
  if (!secret || (header !== secret && bearer !== secret)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!firestore.isEnabled()) {
    return res.status(503).json({ error: 'leaderboard_unavailable' });
  }
  try {
    const db = firestore.getDb();
    const cutoff = lb.addDays(
      lb.todayKey(),
      -LEADERBOARD_RETENTION_DAYS
    );
    const snap = await db.collection('leaderboard').get();
    const deleted = [];
    for (const doc of snap.docs) {
      const weekId = doc.id;
      const start = lb.weekStartDate(weekId);
      if (!start || start >= cutoff) continue;
      if (typeof db.recursiveDelete === 'function') {
        await db.recursiveDelete(doc.ref);
      } else {
        await doc.ref.delete();
      }
      deleted.push(weekId);
    }
    res.json({ ok: true, deleted, cutoff });
  } catch (e) {
    return sendFailure(req, res, e);
  }
}

app.post('/cron/leaderboard-gc', leaderboardGc);
app.get('/cron/leaderboard-gc', leaderboardGc);

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

app.post(
  '/payment/create-subscription',
  requireAuth,
  rateLimit('/payment/create-subscription'),
  async (req, res) => {
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

    // ── ₹1 is the FIRST subscription's price, not a recurring courtesy ──
    // A cancelled account re-subscribing is an ordinary new subscription for
    // Razorpay, so nothing there stops the ₹1 from being collected again and
    // again. Our own ledger decides: an account that has ever paid gets the
    // ₹49 plan from day one (no addon, no deferred start) — the same rule
    // Spotify/YouTube/Apple apply to their intro offers.
    const introUsed = await introUsedFor(id);

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
      // ── NEW accounts: FIRST MONTH ₹1 ────────────────────────────
      // Billing for the ₹49 plan starts 30 days out, and the ₹1 is collected
      // NOW as an upfront addon during the authorisation transaction. That is
      // the difference between this and the old free month: the customer
      // makes a real (small) payment today, which also authenticates the
      // mandate without a bare ₹5 token debit. The first ₹49 charge happens
      // at the start of the future cycle, reported by subscription.activated /
      // subscription.charged via the webhook below.
      //
      // ── RETURNING accounts: ₹49 from day one ────────────────────
      // No start_at (the first cycle is charged at authorisation) and no
      // addon — skipping the intro price is what stops cancel → re-subscribe
      // from costing ₹1 a month forever.
      ...(introUsed
        ? {}
        : {
            start_at: Math.floor(
              (Date.now() + FIRST_MONTH_DAYS * 24 * 60 * 60 * 1000) / 1000
            ),
            // Razorpay's only cross-method way to take money at authorisation:
            // `addons` is "the upfront amount you want to collect as part of
            // the authorisation transaction". Kept separate from the plan so
            // the recurring amount stays ₹49.
            addons: [
              {
                item: {
                  name: 'First month',
                  amount: FIRST_MONTH_PRICE,
                  currency: 'INR',
                  description: 'First month at ₹1, then ₹49/month',
                },
              },
            ],
          }),
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
      amount: 4900, // what auto-charges every cycle for a returning account
      currency: 'INR',
      // True when THIS checkout carries the ₹1 intro (first subscription
      // ever). The app uses it to keep the checkout description honest.
      intro_offer: !introUsed,
      // New accounts: month 1 costs ₹1 (charged with the mandate), month 2
      // onwards ₹49. Returning accounts pay ₹49 from the first cycle.
      first_month_price: introUsed ? 4900 : FIRST_MONTH_PRICE,
      first_month_days: introUsed ? 0 : FIRST_MONTH_DAYS,
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
      // intro_used: a verified payment means the ₹1 intro (if any) is spent;
      // every later subscription for this account bills ₹49 from day one.
      const u = await dbq(
        'INSERT INTO users (phone, subscribed, intro_used) VALUES ($1, true, true) ON CONFLICT (phone) DO UPDATE SET subscribed = true, intro_used = true',
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
        {
          subscribed: true,
          // Marks the ₹1 intro as spent the moment a genuine payment is
          // verified — the same ledger YouTube/Apple keep per account.
          intro_used: true,
          subscriptionId: razorpay_subscription_id || null,
        },
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

    // The signature covers the EXACT bytes Razorpay sent. Re-serializing
    // req.body would verify a body we constructed, not the one that arrived, so
    // a missing raw capture is a rejection rather than a fallback.
    if (!req.rawBody) {
      return res.status(400).json({ error: 'Missing raw body' });
    }
    const rawBody = req.rawBody.toString();
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
    // Razorpay retries a webhook until it gets a 2xx, and it does not promise
    // delivery order. Two consequences the old handler ignored:
    //   * a retried `subscription.charged` re-activated an account whose
    //     subscription had since been cancelled;
    //   * an event that arrives late (after a newer one was applied) rewound
    //     the state it carried.
    // Both are settled against what this server has already applied: the
    // event id is recorded once, and state changes are only applied when the
    // event is at least as new as the last one applied to that subscription.
    const eventAt = Number(event?.created_at) || 0;
    // Every processed event is recorded in webhookLog/{id} — a payment that
    // never activates (or an event we can't map to a user) is visible within
    // minutes instead of silently returning { received: true }.
    const logEventId =
      event?.id || ('evt_' + (event?.created_at || Date.now()) + '_' + (subscriptionId || 'none'));
    // Idempotency: an event id we have already logged is a RETRY, not new
    // information. Answering 200 (not an error) is what stops Razorpay
    // retrying it forever.
    const seen = await firestore.get('webhookLog/' + logEventId);
    if (seen && seen.seenAt) {
      return res.json({ received: true, duplicate: true });
    }

    if (!subscriptionId) {
      try {
        await firestore.set('webhookLog/' + logEventId, {
          event: event?.event || '',
          outcome: 'no_subscription',
          seenAt: new Date(),
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
      eventType.includes('halted');
    // A single failed charge is NOT the end of a subscription. Razorpay retries
    // every failed attempt and only emits subscription.halted once those
    // retries are exhausted (or the mandate is revoked). Treating the first
    // payment.failed as an off-switch cut off customers whose card was charged
    // successfully on the last retry minutes later — they paid, and the app had
    // already told them they were not Pro.
    const paymentFailed = eventType.includes('failed');

    // Ordering: never rewind a subscription to an older event than the last
    // one applied. The marker is written with each state change below.
    let lastEventAt = 0;
    if (eventAt) {
      try {
        const applied = await firestore.get('subscriptions/' + subscriptionId);
        lastEventAt = Number(applied && applied.lastEventAt) || 0;
      } catch (_) {}
      if (lastEventAt && eventAt < lastEventAt) {
        try {
          await firestore.set('webhookLog/' + logEventId, {
            event: eventType,
            subscriptionId,
            phone: phone || null,
            outcome: 'stale',
            eventAt,
            lastEventAt,
            seenAt: new Date(),
            receivedAt: new Date(),
          }, { merge: true });
        } catch (_) {}
        return res.json({ received: true, stale: true });
      }
    }

    let outcome;
    if (!phone) {
      outcome = 'unresolved';
    } else if (turnOn) {
      await dbq(
        'INSERT INTO users (phone, subscribed, intro_used) VALUES ($1, true, true) ON CONFLICT (phone) DO UPDATE SET subscribed = true, intro_used = true, subscription_id = $2',
        [phone, subscriptionId]
      );
      try {
        await dbq('UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE id = $2', [sub?.status || 'active', subscriptionId]);
      } catch (_) {}
      // Firestore mirror: activate user + subscription doc (best-effort).
      {
        const fUid = await firestore.resolveUid(phone);
        if (fUid) {
          // intro_used rides along on every charge: after the first one the
          // ₹1 intro is spent, so a later re-subscribe bills ₹49 from day one.
          await firestore.set('users/' + fUid, { subscribed: true, intro_used: true, subscriptionId: subscriptionId || null }, { merge: true });
        }
        if (subscriptionId) {
          await firestore.set('subscriptions/' + subscriptionId, { uid: fUid || null, identifier: phone, status: sub?.status || 'active', lastEventAt: eventAt || Date.now(), updatedAt: new Date() }, { merge: true });
        }
      }
      outcome = 'activated';
    } else if (paymentFailed) {
      // Keep whatever state the account already has: a paying customer stays
      // Pro through the retry window, and someone who never paid stays free.
      outcome = 'payment_failed_grace';
    } else if (turnOff) {
      // ── Cancelling stops the NEXT charge, not days already paid for ──
      // This used to switch Pro off the moment the mandate died. Subscribe
      // with the ₹1 first month, cancel the autopay a week later, and the app
      // answered "not Pro — subscribe again" for a month the customer had
      // already paid for. The paid cycle now runs to its end: `subscribed`
      // goes false (nothing will ever auto-charge again) while `pro_until`
      // carries the window — the same field the referral reward uses, so
      // entitlementsFor() and /subscription/status already honour it.
      const paidUntil = paidCycleEnd(sub);
      await dbq(
        paidUntil
          ? 'UPDATE users SET subscribed = false, pro_until = $1 WHERE phone = $2'
          : 'UPDATE users SET subscribed = false WHERE phone = $1',
        paidUntil ? [paidUntil, phone] : [phone]
      );
      try {
        await dbq('UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE id = $2', [sub?.status || 'cancelled', subscriptionId]);
      } catch (_) {}
      // Firestore mirror: deactivate user + subscription doc (best-effort).
      {
        const fUid = await firestore.resolveUid(phone);
        if (fUid) {
          await firestore.set(
            'users/' + fUid,
            paidUntil
              ? { subscribed: false, pro_until: paidUntil, pro_until_at: new Date(paidUntil) }
              : { subscribed: false },
            { merge: true }
          );
        }
        if (subscriptionId) {
          await firestore.set('subscriptions/' + subscriptionId, { status: sub?.status || 'cancelled', lastEventAt: eventAt || Date.now(), updatedAt: new Date() }, { merge: true });
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
        eventAt: eventAt || null,
        seenAt: new Date(),
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
    // Whether the ₹1 intro month is still available to this account — the
    // paywall shows ₹1 copy only when the server says so, so a re-subscriber
    // is never promised a price their checkout will not charge.
    let proUntil = null;
    let introUsed = false;
    try {
      const fUid = await firestore.resolveUid(phone);
      if (fUid && firestore.isEnabled()) {
        const doc = await firestore.getDb().collection('users').doc(fUid).get();
        if (doc.exists) {
          subscribed = doc.data().subscribed === true;
          introUsed = doc.data().intro_used === true;
          // A cancelled subscription can still have days of the cycle it has
          // already paid for. Reporting false here made the app's payment poll
          // say "free" while /subscription/status said "Pro".
          if (!subscribed && proUntilActive(doc.data().pro_until)) {
            subscribed = true;
            proUntil = doc.data().pro_until;
          }
        }
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
          // Any payment record means this identity has paid before.
          introUsed = true;
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
      const user = await dbq('SELECT subscribed, intro_used, pro_until FROM users WHERE phone = $1', [phone]);
      const payments = await dbq(
        'SELECT * FROM payments WHERE phone = $1 ORDER BY created_at DESC LIMIT 1',
        [phone]
      );
      subscribed = user.rows[0]?.subscribed || false;
      introUsed = introUsed || user.rows[0]?.intro_used === true;
      if (!subscribed && proUntilActive(user.rows[0]?.pro_until)) {
        subscribed = true;
        proUntil = user.rows[0].pro_until;
      }
      payment = payments.rows[0] || null;
      if (payment) introUsed = true;
    }
    res.json({
      subscribed,
      payment,
      intro_eligible: !introUsed,
      ...(proUntil ? { pro_until: proUntil } : {}),
    });
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
// Wipes ALL of the user's data (Postgres + Firestore) and keeps exactly one
// thing: a tombstone holding an HMAC fingerprint of the identifier and the
// deletion timestamp. It exists so the once-per-account ₹1 first month cannot
// be collected again by deleting and re-registering — see tombstoneFingerprint
// for why the record is a keyed hash rather than the email, and
// TOMBSTONE_RETENTION_MONTHS for how long it lives.
// Deletes every document matching [query], in batches of 400 — Firestore caps
// a commit at 500 writes, so the old "one batch for the whole account" broke
// silently for anyone with more than 500 meals. Throws on failure: the caller
// records it instead of reporting a clean deletion.
async function deleteEveryMatching(db, query) {
  const snap = await query.get();
  const docs = (snap && snap.docs) || [];
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return docs.length;
}

app.post('/account/delete', requireAuth, async (req, res) => {
  try {
    // You can only delete the account you are signed in as.
    const id = identityOf(req);
    const phone = id.phone || id.identifier;
    const email = id.email;
    const identifier = phone || email;
    if (!identifier) return res.status(400).json({ error: 'Identity required' });
    if (isAdminUser(id)) return res.status(403).json({ error: 'Admin account cannot be deleted' });

    // 1) Resolve the uid before anything is wiped: it is the key for the
    //    Firestore documents removed in step 4.
    //
    //    Nothing about the old free trial is captured any more. The trial is
    //    gone, nothing reads its marker, and "when this person started a trial
    //    that no longer exists" is not something worth remembering about a
    //    deleted account.
    const fUid = await firestore.resolveUid(identifier);

    // 2) Write the tombstone. It holds NO email, phone or name — only an HMAC
    //    fingerprint of the identifier, which is enough to answer "has this
    //    identity spent the ₹1 month?" and useless for anything else. See
    //    tombstoneFingerprint() for why, and for the retention window.
    const fingerprint = tombstoneFingerprint(identifier);
    // Without a real key a fingerprint enforces nothing (anyone with the
    // source can reproduce the development key), and writing one also deletes
    // the legacy cleartext document — the only remaining evidence that this
    // account deleted. So a run using the development key leaves the tombstone
    // store completely alone, and says why.
    const tombstonesEnforce = Boolean(TOMBSTONE_SECRET);
    if (!tombstonesEnforce && (firestore.isEnabled() || dbAvailable)) {
      console.error(
        "tombstone NOT written: TOMBSTONE_SECRET is unset, so the fingerprint would " +
          "use the insecure development key and enforce nothing. Set TOMBSTONE_SECRET " +
          "to the production value, or do not point this run at a real database."
      );
    }
    if (tombstonesEnforce && firestore.isEnabled()) {
      await firestore.set('deletedAccounts/' + fingerprint, {
        deleted_at: new Date().toISOString(),
      });
      // Remove the old raw-identifier document written by earlier builds: it
      // carries the email in cleartext and nothing reads that id any more.
      try {
        await firestore.del(
          'deletedAccounts/' + String(identifier).toLowerCase()
        );
      } catch (_) {}
      // Storage limitation, Firestore half. This matters more than the SQL copy
      // below: production runs without DATABASE_URL (the startup log says
      // "running without Postgres"), so the SQL purge never executes there and
      // the policy's "deleted automatically after 24 months" would be a promise
      // no code keeps. Expired fingerprints are removed here, on the next
      // deletion, whichever store the deployment actually uses.
      try {
        const db = firestore.getDb();
        const cutoff = new Date(
          Date.now() - TOMBSTONE_RETENTION_MONTHS * 30.44 * 24 * 3600 * 1000
        ).toISOString();
        const snap = await db
          .collection('deletedAccounts')
          .where('deleted_at', '<', cutoff)
          .get();
        const expired = (snap && snap.docs) || [];
        // Firestore commits cap at 500 operations, so a busy year's worth of
        // expired records cannot go in one batch. 400 leaves room to spare.
        for (let i = 0; i < expired.length; i += 400) {
          const batch = db.batch();
          expired.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      } catch (e) {
        // A purge that fails silently is a retention promise nobody can see
        // breaking. The deletion itself still succeeds — this must never turn
        // into a failed account deletion — but it has to be in the logs.
        console.error(
          'tombstone purge failed (Firestore):',
          e && e.message ? e.message : e
        );
      }
    }
    if (tombstonesEnforce && dbAvailable) {
      try {
        await dbq(
          `INSERT INTO deleted_accounts (identifier) VALUES ($1)
           ON CONFLICT (identifier) DO UPDATE SET deleted_at = NOW()`,
          [fingerprint]
        );
        // Storage limitation, enforced by the write that creates the rows:
        // fingerprints older than the retention window go on the next deletion.
        await dbq(
          `DELETE FROM deleted_accounts
           WHERE deleted_at < NOW() - ($1 || ' months')::interval`,
          [String(TOMBSTONE_RETENTION_MONTHS)]
        );
      } catch (e) {
        // Same rule as the Firestore half: never fail the deletion, always
        // leave a trace that the purge did not run.
        console.error(
          'tombstone purge failed (Postgres):',
          e && e.message ? e.message : e
        );
      }
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

    // 4) Wipe personal data — Firestore. Every step is CHECKED now. This used
    //    to delete the account's meals in ONE unbounded batch (Firestore caps a
    //    commit at 500 writes), swallow every failure, skip the `mealPhotos`
    //    collection the privacy policy promises to delete, and answer
    //    {ok:true} regardless — so a large account or a transient Firestore
    //    error left data behind while the app said the account was gone.
    const failures = [];
    let authDeleted = false;
    if (fUid && firestore.isEnabled()) {
      const db = firestore.getDb();
      const note = (what, e) => {
        const detail = e && e.message ? e.message : String(e || 'failed');
        console.error('[account/delete] ' + what + ':', detail);
        failures.push(what);
      };

      // 4a) Stop the billing FIRST. A deleted account whose Razorpay mandate is
      //     still live keeps being auto-charged for a subscription it can no
      //     longer see, let alone cancel.
      let subs = [];
      try {
        const snap = await db
          .collection('subscriptions')
          .where('uid', '==', fUid)
          .get();
        subs = snap.docs;
      } catch (e) {
        note('subscription lookup', e);
      }
      for (const doc of subs) {
        const subId = doc.id;
        const status = String((doc.data() || {}).status || '').toLowerCase();
        if (['cancelled', 'completed', 'expired', 'halted'].includes(status)) {
          continue;
        }
        if (!razorpay) {
          note('subscription ' + subId + ' not cancelled (Razorpay not configured)');
          continue;
        }
        try {
          // false = cancel now rather than at the end of the cycle: this is an
          // account deletion, and a final charge after it would be
          // unexplainable to the user who asked to be deleted.
          await razorpay.subscriptions.cancel(subId, false);
        } catch (e) {
          // A mandate that is already gone answers 400. Re-read before treating
          // it as a failure, so retrying the deletion is not blocked forever.
          let alreadyGone = false;
          try {
            const live = await razorpay.subscriptions.fetch(subId);
            alreadyGone = ['cancelled', 'completed', 'expired', 'halted'].includes(
              String((live && live.status) || '').toLowerCase()
            );
          } catch (_) {}
          if (!alreadyGone) note('subscription ' + subId + ' not cancelled', e);
        }
      }

      // 4b) Account-owned collections, in bounded batches.
      const owned = [
        ['meals', () => db.collection('meals').where('uid', '==', fUid)],
        ['mealPhotos', () => db.collection('mealPhotos').where('uid', '==', fUid)],
        ['payments', () => db.collection('payments').where('uid', '==', fUid)],
        ['referrals', () => db.collection('referrals').where('uid', '==', fUid)],
      ];
      for (const [label, query] of owned) {
        try {
          await deleteEveryMatching(db, query());
        } catch (e) {
          note(label + ' not fully deleted', e);
        }
      }
      // Leaderboard entries carry the display name, so they are personal data
      // too. The collection-group query needs an index; a failure is recorded
      // rather than fatal, and the retry can finish it.
      // Board rows are ephemeral (weekly reset, name + points only), so a
      // missing collection-group index is logged rather than turning every
      // deletion into a "failed" state the user cannot act on.
      try {
        await deleteEveryMatching(
          db,
          db.collectionGroup('entries').where('uid', '==', fUid)
        );
      } catch (e) {
        console.error(
          '[account/delete] leaderboard entries not cleared:',
          e && e.message ? e.message : e
        );
      }
      // Single documents. The safe helpers return false on failure instead of
      // throwing, so every result is checked.
      for (const col of [
        'habitData',
        'dietProfiles',
        'recentFoods',
        'userPreferences',
        'analytics',
        'recipes',
        'userIndex',
        'users',
      ]) {
        const id = col === 'userIndex' ? identifier : fUid;
        const ok = await firestore.del(col + '/' + id);
        if (!ok) note(col + '/' + id + ' not deleted');
      }
      // The subscription and payment records themselves, after the mandate is
      // dead — never before, or the cancellation would have nothing to look up.
      for (const doc of subs) {
        const ok = await firestore.del('subscriptions/' + doc.id);
        if (!ok) note('subscriptions/' + doc.id + ' not deleted');
      }
    }

    // 5) The sign-in identity itself. When the device's own delete() failed
    //    (Firebase requires a recent login) the app used to sign out anyway,
    //    leaving a usable Firebase account behind a screen that said the
    //    account was gone. The Admin SDK needs no fresh login.
    if (fUid) {
      const admin = firestore.getAdmin ? firestore.getAdmin() : null;
      if (!admin) {
        // Unreachable for a real request: requireAuth verifies tokens WITH the
        // Admin SDK, so no authenticated call arrives without it. Logged so a
        // misconfigured deployment is visible instead of silent.
        console.error('[account/delete] auth not deleted: Firebase Admin unavailable');
      } else {
        try {
          await admin.auth().deleteUser(fUid);
          authDeleted = true;
        } catch (e) {
          if (e && e.code === 'auth/user-not-found') {
            authDeleted = true; // already gone — the desired end state
          } else {
            console.error(
              '[account/delete] auth deleteUser:',
              e && e.message ? e.message : e
            );
            failures.push('auth account not deleted');
          }
        }
      }
    }

    if (failures.length) {
      // 202, not 200: most of the account is gone (its sign-in may already be),
      // but the app must not claim a clean deletion. "Partly deleted" is a
      // retryable state — neither success nor "nothing happened".
      return res.status(202).json({
        ok: false,
        incomplete: true,
        auth_deleted: authDeleted,
        error: 'account_deletion_incomplete',
        message:
          'Some account data could not be deleted yet. Retry from Settings, or email macrosnap7@gmail.com and we will finish it.',
      });
    }

    res.json({ ok: true, auth_deleted: authDeleted });
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
  'Guru\u2019s replies must be SHORT and SCANNABLE: use bullet points (one point per line, starting with a \u2022 or a dash) or a compact numbered list \u2014 never long paragraphs or essays. ' +
  'Keep the whole answer under 80 words overall, friendly and practical. A one-line answer with 2-4 quick points beats a paragraph. ' +
  'When you name a traditional Indian dish, add a short English explanation in parentheses.';

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
    // introUsed rides along so the FREE answer can say whether the ₹1 intro
    // month is still available (the paywall and upsell teasers only promise
    // ₹1 when the server says it is real for this account).
    let introUsed = false;
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
        if (doc.exists) introUsed = doc.data().intro_used === true;
        // Legacy payers predate the flag: their payment record is the proof.
        const paid = await firestore
          .getDb()
          .collection('payments')
          .where('identifier', '==', identifier)
          .get();
        if (paid && !paid.empty) introUsed = true;
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
      const r = await dbq('SELECT subscribed, pro_until, intro_used FROM users WHERE phone = $1 LIMIT 1', [phone]);
      user = r.rows[0] || null;
    }
    if (!user && email) {
      const r = await dbq('SELECT subscribed, pro_until, intro_used FROM users WHERE email = $1 LIMIT 1', [email]);
      user = r.rows[0] || null;
    }
    if (user?.subscribed) {
      return res.json({
        subscribed: true,
        ...(user.pro_until ? { pro_until: user.pro_until } : {}),
      });
    }
    if (user && user.intro_used) introUsed = true;
    if (user && identifier) {
      const paid = await dbq(
        "SELECT id FROM payments WHERE phone = $1 AND status = 'approved' LIMIT 1",
        [identifier]
      );
      if (paid.rows[0]) introUsed = true;
    }
    if (proUntilActive(user && user.pro_until)) return res.json({ subscribed: true, pro_until: user.pro_until });
    res.json({ subscribed: false, intro_eligible: !introUsed });
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
// Test seam: the shared week scorer (step ceiling behaviour is unit-tested
// without needing the clock to cooperate).
module.exports._scoreWeekFacts = scoreWeekFacts;
// Test hook: the deletion tombstone's fingerprint and retention window. The
// retained record must not be a readable identifier, and that is worth a test
// rather than a comment (test/tombstone.test.js).
module.exports._tombstone = {
  fingerprint: tombstoneFingerprint,
  retentionMonths: TOMBSTONE_RETENTION_MONTHS,
  expired: tombstoneExpired,
  canary: tombstoneCanary,
  ensureCanary: ensureTombstoneCanary,
  introUsedFor,
};
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
