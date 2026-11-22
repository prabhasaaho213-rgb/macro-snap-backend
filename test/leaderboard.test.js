'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lb = require('../leaderboard');

test('the daily table matches the app exactly', () => {
  assert.equal(lb.DAILY_MAX, 90);
  assert.equal(lb.WEEK_MAX, 630);
  assert.equal(lb.POINTS.meal, 10);
  assert.equal(lb.POINTS.habit, 5);
  assert.equal(lb.POINTS.stepGoal, 20);
  assert.equal(lb.POINTS.weighIn, 5);
});

test('a full day is worth 90 and never more', () => {
  const day = lb.scoreDay({
    mealCount: 3,
    calorieGoalMet: true,
    completedHabits: 3,
    waterGlasses: 8,
    waterGoal: 8,
    steps: 20000,
    stepGoal: 10000,
    weighedIn: true,
  });
  assert.equal(day.points, 90);
  assert.deepEqual(day.buckets, {
    nutrition: 40,
    habits: 15,
    hydration: 10,
    movement: 20,
    body: 5,
  });
});

test('absurd client facts are clamped to the table', () => {
  const day = lb.scoreDay({
    mealCount: 9999,
    completedHabits: 9999,
    waterGlasses: 99999,
    waterGoal: 1,
    steps: 100000000,
    stepGoal: 1,
    weighedIn: true,
    calorieGoalMet: true,
  });
  assert.equal(day.points, 90);
});

test('steps only pay when the goal is reached, and the goal is snapped', () => {
  assert.equal(
    lb.scoreDay({ steps: 9999, stepGoal: 10000 }).buckets.movement,
    0
  );
  assert.equal(
    lb.scoreDay({ steps: 10000, stepGoal: 10000 }).buckets.movement,
    20
  );
  // A goal outside the offered range is replaced by the default, never
  // lowered to make the 20-point award free.
  assert.equal(lb.normalizeStepGoal(1), 10000);
  assert.equal(lb.normalizeStepGoal(2500), 5000);
  assert.equal(lb.normalizeStepGoal(70000), 10000);
  assert.equal(lb.normalizeStepGoal('15000'), 15000);
});

test('hydration pays per glass plus the goal bonus, capped at 10', () => {
  assert.equal(lb.scoreDay({ waterGlasses: 3, waterGoal: 0 }).points, 3);
  assert.equal(lb.scoreDay({ waterGlasses: 8, waterGoal: 8 }).points, 10);
  assert.equal(lb.scoreDay({ waterGlasses: 40, waterGoal: 40 }).points, 10);
});

test('no facts, no points — a zero day cannot be inflated', () => {
  assert.equal(lb.scoreDay({}).points, 0);
  assert.equal(lb.scoreDay(null).points, 0);
});

test('a week is the seven days of the IST Monday–Sunday week', () => {
  // 2026-11-22T20:00Z is 2026-11-23 01:30 IST — Monday of the next week.
  const { week, dates } = lb.isoWeek(new Date('2026-11-22T20:00:00Z'));
  assert.equal(week, '2026-W48');
  assert.equal(dates.length, 7);
  assert.equal(dates[0], '2026-11-23');
  assert.equal(dates[6], '2026-11-29');
  assert.equal(lb.todayKey(new Date('2026-11-22T20:00:00Z')), '2026-11-23');
});

test('a day is the IST day, not the server day', () => {
  // 18:29Z is still the same date in IST; 18:31Z is the next day.
  assert.equal(lb.todayKey(new Date('2026-11-22T18:29:00Z')), '2026-11-22');
  assert.equal(lb.todayKey(new Date('2026-11-22T18:31:00Z')), '2026-11-23');
});

test('day arithmetic crosses month and year boundaries', () => {
  assert.equal(lb.addDays('2026-11-22', 1), '2026-11-23');
  assert.equal(lb.addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(lb.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(lb.addDays('2028-02-28', 1), '2028-02-29');
});

test('only known states and safe scopes are accepted', () => {
  assert.equal(lb.stateKey('Maharashtra'), 'maharashtra');
  assert.equal(lb.stateKey('atlantis'), null);
  assert.equal(lb.stateKey(null), null);
  assert.ok(lb.isValidScope('india'));
  assert.ok(lb.isValidScope('district_maharashtra_pune'));
  assert.ok(!lb.isValidScope('../../etc'));
  assert.ok(!lb.isValidScope('scopes'));
});

test('board scopes match the app paths', () => {
  assert.deepEqual(
    lb.boardsFor('maharashtra', lb.slug('Pune City')),
    ['india', 'state_maharashtra', 'district_maharashtra_pune-city']
  );
});

test('meal dates are read from both app and backend shapes', () => {
  assert.equal(lb.mealDayKey({ date: '2026-11-22T09:15:00.000' }), '2026-11-22');
  const ts = { toDate: () => new Date('2026-11-22T18:00:00Z') };
  // 18:00Z is 23:30 IST — still the 22nd.
  assert.equal(lb.mealDayKey({ date: ts }), '2026-11-22');
  assert.equal(lb.mealDayKey({}), null);
});

test('names are clamped and control characters stripped', () => {
  assert.equal(lb.publicName('  Asha  '), 'Asha');
  assert.equal(lb.publicName('a\u0000b'), 'ab');
  assert.equal(lb.publicName(''), 'MacroSnap user');
  assert.equal(lb.publicName('x'.repeat(80)).length, 40);
});

// ─── Hardening: names, steps, calorie target, week dates ──────────────────

const { test: t2 } = require('node:test');

t2('a display name cannot impersonate the app', () => {
  assert.equal(lb.publicName('MacroSnap Support'), 'MacroSnap user');
  assert.equal(lb.publicName('  macrosnap  '), 'MacroSnap user');
  assert.equal(lb.publicName('Admin'), 'MacroSnap user');
  assert.equal(lb.publicName('Rahul'), 'Rahul');
});

t2('bidi and zero-width characters are stripped from a name', () => {
  assert.equal(lb.publicName('Ram\u202Etino'), 'Ramtino');
  assert.equal(lb.publicName('A\u200Bb\u200Bc'), 'Abc');
  assert.equal(lb.publicName('  too    many   spaces '), 'too many spaces');
});

t2('a clashing name gets a stable per-account tag', () => {
  const first = lb.uniqueName('Rahul', 'uid-one', ['Rahul']);
  assert.match(first, /^Rahul #[0-9a-f]{4}$/);
  assert.equal(lb.uniqueName('Rahul', 'uid-one', ['Rahul']), first);
  assert.notEqual(lb.uniqueName('Rahul', 'uid-two', ['Rahul']), first);
  assert.equal(lb.uniqueName('Rahul', 'uid-one', ['Rahul S']), 'Rahul');
  // The suffix never pushes the name past the 40-character limit.
  assert.ok(lb.uniqueName('x'.repeat(40), 'uid-one', ['x'.repeat(40)]).length <= 40);
});

t2('a step claim is bounded by how much of the day has passed', () => {
  // 00:30 IST = 2026-01-01T19:00Z
  assert.equal(
    lb.stepCeiling(new Date('2026-01-01T19:00:00Z')),
    lb.STEP_BASE_ALLOWANCE + lb.STEP_PER_HOUR / 2
  );
  // 12:00 IST
  assert.equal(
    lb.stepCeiling(new Date('2026-01-02T06:30:00Z')),
    lb.STEP_BASE_ALLOWANCE + 12 * lb.STEP_PER_HOUR
  );
  // Late in the day the ceiling is generous but still a ceiling.
  const late = lb.stepCeiling(new Date('2026-01-02T17:00:00Z'));
  assert.ok(late <= 200000);
  assert.ok(late > 12 * lb.STEP_PER_HOUR);
});

t2('the calorie target is recomputed from the stored profile', () => {
  const maintain = lb.dietTargetCalories({
    weightKg: 70,
    heightCm: 175,
    age: 30,
    gender: 'male',
    goal: 'maintain',
    activity: 'sedentary',
  });
  assert.ok(maintain > 1900 && maintain < 2050, `got ${maintain}`);

  // A small sedentary user on a deficit is floored at the safe minimum, not at
  // 822 kcal.
  const loss = lb.dietTargetCalories({
    weightKg: 45,
    heightCm: 150,
    age: 25,
    gender: 'female',
    goal: 'loseWeight',
    activity: 'sedentary',
  });
  assert.equal(loss, 1200);

  assert.equal(lb.dietTargetCalories(null), 0);
  assert.equal(lb.dietTargetCalories({ weightKg: 0 }), 0);
});

t2('a week id maps to the Monday it starts on', () => {
  assert.equal(lb.weekStartDate('2026-W47'), '2026-11-16');
  assert.equal(lb.weekStartDate('2026-W48'), '2026-11-23');
  assert.equal(lb.weekStartDate('2025-W01'), '2024-12-30');
  assert.equal(lb.weekStartDate('nonsense'), null);
});
