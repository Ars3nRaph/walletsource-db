# WalletSourceDB v4.0 — Deployment Guide

## Prerequisites

- Docker Desktop installed and running
- Node.js 18+ installed
- Git Bash or WSL (for Windows users)
- Helius API key (get one at [helius.dev](https://helius.dev))

## Quick Start (Paper Trading Mode)

### 1. Setup PostgreSQL Database

```bash
# Start PostgreSQL in Docker
./scripts/setup-db.sh
```

This will:
- Stop any existing containers
- Start PostgreSQL container with auto-schema initialization
- Verify 8 tables are created
- Display connection details

### 2. Configure Environment

Review and update `.env`:

```bash
# Critical settings
HELIUS_API_KEY=your_actual_api_key_here
SOLANA_WSS_URL=wss://atlas-mainnet.helius-rpc.com?api-key=your_actual_api_key_here

# Paper trading (MUST be true for testing)
PAPER_TRADING_MODE=true
PAPER_TRADING_LOG_FILE=./data/paper-trades.log
```

### 3. Install Dependencies & Build

```bash
npm install
npm run build
```

### 4. Start Paper Trading

```bash
# Option A: Use helper script (recommended)
./scripts/start-paper-trading.sh

# Option B: Direct npm start
npm start
```

## What Happens in Paper Trading Mode?

1. **ForensicWorker** detects new Pump.fun tokens via Solana WSS
2. **TokenTracker** polls DexScreener every 30s for 30 minutes (60 snapshots)
3. **PlaybookBuilder** analyzes rugger patterns and builds predictive playbooks
4. **PaperTradeExecutor** generates trade signals WITHOUT executing real trades
5. All signals are logged to `data/paper-trades.log`

### Sample Log Entry

```json
{
  "timestamp": "2024-03-07T12:34:56.789Z",
  "token": "TokenMintAddress...",
  "elapsed_min": "5.50",
  "current_mc": 45000,
  "action": "BUY",
  "confidence": "0.875",
  "percentage": 100,
  "reason": "Entry window (0-4.9 min)",
  "strategy": "RIDE",
  "fallback": false
}
```

## Monitoring

### Real-time Logs

```bash
# Watch system logs
npm start

# Watch paper trades
tail -f data/paper-trades.log
```

### Database Inspection

```bash
# Start pgAdmin
docker-compose up -d pgadmin

# Access at http://localhost:5050
# Email: admin@walletsource.local
# Password: admin
```

Add server connection:
- Host: postgres (Docker internal network)
- Port: 5432
- Database: walletsource
- Username: walletsource
- Password: walletsource_dev

### Paper Trading Statistics

Query from application logs or directly from `data/paper-trades.log`:

```bash
# Count signals by action
cat data/paper-trades.log | jq -r '.action' | sort | uniq -c

# Average confidence
cat data/paper-trades.log | jq -r '.confidence' | awk '{sum+=$1; count++} END {print sum/count}'

# Signals by strategy
cat data/paper-trades.log | jq -r '.strategy' | sort | uniq -c
```

## Database Schema

8 tables auto-created on first PostgreSQL start:

1. **wallet_profiles** — Creator profiles with playbook
2. **wallet_ancestry** — Funding relationships (depth 0-3)
3. **token_events** — Token detections with verdicts
4. **token_snapshots** — 30-min tracking data (60 snapshots/token)
5. **cartel_groups** — Wallet clusters
6. **taint_log** — Rug propagation history
7. **monitoring_queue** — Token tracking queue
8. **calibration_log** — Weekly sigmoid recalibration

## Production Checklist

**Before enabling real trading:**

- [ ] Paper trading ran for at least 7 days
- [ ] Analyzed `data/paper-trades.log` for accuracy
- [ ] Validated playbook recommendations (RIDE/FADE/WATCH/AVOID)
- [ ] Reviewed wallet strategies in database
- [ ] Confirmed rate limits respected (300 req/min DexScreener)
- [ ] Set up trade execution infrastructure (DEX integration)
- [ ] Configured position sizing and risk management
- [ ] Enabled monitoring/alerting
- [ ] Set `PAPER_TRADING_MODE=false` in `.env`

## Stopping the System

```bash
# Stop application
Ctrl+C

# Stop PostgreSQL
docker-compose down

# Stop and remove all data (WARNING: deletes database)
docker-compose down -v
```

## Troubleshooting

### PostgreSQL won't start

```bash
# Check Docker logs
docker-compose logs postgres

# Common fix: remove old volumes
docker-compose down -v
./scripts/setup-db.sh
```

### Schema not loading

```bash
# Manually load schema
docker exec -i walletsource-db psql -U walletsource -d walletsource < src/db/schema.sql
```

### WebSocket disconnections

- Check Helius API key validity
- Monitor rate limits (100k credits/month free tier)
- Verify WSS URL includes API key

### No tokens detected

- Pump.fun activity varies by time of day
- Peak hours: 10:00-22:00 UTC
- Low activity is normal during off-peak

### Rate limit errors

- DexScreener: 300 req/min (5 req/s)
- System handles 150 simultaneous tokens (2 req/token/min)
- Reduce tracking if exceeding limits

## Architecture Overview

```
┌─────────────────┐
│  Solana WSS     │ ──▶ ForensicWorker (detects new tokens)
└─────────────────┘           │
                              ▼
                    ┌───────────────────┐
                    │ monitoring_queue  │
                    └───────────────────┘
                              │
                              ▼
┌─────────────────┐     TokenTracker (30min polling)
│  DexScreener    │ ◀──────────┤
└─────────────────┘            │
                              ▼
                    ┌───────────────────┐
                    │ token_snapshots   │ (60 snapshots)
                    │ token_events      │ (verdict after 30min)
                    └───────────────────┘
                              │
                              ▼
                      PlaybookBuilder
                              │
                              ▼
                    ┌───────────────────┐
                    │ rugger_playbook   │ (temporal windows)
                    └───────────────────┘
                              │
                              ▼
                   PaperTradeExecutor (v4.0)
                              │
                              ▼
                    ┌───────────────────┐
                    │ paper-trades.log  │
                    └───────────────────┘
```

## Next Steps

1. **Week 1-2**: Monitor paper trades, validate detection accuracy
2. **Week 3-4**: Analyze playbook consistency scores, tune thresholds
3. **Week 5-7**: Evaluate strategy recommendations (RIDE/FADE)
4. **Week 8+**: Consider real trading integration (if metrics justify)

## Support

- Issues: Check logs in `data/` directory
- Schema: Review `src/db/schema.sql`
- Documentation: `CLAUDE.md`, `PRD_WalletSourceDB_v3.0.md`
- Tests: `npm test` (178 tests, 98.3% passing)
