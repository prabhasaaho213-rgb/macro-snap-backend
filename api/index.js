// Vercel serverless entry point. The api/ directory convention turns this
// file into a serverless function automatically. vercel.json ALSO pins the
// same app explicitly (a builds/routes block on server.js); that block is the
// one Vercel actually uses today, and this file is the convention-based
// equivalent of it. Both must keep resolving to server.js.
// The Express app itself lives in server.js (shared with local dev and
// Railway via `node server.js`).
module.exports = require('../server.js');
