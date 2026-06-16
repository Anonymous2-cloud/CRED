// app.js — Express app factory (shared by local server + Vercel function)
//
// This builds and returns the Express app WITHOUT calling app.listen().
// - Local dev (`server.js`) imports this and calls listen().
// - Vercel (`api/index.js`) imports this and exports it as the handler.

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { router as apiRouter } from './src/api.js';
import { handleHeliusWebhook } from './src/indexer.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  // ─── MIDDLEWARE ─────────────────────────────────────────────
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // ─── STATIC FRONTEND ────────────────────────────────────────
  // Serves public/ for local dev. On Vercel the CDN serves these files
  // directly; only /api/* and /webhook/* are routed to this function.
  app.use(express.static(path.join(__dirname, 'public')));

  // ─── HEALTH CHECK ───────────────────────────────────────────
  app.get('/api', (req, res) => {
    res.json({
      name:    'CRED Protocol API',
      version: '0.1.0',
      tagline: 'On-chain proof of work, for every agent.',
      status:  'running',
      endpoints: [
        'GET  /api/stats',
        'GET  /api/leaderboard',
        'GET  /api/agent/:wallet',
        'GET  /api/agent/:wallet/score',
        'GET  /api/agent/:wallet/history',
        'GET  /api/agent/:wallet/txs',
        'POST /api/agent/register',
        'POST /api/agent/:wallet/dispute',
        'POST /webhook/helius',
      ],
    });
  });

  // ─── HELIUS WEBHOOK ─────────────────────────────────────────
  // Helius POSTs here every time a tracked wallet gets a payment.
  app.post('/webhook/helius', async (req, res) => {
    // Verify auth header matches our secret
    const authHeader = req.headers['authorization'];
    if (process.env.WEBHOOK_SECRET && authHeader !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const events = Array.isArray(req.body) ? req.body : [req.body];

    // On serverless (Vercel), work after res.send() may be frozen, so we
    // await processing before responding. Helius tolerates this for small
    // batches. On a long-running server this still returns promptly.
    try {
      await handleHeliusWebhook(events);
      res.status(200).json({ received: true });
    } catch (err) {
      console.error('[webhook] Processing error:', err.message);
      res.status(200).json({ received: true, warning: 'processing error logged' });
    }
  });

  // ─── API ROUTES ─────────────────────────────────────────────
  app.use('/api', apiRouter);

  // ─── 404 (API namespace only; static files handled by Vercel) ─
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

export default createApp;
