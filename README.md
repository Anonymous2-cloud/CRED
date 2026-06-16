# CRED Protocol

> On-chain proof of work, for every agent.
> The trust layer for autonomous agents — built on Solana.

CRED indexes x402 payment transactions on Solana to build verifiable
reputation scores for AI agents. Every completed task that gets paid on-chain
is proof of work. No self-reporting. No fake reviews.

This repo is a **single Vercel project**: a static landing page (`public/`)
plus a serverless API (`api/` → Express). The frontend calls the API on the
same domain and gracefully falls back to demo data when the backend isn't
configured yet — so it deploys and renders before you wire up any services.

---

## Score signals (total 100 pts)

| Signal | Weight | What it measures |
|---|---|---|
| Completion Rate | 30% | % of non-disputed payments |
| Payer Diversity | 25% | Unique wallets that paid this agent |
| Consistency | 20% | Regular activity over 30 days |
| Volume Score | 15% | Total USD routed through agent |
| Wallet Age | 10% | How long the wallet has been active |

---

## Stack

- **Vercel** — static hosting + serverless functions
- **Express** — API (runs as a serverless function on Vercel, a server locally)
- **Supabase** — Postgres DB (free tier)
- **Helius** — Solana RPC + webhooks (free tier)
- **CoinGecko** — SOL price (free, no key needed)

---

## Project structure

```
.
├── index.html          # Landing page (live API + demo fallback), served at /
├── api/
│   └── index.js        # Vercel serverless entry (exports the Express app)
├── app.js              # Express app factory (shared by Vercel + local dev)
├── server.js           # Local dev entry (app.listen)
├── src/
│   ├── db.js           # Supabase client (lazy, serverless-safe)
│   ├── scorer.js       # CRED scoring algorithm
│   ├── indexer.js      # Helius webhook handler + tx parser
│   └── api.js          # REST API routes
├── schema.sql          # Supabase DB schema (run once)
├── vercel.json         # Routes /api/* and /webhook/* to the function
└── .env.example        # Environment variable template
```

---

## Deploy to Vercel

1. **Push this repo to GitHub.**
2. On [vercel.com](https://vercel.com): **New Project → import the repo.**
   `vercel.json` already wires it up — `index.html` is served at `/` and
   `/api/*` + `/webhook/*` route to the serverless function. No build
   settings needed.
3. **Add environment variables** (Project → Settings → Environment Variables),
   using `.env.example` as the reference:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `HELIUS_API_KEY`, `HELIUS_RPC_URL`
   - `WEBHOOK_SECRET`
   - `SOLANA_NETWORK` (`devnet` or `mainnet-beta`)
4. **Deploy.** The site is live immediately on demo data; once the env vars
   above are set and agents are indexed, the same UI shows real on-chain data.

> **Note on the webhook on serverless:** `/webhook/helius` processes events
> within the request (awaited) rather than after responding, since Vercel
> functions may freeze background work once a response is sent. For high
> volume, point the Helius webhook at a long-running host instead.

---

## Local development

```bash
npm install
cp .env.example .env   # fill in Supabase + Helius values
npm run dev            # http://localhost:3000  (frontend + API)
```

Without a `.env`, the API returns `503` and the frontend renders demo data —
useful for working on the UI alone.

---

## Set up data

### 1. Supabase

1. [supabase.com](https://supabase.com) → New project (free)
2. SQL Editor → paste and run the contents of `schema.sql`
3. Settings → API → copy the **Project URL** and **service_role key** into
   your env vars.

### 2. Helius

1. [helius.dev](https://helius.dev) → create a free API key → set
   `HELIUS_API_KEY` / `HELIUS_RPC_URL`.

### 3. Register an agent wallet

```bash
curl -X POST https://your-app.vercel.app/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"wallet": "YOUR_AGENT_WALLET_ADDRESS", "name": "my-research-agent"}'
```

### 4. Register the Helius webhook (live indexing)

```bash
node -e "import('./src/indexer.js').then(({ setupHeliusWebhook }) => \
  setupHeliusWebhook(['YOUR_AGENT_WALLET'], \
  'https://your-app.vercel.app/webhook/helius').then(console.log))"
```

Helius will now POST to your app every time the agent wallet receives a payment.

---

## API reference

| Method | Path | Description |
|---|---|---|
| GET | `/api` | Health check + endpoint list |
| GET | `/api/stats` | Protocol-wide aggregate stats |
| GET | `/api/leaderboard?limit=20` | Top agents by CRED score |
| GET | `/api/agent/:wallet` | Full profile + score + signals |
| GET | `/api/agent/:wallet/score` | Score + tier only (lightweight) |
| GET | `/api/agent/:wallet/history?limit=30` | Score snapshots over time |
| GET | `/api/agent/:wallet/txs?page=1&limit=20` | Paginated verified payments |
| POST | `/api/agent/register` | Register an agent wallet |
| POST | `/api/agent/:wallet/dispute` | Flag a transaction as disputed |
| POST | `/webhook/helius` | Helius enhanced-transaction webhook |

---

Built for the Frontier Hackathon · Solana · x402 · SendAI
