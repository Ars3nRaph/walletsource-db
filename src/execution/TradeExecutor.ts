import type { Pool } from 'pg';
import type { RuggerPlaybook } from '../types/index.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { FunderLookup } from '../api/FunderLookup.js';
import { RuggerProfiler, RuggerProfile } from './RuggerProfiler.js';
import { CartelDetector } from './CartelDetector.js';
import { logger } from '../utils/logger.js';
import { readFileSync } from 'fs';
// ━━━ Dynamic Param Loader (AutoTuner) ━━━
interface TunedParamsCache {
  version: number;
  params: Record<string, number>;
}
let _tunedCache: TunedParamsCache | null = null;
let _tunedLastCheck = 0;
function _getTunedParam(name: string, fallback: number): number {
  const now = Date.now();
  // Reload every 30s
  if (now - _tunedLastCheck > 30_000) {
    _tunedLastCheck = now;
    try {
      const raw = readFileSync('./data/tuned-params.json', 'utf-8');
      const parsed = JSON.parse(raw);
      if (!_tunedCache || parsed.version !== _tunedCache.version) {
        _tunedCache = { version: parsed.version, params: parsed.params };
        logger.info({ version: parsed.version, keys: Object.keys(parsed.params).length }, '🧬 Loaded tuned params');
      }
    } catch {
      // File doesn't exist yet — use defaults
    }
  }
  return _tunedCache?.params?.[name] ?? fallback;
}



export type TradeAction = 'BUY' | 'SELL' | 'HOLD' | 'NONE';

export interface TradeSignal {
  action: TradeAction;
  confidence: number;
  percentage?: number;
  reason: string;
  playbook_strategy?: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID';
  signals?: SignalBreakdown;
  wallet_risk_score?: number;  // v10.10j: 0-1 risk score from wallet_profiles → position sizing
  position_sol?: number;       // v10.10j: risk-adjusted position size (0.1-0.5 SOL)
  quality_score?: number;      // v10.10k: 0-4 market microstructure quality score
}

interface SignalBreakdown {
  timing_score: number;
  momentum_score: number;
  consistency_score: number;
  risk_score: number;
  wallet_score: number;
}

interface OpenPosition {
  entryMC: number;
  entryTime: Date;
  highestMC: number;
  lowestMCAfterEntry: number;
  tradeCount: number;
  walletAddress: string;
    walletRiskScore?: number;
  peakTime: number;           // timestamp when highestMC was set
  hadSignificantPump: boolean; // true if ever reached +20%
  entryBuyVol: number;        // buy volume ($) at entry — drives adaptive SL
  entryBuyCount: number;      // buy count at entry
  entryBuyerCount: number;    // unique buyers at entry
  entrySellersCount: number;  // v10.10k: unique sellers at entry — for adaptive trail
  staleTicks: number;         // v10.10: consecutive ticks without new high (>2%)
  ceilingHigh: number;        // v10.10: rolling high for ceiling detection
  // v10.10c: Pump cycle tracking for lower-high exit
  pumpPeaks: number[];        // MC at each pump peak
  pumpState: 'PUMP' | 'DIP'; // current cycle state
  cycleHigh: number;          // current pump cycle high
  dipLow: number;             // current dip low
  // v10.10d: Post-buy confirmation (10 ticks)
  tickMCs: number[];            // MC at each tick after buy
  confirmationDone: boolean;    // true once 10 ticks checked
  neoStrategy?: boolean;       // NEO strategy flag — uses different exit params
  cartelStrategy?: boolean;    // CARTEL strategy flag — good wallet convergence
  earlyStrategy?: boolean;     // EARLY strategy flag
  // v10.13: 60s post-entry confirmation (STD only)
  postEntrySignal?: 'STRONG' | 'GOOD' | 'WEAK' | 'SELL_DOM';
  postEntryChecked?: boolean;  // true once 60s check done
  addOnBought?: boolean;       // true if add-on position placed on STRONG
  swarmStrategy?: boolean;     // SWARM: organic retail crowd signal
  eliteWallets?: Set<string>;  // which ELITE wallets triggered this entry

}

interface LiveTradeState {
  buyCount: number;
  sellCount: number;
  buyVol: number;
  sellVol: number;
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  firstSellAt: Date | null;
  lastSeenAt: Date;
  recentSells: number;
  recentBuys: number;
  cascadeDetected: boolean;
  highestMC: number;         // v8.0: track spike MC for dip entry
  // v8.1: enhanced tracking
  holderBalances: Map<string, number>;  // wallet → token balance (from newTokenBalance)
  totalDumpSells: number;               // sells where newTokenBalance = 0 (full dump)
  repeatBuyers: Map<string, number>;    // wallet → buy count (conviction signal)
  avgBuySize: number;                   // rolling avg buy volume
  avgSellSize: number;                  // rolling avg sell volume
  buyTimestamps: number[];              // for velocity calc (last 10 buy timestamps)

  bondingCurvePct: number;              // % of bonding curve filled
  largestHolderPct: number;             // largest holder % of supply
  recentMCs: number[];                   // v10.9: last 5 MC values for momentum
  rawTrades: { ts: number; type: 'buy'|'sell'; usd: number; trader: string; mc: number; }[];  // v10.11: raw tx log for analysis
}

/**
 * Per-wallet strategy parameters computed from historical data.
 * Each wallet gets custom entry/exit/SL based on its actual patterns.
 */
interface WalletStrategy {
  // Entry
  minPumpPct: number;        // min pump above baseline to confirm entry (e.g., 0.10 = +10%)
  maxEntryRatio: number;     // max MC/baseline ratio for entry (don't enter past this)
  maxEntrySec: number;       // max seconds after detection to enter
  
  // Exit  
  targetRatio: number;       // expected peak MC/baseline for partial exit
  maxHoldSec: number;        // max hold time before force close
  
  // Risk
  stopLossPct: number;       // stop-loss % from entry
  trailingStopPct: number;   // trailing stop % from high
  cascadeThreshold: number;  // consecutive sells to trigger cascade exit
  
  // Sizing
  winRate: number;           // historical pump rate
  evPerTrade: number;        // expected value per trade %
  
  // Source
  sampleSize: number;        // how many tokens this is based on
}

/**
 * TradeExecutor v5.0 — Per-Wallet Strategy Engine
 *
 * Each RIDE wallet gets its own entry/exit/SL parameters derived from
 * its historical token data. No more one-size-fits-all thresholds.
 */
export class TradeExecutor {
  private tokenRepo: TokenEventRepo;
  private walletRepo: WalletRepo;
  protected pool: Pool;

  protected openPositions = new Map<string, OpenPosition>();
  private lastBuyTimestamp = 0; // v10.9.2: absolute last buy time
  private firstMC = new Map<string, number>();
  public liveState = new Map<string, LiveTradeState>(); // v10.14.1: public for TokenTracker fast_verdict

  // Cache: token → { isRide, detectedAt, fdvAtDetection, walletAddress, strategy }
  protected rideCache = new Map<string, {
    isRide: boolean;
    isCleanRide: boolean;
    detectedAt: Date;
    fdvAtDetection: number;
    walletAddress: string;
    walletRiskScore?: number;
    strategy: WalletStrategy | null;
  }>();
  private evaluating = new Set<string>();
  private closedTokens = new Map<string, { exitType: string; exitMC: number; exitTime: number; entryMC: number; peakMC: number; reentryCount: number }>();
  // v10.10k Circuit Breaker: pause after 3 consecutive hard stops
  private consecutiveHardStops = 0;
  private circuitBreakerUntil: number | null = null;
  private readonly CB_MAX_HS = 4; // v4.18: raised 2→4 (NEO needs more sample before CB fires)
  private readonly CB_PAUSE_MS = 15 * 60 * 1000; // v4.18: reduced 30min→15min pause
  public ruggerProfiler: RuggerProfiler;
  public cartelDetector: CartelDetector;
  private funderLookup: FunderLookup;
  private ruggerPositions = new Set<string>(); // Tokens entered via rugger strategy
  private sweepInterval: NodeJS.Timeout | null = null;

  /** Start periodic position sweep (call after construction) */
  startPositionSweep(): void {
    if (this.sweepInterval) return;
    this.sweepInterval = setInterval(() => this.sweepStalePositions(), 5000);
  }

  stopPositionSweep(): void {
    if (this.sweepInterval) { clearInterval(this.sweepInterval); this.sweepInterval = null; }
  }

  private sweepStalePositions(): void {
    const now = Date.now();
    for (const [tokenAddress, pos] of this.openPositions.entries()) {
      const holdSec = (now - pos.entryTime.getTime()) / 1000;
      const cached = this.rideCache.get(tokenAddress);
      const ws = cached ? this.walletStrategies.get(cached!.walletAddress) : null;
      const maxHold = ws?.maxHoldSec ?? 600; // v10.10h: 10min max (was 180s)
      
      // Stale: no new trades AND past max hold time
      if (!this.openPositions.has(tokenAddress)) continue;
      // v10.13: Check time since last tick (not total tick count)
      const lastTickAge = pos.peakTime ? (now - pos.peakTime) / 1000 : holdSec;
      // Only sweep if BOTH conditions: past max hold AND very few ticks (truly stale)
      const isStale = holdSec > maxHold && pos.tradeCount < 5;
      // OR: held very long (>10min) with no trades for a while
      const isAbandoned = holdSec > 600 && pos.tradeCount < 10;
      // v10.13: Token stopped receiving ticks (>5min since last tick + past max hold)
      const isNoTicks = holdSec > maxHold && lastTickAge > 300;
      const isNeoTimeout = pos.neoStrategy === true && holdSec > 900;
      const isCartelTimeout = pos.cartelStrategy === true && holdSec > 900; // NEO v4.23: hard 15min timeout regardless of ticks
      if (isStale || isAbandoned || isNeoTimeout || isCartelTimeout || isNoTicks) {
        const lastMC = pos.tickMCs?.length > 0 ? pos.tickMCs[pos.tickMCs.length - 1] : (pos.highestMC || pos.entryMC);
        const realPnl = ((lastMC - pos.entryMC) / pos.entryMC * 100).toFixed(1);
        
        logger.info({
          token: tokenAddress.slice(0, 8),
          holdSec: holdSec.toFixed(0),
          tradeCount: pos.tradeCount,
          pnl: realPnl + '%',
        }, '🧹 SWEEP: closing stale position');
        
        // Force-close by calling evaluateTrade with last known MC
        // This triggers managePosition which will hit MAX HOLD or other exit
        // If that doesn't work, force-close here
        const sweepResult = this.sell(100, 1.0, 'RIDE',
          `🧹 SWEEP: stale (${holdSec.toFixed(0)}s, ${pos.tradeCount} ticks, P&L ${realPnl}%)`,
          this.emptySignals());
        this.closePosition(tokenAddress);
        // Emit to paper trade log via overrideable method
        this.onSweepClose(tokenAddress, sweepResult, lastMC);
      }
    }
  }
  
  // Price history for momentum confirmation (last N ticks per token)
  private priceHistory = new Map<string, Array<{ mc: number; ts: number }>>();

  // Per-wallet strategy cache (wallet_address → WalletStrategy)
  private walletStrategies = new Map<string, WalletStrategy>();

  constructor(pool: Pool) {
    this.pool = pool;
    this.tokenRepo = new TokenEventRepo(pool);
    this.walletRepo = new WalletRepo(pool);
    this.ruggerProfiler = new RuggerProfiler(pool);
    this.funderLookup = new FunderLookup();
    this.cartelDetector = new CartelDetector(pool);
    // Init cartel detector (async)
    this.cartelDetector.init().catch(err => 
      logger.error({ err }, 'Failed to init CartelDetector')
    );
    // Load rugger profiles on startup
    this.ruggerProfiler.refreshProfiles().then(() => {
      logger.info({ count: this.ruggerProfiler.profileCount }, '🎯 Rugger profiles loaded at startup');
    }).catch(err => 
      logger.error({ err }, 'Failed to load rugger profiles')
    );
  }

  /**
   * Compute or retrieve per-wallet strategy from historical data.
   * This is the CORE of v5.0 — each wallet gets custom parameters.
   */
  private async getWalletStrategy(walletAddress: string, playbook: RuggerPlaybook): Promise<WalletStrategy> {
    const cached = this.walletStrategies.get(walletAddress);
    if (cached) return cached;

    // Query historical performance for this specific wallet
    const result = await this.pool.query(`
      WITH token_data AS (
        SELECT
          te.fdv_at_detection AS baseline,
          te.peak_mc,
          te.peak_mc / NULLIF(te.fdv_at_detection, 0) AS peak_ratio,
          te.time_to_peak_min * 60 AS peak_sec,
          CASE WHEN te.peak_mc > te.fdv_at_detection * 1.30 THEN true ELSE false END AS is_pump
        FROM token_events te
        WHERE te.creator_wallet = $1
          AND te.fdv_at_detection > 0
          AND te.peak_mc IS NOT NULL
      )
      SELECT
        COUNT(*) AS sample_size,
        COUNT(*) FILTER (WHERE is_pump) AS pump_count,
        -- Pump tokens: where they peak
        COALESCE(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY peak_ratio) FILTER (WHERE is_pump), 1.3) AS p25_pump,
        COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY peak_ratio) FILTER (WHERE is_pump), 1.5) AS median_pump,
        COALESCE(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY peak_ratio) FILTER (WHERE is_pump), 2.0) AS p75_pump,
        -- Time to peak on pumps
        COALESCE(AVG(peak_sec) FILTER (WHERE is_pump), 30) AS avg_peak_sec,
        COALESCE(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY peak_sec) FILTER (WHERE is_pump), 60) AS p75_peak_sec,
        -- Non-pump tokens: how much they drop
        COALESCE(AVG(CASE WHEN NOT is_pump THEN peak_ratio END), 1.0) AS avg_nopump_ratio,
        -- Max observed drop on non-pumps (worst case loss)
        COALESCE(MIN(CASE WHEN NOT is_pump THEN peak_ratio END), 0.8) AS worst_nopump_ratio
      FROM token_data
    `, [walletAddress]);

    const r = result.rows[0];
    const sampleSize = parseInt(r.sample_size);
    const pumpCount = parseInt(r.pump_count);
    const winRate = sampleSize > 0 ? pumpCount / sampleSize : 0;
    const medianPump = parseFloat(r.median_pump);
    const avgPeakSec = parseFloat(r.avg_peak_sec);
    const p75PeakSec = parseFloat(r.p75_peak_sec);
    const avgNoPumpRatio = parseFloat(r.avg_nopump_ratio);

    // Playbook-level timing data (if available from trade_events)
    const pbRugSec = playbook.avg_time_to_rug_sec ?? (playbook.avg_time_to_rug_min * 60);

    // ── ENTRY PARAMETERS ──
    // Enter early in the pump: require at least +10% above baseline
    // But don't enter past the P25 pump mark (first quartile of winning pumps)
    // This means we enter in the bottom 25% of the pump → maximum upside
    const minPumpPct = 0.10;  // minimum +10% to confirm real pump
    const maxEntryRatio = Math.max(medianPump * 0.85, 1.50);  // enter below 85% of median pump, floor 1.5x
    const maxEntrySec = Math.min(p75PeakSec * 1.5, 300);  // generous time window

    // ── EXIT PARAMETERS ──
    const targetRatio = medianPump;  // target the median pump for partial exit
    const maxHoldSec = Math.max(pbRugSec * 0.9, avgPeakSec * 3, 60);  // exit well before rug

    // ── RISK PARAMETERS ──
    // Stop-loss: based on how much non-pump tokens drop
    // If non-pumps stay flat (ratio ~1.0) → tight SL works (10%)
    // If non-pumps crash hard (ratio ~0.3) → wider SL needed but means bigger losses
    const typicalLossPct = Math.max(0.08, 1 - avgNoPumpRatio + 0.05);
    const stopLossPct = Math.min(typicalLossPct, 0.25);  // cap at 25%
    const trailingStopPct = Math.max(stopLossPct * 1.2, 0.10);  // trailing slightly tighter

    // Cascade: scale threshold by how noisy the wallet's tokens are
    // High win rate wallets → fewer false cascades → lower threshold
    // Low win rate → lots of selling on non-pumps → higher threshold
    const cascadeThreshold = 8; // v10.9.4: high threshold, organic tokens have normal sell waves

    // ── EV CALCULATION ──
    // Expected value = winRate * avgWinPct - (1-winRate) * avgLossPct
    const avgWinPct = Math.max(0, (medianPump - 1) * 100 * 0.5);  // instant entry at baseline (T+0s snipe)
    const avgLossPct = Math.min(stopLossPct * 100, 15);  // cap loss at SL or 15%
    const evPerTrade = winRate * avgWinPct - (1 - winRate) * avgLossPct;

    const strategy: WalletStrategy = {
      minPumpPct,
      maxEntryRatio,
      maxEntrySec,
      targetRatio,
      maxHoldSec,
      stopLossPct,
      trailingStopPct,
      cascadeThreshold,
      winRate,
      evPerTrade,
      sampleSize,
    };

    this.walletStrategies.set(walletAddress, strategy);

    logger.info({
      wallet: walletAddress.slice(0, 8),
      winRate: (winRate * 100).toFixed(0) + '%',
      ev: evPerTrade.toFixed(1) + '%',
      maxEntry: (maxEntryRatio * 100 - 100).toFixed(0) + '%',
      sl: (stopLossPct * 100).toFixed(0) + '%',
      trailing: (trailingStopPct * 100).toFixed(0) + '%',
      target: ((medianPump - 1) * 100).toFixed(0) + '%',
      maxHold: maxHoldSec.toFixed(0) + 's',
      sample: sampleSize,
    }, '📊 Wallet strategy computed');

    return strategy;
  }

  // ─────────────────────────────────────────────────────────────
  // TRADE EVENT HANDLER
  // ─────────────────────────────────────────────────────────────

  onTrade(tokenAddress: string, txType: 'buy' | 'sell', mcUsd: number, volUsd: number, trader: string, _tokenAmount?: number, newTokenBalance?: number): void {
    let state = this.liveState.get(tokenAddress);
    if (!state) {
      state = {
        buyCount: 0, sellCount: 0, buyVol: 0, sellVol: 0,
        uniqueBuyers: new Set(), uniqueSellers: new Set(),
        firstSellAt: null, lastSeenAt: new Date(),
        recentSells: 0, recentBuys: 0, cascadeDetected: false,
        highestMC: 0,
        recentMCs: [],
        rawTrades: [],
        holderBalances: new Map(), totalDumpSells: 0,
        repeatBuyers: new Map(), avgBuySize: 0, avgSellSize: 0,
        buyTimestamps: [], bondingCurvePct: 0, largestHolderPct: 0
      };
      this.liveState.set(tokenAddress, state);
      // v10.13: Cap liveState to prevent OOM (evict oldest non-position tokens)
      if (this.liveState.size > 1000) {
        for (const [tok] of this.liveState) {
          if (this.liveState.size <= 800) break;
          if (!this.openPositions.has(tok)) this.liveState.delete(tok);
        }
      }
    }

    if (txType === 'buy') {
      state.buyCount++;
      state.buyVol += volUsd;
      state.uniqueBuyers.add(trader);
      state.recentBuys++;
    } else {
      state.sellCount++;
      state.sellVol += volUsd;
      state.uniqueSellers.add(trader);
      state.recentSells++;
      if (!state.firstSellAt) state.firstSellAt = new Date();
    }
    state.lastSeenAt = new Date();
    if (mcUsd > state.highestMC) state.highestMC = mcUsd;  // v8.0: track spike for dip entry
    // v10.9: track recent MCs for momentum confirmation
    if (!state.recentMCs) state.recentMCs = [];
    state.recentMCs.push(mcUsd);
    if (state.recentMCs.length > 5) state.recentMCs.shift();

    // v8.1: Enhanced tracking
    // Holder balances
    if (newTokenBalance !== undefined && trader) {
      state.holderBalances.set(trader, newTokenBalance);
      if (txType === 'sell' && newTokenBalance === 0) {
        state.totalDumpSells++;
      }
      // Update largest holder %
      if (state.holderBalances.size > 0) {
        const totalHeld = Array.from(state.holderBalances.values()).reduce((a, b) => a + b, 0);
        const maxHeld = Math.max(...state.holderBalances.values());
        state.largestHolderPct = totalHeld > 0 ? maxHeld / totalHeld : 0;
      }
    }
    // Repeat buyers
    if (txType === 'buy' && trader) {
      state?.repeatBuyers.set(trader, (state?.repeatBuyers.get(trader) ?? 0) + 1);
    }
    // Average buy/sell sizes
    if (txType === 'buy' && volUsd > 0) {
      state.avgBuySize = state.buyCount > 0 ? state?.buyVol / state.buyCount : volUsd;
    } else if (txType === 'sell' && volUsd > 0) {
      state.avgSellSize = state.sellCount > 0 ? state?.sellVol / state.sellCount : volUsd;
    }
    // Buy velocity (keep last 10 timestamps)
    if (txType === 'buy') {
      state.buyTimestamps.push(Date.now());
      if (state.buyTimestamps.length > 10) state.buyTimestamps.shift();
    }
    // v10.11: Store raw trade for post-analysis (kept in memory only, dropped when token expires)
    if (state.rawTrades.length < 500) {  // v10.13: reduced from 2000 to save memory
      state.rawTrades.push({ ts: Date.now(), type: txType, usd: volUsd, trader, mc: mcUsd });
    // v10.12: Feed cartel detector
    this.cartelDetector.onTrade(tokenAddress, trader, txType);
    }
    // Bonding curve progress (793K SOL = ~100% on pump.fun)
    if (mcUsd > 0) {
      // pump.fun bonding curve completes at ~$69K MC (at ~$150 SOL)
      // More precise: vSol reaches 85 SOL = migration
      // We approximate from MC: $69K MC ≈ 100% bonding curve
      state.bondingCurvePct = Math.min(mcUsd / 69000, 1.0);
    }

    // Dynamic cascade threshold from wallet strategy
    const cached = this.rideCache.get(tokenAddress);
    const cascadeThresh = cached?.strategy?.cascadeThreshold ?? 5;
    
    

    if (txType === 'sell' && state.recentSells >= cascadeThresh && state.recentBuys === 0
        && state?.sellVol > state?.buyVol * 0.5) {
      state.cascadeDetected = true;
    }
    if (txType === 'buy') {
      state.recentSells = 0;
      state.recentBuys = 0;
    }

    // Track price history for momentum confirmation
    let history = this.priceHistory.get(tokenAddress);
    if (!history) {
      history = [];
      this.priceHistory.set(tokenAddress, history);
    }
    history.push({ mc: mcUsd, ts: Date.now() });
    // Keep only last 30 seconds of history
    const cutoff = Date.now() - 30000;
    while (history.length > 0 && history[0].ts < cutoff) history.shift();
    
    // ══════════════════════════════════════════════════════════════
    // REAL-TIME ENTRY CHECK — enter on exact tick, not 5s poll delay
    // ══════════════════════════════════════════════════════════════
    if (!this.openPositions.has(tokenAddress) && state) {
      const rtClosed = this.closedTokens.get(tokenAddress);
      if (!rtClosed || rtClosed.exitType === 'TRAIL') {
      const rtCached = this.rideCache.get(tokenAddress);
      const rtBuyers = state.uniqueBuyers?.size ?? 0;
      const rtBaselineMC = rtCached?.fdvAtDetection || this.firstMC.get(tokenAddress) || mcUsd;
      const rtRatio = mcUsd / Math.max(rtBaselineMC, 1);
      const rtDetectedAt = rtCached?.detectedAt || new Date();
      const rtElapsedSec = (Date.now() - rtDetectedAt.getTime()) / 1000;
      const rtDumps = state.totalDumpSells || 0;
      const rtBuyVol = state.buyVol || 0;
      const rtSellCount = state.sellCount || 0;
      const rtBuyCount = state.buyCount || 0;
      const rtMcs = state.recentMCs || [];
      
      // CARTEL: immediate entry when 2+ good wallets detected (T+2-120s)
      let cartelSig = this.cartelDetector.getSignal(tokenAddress);
      if (cartelSig && (cartelSig.eliteWalletCount >= 2 || cartelSig.goodWalletCount >= 5) && rtElapsedSec >= 2 && rtElapsedSec <= 120) {
        // Trigger immediate evaluation — CARTEL has priority
        this.evaluating.delete(tokenAddress);
        this.maybeEvaluateLive(tokenAddress, mcUsd).catch(() => {});
      }



      // ELITE RT check removed — replaced by SWARM (poll-based, T=20-90s)
      
      // v10.14.2: Helius buyer scan — discover hidden good wallets on ALL promising tokens
      // Trigger: 20+ unique buyers, within 90s of detection (even if CARTEL already detected — may find more wallets)
      // Cost: ~200 credits/scan, budget allows ~1350 scans/day
      if (rtBuyCount >= 20 && rtElapsedSec >= 10 && rtElapsedSec <= 90) {
        this.cartelDetector.heliusScan(tokenAddress).then(sig => {
          if (sig && (sig.eliteWalletCount >= 2 || sig.goodWalletCount >= 5)) {
            logger.info({ token: tokenAddress.slice(0,8), goodWallets: sig.goodWalletCount }, 
              '🔍 Helius scan discovered CARTEL signal!');
            this.evaluating.delete(tokenAddress);
            this.maybeEvaluateLive(tokenAddress, mcUsd).catch(() => {});
          }
        }).catch(() => {});
      }

      // RUGGER: immediate entry for qualified wallets (T+3-30s)
      const rtWallet = rtCached?.walletAddress || '';
      if (false && rtWallet && rtElapsedSec >= 3 && rtElapsedSec <= 30 && !this.ruggerPositions.has(tokenAddress)) { // v10.10i: RUGGER disabled — 0% WR, -30% avg
        const rProfile = this.ruggerProfiler.getProfile(rtWallet);
        if (rProfile && mcUsd >= 4000 && mcUsd < rProfile.targetExitMC * 0.85 && mcUsd > rProfile.targetExitMC * 0.5) {
          // Trigger full evaluation immediately
          this.evaluating.delete(tokenAddress);
          this.maybeEvaluateLive(tokenAddress, mcUsd).catch(() => {});
          // Skip rest — evaluateTrade will handle the BUY
        }
      }
      
      // v10-MARKET: check if all conditions met for instant entry
      if (rtElapsedSec >= 30 && rtElapsedSec <= 120 
          && rtBuyers >= 80 && rtBuyers <= 100
          && rtRatio >= 2.0 && rtRatio <= 3.0
          && rtDumps < 30
          && rtSellCount <= rtBuyCount * 0.8) {
        // Momentum check (5 ticks rising +3%)
        if (rtMcs.length >= 5) {
          const last5 = rtMcs.slice(-5);
          const isRising = last5[1] > last5[0] && last5[2] > last5[1] && last5[3] > last5[2] && last5[4] > last5[3];
          const momPct = ((last5[4] - last5[0]) / last5[0]) * 100;
          if (isRising && momPct >= 3.0) {
            // All conditions met — force immediate evaluation
            logger.info({
              token: tokenAddress.slice(0, 8),
              buyers: rtBuyers,
              ratio: rtRatio.toFixed(2),
              mc: mcUsd.toFixed(0),
              elapsed: rtElapsedSec.toFixed(0),
            }, '⚡ RT-ENTRY conditions met — forcing evaluation');
            this.evaluating.delete(tokenAddress);
            this.maybeEvaluateLive(tokenAddress, mcUsd).catch(() => {});
          }
        }
      }
      } // end rtClosed check
    }

    // ══════════════════════════════════════════════════════════════
    // REAL-TIME EXIT CHECK — don't wait for poll, check every trade
    // Prevents rug gaps from destroying profits (D59YZ bug: +226% → 0%)
    // ══════════════════════════════════════════════════════════════
    const rtPos = this.openPositions.get(tokenAddress);
    if (rtPos && mcUsd > 0) {
      const rtPnl = ((mcUsd - rtPos.entryMC) / rtPos.entryMC) * 100;
      const rtHoldSec = (Date.now() - rtPos.entryTime.getTime()) / 1000;
      const rtPeakPnl = ((rtPos.highestMC - rtPos.entryMC) / rtPos.entryMC) * 100;
      const rtDropFromPeak = rtPos.highestMC > 0 ? (rtPos.highestMC - mcUsd) / rtPos.highestMC : 0;
      
      // Compute drop limit — FLAT 20% for all peaks ≥50% (backtest: wallet 108 vs 79 with old tiers)
      // Peak <50%: NO TRAIL (let it run to 50%+ or hit hard stop)
      // Peak ≥50%: 20% drop from peak
      // v10.10k: Adaptive RT-TRAIL based on seller growth
      const rtCurrentSellers = state?.uniqueSellers?.size || 0;
      const rtCurrentBuyers = state?.uniqueBuyers?.size || 0;
      const rtNewSellers = rtCurrentSellers - (rtPos.entrySellersCount || 0);
      const rtNewBuyers = rtCurrentBuyers - (rtPos.entryBuyerCount || 0);
      const rtSellerRatio = rtNewBuyers > 15 ? rtNewSellers / rtNewBuyers : -1;

      let rtDropLimit = 0;
      const rtIsNeo = rtPos.neoStrategy === true;
      const rtIsCartel = rtPos.cartelStrategy === true;
      const rtIsSwarm = rtPos.swarmStrategy === true;
      const rtTrailTrigger = rtIsSwarm ? 40 : (rtIsNeo || rtIsCartel) ? 25 : 50; // SWARM: trail from +40%, NEO/CARTEL: 25%, STD: 50%
      if (rtPeakPnl >= rtTrailTrigger) {
        if (rtIsSwarm) {
          rtDropLimit = 0.20; // SWARM: 20% trail drop
        } else if (rtIsCartel) {
          rtDropLimit = 0.20; // CARTEL: 20% trail
        } else if (rtIsNeo) {
          // NEO v4.32: tiered RT trail — match secondary trail logic, give rockets room to breathe
          // Data: NEO only 16 100%+ trails vs STD 35. Root cause: flat 15% kills rockets at 50-100% peak.
          // STD uses 20% at 50%+ → lets tokens dip and recover → 2x more rockets captured.
          const rtHealthy = rtSellerRatio >= 0 && rtSellerRatio <= 0.20;
          const rtDump = rtSellerRatio > 0.40;
          if (rtPeakPnl >= 100) {
            rtDropLimit = rtHealthy ? 0.27 : rtDump ? 0.18 : 0.22; // v4.32: match secondary 100%+ tier
          } else if (rtPeakPnl >= 50) {
            rtDropLimit = rtHealthy ? 0.22 : rtDump ? 0.15 : 0.20; // v4.32: 15%→20% default at 50-100% (was flat 15%)
          } else if (rtPeakPnl >= 30) {
            rtDropLimit = rtHealthy ? 0.18 : rtDump ? 0.10 : 0.14; // v4.32: 15%→14% default at 30-50% (less tight, more room)
          } else {
            rtDropLimit = rtHealthy ? 0.14 : rtDump ? 0.08 : 0.12; // v4.32: 25-30% zone
          }
        } else if (rtSellerRatio >= 0 && rtSellerRatio <= 0.20) {
          rtDropLimit = 0.25; // healthy → wide trail
        } else if (rtSellerRatio > 0.40) {
          rtDropLimit = 0.15; // pressure → tight trail
        } else {
          rtDropLimit = 0.20; // standard
        }
      }
      // Below 50% peak: rtDropLimit stays 0 = no trailing stop
      
      let rtShouldSell = false;
      let rtReason = '';

      // 0. ELITE-MIMIC: sell-surge early exit (RT)
      if (false) { // ELITE copy-exit removed
        const rtState = this.liveState.get(tokenAddress);
        const rtRecentSells = rtState?.recentSells ?? 0;
        const rtRecentBuys = rtState?.recentBuys ?? 0;
        const rtSb = rtRecentBuys > 0 ? rtRecentSells / rtRecentBuys : 0;
        if (rtSb > 1.5 && rtRecentSells >= 5 && rtRecentBuys >= 2) { // v1.1: need min 2 buys
          rtReason = `⚡ RT-ELITE_SURGE sb=${rtSb.toFixed(2)} sells=${rtRecentSells} pnl=${rtPnl.toFixed(1)}% | MC ${mcUsd.toFixed(0)}`;
          rtShouldSell = true;
          this.consecutiveHardStops = 0;
        }
      }

      // 1. Tiered trailing stop
      if (rtDropLimit > 0 && rtDropFromPeak > rtDropLimit) {
        const captured = ((rtPos.highestMC * (1 - rtDropLimit) - rtPos.entryMC) / rtPos.entryMC * 100).toFixed(1);
        rtReason = `⚡ RT-TRAIL — drop -${(rtDropFromPeak*100).toFixed(0)}%>${(rtDropLimit*100).toFixed(0)}% from peak +${rtPeakPnl.toFixed(0)}% | captured ~${captured}% | sellers ${rtSellerRatio >= 0 ? (rtSellerRatio*100).toFixed(0)+'%' : 'n/a'}`;
        rtShouldSell = true;
        this.consecutiveHardStops = 0; // CB reset on non-HS exit
      }
      
      // 1b. ELITE max hold 120s (RT)
      if (!rtShouldSell && rtIsSwarm && rtHoldSec > 300) { // SWARM: max 300s hold
        rtReason = `⚡ RT-ELITE_MAX_HOLD 300s — pnl=${rtPnl.toFixed(1)}% | MC ${mcUsd.toFixed(0)}`;
        rtShouldSell = true;
        this.consecutiveHardStops = 0;
      }

      // 2. Hard stop (NEO: -15%, others: -20%)
      const rtHsThreshold = rtPos.swarmStrategy ? -20 : rtPos.neoStrategy ? -25 : -20; // SWARM -20%, NEO -25%, STD -20%
      if (!rtShouldSell && rtPnl <= rtHsThreshold) {
        rtReason = `⚡ RT-HARD_STOP — P&L ${rtPnl.toFixed(1)}% (threshold ${rtHsThreshold}%) | MC ${mcUsd.toFixed(0)}`;
        this.consecutiveHardStops++;
        if (this.consecutiveHardStops >= this.CB_MAX_HS) {
          this.circuitBreakerUntil = Date.now() + this.CB_PAUSE_MS;
          console.log(`🛑 CIRCUIT BREAKER — ${this.consecutiveHardStops} HS consécutifs → pause ${this.CB_PAUSE_MS/60000}min`);
        }
        rtShouldSell = true;
      }
      
      // 3. Rugger exits
      if (!rtShouldSell && this.ruggerPositions.has(tokenAddress)) {
        const rProfile = this.ruggerProfiler.getProfile(rtPos.walletAddress);
        if (rProfile) {
          if (mcUsd >= rProfile.targetExitMC) {
            rtReason = `⚡ RT-RUGGER_TARGET — MC ${mcUsd.toFixed(0)} >= ${rProfile.targetExitMC.toFixed(0)} | P&L +${rtPnl.toFixed(1)}%`;
            rtShouldSell = true;
          }
        }
      }
      
      if (rtShouldSell) {
        logger.info({ 
          token: tokenAddress.slice(0, 8), 
          mc: mcUsd.toFixed(0), 
          peak: rtPos.highestMC.toFixed(0),
          pnl: rtPnl.toFixed(1),
          reason: rtReason.slice(0, 80)
        }, '⚡ REAL-TIME EXIT triggered');
        
        // DIRECT SELL — don't go through async maybeEvaluateLive
        const rtSellResult = this.sell(100, 1.0, 'RIDE', rtReason, this.emptySignals());
        this.openPositions.delete(tokenAddress);
        const rtExitType = rtReason.includes('HARD_STOP') ? 'HARD_STOP' : rtReason.includes('RUGGER') ? 'RUGGER_TARGET' : 'TRAIL';
        this.closedTokens.set(tokenAddress, { 
          exitType: rtExitType, exitMC: mcUsd, exitTime: Date.now(), 
          entryMC: rtPos.entryMC, peakMC: rtPos.highestMC, 
          reentryCount: rtExitType === 'TRAIL' ? 0 : 99 
        });
        this.ruggerPositions.delete(tokenAddress);
        // Log to paper trades
        this.onSweepClose(tokenAddress, rtSellResult, mcUsd);
        return; // Done — position closed instantly
      }
    }

    this.maybeEvaluateLive(tokenAddress, mcUsd).catch(() => {});
  }

  public onSweepClose(tokenAddress: string, result?: any, mc?: number): void {
    const pos = this.openPositions.get(tokenAddress);
    const entryMC = pos?.entryMC || 0;
    const exitMC = mc || pos?.lowestMCAfterEntry || entryMC;
    const pnl = entryMC > 0 ? ((exitMC - entryMC) / entryMC * 100).toFixed(1) : '0';
    this.openPositions.delete(tokenAddress);
    this.closedTokens.set(tokenAddress, { exitType: 'SWEEP', exitMC: exitMC, exitTime: Date.now(), entryMC, peakMC: pos?.highestMC || 0, reentryCount: 99 });
    // Log sweep to paper-trades via onTrade if available
    if (typeof (this as any).onTrade === 'function') {
      (this as any).onTrade({
        action: 'SELL', confidence: 1, percentage: 100, playbook_strategy: 'RIDE',
        reason: `🧹 SWEEP: position fermée (P&L ${pnl}%) — token inactif`
      }, tokenAddress, exitMC);
    }
  }

  isLiveTracked(tokenAddress: string): boolean {
    return this.rideCache.get(tokenAddress)?.isRide === true;
  }

  private async maybeEvaluateLive(tokenAddress: string, currentMC: number): Promise<void> {
    if (this.evaluating.has(tokenAddress)) return;

    let cached = this.rideCache.get(tokenAddress);
    // v10: evaluate ALL tokens (entry based on market demand, not wallet)
    if (cached && cached.isRide === false && !this.openPositions.has(tokenAddress)) {
      // Only skip if we already checked and no position open
      // But re-evaluate after 5s in case buyer count changed
      const state = this.liveState.get(tokenAddress);
      const buyers = state?.uniqueBuyers?.size ?? 0;
      // Bypass buyer filter for qualified rugger wallets
      if (buyers < 15) {
        const walletAddr = cached?.walletAddress || '';
        if (!walletAddr || !this.ruggerProfiler.getProfile(walletAddr)) {
          return; // v10: skip until meaningful buyer count (unless rugger wallet or velocity)
        }
      }
    }

    this.evaluating.add(tokenAddress);
    try {
      if (!cached) {
        const token = await this.tokenRepo.getByAddress(tokenAddress);
        if (!token) {
          this.rideCache.set(tokenAddress, { isRide: false, isCleanRide: false, detectedAt: new Date(), fdvAtDetection: 0, walletAddress: '', walletRiskScore: 0.5, strategy: null });
          return; // token not found — skip
        }
        const wallet = await this.walletRepo.getByAddress(token.creator_wallet);
        const playbook: RuggerPlaybook | null = wallet?.rugger_playbook
          ? (typeof wallet.rugger_playbook === 'string'
              ? JSON.parse(wallet.rugger_playbook) as RuggerPlaybook
              : wallet.rugger_playbook as RuggerPlaybook)
          : null;
        const _isRide = playbook?.recommended_strategy === 'RIDE';
        // v9.0: Also check wallet strategy column — wallets can be RIDE via SigmoidScorer
        const _isRideByStrategy = wallet?.strategy === 'RIDE';
        // v9.2: New wallets with 0 rugs are potential clean — evaluate them
        const isNewClean = !wallet?.strategy && (wallet?.rug_count ?? 0) === 0;
        // v10: ALL tokens are candidates (market demand determines entry, not wallet)
        // v10.10j: Block FADE/WATCH wallets — backtest: WR 27%, avg -13% (22 trades, 16 losses eliminated)
        // v10.10j: Store wallet risk score for position sizing
        let walletRiskScore = wallet?.risk_score ?? 0.5; // default 0.5 for unknown wallets
        const walletStrat = wallet?.strategy;
        if (walletStrat === 'FADE') {
          logger.debug({ wallet: token.creator_wallet.slice(0, 8), strategy: walletStrat, rugs: wallet?.rug_count }, '🚫 v10.10j: FADE wallet blocked');
          this.rideCache.set(tokenAddress, { isRide: false, isCleanRide: false, detectedAt: new Date(), fdvAtDetection: 0, walletAddress: token.creator_wallet, walletRiskScore, strategy: null });
          return;
        }

        // v10.10j: Check funder's risk score (RPC-based, cached from OBSERVE prefetch)
        const funderResult = await this.funderLookup.getFunder(token.creator_wallet);
        if (funderResult) {
          const funderProfile = await this.walletRepo.getByAddress(funderResult.funder);
          if (funderProfile) {
            const funderRisk = funderProfile.risk_score ?? 0;
            const funderRugs = funderProfile.rug_count ?? 0;
            const funderStrat = funderProfile.strategy;
            // Inherit worst-of: funder risk or creator risk
            if (funderRisk > walletRiskScore) {
              walletRiskScore = Math.max(walletRiskScore, funderRisk * funderResult.confidence);
              logger.info({ creator: token.creator_wallet.slice(0, 8), funder: funderResult.funder.slice(0, 8), funderRisk: funderRisk.toFixed(2), funderRugs, funderStrat, adjustedRisk: walletRiskScore.toFixed(2) }, '⚠️ v10.10j: Funder risk inherited');
            }
            // Block if funder is FADE
            if (funderStrat === 'FADE' || funderStrat === 'AVOID') {
              logger.info({ creator: token.creator_wallet.slice(0, 8), funder: funderResult.funder.slice(0, 8), funderStrat, funderRugs }, '🚫 v10.10j: Toxic funder — wallet blocked');
              this.rideCache.set(tokenAddress, { isRide: false, isCleanRide: false, detectedAt: new Date(), fdvAtDetection: 0, walletAddress: token.creator_wallet, walletRiskScore: 1.0, strategy: null });
              return;
            }
          }
          // Store ancestry in DB (async, non-blocking)
          this.storeAncestry(token.creator_wallet, funderResult).catch(() => {});
        }

        const effectiveRide = true;
        
        let strategy: WalletStrategy | null = null;
        let isCleanRide = true; // v10: treat all as clean entry path
        if (effectiveRide) {
          // v9.0: Handle wallets WITHOUT a playbook or with minimal playbook (sample_size=0)
          // These are clean/low-rug wallets classified as RIDE by the SigmoidScorer
          const hasNoPlaybook = !playbook || playbook.sample_size === 0;
          const isCleanWallet = (wallet?.rug_count ?? 0) <= 1;
          isCleanRide = hasNoPlaybook && isCleanWallet;
          // v9.2: Brand new wallets (no strategy) are always clean
          if (isNewClean) isCleanRide = true;
          if (isCleanRide) {
            strategy = {
              minPumpPct: 0.10,
              maxEntryRatio: 2.50,
              maxEntrySec: 30,
              targetRatio: 2.0,
              maxHoldSec: 120,
              stopLossPct: 0.15,
              trailingStopPct: 0.12,
              cascadeThreshold: 4,
              winRate: 0.70,  // 100% historical but conservative estimate
              evPerTrade: 25,  // high EV from backtest
              sampleSize: wallet?.survival_count ?? 3,
            };
            this.walletStrategies.set(token.creator_wallet, strategy);
            logger.info({
              wallet: token.creator_wallet.slice(0, 8),
              survivalCount: wallet?.survival_count,
            }, '🌟 CLEAN_RIDE strategy — high-quality clean wallet');
          } else if (playbook) {
            strategy = await this.getWalletStrategy(token.creator_wallet, playbook);
            // Skip wallets with negative EV
            if (strategy.evPerTrade <= 0) {
              logger.debug({ wallet: token.creator_wallet.slice(0, 8), ev: strategy.evPerTrade.toFixed(1) }, 'Skipping negative EV wallet');
              this.rideCache.set(tokenAddress, { isRide: false, isCleanRide: false, detectedAt: new Date(), fdvAtDetection: 0, walletAddress: token.creator_wallet, walletRiskScore: walletRiskScore ?? 0.5, strategy: null });
              return;
            }
          }
        }
        
        cached = {
          isRide: effectiveRide && strategy !== null && strategy.evPerTrade > 0,
          isCleanRide,
          detectedAt: token.detected_at ?? new Date(),
          fdvAtDetection: token.fdv_at_detection ?? 0,
          walletAddress: token.creator_wallet,
          walletRiskScore,
          strategy,
        };
        this.rideCache.set(tokenAddress, cached);
        if (!cached.isRide) {
          return;
        }
        logger.info({ token: tokenAddress.slice(0, 8), mc: currentMC.toFixed(0), ev: strategy!.evPerTrade.toFixed(1) + '%' }, '🎯 RIDE token — per-wallet strategy active');
      }

      const elapsedMs = Date.now() - cached.detectedAt.getTime();
      const elapsedMinutes = elapsedMs / 60000;

      if (elapsedMinutes > 10) {
        this.rideCache.delete(tokenAddress);
        return;
      }

      if (!this.firstMC.has(tokenAddress)) {
        this.firstMC.set(tokenAddress, currentMC);
      }

      await this.evaluateTrade(tokenAddress, elapsedMinutes, currentMC);
    } finally {
      this.evaluating.delete(tokenAddress);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN EVALUATION
  // ─────────────────────────────────────────────────────────────

  async evaluateTrade(
    tokenAddress: string,
    elapsedMinutes: number,
    currentMC: number
  ): Promise<TradeSignal> {
    try {
      if (!this.firstMC.has(tokenAddress)) {
        this.firstMC.set(tokenAddress, currentMC);
      }

      const pos = this.openPositions.get(tokenAddress);
      if (pos) {
        if (currentMC > pos.highestMC && currentMC < pos.highestMC * 5) {
          pos.highestMC = currentMC;
          pos.peakTime = Date.now();
        }
        // v10.10: Ceiling detection — track ticks without new high (>2%)
        if (currentMC > (pos.ceilingHigh || pos.entryMC) * 1.02) {
          pos.ceilingHigh = currentMC;
          pos.staleTicks = 0;
        } else {
          pos.staleTicks = (pos.staleTicks || 0) + 1;
        }

        // v10.10c: Pump cycle tracking (for lower-high exit on pump 3)
        if (!pos.pumpPeaks) { pos.pumpPeaks = []; pos.pumpState = 'PUMP'; pos.cycleHigh = pos.entryMC; pos.dipLow = pos.entryMC; }
        if (pos.pumpState === 'PUMP') {
          if (currentMC > pos.cycleHigh) pos.cycleHigh = currentMC;
          const dropFromCycle = (pos.cycleHigh - currentMC) / pos.cycleHigh;
          const cyclePnl = (pos.cycleHigh - pos.entryMC) / pos.entryMC * 100;
          if (dropFromCycle >= 0.05 && cyclePnl > 3) {
            // Dipped 5% from cycle high → record peak, enter DIP state
            pos.pumpPeaks.push(pos.cycleHigh);
            pos.pumpState = 'DIP';
            pos.dipLow = currentMC;
          }
        } else {
          // DIP state
          if (currentMC < pos.dipLow) pos.dipLow = currentMC;
          if (currentMC > pos.dipLow * 1.03) {
            // Recovering 3% from dip → new pump starting
            pos.pumpState = 'PUMP';
            pos.cycleHigh = currentMC;
          }
        }
        const currentProfit = (pos.highestMC - pos.entryMC) / pos.entryMC;
        if (currentProfit >= 0.20) pos.hadSignificantPump = true;
        if (currentMC < pos.lowestMCAfterEntry) pos.lowestMCAfterEntry = currentMC;
        pos.tradeCount++;
        // v10.10d: Track MCs for post-buy confirmation
        if (pos.tickMCs && !pos.confirmationDone) {
          pos.tickMCs.push(currentMC);
        }

        // ══════════════════════════════════════════════════════════════
        // v10.13: 60s POST-ENTRY CONFIRMATION (STD only)
        // Backtest: STRONG signal (buy_vol > 5x sell_vol + 15 new buyers) = 83% WR, +62.3%
        //           SELL_DOM (sell_vol > buy_vol) = 18% WR, -19.1%
        // Action: SELL_DOM → exit immediately | STRONG → add-on buy (double position)
        // ══════════════════════════════════════════════════════════════
        const holdSec60 = (Date.now() - pos.entryTime.getTime()) / 1000;
        if (!pos.postEntryChecked && !pos.neoStrategy && !pos.cartelStrategy && holdSec60 >= 60 && holdSec60 <= 90) {
          pos.postEntryChecked = true;
          const state60 = this.liveState.get(tokenAddress);
          if (state60?.rawTrades) {
            const entryTs = pos.entryTime.getTime();
            const postTrades = state60.rawTrades.filter((t: any) => t.ts >= entryTs && t.ts <= entryTs + 60000);
            const buyVol60 = postTrades.filter((t: any) => t.type === 'buy').reduce((s: number, t: any) => s + t.usd, 0);
            const sellVol60 = postTrades.filter((t: any) => t.type === 'sell').reduce((s: number, t: any) => s + t.usd, 0);
            const postBuyers = new Set(postTrades.filter((t: any) => t.type === 'buy').map((t: any) => t.trader)).size;
            const volRatio60 = sellVol60 > 0 ? buyVol60 / sellVol60 : (buyVol60 > 0 ? 99 : 0);

            if (sellVol60 > buyVol60) {
              pos.postEntrySignal = 'SELL_DOM';
              // SELL_DOM: 18% WR, avg -19.1% → exit immediately
              const pnl60 = ((currentMC - pos.entryMC) / pos.entryMC * 100);
              logger.info({ token: tokenAddress.slice(0, 8), buyVol: buyVol60.toFixed(0), sellVol: sellVol60.toFixed(0), postBuyers, pnl: pnl60.toFixed(1) },
                '🚫 v10.13 SELL_DOM at 60s — exiting STD position');
              this.openPositions.delete(tokenAddress);
              return this.sell(100, 0.95, 'RIDE',
                `🚫 v10.13 SELL_DOM_60s — sell>${'$'}${sellVol60.toFixed(0)} > buy>${'$'}${buyVol60.toFixed(0)} (${postBuyers}b) | P&L ${pnl60.toFixed(1)}%`,
                this.emptySignals());
            } else if (volRatio60 > 5 && postBuyers >= 15) {
              pos.postEntrySignal = 'STRONG';
              pos.addOnBought = true;
              // STRONG: 83% WR, +62.3% → add-on buy (double exposure)
              // Record add-on MC for blended P&L: original entry + add-on at current MC
              (pos as any).addOnMC = currentMC;
              (pos as any).addOnSol = (pos as any).originalPositionSol || 0;
              logger.info({ token: tokenAddress.slice(0, 8), buyVol: buyVol60.toFixed(0), sellVol: sellVol60.toFixed(0), ratio: volRatio60.toFixed(1), postBuyers, mc: currentMC.toFixed(0) },
                '🔥 v10.13 STRONG CONFIRMATION — doubling position');
            } else if (volRatio60 > 1 && postBuyers >= 10) {
              pos.postEntrySignal = 'GOOD';
            } else {
              pos.postEntrySignal = 'WEAK';
            }
            logger.info({ token: tokenAddress.slice(0, 8), signal: pos.postEntrySignal, volRatio: volRatio60.toFixed(1), postBuyers, buyVol: buyVol60.toFixed(0), sellVol: sellVol60.toFixed(0) },
              '📊 v10.13 60s confirmation');
          }
        }
      }

      const _elapsedSec = elapsedMinutes * 60;
      let cached = this.rideCache.get(tokenAddress);
      if (!cached || !cached.strategy) {
        // v10: create a default strategy for any token (market demand determines entry)
        const token = await this.tokenRepo.getByAddress(tokenAddress);
        if (!token) return this.none('Token not found');
        const detectedAt = token.detected_at ? new Date(token.detected_at) : new Date();
        const fdv = token.fdv_at_detection ?? (this.firstMC.get(tokenAddress) ?? currentMC);
        
        // Auto-create cache entry with v10 default strategy
        const cacheEntry = {
          isRide: true,
          isCleanRide: true,
          detectedAt,
          fdvAtDetection: fdv,
          walletAddress: token.creator_wallet,
          strategy: {
            minPumpPct: 0.10,
            maxEntryRatio: 2.5, // v10.3: reduced from 5.0 → 2.5 (2026-03-13 21:01 UTC) — ratio 2-3x: 9t WR=33% avg +2%, filter out late entries
            maxEntrySec: 90,
            targetRatio: 2.0,
            sampleSize: 0,
            winRate: 0,
            evPerTrade: 0,
            cascadeThreshold: 8,
            maxHoldSec: 300,
            stopLossPct: 0.15,
            trailingStopPct: 0.10,
          }
        };
        this.rideCache.set(tokenAddress, cacheEntry);
        cached = cacheEntry;
      }

      const ws = cached!.strategy!;
      const baselineMC = cached!.fdvAtDetection > 0 ? cached!.fdvAtDetection : (this.firstMC.get(tokenAddress) ?? currentMC);
      const state = this.liveState.get(tokenAddress);
      const elapsedSec = _elapsedSec;
      const mcRatio = currentMC / Math.max(baselineMC, 1);

      // ── MANAGE OPEN POSITION ──
      if (pos) {
        return this.managePosition(tokenAddress, pos, ws, currentMC, elapsedSec, state);
      }

      // ── EVALUATE ENTRY ──
      return await this.evaluateEntry(tokenAddress, ws, currentMC, baselineMC, mcRatio, elapsedSec, state, cached!.walletAddress);

    } catch (err) {
      logger.error({ err, tokenAddress }, 'TradeExecutor error');
      return this.none('Evaluation error');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // POSITION MANAGEMENT (per-wallet parameters)
  // ─────────────────────────────────────────────────────────────

  private managePosition(
    tokenAddress: string,
    pos: OpenPosition,
    ws: WalletStrategy,
    currentMC: number,
    elapsedSec: number,
    state: LiveTradeState | undefined
  ): TradeSignal {

    const holdSec = (Date.now() - pos.entryTime.getTime()) / 1000;
    const pnlPct = ((currentMC - pos.entryMC) / pos.entryMC) * 100;
    const peakPnl = ((pos.highestMC - pos.entryMC) / pos.entryMC) * 100;
    const dropFromPeak = pos.highestMC > 0 ? (pos.highestMC - currentMC) / pos.highestMC : 0;
    const _isClean = this.rideCache.get(tokenAddress)?.isCleanRide ?? false;
    const signals: SignalBreakdown = { timing_score: 0, momentum_score: 0, consistency_score: 0, risk_score: 0, wallet_score: 0 };

    // ══════════════════════════════════════════════════════════════
    // RUGGER EXIT — Target MC based on wallet profile
    // ══════════════════════════════════════════════════════════════
    if (this.ruggerPositions.has(tokenAddress)) {
      const rProfile = this.ruggerProfiler.getProfile(pos.walletAddress);
      if (rProfile) {
        const targetMC = rProfile.targetExitMC;
        const timeStopSec = rProfile.timeStopMin * 60;
        
        // 1. TARGET HIT — sell at profit
        if (currentMC >= targetMC) {
          this.ruggerPositions.delete(tokenAddress);
          return this.sell(100, 0.95, 'RIDE',
            `🎯 RUGGER TARGET — MC ${currentMC.toFixed(0)} >= ${targetMC.toFixed(0)} | P&L ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s`,
            signals);
        }
        
        // 2. TIME STOP — exit before average rug time
        if (holdSec >= timeStopSec) {
          this.ruggerPositions.delete(tokenAddress);
          return this.sell(100, 0.90, 'RIDE',
            `⏱️ RUGGER TIME_STOP — ${holdSec.toFixed(0)}s >= ${timeStopSec.toFixed(0)}s | P&L ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
            signals);
        }
        
        // 3. HARD STOP — limit losses
        if (pnlPct <= -20) {
          this.ruggerPositions.delete(tokenAddress);
          return this.sell(100, 1.0, 'RIDE',
            `🛑 RUGGER HARD_STOP — P&L ${pnlPct.toFixed(1)}% <= -20% | MC ${currentMC.toFixed(0)}`,
            signals);
        }
        
        // 4. BONUS: if MC goes WAY above target (>1.5x target), ride with trailing stop
        if (currentMC > targetMC * 1.5 && dropFromPeak > 0.15) {
          this.ruggerPositions.delete(tokenAddress);
          return this.sell(100, 0.90, 'RIDE',
            `🎯 RUGGER TRAIL — MC ${currentMC.toFixed(0)} (>${(targetMC*1.5).toFixed(0)}), drop -${(dropFromPeak*100).toFixed(0)}% from peak | P&L +${pnlPct.toFixed(1)}%`,
            signals);
        }
        
        // Hold — waiting for target or time stop
        return { action: 'HOLD', confidence: 0.5, percentage: 0, playbook_strategy: 'RIDE',
          reason: `🎯 RUGGER HOLD — MC ${currentMC.toFixed(0)}/${targetMC.toFixed(0)} (${(currentMC/targetMC*100).toFixed(0)}%) | P&L ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}% | ${holdSec.toFixed(0)}s/${timeStopSec.toFixed(0)}s` };
      }
      // Profile disappeared — fall through to standard exit
      this.ruggerPositions.delete(tokenAddress);
    }

    // ══════════════════════════════════════════════════════════════
    // v10 EXIT STRATEGY
    //
    // Backtest: Trail -10% from peak → 69.3% WR, avg +52.7% P&L
    // Median peak at T+24s from detection (very fast)
    // ══════════════════════════════════════════════════════════════

    // v10.10: Tiered exits (Raph config 2026-03-15 14:59 UTC)
    // Below +40% peak → only hard stop at -25% from entry
    // +40% → -15% drop | +50-60% → -20% | +70% → -15% | +80% → -10% | +90-100% → -5% | >100% → -15%
    // v10.10h: Raph tiered exits 2026-03-17 03:44 UTC
    // Below +20% peak → hard stop at -20% from ENTRY (handled below)
    // Optimized tiers (62-trade analysis): no trail <50%, tighter on rockets
    // v10.10k: Adaptive trail based on seller growth rate post-entry
    const currentSellers = state?.uniqueSellers?.size || 0;
    const currentBuyers = state?.uniqueBuyers?.size || 0;
    const newSellers = currentSellers - (pos.entrySellersCount || 0);
    const newBuyers = currentBuyers - (pos.entryBuyerCount || 0);
    const sellerGrowthRatio = newBuyers > 15 ? newSellers / newBuyers : -1; // need 15+ new buyers for signal

    const isNeo = pos.neoStrategy === true;
    const isCartel = pos.cartelStrategy === true;
    const isSwarm = pos.swarmStrategy === true;
    const trailTrigger = isSwarm ? 40 : (isNeo || isCartel) ? 25 : 50; // SWARM: trail from +40% // NEO/CARTEL: 25%, STD: 50%
    let dropLimit = 0; // 0 = no trail, rely on hard stop
    if (peakPnl >= trailTrigger) {
      if (isSwarm) {
        dropLimit = 0.20; // SWARM: 20% trail drop
      } else
      if (isCartel) {
        dropLimit = 0.20; // CARTEL: 20% trail (more room for big moves)
      } else if (isNeo) {
        // NEO v4.25: adaptive trail — tight at small peaks, wider for rockets
        // DB: trail exits 100%+: 7 @+180% | 50-100%: 10 @+66% | 30-50%: 22 @+41% | <30%: 41 @+18%
        // Goal: let 50%+ peaks breathe (18-22% trail) → capture larger moves, match CARTEL
        // NEO v4.27: tiered adaptive trail
        // Trigger lowered 30→25% to save 25-30% peakers from HS
        // 50-100% tier tightened 18→16% (better capture, math: +2% x43 trades)
        // NEO v4.30: seller-growth-aware tiered trail
        // Data: sellerGrowthRatio ≤20% post-entry → 94.1% WR → let these tokens breathe (wider trail)
        // sellerGrowthRatio >40% → dump pressure → protect gains (tighter trail)
        // v4.31: extend seller-growth-aware trail to 25-50% zone — healthy tokens get more room to dip+recover
        const healthyToken = sellerGrowthRatio >= 0 && sellerGrowthRatio <= 0.20;
        const dumpPressure = sellerGrowthRatio > 0.40;
        if (peakPnl >= 100) {
          dropLimit = healthyToken ? 0.27 : dumpPressure ? 0.18 : 0.22; // v4.30: healthy→27%, dump→18%, default→22%
        } else if (peakPnl >= 50) {
          dropLimit = healthyToken ? 0.18 : dumpPressure ? 0.12 : 0.15; // v4.49: slight tighten — healthy→18%, dump→12%, default→15% (was 22/15/18)
        } else if (peakPnl >= 30) {
          dropLimit = healthyToken ? 0.12 : dumpPressure ? 0.07 : 0.10; // v4.49: TIGHT — healthy→12%, dump→7%, default→10% (was 20/10/16) — exit ~+18-27% gross
        } else {
          dropLimit = healthyToken ? 0.08 : dumpPressure ? 0.05 : 0.06; // v4.49: TIGHT — healthy→8%, dump→5%, default→6% (was 16/8/12) — exit ~+15-18% gross vs +5% gross at old 16% trail
        }
      } else if (sellerGrowthRatio >= 0 && sellerGrowthRatio <= 0.20) {
        dropLimit = 0.25; // ≤20% seller ratio → healthy token, let it run (wider trail)
      } else if (sellerGrowthRatio > 0.40) {
        dropLimit = 0.15; // >40% seller ratio → dump pressure, protect gains (tight trail)
      } else {
        dropLimit = 0.20; // 20-40% or not enough data → standard FLAT 20%
      }
    }
    // Below 50%: no trailing stop — let it run or hit hard stop
    // v10.10k: Early exit on high seller pressure below 50% peak
    if (false && peakPnl < 50) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'SELLER_PRESSURE', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0; // CB reset on non-HS exit
      return this.sell(100, 0.90, 'RIDE', `🚨 v10.10k SELLER_PRESSURE — ${newSellers} new sellers / ${newBuyers} new buyers (${(sellerGrowthRatio*100).toFixed(0)}%) | peak +${peakPnl.toFixed(0)}% | P&L ${pnlPct.toFixed(1)}%`, signals);
    }

    // 1. Drop stop (tiered) — only if peak reached a tier
    if (dropLimit > 0 && dropFromPeak > dropLimit) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'TRAIL', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0; // CB reset on non-HS exit
      const capturedPnl = ((pos.highestMC * (1 - dropLimit) - pos.entryMC) / pos.entryMC * 100).toFixed(1);
      return this.sell(100, 0.95, 'RIDE', `📉 v10 DROP -${(dropFromPeak*100).toFixed(0)}%>${(dropLimit*100).toFixed(0)}% from peak +${peakPnl.toFixed(0)}% | captured ~${capturedPnl}%`, signals);
    }

    // 2. Hard stop: -25% from ENTRY (only if no drop tier reached)
    // v10.10: CEILING EXIT — DISABLED after backtest showed it cuts winners

    // v10.10i: PUMP3 EXIT — 3 pumps without reaching trail trigger = token is crab, exit at -7% from 3rd peak
    // NEO v4.19: NEO trail triggers at +30% → PUMP3 threshold also 30% (was 50%). Faster crab exit, matches trail.
    // STD/CARTEL keep 50% threshold. STD: no trail below 50%, so 50% is correct for them.
    const pump3Threshold = isNeo ? 25 : 50; // NEO v4.27: aligned with trail trigger (25%)
    // v10.13: PUMP3 disabled for STD until 2026-03-25 20:23 UTC (Raph request)
    const pump3DisabledForSTD = !isNeo && !isCartel && Date.now() < new Date("2026-03-25T20:23:00Z").getTime();
    if (!pump3DisabledForSTD && pos.pumpPeaks && pos.pumpPeaks.length >= 3 && peakPnl < pump3Threshold) {
      const thirdPeak = pos.pumpPeaks[2];
      const dropFrom3rd = (thirdPeak - currentMC) / thirdPeak;
      if (dropFrom3rd >= 0.05) { // NEO v4.28: 7%→5% tighter PUMP3 exit (v4.27 PUMP3 was -5.4% avg on 10 trades)
        this.openPositions.delete(tokenAddress);
        this.closedTokens.set(tokenAddress, { exitType: 'PUMP3_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0; // CB reset on non-HS exit
        return this.sell(100, 0.90, 'RIDE',
          `🔄 v10.10g PUMP3 EXIT — 3 pumps, peak +${peakPnl.toFixed(0)}% <50%, drop -${(dropFrom3rd*100).toFixed(0)}% from pump3 | P&L ${pnlPct.toFixed(1)}%`,
          signals);
      }
    }

    // v10.10c: LOWER HIGH EXIT on pump 3+
    // If 3rd pump fails to break significantly above 2nd pump → momentum dead, exit
    // Backtest: p2<50% margin15% → 469 triggers, +5.7% exit, saves +2.9%, WR 54%
    if (pos.pumpPeaks && pos.pumpPeaks.length >= 2 && pos.pumpState === 'PUMP') {
      const lastPeak = pos.pumpPeaks[pos.pumpPeaks.length - 1];
      const lastPeakPnl = (lastPeak - pos.entryMC) / pos.entryMC * 100;
      // Only apply when previous peaks were small (<50%) — don't cut moonshots
      if (lastPeakPnl < 50) {
        // Current pump cycle high vs last recorded peak
        const margin = (pos.cycleHigh - lastPeak) / lastPeak;
        if (margin < 0.15) {
          // Lower high (or barely higher) — check for -10% drop from current cycle high
          const dropFromCycle = (pos.cycleHigh - currentMC) / pos.cycleHigh;
          if (dropFromCycle >= 0.10) {
            this.openPositions.delete(tokenAddress);
            this.closedTokens.set(tokenAddress, { exitType: 'LOWER_HIGH', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0; // CB reset on non-HS exit
            return this.sell(100, 0.90, 'RIDE',
              `📉 v10.10 LOWER HIGH — pump ${pos.pumpPeaks.length + 1} failed (cycle +${((pos.cycleHigh-pos.entryMC)/pos.entryMC*100).toFixed(0)}% vs prev +${lastPeakPnl.toFixed(0)}%) | P&L ${pnlPct.toFixed(1)}%`,
              signals);
          }
        }
      }
    }

    // ── ELITE-MIMIC: sell-surge early exit ──
    if (false) { // copy-exit removed
      const recentSells = state?.recentSells ?? 0;
      const recentBuys = state?.recentBuys ?? 0;
      const sbRatio = recentBuys > 0 ? recentSells / recentBuys : 99;
      if (sbRatio > 1.5 && recentSells >= 3) {
        this.openPositions.delete(tokenAddress);
        this.closedTokens.set(tokenAddress, { exitType: 'ELITE_SURGE', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
        this.consecutiveHardStops = 0;
        return this.sell(100, 1.0, 'RIDE', `👑 ELITE_SURGE_EXIT sb=${sbRatio.toFixed(2)} sells=${recentSells} pnl=${pnlPct.toFixed(1)}% | MC ${currentMC.toFixed(0)}`, signals);
      }
    }

        const hsThreshold = pos.swarmStrategy ? -20 : pos.neoStrategy ? -25 : -20; // SWARM -20% // NEO -25%
    if (pnlPct <= hsThreshold) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'HARD_STOP', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops++;
      if (this.consecutiveHardStops >= this.CB_MAX_HS) {
        this.circuitBreakerUntil = Date.now() + this.CB_PAUSE_MS;
        console.log(`🛑 CIRCUIT BREAKER — ${this.consecutiveHardStops} HS consécutifs → pause ${this.CB_PAUSE_MS/60000}min`);
      }
      const hsLabel = pos.swarmStrategy ? '🐝 SWARM' : pos.cartelStrategy ? '🤝 CARTEL' : pos.neoStrategy ? '🧠 NEO' : '🛑 v10';
      return this.sell(100, 1.0, 'RIDE', `${hsLabel} HARD_STOP ${pnlPct.toFixed(1)}% | peak +${peakPnl.toFixed(0)}% (threshold ${hsThreshold}%) | MC ${currentMC.toFixed(0)}`, signals);
    }

    // ELITE-MIMIC: 120s max hold (ELITE avg hold = 41s win / 33s loss)
    if (isSwarm && holdSec > 300) { // SWARM: max 300s hold
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'ELITE_MAX_HOLD', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0;
      return this.sell(100, 0.9, 'RIDE', `👑 ELITE_MAX_HOLD 120s — pnl=${pnlPct.toFixed(1)}% | MC ${currentMC.toFixed(0)}`, signals);
    }

    // 2. MAX HOLD: 5 minutes → force exit
    if ((isNeo ? holdSec > 870 : holdSec > 600)) { // NEO v4.26: NEO→870s (just before 900s sweep), STD→600s
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'MAX_HOLD', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0; // CB reset
      return this.sell(100, 0.9, 'RIDE', `⏰ v10 MAX HOLD 5min — P&L ${pnlPct.toFixed(1)}%`, signals);
    }

    // NEO v4.54: STALE_MICRO (30-50s) — token never moved up, already -10%+ = slow gap rug, exit early
    // Gap: STALE_EARLY covers pnl<-13%, MICRO fills -10 to -13% window in 30-50s. Peak<0.5% = no upward signal.
    // Saves ~15pp per trade vs HS avg (-10% vs -35% avg HS). 16t in -10 to -5% RT-TRAIL range could be caught.
    if (isNeo && holdSec > 30 && holdSec <= 50 && pnlPct < -10 && peakPnl < 0.5) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops++;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.54 STALE_MICRO ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — slow gap rug`, signals);
    }

    // NEO v4.48: STALE_EXIT ultra-early (25s) — token at -16% with zero upward movement = gap rug in progress
    // Exits at ~-16% vs HS avg -34.6% → saves ~18% per trade. peakPnl < 0.5 = never went up = pure rug signal
    if (isNeo && holdSec > 25 && holdSec <= 120 && pnlPct < -13 && peakPnl < 0.5) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops++;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.48 STALE_EARLY ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — zero momentum rug`, signals);
    }

    // NEO v4.52: STALE_EARLYBLEED (50-88s) — fills gap between STALE_EARLY (peak<0.5) and STALE_FAST (90s+)
    // Targets tokens with tiny peak (0.5-1.5%) bleeding at -13%+ in 50-88s window → heading for HS at -25%
    // Saves ~12pp per trade vs HS (exit at -14% vs -33% avg). Risk low: peak<1.5% = no real momentum.
    if (isNeo && holdSec > 50 && holdSec <= 88 && pnlPct < -13 && peakPnl < 1.5) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.52 STALE_EARLYBLEED ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — gap fill early exit`, signals);
    }

    // NEO v4.51: STALE_FAST (90s) — token bleeding slowly with no peak = exit before further deterioration
    // Gap rugs fire HS at tick 0. STALE_FAST catches slow bleeds: -8%+ at 90s, peak <1.5% = no momentum.
    // Expected: saves ~20-25% vs HS on ~5-10% of trades in 90-170s window.
    if (isNeo && holdSec > 90 && holdSec <= 170 && pnlPct < -8 && peakPnl < 1.5) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.51 STALE_FAST ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — slow bleed exit`, signals);
    }

    // NEO v4.54: STALE_MID (150s) — token crabbing with no momentum = zombie trade [tightened: 180→150s, pnl<5→3%, peak<15→12%]
    // Data: 90 marginal trades (-10% to +10%) deployed 18 SOL for +0.29 SOL net. Cut crab zombies earlier.
    // v4.54: earlier exit (150s vs 180s) + tighter thresholds. Saves ~8% per trade vs letting run to 0%.
    if (isNeo && holdSec > 150 && pnlPct < 3 && peakPnl < 12) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.50 STALE_MID ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — crab zombie`, signals);
    }

    // NEO v4.48: STALE_EXIT late-stage (650s) — tokens stuck negative after 10min+ = momentum dead
    // TRACKING_END trades: 8t WR=12% avg=-2.6%. Exit at -3%/-8% saves vs -14% avg TRACKING_END
    if (isNeo && holdSec > 650 && pnlPct < -3 && peakPnl < 12) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0; // Not a rug — voluntary smart exit, reset CB
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.48 STALE_LATE ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — momentum dead`, signals);
    }

    // NEO v4.29: STALE EARLY EXIT — exit losing NEO positions before they hit the sweep
    // 13 TRACKING_END trades @-7.2% avg, mostly stuck losers. Exiting early at -10% saves 5-8%.
    if (isNeo && holdSec > 400 && pnlPct < -10 && peakPnl < 12) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops++;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.29 STALE_EXIT ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(0)}%`, signals);
    }

    // 3. BREAKEVEN removed in v10.9.9 — redundant with -15% drop stop
    // Was selling winners too early (e.g. peak +12%, dip to +2% → sold → token pumped +90%)

    // 4. GRACE PERIOD (first 8s): no trailing, just hard stop
    if (holdSec < 8) {
      return { action: 'HOLD', confidence: 0.5, reason: `⏳ v10 GRACE ${holdSec.toFixed(0)}s/8s | P&L ${pnlPct.toFixed(1)}% | peak +${peakPnl.toFixed(0)}%`, playbook_strategy: 'RIDE' };
    }

    // (old trail section removed — replaced by drop stop above)

    // 6. NO_PUMP removed v10.9.9 — 87% of NO_PUMP exits pumped after sell (avg +40%)
    // Let the -25% hard stop or -15% drop stop handle dead tokens naturally

    // v10.10: DISABLED — cascade kills dips that recover 73% of the time
    //     // 7. CASCADE DETECTION: sudden sell pressure
    // v10.10: DISABLED — cascade kills dips that recover 73% of the time
    //     if (state?.cascadeDetected && holdSec > 30 && pnlPct < -3) { // v10.9.4
    // v10.10: DISABLED — cascade kills dips that recover 73% of the time
    //       this.openPositions.delete(tokenAddress);
    // v10.10: DISABLED — cascade kills dips that recover 73% of the time
    //       this.closedTokens.set(tokenAddress, { exitType: 'CASCADE', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
    // v10.10: DISABLED — cascade kills dips that recover 73% of the time
    //       return this.sell(100, 0.9, 'RIDE', `🌊 v10 CASCADE — P&L ${pnlPct.toFixed(1)}%`, signals);
    // v10.10: DISABLED — cascade kills dips that recover 73% of the time
    //     }

    // HOLD
    return {
      action: 'HOLD', confidence: 0.5,
      reason: `📊 v10 HOLD ${holdSec.toFixed(0)}s | P&L ${pnlPct.toFixed(1)}% | peak +${peakPnl.toFixed(0)}% | drop ${(dropFromPeak*100).toFixed(0)}%/15%`,
      playbook_strategy: 'RIDE'
    };
  }

  private async evaluateEntry(
    tokenAddress: string,
    ws: WalletStrategy,
    currentMC: number,
    baselineMC: number,
    mcRatio: number,
    elapsedSec: number,
    state: LiveTradeState | undefined,
    walletAddress: string
  ): Promise<TradeSignal> {

    // Smart re-entry: allow on TRAIL exits only
    const closedInfo = this.closedTokens.get(tokenAddress);
    if (closedInfo) {
      // Block re-entry for non-TRAIL exits (losers)
      if (closedInfo.exitType !== 'TRAIL') {
        return this.none(`Token sorti (${closedInfo.exitType}) — pas de re-entry`, 'RIDE');
      }
      // Max 1 re-entry per token
      if (closedInfo.reentryCount >= 1) {
        return this.none('Token déjà re-entry 1x — max atteint', 'RIDE');
      }
      // Cooldown: at least 30s since sell
      const secSinceSell = (Date.now() - closedInfo.exitTime) / 1000;
      if (secSinceSell < 30) {
        return this.none(`Re-entry cooldown ${secSinceSell.toFixed(0)}s/30s`, 'RIDE');
      }
      // Re-entry conditions:
      // 1. Token must be above original entry (still a winning token)
      if (currentMC < closedInfo.entryMC * 1.05) {
        return this.none(`Re-entry: MC $${currentMC.toFixed(0)} < entry+5% $${(closedInfo.entryMC*1.05).toFixed(0)}`, 'RIDE');
      }
      // 2. Token must show renewed strength: current MC within 30% of peak (not dead)
      if (closedInfo.peakMC > 0 && currentMC < closedInfo.peakMC * 0.5) {
        return this.none(`Re-entry: MC $${currentMC.toFixed(0)} < 50% of peak $${closedInfo.peakMC.toFixed(0)} — too dead`, 'RIDE');
      }
      // Require momentum (same as first entry: 5 ticks rising)
      // This is checked below in the normal flow — so we just let it pass through
      // Mark as re-entry attempt
      this.closedTokens.set(tokenAddress, { ...closedInfo, reentryCount: closedInfo.reentryCount + 1 });
      // Log and continue to normal entry evaluation
      console.log(`🔄 RE-ENTRY candidate ${tokenAddress.slice(0,8)} — prev TRAIL at $${closedInfo.exitMC.toFixed(0)}, MC now ${currentMC.toFixed(0)}`);
    }

    // v10.12: Split position pools — 2 NEO + 3 CARTEL + 2 STANDARD = 5 max
    const neoCount = Array.from(this.openPositions.values()).filter(p => p.neoStrategy).length;
    const swarmCount = Array.from(this.openPositions.values()).filter(p => p.swarmStrategy).length;
    const cartelOpenCount = Array.from(this.openPositions.values()).filter(p => p.cartelStrategy).length;
    const stdCount = Array.from(this.openPositions.values()).filter(p => !p.neoStrategy && !p.earlyStrategy && !p.cartelStrategy && !p.swarmStrategy).length;
    const MAX_NEO = 1; // v10.14.4: NEO is losing
    const MAX_CARTEL = 1; // v10.14.4: reduced for ELITE
    const MAX_SWARM = 2; // SWARM v1.0: organic retail crowd (buyers≥80, avg_buy<$25, ratio 2.0-3.5x)
    const MAX_STD = 3; // v10.14.4
    const isNeoEntry = mcRatio < 2.0 && elapsedSec <= 75;
    if (isNeoEntry && neoCount >= MAX_NEO) {
      return this.none(`🚫 NEO pool full (${neoCount}/${MAX_NEO}) — skip`, 'RIDE');
    }
    if (cartelOpenCount >= MAX_CARTEL) {
      return this.none(`🚫 CARTEL pool full (${cartelOpenCount}/${MAX_CARTEL}) — skip`, 'RIDE');
    }
    // Individual pool guards moved inline to each strategy block for clarity
    if (this.openPositions.size >= 7) { // 3 STD + 1 NEO + 1 CARTEL + 2 SWARM = 7 max
      return this.none(`🚫 Max total positions (7) — skip`, 'RIDE');
    }

    const uniqueBuyerCount = state?.uniqueBuyers?.size ?? 0;
    const buyVol = state?.buyVol ?? 0;
    const buyCount = state?.buyCount ?? 0;
    const sellCount = state?.sellCount ?? 0;

    // ══════════════════════════════════════════════════════════════
    // v10 STRATEGY: "Market Validation First"
    //
    // Backtest (3 days, 1282 tokens):
    //   20+ unique buyers AND $1K+ vol at T+30s → 99.6% reach 1.5x
    //   Trail -10% from peak → 69.3% WR, avg +52.7% P&L
    //
    // Entry is PURELY based on market demand, not wallet reputation.
    // ══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════
    // v10.10 PROGRESSIVE ENTRY — "Enter early on organic tokens"
    // Instead of waiting for 50 buyers + 2x ratio (paying 81% premium),
    // enter at 15-20 buyers IF on-chain signals show organic demand.
    // DB analysis: 60.6% of filtered tokens reach 3x+ vs 38.2% unfiltered.
    // ═══════════════════════════════════════════════════════════
    // v10.10h: EARLY ENTRY DISABLED — backtest: ratio<2.0x = WR 34%, net -8.0%, wallet 6.03
    // Standard path only: b>=80, ratio>=2.0x, d<30 = WR 44%, net +7.2%, wallet 27.57

    // ══════════════════════════════════════════════════════════════
    // RUGGER STRATEGY — Per-wallet predictable behavior exploitation
    // Backtest: 16 qualified wallets, 1240 trades, WR 63%, avg +27.1% net
    // Entry: immediate (no buyer threshold needed)
    // Exit: at P25 target MC of wallet's history, or hard stop -20%
    // ══════════════════════════════════════════════════════════════
    if (false && !this.openPositions.has(tokenAddress) && !this.ruggerPositions.has(tokenAddress) && elapsedSec >= 3 && elapsedSec <= 30) {
      // Refresh profiles periodically
      await this.ruggerProfiler.refreshProfiles();
      
      const ruggerProfile = this.ruggerProfiler.getProfile(walletAddress);
      if (ruggerProfile) {
        // Qualified rugger wallet — enter immediately
        const minEntryMC = ruggerProfile.targetExitMC * 0.5; // Don't enter if already near target
        if (currentMC >= 4000 && currentMC < ruggerProfile.targetExitMC * 0.85 && currentMC > minEntryMC) {
          const expectedPnl = ((ruggerProfile.targetExitMC - currentMC) / currentMC * 100).toFixed(0);
          
          this.ruggerPositions.add(tokenAddress);
          this.openPositions.set(tokenAddress, {
            entryMC: currentMC,
            entryTime: new Date(),
            highestMC: currentMC,
            lowestMCAfterEntry: currentMC,
            tradeCount: 0,
            walletAddress,
            peakTime: Date.now(),
            hadSignificantPump: false,
            entryBuyVol: buyVol,
            entryBuyCount: buyCount,
            entryBuyerCount: uniqueBuyerCount,
    entrySellersCount: state?.uniqueSellers?.size || 0,
            staleTicks: 0,
            ceilingHigh: currentMC,
            pumpPeaks: [],
            pumpState: 'PUMP' as const,
            cycleHigh: currentMC,
            dipLow: currentMC,
            tickMCs: [currentMC],
            confirmationDone: false,
          });

          logger.info({
            token: tokenAddress.slice(0, 8),
            wallet: walletAddress.slice(0, 8),
            mc: currentMC.toFixed(0),
            target: ruggerProfile.targetExitMC.toFixed(0),
            expectedPnl: `+${expectedPnl}%`,
            cv: ruggerProfile.cvPeak.toFixed(2),
            trainWR: `${ruggerProfile.trainWR.toFixed(0)}%`,
            tokens: ruggerProfile.tokenCount,
            timeStop: `${ruggerProfile.timeStopMin.toFixed(1)}min`,
          }, '🎯 RUGGER BUY — predictable wallet exploit');

          return {
            action: 'BUY', confidence: 0.90, percentage: 100, playbook_strategy: 'RIDE',
            reason: `🎯 RUGGER BUY — wallet ${walletAddress.slice(0,8)} (${ruggerProfile.tokenCount}t, CV=${ruggerProfile.cvPeak.toFixed(2)}, trainWR=${ruggerProfile.trainWR.toFixed(0)}%) | MC ${currentMC.toFixed(0)} → target ${ruggerProfile.targetExitMC.toFixed(0)} (+${expectedPnl}%) | timeStop ${ruggerProfile.timeStopMin.toFixed(1)}min`
          };
        }
      }
    }


        // ══════════════════════════════════════════════════════════════
    // SWARM STRATEGY v1.0 — Organic retail crowd signal
    // Backtest CARTEL (163t): buyers≥80 + avg_buy<$25 → 8 fusées +198% avg
    // Signal: masse retail (≥80 buyers, avg<$25, ratio 2.0-3.5x, T=20-90s)
    // Philosophy: not smart money, it's the crowd that makes fusées
    // ══════════════════════════════════════════════════════════════
    if (!this.openPositions.has(tokenAddress) && elapsedSec >= 20 && elapsedSec <= 90) {
      const swarmSbRatio = buyCount > 0 ? sellCount / buyCount : 0;
      // avgBuyUsd = buyVol (USD) / buyCount
      const swarmAvgBuy = buyCount > 0 ? buyVol / buyCount : 999;
      if (
        uniqueBuyerCount >= 80 &&          // masse retail
        swarmAvgBuy < 25 &&               // petits acheteurs ($25 avg = retail, not whale)
        mcRatio >= 2.0 && mcRatio <= 3.5 && // pompe confirmée mais pas surachetée
        currentMC < 12000 &&              // encore tôt
        swarmSbRatio < 0.4                // peu de pression vendeuse
      ) {
        if (swarmCount >= MAX_SWARM) {
          return this.none(`🚫 SWARM pool full (${swarmCount}/${MAX_SWARM})`, 'RIDE');
        }
        if (this.openPositions.size >= 7) {
          return this.none('🚫 Total pool full — skip', 'RIDE');
        }
        const swarmPos = 0.35; // slightly larger than STD min — crowd signal = higher conviction
        this.lastBuyTimestamp = Date.now();
        this.openPositions.set(tokenAddress, {
          entryMC: currentMC, entryTime: new Date(), highestMC: currentMC, lowestMCAfterEntry: currentMC,
          tradeCount: 0, walletAddress, peakTime: Date.now(), hadSignificantPump: false,
          entryBuyVol: buyVol, entryBuyCount: buyCount, entryBuyerCount: uniqueBuyerCount,
          entrySellersCount: sellCount, staleTicks: 0, ceilingHigh: currentMC,
          pumpPeaks: [], pumpState: 'PUMP' as const, cycleHigh: currentMC, dipLow: currentMC,
          tickMCs: [currentMC], confirmationDone: true, swarmStrategy: true,
        });
        logger.info({ token: tokenAddress.slice(0,8), buyers: uniqueBuyerCount, avgBuy: swarmAvgBuy.toFixed(0), ratio: mcRatio.toFixed(2), mc: currentMC.toFixed(0) }, '🐝 SWARM BUY');
        return {
          action: 'BUY', confidence: 0.82, percentage: 100, playbook_strategy: 'RIDE',
          wallet_risk_score: 0.3, position_sol: swarmPos,
          reason: `🐝 SWARM v1.0 BUY — ${uniqueBuyerCount}b avg=$${swarmAvgBuy.toFixed(0)} ${mcRatio.toFixed(2)}x ${elapsedSec.toFixed(0)}s | sb=${swarmSbRatio.toFixed(2)} mc=$${currentMC.toFixed(0)} pos=${swarmPos}SOL`
        };
      }
    }



    // ══════════════════════════════════════════════════════════════
    if (!this.openPositions.has(tokenAddress) && elapsedSec >= 2 && elapsedSec <= 120) {
      const cartelSignal = this.cartelDetector.getSignal(tokenAddress);
      if (cartelSignal && (cartelSignal.eliteWalletCount >= 2 || cartelSignal.goodWalletCount >= 5)) {
        // No circuit breaker for CARTEL — independent signal, not affected by STD/NEO HS

        // FADE block
        const wRisk = this.rideCache.get(tokenAddress)?.walletRiskScore ?? 0.5;
        if (wRisk >= 0.65) {
          return this.none(`🚫 CARTEL: FADE risk=${wRisk.toFixed(2)}`, 'RIDE');
        }

        // Max concurrent cartel positions
        const cartelCount = Array.from(this.openPositions.values()).filter(p => p.cartelStrategy).length;
        if (cartelCount >= 3) {
          return this.none(`🚫 CARTEL: max 3 concurrent positions`, 'RIDE');
        }

        const cartelPos = cartelSignal.positionSol;

        this.lastBuyTimestamp = Date.now();
        this.openPositions.set(tokenAddress, {
          entryMC: currentMC,
          entryTime: new Date(),
          highestMC: currentMC,
          lowestMCAfterEntry: currentMC,
          tradeCount: 0,
          walletAddress,
          peakTime: Date.now(),
          hadSignificantPump: false,
          entryBuyVol: buyVol,
          entryBuyCount: buyCount,
          entryBuyerCount: uniqueBuyerCount,
          entrySellersCount: state?.uniqueSellers?.size || 0,
          staleTicks: 0,
          ceilingHigh: currentMC,
          pumpPeaks: [],
          pumpState: 'PUMP' as const,
          cycleHigh: currentMC,
          dipLow: currentMC,
          tickMCs: [currentMC],
          confirmationDone: false,
          cartelStrategy: true,
        });

        return {
          action: 'BUY', confidence: cartelSignal.confidence, percentage: 100, playbook_strategy: 'RIDE',
          wallet_risk_score: wRisk,
          position_sol: cartelPos,
          quality_score: cartelSignal.goodWalletCount,
          reason: `🤝 CARTEL v1.2 BUY — ${cartelSignal.goodWalletCount} good wallets | ${mcRatio.toFixed(2)}x ${elapsedSec.toFixed(0)}s | ${uniqueBuyerCount}b pos=${cartelPos}SOL`
        };
      }
    }

        // NEO v4 STRATEGY — Live-tuned from 14 real trades
    // Winners: topH≤12%, dumps≤14, sr≤0.44, Q1+ (5/5 win)
    // Losers: Q0 garbage (3/3 lost), topH≥13% OR dumps≥15
    // Key insight: Q0 = no edge, Q1+ = 62.5%+ WR with avg +29%
    // Exit: HS -15%, Trail 15% after +30% peak (unchanged, working well)
    // ══════════════════════════════════════════════════════════════
    if (mcRatio >= 1.5 && mcRatio < 2.0 && elapsedSec >= 15 && elapsedSec <= 120 && !this.openPositions.has(tokenAddress)) { // v4.53: ratio 1.3→1.5 (1.3-1.5 bucket = -1.6% avg on 141t, major drag)
      const neoTopH = state?.largestHolderPct || 0;
      const neoDumps = state?.totalDumpSells || 0;
      const neoSellers = state?.uniqueSellers?.size || 0;
      const neoBuyers = uniqueBuyerCount;
      const neoSellRatio = neoBuyers > 0 ? neoSellers / neoBuyers : 1;
      const neoAvgBuy = state?.avgBuySize || 0;
      const neoRecentBuys = (state?.buyTimestamps || []).filter((t: number) => Date.now() - t < 30000).length;
      const neoVelocity = neoRecentBuys / 0.5; // buys per minute in last 30s
      
      // NEO v4.22 — gate wider: th0.15→0.20 md18→25. DB score 29122→41364 (+42%). WR=82.8% avg=58.7% n=705.
      // Gate unchanged: sr=0.40 th=0.12 mb=25 md=15 (still optimal entry params)
      // Gate 1: Basic quality
      if (neoBuyers >= 20 && neoSellRatio <= 0.44 && neoTopH <= 0.20 && neoDumps <= 25) { // v4.22: gate th0.15→0.20 md18→25 (DB: score 29122→41364 +42%). WR=82.8% avg=58.7% n=705
        
        // Circuit breaker
        if (this.circuitBreakerUntil && Date.now() < this.circuitBreakerUntil) {
          const remainMin = ((this.circuitBreakerUntil - Date.now()) / 60000).toFixed(1);
          return this.none(`🛑 NEO CB — pause ${remainMin}min`, 'RIDE');
        }
        if (this.circuitBreakerUntil && Date.now() >= this.circuitBreakerUntil) {
          this.circuitBreakerUntil = null;
          this.consecutiveHardStops = 0;
        }
        
        // FADE block — threshold raised 0.50→0.65 (default 0.5 was blocking all unknown wallets)
        // DB: 76.9% of wallets score <0.65, only 38.3% score <0.50. Allows unknowns through.
        const wRisk = this.rideCache.get(tokenAddress)?.walletRiskScore ?? 0.5;
        if (wRisk >= 0.65) {
          return this.none(`🚫 NEO: FADE risk=${wRisk.toFixed(2)}`, 'RIDE');
        }
        
        // Q-Score: 4 signals of organic quality
        let neoQ = 0;
        if (neoAvgBuy > 0 && neoAvgBuy <= 10) neoQ++;   // Micro-retail buys (v4.17: tightened $25→$15; DB ≤$10 = 89.8%WR/+74.9% vs $10-25 = 78%/+55.3%)
        if (neoDumps <= 10) neoQ++;                        // v4.18: Q dump criterion ≤10 (tighter than gate 15, rewards cleaner tokens)
        if (neoTopH <= 0.08) neoQ++;                       // No whale concentration
        if (neoSellRatio <= 0.25) neoQ++;                  // Tight sell ratio signal (still 0.25 for Q, gate at 0.35)
        
        // BLOCK Q0-Q2 entries — v4.48: Q1=-1.8% avg 261t, Q2=-2.6% avg 209t (Raph approved block 2026-03-26)
        if (neoQ <= 2) {
          return this.none(`🚫 NEO v4.48: Q${neoQ} blocked (Q0-Q2 losing) — sr=${neoSellRatio.toFixed(2)} topH=${(neoTopH*100).toFixed(0)}% dumps=${neoDumps} avgBuy=$${neoAvgBuy.toFixed(0)}`, 'RIDE');
        }
        
        // Aggressive sizing: Q1+ proven winners, scale up with quality
        // Q1=0.20, Q2=0.35, Q3=0.55, Q4=0.65 (v4.3: more aggressive on high conviction; WR=84.8% supports it)
        const neoQSizing: Record<number, number> = { 1: 0.10, 2: 0.25, 3: 0.25, 4: 0.50 }; // v4.50: Q3 0.35→0.25 (marginal trades drain fees) — Q4 still 0.50
        const neoPos = neoQSizing[neoQ] || 0.20;
        
        this.lastBuyTimestamp = Date.now();
        this.openPositions.set(tokenAddress, {
          entryMC: currentMC,
          entryTime: new Date(),
          highestMC: currentMC,
          lowestMCAfterEntry: currentMC,
          tradeCount: 0,
          walletAddress,
          peakTime: Date.now(),
          hadSignificantPump: false,
          entryBuyVol: buyVol,
          entryBuyCount: buyCount,
          entryBuyerCount: uniqueBuyerCount,
          entrySellersCount: neoSellers,
          staleTicks: 0,
          ceilingHigh: currentMC,
          pumpPeaks: [],
          pumpState: 'PUMP' as const,
          cycleHigh: currentMC,
          dipLow: currentMC,
          tickMCs: [currentMC],
          confirmationDone: false,
          neoStrategy: true,
        });
        
        return {
          action: 'BUY', confidence: 0.95, percentage: 100, playbook_strategy: 'RIDE',
          wallet_risk_score: wRisk,
          position_sol: neoPos,
          quality_score: neoQ,
          reason: `🧠 NEO v4.53 BUY Q${neoQ} — ${neoBuyers}b ${neoSellers}s sr=${neoSellRatio.toFixed(2)} vel=${neoVelocity} | ${mcRatio.toFixed(2)}x ${elapsedSec.toFixed(0)}s | topH=${(neoTopH*100).toFixed(0)}% dumps=${neoDumps} avgBuy=$${neoAvgBuy.toFixed(0)} pos=${neoPos}SOL`
        };
      }
    }

    // ═══════════════════════════════════════════════════════════

    // Phase 1 (T+0-30s): OBSERVE    // Phase 1 (T+0-30s): OBSERVE — accumulate buyer data
    if (elapsedSec < 30) {
      // v10.10j: Prefetch funder during OBSERVE (async, non-blocking)
      if (walletAddress && uniqueBuyerCount >= 5) {
        this.funderLookup.prefetch(walletAddress);
      }
      if (uniqueBuyerCount >= 5) {
        return this.none(`👁️ v10 OBSERVE (${elapsedSec.toFixed(0)}s/30s) — ${uniqueBuyerCount} buyers, $${buyVol.toFixed(0)} vol, ${mcRatio.toFixed(1)}x`, 'RIDE');
      }
      return this.none(`👁️ v10 OBSERVE (${elapsedSec.toFixed(0)}s)`, 'RIDE');
    }



    // ══════════════════════════════════════════════════════════════
    // EARLY ENTRY (v10.11) — enter at ratio 1.2x with 50+ buyers
    // DB backtest: 9703 tokens, WR 81%, avg net +130% vs standard 59% WR, +60%
    // Key insight: waiting for 2.0x ratio loses 2.3x MC inflation → most upside gone
    // ══════════════════════════════════════════════════════════════
    if (false && mcRatio >= 1.2) {
      const earlyTopH = state?.largestHolderPct || 0;
      const earlyDumps = state?.totalDumpSells || 0;
      const earlyAvgBuy = state?.avgBuySize || 0;
      
      // Hard blocks still apply
      if (earlyTopH > 0.15) {
        return this.none(`🚫 EARLY: topHolder ${(earlyTopH*100).toFixed(0)}% > 15%`, 'RIDE');
      }
      
      // v10.11b: Buy/Sell ratio filter — DB: bsr>=1.2 + tb<=8% = 85% WR, +215% net
      const earlyBSR = sellCount > 0 ? buyCount / sellCount : 99;
      if (earlyBSR < 1.2) {
        return this.none(`🚫 EARLY: buy/sell ratio ${earlyBSR.toFixed(2)} < 1.2`, 'RIDE');
      }
      
      // CB removed for EARLY — Raph decision 2026-03-22
      
      // Quality score at 50 buyers (same metrics, slightly relaxed thresholds)
      let earlyQ = 0;
      if (earlyAvgBuy <= 30) earlyQ++;
      if (earlyDumps <= 12) earlyQ++;
      if (earlyTopH <= 0.08) earlyQ++;
      if (buyVol <= 2000) earlyQ++;
      
      // Minimum quality: Q2+ required for early entry (stricter filter to compensate less data)
      if (earlyQ < 1) {
        return this.none(`⏳ EARLY: Q${earlyQ} < 2 — not enough quality for early entry`, 'RIDE');
      }
      
      // FADE wallet block
      const wRisk = this.rideCache.get(tokenAddress)?.walletRiskScore ?? 0.5;
      if (wRisk >= 0.50) {
        return this.none(`🚫 EARLY: FADE wallet risk=${wRisk.toFixed(2)}`, 'RIDE');
      }
      
      // Position sizing: same formula but cap at 0.3 SOL for early (more risk)
      const riskBase = 0.5 - wRisk * 0.4;
      const qualityMultiplier = [0.3, 0.5, 0.7, 0.9, 1.0][earlyQ];
      const earlyPos = Math.round(Math.min(0.30, Math.max(0.10, riskBase * qualityMultiplier)) * 100) / 100;
      
      this.lastBuyTimestamp = Date.now();
      this.openPositions.set(tokenAddress, {
        entryMC: currentMC,
        entryTime: new Date(),
        highestMC: currentMC,
        lowestMCAfterEntry: currentMC,
        tradeCount: 0,
        walletAddress,
        peakTime: Date.now(),
        hadSignificantPump: false,
        entryBuyVol: buyVol,
        entryBuyCount: buyCount,
        entryBuyerCount: uniqueBuyerCount,
        entrySellersCount: state?.uniqueSellers?.size || 0,
        staleTicks: 0,
        ceilingHigh: currentMC,
        pumpPeaks: [],
        pumpState: 'PUMP' as const,
        cycleHigh: currentMC,
        dipLow: currentMC,
        tickMCs: [currentMC],
        confirmationDone: false,
        earlyStrategy: true,
      });
      
      return {
        action: 'BUY', confidence: 0.90, percentage: 100, playbook_strategy: 'RIDE',
        wallet_risk_score: wRisk,
        position_sol: earlyPos,
        quality_score: earlyQ,
        reason: `⚡ v10.11 EARLY BUY Q${earlyQ} — ${uniqueBuyerCount} buyers, $${buyVol.toFixed(0)} vol, ${mcRatio.toFixed(1)}x base | ${elapsedSec.toFixed(0)}s | dumps=${earlyDumps} topH=${(earlyTopH*100).toFixed(0)}% avgBuy=$${earlyAvgBuy.toFixed(0)} risk=${wRisk.toFixed(2)} pos=${earlyPos}SOL`
      };
    }

    // Phase 2 (T+30-90s): EVALUATE — standard entry (fallback if early entry didn't trigger)
    const MIN_BUYERS = 70; // v10.10k: lowered from 80 to collect data on 70-79 range // v10.10g: backtest 1711t — b>=80 net +2.4%, wallet 13.43
    const MIN_VOL = 1000;

    // Minimum MC ratio 2.0x for standard entry
    if (mcRatio < 2.0) { // v10.10: reverted to 2.0 (backtest: baseline wins)
      if (elapsedSec > 60) {
        return this.none(`💀 v10: ratio ${mcRatio.toFixed(2)}x < 2.0x after ${elapsedSec.toFixed(0)}s — no momentum`, 'RIDE');
      }
      return this.none(`⏳ v10: ratio ${mcRatio.toFixed(2)}x < 2.0x — waiting for momentum`, 'RIDE');
    }

    // Max MC ratio 2.6x
    if (mcRatio > 3.0) { // v10.10h: extended from 2.6
      return this.none(`🚫 v10: ratio ${mcRatio.toFixed(1)}x > 3.0x — trop cher`, 'RIDE');
    }

    // Token must have shown movement during observe
    const spikeMC = state?.highestMC ?? currentMC;
    const hasShownLife = spikeMC > baselineMC * 1.05;
    if (!hasShownLife && elapsedSec < 60) {
      return this.none(`⏳ v10: flat token (spike ${(spikeMC/baselineMC).toFixed(2)}x) — waiting`, 'RIDE');
    }
    if (!hasShownLife && elapsedSec >= 90) {
      return this.none(`💀 v10: never moved >5% in ${elapsedSec.toFixed(0)}s — dead`, 'RIDE');
    }

    // Hard requirement: unique buyer wallets
    if (uniqueBuyerCount < MIN_BUYERS) {
      if (elapsedSec > 90) {
        return this.none(`💀 v10: ${uniqueBuyerCount}/${MIN_BUYERS} buyers after ${elapsedSec.toFixed(0)}s — dead`, 'RIDE');
      }
      return this.none(`⏳ v10: ${uniqueBuyerCount}/${MIN_BUYERS} buyers — waiting`, 'RIDE');
    }

    // Hard requirement: buy volume
    if (buyVol < MIN_VOL) {
      if (elapsedSec > 90) {
        return this.none(`💀 v10: vol $${buyVol.toFixed(0)}/${MIN_VOL} after ${elapsedSec.toFixed(0)}s — dead`, 'RIDE');
      }
      return this.none(`⏳ v10: vol $${buyVol.toFixed(0)}/$${MIN_VOL} — waiting`, 'RIDE');
    }

    // Entry window: max 120s (was 90s — US peak hours need more time)
    if (elapsedSec > 110) {
      return this.none(`⏰ v10: too late (${elapsedSec.toFixed(0)}s > 110s)`, 'RIDE');
    }

//    // Anti-cascade: if sells dominate, skip
//    if (sellCount > buyCount * 0.8 && sellCount > 5) {
//      return this.none(`📉 v10: sell pressure ${sellCount}s/${buyCount}b — skip`, 'RIDE');
//    }

    // Compute confidence tier
    // v10.10h: Raised cap 100→150 — RT-TRAIL handles volatile tokens better now
    if (uniqueBuyerCount > 150) {
      return this.none(`🚫 v10: ${uniqueBuyerCount} buyers > 150 — hype peak, skip`, 'RIDE');
    }
    const tier = uniqueBuyerCount >= 50 ? 'HIGH' : uniqueBuyerCount >= 30 ? 'MID' : 'BASE';
    const confidence = tier === 'HIGH' ? 0.95 : tier === 'MID' ? 0.90 : 0.85;

    // v10.10g: ENTRY FILTER — backtest 1711t: b>=80 + d<30 = wallet 13.43 (+34%)
    // v10.11: Tightened dumps gate 30→21 (paper: dumps>20 = 131t WR 35% avg -3.5% vs dumps 13-20 = 29t WR 66% avg +6.6%)
    const totalDumps = state?.totalDumpSells || 0;
    if (totalDumps >= 30) {
      return this.none(`🚫 v10.11: ${totalDumps} dumps >= 30 — distribution, skip`, 'RIDE');
    }

    // v10.10i: avgBuy filter — high avg buy = whale/insider manipulation, not organic demand
//    // Data: avgBuy<=25 → 16 trades, WR 68.8%, +408% total, 0 wins lost
//    const avgBuySize = state?.avgBuySize || 0;
//    if (avgBuySize > 30) {
//      return this.none(`🚫 v10.10i: avgBuy $${avgBuySize.toFixed(0)} > $30 — whale activity, skip`, 'RIDE');
//    }

    // v10.9: MOMENTUM CONFIRMATION — price must be rising in last 3 ticks
    const mcs = state?.recentMCs || [];
    if (mcs.length >= 5) {
      const last5 = mcs.slice(-5);
      const isRising = last5[1] > last5[0] && last5[2] > last5[1] && last5[3] > last5[2] && last5[4] > last5[3];
      const momentumPct = ((last5[4] - last5[0]) / last5[0]) * 100;
      if (!isRising || momentumPct < 3.0) {
        return this.none(`⏸️ v10.9: no momentum (${momentumPct.toFixed(1)}%, rising=${isRising}) — waiting`, 'RIDE');
      }
    } else if (mcs.length < 5) {
      return this.none(`⏸️ v10.9: need 5 ticks for momentum (have ${mcs.length})`, 'RIDE');
    }

    // v10.9.9: Cooldown removed — max concurrent (2) handles frequency naturally

    // ✅ v10.9.2 BUY — market validated + momentum confirmed
    this.lastBuyTimestamp = Date.now();
    this.openPositions.set(tokenAddress, {
      entryMC: currentMC,
      entryTime: new Date(),
      highestMC: currentMC,
      lowestMCAfterEntry: currentMC,
      tradeCount: 0,
      walletAddress,
      peakTime: Date.now(),
      hadSignificantPump: false,
      entryBuyVol: buyVol,
      entryBuyCount: buyCount,
      entryBuyerCount: uniqueBuyerCount,
    entrySellersCount: state?.uniqueSellers?.size || 0,
      staleTicks: 0,
      ceilingHigh: currentMC,
    pumpPeaks: [],
          pumpState: 'PUMP' as const,
          cycleHigh: currentMC,
          dipLow: currentMC,
        tickMCs: [currentMC],
          confirmationDone: false,
        });

    logger.info({
      token: tokenAddress.slice(0, 8),
      buyers: uniqueBuyerCount,
      vol: buyVol.toFixed(0),
      mc: currentMC.toFixed(0),
      ratio: mcRatio.toFixed(2),
      tier,
      elapsed: elapsedSec.toFixed(0),
    }, '🚀 v10 BUY — market validated');

    // v10.10k: Quality score (0-4) from early market microstructure
    const avgBuySize = state?.avgBuySize || 0;
    const qDumps = state?.totalDumpSells || 0;
    const topHolderPct = state?.largestHolderPct || 0;
    // v10.10k: Hard block topHolder > 12% — 73% HS rate, saves +2.0 SOL
    if (topHolderPct > 0.12) {
      return { action: 'NONE', confidence: 0, percentage: 0, reason: `🚫 topHolder ${(topHolderPct*100).toFixed(0)}% > 12% — whale concentration block` };
    }
    let qualityScore = 0;
    if (avgBuySize <= 25) qualityScore++;
    if (qDumps <= 18) qualityScore++;
    if (topHolderPct <= 0.10) qualityScore++;
    if (buyVol <= 2500) qualityScore++;

    // v10.10k: Combined position sizing — wallet risk × quality score
    // Wallet risk base: 0.5 - (risk × 0.4) → 0.1-0.5 SOL
    // Quality multiplier: score 0→0.3, 1→0.5, 2→0.7, 3→0.9, 4→1.0
    const wRisk = this.rideCache.get(tokenAddress)?.walletRiskScore ?? 0.5;
    const riskBase = 0.5 - wRisk * 0.4; // 0.1-0.5
    const qualityMultiplier = [0.3, 0.5, 0.7, 0.9, 1.0][qualityScore];
    const riskPositionSol = Math.round(Math.min(0.50, Math.max(0.30, riskBase * qualityMultiplier)) * 100) / 100;

    logger.info({
      token: tokenAddress.slice(0, 8),
      qualityScore,
      avgBuy: avgBuySize.toFixed(0),
      dumps: qDumps,
      topH: (topHolderPct * 100).toFixed(0) + '%',
      vol: buyVol.toFixed(0),
      wRisk: wRisk.toFixed(2),
      riskBase: riskBase.toFixed(2),
      qMult: qualityMultiplier.toFixed(1),
      position: riskPositionSol,
    }, '🎯 v10.10k Quality Score');

    // v10.10k Circuit Breaker
    if (this.circuitBreakerUntil && Date.now() < this.circuitBreakerUntil) {
      const remainMin = ((this.circuitBreakerUntil - Date.now()) / 60000).toFixed(1);
      return { action: 'NONE', confidence: 0, percentage: 0, reason: `🛑 CIRCUIT BREAKER — pause ${remainMin}min` };
    }
    if (this.circuitBreakerUntil && Date.now() >= this.circuitBreakerUntil) {
      console.log(`✅ Circuit breaker lifted — resuming trading`);
      this.circuitBreakerUntil = null;
      this.consecutiveHardStops = 0;
    }
    return {
      action: 'BUY', confidence, percentage: 100, playbook_strategy: 'RIDE',
      wallet_risk_score: wRisk,
      position_sol: riskPositionSol,
      quality_score: qualityScore,
      reason: `${closedInfo ? "🔄 RE-ENTRY" : "🚀"} v10.14 BUY [${tier}] Q${qualityScore} — ${uniqueBuyerCount} buyers, $${buyVol.toFixed(0)} vol, ${mcRatio.toFixed(1)}x base | ${elapsedSec.toFixed(0)}s | momentum ✓ | dumps=${qDumps} sells=${sellCount}/${buyCount} avgBuy=$${avgBuySize.toFixed(0)} avgSell=$${(state?.avgSellSize || 0).toFixed(0)} topHolder=${(topHolderPct*100).toFixed(0)}% peak=${(state?.highestMC || currentMC).toFixed(0)} risk=${wRisk.toFixed(2)} Q=${qualityScore}×${qualityMultiplier.toFixed(1)} pos=${riskPositionSol}SOL`
    };
  }


  // v10.10h: Save live snapshot to DB for every evaluation
  async saveSnapshot(tokenAddress: string, elapsedSec: number, currentMC: number, signal: { action: string; reason?: string }): Promise<void> {
    try {
      const state = this.liveState.get(tokenAddress);
      
      const buyCount = state?.buyCount || 0;
      const sellCount = state?.sellCount || 0;
      const uniqueBuyers = state?.uniqueBuyers?.size || 0;
      const uniqueSellers = state?.uniqueSellers?.size || 0;
      const buyVol = state?.buyVol || 0;
      const sellVol = state?.sellVol || 0;
      const netFlow = buyVol - sellVol;
      const avgBuySize = state?.avgBuySize || 0;
      const avgSellSize = state?.avgSellSize || 0;
      const topHolderPct = state?.largestHolderPct || 0;
      const repeatBuyerCount = state?.repeatBuyers?.size || 0;
      const totalDumps = state?.totalDumpSells || 0;
      const sellRatio = sellCount / Math.max(buyCount + sellCount, 1);
      const bondingCurve = state?.bondingCurvePct || 0;
      
      // Buy velocity: buyers in last 30s (approximate from timestamps)
      const now = Date.now();
      const recentBuys = (state?.buyTimestamps || []).filter((t: number) => now - t < 30000).length;
      const buyVelocity30s = recentBuys / 0.5; // per minute
      
      // MC ratio
      const baselineMC = currentMC / Math.max(state?.highestMC || currentMC, 1) * (state?.highestMC || currentMC);
      // Approximate: ratio = currentMC / (initial MC guess from first few ticks)
      const mcs = state?.recentMCs || [];
      const firstMC = mcs.length > 0 ? mcs[0] : currentMC;
      const mcRatio = firstMC > 0 ? currentMC / firstMC : 1;
      
      // Momentum: last 5 ticks
      let momentumPct = 0;
      if (mcs.length >= 5) {
        const last5 = mcs.slice(-5);
        momentumPct = ((last5[4] - last5[0]) / Math.max(last5[0], 1)) * 100;
      }
      
      // Only save every 3rd tick for NONE actions to reduce DB load
      // Always save BUY/SELL
      if (signal.action === "NONE") {
        const tickCount = mcs.length;
        if (tickCount % 3 !== 0) return;
      }
      
      await this.pool.query(
        `INSERT INTO token_snapshots (
          token_address, snapshot_at, elapsed_sec, mc_live, source,
          unique_buyers, unique_sellers, buy_vol_live, sell_vol_live, net_flow,
          avg_buy_size, avg_sell_size, top_holder_pct, repeat_buyer_count,
          total_dumps, sell_ratio, buy_velocity_30s, mc_ratio,
          bonding_curve_pct, momentum_pct, trade_action, action_reason
        ) VALUES (
          $1, NOW(), $2, $3, 'live',
          $4, $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18, $19, $20
        )`,
        [
          tokenAddress, elapsedSec, currentMC,
          uniqueBuyers, uniqueSellers, buyVol, sellVol, netFlow,
          avgBuySize, avgSellSize, topHolderPct, repeatBuyerCount,
          totalDumps, sellRatio, buyVelocity30s, mcRatio,
          bondingCurve, momentumPct, signal.action, (signal.reason || '').slice(0, 200)
        ]
      );
    } catch (err) {
      logger.error({ err }, 'saveSnapshot error');
    }
  }

  private async getWalletHistoricalWR(walletAddress: string): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT COUNT(*) as total,
          COUNT(*) FILTER(WHERE peak_mc / NULLIF(fdv_at_detection, 0) >= 1.5) as pumps
        FROM token_events
        WHERE creator_wallet = $1 AND fdv_at_detection > 0 AND peak_mc > 0
      `, [walletAddress]);
      const total = parseInt(result.rows[0].total) || 0;
      const pumps = parseInt(result.rows[0].pumps) || 0;
      return total > 0 ? (pumps / total) * 100 : 0;
    } catch { return 0; }
  }

  /** Count tokens created by wallet in last N hours */
  private async getWalletSpamCount(walletAddress: string, hoursBack: number = 2): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT COUNT(*) as cnt FROM token_events
        WHERE creator_wallet = $1 AND detected_at > NOW() - INTERVAL '1 hour' * $2
      `, [walletAddress, hoursBack]);
      return parseInt(result.rows[0].cnt) || 0;
    } catch { return 0; }
  }

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────

  /** Store funder relationship in wallet_ancestry table */
  private async storeAncestry(childWallet: string, funder: { funder: string; amountSol: number; confidence: number }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO wallet_ancestry (parent_wallet, child_wallet, funding_tx_hash, funding_amount_sol, depth, confidence)
         VALUES ($1, $2, 'rpc-lookup', $3, 0, $4)
         ON CONFLICT (parent_wallet, child_wallet) DO NOTHING`,
        [funder.funder, childWallet, funder.amountSol, funder.confidence]
      );
    } catch { /* non-critical */ }
  }

  private none(reason: string, strategy?: 'RIDE'|'FADE'|'WATCH'|'AVOID'): TradeSignal {
    return { action: 'NONE', confidence: 0, reason, playbook_strategy: strategy };
  }

  private sell(pct: number, confidence: number, strategy: 'RIDE', reason: string, signals: SignalBreakdown): TradeSignal {
    return { action: 'SELL', confidence, percentage: pct, reason, playbook_strategy: strategy, signals };
  }

  private emptySignals(): SignalBreakdown {
    return { timing_score: 0, momentum_score: 0, consistency_score: 0, risk_score: 0, wallet_score: 0 };
  }

  private closePosition(tokenAddress: string, lastKnownMC?: number): void {
    const pos = this.openPositions.get(tokenAddress);
    if (pos) {
      const holdSec = (Date.now() - pos.entryTime.getTime()) / 1000;
      let exitMC = lastKnownMC || pos.lowestMCAfterEntry || pos.entryMC;
      
      // v10.13: If token peaked above trail trigger but never trailed (WS gap),
      // simulate trail exit instead of closing at current (crashed) MC
      const peakPnl = (pos.highestMC - pos.entryMC) / pos.entryMC * 100;
      const trailTrigger = pos.neoStrategy ? 25 : (pos.cartelStrategy ? 30 : 50);
      if (peakPnl > trailTrigger && !lastKnownMC) {
        // Token should have trailed — estimate exit at peak - default trail drop
        const trailDrop = pos.neoStrategy ? 0.15 : 0.20;
        const simulatedExitMC = pos.highestMC * (1 - trailDrop);
        logger.warn({ token: tokenAddress.slice(0,8), peakPnl: peakPnl.toFixed(0), simulatedMC: simulatedExitMC.toFixed(0) },
          '⚠️ TRACKING_END with missed trail — simulating trail exit');
        exitMC = simulatedExitMC;
      }
      
      const pnl = ((exitMC - pos.entryMC) / pos.entryMC * 100);
      logger.info({
        token: tokenAddress.slice(0, 8),
        wallet: pos.walletAddress.slice(0, 8),
        entryMC: pos.entryMC.toFixed(0),
        exitMC: exitMC.toFixed(0),
        highMC: pos.highestMC.toFixed(0),
        holdSec: holdSec.toFixed(0),
        pnl: pnl.toFixed(1) + '%'
      }, '🔴 POSITION CLOSED — logging SELL');
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'TRACKING_END', exitMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: 99 });
      this.consecutiveHardStops = 0; // CB reset

      // v10.10c: Log SELL to paper-trades so no orphan BUYs
      this.onSweepClose(tokenAddress, this.sell(100, 1.0, 'RIDE',
        `🔒 TRACKING END — P&L ${pnl.toFixed(1)}% | peak +${((pos.highestMC - pos.entryMC) / pos.entryMC * 100).toFixed(0)}% | ${holdSec.toFixed(0)}s`,
        this.emptySignals()), exitMC);
    }
    this.firstMC.delete(tokenAddress);
    this.liveState.delete(tokenAddress);
    this.priceHistory.delete(tokenAddress);
  }

  closePositionIfOpen(tokenAddress: string, lastMC?: number): void {
    if (this.openPositions.has(tokenAddress)) {
      const pos = this.openPositions.get(tokenAddress)!;
      const mc = lastMC || pos.lowestMCAfterEntry || pos.entryMC || 0;
      // v10.10d: Force a proper SELL via evaluateHold logic before tracking ends
      const pnl = (mc - pos.entryMC) / pos.entryMC * 100;
      const peakPnl = (pos.highestMC - pos.entryMC) / pos.entryMC * 100;
      logger.info({ token: tokenAddress.slice(0, 8), pnl: pnl.toFixed(1), peak: peakPnl.toFixed(0), mc: mc.toFixed(0) },
        '🔒 TRACKING END — force selling open position');
      this.closePosition(tokenAddress, mc);
    }
    this.firstMC.delete(tokenAddress);
    this.liveState.delete(tokenAddress);
  }

  hasPosition(tokenAddress: string): boolean {
    return this.openPositions.has(tokenAddress);
  }

  getOpenPositionTokens(): string[] {
    return [...this.openPositions.keys()];
  }
}
