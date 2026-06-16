// src/scorer.js — CRED Reputation Scoring Engine
//
// Score breakdown (total: 100 points):
//   Completion Rate    → 30 pts  (most important signal)
//   Payer Diversity    → 25 pts  (prevents fake self-payments)
//   Consistency        → 20 pts  (regular activity over time)
//   Volume Score       → 15 pts  (economic weight)
//   Wallet Age         → 10 pts  (longevity = trust)

import { supabase } from './db.js';

// ─── WEIGHT CONFIG ───────────────────────────────────────────
const WEIGHTS = {
  completionRate: 0.30,
  payerDiversity: 0.25,
  consistency:    0.20,
  volume:         0.15,
  age:            0.10,
};

// ─── THRESHOLDS ──────────────────────────────────────────────
const THRESHOLDS = {
  // Payer diversity: how many unique payers = 100%
  maxPayersForFullScore: 50,
  // Volume: $10k routed = 100%
  maxVolumeForFullScore: 10000,
  // Age: 90 days old = 100%
  maxAgeForFullScore: 90,
  // Consistency window: days to look back
  consistencyWindowDays: 30,
};

/**
 * Compute CRED score for a given agent wallet.
 * Pulls all their tx data from Supabase and runs the scoring algo.
 */
export async function computeScore(walletAddress) {
  // Fetch all transactions for this agent
  const { data: txs, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('agent_wallet', walletAddress)
    .order('block_time', { ascending: true });

  if (error) throw new Error(`DB error fetching txs: ${error.message}`);

  // No transactions = zero score
  if (!txs || txs.length === 0) {
    return buildZeroScore(walletAddress);
  }

  const completedTxs = txs.filter(t => t.status === 'completed');
  const disputedTxs  = txs.filter(t => t.status === 'disputed');

  // ── 1. COMPLETION RATE ───────────────────────────────────
  // Raw % of completed vs total (non-failed). Disputes hurt more than fails.
  const completionRate = txs.length > 0
    ? Math.max(0, (completedTxs.length - (disputedTxs.length * 2)) / txs.length)
    : 0;
  const completionScore = Math.min(1, Math.max(0, completionRate));

  // ── 2. PAYER DIVERSITY ───────────────────────────────────
  // Count unique payer wallets. More payers = harder to fake.
  const uniquePayers = new Set(completedTxs.map(t => t.payer_wallet)).size;
  const payerScore = Math.min(1, uniquePayers / THRESHOLDS.maxPayersForFullScore);

  // ── 3. CONSISTENCY ───────────────────────────────────────
  // Were they active regularly over the last 30 days?
  // We split the window into 6 buckets and score how many had activity.
  const consistencyScore = computeConsistency(completedTxs);

  // ── 4. VOLUME SCORE ──────────────────────────────────────
  // Total USD routed through the agent, normalized.
  const totalVolumeUsd = completedTxs.reduce((sum, t) => sum + (t.amount_usd || 0), 0);
  const volumeScore = Math.min(1, totalVolumeUsd / THRESHOLDS.maxVolumeForFullScore);

  // ── 5. WALLET AGE ────────────────────────────────────────
  // Days since first transaction.
  const firstTx = txs[0];
  const ageInDays = firstTx
    ? (Date.now() - new Date(firstTx.block_time).getTime()) / (1000 * 60 * 60 * 24)
    : 0;
  const ageScore = Math.min(1, ageInDays / THRESHOLDS.maxAgeForFullScore);

  // ── FINAL WEIGHTED SCORE (0–100) ─────────────────────────
  const rawScore =
    (completionScore  * WEIGHTS.completionRate) +
    (payerScore       * WEIGHTS.payerDiversity) +
    (consistencyScore * WEIGHTS.consistency)    +
    (volumeScore      * WEIGHTS.volume)         +
    (ageScore         * WEIGHTS.age);

  const credScore = Math.round(rawScore * 100);

  return {
    wallet: walletAddress,
    credScore,
    signals: {
      completionRate:   Math.round(completionScore  * 100),
      payerDiversity:   Math.round(payerScore       * 100),
      consistency:      Math.round(consistencyScore * 100),
      volumeScore:      Math.round(volumeScore      * 100),
      ageScore:         Math.round(ageScore         * 100),
    },
    meta: {
      totalTasks:       txs.length,
      completedTasks:   completedTxs.length,
      disputedTasks:    disputedTxs.length,
      uniquePayers,
      totalVolumeUsd:   Math.round(totalVolumeUsd * 100) / 100,
      ageInDays:        Math.round(ageInDays),
      firstSeenAt:      firstTx?.block_time || null,
      lastActiveAt:     txs[txs.length - 1]?.block_time || null,
    }
  };
}

/**
 * Consistency scoring.
 * Splits the last 30 days into 6 x 5-day buckets.
 * Score = % of buckets that had at least one completed tx.
 */
function computeConsistency(completedTxs) {
  const now = Date.now();
  const windowMs = THRESHOLDS.consistencyWindowDays * 24 * 60 * 60 * 1000;
  const bucketCount = 6;
  const bucketMs = windowMs / bucketCount;

  // Only look at txs within the window
  const recentTxs = completedTxs.filter(t =>
    new Date(t.block_time).getTime() > now - windowMs
  );

  if (recentTxs.length === 0) return 0;

  // Mark which buckets have activity
  const activeBuckets = new Set();
  for (const tx of recentTxs) {
    const age = now - new Date(tx.block_time).getTime();
    const bucket = Math.floor(age / bucketMs);
    if (bucket < bucketCount) activeBuckets.add(bucket);
  }

  return activeBuckets.size / bucketCount;
}

/**
 * Zero score object for wallets with no history.
 */
function buildZeroScore(wallet) {
  return {
    wallet,
    credScore: 0,
    signals: {
      completionRate: 0,
      payerDiversity: 0,
      consistency:    0,
      volumeScore:    0,
      ageScore:       0,
    },
    meta: {
      totalTasks:     0,
      completedTasks: 0,
      disputedTasks:  0,
      uniquePayers:   0,
      totalVolumeUsd: 0,
      ageInDays:      0,
      firstSeenAt:    null,
      lastActiveAt:   null,
    }
  };
}

/**
 * Persist the computed score back to the agents table
 * and write a snapshot to score_history.
 */
export async function saveScore(scoreResult) {
  const { wallet, credScore, signals, meta } = scoreResult;

  // Upsert agent row
  const { error: upsertError } = await supabase
    .from('agents')
    .upsert({
      wallet,
      cred_score:        credScore,
      completion_rate:   signals.completionRate,
      payer_diversity:   meta.uniquePayers,
      consistency_score: signals.consistency,
      volume_score:      signals.volumeScore,
      age_score:         signals.ageScore,
      total_tasks:       meta.totalTasks,
      total_payers:      meta.uniquePayers,
      total_volume_usd:  meta.totalVolumeUsd,
      first_seen_at:     meta.firstSeenAt,
      last_active_at:    meta.lastActiveAt,
    }, { onConflict: 'wallet' });

  if (upsertError) throw new Error(`Failed to save agent: ${upsertError.message}`);

  // Append to score history
  await supabase.from('score_history').insert({
    agent_wallet: wallet,
    cred_score: credScore,
  });
}
