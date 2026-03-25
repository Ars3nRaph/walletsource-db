# CLAUDE.md — WalletSourceDB Development Guide

## Project Overview

WalletSourceDB is a Solana pump.fun memecoin sniping bot that detects new token launches, classifies creator wallets by historical behavior, and executes paper/live trades with asymmetric risk-reward strategies.

**Current version**: v10.13 (STD) / NEO v4.27 / CARTEL v1.0

## Architecture

```
┌─────────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   ForensicWorker    │────▶│   TokenTracker   │────▶│  TradeExecutor   │
│  (WSS: new tokens)  │     │ (lifecycle track) │     │  (3 strategies)  │
└─────────────────────┘     └──────────────────┘     └──────────────────┘
         │                           │                        │
         ▼                           ▼                        ▼
┌─────────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  PumpTradeStream    │────▶│   PostgreSQL DB  │◀────│PaperTradeExecutor│
│  (tick-by-tick WS)  │     │  (11 tables)     │     │ or LiveTradeExec │
└─────────────────────┘     └──────────────────┘     └──────────────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │ Web Dashboard    │
                            │ (port 3001)      │
                            └──────────────────┘
```

## Quick Start

```bash
# 1. Start PostgreSQL
docker compose up -d postgres

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 4. Build TypeScript
npx tsc

# 5. Start the bot
pm2 start dist/src/index.js --name walletsource-db \
  --kill-timeout 10000 \
  --node-args="--max-old-space-size=3072"

# 6. Start the dashboard
pm2 start scripts/web-dashboard/server.js --name walletsource-dashboard

# 7. Save PM2 config
pm2 save
```

## Critical Development Rules

### ⚠️ NEVER restart PM2 directly
```bash
# WRONG — kills open positions
pm2 restart walletsource-db

# RIGHT — checks for open positions first
./scripts/safe-restart.sh
```

### Build before restart
PM2 runs compiled JS from `dist/src/index.js`. Any TypeScript change requires:
```bash
npx tsc && ./scripts/safe-restart.sh
```

### Memory management
- `rawTrades` capped at 500 per token (was 2000 → OOM)
- `liveState` capped at 1000 tokens (evicts non-position tokens)
- Heap set to 3072 MB via `--max-old-space-size`
- PumpTradeStream: 2000 max subscriptions, 10min TTL

### Position safety (5 layers)
1. `safe-restart.sh` — blocks restart if positions are open
2. Graceful shutdown — `SIGTERM` handler saves positions to DB
3. PM2 `kill-timeout: 10000` — 10s grace for shutdown
4. Position recovery — on startup, recovers BUYs without SELL from DB
5. PumpTradeStream — never evicts tokens with open positions

## Three Trading Strategies

### STANDARD (STD) v10.13 — Market Validation
- **Entry**: ≥70 buyers, ratio 2.0-3.0x, <30 dumps, momentum 3%+ rising, window 30-110s
- **Filters**: FADE wallets blocked, Quality Score (Q0-Q4)
- **Exit**: Hard stop -20%, RT-TRAIL 20% @ +50% peak, PUMP3 @ 50%
- **Post-entry**: 60s confirmation — SELL_DOM exits, STRONG flagged
- **Sizing**: 0.30-0.50 SOL (risk-adjusted by wallet + quality)
- **Max concurrent**: 3

### NEO v4.27 — Early Entry
- **Entry**: ratio 1.0-2.0x, ≥20 buyers, window 15-120s, sell_ratio ≤0.44, topHolder ≤20%, dumps ≤25
- **Filters**: Q0 blocked, FADE ≥0.65
- **Exit**: Hard stop -25%, adaptive trail @ +25% (10-22% drop tiers), PUMP3 @ 25%
- **Sizing**: Q1:0.15, Q2:0.20, Q3:0.25, Q4:0.25 SOL
- **Max concurrent**: 3

### CARTEL v1.0 — Good Wallet Convergence
- **Entry**: 2+ wallets with 65%+ WR on 15+ tokens buying same token within 10-120s
- **Filters**: FADE ≥0.65, no circuit breaker
- **Exit**: Hard stop -20%, RT-TRAIL 20% @ +30% peak, PUMP3 enabled
- **Sizing**: 2 wallets→0.50, 3→0.60, 4+→0.70 SOL
- **Max concurrent**: 3

## Database Schema

11 tables in PostgreSQL 15:

| Table | Purpose | Size (typical) |
|-------|---------|----------------|
| `wallet_profiles` | Wallet classification (RIDE/FADE/WATCH/AVOID) | ~50k rows |
| `wallet_ancestry` | Funding chain relationships | ~100k rows |
| `token_events` | Token lifecycle tracking | ~170k rows |
| `token_snapshots` | Tick-by-tick MC/price snapshots | ~2M rows |
| `trade_events` | Individual buy/sell transactions | ~12M rows |
| `paper_trades` | Paper trading BUY/SELL records | ~1k rows |
| `live_trades` | Real on-chain trade records | 0 (DRY_RUN) |
| `cartel_groups` | Wallet group detection | ~100 rows |
| `taint_log` | Wallet risk propagation log | ~50k rows |
| `monitoring_queue` | Token monitoring queue | transient |
| `calibration_log` | Scoring calibration | ~1k rows |

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/execution/TradeExecutor.ts` | ~1976 | Core trading logic — all 3 strategies |
| `src/workers/PumpTradeStream.ts` | ~345 | WebSocket trade feed from PumpPortal |
| `src/execution/PaperTradeExecutor.ts` | ~441 | Paper trade recording to DB |
| `src/execution/LiveTradeExecutor.ts` | ~527 | Real trade execution (Jito bundles) |
| `src/execution/CartelDetector.ts` | ~151 | Good wallet convergence detection |
| `src/workers/TokenTracker.ts` | ~900+ | Token lifecycle tracking |
| `src/workers/ForensicWorker.ts` | ~500+ | New token detection via WSS |
| `scripts/web-dashboard/server.js` | ~727 | Dashboard API server |
| `scripts/web-dashboard/wallet.html` | ~1073 | Wallet simulation page |
| `data/neo-config.json` | JSON | NEO strategy live config |

## WebSocket Reliability (v10.13)

PumpPortal disconnects ~12x/day (30-250s gaps). Protections:

1. **Ping keepalive** every 30s
2. **Pong tracking** — force reconnect if no pong in 90s
3. **Message watchdog** — force reconnect if no messages in 60s
4. **Post-reconnect MC check** — fetches current MC via pump.fun API for all open positions
5. **Subscription guard** — every 60s, verifies position tokens are subscribed
6. **Sweep `lastTickAt`** — closes positions with no tick in 5+ minutes past max hold

## Fees & Economics

- Pump.fun: 1% fee per side
- Bonding curve slippage: ~0.83% per side (at 0.25 SOL / $6k MC)
- Jito tips: 100k lamports (buy) / 450k lamports (sell)
- **Total round-trip: ~4.5% (conservative dashboard estimate: 8%)**
- **Breakeven: +12% gross P&L**
- **Fees consume 55-85% of gross gains** — this is the primary drag

## Environment Variables

See `.env.example` for all required variables. Key ones:
- `DATABASE_URL` — PostgreSQL connection string
- `SOLANA_WSS_URL` — Helius WebSocket for token detection
- `HELIUS_API_KEY` — Helius RPC for wallet ancestry
- `DRY_RUN=true` — Paper trading mode (default)
- `WALLET_PRIVATE_KEY` — Required for live trading only

## PM2 Process Management

```bash
pm2 show walletsource-db          # Status
pm2 logs walletsource-db          # Live logs
pm2 monit                         # CPU/Memory monitor
./scripts/safe-restart.sh         # Safe restart (checks positions)
pm2 save                          # Persist config
```

## Cron Jobs (via OpenClaw)

| Job | Schedule | Purpose |
|-----|----------|---------|
| `v10-hourly-analysis` | Every hour | Performance report |
| `neo-autonomous-optimizer` | Every 2h | NEO strategy auto-tuning |
| `Rebuild playbooks` | Daily 08:00 UTC | Wallet playbook refresh |
