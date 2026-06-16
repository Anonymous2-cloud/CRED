// src/indexer.js — Helius Webhook Handler + Transaction Indexer
//
// This receives POST requests from Helius every time a tracked
// wallet receives a payment. It parses the tx, stores it, and
// triggers a score recompute for that agent.

import { supabase } from './db.js';
import { computeScore, saveScore } from './scorer.js';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const SOL_PRICE_CACHE = { price: 150, fetchedAt: 0 };

// ─── WEBHOOK HANDLER ─────────────────────────────────────────

/**
 * Main entry point — called by Express route POST /webhook/helius
 * Helius sends an array of enhanced transaction objects.
 */
export async function handleHeliusWebhook(events) {
  for (const event of events) {
    // Log raw event first so we never lose data
    await logRawEvent(event);

    try {
      await processEvent(event);
    } catch (err) {
      console.error(`[indexer] Failed to process tx ${event.signature}:`, err.message);
      await markEventError(event.signature, err.message);
    }
  }
}

/**
 * Process a single Helius enhanced transaction event.
 */
async function processEvent(event) {
  const { signature, timestamp, nativeTransfers, tokenTransfers, accountData, description } = event;

  if (!signature) return;

  // Skip if already indexed
  const { data: existing } = await supabase
    .from('transactions')
    .select('id')
    .eq('tx_signature', signature)
    .single();

  if (existing) {
    console.log(`[indexer] Tx already indexed: ${signature}`);
    return;
  }

  // ── Identify the agent wallet and payer wallet ────────────
  // In an x402 payment: payer sends SOL to agent.
  // The agent wallet is whichever account we're tracking.
  const agentWallet = await findTrackedWallet(accountData);
  if (!agentWallet) {
    console.log(`[indexer] No tracked agent in tx ${signature}, skipping`);
    return;
  }

  // Find the transfer TO the agent (the payment)
  const payment = findPaymentToAgent(nativeTransfers, agentWallet);
  if (!payment || payment.amount <= 0) {
    console.log(`[indexer] No incoming payment found in ${signature}`);
    return;
  }

  const payerWallet = payment.fromUserAccount;
  const amountSol   = payment.amount / 1e9; // lamports → SOL
  const amountUsd   = amountSol * (await getSolPrice());

  // ── Parse memo for task info ──────────────────────────────
  const memo         = extractMemo(event);
  const taskCategory = inferCategory(memo || description || '');
  const blockTime    = timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString();

  // ── Ensure agent exists in DB ─────────────────────────────
  await ensureAgent(agentWallet);

  // ── Store the transaction ─────────────────────────────────
  const { error } = await supabase.from('transactions').insert({
    tx_signature:   signature,
    agent_wallet:   agentWallet,
    payer_wallet:   payerWallet,
    amount_sol:     amountSol,
    amount_usd:     amountUsd,
    task_memo:      memo,
    task_category:  taskCategory,
    status:         'completed',
    block_time:     blockTime,
    slot:           event.slot || null,
    raw_data:       event,
  });

  if (error) {
    if (error.code === '23505') return; // duplicate, fine
    throw new Error(`Insert tx failed: ${error.message}`);
  }

  console.log(`[indexer] ✓ Indexed tx ${signature} | Agent: ${agentWallet} | $${amountUsd.toFixed(4)}`);

  // ── Recompute agent score ─────────────────────────────────
  const score = await computeScore(agentWallet);
  await saveScore(score);
  console.log(`[indexer] ✓ Score updated for ${agentWallet}: ${score.credScore}`);
}

// ─── HELPERS ─────────────────────────────────────────────────

/**
 * Find which account in the tx is a tracked agent wallet.
 * Returns the wallet address or null.
 */
async function findTrackedWallet(accountData) {
  if (!accountData) return null;

  const addresses = accountData.map(a => a.account);

  const { data } = await supabase
    .from('agents')
    .select('wallet')
    .in('wallet', addresses)
    .limit(1);

  return data?.[0]?.wallet || null;
}

/**
 * From the nativeTransfers array, find the transfer that
 * goes TO the agent wallet (the payment received).
 */
function findPaymentToAgent(nativeTransfers, agentWallet) {
  if (!nativeTransfers) return null;
  return nativeTransfers.find(t => t.toUserAccount === agentWallet) || null;
}

/**
 * Extract memo text from the transaction if present.
 * x402 payments often include a task description in the memo program.
 */
function extractMemo(event) {
  try {
    const instructions = event.instructions || [];
    const memoIx = instructions.find(ix =>
      ix.programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
    );
    return memoIx?.data ? Buffer.from(memoIx.data, 'base64').toString('utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Infer task category from memo or description text.
 * Simple keyword matching — can be upgraded with LLM later.
 */
function inferCategory(text) {
  const t = text.toLowerCase();
  if (t.includes('research') || t.includes('scrape') || t.includes('search')) return 'research';
  if (t.includes('trade') || t.includes('swap') || t.includes('order'))       return 'trading';
  if (t.includes('content') || t.includes('write') || t.includes('draft'))    return 'content';
  if (t.includes('data') || t.includes('pipeline') || t.includes('etl'))      return 'data';
  if (t.includes('support') || t.includes('ticket') || t.includes('help'))    return 'support';
  if (t.includes('code') || t.includes('review') || t.includes('debug'))      return 'engineering';
  return 'general';
}

/**
 * Ensure an agent row exists. Creates one if not.
 */
async function ensureAgent(wallet) {
  await supabase
    .from('agents')
    .upsert({ wallet }, { onConflict: 'wallet', ignoreDuplicates: true });
}

/**
 * Get current SOL price in USD.
 * Caches for 5 minutes to avoid rate limits.
 */
async function getSolPrice() {
  const now = Date.now();
  if (now - SOL_PRICE_CACHE.fetchedAt < 5 * 60 * 1000) {
    return SOL_PRICE_CACHE.price;
  }
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 4000 }
    );
    SOL_PRICE_CACHE.price = res.data.solana.usd;
    SOL_PRICE_CACHE.fetchedAt = now;
    return SOL_PRICE_CACHE.price;
  } catch {
    return SOL_PRICE_CACHE.price; // fallback to cached
  }
}

/**
 * Log raw Helius event to webhook_events table.
 */
async function logRawEvent(event) {
  await supabase.from('webhook_events').insert({
    raw_payload: event,
    processed: false,
  });
}

/**
 * Mark a webhook event as errored.
 */
async function markEventError(signature, errorMsg) {
  await supabase
    .from('webhook_events')
    .update({ error: errorMsg })
    .eq('raw_payload->>signature', signature);
}

// ─── MANUAL WALLET REGISTRATION ──────────────────────────────

/**
 * Register a new agent wallet to start tracking it.
 * Call this when an agent claims their profile.
 */
export async function registerAgent(wallet, metadata = {}) {
  const { data, error } = await supabase
    .from('agents')
    .upsert({
      wallet,
      name:        metadata.name        || null,
      description: metadata.description || null,
    }, { onConflict: 'wallet' })
    .select()
    .single();

  if (error) throw new Error(`Failed to register agent: ${error.message}`);

  // Kick off an initial score compute
  const score = await computeScore(wallet);
  await saveScore(score);

  return data;
}

// ─── HELIUS WEBHOOK SETUP HELPER ─────────────────────────────

/**
 * Register a webhook with Helius for a list of wallet addresses.
 * Call once during setup — not on every server start.
 * 
 * Usage: await setupHeliusWebhook(['wallet1', 'wallet2'], 'https://yourapp.com/webhook/helius')
 */
export async function setupHeliusWebhook(walletAddresses, webhookUrl) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error('HELIUS_API_KEY not set');

  const response = await axios.post(
    `https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`,
    {
      webhookURL:        webhookUrl,
      transactionTypes:  ['TRANSFER'],
      accountAddresses:  walletAddresses,
      webhookType:       'enhanced',
      authHeader:        process.env.WEBHOOK_SECRET,
    }
  );

  return response.data;
}
