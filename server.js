// server.js — Local development entry point
//
// For local dev only. On Vercel the app runs as a serverless function
// (see api/index.js) and this file is never executed.

import { createApp } from './app.js';

const app  = createApp();
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   CRED Protocol — Backend Running     ║
  ║   On-chain proof of work, for every   ║
  ║   agent.                              ║
  ╠═══════════════════════════════════════╣
  ║   http://localhost:${PORT}               ║
  ║   POST /webhook/helius                ║
  ║   GET  /api/agent/:wallet             ║
  ║   GET  /api/leaderboard               ║
  ║   GET  /api/stats                     ║
  ╚═══════════════════════════════════════╝
  `);
});
