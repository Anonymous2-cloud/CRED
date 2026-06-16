// src/db.js — Supabase client (lazy + serverless-safe)
//
// On Vercel each serverless function imports this module. If we threw at
// import time when env vars are missing, the whole function (including the
// health check) would crash before it could return a useful error. Instead
// we create the client lazily and surface a clean, explicit error only when
// a route actually tries to hit the database.

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

let _client = null;

/** Returns true when Supabase credentials are present. */
export function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

/**
 * Lazily create (and cache) the Supabase client.
 * Throws a descriptive error if credentials are missing so the API can
 * return a 503 instead of the process crashing at import time.
 */
export function getSupabase() {
  if (_client) return _client;

  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY ' +
      'in your environment (see .env.example).'
    );
  }

  _client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  return _client;
}

// Backwards-compatible proxy: existing code does `supabase.from(...)`.
// Each property access resolves the real client on demand.
export const supabase = new Proxy({}, {
  get(_target, prop) {
    const client = getSupabase();
    const value = client[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
