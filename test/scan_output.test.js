'use strict';
// Tests for the AI-output sanitizers behind /analyze.
//
// The model is asked for numbers and usually sends numbers, but it also sends
// "250 kcal", "~150 g", null or an object. The app casts these with `as num`,
// so a single string used to throw a TypeError while building the result card
// — after the scan had already been charged. These tests pin the guarantee
// that whatever the model says, the app receives a bounded number.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// ── Minimal module stubs: enough for server.js to load ──────────────────
const routes = { get: {}, post: {}, delete: {} };
const appStub = {
  use: () => {},
  get: (p, ...fns) => { routes.get[p] = fns[fns.length - 1]; },
  post: (p, ...fns) => { routes.post[p] = fns[fns.length - 1]; },
  delete: (p, ...fns) => { routes['delete'][p] = fns[fns.length - 1]; },
  listen: () => {},
};
function express() { return appStub; }
express.json = () => (req, res, next) => next();
express.static = () => () => {};
function multer() { return { single: () => (req, res, next) => next() }; }
multer.memoryStorage = () => ({});

const firestoreStub = {
  init: () => true,
  isEnabled: () => false,
  resolveUid: async () => null,
  set: async () => false,
  del: async () => false,
  getDb: () => null,
  getAdmin: () => null,
};

const origLoad = Module._load;
Module._load = function (request) {
  switch (request) {
    case 'dotenv': return { config: () => ({}) };
    case 'express': return express;
    case 'multer': return multer;
    case 'sharp': return (buf) => ({ jpeg: () => ({ toBuffer: async () => buf }) });
    case 'pg': return { Pool: class { query() { return { rows: [] }; } } };
    case 'razorpay': return class {};
    case './firestore': return firestoreStub;
    default: return origLoad.apply(this, arguments);
  }
};

process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
delete process.env.DATABASE_URL;

const app = require('../server.js');
const {
  numOr,
  clampRange,
  cleanText,
  cleanSuitableFor,
  macrosFrom,
  clampGrams,
  normalizeIngredients,
  dishGramsFrom,
  totalGramsFrom,
} = app._scanSanitizers;

test('numOr reads a number out of the model\'s usual slips', () => {
  assert.equal(numOr(250), 250);
  assert.equal(numOr('250'), 250);
  assert.equal(numOr('250 kcal'), 250);
  assert.equal(numOr('12 g per 100 g'), 12);
  assert.equal(numOr(undefined, 7), 7);
  assert.equal(numOr(null, 7), 7);
  assert.equal(numOr('abc', 0), 0);
  assert.equal(numOr({}, 0), 0);
  assert.equal(numOr([], 0), 0);
  assert.equal(numOr(Infinity, 0), 0);
  assert.equal(numOr(NaN, 0), 0);
});

test('clampRange keeps a value inside what is physically possible', () => {
  assert.equal(clampRange(5000, 0, 900), 900);
  assert.equal(clampRange(-20, 0, 900), 0);
  assert.equal(clampRange('250 kcal', 0, 900), 250);
  assert.equal(clampRange('nonsense', 0, 900, 0), 0);
});

test('macros are always bounded numbers — never a string the app would crash on', () => {
  const m = macrosFrom({
    calories_per_100g: '250 kcal',
    protein_g_per_100g: '31 g',
    carbs_g_per_100g: '0',
    fats_g_per_100g: 500, // impossible: clamped to 100 g/100 g
    fiber_g_per_100g: -3,
    sugar_g_per_100g: 'n/a',
  });
  assert.deepEqual(m, {
    calories_per_100g: 250,
    protein_g_per_100g: 31,
    carbs_g_per_100g: 0,
    fats_g_per_100g: 100,
    fiber_g_per_100g: 0,
    sugar_g_per_100g: 0,
  });
  for (const [key, value] of Object.entries(m)) {
    assert.equal(typeof value, 'number', `${key} must be a number`);
    assert.ok(Number.isFinite(value), `${key} must be finite`);
  }
});

test('the legacy flat shape is read the same way', () => {
  const m = macrosFrom({ calories: '180', protein_g: '9' });
  assert.equal(m.calories_per_100g, 180);
  assert.equal(m.protein_g_per_100g, 9);
  assert.equal(m.fats_g_per_100g, 0);
});

test('names are trimmed, bounded strings — objects never reach the app', () => {
  assert.equal(cleanText('  Grilled chicken  '), 'Grilled chicken');
  assert.equal(cleanText({ name: 'cake' }, 'Unknown'), 'Unknown');
  assert.equal(cleanText(null, 'Unknown'), 'Unknown');
  assert.equal(cleanText(42, 'Unknown'), 'Unknown');
  assert.equal(cleanText('   ', 'Unknown'), 'Unknown');
  assert.equal(cleanText('x'.repeat(200)).length, 60);
});

test('suitable_for is one of the three values the card understands', () => {
  assert.equal(cleanSuitableFor('BULK'), 'bulk');
  assert.equal(cleanSuitableFor(' diet '), 'diet');
  assert.equal(cleanSuitableFor('keto'), 'both');
  assert.equal(cleanSuitableFor(undefined), 'both');
  assert.equal(cleanSuitableFor({}), 'both');
});

test('a dish weight is a whole number of grams inside the card\'s range', () => {
  assert.equal(clampGrams('150 g'), 150);
  assert.equal(clampGrams(0), 0);
  assert.equal(clampGrams(-5), 0);
  assert.equal(clampGrams(99999), 5000);
  assert.equal(clampGrams('n/a'), 0);
});

test('ingredients drop nameless rows and clamp the rest', () => {
  const out = normalizeIngredients([
    { name: '  ', grams: 10 },
    { name: 'Chicken breast', grams: '150 g', health_score: '4' },
    { name: 'Dressing', grams: 10, health_score: 99 },
    null,
    'not an object',
    { name: { nested: true }, grams: 5 },
  ]);
  assert.deepEqual(out, [
    { name: 'Chicken breast', grams: 150, health_score: 4 },
    { name: 'Dressing', grams: 10, health_score: 5 },
  ]);
});

test('a non-array ingredient list is simply empty', () => {
  assert.deepEqual(normalizeIngredients(undefined), []);
  assert.deepEqual(normalizeIngredients('chicken'), []);
  assert.deepEqual(normalizeIngredients({ name: 'x' }), []);
});

// ── Weights must describe the photo, not the nutrition table ────────────
// A single egg that arrives as "100 g" logs 143 kcal for one egg. The model
// is asked for real per-photo weights; these helpers are what keeps the card
// honest when it half-obeys.

test('dishGramsFrom trusts the dish weight the model sent', () => {
  assert.equal(dishGramsFrom({ grams: 55 }, []), 55);
  assert.equal(dishGramsFrom({ grams: '150 g' }, [{ grams: 10 }]), 150);
});

test('dishGramsFrom falls back to the sum of the component weights', () => {
  assert.equal(
    dishGramsFrom({ grams: 'n/a' }, [{ grams: 55 }]),
    55,
    'one egg ingredient sums to the egg'
  );
  assert.equal(
    dishGramsFrom({}, [{ grams: 40 }, { grams: 15 }]),
    55
  );
  assert.equal(
    dishGramsFrom({}, [{ grams: 99999 }]),
    5000,
    'the sum is clamped like any weight'
  );
  assert.equal(dishGramsFrom({}, []), 0);
  assert.equal(dishGramsFrom({}, [{ grams: 0 }]), 0);
});

test('totalGramsFrom prefers the model total, then the dish sum, then unknown', () => {
  assert.equal(totalGramsFrom({ total_grams: 55 }, [{ grams: 99 }]), 55);
  assert.equal(totalGramsFrom({ total_grams: '110 g' }, []), 110);
  assert.equal(totalGramsFrom({ total_grams: 99999 }, []), 3000);
  assert.equal(totalGramsFrom({}, [{ grams: 45 }, { grams: 10 }]), 55);
  assert.equal(totalGramsFrom({}, []), 0, '0 means unknown — the caller keeps 100 g');
});
