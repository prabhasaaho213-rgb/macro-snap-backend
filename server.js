require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { Pool } = require('pg');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
