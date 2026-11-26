'use strict';
// App Links + invite routes: /.well-known/assetlinks.json and /join/:code.
//
// assetlinks.json answering `[]` is a VALID response that verifies nothing, and
// that is exactly why every league invite used to open in the browser and then
// jump to the Play Store. These tests pin the two halves of the fix: the file
// must always name the release certificate, and an Android visitor must be
// handed to the app (with the store only as the fallback).
//
// Same express stub as the other route suites: only the LAST handler of a route
// is captured, so rate limiting and the Firebase Admin SDK stay out of the way.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const routes = { get: {}, post: {} };
const appStub = {
  use: () => {},
  get: (p, ...fns) => {
    routes.get[p] = fns[fns.length - 1];
  },
  post: (p, ...fns) => {
    routes.post[p] = fns[fns.length - 1];
  },
  delete: () => {},
  listen: () => {},
};
function express() {
  return appStub;
}
const passThrough = () => (req, res, next) => next();
express.json = passThrough;
express.raw = passThrough;
express.text = passThrough;
express.urlencoded = passThrough;
express.static = () => () => {};

// Any Firestore call is a no-op: these routes never touch the database, and a
// Proxy keeps this stub from having to grow with server.js.
const firestoreStub = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'isEnabled') return () => false;
      if (prop === 'get') return async () => null;
      if (prop === 'set') return async () => true;
      return () => ({});
    },
  }
);

const origLoad = Module._load;
Module._load = function (request) {
  switch (request) {
    case 'dotenv':
      return { config: () => ({}) };
    case 'express':
      return express;
    case 'multer':
      return Object.assign(() => ({ single: () => (r, s, n) => n() }), {
        memoryStorage: () => ({}),
      });
    case 'sharp':
      return () => ({
        rotate: () => ({
          resize: () => ({ jpeg: () => ({ toBuffer: async () => Buffer.from('') }) }),
        }),
      });
    case 'pg':
      return {
        Pool: class {
          query() {
            return { rows: [] };
          }
        },
      };
    case './firestore':
      return firestoreStub;
    case './auth':
      return {
        requireAuth: (req, res, next) => next(),
        identityOf: () => ({ uid: 'uid1', isAdmin: false }),
      };
    default:
      return origLoad.apply(this, arguments);
  }
};

const server = require('../server.js');
Module._load = origLoad;
assert.ok(server);

function makeRes() {
  const res = { statusCode: 200 };
  res.set = () => res;
  res.type = () => res;
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (o) => {
    res.body = o;
    return res;
  };
  res.send = (body) => {
    res.sent = body;
    return res;
  };
  res.redirect = (code, url) => {
    res.statusCode = code;
    res.location = url;
    return res;
  };
  return res;
}

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8 Pro) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const RELEASE_SHA256 =
  '24:0F:92:80:E7:47:23:71:93:AF:36:7B:54:90:15:F8:DC:EB:B2:78:1A:30:8D:2F:CD:56:36:04:B7:9F:84:4F';

function assetLinks() {
  const res = makeRes();
  routes.get['/.well-known/assetlinks.json']({ headers: {} }, res);
  return res.body;
}

test('assetlinks never answers empty, even with no environment set', () => {
  const statements = assetLinks();
  assert.ok(Array.isArray(statements), 'must be a list of statements');
  assert.equal(statements.length, 1);
  const [statement] = statements;
  assert.deepEqual(statement.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(statement.target.namespace, 'android_app');
  assert.equal(statement.target.package_name, 'com.macrosnap.macro_snap');
  assert.ok(
    statement.target.sha256_cert_fingerprints.includes(RELEASE_SHA256),
    'the release certificate must be trusted'
  );
});

test('ASSETLINKS_SHA256 adds a second certificate instead of replacing it', () => {
  const playKey = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:' +
    'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
  process.env.ASSETLINKS_SHA256 = playKey;
  try {
    const keys = assetLinks()[0].target.sha256_cert_fingerprints;
    assert.ok(keys.includes(RELEASE_SHA256));
    assert.ok(keys.includes(playKey));
  } finally {
    delete process.env.ASSETLINKS_SHA256;
  }
});

test('ASSETLINKS_SHA256 rejects values that are not a SHA-256 fingerprint', () => {
  process.env.ASSETLINKS_SHA256 = 'not-a-fingerprint';
  try {
    const keys = assetLinks()[0].target.sha256_cert_fingerprints;
    assert.deepEqual(keys, [RELEASE_SHA256]);
  } finally {
    delete process.env.ASSETLINKS_SHA256;
  }
});

test('an Android invite hands off to the app, store only as the fallback', () => {
  const res = makeRes();
  routes.get['/join/:code'](
    { params: { code: 'abc123' }, headers: { 'user-agent': ANDROID_UA } },
    res
  );
  assert.equal(res.location, undefined, 'must not redirect straight to Play');
  assert.match(res.sent, /intent:\/\/join\/ABC123#Intent;scheme=macrosnap;/);
  assert.match(res.sent, /package=com\.macrosnap\.macro_snap;/);
  assert.match(res.sent, /S\.browser_fallback_url=https%3A%2F%2Fplay\.google\.com/);
  // The store link still carries the invite, so an install from here joins.
  assert.match(res.sent, /referrer=join_code%3DABC123/);
});

test('a phone that is not Android gets the code to type in', () => {
  const res = makeRes();
  routes.get['/join/:code'](
    { params: { code: 'abc123' }, headers: { 'user-agent': IPHONE_UA } },
    res
  );
  assert.match(res.sent, /ABC123/);
  assert.doesNotMatch(res.sent, /intent:\/\//);
  assert.match(res.sent, /Get MacroSnap for Android/);
});

test('a malformed invite explains itself on every platform', () => {
  const res = makeRes();
  routes.get['/join/:code'](
    { params: { code: 'nope' }, headers: { 'user-agent': ANDROID_UA } },
    res
  );
  assert.match(res.sent, /incomplete/);
  assert.doesNotMatch(res.sent, /intent:\/\//);
});
