// Firebase ID-token authentication for the MacroSnap backend.
//
// The app sends `Authorization: Bearer <Firebase ID token>` on every call to
// our backend (lib/services/auth_http.dart); guests send no header at all.
// [requireAuth] verifies that token with the Admin SDK and puts the decoded
// claims on `req.user`. From then on the request's identity comes from the
// TOKEN ONLY — any phone / email / uid in the body, query or URL is ignored,
// so a client can never act as another user.
//
// Scope note: the token is only ever sent to OUR backend; third-party URLs
// (Google Gemini, Razorpay's hosted page) are called without it.
//
// Fail closed: when Firebase Admin is not configured (no service account) the
// token cannot be verified, so requireAuth answers 401 rather than letting an
// unauthenticated request through.
const firestore = require('./firestore');

// Extracts the bearer token from a request's Authorization header, or null.
function bearerToken(req) {
  const raw =
    (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return match ? match[1].trim() : null;
}

// Verifies a Firebase ID token. Returns the decoded claims, or null when the
// token is missing, malformed, expired, revoked — or the Admin SDK is not
// available to check it (fail closed).
async function verifyIdToken(token) {
  if (!token) return null;
  const admin = firestore.getAdmin ? firestore.getAdmin() : null;
  if (!admin) return null;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (_) {
    return null;
  }
}

// Express middleware: 401 unless the request carries a valid ID token.
async function requireAuth(req, res, next) {
  const claims = await verifyIdToken(bearerToken(req));
  if (!claims || !claims.uid) {
    return res.status(401).json({
      error: 'unauthenticated',
      message: 'Sign in to use this feature.',
    });
  }
  req.user = claims;
  return next();
}

// The verified identity of a request — the ONLY trusted source of who the
// caller is. `identifier` is the value the legacy Postgres tables are keyed
// by (the app has always used the email or phone number as its account id);
// `uid` is the Firebase UID that Firestore documents are keyed by.
//
// `emailVerified` carries the token's `email_verified` claim. Google sign-in
// always arrives verified, but an email/password account can hold an address it
// never proved it owns, so anything that keys TRUST on the address must check
// it. It does NOT gate `identifier`/`email` themselves — data is keyed by that
// address either way, and dropping it would lock a legitimate unverified user
// out of their own history.
//
// `isAdmin` is the `admin` CUSTOM CLAIM. Privilege (free Pro, the scan-limit
// exemption, "this account cannot be deleted") hangs off this claim and nothing
// else: it is set only by the Admin SDK (see ensureAdminClaim in server.js) and
// can never be produced by a client. An email address is not a credential.
function identityOf(req) {
  const user = (req && req.user) || {};
  const email =
    typeof user.email === 'string' && user.email.trim()
      ? user.email.trim().toLowerCase()
      : null;
  const phone =
    typeof user.phone_number === 'string' && user.phone_number.trim()
      ? user.phone_number.trim()
      : null;
  const uid = typeof user.uid === 'string' && user.uid ? user.uid : null;
  // Only a POSITIVE claim counts: missing/undefined is treated as unverified.
  const emailVerified = user.email_verified === true;
  const isAdmin = user.admin === true;
  return {
    uid,
    email,
    phone,
    emailVerified,
    isAdmin,
    identifier: email || phone || uid || null,
  };
}

module.exports = { requireAuth, verifyIdToken, bearerToken, identityOf };
