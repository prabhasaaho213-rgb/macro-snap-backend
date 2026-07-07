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

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY,
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
    console.log('Database tables ready');
  } finally {
    client.release();
  }
}
initDB();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

async function prepareImage(buffer, mimetype) {
  if (mimetype === 'image/jpeg') return buffer;
  return sharp(buffer).jpeg().toBuffer();
}

app.get('/razorpay-key', (req, res) => {
  res.json({ keyId: process.env.RAZORPAY_KEY_ID });
});

app.post('/create-order', async (req, res) => {
  try {
    const { amount } = req.body;
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: 'INR',
      receipt: 'sub_' + Date.now(),
      notes: { product: 'MacroSnap Pro Subscription' }
    });
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const body = razorpay_order_id + '|' + razorpay_payment_id;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
  if (expected === razorpay_signature) {
    res.json({ status: 'ok', subscribed: true });
  } else {
    res.status(400).json({ status: 'failed', subscribed: false });
  }
});

app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const key = process.env.GEMINI_KEY;
    const jpegBuffer = await prepareImage(req.file.buffer, req.file.mimetype);
    const base64 = jpegBuffer.toString('base64');

    const body = JSON.stringify({
      contents: [{
        parts: [
          { text: `You are a professional Indian nutritionist. Analyze this food photo and return ONLY valid JSON with these fields:
{
  "meal_name": "short meal name in English",
  "calories_per_100g": calories per 100g as integer,
  "protein_g_per_100g": protein in grams per 100g as number,
  "carbs_g_per_100g": carbohydrates in grams per 100g as number,
  "fats_g_per_100g": fat in grams per 100g as number,
  "fiber_g_per_100g": fiber in grams per 100g as number,
  "confidence": estimated accuracy between 0 and 1,
  "description": "brief description of what was detected"
}
Use Indian food composition data. Return ONLY raw JSON. No markdown. No backticks.` },
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

    const normalized = {
      meal_name: json.meal_name || 'Unknown',
      calories_per_100g: json.calories_per_100g ?? json.calories ?? 0,
      protein_g_per_100g: json.protein_g_per_100g ?? json.protein_g ?? 0,
      carbs_g_per_100g: json.carbs_g_per_100g ?? json.carbs_g ?? 0,
      fats_g_per_100g: json.fats_g_per_100g ?? json.fats_g ?? 0,
      fiber_g_per_100g: json.fiber_g_per_100g ?? json.fiber_g ?? 0,
      confidence: json.confidence ?? 0.7,
      description: json.description || ''
    };
    res.json(normalized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    await pool.query('INSERT INTO users (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING', [phone]);
    const user = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    res.json({ phone: user.rows[0].phone, subscribed: user.rows[0].subscribed });
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MacroSnap server on port ${port}`));
