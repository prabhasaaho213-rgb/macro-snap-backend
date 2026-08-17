require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { Pool } = require('pg');
const firestore = require('./firestore');

const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

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
    return { rows: [] };
  }
}

// Gemini model — the 2.5 generation is retired for new API keys (2026), so
// the default is a current vision-capable lite model. Override via GEMINI_MODEL.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

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

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(200).json({ ok: true });
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
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_id TEXT"); } catch (_) {}
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

const SCAN_LIMIT_FREE = 3;

// The owner/admin account is always Pro — exempt from the free scan limit.
// Mirrors SubscriptionService.adminEmail in the Flutter app. After Google
// sign-in the app sends the user's email as the `phone` field, so a simple
// case-insensitive match identifies the admin here.
const ADMIN_EMAIL = 'prabhasaaho213@gmail.com';

function isAdminUser(identifier) {
  return typeof identifier === 'string' &&
    identifier.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const phone = req.body?.phone || '';
    if (phone) {
      const now = new Date();
      const currentMonth = now.getFullYear() * 12 + now.getMonth();
      const fUid = await firestore.resolveUid(phone);
      // The owner is always subscribed, so the free limit never applies.
      let subscribed = isAdminUser(phone);
      let count = 0;
      let scanMonth = 0;
      if (dbAvailable) {
        // Postgres path (source of truth when a DB is configured).
        const user = await dbq('SELECT subscribed, scan_count, scan_month FROM users WHERE phone = $1', [phone]);
        if (user.rows.length > 0) {
          count = user.rows[0].scan_count || 0;
          scanMonth = user.rows[0].scan_month || 0;
        } else {
          await dbq('INSERT INTO users (phone, scan_count, scan_month) VALUES ($1, 0, $2) ON CONFLICT (phone) DO NOTHING', [phone, currentMonth]);
        }
      } else if (fUid) {
        // DB-less path: scan counters live in users/{uid} (Firestore).
        const doc = await firestore.getDb().collection('users').doc(fUid).get();
        const d = doc.exists ? doc.data() : {};
        count = d.scanCount || 0;
        scanMonth = d.scanMonth || 0;
      }
      // The owner is ALWAYS subscribed — the DB lookup above must never
      // downgrade them. Without this, an admin whose stored row/doc says
      // subscribed=false (e.g. never paid via Razorpay) gets 403'd at the
      // free scan limit, exactly like a free user.
      subscribed = subscribed || isAdminUser(phone);
      if (!subscribed) {
        if (scanMonth !== currentMonth) {
          count = 0;
          scanMonth = currentMonth;
        }
        if (count >= SCAN_LIMIT_FREE) {
          return res.status(403).json({ error: 'scan_limit_reached', scans_used: count, scans_limit: SCAN_LIMIT_FREE });
        }
      }
      // Carry state so the post-analysis increment updates the right store.
      req._scan = { phone, fUid, currentMonth, count, dbAvailable };
    }

    const key = process.env.GEMINI_KEY;
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

    const resp = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Empty response from AI');

    const cleaned = text.replace(/```json?/g, '').replace(/```/g, '').trim();
    const json = JSON.parse(cleaned.substring(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));

    const now = new Date();
    const currentMonth = now.getFullYear() * 12 + now.getMonth();
    let scansUsed = 0;
    if (req._scan) {
      const { phone, fUid, count, dbAvailable: hadDb } = req._scan;
      // The admin's scans are never counted — their account is always Pro.
      if (!isAdminUser(phone)) {
        scansUsed = count + 1;
        if (hadDb) {
          await dbq('UPDATE users SET scan_count = COALESCE(scan_count, 0) + 1 WHERE phone = $1', [phone]);
          const updated = await dbq('SELECT scan_count FROM users WHERE phone = $1', [phone]);
          scansUsed = updated?.rows[0]?.scan_count || scansUsed;
        }
        // Firestore mirror — also the counter's source when Postgres is absent.
        if (fUid) {
          await firestore.set('users/' + fUid, { scanCount: scansUsed, scanMonth: currentMonth }, { merge: true });
        }
      }
    }
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
      scans_limit: SCAN_LIMIT_FREE
    };
    res.json(normalized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/generate-diet-plan', async (req, res) => {
  try {
    const { weight, height, age, gender, goal, activity } = req.body;
    if (!weight || !height || !age) return res.status(400).json({ error: 'Weight, height & age required' });

    const bmr = gender === 'male' ? 10 * weight + 6.25 * height - 5 * age + 5 : 10 * weight + 6.25 * height - 5 * age - 161;
    const multipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, veryActive: 1.9 };
    const tdee = bmr * (multipliers[activity] || 1.2);
    const bmi = weight / ((height / 100) * (height / 100));
    const calTarget = goal === 'loseWeight' ? tdee - 500 : goal === 'gainMuscle' ? tdee + 300 : tdee;
    const proteinTarget = goal === 'gainMuscle' ? weight * 2.2 : goal === 'loseWeight' ? weight * 2.0 : weight * 1.6;
    const fatTarget = calTarget * 0.25 / 9;
    const carbTarget = (calTarget - (proteinTarget * 4) - (fatTarget * 9)) / 4;

    const prompt = `You are an Indian nutritionist. Generate a personalized ONE-DAY Indian diet plan.
User: ${gender}, ${age} yrs, ${weight}kg, ${height}cm, BMI ${bmi.toFixed(1)}.
Goal: ${goal}, Activity: ${activity}.
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

    const key = process.env.GEMINI_KEY;
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Empty response from AI');

    const cleaned = text.replace(/```json?/g, '').replace(/```/g, '').trim();
    const plan = JSON.parse(cleaned.substring(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));

    res.json({ bmi: bmi.toFixed(1), bmr: Math.round(bmr), tdee: Math.round(tdee), targetCalories: Math.round(calTarget), targetProtein: proteinTarget.toFixed(0), targetCarbs: carbTarget.toFixed(0), targetFats: fatTarget.toFixed(0), plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { phone, email, name } = req.body;
    if (!phone && !email) return res.status(400).json({ error: 'Phone or email required' });
    const identifier = phone || email;
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
    // Firestore mirror: user doc + identifier index (best-effort).
    {
      const fUid = await firestore.resolveUid(identifier);
      if (fUid) {
        await firestore.set('users/' + fUid, {
          identifier: identifier,
          email: email || null,
          name: name || '',
          subscribed: row.subscribed,
        }, { merge: true });
        await firestore.set('userIndex/' + identifier, { uid: fUid, name: name || '' }, { merge: true });
      }
    }
    res.json({ phone: row.phone || identifier, subscribed: row.subscribed || false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Returns the stored profile name for an identifier (phone or email) so the
// app can restore a previously-chosen nickname after a reinstall / on a new
// device — an existing user must never be re-asked for a nickname.
app.get('/user/profile', async (req, res) => {
  try {
    const { phone, email } = req.query;
    const identifier = phone || email;
    if (!identifier) return res.status(400).json({ error: 'Phone or email required' });
    const user = await dbq('SELECT name FROM users WHERE phone = $1', [identifier]);
    const name = (user.rows[0] || {}).name || null;
    res.json({ name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.post('/referral/generate', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const existing = await dbq('SELECT referral_code FROM users WHERE phone = $1', [phone]);
    if (existing.rows[0]?.referral_code) {
      return res.json({ referral_code: existing.rows[0].referral_code });
    }
    let code;
    for (let attempt = 0; attempt < 10; attempt++) {
      code = generateReferralCode();
      const dup = await dbq('SELECT 1 FROM users WHERE referral_code = $1', [code]);
      if (dup.rows.length === 0) break;
    }
    await dbq('UPDATE users SET referral_code = $1 WHERE phone = $2', [code, phone]);
    // Firestore mirror: referral code on the user + referrals index.
    {
      const fUid = await firestore.resolveUid(phone);
      if (fUid) {
        await firestore.set('users/' + fUid, { referralCode: code }, { merge: true });
        await firestore.set('referrals/' + code, { uid: fUid, identifier: phone, createdAt: new Date() }, { merge: true });
      }
    }
    res.json({ referral_code: code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/referral/my-code/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    let code = null;
    let result = await dbq('SELECT referral_code FROM users WHERE phone = $1', [phone]);
    if (!result.rows[0]?.referral_code) {
      for (let attempt = 0; attempt < 10; attempt++) {
        code = generateReferralCode();
        const dup = await dbq('SELECT 1 FROM users WHERE referral_code = $1', [code]);
        if (dup.rows.length === 0) break;
      }
      await dbq('UPDATE users SET referral_code = $1 WHERE phone = $2', [code, phone]);
    } else {
      code = result.rows[0].referral_code;
    }
    // Firestore mirror (best-effort) — also the DB-less source of truth.
    {
      const fUid = await firestore.resolveUid(phone);
      if (fUid && code) {
        await firestore.set('users/' + fUid, { referralCode: code }, { merge: true });
        await firestore.set('referrals/' + code, { uid: fUid, identifier: phone, createdAt: new Date() }, { merge: true });
      }
    }
    res.json({ referral_code: code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/referral/apply', async (req, res) => {
  try {
    const { phone, code } = req.body;
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
    res.status(500).json({ error: e.message });
  }
});

app.get('/meals/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const result = await dbq('SELECT * FROM meals WHERE phone = $1 ORDER BY date DESC', [phone]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Meal restore/remove aliases the app actually calls ─────────────────
// The app's MealSyncService always used GET /meals/list/:phone and
// POST /meals/remove, which never existed on the server (restore and delete
// were silently 404ing). These mirror the Postgres + Firestore behaviour.
app.get('/meals/list/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const result = await dbq('SELECT * FROM meals WHERE phone = $1 ORDER BY date DESC', [phone]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/meals/remove', async (req, res) => {
  try {
    const { phone, meal_id } = req.body;
    if (!phone || !meal_id) return res.status(400).json({ error: 'Phone and meal_id required' });
    await dbq('DELETE FROM meals WHERE id = $1 AND phone = $2', [meal_id, phone]);
    // Firestore mirror (best-effort)
    const fUid = await firestore.resolveUid(phone);
    if (fUid) {
      await firestore.del('meals/' + meal_id);
    }
    res.json({ removed: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/meals/sync', async (req, res) => {
  try {
    const { phone, meals, meal } = req.body;
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
    res.status(500).json({ error: e.message });
  }
});

// ─── Habits & Water Log backup ────────────────────────────────────────
// Stores the user's full habit list + water log as JSON so the app can
// restore them after a reinstall. The Flutter app's MealSyncService hits
// /habits/sync and /habits/list/:phone — these were MISSING, which is why
// synced habits never came back after reinstalling the app.
app.post('/habits/sync', async (req, res) => {
  try {
    const { phone, habits, water_log, water_goal } = req.body;
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
    res.status(500).json({ error: e.message });
  }
});

app.get('/habits/list/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
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
    res.status(500).json({ error: e.message });
  }
});

app.post('/subscribe', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    await dbq('INSERT INTO users (phone, subscribed) VALUES ($1, true) ON CONFLICT (phone) DO UPDATE SET subscribed = true', [phone]);
    // Firestore mirror (best-effort).
    {
      const fUid = await firestore.resolveUid(phone);
      if (fUid) await firestore.set('users/' + fUid, { subscribed: true }, { merge: true });
    }
    res.json({ subscribed: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/unsubscribe', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    await dbq('UPDATE users SET subscribed = false WHERE phone = $1', [phone]);
    // Firestore mirror (best-effort).
    {
      const fUid = await firestore.resolveUid(phone);
      if (fUid) await firestore.set('users/' + fUid, { subscribed: false }, { merge: true });
    }
    res.json({ subscribed: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Razorpay: Create Recurring Subscription ───────────────────────────────
// Real ₹29/month recurring billing: creates a Razorpay Subscription (auto-
// charges every month) instead of a one-time order. The app opens checkout
// with the returned subscription_id; Razorpay then charges the customer
// automatically each billing cycle and fires webhooks we verify below.
app.post('/payment/create-subscription', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    if (!process.env.RAZORPAY_KEY_ID) {
      return res.status(500).json({ error: 'Razorpay not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env' });
    }

    const planId = await getPlanId();

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 12, // 12 monthly charges; user can cancel anytime
      customer_notify: 1,
      // NOTE: do NOT pass a `customer` block here — Razorpay's Subscriptions
      // API rejects it ("customer is/are not required and should not be
      // sent"). The customer is created/attached automatically when the user
      // completes checkout. The phone travels in `notes` so webhooks can
      // still map the subscription back to the user.
      notes: { phone },
    });

    // Track the subscription → phone mapping so webhooks can find the user.
    await dbq(
      `INSERT INTO subscriptions (id, phone, status) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone, status = EXCLUDED.status`,
      [subscription.id, phone, subscription.status || 'created']
    );

    res.json({
      subscription_id: subscription.id,
      amount: 2900,
      currency: 'INR',
      razorpay_key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Razorpay: Verify Payment (order or subscription) ──────────────────────
// Supports both the legacy one-time order flow and the new recurring
// subscription flow. Signature format differs:
//   order:        HMAC(order_id|payment_id)
//   subscription: HMAC(subscription_id|payment_id)
app.post('/payment/verify', async (req, res) => {
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
    const body = `${signingId}|${razorpay_payment_id}`;
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
    res.status(500).json({ error: e.message });
  }
});

// ─── Razorpay: Cancel Recurring Subscription ───────────────────────────────
// Called from the app's "Cancel Subscription" button. Stops the recurring
// ₹29/month plan AT RAZORPAY so future auto-charges end — cancelling must
// never be only a local flag flip, or the customer keeps getting billed.
//
// Refund of already-charged months is deliberately NOT here: that is a
// separate, merchant-initiated action from the Razorpay dashboard (or API)
// and must never run automatically from a user-facing endpoint.
app.post('/payment/cancel-subscription', async (req, res) => {
  try {
    const { phone, email, subscription_id } = req.body || {};
    const identifier = phone || email;
    if (!identifier) return res.status(400).json({ error: 'Phone or email required' });
    if (!razorpay) {
      return res.status(500).json({ error: 'Razorpay not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env' });
    }

    // Resolve the subscription to cancel: the caller-provided id, the id
    // saved on the user row at activation, or the newest one on record.
    let subscriptionId = subscription_id;
    if (!subscriptionId) {
      const user = await dbq('SELECT subscription_id FROM users WHERE phone = $1', [identifier]);
      subscriptionId = (user.rows[0] || {}).subscription_id || null;
    }
    if (!subscriptionId) {
      const row = await dbq(
        `SELECT id FROM subscriptions
         WHERE phone = $1 AND status IN ('created','authenticated','active','paused','halted')
         ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [identifier]
      );
      subscriptionId = (row.rows[0] || {}).id || null;
    }

    if (!subscriptionId) {
      // Nothing on record to cancel — the user is already free. Idempotent:
      // repeat taps / double requests must never error.
      return res.json({ success: true, cancelled: false, message: 'No active subscription found' });
    }

    // Stop future charges at Razorpay. If the plan is already in a terminal
    // state (completed / already cancelled / expired) Razorpay rejects the
    // cancel — that's fine, nothing left to stop, so we treat it as success
    // and still sync our own state below (idempotent with the
    // subscription.cancelled webhook).
    let cancelledAtRazorpay = false;
    try {
      await razorpay.subscriptions.cancel(subscriptionId);
      cancelledAtRazorpay = true;
    } catch (e) {
      const desc = `${(e && (e.error && e.error.description)) || (e && e.message) || ''}`.toLowerCase();
      const terminal = /already cancelled|already been cancelled|cannot be cancelled|not in (a )?(created|authenticated|active)|completed|expired/i.test(desc);
      if (!terminal) throw e;
    }

    // Local deactivation (Postgres + Firestore mirror, best-effort like the
    // webhook paths). Clearing subscription_id means the next cancel call is
    // a clean idempotent no-op.
    await dbq(
      'UPDATE users SET subscribed = false, subscription_id = NULL WHERE phone = $1',
      [identifier]
    );
    await dbq(
      'UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE id = $2',
      ['cancelled', subscriptionId]
    );
    try {
      const fUid = await firestore.resolveUid(identifier);
      if (fUid) {
        await firestore.set('users/' + fUid, { subscribed: false }, { merge: true });
        await firestore.set('subscriptions/' + subscriptionId, { uid: fUid, identifier, status: 'cancelled', updatedAt: new Date() }, { merge: true });
      }
    } catch (_) {}

    res.json({ success: true, cancelled: true, cancelledAtRazorpay, subscription_id: subscriptionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    if (!subscriptionId) return res.json({ received: true });

    // Find the phone for this subscription (fall back to payment notes).
    let phone = null;
    try {
      const row = await dbq('SELECT phone FROM subscriptions WHERE id = $1', [subscriptionId]);
      phone = row.rows[0]?.phone || null;
    } catch (_) {}
    if (!phone && payment?.notes?.phone) phone = payment.notes.phone;
    if (!phone) return res.json({ received: true });

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

    if (turnOn) {
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
    }

    res.json({ received: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



app.get('/payment/status/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await dbq('SELECT subscribed FROM users WHERE phone = $1', [phone]);
    const payments = await dbq(
      'SELECT * FROM payments WHERE phone = $1 ORDER BY created_at DESC LIMIT 1',
      [phone]
    );
    res.json({
      subscribed: user.rows[0]?.subscribed || false,
      payment: payments.rows[0] || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Subscription verification (Firestore first, Postgres fallback) ------
app.get('/subscription/status', async (req, res) => {
  try {
    const { phone, email } = req.query;
    if (!phone && !email) return res.status(400).json({ error: 'Phone or email required' });
    const identifier = phone || email;

    // The owner is always subscribed.
    if (isAdminUser(identifier)) return res.json({ subscribed: true });

    // Firestore is the source of truth (Phase 3) — check users/{uid} first.
    const fUid = await firestore.resolveUid(identifier);
    if (fUid && firestore.isEnabled()) {
      try {
        const doc = await firestore.getDb().collection('users').doc(fUid).get();
        if (doc.exists && doc.data().subscribed === true) {
          return res.json({ subscribed: true });
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
    res.json({ subscribed: user?.subscribed || false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Vercel (serverless) imports this module as the request handler; local /
// Railway runs call listen() directly.
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`MacroSnap server on port ${port}`));
}

module.exports = app;
