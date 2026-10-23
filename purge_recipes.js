// ONE-TIME cleanup: delete every recipes/{uid} document in Firestore.
//
// The custom-recipes feature was removed from the app and from the security
// rules, but the documents those older app versions wrote were never deleted:
// account deletion no longer wipes 'recipes' (it was dropped from the list in
// server.js) and the rules no longer allow a client to touch them at all. So
// deleting the feature would have left every user's recipe data in the cloud,
// against both the privacy policy and the account-deletion promise.
//
// This script lists all docs under `recipes/` with the Admin SDK (which
// bypasses the rules) and deletes each one. Run it once, after the feature
// removal has shipped, and again later exists harmless: deleting a collection
// that no longer exists afterwards simply finds no documents.
//
//   FIREBASE_SERVICE_ACCOUNT_JSON='{...}' node purge_recipes.js            # delete
//   FIREBASE_SERVICE_ACCOUNT_JSON='{...}' node purge_recipes.js --dry-run  # list only
//
// Dry-run lists every doc that WOULD be deleted without touching anything.
require('dotenv').config();
const firestore = require('./firestore');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_MAX = 400; // Firestore batches cap at 500 operations

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
  const snap = await db.collection('recipes').get();
  const docs = snap.docs;
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}found ${docs.length} recipes docs`);

  if (DRY_RUN) {
    for (const d of docs) {
      console.log('  would delete recipes/' + d.id);
    }
    console.log('[dry-run] nothing was deleted');
    // Firestore keeps its live socket open, which would hang the script
    // without an explicit exit — a dry-run must end like the real run does.
    process.exit(0);
  }

  let deleted = 0;
  for (let i = 0; i < docs.length; i += BATCH_MAX) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + BATCH_MAX)) {
      batch.delete(d.ref);
    }
    await batch.commit();
    deleted = Math.min(i + BATCH_MAX, docs.length);
    console.log(`  deleted ${deleted}/${docs.length}`);
  }
  console.log(`done: ${deleted} recipes docs deleted`);
  process.exit(0);
}

purge().catch((e) => {
  console.error('purge failed:', e.message);
  process.exit(1);
});
