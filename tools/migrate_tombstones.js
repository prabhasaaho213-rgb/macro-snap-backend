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

function isFingerprint(id) {
  return FINGERPRINT_RE.test(String(id || ''));
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
  const result = { scanned: docs.length, legacy: 0, migrated: 0, merged: 0, skipped: 0 };

  // Fingerprints written during this run, so two legacy ids that normalise to
  // the same address (e.g. differing case) merge instead of racing.
  const batch = apply ? db.batch() : null;
  const pending = new Map();

  for (const doc of docs) {
    const id = doc.id;
    if (isFingerprint(id)) {
      result.skipped += 1;
      continue;
    }
    result.legacy += 1;
    const data = (doc.data && doc.data()) || {};
    const fp = fingerprint(id);
    if (pending.has(fp)) {
      result.merged += 1;
    } else {
      pending.set(fp, data.deleted_at || new Date().toISOString());
    }
    if (batch) {
      batch.set(
        db.collection('deletedAccounts').doc(fp),
        { deleted_at: pending.get(fp) },
        { merge: true }
      );
      batch.delete(doc.ref);
    }
  }

  if (batch && pending.size > 0) await batch.commit();
  result.migrated = apply ? pending.size : 0;
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

  const res = await migrateLegacyTombstones({
    db: firestore.getDb(),
    fingerprint,
    apply,
  });

  console.log(
    [
      `scanned   ${res.scanned}`,
      `already-fingerprinted ${res.skipped}`,
      `legacy    ${res.legacy}`,
      res.merged ? `merged    ${res.merged} (same address, different case)` : null,
      apply ? `migrated  ${res.migrated}` : 'dry run — pass --apply to write',
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

module.exports = { migrateLegacyTombstones, isFingerprint };
