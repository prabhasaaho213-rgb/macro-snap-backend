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
  "sugar_g_per_100g": sugar in grams per 100g as number,
  "suitable_for": "bulk" if high protein/calories, "diet" if low calorie/low fat, "both" if balanced,
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
      sugar_g_per_100g: json.sugar_g_per_100g ?? 0,
      suitable_for: json.suitable_for || 'both',
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

app.post('/payment/request', async (req, res) => {
  try {
    const { phone, transaction_ref } = req.body;
    if (!phone || !transaction_ref) return res.status(400).json({ error: 'Phone and transaction_ref required' });
    const result = await pool.query(
      'INSERT INTO payments (phone, transaction_ref) VALUES ($1, $2) RETURNING *',
      [phone, transaction_ref]
    );
    res.json({ id: result.rows[0].id, status: 'pending' });
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

app.get('/admin', async (req, res) => {
  try {
    const payments = await pool.query(
      "SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at DESC"
    );
    const html = `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width"><title>MacroSnap Admin</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #f5f7fa; padding: 24px; }
  h1 { font-size: 22px; margin-bottom: 20px; color: #1a1a2e; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  th, td { padding: 12px 16px; text-align: left; font-size: 14px; }
  th { background: #059669; color: white; font-weight: 600; }
  tr { border-bottom: 1px solid #e2e8f0; }
  tr:hover { background: #f8fafc; }
  .btn { display: inline-block; padding: 6px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; text-decoration: none; }
  .btn-approve { background: #059669; color: white; }
  .btn-reject { background: #f43f5e; color: white; margin-left: 6px; }
  .empty { text-align: center; padding: 40px; color: #94a3b8; font-size: 15px; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; background: #fef3c7; color: #92400e; }
  .badge-approved { background: #d1fae5; color: #065f46; }
  .badge-rejected { background: #fee2e2; color: #991b1b; }
</style></head><body>
<h1>&#128274; MacroSnap Payment Approvals</h1>
<div style="margin-bottom: 16px; display: flex; gap: 12px;">
  <a href="/admin" style="text-decoration: none; padding: 8px 16px; background: #059669; color: white; border-radius: 8px; font-size: 13px; font-weight: 600;">Pending</a>
  <a href="/admin?filter=approved" style="text-decoration: none; padding: 8px 16px; background: #e2e8f0; color: #475569; border-radius: 8px; font-size: 13px; font-weight: 600;">Approved</a>
  <a href="/admin?filter=all" style="text-decoration: none; padding: 8px 16px; background: #e2e8f0; color: #475569; border-radius: 8px; font-size: 13px; font-weight: 600;">All</a>
</div>
${payments.rows.length === 0 ? '<div class="empty">No pending payments</div>' : `
<table>
<tr><th>ID</th><th>Phone</th><th>Transaction Ref</th><th>Amount</th><th>Date</th><th>Action</th></tr>
${payments.rows.map(p => `<tr>
<td>#${p.id}</td><td>${p.phone}</td><td><strong>${p.transaction_ref}</strong></td>
<td>\u20B9${p.amount}</td><td>${new Date(p.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
<td>
  <form action="/admin/approve/${p.id}" method="POST" style="display:inline">
    <button class="btn btn-approve">Approve</button>
  </form>
  <form action="/admin/reject/${p.id}" method="POST" style="display:inline">
    <button class="btn btn-reject">Reject</button>
  </form>
</td></tr>`).join('')}
</table>`}
</body></html>`;
    res.type('html').send(html);
  } catch (e) {
    res.status(500).send('Error loading admin');
  }
});

app.post('/admin/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const pay = await pool.query('UPDATE payments SET status = $1 WHERE id = $2 RETURNING *', ['approved', id]);
    if (pay.rows.length > 0) {
      await pool.query(
        'INSERT INTO users (phone, subscribed) VALUES ($1, true) ON CONFLICT (phone) DO UPDATE SET subscribed = true',
        [pay.rows[0].phone]
      );
    }
    res.redirect('/admin');
  } catch (e) {
    res.status(500).send('Error approving payment');
  }
});

app.post('/admin/reject/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE payments SET status = $1 WHERE id = $2', ['rejected', id]);
    res.redirect('/admin');
  } catch (e) {
    res.status(500).send('Error rejecting payment');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MacroSnap server on port ${port}`));
