import type { Pool } from 'pg';
import type { RuggerPlaybook } from '../types/index.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { FunderLookup } from '../api/FunderLookup.js';
import { CartelDetector } from './CartelDetector.js';
import { logger } from '../utils/logger.js';
import { getRuntimeConfig } from '../utils/runtimeConfig.js';
import { getCreatorScore, getTokenDeployer, refreshCreatorScores } from '../utils/creatorScorer.js';
import { checkDeployerFunding } from '../utils/funderTracer.js';
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
  playbook_strategy?: string;
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
  cartelStrategy?: boolean;    // CARTEL strategy flag — good wallet convergence
  earlyStrategy?: boolean;     // EARLY strategy flag
  // v10.13: 60s post-entry confirmation (STD only)
  postEntrySignal?: 'STRONG' | 'GOOD' | 'WEAK' | 'SELL_DOM';
  postEntryChecked?: boolean;  // true once 60s check done
  addOnBought?: boolean;       // true if add-on position placed on STRONG
  swarmStrategy?: boolean;     // SWARM: organic retail crowd signal
  ultraStrategy?: boolean;     // ULTRA v7: market demand filter strategy
  // ═══ 5-TIER EXIT SYSTEM: 20% at each level, trail remainder ═══
  tiersSold?: number;            // bitmask: tiers already sold (0=none, 1=T1, 3=T1+T2, 7=T1+T2+T3, 15=all4)
  tiersRemainingPct?: number;    // fraction still held (1.0 → 0.8 → 0.6 → 0.4 → 0.2)
  tierExitPnls?: number[];       // P&L% at each tier exit, for blended calculation
  pendingSellAt?: number;         // timestamp when sell signal fired (delayed execution)
  pendingSellReason?: string;     // reason at signal time
  pendingSellPnl?: number;        // P&L% at signal time
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

// WalletStrategy interface REMOVED — Creator Score + Funder Chain handle wallet quality now

/**
 * TradeExecutor v10.20 — Market Demand Engine
 *
 * Entry decisions based on market microstructure (buyers, volume, ratio, timing).
 * Wallet quality filtered by Creator Score + Funder Chain (not RIDE/FADE labels).
 */
export class TradeExecutor {
  private tokenRepo: TokenEventRepo;
  private walletRepo: WalletRepo;
  protected pool: Pool;

  protected openPositions = new Map<string, OpenPosition>();
  private lastBuyTimestamp = 0; // v10.9.2: absolute last buy time
  private firstMC = new Map<string, number>();
  public liveState = new Map<string, LiveTradeState>(); // v10.14.1: public for TokenTracker fast_verdict

  // Cache: token → { detectedAt, walletAddress, walletRiskScore }
  protected rideCache = new Map<string, {
    detectedAt: Date;
    fdvAtDetection: number;
    walletAddress: string;
    walletRiskScore: number;
  }>();
  private evaluating = new Set<string>();

  // ═══ TIER EXIT HOOK ═══
  // Override in PaperTradeExecutor to forward tier exits to LiveTradeExecutor

  /** Compute blended P&L accounting for tier exits */
  protected getBlendedPnl(pos: OpenPosition, finalPnlPct: number): number {
    const tierExits = pos.tierExitPnls || [];
    const tierSellPct = getRuntimeConfig()?.tiers?.sell_pct || 0.20;
    
    if (tierExits.length === 0) return finalPnlPct;
    
    // blended = sum(tierPnl * tierSellPct) + finalPnl * remaining
    let blended = 0;
    let allocated = 0;
    for (const tierPnl of tierExits) {
      blended += tierPnl * tierSellPct;
      allocated += tierSellPct;
    }
    const remaining = Math.max(0, 1.0 - allocated);
    blended += finalPnlPct * remaining;
    return blended;
  }

  protected onTierExit(tokenAddress: string, pctToSell: number, reason: string, currentMC: number): void {
    // no-op in base class
  }
  private closedTokens = new Map<string, { exitType: string; exitMC: number; exitTime: number; entryMC: number; peakMC: number; reentryCount: number }>();
  // v10.10k Circuit Breaker: pause after 3 consecutive hard stops
  private consecutiveHardStops = 0;
  private circuitBreakerUntil: number | null = null;
  private readonly CB_MAX_HS = 4; // v4.18: raised 2→4 (NEO needs more sample before CB fires)
  private readonly CB_PAUSE_MS = 15 * 60 * 1000; // v4.18: reduced 30min→15min pause
  public cartelDetector: CartelDetector;
  private cartelCircuitBreakerUntil = 0;     // timestamp: pause CARTEL si 3 HS consécutifs
  private cartelConsecHS = 0;                 // compteur HS consécutifs CARTEL
  private funderLookup: FunderLookup;
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
      const ws = null; // WalletStrategy removed
      // SWARM: max hold 600s (v1.1) — use dedicated limit, not wallet strategy maxHoldSec
      const isSwarmPos = pos.swarmStrategy === true;
      const maxHold = 600; // v10.20: fixed 10min max hold for all strategies
      
      // Stale: no new trades AND past max hold time
      if (!this.openPositions.has(tokenAddress)) continue;
      // v10.13: Check time since last tick (not total tick count)
      const lastTickAge = pos.peakTime ? (now - pos.peakTime) / 1000 : holdSec;
      // Only sweep if BOTH conditions: past max hold AND very few ticks (truly stale)
      const isStale = holdSec > maxHold && pos.tradeCount < 5;
      // OR: held very long (>10min) with no trades for a while — SWARM exempt (let rockets run)
      const isAbandoned = !isSwarmPos && holdSec > 600 && pos.tradeCount < 10;
      // v10.13: Token stopped receiving ticks (>5min since last tick + past max hold)
      // SWARM: no-ticks sweep requires lastTickAge > 600s (not 300s) — swarm tokens can go quiet mid-pump
      const noTicksThreshold = isSwarmPos ? 600 : 300;
      const isNoTicks = holdSec > maxHold && lastTickAge > noTicksThreshold;
      const isCartelTimeout = pos.cartelStrategy === true && holdSec > 900; // NEO v4.23: hard 15min timeout regardless of ticks
      if (isStale || isAbandoned || isCartelTimeout || isNoTicks) {
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
                this.onLiveSignal(sweepResult, tokenAddress, lastMC);
      }
    }
  }
  
  // Price history for momentum confirmation (last N ticks per token)
  private priceHistory = new Map<string, Array<{ mc: number; ts: number }>>();


  constructor(pool: Pool) {
    this.pool = pool;
    this.tokenRepo = new TokenEventRepo(pool);
    this.walletRepo = new WalletRepo(pool);
    this.funderLookup = new FunderLookup();
    this.cartelDetector = new CartelDetector(pool);
    // Init cartel detector (async)
    this.cartelDetector.init().catch((err: any) => 
      logger.error({ err }, 'Failed to init CartelDetector')
    );
  }

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
    const cascadeThresh = 5; // v10.20: fixed cascade threshold
    
    

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
      // v2.2: CARTEL bloque re-entry pendant 5min sur tout exit (trail inclus — fix same-token double entry)
      const rtCartelSignalHere = this.cartelDetector.getSignal(tokenAddress);
      const rtIsCartelCandidate = !!rtCartelSignalHere;
      const rtCartelCooldown = rtIsCartelCandidate && rtClosed && (Date.now() - rtClosed.exitTime) < 5 * 60_000;
      if ((!rtClosed || rtClosed.exitType === 'TRAIL') && !rtCartelCooldown) {
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
      
      // CARTEL DISABLED v2.3 — mécanisme sniper PumpPortal inférieur à v1.x wallet_stats
      // v2.0 stats: 46.1% WR, +1.2% avg, 44.7% HS rate vs v1.x: 57.1% WR, +13.0% avg, 29.6% HS
      // Raising sniper threshold makes it worse (3+ = 34.8% WR, -4.2% avg). Full redesign needed.
      // const cartelSig = this.cartelDetector.getSignal(tokenAddress);



      // ELITE RT check removed — replaced by SWARM (poll-based, T=20-90s)
      
      // CARTEL v2.0: Helius scan supprimé — détection via PumpPortal stream uniquement

      // RUGGER: immediate entry for qualified wallets (T+3-30s)
      const rtWallet = rtCached?.walletAddress || '';
      if (false) { // RUGGER removed
        const rProfile = null;
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
      // ═══ DELAYED EXECUTION: simulate 3s TX latency for realistic paper P&L ═══
      const TX_LATENCY_MS = (getRuntimeConfig()?.general?.paper_tx_latency_ms || 3000);
      
      // If pending sell, check if latency elapsed
      if (rtPos.pendingSellAt) {
        const elapsed = Date.now() - rtPos.pendingSellAt;
        if (elapsed < TX_LATENCY_MS) {
          return; // Still waiting — price continues to move
        }
        // Latency elapsed: sell NOW at current (delayed) MC
        const delayedPnl = ((mcUsd - rtPos.entryMC) / rtPos.entryMC) * 100;
        const originalPnl = rtPos.pendingSellPnl || 0;
        let reason = rtPos.pendingSellReason || '';
        // Update P&L in reason with delayed price
        reason = reason.replace(/P&L\s+[+-]?[\d.]+%/, `P&L ${delayedPnl >= 0 ? '+' : ''}${delayedPnl.toFixed(1)}%`);
        reason = reason.replace(/captured\s+~?[\d.]+%/, `captured ~${delayedPnl.toFixed(1)}%`);
        reason += ` | ⏱️${(elapsed/1000).toFixed(1)}s delay (signal was ${originalPnl >= 0 ? '+' : ''}${originalPnl.toFixed(1)}%)`;
        
        // Compute blended P&L with tiers
        const blendedPnl = this.getBlendedPnl(rtPos, delayedPnl);
        const tierCount = rtPos.tierExitPnls?.length || 0;
        if (tierCount > 0) {
          reason = reason.replace(/P&L\s+[+-]?[\d.]+%/, `P&L ${blendedPnl >= 0 ? '+' : ''}${blendedPnl.toFixed(1)}%`);
          reason = reason.replace(/captured\s+~?[\d.]+%/, `captured ~${blendedPnl.toFixed(1)}%`);
          reason += ` | 🔶${tierCount}T`;
        }
        
        logger.info({ 
          token: tokenAddress.slice(0, 8), 
          signalPnl: originalPnl.toFixed(1),
          delayedPnl: delayedPnl.toFixed(1),
          blendedPnl: blendedPnl.toFixed(1),
          delayMs: elapsed,
        }, '⏱️ DELAYED SELL executed after TX latency simulation');
        
        const rtSellResult = this.sell(100, 1.0, 'RIDE', reason, this.emptySignals());
        this.openPositions.delete(tokenAddress);
        const rtExitType = reason.includes('HARD_STOP') ? 'HARD_STOP' : reason.includes('RUGGER') ? 'RUGGER_TARGET' : 'TRAIL';
        this.closedTokens.set(tokenAddress, { 
          exitType: rtExitType, exitMC: mcUsd, exitTime: Date.now(), 
          entryMC: rtPos.entryMC, peakMC: rtPos.highestMC, 
          reentryCount: rtExitType === 'TRAIL' ? 0 : 99 
        });
        this.onSweepClose(tokenAddress, rtSellResult, mcUsd);
        this.onLiveSignal(rtSellResult, tokenAddress, mcUsd);
        return;
      }
      
      const rtPnl = ((mcUsd - rtPos.entryMC) / rtPos.entryMC) * 100;
      const rtHoldSec = (Date.now() - rtPos.entryTime.getTime()) / 1000;
      const rtPeakPnl = ((rtPos.highestMC - rtPos.entryMC) / rtPos.entryMC) * 100;
      const rtDropFromPeak = rtPos.highestMC > 0 ? (rtPos.highestMC - mcUsd) / rtPos.highestMC : 0;
      
      // ═══ 5-TIER EXIT: sell 20% at +30%, +60%, +100%, +200%, trail remainder ═══
      const _rc = getRuntimeConfig();
      const tierLevels = _rc?.tiers?.levels || [30, 60, 100, 200];
      const tierSellPct = _rc?.tiers?.sell_pct || 0.20;
      const tierFloorOffset = _rc?.tiers?.floor_offset_pct || 10;
      const tiersSold = rtPos.tiersSold || 0;
      let remaining = rtPos.tiersRemainingPct ?? 1.0;
      
      for (let i = 0; i < tierLevels.length; i++) {
        const tierBit = 1 << i;
        const isLastTier = i === tierLevels.length - 1;
        // Last tier: close entire remaining position (no minimum check)
        if (!(tiersSold & tierBit) && rtPnl >= tierLevels[i] && (isLastTier || remaining > tierSellPct + 0.05)) {
          rtPos.tiersSold = (rtPos.tiersSold || 0) | tierBit;
          const sellAmt = isLastTier ? remaining : tierSellPct;
          const pctToSell = sellAmt / remaining; // % of current holding to sell
          remaining -= sellAmt;
          rtPos.tiersRemainingPct = remaining;
          if (!rtPos.tierExitPnls) rtPos.tierExitPnls = [];
          rtPos.tierExitPnls.push(rtPnl);
          this.onTierExit(tokenAddress, pctToSell, `P&L +${rtPnl.toFixed(0)}% hit +${tierLevels[i]}% tier (${Math.round(remaining*100)}% left)`, mcUsd);
          // Last tier = full close → position fully exited via tiers
          if (isLastTier && remaining <= 0.01) {
            this.openPositions.delete(tokenAddress);
            this.closedTokens.set(tokenAddress, { exitType: 'TIER_FULL', exitMC: mcUsd, exitTime: Date.now(), entryMC: rtPos.entryMC, peakMC: rtPos.highestMC, reentryCount: 0 });
            this.consecutiveHardStops = 0;
            logger.info({ token: tokenAddress.slice(0,8), pnl: rtPnl.toFixed(0), tiers: tierLevels.length }, '🏆 TIER FULL CLOSE — all tiers hit');
            return; // fully closed via tier exits, no trail needed
          }
        }
      }
      
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
      const rtIsNeo = false; // NEO removed
      const rtIsCartel = rtPos.cartelStrategy === true;
      const rtIsSwarm = rtPos.swarmStrategy === true;
      const rtIsUltra = (rtPos as any).ultraStrategy === true;
      // Trail activation: lower threshold if tiers already sold (protect remaining)
      const rtTiersSold = rtPos.tiersSold || 0;
      let rtTrailTrigger = rtIsSwarm ? (_rc?.strategies?.SWARM?.trail_activate_pct || 30)
        : rtIsUltra ? 15   // ULTRA: trail activates at +15%
        : rtIsCartel ? 15
        : 15;
      if (rtTiersSold >= 1) rtTrailTrigger = Math.min(rtTrailTrigger, 15); // activate trail earlier after first tier
      if (rtPeakPnl >= rtTrailTrigger) {
        if (rtIsSwarm || rtIsUltra) {
          // SWARM/ULTRA: dynamic trail — tighter after tier exits lock in profit
          const swTiers = rtPos.tiersSold || 0;
          if (swTiers >= 15) {        // all 4 tiers sold (20% left) → very tight
            rtDropLimit = 0.06;
          } else if (swTiers >= 7) {  // 3 tiers sold (40% left) → tight  
            rtDropLimit = 0.08;
          } else if (swTiers >= 3) {  // 2 tiers sold (60% left) → medium
            rtDropLimit = 0.10;
          } else if (swTiers >= 1) {  // 1 tier sold (80% left) → moderate
            rtDropLimit = 0.13;
          } else {
            // No tiers sold yet — original dynamic trail from runtime config
            const sw = _rc?.strategies?.SWARM || {};
            const swBase = (sw.trail_base_pct || 18) / 100;
            const swMid = (sw.trail_mid_pct || 13) / 100;
            const swMidAt = sw.trail_mid_at_pct || 50;
            const swTight = (sw.trail_tight_pct || 8) / 100;
            const swTightAt = sw.trail_tight_at_pct || 200;
            rtDropLimit = rtPeakPnl >= swTightAt ? swTight : rtPeakPnl >= swMidAt ? swMid : swBase;
          }
        } else if (rtIsCartel) {
          rtDropLimit = 0.20; // CARTEL: 20% trail
        } else if (rtIsNeo) {
          const neoTiers = rtPos.tiersSold || 0;
          if (neoTiers >= 7) {        // 3+ tiers sold → tight
            rtDropLimit = 0.08;
          } else if (neoTiers >= 1) { // 1+ tiers sold → moderate
            rtDropLimit = 0.12;
          } else {
            rtDropLimit = rtPeakPnl >= 125 || rtPeakPnl < 40 ? 0.15 : 0.25;
          }
        } else if (rtSellerRatio >= 0 && rtSellerRatio <= 0.20) {
          rtDropLimit = 0.27; // v10.19: healthy → wide trail (was 0.25)
        } else if (rtSellerRatio > 0.40) {
          rtDropLimit = 0.17; // v10.19: pressure → tight trail (was 0.15)
        } else {
          // STD: tighten trail after tier exits
          const stdTiers = rtPos.tiersSold || 0;
          if (stdTiers >= 7) rtDropLimit = 0.10;       // 3+ tiers → tight
          else if (stdTiers >= 1) rtDropLimit = 0.15;   // 1+ tiers → moderate
          else rtDropLimit = 0.22;                       // no tiers → standard
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

      // 1. Tiered trailing stop — with inter-tier floor protection
      if (rtDropLimit > 0 && rtDropFromPeak > rtDropLimit) {
        // ═══ INTER-TIER FLOOR: don't trail-sell if still above last tier level ═══
        // After selling at +30%, only trail if P&L drops below +40% (+10% above tier level)
        // This lets the token breathe between tiers instead of cutting at every correction
        const tierFloors = [0, ...tierLevels.map((l: number) => l + tierFloorOffset)]; // floor = tier level + offset
        const tiersCount = [0,1,2,3,4,5].reduce((n,b) => n + (((rtPos.tiersSold || 0) >> b) & 1), 0); // popcount up to 6 tiers
        const tierFloor = tierFloors[tiersCount] || 0;
        
        if (rtPnl > tierFloor) {
          // Still above floor — suppress trail, let it ride to next tier
          // (but log for debugging)
        } else {
          const captured = ((rtPos.highestMC * (1 - rtDropLimit) - rtPos.entryMC) / rtPos.entryMC * 100).toFixed(1);
          rtReason = `⚡ RT-TRAIL — drop -${(rtDropFromPeak*100).toFixed(0)}%>${(rtDropLimit*100).toFixed(0)}% from peak +${rtPeakPnl.toFixed(0)}% | captured ~${captured}% | sellers ${rtSellerRatio >= 0 ? (rtSellerRatio*100).toFixed(0)+'%' : 'n/a'}`;
          rtShouldSell = true;
          this.consecutiveHardStops = 0;
        }
      }
      
      // 1b. SWARM max hold 600s (RT) — exempt if actively rising (v1.2: let rockets run)
      if (!rtShouldSell && rtIsSwarm && rtHoldSec > 600) {
        const rtStillRising = rtPnl > 50 && rtDropFromPeak < 0.05; // >+50% P&L AND within 5% of peak
        if (rtStillRising) {
          // Token actively pumping — skip MAX_HOLD, trail will handle exit
        } else {
          rtReason = `⚡ RT-SWARM_MAX_HOLD 600s — pnl=${rtPnl.toFixed(1)}% | MC ${mcUsd.toFixed(0)}`;
          rtShouldSell = true;
          this.consecutiveHardStops = 0;
        }
      }

      // 2. Hard stop (NEO: -20% v4.59 was -25%, others: -20%)
      const rtHsThreshold = _rc?.general?.hard_stop_pct || -20; // SWARM -20%, NEO -20% (v4.59: aligned with STD), STD -20%
      if (!rtShouldSell && rtPnl <= rtHsThreshold) {
        rtReason = `⚡ RT-HARD_STOP — P&L ${rtPnl.toFixed(1)}% (threshold ${rtHsThreshold}%) | MC ${mcUsd.toFixed(0)}`;
        this.consecutiveHardStops++;
        if (this.consecutiveHardStops >= this.CB_MAX_HS) {
          this.circuitBreakerUntil = Date.now() + this.CB_PAUSE_MS;
          console.log(`🛑 CIRCUIT BREAKER — ${this.consecutiveHardStops} HS consécutifs → pause ${this.CB_PAUSE_MS/60000}min`);
        }
        // v2.1: CARTEL circuit breaker — pause 30min après 3 HS consécutifs
        if (rtPos.cartelStrategy) {
          this.cartelConsecHS++;
          if (this.cartelConsecHS >= 3) {
            this.cartelCircuitBreakerUntil = Date.now() + 30 * 60_000;
            logger.warn({ consec: this.cartelConsecHS }, '🔌 CARTEL circuit breaker — 3 HS consécutifs → pause 30min');
          }
        }
        // NOTE: cartelConsecHS ne se reset PAS sur une victoire concurrente (v2.2 bugfix)
        // Le reset se fait uniquement via le circuit breaker (timeout 30min)
        rtShouldSell = true;
      }
      
      // 3. Rugger exits
      if (false) {
        const rProfile = null;
        if (rProfile) {
          if (mcUsd >= rProfile.targetExitMC) {
            rtReason = `⚡ RT-RUGGER_TARGET — MC ${mcUsd.toFixed(0)} >= ${rProfile.targetExitMC.toFixed(0)} | P&L +${rtPnl.toFixed(1)}%`;
            rtShouldSell = true;
          }
        }
      }
      
      if (rtShouldSell) {
        // DON'T sell immediately — queue for delayed execution (TX latency simulation)
        // Live signal fires IMMEDIATELY (no delay for real trades)
        this.onLiveSignal(this.sell(100, 1.0, 'RIDE', rtReason, this.emptySignals()), tokenAddress, mcUsd);
        
        rtPos.pendingSellAt = Date.now();
        rtPos.pendingSellReason = rtReason;
        rtPos.pendingSellPnl = rtPnl;
        
        logger.info({ 
          token: tokenAddress.slice(0, 8), 
          mc: mcUsd.toFixed(0), 
          pnl: rtPnl.toFixed(1),
          reason: rtReason.slice(0, 80)
        }, '⏱️ SELL SIGNAL — waiting TX latency before paper execution');
        return;
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
    return this.rideCache.has(tokenAddress);
  }

  private async maybeEvaluateLive(tokenAddress: string, currentMC: number): Promise<void> {
    if (this.evaluating.has(tokenAddress)) return;

    let cached = this.rideCache.get(tokenAddress);
    // v10: evaluate ALL tokens (entry based on market demand, not wallet)
    if (false) { // v10.20: all tokens always evaluated
      // Only skip if we already checked and no position open
      // But re-evaluate after 5s in case buyer count changed
      const state = this.liveState.get(tokenAddress);
      const buyers = state?.uniqueBuyers?.size ?? 0;
      // Bypass buyer filter for qualified rugger wallets
      if (buyers < 15) {
        const walletAddr = cached?.walletAddress || '';
        if (true) {
          return; // v10: skip until meaningful buyer count (unless rugger wallet or velocity)
        }
      }
    }

    this.evaluating.add(tokenAddress);
    try {
      if (!cached) {
        const token = await this.tokenRepo.getByAddress(tokenAddress);
        if (!token) {
          this.rideCache.set(tokenAddress, { detectedAt: new Date(), fdvAtDetection: 0, walletAddress: '', walletRiskScore: 0.5 });
          return; // token not found — skip
        }
        // v10.20: RIDE/FADE/AVOID removed — Creator Score + Funder Chain handle wallet quality in evaluateEntry
        // All tokens reach evaluateEntry; market demand determines entry, not wallet reputation labels
        const wallet = await this.walletRepo.getByAddress(token.creator_wallet);
        let walletRiskScore = wallet?.risk_score ?? 0.5;

        // Inherit funder risk score (for position sizing, not blocking)
        const funderResult = await this.funderLookup.getFunder(token.creator_wallet);
        if (funderResult) {
          const funderProfile = await this.walletRepo.getByAddress(funderResult.funder);
          if (funderProfile) {
            const funderRisk = funderProfile.risk_score ?? 0;
            if (funderRisk > walletRiskScore) {
              walletRiskScore = Math.max(walletRiskScore, funderRisk * funderResult.confidence);
            }
          }
          this.storeAncestry(token.creator_wallet, funderResult).catch(() => {});
        }

        cached = {
          detectedAt: token.detected_at ?? new Date(),
          fdvAtDetection: token.fdv_at_detection ?? 0,
          walletAddress: token.creator_wallet,
          walletRiskScore,
        };
        this.rideCache.set(tokenAddress, cached);
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


  /** Hook for live trade forwarding — overridden by PaperTradeExecutor */
  protected onLiveSignal(_signal: any, _tokenAddress: string, _currentMC: number): void {}

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
        if (!pos.postEntryChecked && !pos.cartelStrategy && holdSec60 >= 60 && holdSec60 <= 90) {
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
              // Tokens often bounce after initial sell pressure. Keeping position = +0.6 SOL improvement per period.
              const pnl60 = ((currentMC - pos.entryMC) / pos.entryMC * 100);
              logger.info({ token: tokenAddress.slice(0, 8), buyVol: buyVol60.toFixed(0), sellVol: sellVol60.toFixed(0), pnl: pnl60.toFixed(1) },
                '⚠️ v10.15 SELL_DOM detected (ignored for STD — disabled)');
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
      if (!cached) {
        // Token not in cache — create entry
        const token = await this.tokenRepo.getByAddress(tokenAddress);
        if (!token) return this.none('Token not found');
        const detectedAt = token.detected_at ? new Date(token.detected_at) : new Date();
        const fdv = token.fdv_at_detection ?? (this.firstMC.get(tokenAddress) ?? currentMC);
        
        // Auto-create cache entry with v10 default strategy
        const cacheEntry = {
          detectedAt,
          fdvAtDetection: fdv,
          walletAddress: token.creator_wallet,
          walletRiskScore: 0.5,
        };
        this.rideCache.set(tokenAddress, cacheEntry);
        cached = cacheEntry;
      }

      const baselineMC = cached!.fdvAtDetection > 0 ? cached!.fdvAtDetection : (this.firstMC.get(tokenAddress) ?? currentMC);
      const state = this.liveState.get(tokenAddress);
      const elapsedSec = _elapsedSec;
      const mcRatio = currentMC / Math.max(baselineMC, 1);

      // ── MANAGE OPEN POSITION ──
      if (pos) {
        const mResult = this.managePosition(tokenAddress, pos, null, currentMC, elapsedSec, state);
        if (mResult.action === 'BUY' || mResult.action === 'SELL') this.onLiveSignal(mResult, tokenAddress, currentMC);
        return mResult;
      }

      // ── EVALUATE ENTRY ──
      const eResult = await this.evaluateEntry(tokenAddress, null, currentMC, baselineMC, mcRatio, elapsedSec, state, cached!.walletAddress);
      if (eResult.action === 'BUY' || eResult.action === 'SELL') this.onLiveSignal(eResult, tokenAddress, currentMC);
      return eResult;

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
    _ws: any,
    currentMC: number,
    elapsedSec: number,
    state: LiveTradeState | undefined
  ): TradeSignal {

    const holdSec = (Date.now() - pos.entryTime.getTime()) / 1000;
    const pnlPct = ((currentMC - pos.entryMC) / pos.entryMC) * 100;
    const peakPnl = ((pos.highestMC - pos.entryMC) / pos.entryMC) * 100;
    const dropFromPeak = pos.highestMC > 0 ? (pos.highestMC - currentMC) / pos.highestMC : 0;
    // RIDE/FADE/AVOID removed — Creator Score handles wallet quality
    const signals: SignalBreakdown = { timing_score: 0, momentum_score: 0, consistency_score: 0, risk_score: 0, wallet_score: 0 };

    // ══════════════════════════════════════════════════════════════
    // v10 EXIT STRATEGY
    // ══════════════════════════════════════════════════════════════

    const currentSellers = state?.uniqueSellers?.size || 0;
    const currentBuyers = state?.uniqueBuyers?.size || 0;
    const newSellers = currentSellers - (pos.entrySellersCount || 0);
    const newBuyers = currentBuyers - (pos.entryBuyerCount || 0);
    const sellerGrowthRatio = newBuyers > 15 ? newSellers / newBuyers : -1;

    const isNeo = false; // NEO removed
    const isCartel = pos.cartelStrategy === true;
    const isSwarm = pos.swarmStrategy === true;
    const isUltra = (pos as any).ultraStrategy === true;
    const trailTrigger = isSwarm ? 30 : (isCartel ? 15 : 15);
    let dropLimit = 0;
    if (peakPnl >= trailTrigger) {
      if (isSwarm || isUltra) {
        // SWARM/ULTRA: dynamic trail 18%→13%@50%→8%@200%
        dropLimit = peakPnl >= 200 ? 0.08 : peakPnl >= 50 ? 0.13 : 0.18;
      } else if (isCartel) {
        dropLimit = 0.20;
      } else if (sellerGrowthRatio >= 0 && sellerGrowthRatio <= 0.20) {
        dropLimit = 0.27;
      } else if (sellerGrowthRatio > 0.40) {
        dropLimit = 0.17;
      } else {
        dropLimit = 0.22;
      }
    }

    // 1. Drop stop — trail remainder after tiers
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
    const pump3Threshold = isCartel ? 25 : 15; // STD v10.15: aligned with trail trigger 15% (was 50%)
    // v10.13: PUMP3 disabled for STD until 2026-03-25 20:23 UTC (Raph request)
    const pump3DisabledForSTD = !isCartel && !isSwarm; // PUMP3 disabled for STD/ULTRA/SWARM // STD v10.16: PUMP3 DISABLED for STD permanently — 56% of tokens continue +20%+ after exit, avg +41.7pp left on table. Trail@15% handles these correctly.
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

    // v10.15: LOWER HIGH EXIT DISABLED for STD
    // Backtest: 10 trades avg -14.1%, 0% above breakeven. Tokens flagged as "lower high" still recover.
    // Keeping position → natural PUMP3/trail/HS exits add ~+0.4 SOL per period.

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

        const _hsRc = getRuntimeConfig();
        const hsDefault = (_hsRc?.general?.hard_stop_pct != null ? -Math.abs(_hsRc.general.hard_stop_pct) : -25);
        const hsThreshold = pos.swarmStrategy ? -20 : hsDefault; // SWARM -20% / ULTRA+others: from runtime-config (default -25%)
    if (pnlPct <= hsThreshold) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'HARD_STOP', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops++;
      if (this.consecutiveHardStops >= this.CB_MAX_HS) {
        this.circuitBreakerUntil = Date.now() + this.CB_PAUSE_MS;
        console.log(`🛑 CIRCUIT BREAKER — ${this.consecutiveHardStops} HS consécutifs → pause ${this.CB_PAUSE_MS/60000}min`);
      }
      // v2.2: CARTEL circuit breaker (bugfix: plus de reset sur wins concurrents)
      if (pos.cartelStrategy) {
        this.cartelConsecHS++;
        if (this.cartelConsecHS >= 3) {
          this.cartelCircuitBreakerUntil = Date.now() + 30 * 60_000;
          this.cartelConsecHS = 0; // reset après déclenchement pour le prochain cycle
          logger.warn({ consec: this.cartelConsecHS }, '🔌 CARTEL circuit breaker — 3 HS consécutifs → pause 30min');
        }
      }
      const hsLabel = pos.swarmStrategy ? '🐝 SWARM' : pos.cartelStrategy ? '🎯 CARTEL' : false ? '🧠 NEO' : '🛑 v10';
      return this.sell(100, 1.0, 'RIDE', `${hsLabel} HARD_STOP ${pnlPct.toFixed(1)}% | peak +${peakPnl.toFixed(0)}% (threshold ${hsThreshold}%) | MC ${currentMC.toFixed(0)}`, signals);
    }

    // SWARM: max hold 600s (v1.2: exempt if actively rising — let rockets run)
    if (isSwarm && holdSec > 600) {
      const stillRising = pnlPct > 50 && dropFromPeak < 0.05; // >+50% P&L AND within 5% of peak
      if (!stillRising) {
        this.openPositions.delete(tokenAddress);
        this.closedTokens.set(tokenAddress, { exitType: 'MAX_HOLD', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
        this.consecutiveHardStops = 0;
        return this.sell(100, 0.9, 'RIDE', `🐝 SWARM_MAX_HOLD 600s — pnl=${pnlPct.toFixed(1)}% | MC ${currentMC.toFixed(0)}`, signals);
      }
      // Still rising: skip MAX_HOLD, trail will handle exit
    }

    // 2. MAX HOLD: 5 minutes → force exit
    if (holdSec > 600) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'MAX_HOLD', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0; // CB reset
      return this.sell(100, 0.9, 'RIDE', `⏰ v10 MAX HOLD 5min — P&L ${pnlPct.toFixed(1)}%`, signals);
    }

    // NEO v4.61: STALE_ULTRAEARLY (5-25s) — token at -15%+ with zero upward movement = instant gap rug
    // v4.60 was 10-25s. Expanded to 5s: -15% in 5-9s with no peak = overwhelming rug signal (saves ~13pp vs HS).
    // Data: ALL 95 HS trades had peak=0% and hold<30s. This fires BEFORE the -20% HS threshold.
    // Risk: near-zero — a token at -15% in 5-25s with no peak NEVER recovers on pump.fun.
    if (isNeo && holdSec > 5 && holdSec <= 25 && pnlPct < -15 && peakPnl < 0.5) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops++;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.62 STALE_ULTRAEARLY ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — instant gap rug`, signals);
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
    // NEO v4.55: Targets tokens with tiny peak (0.5-2.5%) bleeding at -13%+ in 50-88s window → heading for HS at -25%
    // Saves ~12pp per trade vs HS (exit at -14% vs -33% avg). Risk low: peak<1.5% = no real momentum.
    if (isNeo && holdSec > 50 && holdSec <= 88 && pnlPct < -13 && peakPnl < 2.5) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.55 STALE_EARLYBLEED ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — gap fill early exit`, signals);
    }

    // NEO v4.51: STALE_FAST (90s) — token bleeding slowly with no peak = exit before further deterioration
    // NEO v4.55: STALE_FAST catches slow bleeds: -8%+ at 90s, peak <2.5% = no momentum (expanded from 1.5%).
    // Expected: saves ~20-25% vs HS on ~5-10% of trades in 90-170s window.
    if (isNeo && holdSec > 90 && holdSec <= 170 && pnlPct < -8 && peakPnl < 2.5) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.55 STALE_FAST ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — slow bleed exit`, signals);
    }

    // NEO v4.57: STALE_MIDBLEED (90-150s) — token had minor pump (2.5-12% peak) but now bleeding -8%+
    // Gap between STALE_FAST (peak<2.5%) and STALE_MID (>150s). Failed mini-rockets: exit at -8% vs -25% HS.
    // Saves ~17pp per trade. Risk low: peak<12% = no real momentum, -8%+ already committed to downside.
    if (isNeo && holdSec > 90 && holdSec <= 150 && pnlPct < -8 && peakPnl >= 2.5 && peakPnl < 12) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.57 STALE_MIDBLEED ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — failed mini-rocket exit`, signals);
    }

    // NEO v4.58: STALE_GHOSTZONE (90-150s) — token pumped 12-24% (below trail trigger) but now bleeding -10%+
    // Gap in STALE coverage: MIDBLEED covers peak<12%, trail covers peak>=25%. 12-24% range was unprotected.
    // Saves ~17pp per trade (exit at -10% vs HS avg -35%). Risk: peak 12-24% = initial momentum but failed.
    if (isNeo && holdSec > 90 && holdSec <= 150 && pnlPct < -10 && peakPnl >= 12 && peakPnl < 25) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.58 STALE_GHOSTZONE ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — failed near-trail exit`, signals);
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

    // NEO v4.58: STALE_MID_PRETRAIL (150s+) — token pumped 12-24% (ghost zone) but crabbing/bleeding >150s
    // Extends STALE_MID coverage to peak 12-24% range. These tokens showed initial momentum but failed trail.
    // pnl < 0 at 150s+ with near-trail peak = unlikely to recover, exit before potential HS at -25%.
    if (isNeo && holdSec > 150 && pnlPct < 0 && peakPnl >= 12 && peakPnl < 25) {
      this.openPositions.delete(tokenAddress);
      this.closedTokens.set(tokenAddress, { exitType: 'STALE_EXIT', exitMC: currentMC, exitTime: Date.now(), entryMC: pos.entryMC, peakMC: pos.highestMC, reentryCount: (this.closedTokens.get(tokenAddress)?.reentryCount || 0) });
      this.consecutiveHardStops = 0;
      return this.sell(100, 1.0, 'RIDE', `🧊 NEO v4.58 STALE_MID_PRETRAIL ${pnlPct.toFixed(1)}% | hold ${holdSec.toFixed(0)}s peak +${peakPnl.toFixed(1)}% — ghost zone stall`, signals);
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
    _ws: any,
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
    // ══════════════════════════════════════════════════════════════
    // SWARM ULTRA (v7) — Highest efficiency variant (replaces STD slots)
    // Backtest: +62.3% avg, 69.4% WR, 30.6% HS, 24.5% rocket rate
    // Filters: SWARM base + Window≥45s + MC≠6-7K + sell_pressure<0.3
    // Uses STD's 3 slots (separate from SWARM v1.2 and v3)
    // ══════════════════════════════════════════════════════════════
    // Extract market state variables
    const buyCount = state?.buyCount || 0;
    const sellCount = state?.sellCount || 0;
    const buyVol = state?.buyVol || 0;
    const uniqueBuyerCount = state?.uniqueBuyers?.size ?? 0;

    const ultraCount = Array.from(this.openPositions.values()).filter(p => (p as any).ultraStrategy).length;
    const MAX_ULTRA = 3; // ULTRA v7: SP<0.5 + Creator Score + Funder Chain
    if (!this.openPositions.has(tokenAddress) && elapsedSec >= 20 && elapsedSec <= 60) { // T=20-60s (was 90s — tokens at 90s are often end-of-pump)
      const ultSbRatio = buyCount > 0 ? sellCount / buyCount : 0;
      const ultAvgBuy = buyCount > 0 ? buyVol / buyCount : 999;
      const ultSellVol = state?.sellVol || 0;
      const ultSellPressure = buyVol > 0 ? ultSellVol / buyVol : 1;
      if (
        uniqueBuyerCount >= 80 &&
        ultAvgBuy < 25 &&
        mcRatio >= 2.2 && mcRatio <= 3.5 && // v10.21: 2.0→2.2 (tokens at 2.0x barely pumped → fragile)
        currentMC < 12000 &&
        !(currentMC >= 6000 && currentMC < 7000) &&  // skip 6-7K dead zone
        ultSellPressure < 0.5 &&                      // KEY: low sell pressure = organic momentum
        ultSbRatio < 0.4
      ) {
        if (ultraCount >= MAX_ULTRA) {
          // Fall through to other strategies
        } else if (this.openPositions.size >= 6) {
          // Fall through
        } else {
          const ultPos = 0.35;
          this.lastBuyTimestamp = Date.now();
          this.openPositions.set(tokenAddress, {
            entryMC: currentMC, entryTime: new Date(), highestMC: currentMC, lowestMCAfterEntry: currentMC,
            tradeCount: 0, walletAddress, peakTime: Date.now(), hadSignificantPump: false,
            entryBuyVol: buyVol, entryBuyCount: buyCount, entryBuyerCount: uniqueBuyerCount,
            entrySellersCount: sellCount, staleTicks: 0, ceilingHigh: currentMC,
            pumpPeaks: [], pumpState: 'PUMP' as const, cycleHigh: currentMC, dipLow: currentMC,
            tickMCs: [currentMC], confirmationDone: true, ultraStrategy: true,
          });
          // Creator score check (async — fire and forget if slow, but block if fast)
          const ultDeployer = await getTokenDeployer(tokenAddress);
          const ultCreatorScore = ultDeployer ? await getCreatorScore(ultDeployer) : null;
          // Block serial ruggers: if deployer known AND (rug_rate >= 50% OR avg_peak_mc < 8K)
          if (ultCreatorScore && (ultCreatorScore.rugRate >= 50 || ultCreatorScore.avgPeakMC < 8000)) {
            this.openPositions.delete(tokenAddress);
            return this.none(`🚫 ULTRA: deployer rug_rate=${ultCreatorScore.rugRate.toFixed(0)}% avgPeak=$${ultCreatorScore.avgPeakMC.toFixed(0)} — serial rugger`, 'RIDE');
          }
          // Funder chain check — is this deployer funded by a known rugger?
          // Only check for NEW deployers (unknown to creator_scores) to save RPC credits
          if (!ultCreatorScore && ultDeployer) {
            const funderCheck = await checkDeployerFunding(ultDeployer);
            if (funderCheck.blocked) {
              this.openPositions.delete(tokenAddress);
              logger.info({ token: tokenAddress.slice(0,8), deployer: ultDeployer.slice(0,8), reason: funderCheck.reason }, '🚫 ULTRA: funder chain blocked');
              return this.none(`🚫 ULTRA: ${funderCheck.reason}`, 'RIDE');
            }
          }
          const ultScoreLabel = ultCreatorScore ? `cs=${ultCreatorScore.score.toFixed(0)}` : 'cs=new';

          (this.openPositions.get(tokenAddress) as any).ultraStrategy = true;
          logger.info({ token: tokenAddress.slice(0,8), buyers: uniqueBuyerCount, avgBuy: ultAvgBuy.toFixed(0), ratio: mcRatio.toFixed(2), mc: currentMC.toFixed(0), sp: ultSellPressure.toFixed(2), creatorScore: ultCreatorScore?.score?.toFixed(0) || 'new' }, '⚡ ULTRA BUY');
          return {
            action: 'BUY', confidence: 0.90, percentage: 100, playbook_strategy: 'RIDE',
            wallet_risk_score: 0.2, position_sol: ultPos,
            reason: `⚡ ULTRA v7 BUY — ${uniqueBuyerCount}b avg=$${ultAvgBuy.toFixed(0)} ${mcRatio.toFixed(2)}x T=${elapsedSec.toFixed(0)}s | sp=${ultSellPressure.toFixed(2)} ${ultScoreLabel} mc=$${currentMC.toFixed(0)} pos=${ultPos}SOL`
          };
        }
      }
    }


    // ══════════════════════════════════════════════════════════════
    // SWARM v3 — Optimized variant (replaces NEO slot)
    // Backtest: Window≥45s + skip MC 6-7K dead zone → +36.5% avg vs +28% baseline
    // Uses NEO's old slot (1 dedicated slot, separate from SWARM v1.2)
    // ══════════════════════════════════════════════════════════════
    const swarm3Count = Array.from(this.openPositions.values()).filter(p => (p as any).swarm3Strategy).length;
    const MAX_SWARM3 = 1;
    const swarmCount = Array.from(this.openPositions.values()).filter(p => p.swarmStrategy && !(p as any).swarm3Strategy && !(p as any).ultraStrategy).length;
    const MAX_SWARM = 2;
    if (!this.openPositions.has(tokenAddress) && elapsedSec >= 45 && elapsedSec <= 60) { // SWARM v3: T=45-60s
      const sw3SbRatio = buyCount > 0 ? sellCount / buyCount : 0;
      const sw3AvgBuy = buyCount > 0 ? buyVol / buyCount : 999;
      if (
        uniqueBuyerCount >= 80 &&
        sw3AvgBuy < 25 &&
        mcRatio >= 2.0 && mcRatio <= 3.5 &&
        currentMC < 12000 &&
        !(currentMC >= 6000 && currentMC < 7000) &&  // skip 6-7K dead zone
        sw3SbRatio < 0.4
      ) {
        if (swarm3Count >= MAX_SWARM3) {
          // Don't return — fall through to SWARM v1.2
        } else if (this.openPositions.size >= 6) {
          // Don't return — fall through
        } else {
          const sw3Pos = 0.35;
          this.lastBuyTimestamp = Date.now();
          this.openPositions.set(tokenAddress, {
            entryMC: currentMC, entryTime: new Date(), highestMC: currentMC, lowestMCAfterEntry: currentMC,
            tradeCount: 0, walletAddress, peakTime: Date.now(), hadSignificantPump: false,
            entryBuyVol: buyVol, entryBuyCount: buyCount, entryBuyerCount: uniqueBuyerCount,
            entrySellersCount: sellCount, staleTicks: 0, ceilingHigh: currentMC,
            pumpPeaks: [], pumpState: 'PUMP' as const, cycleHigh: currentMC, dipLow: currentMC,
            tickMCs: [currentMC], confirmationDone: true, swarmStrategy: true,
          });
          // Tag as SWARM v3 (swarm3Strategy flag for slot counting)
          (this.openPositions.get(tokenAddress) as any).swarm3Strategy = true;
          // Creator Score + Funder chain check
          const sw3Deployer = await getTokenDeployer(tokenAddress);
          const sw3CS = sw3Deployer ? await getCreatorScore(sw3Deployer) : null;
          if (sw3CS && (sw3CS.rugRate >= 50 || sw3CS.avgPeakMC < 8000)) {
            this.openPositions.delete(tokenAddress);
            return this.none(`🚫 SWARM3: deployer rug_rate=${sw3CS.rugRate.toFixed(0)}% avgPeak=$${sw3CS.avgPeakMC.toFixed(0)} — serial rugger`, 'RIDE');
          }
          if (!sw3CS && sw3Deployer) {
            const sw3Funder = await checkDeployerFunding(sw3Deployer);
            if (sw3Funder.blocked) { this.openPositions.delete(tokenAddress); return this.none(`🚫 SWARM3: ${sw3Funder.reason}`, 'RIDE'); }
          }
          logger.info({ token: tokenAddress.slice(0,8), buyers: uniqueBuyerCount, avgBuy: sw3AvgBuy.toFixed(0), ratio: mcRatio.toFixed(2), mc: currentMC.toFixed(0) }, '🐝 SWARM v3 BUY');
          return {
            action: 'BUY', confidence: 0.85, percentage: 100, playbook_strategy: 'RIDE',
            wallet_risk_score: 0.3, position_sol: sw3Pos,
            reason: `🐝 SWARM v3 BUY — ${uniqueBuyerCount}b avg=$${sw3AvgBuy.toFixed(0)} ${mcRatio.toFixed(2)}x T=${elapsedSec.toFixed(0)}s (45-90s) | sb=${sw3SbRatio.toFixed(2)} mc=$${currentMC.toFixed(0)} pos=${sw3Pos}SOL`
          };
        }
      }
    }

        // ══════════════════════════════════════════════════════════════
    // SWARM STRATEGY v1.2 — Organic retail crowd signal (broader filters)
    // Backtest CARTEL (163t): buyers≥80 + avg_buy<$25 → 8 fusées +198% avg
    // Signal: masse retail (≥80 buyers, avg<$25, ratio 2.0-3.5x, T=20-90s)
    // Philosophy: not smart money, it's the crowd that makes fusées
    // ══════════════════════════════════════════════════════════════
    if (!this.openPositions.has(tokenAddress) && elapsedSec >= 20 && elapsedSec <= 60) { // T=20-60s
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
        if (this.openPositions.size >= 6) {
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
        // Creator Score + Funder chain check
        const swDeployer = await getTokenDeployer(tokenAddress);
        const swCS = swDeployer ? await getCreatorScore(swDeployer) : null;
        if (swCS && (swCS.rugRate >= 50 || swCS.avgPeakMC < 8000)) {
          this.openPositions.delete(tokenAddress);
          return this.none(`🚫 SWARM: deployer rug_rate=${swCS.rugRate.toFixed(0)}% avgPeak=$${swCS.avgPeakMC.toFixed(0)} — serial rugger`, 'RIDE');
        }
        if (!swCS && swDeployer) {
          const swFunder = await checkDeployerFunding(swDeployer);
          if (swFunder.blocked) { this.openPositions.delete(tokenAddress); return this.none(`🚫 SWARM: ${swFunder.reason}`, 'RIDE'); }
        }
        logger.info({ token: tokenAddress.slice(0,8), buyers: uniqueBuyerCount, avgBuy: swarmAvgBuy.toFixed(0), ratio: mcRatio.toFixed(2), mc: currentMC.toFixed(0) }, '🐝 SWARM BUY');
        return {
          action: 'BUY', confidence: 0.82, percentage: 100, playbook_strategy: 'RIDE',
          wallet_risk_score: 0.3, position_sol: swarmPos,
          reason: `🐝 SWARM v1.2 BUY — ${uniqueBuyerCount}b avg=$${swarmAvgBuy.toFixed(0)} ${mcRatio.toFixed(2)}x T=${elapsedSec.toFixed(0)}s | sb=${swarmSbRatio.toFixed(2)} mc=$${currentMC.toFixed(0)} pos=${swarmPos}SOL`
        };
      }
    }



    // ══════════════════════════════════════════════════════════════
    // CARTEL DISABLED v2.3 — see RT path comment above for reasoning
    if (!this.openPositions.has(tokenAddress) && elapsedSec >= 2 && elapsedSec <= 120) {
      const cartelSignal = this.cartelDetector.getSignal(tokenAddress);
      if (cartelSignal && cartelSignal.sniperCount >= 999) { // v2.3: DISABLED (seuil 999 = jamais)
        // v2.1: Circuit breaker check
        if (this.cartelCircuitBreakerUntil > Date.now()) {
          return this.none(`🔌 CARTEL: circuit breaker actif jusqu'à ${new Date(this.cartelCircuitBreakerUntil).toISOString()}`, 'RIDE');
        }

        // v2.1: Minimum MC $5K — entrées < $3K ont 25% WR (vs 61% à $5K-8K)
        if (currentMC < 5000) {
          return this.none(`🚫 CARTEL: MC $${currentMC.toFixed(0)} < $5K minimum`, 'RIDE');
        }

        // v2.1: Minimum buyers 50 — HS avg 66b vs winners 80b, 50 est le seuil bas
        if (uniqueBuyerCount < 50) {
          return this.none(`🚫 CARTEL: ${uniqueBuyerCount} buyers < 50 minimum`, 'RIDE');
        }

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
          quality_score: cartelSignal.sniperCount,
          reason: `🎯 CARTEL v2.2 BUY — ${cartelSignal.sniperCount} snipers | ${mcRatio.toFixed(2)}x ${elapsedSec.toFixed(0)}s | ${uniqueBuyerCount}b pos=${cartelPos}SOL`
        };
      }
    }

    return this.none('⏳ No strategy matched', 'RIDE');
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

  private none(reason: string, strategy?: string): TradeSignal {
    return { action: 'NONE', confidence: 0, reason, playbook_strategy: strategy };
  }

  private sell(pct: number, confidence: number, strategy: string, reason: string, signals: SignalBreakdown): TradeSignal {
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
      const trailTrigger = false ? 15 : pos.swarmStrategy ? 30 : (pos.cartelStrategy ? 30 : 15); // v10.19: NEO 25→15, SWARM 40→30
      if (peakPnl > trailTrigger && !lastKnownMC) {
        // Token should have trailed — estimate exit at peak - default trail drop
        const trailDrop = false ? (peakPnl >= 125 ? 0.15 : 0.25) : pos.swarmStrategy ? (peakPnl >= 200 ? 0.08 : peakPnl >= 50 ? 0.13 : 0.18) : 0.22; // v10.19: dynamic trail
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
