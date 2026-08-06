// Vercel serverless entry point. The api/ directory convention turns this
// file into a serverless function automatically — no builds/routes config
// needed. The Express app itself lives in server.js (shared with local dev
// and Railway via `node server.js`).
module.exports = require('../server.js');
