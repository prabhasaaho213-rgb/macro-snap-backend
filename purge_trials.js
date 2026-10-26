// ONE-TIME cleanup: strip every free-trial field from users/{uid} docs.
//
// Free trials no longer exist anywhere in MacroSnap: the server's
// /trial/status answers a flat "no trial", entitlementsFor() ignores
// trial_started_at, firestore.rules dropped the trial_ends_at grant, and
// initDB() nulls the Postgres column at boot. The Firestore documents those
// older versions wrote, however, were never cleaned — inert data that no
// code path reads anymore, but which contradicts "trials are gone" the day
// somebody inspects a user doc.
//
// This script lists the trial-carrying docs with the Admin SDK (which
// bypasses the rules) and removes ONLY the trial fields (FieldValue.delete),
// never the doc itself — subscribed, pro_until, meals references and every
// other field stay untouched. Re-running it later is harmless: a second
// pass finds nothing to do.
//
//   FIREBASE_SERVICE_ACCOUNT_JSON='{...}' node purge_trials.js            # purge
//   FIREBASE_SERVICE_ACCOUNT_JSON='{...}' node purge_trials.js --dry-run  # list only
//
// Dry-run lists every doc and field WOULD be purged without touching them.
require('dotenv').config();
const firestore = require('./firestore');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_MAX = 400; // Firestore batches cap at 500 operations

// The two fields history is known to have used. Anything else whose key
// merely CONTAINS 'trial' is reported too, so an unknown remnant cannot hide.
const KNOWN_TRIAL_FIELDS = ['trial_started_at', 'trial_ends_at'];

firestore.init();
const db = firestore.getDb();
if (!db) {
  console.error(
    'Firestore is not enabled. Set FIREBASE_SERVICE_ACCOUNT_JSON ' +
      '(or GOOGLE_APPLICATION_CREDENTIALS), then retry.'
  );
  process.exit(1);
}

async function purge() {
  const snap = await db.collection('users').get();
  const hits = [];
  for (const d of snap.docs) {
    const data = d.data() || {};
    const fields = Object.keys(data).filter(
      (k) => KNOWN_TRIAL_FIELDS.includes(k) || k.toLowerCase().includes('trial')
    );
    if (fields.length) hits.push({ ref: d.ref, id: d.id, fields });
  }

  console.log(
    `${DRY_RUN ? '[dry-run] ' : ''}found ${hits.length} users docs carrying trial fields ` +
      `(of ${snap.docs.length} total)`
  );

  if (DRY_RUN) {
    for (const h of hits) {
      console.log(`  would purge users/${h.id}: ${h.fields.join(', ')}`);
    }
    console.log('[dry-run] nothing was changed');
    // Firestore keeps its live socket open, which would hang the script
    // without an explicit exit — a dry-run must end like the real run does.
    process.exit(0);
  }

  let purged = 0;
  for (let i = 0; i < hits.length; i += BATCH_MAX) {
    const batch = db.batch();
    for (const h of hits.slice(i, i + BATCH_MAX)) {
      const deleteMarker = firestore.getAdmin().firestore.FieldValue.delete();
      const patch = {};
      for (const f of h.fields) {
        patch[f] = deleteMarker;
      }
      batch.update(h.ref, patch);
    }
    await batch.commit();
    purged = Math.min(i + BATCH_MAX, hits.length);
    console.log(`  purged ${purged}/${hits.length}`);
  }
  console.log(`done: trial fields cleared from ${purged} users docs`);
  process.exit(0);
}

purge().catch((e) => {
  console.error('purge failed:', e.message);
  process.exit(1);
});
