// src/api.js — CRED REST API Routes
//
// Base URL: https://yourapp.com/api
//
// GET  /api/agent/:wallet          → Full agent profile + score
// GET  /api/agent/:wallet/score    → Score only (for quick checks)
// GET  /api/agent/:wallet/history  → Score over time
// GET  /api/agent/:wallet/txs      → Paginated transaction list
// GET  /api/leaderboard            → Top agents by CRED score
// GET  /api/stats                  → Protocol-wide stats
// POST /api/agent/register         → Register a new agent wallet
// POST /api/agent/:wallet/dispute  → Flag a transaction as disputed

import express from 'express';
import { supabase, isSupabaseConfigured } from './db.js';
import { computeScore, saveScore } from './scorer.js';
import { registerAgent } from './indexer.js';

export const router = express.Router();

// ─── DB CONFIG GUARD ─────────────────────────────────────────
// Every route below needs Supabase. If it isn't configured (e.g. a fresh
// Vercel deploy without env vars yet), return a clean 503 so the frontend
// can fall back to demo data instead of surfacing a 500.

router.use((req, res, next) => {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({
      error: 'Backend not configured',
      hint: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY to enable live data.',
      demoMode: true,
    });
  }
  next();
});

// ─── GET /api/agent/:wallet ───────────────────────────────────
// Full agent profile with latest score and signals.

router.get('/agent/:wallet', async (req, res) => {
  try {
    const { wallet } = req.params;

    const { data: agent, error } = await supabase
      .from('agents')
      .select('*')
      .eq('wallet', wallet)
      .single();

    if (error || !agent) {
      return res.status(404).json({
        error: 'Agent not found',
        hint: 'Register this wallet first via POST /api/agent/register'
      });
    }

    // Compute fresh score
    const score = await computeScore(wallet);

    return res.json({
      success: true,
      agent: {
        wallet:      agent.wallet,
        name:        agent.name,
        description: agent.description,
        credScore:   score.credScore,
        tier:        getTier(score.credScore),
        signals:     score.signals,
        meta:        score.meta,
        categories:  agent.task_categories,
        registeredAt: agent.created_at,
      }
    });

  } catch (err) {
    console.error('[api] GET /agent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agent/:wallet/score ────────────────────────────
// Lightweight endpoint — just the score number and tier.
// Perfect for developers to check before hiring an agent.

router.get('/agent/:wallet/score', async (req, res) => {
  try {
    const { wallet } = req.params;

    const { data: agent } = await supabase
      .from('agents')
      .select('cred_score, last_active_at')
      .eq('wallet', wallet)
      .single();

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    return res.json({
      wallet,
      credScore:    agent.cred_score,
      tier:         getTier(agent.cred_score),
      lastActiveAt: agent.last_active_at,
      verifiedAt:   new Date().toISOString(),
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agent/:wallet/history ──────────────────────────
// Score snapshots over time for chart display.

router.get('/agent/:wallet/history', async (req, res) => {
  try {
    const { wallet } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);

    const { data, error } = await supabase
      .from('score_history')
      .select('cred_score, snapshot_at')
      .eq('agent_wallet', wallet)
      .order('snapshot_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json({
      wallet,
      history: (data || []).reverse(), // chronological order
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/agent/:wallet/txs ──────────────────────────────
// Paginated list of verified transactions.

router.get('/agent/:wallet/txs', async (req, res) => {
  try {
    const { wallet } = req.params;
    const page  = parseInt(req.query.page)  || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabase
      .from('transactions')
      .select('tx_signature, payer_wallet, amount_sol, amount_usd, task_memo, task_category, status, block_time', { count: 'exact' })
      .eq('agent_wallet', wallet)
      .order('block_time', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return res.json({
      wallet,
      transactions: data || [],
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/leaderboard ────────────────────────────────────
// Top agents ranked by CRED score.

router.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const { data, error } = await supabase
      .from('agents')
      .select('wallet, name, cred_score, total_tasks, total_payers, total_volume_usd, last_active_at, first_seen_at')
      .order('cred_score', { ascending: false })
      .gt('total_tasks', 0)
      .limit(limit);

    if (error) throw error;

    const ranked = (data || []).map((agent, i) => ({
      rank:         i + 1,
      wallet:       agent.wallet,
      name:         agent.name || shortenWallet(agent.wallet),
      credScore:    agent.cred_score,
      tier:         getTier(agent.cred_score),
      totalTasks:   agent.total_tasks,
      uniquePayers: agent.total_payers,
      volumeUsd:    agent.total_volume_usd,
      lastActive:   agent.last_active_at,
      ageInDays:    agent.first_seen_at
        ? Math.round((Date.now() - new Date(agent.first_seen_at)) / (1000 * 60 * 60 * 24))
        : 0,
    }));

    return res.json({ leaderboard: ranked, updatedAt: new Date().toISOString() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/stats ──────────────────────────────────────────
// Protocol-wide aggregate stats for the hero section.

router.get('/stats', async (req, res) => {
  try {
    const [agentCount, txStats] = await Promise.all([
      supabase.from('agents').select('*', { count: 'exact', head: true }),
      supabase.from('transactions').select('amount_usd, payer_wallet').eq('status', 'completed'),
    ]);

    const txs = txStats.data || [];
    const totalVolumeUsd = txs.reduce((s, t) => s + (t.amount_usd || 0), 0);
    const uniquePayers   = new Set(txs.map(t => t.payer_wallet)).size;

    return res.json({
      agentsIndexed:    agentCount.count || 0,
      txsVerified:      txs.length,
      totalVolumeUsd:   Math.round(totalVolumeUsd),
      uniquePayers,
      updatedAt:        new Date().toISOString(),
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agent/register ────────────────────────────────
// Register a new agent wallet to start being tracked.

router.post('/agent/register', async (req, res) => {
  try {
    const { wallet, name, description } = req.body;

    if (!wallet || typeof wallet !== 'string' || wallet.length < 32) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const agent = await registerAgent(wallet, { name, description });

    return res.status(201).json({
      success: true,
      message: 'Agent registered. CRED will start indexing your on-chain activity.',
      agent,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/agent/:wallet/dispute ─────────────────────────
// Flag a transaction as disputed.
// In production: require signature proof from payer wallet.

router.post('/agent/:wallet/dispute', async (req, res) => {
  try {
    const { wallet } = req.params;
    const { txSignature, reason } = req.body;

    if (!txSignature) {
      return res.status(400).json({ error: 'txSignature required' });
    }

    const { error } = await supabase
      .from('transactions')
      .update({ status: 'disputed' })
      .eq('tx_signature', txSignature)
      .eq('agent_wallet', wallet);

    if (error) throw error;

    // Recompute score with the dispute factored in
    const score = await computeScore(wallet);
    await saveScore(score);

    return res.json({
      success: true,
      message: 'Dispute recorded. Agent score has been recomputed.',
      newScore: score.credScore,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HELPERS ─────────────────────────────────────────────────

function getTier(score) {
  if (score >= 75) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

function shortenWallet(wallet) {
  return wallet ? `${wallet.slice(0, 4)}...${wallet.slice(-4)}` : 'unknown';
}
