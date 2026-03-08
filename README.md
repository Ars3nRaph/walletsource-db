# WalletSourceDB v4.0 — "Ride the Rugger"

On-chain forensic intelligence database for Solana/Pump.fun wallet profiling and predictive trading.

## Quick Start

```bash
# 1. Setup PostgreSQL (Docker)
npm run db:setup

# 2. Install dependencies
npm install

# 3. Build project
npm run build

# 4. Start in paper trading mode
npm run paper:start
```

## Documentation

- **[DEPLOY.md](./DEPLOY.md)** — Complete deployment guide (PostgreSQL, paper trading, monitoring)
- **[CLAUDE.md](./CLAUDE.md)** — Technical architecture and development guidelines
- **[PRD_WalletSourceDB_v3.0.md](./PRD_WalletSourceDB_v3.0.md)** — Full product requirements

## What is this?

WalletSourceDB builds a live forensic database of Solana wallets that create tokens on Pump.fun. It:

1. **Detects** new tokens via Solana WebSocket
2. **Tracks** each token for 30 minutes (60 snapshots at 30s intervals)
3. **Analyzes** rugger behavior patterns (timing, consistency, dump speed)
4. **Builds** predictive playbooks (temporal windows for entry/exit)
5. **Generates** trade signals (RIDE/FADE strategies)

### Key Innovation: Time-Based Execution

Unlike traditional price-based exits, v4.0 uses **temporal windows** derived from a wallet's historical rug patterns:

- **RIDE**: Exploit predictable ruggers (buy early, sell before dump)
- **FADE**: Short predictable peaks (short at peak, cover after dump)
- **WATCH**: Insufficient data (fallback to P_exit)
- **AVOID**: Too chaotic (fallback to P_exit)

## Paper Trading Mode

**IMPORTANT**: System starts in paper trading mode by default. All trade signals are logged but NOT executed.

```bash
# View paper trades
tail -f data/paper-trades.log

# Statistics
npm run paper:stats
```

## Architecture

```
Solana WSS → ForensicWorker → TokenTracker (30min) → PlaybookBuilder → TradeExecutor
                                                                            ↓
                                                                    paper-trades.log
```

8 PostgreSQL tables:
- `wallet_profiles` — Creator profiles with playbooks
- `token_events` — Token verdicts (RUG/SUCCESS/NEUTRAL)
- `token_snapshots` — 30-min tracking data
- `wallet_ancestry` — Funding relationships
- `cartel_groups` — Wallet clusters
- `taint_log` — Rug propagation
- `monitoring_queue` — Tracking queue
- `calibration_log` — Weekly tuning

## Development

```bash
# Type check
npm run type-check

# Lint
npm run lint

# Tests (178 tests, 98.3% passing)
npm test

# Coverage
npm run test:coverage

# Watch mode
npm run start:dev
```

## Database Management

```bash
# Start PostgreSQL
npm run db:start

# Stop PostgreSQL
npm run db:stop

# Reset database (WARNING: deletes all data)
npm run db:reset

# pgAdmin (optional)
docker-compose up -d pgadmin
# Access: http://localhost:5050
```

## Configuration

Edit `.env`:

```env
# Helius API (required)
HELIUS_API_KEY=your_key_here
SOLANA_WSS_URL=wss://atlas-mainnet.helius-rpc.com?api-key=your_key_here

# Database (Docker default)
DATABASE_URL=postgresql://walletsource:walletsource_dev@localhost:5432/walletsource

# Paper trading (MUST be true for testing)
PAPER_TRADING_MODE=true
PAPER_TRADING_LOG_FILE=./data/paper-trades.log

# Rate limits
DEXSCREENER_RATE_LIMIT=300  # req/min

# Logging
LOG_LEVEL=info
```

## Production Deployment

See [DEPLOY.md](./DEPLOY.md) for full production checklist.

**DO NOT** set `PAPER_TRADING_MODE=false` until:
- 7+ days of paper trading completed
- Playbook accuracy validated
- Trade execution infrastructure ready
- Risk management configured

## License

MIT

## Support

For issues, check:
1. `data/` directory for logs
2. Docker logs: `docker-compose logs postgres`
3. Schema: `src/db/schema.sql`
4. Tests: `npm test`
