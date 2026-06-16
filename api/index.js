// api/index.js — Vercel serverless entry point
//
// Vercel's @vercel/node runtime treats the default export as the request
// handler. We hand it the full Express app; vercel.json rewrites /api/* and
// /webhook/* here, so Express sees the original path and routes normally.

import { createApp } from '../app.js';

const app = createApp();

export default app;
