// Server-side score computation for the weekly leaderboard.
//
// THE POINT OF THIS FILE: points are never accepted from the client. The app
// used to compute its own weekly total and write it straight to
// `leaderboard/{week}/scopes/{scope}/entries/{uid}` (up to 1,000 points), so
// anyone running a modified client could claim any score. Now the client only
// reports raw activity facts, the server applies the scoring table below, and
// the Firestore rules deny all client writes to the board.
//
// Which facts are authoritative?
//   * meals, habits, water — read from Firestore by the caller (the `meals`
//     and `habitData` documents the app already mirrors), so the client cannot
//     invent a count it did not log.
//   * weigh-in, calorie goal — not stored server-side anywhere, so the client
//     asserts them. Each is worth a fixed, small number of points and is
//     hard-capped here, which is the difference that matters: the worst a
//     tampered client can do is claim the same maximum a real user earns in
//     those buckets (5 + 10 a day), not an arbitrary week total.
//   * steps — persisted server-side in `stepLog/{uid}` by the sync route, so a
//     reinstall or a day the app was not opened still counts. The phone's step
//     sensor (not Health Connect) is the primary source, and the route keeps
//     the HIGHER of what it stored and what the client reports.
//
// The table mirrors lib/services/leaderboard_service.dart exactly. If one side
// changes, the other must too — test/leaderboard.test.js pins the numbers.
'use strict';

const crypto = require('crypto');

const POINTS = {
  meal: 10,
  mealDailyCap: 30,

  habit: 5,
  habitDailyCap: 15,

  waterPerGlass: 1,
  waterDailyCap: 5,
  waterGoalBonus: 5,
  hydrationDailyCap: 10,

  // Movement pays PER DISTANCE WALKED, not for crossing one target: every
  // 5,000 steps is 10 points. A user who walks 20,000 steps earns 40, the
  // same rate for everyone, and nothing is gated behind a goal they can
  // change. The cap (50,000 steps' worth) only exists so a corrupt or
  // tampered count cannot print an unbounded week total.
  stepsPerAward: 5000,
  stepAward: 10,
  movementDailyCap: 100,

  weighIn: 5,

  calorieGoal: 10,
  // Meals (30) + the calorie-goal bonus (10).
  nutritionDailyCap: 40,
};

// Meals (30) + habits (15) + hydration (10) + movement (100) + weigh-in (5) +
// the calorie goal (10).
const DAILY_MAX = 170;
const WEEK_MAX = DAILY_MAX * 7; // 1190

// The states/UT keys the app offers (lib/services/leaderboard_remote.dart).
// The key is part of the Firestore path, so it must be a known value rather
// than whatever string a client sent.
const STATE_KEYS = new Set([
  'andhra-pradesh',
  'arunachal-pradesh',
  'assam',
  'bihar',
  'chandigarh',
  'chhattisgarh',
  'dadra-nagar-haveli-daman-diu',
  'delhi',
  'goa',
  'gujarat',
  'haryana',
  'himachal-pradesh',
  'jammu-kashmir',
  'jharkhand',
  'karnataka',
  'kerala',
  'ladakh',
  'lakshadweep',
  'madhya-pradesh',
  'maharashtra',
  'manipur',
  'meghalaya',
  'mizoram',
  'nagaland',
  'odisha',
  'puducherry',
  'punjab',
  'rajasthan',
  'sikkim',
  'tamil-nadu',
  'telangana',
  'tripura',
  'uttar-pradesh',
  'uttarakhand',
  'west-bengal',
  'andaman-nicobar',
]);

const STEP_GOAL_MIN = 5000;
const STEP_GOAL_MAX = 50000;
const STEP_GOAL_GRID = 5000;
const DEFAULT_STEP_GOAL = 10000;
const MAX_DAILY_STEP_INPUT = 200000;
const MAX_DISTRICT_LENGTH = 40;

function clampInt(value, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return min;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

// Lowercase, hyphenated district slug — identical to the app's slug() so a
// board key never depends on how the name was typed.
function slug(value) {
  if (typeof value !== 'string') return '';
  let out = '';
  let lastDash = false;
  for (const ch of value.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
      lastDash = false;
    } else if (!lastDash && out.length > 0) {
      out += '-';
      lastDash = true;
    }
  }
  out = out.replace(/-+$/, '');
  return out.length > MAX_DISTRICT_LENGTH
    ? out.slice(0, MAX_DISTRICT_LENGTH)
    : out;
}

function stateKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return STATE_KEYS.has(key) ? key : null;
}

// The app offers the target in 5,000-step steps between 5k and 50k. Snapping
// here means a client cannot send goal: 1 to make the 20-point step award free.
// The most steps a phone could plausibly have recorded by now (IST).
//
// Steps are the one bucket with no server-side record: Health Connect is read on
// the phone and the number arrives in the request. A tampered client can still
// claim the goal, but it cannot claim it instantly — this ceiling grows with
// the day (a 6,000-step allowance for activity recorded before the app opened,
// then 2,000 steps per elapsed hour), so "15,000 steps" at 00:30 is refused and
// the 20 points are only banked once the day has caught up.
const STEP_BASE_ALLOWANCE = 6000;
const STEP_PER_HOUR = 2000;

function stepCeiling(now) {
  const shifted = istDate(now || Date.now());
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const ceiling =
    STEP_BASE_ALLOWANCE + Math.floor((minutes * STEP_PER_HOUR) / 60);
  return Math.min(ceiling, MAX_DAILY_STEP_INPUT);
}

// The app's daily calorie target, recomputed here from the stored diet profile
// (Mifflin-St Jeor + the same activity multipliers and safety floor as
// lib/models/diet_profile.dart). The goal check used to be a boolean the client
// sent, which made "calorie goal met" true whenever a modified app said so.
const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  veryActive: 1.9,
};

function dietTargetCalories(profile) {
  const p = profile && typeof profile === 'object' ? profile : null;
  if (!p) return 0;
  const weightKg = Number(p.weightKg);
  const heightCm = Number(p.heightCm);
  const age = Number(p.age);
  if (!Number.isFinite(weightKg) || weightKg <= 0) return 0;
  if (!Number.isFinite(heightCm) || heightCm <= 0) return 0;
  if (!Number.isFinite(age) || age <= 0) return 0;

  const male = String(p.gender || 'male').toLowerCase() === 'male';
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + (male ? 5 : -161);
  const multiplier = ACTIVITY_MULTIPLIERS[p.activity] || 1.2;
  const tdee = bmr * multiplier;
  const goal = String(p.goal || 'maintain');
  const raw = Math.round(
    goal === 'loseWeight' ? tdee - 500 : goal === 'gainMuscle' ? tdee + 300 : tdee
  );
  if (goal !== 'loseWeight') return raw;
  const floor = Math.max(Math.round(bmr), male ? 1500 : 1200);
  return raw < floor ? floor : raw;
}

function normalizeStepGoal(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_STEP_GOAL;
  const snapped = Math.round(n / STEP_GOAL_GRID) * STEP_GOAL_GRID;
  if (snapped < STEP_GOAL_MIN || snapped > STEP_GOAL_MAX) {
    return DEFAULT_STEP_GOAL;
  }
  return snapped;
}

// ─── Display names ────────────────────────────────────────────────────────
// A display name is the only free-text field on a board. Clamped, stripped of
// control AND zero-width/bidi characters (which used to let one name render as
// another — a "MacroSnap‮tnemmoc" trick), and whitespace-collapsed.
//
// Names that read as the app itself are refused: on a public board a row called
// "MacroSnap Support" is an impersonation channel, and there is no reason a
// real user needs one.
const MAX_NAME_LENGTH = 40;

const RESERVED_NAME_KEYS = new Set([
  'macrosnap',
  'macrosnapsupport',
  'macrosnapteam',
  'macrosnapadmin',
  'macrosnapuser',
  'admin',
  'administrator',
  'moderator',
  'support',
  'official',
  'macrosnaphelp',
]);

const INVISIBLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

// Letters/digits only, lowercased. This is how two names are compared for a
// collision: "A. Rao" and "a rao" are the same display slot.
function nameKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function publicName(value) {
  if (typeof value !== 'string') return 'MacroSnap user';
  const clean = value.replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'MacroSnap user';
  if (RESERVED_NAME_KEYS.has(nameKey(clean))) return 'MacroSnap user';
  return clean.length > MAX_NAME_LENGTH ? clean.slice(0, MAX_NAME_LENGTH) : clean;
}

// ─── Avatars ─────────────────────────────────────────────────────────────
// The only avatar a board row carries is the illustrated id the app ships
// (`art:hood`). Anything else — a stray emoji, a URL, a novel string from a
// modified client — is dropped rather than stored: these strings are rendered
// on other people's phones, and a board row must not become a place to put
// arbitrary text.
const AVATAR_ID = /^art:[a-z][a-z-]{0,23}$/;

function publicAvatar(value) {
  if (typeof value !== 'string') return '';
  const clean = value.trim();
  return AVATAR_ID.test(clean) ? clean : '';
}

// A stable 4-character tag for an account, so two people called the same thing
// are still distinguishable and neither can be mistaken for the other.
function shortTag(uid) {
  return crypto
    .createHash('sha256')
    .update(String(uid || ''))
    .digest('hex')
    .slice(0, 4);
}

/// [name] made unique against [takenNames] (the names already on the board).
/// The suffix is derived from the caller's uid, so the same account always gets
/// the same label and the board does not churn every sync.
function uniqueName(name, uid, takenNames) {
  const base = publicName(name);
  const key = nameKey(base);
  const clashes = (Array.isArray(takenNames) ? takenNames : []).some(
    (other) => nameKey(other) === key
  );
  if (!clashes) return base;
  const suffix = ` #${shortTag(uid)}`;
  const room = MAX_NAME_LENGTH - suffix.length;
  return (base.length > room ? base.slice(0, room) : base) + suffix;
}

// One day's points, from facts only. `mealCount` etc. are counts the caller
// read from Firestore; the numeric clamps are belt-and-braces so a bad read
// can never produce a number outside the table.
function scoreDay(facts) {
  const f = facts || {};
  const meals = clampInt(f.mealCount, 0, 3);
  const habits = clampInt(f.completedHabits, 0, 3);
  const glasses = clampInt(f.waterGlasses, 0, 100);
  const waterGoal = clampInt(f.waterGoal, 0, 5000);
  const steps = clampInt(f.steps, 0, MAX_DAILY_STEP_INPUT);

  const nutrition = Math.min(
    meals * POINTS.meal + (f.calorieGoalMet === true ? POINTS.calorieGoal : 0),
    POINTS.nutritionDailyCap
  );
  const habitPoints = Math.min(habits * POINTS.habit, POINTS.habitDailyCap);
  const hydration = Math.min(
    Math.min(glasses, POINTS.waterDailyCap) * POINTS.waterPerGlass +
      (waterGoal > 0 && glasses >= waterGoal ? POINTS.waterGoalBonus : 0),
    POINTS.hydrationDailyCap
  );
  // 10 points for every complete 5,000 steps (0 for fewer than 5,000).
  const movement = Math.min(
    Math.floor(steps / POINTS.stepsPerAward) * POINTS.stepAward,
    POINTS.movementDailyCap
  );
  const body = f.weighedIn === true ? POINTS.weighIn : 0;

  const buckets = {
    movement,
    nutrition,
    habits: habitPoints,
    hydration,
    body,
  };
  const total = Math.min(
    movement + nutrition + habitPoints + hydration + body,
    DAILY_MAX
  );
  return { points: total, buckets };
}

// ─── Calendar (Asia/Kolkata) ─────────────────────────────────────────────
// A "day" on the board must roll over for the user, not for whatever timezone
// the server process happens to run in (Vercel is UTC). The app's audience is
// India, the app's own week is Monday–Sunday, and so is this one.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function istDate(now) {
  return new Date((now instanceof Date ? now.getTime() : Number(now)) + IST_OFFSET_MS);
}

function dayKeyFromUtcDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function todayKey(now) {
  return dayKeyFromUtcDate(istDate(now || Date.now()));
}

// [dayKey] shifted by [days] calendar days. Used to bound "today's meals" to a
// half-open [today, tomorrow) range.
function addDays(dayKey, days) {
  const parts = String(dayKey).split('-').map(Number);
  return dayKeyFromUtcDate(
    new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days))
  );
}

// The Monday of an ISO week id (`2026-W47`), as a UTC day key. Used by the
// cleanup job to decide which boards are old enough to delete.
function weekStartDate(weekId) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(weekId || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const firstMonday = new Date(jan4);
  firstMonday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1));
  const monday = new Date(firstMonday);
  monday.setUTCDate(firstMonday.getUTCDate() + (week - 1) * 7);
  return dayKeyFromUtcDate(monday);
}

// ISO week id plus the seven date keys (Monday first) that make it up.
function isoWeek(now) {
  const shifted = istDate(now || Date.now());
  const date = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  );
  const weekday = date.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - (weekday - 1));

  // The week belongs to the year its Thursday falls in.
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const firstMonday = new Date(jan4);
  firstMonday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1));
  const week = Math.floor((thursday - firstMonday) / 86400000 / 7) + 1;

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    dates.push(dayKeyFromUtcDate(d));
  }
  return { week: `${year}-W${pad2(week)}`, dates };
}

// ─── Paths ───────────────────────────────────────────────────────────────
const WEEK_ID_PATTERN = /^\d{4}-W\d{2}$/;

function isValidWeekId(value) {
  return typeof value === 'string' && WEEK_ID_PATTERN.test(value);
}

const SCOPE_PATTERN = /^(state|district)_[a-z0-9_-]+$/;

function isValidScope(scope) {
  return scope === 'india' || SCOPE_PATTERN.test(String(scope || ''));
}

function boardsFor(state, district) {
  return [
    'india',
    `state_${state}`,
    `district_${state}_${district}`,
  ];
}

// The day key a meal document belongs to. The app writes `date` as an ISO
// string (local time); the backend's mirror writes a Firestore Timestamp.
// Both are reduced to the app's local calendar day.
function mealDayKey(data) {
  const value = data && data.date;
  if (!value) return null;
  if (typeof value === 'string') {
    const direct = value.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : dayKeyFromUtcDate(istDate(parsed));
  }
  if (typeof value.toDate === 'function') {
    const d = value.toDate();
    return Number.isNaN(d.getTime()) ? null : dayKeyFromUtcDate(istDate(d));
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : dayKeyFromUtcDate(istDate(value));
  }
  return null;
}

module.exports = {
  POINTS,
  ACTIVITY_MULTIPLIERS,
  MAX_NAME_LENGTH,
  STEP_BASE_ALLOWANCE,
  STEP_PER_HOUR,
  DAILY_MAX,
  WEEK_MAX,
  STATE_KEYS,
  DEFAULT_STEP_GOAL,
  clampInt,
  slug,
  stateKey,
  normalizeStepGoal,
  stepCeiling,
  dietTargetCalories,
  publicName,
  publicAvatar,
  nameKey,
  shortTag,
  uniqueName,
  scoreDay,
  todayKey,
  addDays,
  isoWeek,
  weekStartDate,
  isValidWeekId,
  isValidScope,
  boardsFor,
  mealDayKey,
};
