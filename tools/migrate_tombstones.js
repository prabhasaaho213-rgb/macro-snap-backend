'use strict';
// One-time migration: turn legacy cleartext deletion tombstones into
// fingerprints.
//
// Earlier builds wrote one document per deleted account at
// `deletedAccounts/<email or phone>`. The offer check now looks up
// `deletedAccounts/<hmac>`, so those documents are invisible to it: everyone who
// deleted an account before this build could re-register and claim the ₹1 first
// month again. Deleting the old documents by hand — which the checklist used to
// suggest — makes that permanent, because the address is the only place the
// information still exists.
//
// This reads each legacy document, computes the fingerprint with the SAME key
// the server uses (TOMBSTONE_SECRET), writes the fingerprint document with the
// original deletion time, and only then deletes the old one. It is idempotent:
// documents already keyed by fingerprint (64 hex characters) are skipped.
//
// Usage:
//   TOMBSTONE_SECRET=... FIREBASE_SERVICE_ACCOUNT_JSON=... \
//     node tools/migrate_tombstones.js            # dry run, prints counts
//   ... node tools/migrate_tombstones.js --apply  # write the changes
//
// No identifier is ever printed: the run reports counts, not addresses.

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

// A Firestore commit allows 500 operations, and this migration uses two per
// legacy record (set the fingerprint, delete the old document). 200 records per
// commit is 400 operations — under the limit with room to spare, and it means a
// collection larger than 250 records does not fail halfway through.
const MAX_OPS_PER_COMMIT = 400;
const RECORDS_PER_COMMIT = MAX_OPS_PER_COMMIT / 2;

function isFingerprint(id) {
  return FINGERPRINT_RE.test(String(id || ''));
}

// Must match TOMBSTONE_CANARY_CONSTANT / tombstoneCanary() in ../server.js.
const CANARY_CONSTANT = 'macrosnap-tombstone-key-check-v1';
const CANARY_COLLECTION = 'meta';
const CANARY_DOC = 'tombstone_key_check';

function canaryFor(secret) {
  return require('node:crypto')
    .createHmac('sha256', secret)
    .update(CANARY_CONSTANT)
    .digest('hex');
}

/**
 * Compares the key this run is using against the value the deployed server
 * published. Returns 'ok', 'mismatch' or 'missing'.
 *
 * Overlap between a legacy address and an existing fingerprint is NOT a
 * usable signal — the delete handler removes the legacy document when that
 * account deletes again, so a correct run normally has no overlap at all.
 */
async function verifyCanary({ db, secret }) {
  try {
    const doc = await db
      .collection(CANARY_COLLECTION)
      .doc(CANARY_DOC)
      .get();
    const stored = doc && doc.exists ? (doc.data() || {}).canary : null;
    if (!stored) return 'missing';
    return stored === canaryFor(secret) ? 'ok' : 'mismatch';
  } catch (_) {
    return 'missing';
  }
}

/**
 * Pure core, so it can be tested against a fake Firestore.
 *
 * @param {object} opts
 * @param {object} opts.db        Firestore instance (collection/batch)
 * @param {(id: string) => string} opts.fingerprint
 * @param {boolean} [opts.apply]  false = report only
 */
async function migrateLegacyTombstones({ db, fingerprint, apply = false }) {
  const snapshot = await db.collection('deletedAccounts').get();
  const docs = (snapshot && snapshot.docs) || [];
  const existingIds = new Set(docs.map((d) => d.id));

  // Fingerprints that already exist (written by the server for an account
  // deleted after this build). Seeding the map with their dates is what stops
  // a legacy record from rewriting a NEWER deletion with an older date.
  const latest = new Map();
  for (const d of docs) {
    if (!isFingerprint(d.id)) continue;
    const at = ((d.data && d.data()) || {}).deleted_at;
    if (at) latest.set(d.id, at);
  }
  // Fingerprints this run is responsible for, so "migrated" counts legacy
  // records rather than also counting documents that already existed.
  const legacyFingerprints = new Set();
  const result = {
    scanned: docs.length,
    legacy: 0,
    migrated: 0,
    merged: 0,
    skipped: 0,
    commits: 0,
    // True when some legacy document's fingerprint is already present, which
    // proves this run is using the same TOMBSTONE_SECRET as the server.
    keyConfirmed: null,
  };

  let batch = apply ? db.batch() : null;
  let ops = 0;

  const flush = async () => {
    if (!apply || !batch || ops === 0) return;
    await batch.commit();
    result.commits += 1;
    batch = db.batch();
    ops = 0;
  };

  for (const doc of docs) {
    const id = doc.id;
    if (isFingerprint(id)) {
      result.skipped += 1;
      continue;
    }
    result.legacy += 1;
    const data = (doc.data && doc.data()) || {};
    const fp = fingerprint(id);
    if (existingIds.has(fp)) result.keyConfirmed = true;

    legacyFingerprints.add(fp);
    const date = data.deleted_at || new Date().toISOString();
    const previous = latest.get(fp);
    if (previous) result.merged += 1;
    // Keep the LATER deletion date: the record exists to say "this identity has
    // deleted", and when the same address deleted twice, the recent deletion is
    // the one worth remembering. (Reading order in Firestore is by document id,
    // so "first one wins" would pick an arbitrary date.)
    const keep = previous && previous > date ? previous : date;
    latest.set(fp, keep);

    if (apply) {
      // Both operations are always issued — a duplicate still has an old
      // document to delete — so each legacy record costs exactly 2 ops.
      batch.set(
        db.collection('deletedAccounts').doc(fp),
        { deleted_at: keep },
        { merge: true }
      );
      batch.delete(doc.ref);
      ops += 2;
      if (ops >= MAX_OPS_PER_COMMIT) await flush();
    }
  }

  await flush();
  result.migrated = apply ? legacyFingerprints.size : 0;
  return result;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const secret = (process.env.TOMBSTONE_SECRET || '').trim();
  if (!secret) {
    console.error(
      'TOMBSTONE_SECRET is not set. Fingerprints must be produced with the\n' +
        'same key the server uses, otherwise the migrated documents are noise.'
    );
    process.exit(1);
  }

  const firestore = require('../firestore');
  if (!firestore.init() || !firestore.isEnabled()) {
    console.error(
      'Firestore is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON\n' +
        '(or GOOGLE_APPLICATION_CREDENTIALS) and try again.'
    );
    process.exit(1);
  }

  const crypto = require('node:crypto');
  const fingerprint = (identifier) =>
    crypto
      .createHmac('sha256', secret)
      .update(String(identifier).trim().toLowerCase())
      .digest('hex');

  const db = firestore.getDb();

  // Refuse to write with a key the running server does not share. This is the
  // failure that would otherwise be silent: every fingerprint written here
  // would be a value nothing ever looks up.
  const canary = await verifyCanary({ db, secret });
  const force = process.argv.includes('--force');
  if (canary === 'mismatch') {
    console.error(
      'TOMBSTONE_SECRET does not match the key the deployed server published\n' +
        'in meta/tombstone_key_check. Running this would write fingerprints the\n' +
        'server can never match, silently re-opening the ₹1 month. Nothing was\n' +
        'written. Use the value from `vercel env pull`, or pass --force if you\n' +
        'know the canary is stale.'
    );
    if (!force) process.exit(1);
  }
  if (canary === 'missing' && apply) {
    console.warn(
      'warning: meta/tombstone_key_check is missing — the server has not booted\n' +
        '         with this key yet, so it could not be verified. Continuing.'
    );
  }

  const res = await migrateLegacyTombstones({ db, fingerprint, apply });

  console.log(
    [
      `scanned   ${res.scanned}`,
      `already-fingerprinted ${res.skipped}`,
      `legacy    ${res.legacy}`,
      res.merged ? `merged    ${res.merged} (same address, two records)` : null,
      apply
        ? `migrated  ${res.migrated} fingerprints in ${res.commits} commit(s)`
        : 'dry run — pass --apply to write',
      `key       ${
        canary === 'ok'
          ? 'verified against the server canary'
          : canary === 'mismatch'
            ? 'MISMATCH — refused (see above)'
            : 'unverified (no canary yet)'
      }`,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error('migration failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = {
  migrateLegacyTombstones,
  isFingerprint,
  verifyCanary,
  canaryFor,
  MAX_OPS_PER_COMMIT,
  RECORDS_PER_COMMIT,
};
