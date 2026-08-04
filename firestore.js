// Firestore dual-write helper for the MacroSnap backend (Phase 1 of the
// Postgres -> Firestore migration).
//
// Every Postgres write in server.js is mirrored here into Firestore so that
// when the app switches to Firestore (Phase 3) existing user data is already
// in place. Postgres remains the source of truth until cutover (Phase 4).
//
// All functions are best-effort: a Firestore failure is logged and NEVER
// fails the HTTP request or the Postgres write.
//
// Enable by setting ONE of:
//   FIREBASE_SERVICE_ACCOUNT_JSON  - full service-account JSON as an env var
//   GOOGLE_APPLICATION_CREDENTIALS - path to the service-account JSON file
// If neither is set, dual-write is disabled (logged once) and the app keeps
// working exactly as before.
//
// firebase-admin is required lazily inside init() so that even a missing
// package can never crash the server at boot - a disabled Firestore must be
// indistinguishable from no Firestore at all.
let admin = null;

let db = null;
let enabled = false;
let initAttempted = false;

function init() {
  if (initAttempted) return enabled;
  initAttempted = true;
  try {
    admin = require('firebase-admin');
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (json && json.trim().length > 0) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(json)),
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
    } else {
      console.log(
        'Firestore dual-write DISABLED: set FIREBASE_SERVICE_ACCOUNT_JSON ' +
          '(or GOOGLE_APPLICATION_CREDENTIALS) to enable.'
      );
      return false;
    }
    db = admin.firestore();
    enabled = true;
    console.log('Firestore dual-write ENABLED');
  } catch (e) {
    console.error('Firestore init failed, dual-write disabled:', e.message);
  }
  return enabled;
}

function isEnabled() {
  return enabled && !!db && !!admin;
}

// ─── identifier -> Firebase UID resolution (cached) ─────────────────────
// The app identifies users by phone number (or email, which the app stores in
// the same 'phone' pref for Google/email sign-ins). Firestore docs are keyed
// by Firebase Auth UID, so we resolve the identifier here. Phone numbers
// resolve via getUserByPhoneNumber, email addresses via getUserByEmail.
// Unknown identifiers (guests, pre-auth users) resolve to null and are
// simply not mirrored - matching the app's guest-skip behaviour.
const uidCache = new Map(); // key -> { uid, at }
const UID_CACHE_TTL_MS = 10 * 60 * 1000; // positive hits: 10 min
const NEGATIVE_TTL_MS = 60 * 1000; // misses: 1 min

async function resolveUid(identifier) {
  // When dual-write is disabled the admin SDK isn't initialized - return
  // early instead of hitting auth (which would throw) on every request.
  if (!isEnabled()) return null;
  if (!identifier || typeof identifier !== 'string') return null;
  const key = identifier.toLowerCase();
  const hit = uidCache.get(key);
  if (hit) {
    const ttl = hit.uid ? UID_CACHE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.uid;
    uidCache.delete(key);
  }
  try {
    let user;
    if (key.startsWith('+')) {
      user = await admin.auth().getUserByPhoneNumber(identifier);
    } else {
      user = await admin.auth().getUserByEmail(identifier);
    }
    uidCache.set(key, { uid: user.uid, at: Date.now() });
    return user.uid;
  } catch (e) {
    if (
      e &&
      (e.code === 'auth/user-not-found' ||
        e.code === 'auth/invalid-phone-number' ||
        e.code === 'auth/invalid-email')
    ) {
      uidCache.set(key, { uid: null, at: Date.now() }); // negative cache
      return null;
    }
    console.error(
      'Firestore uid resolve failed for ' + identifier + ':',
      (e && e.code) || (e && e.message)
    );
    return null;
  }
}

// ─── safe write helpers (never throw) ────────────────────────────────────
async function set(path, data, opts) {
  if (!isEnabled()) return false;
  try {
    await db.doc(path).set(data, opts || {});
    return true;
  } catch (e) {
    console.error('Firestore set ' + path + ' failed:', e.message);
    return false;
  }
}

async function del(path) {
  if (!isEnabled()) return false;
  try {
    await db.doc(path).delete();
    return true;
  } catch (e) {
    console.error('Firestore delete ' + path + ' failed:', e.message);
    return false;
  }
}

function getDb() {
  return db;
}

module.exports = { init, isEnabled, resolveUid, set, del, getDb };
