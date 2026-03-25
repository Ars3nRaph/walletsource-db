# PRD — WalletSourceDB: Solana Pump.fun Sniping Bot

**Version**: v10.13 / NEO v4.27 / CARTEL v1.0
**Status**: Paper Trading (DRY_RUN=true)
**Author**: Raph
**Last Updated**: 2026-03-25

---

## 1. Executive Summary

WalletSourceDB is an automated trading system that detects new Solana tokens launched on pump.fun, evaluates them using wallet reputation analysis and real-time market microstructure, and executes trades with three parallel strategies optimized through 300+ hours of backtesting and live paper trading.

**Key Results (paper trading, 877 trades over 7 days)**:
- **Wallet**: 12.55 SOL (+25.5%) from 10 SOL starting balance
- **Win Rate**: 53.4% overall
- **Fees Drag**: 84% — fees consume most gross gains
- **STD**: 510 sells, 53.3% WR, +19.2% avg P&L
- **NEO**: 345 sells, 53.0% WR, +11.7% avg P&L
- **CARTEL**: 22 sells, 59.1% WR, +13.5% avg P&L

---

## 2. Problem Statement

Pump.fun launches thousands of tokens daily. Most are rug pulls (creator dumps tokens immediately). The challenge:
1. **Detection**: Identify tokens within seconds of launch
2. **Classification**: Determine if the creator wallet has a history of legitimate projects
3. **Entry timing**: Enter before the crowd but after confirming demand
4. **Exit optimization**: Maximize capture on winners, minimize loss on losers
5. **Fee management**: Round-trip costs of ~4.5-8% mean most trades are unprofitable

---

## 3. System Architecture

### 3.1 Token Detection Pipeline

```
PumpPortal WSS ──▶ ForensicWorker ──▶ TokenTracker ──▶ TradeExecutor
  (new tokens)      (wallet lookup)    (30min tracking)   (entry/exit)
```

1. **ForensicWorker** connects to PumpPortal WebSocket, receives new token events
2. Looks up creator wallet in `wallet_profiles` table
3. Checks wallet ancestry (funding chain) via Helius RPC
4. Passes token to **TokenTracker** for lifecycle monitoring

### 3.2 Trade Execution Pipeline

```
PumpTradeStream (tick-by-tick) ──▶ TradeExecutor.onTrade()
  │                                    │
  │  Every trade event:                │
  │  - Update MC, volume, buyers       │
  │  - Check entry conditions          │
  │  - Check exit conditions           │
  │  - RT-TRAIL / HARD_STOP / PUMP3   │
  │                                    ▼
  │                              PaperTradeExecutor
  │                              (record to paper_trades DB)
  │                                    │
  │                              LiveTradeExecutor (DRY_RUN)
  │                              (build tx, don't send)
  └───────────────────────────────────┘
```

### 3.3 Dashboard

Express.js server on port 3001 serving:
- **Main page** (`index.html`): Live token tracking, strategy cards, trade list
- **Wallet page** (`wallet.html`): Equity curve, per-trade analysis, fee breakdown, strategy filtering
- **Monkey page** (`monkey.html`): Random strategy comparison

---

## 4. Three Trading Strategies

### 4.1 STANDARD (STD) v10.13 — Market Validation First

**Philosophy**: Wait for market to validate demand before entering.

**Entry Conditions** (ALL must be true):
| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Buyers | ≥70 | First profitable threshold in DB analysis (10k+ tokens) |
| MC Ratio | 2.0-3.0x from detection | Sweet spot: enough momentum, not too late |
| Dumps | <30 | Distribution threshold |
| Momentum | 5-tick rising 3%+ | Confirms upward trend |
| Window | 30-110s from detection | Trades at 110-120s are net negative |
| FADE block | Yes | FADE wallets = 23.1% WR, toxic |
| Quality Score | Q0-Q4 computed | Modulates position size |

**Exit Rules**:
| Exit Type | Condition | Avg Result |
|-----------|-----------|------------|
| RT-TRAIL | -20% from peak when peak >+50% | +69.2% avg |
| HARD_STOP | P&L ≤ -20% | -27.4% avg |
| PUMP3 | 3 pumps <50%, -7% from 3rd peak | -4.4% avg |
| MAX_HOLD | >600s (10 min) | Variable |
| SELL_DOM_60s | Sell volume > buy volume at 60s post-entry | -8.7% avg |
| SWEEP | No ticks for 5+ min past max hold | Emergency |

**Post-Entry Confirmation** (v10.13):
- At 60 seconds after entry, measure buy/sell volume ratio
- **SELL_DOM** (sell > buy): Exit immediately — 80% chance of losing
- **STRONG** (buy > 5× sell + 15 buyers): Flag for potential add-on (not yet automated)

**Position Sizing**:
```
position_sol = min(0.50, max(0.30, 0.5 - wallet_risk × 0.4)) × quality_modifier
```

### 4.2 NEO v4.27 — Early Entry

**Philosophy**: Enter earlier (lower ratio, fewer buyers) with tighter filters on token microstructure.

**Entry Conditions**:
| Parameter | Value | Rationale |
|-----------|-------|-----------|
| MC Ratio | 1.0-2.0x | Earlier than STD (before 2x mark) |
| Buyers | ≥20 | Much earlier than STD's 70 |
| Window | 15-120s | Wider time window |
| Sell Ratio | ≤0.44 | Organic buying (few sellers) |
| Top Holder | ≤20% | No whale concentration |
| Dumps | ≤25 | Limited distribution |
| Quality | Q0 blocked | Q0 = 20% WR, always loses |
| FADE | ≥0.65 threshold | Block known bad wallets |

**Exit Rules** (adaptive trail):
| Peak Range | Trail Drop | Rationale |
|------------|-----------|-----------|
| 25-30% (micro) | 10% | Tight — save from HS at -25% |
| 30-50% | 12% | Small peak capture |
| 50-100% | 16% | Mid-rocket, tightened from 18% |
| 100%+ | 22% | Moon — let it ride |

**Hard Stop**: -25% (wider than STD's -20% to allow for early entry volatility)

### 4.3 CARTEL v1.0 — Good Wallet Convergence

**Philosophy**: When multiple historically profitable wallets buy the same token within minutes, the signal is extremely strong.

**Detection**:
```
IF 2+ wallets with (WR ≥65% AND tokens_traded ≥15)
   buy the same token within 10-120s of detection
→ CARTEL BUY signal
```

**Backtest**: 108 trades, 72.2% WR, wallet 10→34 SOL (+240%)

**Exit**: Same as STD but trail triggers at +30% (earlier than STD's +50%)

**Sizing**: 2 wallets→0.50, 3→0.60, 4+→0.70 SOL (highest conviction = largest position)

---

## 5. Quality Score System

Computed at ~80 buyers from 4 market microstructure metrics:

| Metric | Good (1 point) | Rationale |
|--------|----------------|-----------|
| Avg Buy Size | ≤ $10 | Small organic buys, not whale manipulation |
| Dumps | ≤ 10 | Low distribution activity |
| Top Holder | ≤ 8% | No concentration risk |
| Sell Ratio | ≤ 0.25 | Strong buy pressure |

**Score Distribution**:
| Score | WR | Action |
|-------|-----|--------|
| Q0 (0/4) | 20% | **BLOCKED** (NEO), minimal size (STD) |
| Q1 (1/4) | 40% | Reduced size |
| Q2 (2/4) | 60% | Standard size |
| Q3 (3/4) | 75% | Full size |
| Q4 (4/4) | 87.5% | Maximum size |

---

## 6. WebSocket Reliability System (v10.13)

**Problem**: PumpPortal WebSocket disconnects ~12 times/day (30-250s gaps). Tokens can rug during these gaps, leaving positions stranded.

**6-Layer Protection**:

| Layer | Mechanism | Detection Time |
|-------|-----------|---------------|
| 1. Ping Keepalive | `ws.ping()` every 30s | Prevents idle disconnects |
| 2. Pong Tracking | Force reconnect if no pong in 90s | ~90s max |
| 3. Message Watchdog | Force reconnect if no messages in 60s | ~60s max |
| 4. Post-Reconnect MC Check | Fetch MC via pump.fun API for all positions | Immediate on reconnect |
| 5. Subscription Guard | Every 60s, verify all position tokens are subscribed | ~60s max |
| 6. Sweep `lastTickAt` | Close positions with no tick in 5+ min | ~5 min max |

**Before v10.13**: Disconnections could leave positions orphaned for hours.
**After v10.13**: Max detection time ~60-90s, auto-recovery with MC verification.

---

## 7. Memory Management

**Problem**: Process was crashing with OOM at 1.8 GB heap.

**Root Causes**:
1. `rawTrades`: 2000 transactions × thousands of tokens accumulated in memory
2. `liveState`: Never cleaned up for tokens without positions
3. Default Node.js heap limit (~1.7 GB) too low

**Solutions**:
| Fix | Before | After |
|-----|--------|-------|
| `rawTrades` cap | 2000/token | 500/token |
| `liveState` cap | Unlimited | 1000 tokens (evict non-position) |
| Node.js heap | ~1.7 GB default | 3072 MB (`--max-old-space-size`) |
| PM2 config | Lost on restart | `pm2 save` preserves node-args |

---

## 8. Position Safety Across Restarts

**Problem**: PM2 restarts (from OOM, optimizer, or manual) kill all in-memory positions.

**5-Layer Protection**:

1. **`safe-restart.sh`**: Queries DB for open positions (BUY without matching SELL). Blocks restart if any exist.
2. **Graceful shutdown**: `SIGTERM` handler calls `emergencyCloseAll()` — sells all positions on-chain (live mode) or records to DB (paper mode).
3. **PM2 `kill-timeout: 10000`**: Gives 10 seconds for graceful shutdown.
4. **Position recovery**: On startup, `getOpenPositionTokens()` loads unclosed positions from DB, re-creates in-memory state with `tradeCount: 100` (prevents false sweep).
5. **WebSocket re-subscription**: Recovered position tokens are immediately subscribed to PumpTradeStream for tick data.

---

## 9. Fee Economics

| Component | Cost | Notes |
|-----------|------|-------|
| Pump.fun fee | 1% per side | Protocol fee |
| Bonding curve slippage | ~0.83% per side | At 0.25 SOL / $6k MC |
| Jito tip (buy) | 100k lamports (~$0.002) | Priority landing |
| Jito tip (sell) | 450k lamports (~$0.01) | Critical for exits |
| **Total round-trip** | **~4.5%** | Dashboard uses 8% conservative |

**Impact**: Fees consume 55-85% of gross gains. A trade must gain >12% gross to be net profitable.

**Mitigation**: Quality over quantity — fewer trades, higher conviction, asymmetric payoff (small losses, large winners via trailing stops).

---

## 10. Key Discoveries & Decisions

### What Works
| Discovery | Evidence | Impact |
|-----------|----------|--------|
| RT-TRAIL is the money maker | +69% avg on trail exits | Core exit strategy |
| Quality Score predicts WR | Q0=20%, Q4=87.5% WR | Position sizing |
| CARTEL signal is extremely strong | 72% WR, +240% wallet in backtest | Separate strategy |
| Post-entry 60s SELL_DOM | 80% chance of losing | Exit signal |
| FLAT 20% trail beats tiered | Wallet 108 vs 79 (+36%) | Simplicity wins |
| Early entry outperforms | 81% WR at 1.2x vs 59% at 2.3x | NEO strategy basis |

### What Doesn't Work
| Approach | Result | Lesson |
|----------|--------|--------|
| Any entry filter that improves WR | Reduces wallet (misses winners) | Volume × asymmetry > selectivity |
| Post-buy confirmation delays | All variants reduce wallet | Enter immediately |
| Dip entry (wait for pullback) | Misses 50-75% of trades | Miss = bigger cost than bad entry |
| Anti-rug entry filters | Net negative — kills winners too | Rugs are structural noise |
| Velocity filter | 7/7 HARD_STOP (FOMO peak entries) | Removed in NEO v4.16 |
| RUGGER strategy | 0% WR on 2 live trades | Disabled |
| EARLY strategy | 48.3% WR, 45% HS rate | Removed |

### Structural Truths
- **No entry metric separates winners from losers** — Cohen's d < 0.3 for ALL parameters
- **Pump.fun rugs gap 30-60%+ in one tick** — structurally impossible to prevent
- **83/102 NEO hard stops happen in <60 seconds** — instant rugs, no filter possible
- **Fees are the #1 enemy** — not bad entries, not bad exits
- **The game is won on the tail** — a few +100-300% trades pay for many -20% stops

---

## 11. Historical Performance (72h Competition, Mar 21-24)

| Strategy | Sells | WR | Avg P&L | Trail Avg | HS Rate |
|----------|-------|-----|---------|-----------|---------|
| **STD** | 451 | 53.4% | +18.8% | +48.5% | 34% |
| **NEO** | 178 | 53.4% | +14.4% | +41.6% | 32% |
| **CARTEL** | 18 | 55.6% | +15.3% | +30.0% | 39% |

---

## 12. Roadmap

### Immediate (Next Week)
- [ ] **STRONG add-on buy**: Double position when 60s confirmation shows strong demand
- [ ] **Validate v10.13 protections**: Monitor WebSocket reliability improvements
- [ ] **NEO v4.28**: PUMP3 drop threshold 7% → 5%
- [ ] **Go-live preparation**: Final DRY_RUN validation, SOL funding

### Short-term (1 Month)
- [ ] **Live trading**: Transition from paper to real SOL
- [ ] **Fee optimization**: Research alternative DEX routes for lower slippage
- [ ] **Multi-token correlation**: Detect market-wide pump/dump cycles
- [ ] **Machine learning**: Train on 12M+ trade events for pattern recognition

### Long-term
- [ ] **Raydium integration**: Trade tokens post-graduation from pump.fun
- [ ] **Cross-chain**: Extend to other EVM L2 meme ecosystems
- [ ] **Portfolio management**: Dynamic allocation across strategies based on market regime

---

## 13. Configuration Reference

### Environment Variables (`.env`)
```env
# Required
DATABASE_URL=postgresql://user:pass@localhost:5432/walletsource
SOLANA_WSS_URL=wss://atlas-mainnet.helius-rpc.com?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_KEY

# Trading
DRY_RUN=true                    # Paper trading mode
WALLET_PRIVATE_KEY=             # Required for live only
RPC_URL=https://api.mainnet-beta.solana.com

# Optional
LOG_LEVEL=info
DEXSCREENER_RATE_LIMIT=300
```

### PM2 Configuration
```bash
pm2 start dist/src/index.js \
  --name walletsource-db \
  --kill-timeout 10000 \
  --node-args="--max-old-space-size=3072"
```

### Docker (PostgreSQL)
```yaml
services:
  postgres:
    image: postgres:15-alpine
    shm_size: '512mb'
    command: >
      postgres
      -c shared_buffers=256MB
      -c work_mem=16MB
      -c effective_cache_size=1GB
```
