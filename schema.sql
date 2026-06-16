-- ─────────────────────────────────────────────────────────────
-- CRED Protocol — Supabase Schema
-- Run this in your Supabase SQL editor (free tier)
-- ─────────────────────────────────────────────────────────────

-- AGENTS table
-- One row per agent wallet. Stores identity + computed scores.
create table if not exists agents (
  id uuid default gen_random_uuid() primary key,
  wallet text unique not null,           -- Solana wallet address
  name text,                             -- Optional claimed name
  description text,                      -- Optional claimed description
  task_categories text[] default '{}',   -- e.g. ['research', 'trading']

  -- Core metrics (computed by scorer)
  cred_score integer default 0,          -- 0–100 final score
  completion_rate numeric default 0,     -- % of non-disputed txs
  payer_diversity integer default 0,     -- unique payer count
  consistency_score numeric default 0,   -- activity regularity 0–100
  volume_score numeric default 0,        -- normalized volume score 0–100
  age_score numeric default 0,           -- wallet age score 0–100

  -- Raw counters
  total_tasks integer default 0,
  total_payers integer default 0,
  total_volume_usd numeric default 0,
  dispute_count integer default 0,
  first_seen_at timestamptz,
  last_active_at timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- TRANSACTIONS table
-- Every verified x402 payment event for a known agent wallet.
create table if not exists transactions (
  id uuid default gen_random_uuid() primary key,
  tx_signature text unique not null,     -- Solana tx signature
  agent_wallet text not null references agents(wallet),
  payer_wallet text not null,            -- Who paid the agent
  amount_sol numeric,                    -- Amount in SOL
  amount_usd numeric,                    -- USD equivalent at time of tx
  task_memo text,                        -- Optional memo from tx
  task_category text,                    -- Inferred or tagged category
  status text default 'completed',       -- completed | disputed | failed
  block_time timestamptz,                -- On-chain timestamp
  slot bigint,                           -- Solana slot number
  raw_data jsonb,                        -- Full raw tx from Helius
  created_at timestamptz default now()
);

-- SCORE HISTORY table
-- Tracks score changes over time for charts.
create table if not exists score_history (
  id uuid default gen_random_uuid() primary key,
  agent_wallet text not null references agents(wallet),
  cred_score integer,
  snapshot_at timestamptz default now()
);

-- WEBHOOK EVENTS table
-- Logs every raw event received from Helius for debugging.
create table if not exists webhook_events (
  id uuid default gen_random_uuid() primary key,
  raw_payload jsonb,
  processed boolean default false,
  error text,
  received_at timestamptz default now()
);

-- ─── INDEXES ─────────────────────────────────────────────────
create index if not exists idx_transactions_agent on transactions(agent_wallet);
create index if not exists idx_transactions_payer on transactions(payer_wallet);
create index if not exists idx_transactions_block_time on transactions(block_time desc);
create index if not exists idx_agents_cred_score on agents(cred_score desc);
create index if not exists idx_score_history_wallet on score_history(agent_wallet, snapshot_at desc);

-- ─── UPDATED_AT TRIGGER ──────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger agents_updated_at
  before update on agents
  for each row execute function update_updated_at();

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────
-- Public read, service-role write only
alter table agents enable row level security;
alter table transactions enable row level security;
alter table score_history enable row level security;

create policy "Public read agents" on agents for select using (true);
create policy "Public read transactions" on transactions for select using (true);
create policy "Public read score history" on score_history for select using (true);
