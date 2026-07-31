require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { Pool } = require('pg');

const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.get('/', (req, res) => res.send('OK'));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(200).json({ ok: true });
  next(err);
});

async function initDB(retries = 5) {
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
        `);
        try { await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT'); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT DEFAULT ''"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS scan_count INTEGER DEFAULT 0"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS scan_month INTEGER DEFAULT 0"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT"); } catch (_) {}
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT"); } catch (_) {}
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

app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const phone = req.body?.phone || '';
    if (phone) {
      const now = new Date();
      const currentMonth = now.getFullYear() * 12 + now.getMonth();
      const user = await pool.query('SELECT subscribed, scan_count, scan_month FROM users WHERE phone = $1', [phone]);
      if (user.rows.length > 0) {
        const { subscribed, scan_count, scan_month } = user.rows[0];
        if (!subscribed) {
          if (scan_month !== currentMonth) {
            await pool.query('UPDATE users SET scan_count = 0, scan_month = $1 WHERE phone = $2', [currentMonth, phone]);
          }
          const count = scan_month === currentMonth ? (scan_count || 0) : 0;
          if (count >= SCAN_LIMIT_FREE) {
            return res.status(403).json({ error: 'scan_limit_reached', scans_used: count, scans_limit: SCAN_LIMIT_FREE });
          }
        }
      } else {
        await pool.query('INSERT INTO users (phone, scan_count, scan_month) VALUES ($1, 0, $2) ON CONFLICT (phone) DO NOTHING', [phone, currentMonth]);
      }
    }

    const key = process.env.GEMINI_KEY;
    const jpegBuffer = await prepareImage(req.file.buffer, req.file.mimetype);
    const base64 = jpegBuffer.toString('base64');

    const body = JSON.stringify({
      contents: [{
        parts: [
          { text: `You are a professional Indian nutritionist. The photo likely contains one or more food items (e.g. a full thali). Identify EVERY visible dish and return ONLY valid JSON:
{
  "description": "brief summary of what was detected",
  "confidence": estimated accuracy 0-1,
  "dishes": [
    {
      "name": "dish name in English",
      "portion_description": "estimated portion like '1 small katori' or '2 rotis'",
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
Rules: 1 dish entry per visible item (rice, dal, sabzi, roti, salad, curd, pickle). Be specific about portions. Use Indian food data. Return ONLY raw JSON. No markdown. No backticks.` },
          { inlineData: { mimeType: 'image/jpeg', data: base64 } }
        ]
      }]
    });

    const resp = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
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

    if (phone) {
      await pool.query(
        'UPDATE users SET scan_count = COALESCE(scan_count, 0) + 1 WHERE phone = $1',
        [phone]
      );
    }

    const now = new Date();
    const currentMonth = now.getFullYear() * 12 + now.getMonth();
    const updated = phone ? await pool.query('SELECT scan_count FROM users WHERE phone = $1', [phone]) : null;
    const scansUsed = updated?.rows[0]?.scan_count || 0;

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
TDEE: ${tdee.round()} kcal, Target: ${calTarget.round()} kcal/day.
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
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
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

    res.json({ bmi: bmi.toFixed(1), bmr: bmr.round(), tdee: tdee.round(), targetCalories: calTarget.round(), targetProtein: proteinTarget.toFixed(0), targetCarbs: carbTarget.toFixed(0), targetFats: fatTarget.toFixed(0), plan });
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
      await pool.query(
        'INSERT INTO users (phone, email, name) VALUES ($1, $2, $3) ON CONFLICT (phone) DO UPDATE SET email = $2, name = $3',
        [identifier, email, name]
      );
    } else {
      await pool.query('INSERT INTO users (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING', [identifier]);
    }
    const user = await pool.query('SELECT * FROM users WHERE phone = $1', [identifier]);
    res.json({ phone: user.rows[0].phone, subscribed: user.rows[0].subscribed });
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
    const existing = await pool.query('SELECT referral_code FROM users WHERE phone = $1', [phone]);
    if (existing.rows[0]?.referral_code) {
      return res.json({ referral_code: existing.rows[0].referral_code });
    }
    let code;
    for (let attempt = 0; attempt < 10; attempt++) {
      code = generateReferralCode();
      const dup = await pool.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
      if (dup.rows.length === 0) break;
    }
    await pool.query('UPDATE users SET referral_code = $1 WHERE phone = $2', [code, phone]);
    res.json({ referral_code: code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/referral/my-code/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    let result = await pool.query('SELECT referral_code FROM users WHERE phone = $1', [phone]);
    if (!result.rows[0]?.referral_code) {
      let code;
      for (let attempt = 0; attempt < 10; attempt++) {
        code = generateReferralCode();
        const dup = await pool.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
        if (dup.rows.length === 0) break;
      }
      await pool.query('UPDATE users SET referral_code = $1 WHERE phone = $2', [code, phone]);
      result = await pool.query('SELECT referral_code FROM users WHERE phone = $1', [phone]);
    }
    res.json({ referral_code: result.rows[0].referral_code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/referral/apply', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });
    const referrer = await pool.query('SELECT phone, subscribed FROM users WHERE referral_code = $1', [code.toUpperCase()]);
    if (referrer.rows.length === 0) return res.status(404).json({ error: 'Invalid referral code' });
    if (referrer.rows[0].phone === phone) return res.status(400).json({ error: 'Cannot use your own code' });
    const newUser = await pool.query('SELECT referred_by FROM users WHERE phone = $1', [phone]);
    if (newUser.rows[0]?.referred_by) return res.status(400).json({ error: 'Already used a referral code' });
    await pool.query('UPDATE users SET referred_by = $1, subscribed = true WHERE phone = $2', [code.toUpperCase(), phone]);
    await pool.query('UPDATE users SET subscribed = true WHERE phone = $1', [referrer.rows[0].phone]);
    res.json({ subscribed: true, referrer: referrer.rows[0].phone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/meals/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const result = await pool.query('SELECT * FROM meals WHERE phone = $1 ORDER BY date DESC', [phone]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/meals/sync', async (req, res) => {
  try {
    const { phone, meals } = req.body;
    if (!phone || !meals) return res.status(400).json({ error: 'Phone and meals required' });
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM meals WHERE phone = $1', [phone]);
      for (const meal of meals) {
        await client.query(
          `INSERT INTO meals (id, phone, date, name, category, calories, protein, carbs, fats, fiber, serving)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
          [meal.id, phone, meal.date, meal.name, meal.category, meal.calories, meal.protein, meal.carbs, meal.fats, meal.fiber, meal.serving]
        );
      }
    } finally {
      client.release();
    }
    res.json({ synced: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/subscribe', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    await pool.query('INSERT INTO users (phone, subscribed) VALUES ($1, true) ON CONFLICT (phone) DO UPDATE SET subscribed = true', [phone]);
    res.json({ subscribed: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/unsubscribe', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    await pool.query('UPDATE users SET subscribed = false WHERE phone = $1', [phone]);
    res.json({ subscribed: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Razorpay: Create Order ────────────────────────────────────────────────
app.post('/payment/create-order', async (req, res) => {
  try {
    const { phone, amount, currency } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    if (!process.env.RAZORPAY_KEY_ID) {
      return res.status(500).json({ error: 'Razorpay not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env' });
    }

    const options = {
      amount: amount || 2900, // ₹29 in paise by default
      currency: currency || 'INR',
      receipt: `macrosnap_${phone}_${Date.now()}`,
      notes: { phone },
    };

    const order = await razorpay.orders.create(options);

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      razorpay_key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Razorpay: Verify Payment ──────────────────────────────────────────────
app.post('/payment/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify signature using HMAC SHA256
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
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
      await pool.query(
        `INSERT INTO payments (phone, transaction_ref, amount, status)
         VALUES ($1, $2, $3, 'approved')`,
        [phone, razorpay_payment_id, (payment.amount || 2900) / 100]
      );
    } catch (e) {
      console.error('Payment insert failed:', e.message);
    }

    // Activate subscription
    await pool.query(
      'INSERT INTO users (phone, subscribed) VALUES ($1, true) ON CONFLICT (phone) DO UPDATE SET subscribed = true',
      [phone]
    );

    res.json({ success: true, subscribed: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



app.get('/payment/status/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await pool.query('SELECT subscribed FROM users WHERE phone = $1', [phone]);
    const payments = await pool.query(
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

// --- Subscription verification (source of truth: Postgres) ---------------
app.get('/subscription/status', async (req, res) => {
  try {
    const { phone, email } = req.query;
    if (!phone && !email) return res.status(400).json({ error: 'Phone or email required' });
    // Prefer the phone match (phone is the PK), then fall back to email so a
    // matching email can never resolve to a different user's row.
    let user = null;
    if (phone) {
      const r = await pool.query('SELECT subscribed FROM users WHERE phone = $1 LIMIT 1', [phone]);
      user = r.rows[0] || null;
    }
    if (!user && email) {
      const r = await pool.query('SELECT subscribed FROM users WHERE email = $1 LIMIT 1', [email]);
      user = r.rows[0] || null;
    }
    res.json({ subscribed: user?.subscribed || false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MacroSnap server on port ${port}`));
