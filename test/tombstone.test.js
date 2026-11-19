'use strict';
// The deletion tombstone, in three properties that matter legally:
//
//   1. it holds no readable identifier (an email kept forever is the thing an
//      erasure request is about),
//   2. it expires (storage limitation, not "kept indefinitely"), and
//   3. it is actually READ — the previous version stored the email on every
//      deletion and no code looked at it, so it enforced nothing.
//
// Run: node --test test/
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// ── In-memory Firestore fake (same shape as payment.test.js) ────────────
const fsDocs = {};
const fsSets = [];
const firestoreStub = {
  init: () => true,
  isEnabled: () => true,
  resolveUid: async () => null,
  get: async (path) => {
    const [col, id] = path.split('/');
    return (fsDocs[col] || {})[id] || null;
  },
  set: async (path, data) => {
    fsSets.push({ path, data });
    const [col, id] = path.split('/');
    fsDocs[col] = fsDocs[col] || {};
    fsDocs[col][id] = { ...(fsDocs[col][id] || {}), ...(data || {}) };
    return true;
  },
  del: async (path) => {
    const [col, id] = path.split('/');
    if (fsDocs[col]) delete fsDocs[col][id];
    return true;
  },
  getDb: () => ({
    collection: (name) => ({
      // Mirrors the real SDK: doc() returns a DocumentReference, which is what
      // batch.set() receives, so the fake reference must carry its own id.
      doc: (id) => {
        const ref = { collection: name, id };
        ref.ref = ref;
        ref.get = async () => {
          const d = (fsDocs[name] || {})[id];
          return { exists: !!d, data: () => d || {}, id, ref };
        };
        ref.set = async (data) => {
          fsDocs[name] = fsDocs[name] || {};
          fsDocs[name][id] = { ...(fsDocs[name][id] || {}), ...(data || {}) };
          return true;
        };
        ref.delete = async () => true;
        return ref;
      },
      // Full-collection read, used by the legacy-tombstone migration.
      get: async () => {
        const col = fsDocs[name] || {};
        return {
          docs: Object.keys(col).map((id) => ({
            id,
            ref: { collection: name, id },
            data: () => col[id],
          })),
        };
      },
      // Only the deletedAccounts range query is used: `where('deleted_at','<',cutoff)`
      // for the retention purge. Refuse other fields loudly rather than
      // returning an empty result that would hide a broken purge.
      where: (field, op, value) => ({
        get: async () => {
          if (field !== 'deleted_at' || op !== '<') {
            throw new Error('unexpected where: ' + field + ' ' + op);
          }
          const col = fsDocs[name] || {};
          const docs = Object.keys(col)
            .filter((id) => (col[id] || {}).deleted_at < value)
            .map((id) => ({ id, ref: { collection: name, id }, data: () => col[id] }));
          return { empty: docs.length === 0, docs };
        },
      }),
    }),
    batch: () => {
      const deletes = [];
      const writes = [];
      return {
        delete: (ref) => {
          deletes.push(ref);
          return { delete: () => deletes.push(ref) };
        },
        set: (ref, data, opts) => {
          writes.push({ ref, data, opts });
          return { set: () => writes.push({ ref, data, opts }) };
        },
        commit: async () => {
          for (const w of writes) {
            fsDocs[w.ref.collection] = fsDocs[w.ref.collection] || {};
            fsDocs[w.ref.collection][w.ref.id] = {
              ...(fsDocs[w.ref.collection][w.ref.id] || {}),
              ...(w.data || {}),
            };
          }
          for (const ref of deletes) {
            if (fsDocs[ref.collection]) delete fsDocs[ref.collection][ref.id];
          }
          deletes.length = 0;
          writes.length = 0;
          return true;
        },
      };
    },
  }),
};

const routes = { get: {}, post: {} };
const appStub = {
  use: () => {},
  get: (p, ...fns) => { routes.get[p] = fns[fns.length - 1]; },
  post: (p, ...fns) => { routes.post[p] = fns[fns.length - 1]; },
  listen: () => {},
};
function express() { return appStub; }
express.json = () => (req, res, next) => next();
express.static = () => () => {};
function multer() { return { single: () => (req, res, next) => next() }; }
multer.memoryStorage = () => ({});
const pgStub = { Pool: class { query() { return { rows: [] }; } } };
const origLoad = Module._load;
Module._load = function (request) {
  switch (request) {
    case 'dotenv': return { config: () => ({}) };
    case 'express': return express;
    case 'multer': return multer;
    case 'sharp': return (buf) => ({ jpeg: () => ({ toBuffer: async () => buf }) });
    case 'pg': return pgStub;
    case 'razorpay': return class {};
    case './firestore': return firestoreStub;
    default: return origLoad.apply(this, arguments);
  }
};

process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
delete process.env.DATABASE_URL;
delete process.env.TOMBSTONE_SECRET;

const app = require('../server.js');
const deleteAccount = routes.post['/account/delete'];
const { fingerprint, retentionMonths, introUsedFor } = app._tombstone;

assert.ok(deleteAccount, '/account/delete handler must be registered');

beforeEach(() => {
  for (const k of Object.keys(fsDocs)) delete fsDocs[k];
  fsSets.length = 0;
});

function makeReq(user) {
  const req = { body: {}, query: {}, headers: {} };
  req.user = user;
  return req;
}
function makeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  res.send = (s) => { res.body = s; return res; };
  return res;
}

test('fingerprint is an HMAC, not the identifier', () => {
  const email = 'Someone@Example.com';
  const fp = fingerprint(email);

  assert.equal(fp.length, 64);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.ok(!fp.includes('@'));
  assert.ok(!fp.includes('example'));
  assert.ok(!fp.toLowerCase().includes('someone'));
});

test('fingerprint normalises case and whitespace, so a re-login matches', () => {
  assert.equal(fingerprint('  User@Example.com '), fingerprint('user@example.com'));
  assert.notEqual(fingerprint('a@example.com'), fingerprint('b@example.com'));
});

test('the record has a defined lifetime', () => {
  assert.equal(retentionMonths, 24);
});

test('deleting an account writes only a fingerprint, and drops the old raw doc', async () => {
  // A cleartext document left by an earlier build.
  fsDocs.deletedAccounts = { 'user@example.com': { email: 'user@example.com' } };

  const res = makeRes();
  await deleteAccount(
    makeReq({
      uid: 'uid_abc',
      email: 'user@example.com',
      email_verified: true,
    }),
    res
  );

  const ids = Object.keys(fsDocs.deletedAccounts || {});
  assert.deepEqual(
    ids,
    [fingerprint('user@example.com')],
    'only the fingerprint document may remain'
  );
  assert.equal(fsDocs.deletedAccounts['user@example.com'], undefined);
  const doc = fsDocs.deletedAccounts[fingerprint('user@example.com')];
  assert.deepEqual(Object.keys(doc), ['deleted_at']);
  assert.equal(
    JSON.stringify(doc).includes('user@example.com'),
    false,
    'the stored record must not contain the address'
  );
});

test('expired fingerprints are purged, whether or not Postgres is configured', async () => {
  // Production runs Firestore-only (no DATABASE_URL), so the SQL purge at the
  // end of the delete handler never fires there. This is the half that keeps
  // the policy's "deleted automatically after 24 months" true in that setup.
  const expired = 'a'.repeat(64);
  const recent = 'b'.repeat(64);
  const fresh = 'c'.repeat(64);
  fsDocs.deletedAccounts = {
    [expired]: { deleted_at: '2020-01-01T00:00:00.000Z' },
    [recent]: { deleted_at: new Date().toISOString() },
  };

  await deleteAccount(
    makeReq({ uid: 'uid_purge', email: 'purge@example.com', email_verified: true }),
    makeRes()
  );

  assert.deepEqual(
    Object.keys(fsDocs.deletedAccounts).sort(),
    [recent, fingerprint('purge@example.com')].sort(),
    'the expired fingerprint goes, recent ones stay'
  );
  assert.equal(fsDocs.deletedAccounts[expired], undefined);
  assert.ok(fsDocs.deletedAccounts[fresh] === undefined, 'unrelated ids untouched');
});

test('the 24-month window is enforced at read time, not only by the purge', async () => {
  // The purge runs when somebody deletes an account, so a document can sit past
  // its own expiry for weeks. Honouring it until then would make the policy's
  // "24 months" untrue; the offer must be available again once it is expired.
  const fp = fingerprint('old@example.com');
  const longAgo = new Date(Date.now() - 25 * 30.44 * 24 * 3600 * 1000).toISOString();
  fsDocs.deletedAccounts = { [fp]: { deleted_at: longAgo } };

  assert.equal(
    await introUsedFor({ uid: null, identifier: 'old@example.com' }),
    false,
    'a 25-month-old fingerprint no longer withholds the ₹1 month'
  );

  // A recent one still does.
  fsDocs.deletedAccounts = { [fp]: { deleted_at: new Date().toISOString() } };
  assert.equal(
    await introUsedFor({ uid: null, identifier: 'old@example.com' }),
    true
  );
});

test('expiry helper: missing or unparseable dates are treated as live', () => {
  const { expired } = app._tombstone;
  assert.equal(expired(null), false);
  assert.equal(expired('not a date'), false);
  assert.equal(expired(new Date().toISOString()), false);
  assert.equal(
    expired(new Date(Date.now() - 25 * 30.44 * 24 * 3600 * 1000).toISOString()),
    true
  );
});

test('legacy cleartext tombstones migrate to fingerprints without losing evidence', async () => {
  // Nothing printed, nothing dropped: the offer check must still refuse these
  // two addresses after the old documents are gone.
  const { migrateLegacyTombstones } = require('../tools/migrate_tombstones');
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
  fsDocs.deletedAccounts = {
    'Legacy@Example.com': { deleted_at: old },
    'legacy@example.com': { deleted_at: old },
    [fingerprint('already@example.com')]: { deleted_at: old },
  };

  const res = await migrateLegacyTombstones({
    db: firestoreStub.getDb(),
    fingerprint,
    apply: true,
  });

  assert.equal(res.scanned, 3);
  assert.equal(res.legacy, 2);
  assert.equal(res.migrated, 1, 'the same address in two cases is one fingerprint');
  assert.equal(res.merged, 1);
  assert.equal(res.skipped, 1);
  assert.deepEqual(
    Object.keys(fsDocs.deletedAccounts).sort(),
    [fingerprint('already@example.com'), fingerprint('legacy@example.com')].sort(),
    'only fingerprints remain'
  );
  assert.equal(
    fsDocs.deletedAccounts[fingerprint('legacy@example.com')].deleted_at,
    old,
    'the original deletion time is preserved'
  );
  assert.equal(
    await introUsedFor({ uid: null, identifier: 'legacy@example.com' }),
    true,
    'the migrated record still withholds the ₹1 month'
  );
});

test('migration dry run writes nothing', async () => {
  const { migrateLegacyTombstones } = require('../tools/migrate_tombstones');
  fsDocs.deletedAccounts = { 'dry@example.com': { deleted_at: new Date().toISOString() } };

  const res = await migrateLegacyTombstones({
    db: firestoreStub.getDb(),
    fingerprint,
    apply: false,
  });

  assert.equal(res.legacy, 1);
  assert.equal(res.migrated, 0);
  assert.deepEqual(Object.keys(fsDocs.deletedAccounts), ['dry@example.com']);
});

test('a deleted account is not offered the ₹1 month again', async () => {
  // Before deletion: nothing recorded, so the intro applies.
  assert.equal(
    await introUsedFor({ uid: null, identifier: 'gone@example.com' }),
    false
  );

  await deleteAccount(
    makeReq({ uid: 'uid_gone', email: 'gone@example.com', email_verified: true }),
    makeRes()
  );

  // After deletion every payment record is wiped; the tombstone is the only
  // evidence left, and it must be enough. This is the assertion that fails on
  // the old code, which wrote the record and never read it.
  assert.equal(
    await introUsedFor({ uid: null, identifier: 'gone@example.com' }),
    true
  );
  assert.equal(
    await introUsedFor({ uid: null, identifier: 'someone-else@example.com' }),
    false
  );
});
