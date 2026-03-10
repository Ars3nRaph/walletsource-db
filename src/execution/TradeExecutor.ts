import type { Pool } from 'pg';
import type { RuggerPlaybook } from '../types/index.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { logger } from '../utils/logger.js';

export type TradeAction = 'BUY' | 'SELL' | 'HOLD' | 'NONE';

export interface TradeSignal {
  action: TradeAction;
  confidence: number;
  percentage?: number;
  reason: string;
  playbook_strategy?: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID';
  signals?: SignalBreakdown;
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
  peakTime: number;           // timestamp when highestMC was set
  hadSignificantPump: boolean; // true if ever reached +20%
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

  private openPositions = new Map<string, OpenPosition>();
  private firstMC = new Map<string, number>();
  private liveState = new Map<string, LiveTradeState>();

  // Cache: token → { isRide, detectedAt, fdvAtDetection, walletAddress, strategy }
  private rideCache = new Map<string, {
    isRide: boolean;
    detectedAt: Date;
    fdvAtDetection: number;
    walletAddress: string;
    strategy: WalletStrategy | null;
  }>();
  private evaluating = new Set<string>();
  private closedTokens = new Set<string>();
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
      const ws = cached ? this.walletStrategies.get(cached.walletAddress) : null;
      const maxHold = ws?.maxHoldSec ?? 180;
      
      // Stale: no ticks for 30s+ AND held > 15s
      // Or: past max hold time
      if (holdSec > maxHold || (holdSec > 15 && pos.tradeCount < 3)) {
        const lastMC = pos.lowestMCAfterEntry || pos.entryMC;
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
    const cascadeThreshold = winRate > 0.5 ? 4 : winRate > 0.3 ? 5 : 6;

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

  onTrade(tokenAddress: string, txType: 'buy' | 'sell', mcUsd: number, volUsd: number, trader: string): void {
    let state = this.liveState.get(tokenAddress);
    if (!state) {
      state = {
        buyCount: 0, sellCount: 0, buyVol: 0, sellVol: 0,
        uniqueBuyers: new Set(), uniqueSellers: new Set(),
        firstSellAt: null, lastSeenAt: new Date(),
        recentSells: 0, recentBuys: 0, cascadeDetected: false
      };
      this.liveState.set(tokenAddress, state);
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

    // Dynamic cascade threshold from wallet strategy
    const cached = this.rideCache.get(tokenAddress);
    const cascadeThresh = cached?.strategy?.cascadeThreshold ?? 5;
    
    if (txType === 'sell' && state.recentSells >= cascadeThresh && state.recentBuys === 0
        && state.sellVol > state.buyVol * 0.5) {
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
    
    this.maybeEvaluateLive(tokenAddress, mcUsd).catch(() => {});
  }

  isLiveTracked(tokenAddress: string): boolean {
    return this.rideCache.get(tokenAddress)?.isRide === true;
  }

  private async maybeEvaluateLive(tokenAddress: string, currentMC: number): Promise<void> {
    if (this.evaluating.has(tokenAddress)) return;

    let cached = this.rideCache.get(tokenAddress);
    if (cached && !cached.isRide) return;

    this.evaluating.add(tokenAddress);
    try {
      if (!cached) {
        const token = await this.tokenRepo.getByAddress(tokenAddress);
        if (!token) {
          this.rideCache.set(tokenAddress, { isRide: false, detectedAt: new Date(), fdvAtDetection: 0, walletAddress: '', strategy: null });
          return;
        }
        const wallet = await this.walletRepo.getByAddress(token.creator_wallet);
        const playbook: RuggerPlaybook | null = wallet?.rugger_playbook
          ? (typeof wallet.rugger_playbook === 'string'
              ? JSON.parse(wallet.rugger_playbook) as RuggerPlaybook
              : wallet.rugger_playbook as RuggerPlaybook)
          : null;
        const isRide = playbook?.recommended_strategy === 'RIDE';
        
        let strategy: WalletStrategy | null = null;
        if (isRide && playbook) {
          strategy = await this.getWalletStrategy(token.creator_wallet, playbook);
          // Skip wallets with negative EV
          if (strategy.evPerTrade <= 0) {
            logger.debug({ wallet: token.creator_wallet.slice(0, 8), ev: strategy.evPerTrade.toFixed(1) }, 'Skipping negative EV wallet');
            this.rideCache.set(tokenAddress, { isRide: false, detectedAt: new Date(), fdvAtDetection: 0, walletAddress: token.creator_wallet, strategy: null });
            return;
          }
        }
        
        cached = {
          isRide: isRide && strategy !== null && strategy.evPerTrade > 0,
          detectedAt: token.detected_at ?? new Date(),
          fdvAtDetection: token.fdv_at_detection ?? 0,
          walletAddress: token.creator_wallet,
          strategy,
        };
        this.rideCache.set(tokenAddress, cached);
        if (!cached.isRide) return;
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
        const currentProfit = (pos.highestMC - pos.entryMC) / pos.entryMC;
        if (currentProfit >= 0.20) pos.hadSignificantPump = true;
        if (currentMC < pos.lowestMCAfterEntry) pos.lowestMCAfterEntry = currentMC;
        pos.tradeCount++;
      }

      const _elapsedSec = elapsedMinutes * 60;
      const cached = this.rideCache.get(tokenAddress);
      if (!cached?.isRide || !cached.strategy) {
        // Fallback: lookup from DB
        const token = await this.tokenRepo.getByAddress(tokenAddress);
        if (!token) return this.none('Token not found');

        const wallet = await this.walletRepo.getByAddress(token.creator_wallet);
        if (!wallet) return this.none('Wallet not found');

        const playbook: RuggerPlaybook | null = wallet.rugger_playbook
          ? (typeof wallet.rugger_playbook === 'string'
              ? JSON.parse(wallet.rugger_playbook) : wallet.rugger_playbook)
          : null;
        if (!playbook || playbook.recommended_strategy !== 'RIDE') {
          return this.none('Not RIDE strategy');
        }

        return this.none('Strategy not loaded — waiting for live path');
      }

      const ws = cached.strategy;
      const baselineMC = cached.fdvAtDetection > 0 ? cached.fdvAtDetection : (this.firstMC.get(tokenAddress) ?? currentMC);
      const state = this.liveState.get(tokenAddress);
      const elapsedSec = _elapsedSec;
      const mcRatio = currentMC / Math.max(baselineMC, 1);

      // ── MANAGE OPEN POSITION ──
      if (pos) {
        return this.managePosition(tokenAddress, pos, ws, currentMC, elapsedSec, state);
      }

      // ── EVALUATE ENTRY ──
      return this.evaluateEntry(tokenAddress, ws, currentMC, baselineMC, mcRatio, elapsedSec, state, cached.walletAddress);

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
    _elapsedSec: number,
    state: LiveTradeState | undefined
  ): TradeSignal {

    // 1. CASCADE — immediate exit
    if (state?.cascadeDetected) {
      this.closePosition(tokenAddress);
      return this.sell(100, 1.0, 'RIDE',
        `🌊 CASCADE (${state.sellCount}s/${state.buyCount}b, thresh=${ws.cascadeThreshold})`,
        this.emptySignals());
    }

    // 1.5. PROFIT DECAY — token pumped but now stagnating/declining
    //   If we HAD +20%+ profit but it's been >8s since the peak and profit < 50% of peak profit
    //   → the pump is over, take what's left before the rug
    if (pos.hadSignificantPump) {
      const secSincePeak = (Date.now() - pos.peakTime) / 1000;
      const currentPnl = (currentMC - pos.entryMC) / pos.entryMC;
      const peakPnl = (pos.highestMC - pos.entryMC) / pos.entryMC;
      const retainedPct = peakPnl > 0 ? currentPnl / peakPnl : 0;
      
      // If 8s+ since peak AND we've lost more than 50% of peak profits → exit
      if (secSincePeak > 8 && retainedPct < 0.50 && currentPnl > 0) {
        const pnlStr = (currentPnl * 100).toFixed(1);
        const peakStr = (peakPnl * 100).toFixed(1);
        this.closePosition(tokenAddress);
        return this.sell(100, 1.0, 'RIDE',
          `⏳ PROFIT DECAY +${pnlStr}% (was +${peakStr}%, ${secSincePeak.toFixed(0)}s ago, ${(retainedPct*100).toFixed(0)}% retained)`,
          this.emptySignals());
      }
      
      // If 15s+ since peak AND any profit remaining → take it
      if (secSincePeak > 15 && currentPnl > 0.02) {
        const pnlStr = (currentPnl * 100).toFixed(1);
        this.closePosition(tokenAddress);
        return this.sell(100, 1.0, 'RIDE',
          `⏳ STALE PUMP +${pnlStr}% (peak ${(peakPnl*100).toFixed(0)}% was ${secSincePeak.toFixed(0)}s ago — taking profit)`,
          this.emptySignals());
      }
    }

    // 2. ADAPTIVE EXIT — behavior-based, not fixed percentage
    const dropFromEntry = (pos.entryMC - currentMC) / pos.entryMC;
    const holdSecAdaptive = (Date.now() - pos.entryTime.getTime()) / 1000;
    
    // 2a. QUICK RUG: fast bail on bot-inflated entries or massive drops
    const cachedBase = this.rideCache.get(tokenAddress);
      const entryBaseline = cachedBase?.fdvAtDetection || pos.entryMC;
      const entryRatio = pos.entryMC / Math.max(entryBaseline, 1);
    if (holdSecAdaptive < 5 && pos.tradeCount >= 2) {
      // Bot-inflated entry (>1.08x baseline): tight stop at -5%
      // Baseline entry (<1.08x): wider room at -12% (normal volatility)
      const qrThreshold = entryRatio > 1.08 ? 0.05 : 0.12;
      if (dropFromEntry > qrThreshold) {
        this.closePosition(tokenAddress);
        return this.sell(100, 1.0, 'RIDE',
          `⚡ QUICK RUG -${(dropFromEntry*100).toFixed(1)}% in ${holdSecAdaptive.toFixed(0)}s (entry@${entryRatio.toFixed(2)}x, thresh=${(qrThreshold*100).toFixed(0)}%)`,
          this.emptySignals());
      }
    }
    
    // 2b. HARD STOP: absolute max loss 25% regardless of timing
    //     In paper trading prices gap through — this catches the gap
    if (dropFromEntry >= 0.25) {
      this.closePosition(tokenAddress);
      return this.sell(100, 1.0, 'RIDE',
        `🛑 HARD STOP -${(dropFromEntry*100).toFixed(1)}% (max loss 25%)`,
        this.emptySignals());
    }
    
    // 2c. NO PUMP TIMEOUT: after 15s, if token never pumped +10% → dead, exit
    if (holdSecAdaptive > 15 && !pos.hadSignificantPump) {
      const pnl = ((currentMC - pos.entryMC) / pos.entryMC * 100).toFixed(1);
      this.closePosition(tokenAddress);
      return this.sell(100, 1.0, 'RIDE',
        `⏰ NO PUMP after ${holdSecAdaptive.toFixed(0)}s (P&L ${pnl}%) — token mort`,
        this.emptySignals());
    }

    // 3. PROGRESSIVE TRAILING STOP — widens with profit, tightens as pump matures
    //    Don't trigger until meaningful profit; let the pump develop
    const profitPct = (pos.highestMC - pos.entryMC) / pos.entryMC;
    if (profitPct >= 0.20) {  // activate only after +20% unrealized profit
      const dropFromHigh = (pos.highestMC - currentMC) / pos.highestMC;
      
      // Progressive trailing: wider early, tighter as profit grows
      // +20-50% profit  → 35% trailing (let it breathe, normal volatility)
      // +50-100% profit → 28% trailing (decent pump, protect some gains)
      // +100-200% profit → 22% trailing (big pump, lock in more)
      // +200%+ profit   → 18% trailing (massive pump, protect hard)
      let trailingPct: number;
      if (profitPct < 0.50) trailingPct = 0.35;
      else if (profitPct < 1.00) trailingPct = 0.28;
      else if (profitPct < 2.00) trailingPct = 0.22;
      else trailingPct = 0.18;
      
      if (dropFromHigh >= trailingPct) {
        const realPnl = ((currentMC - pos.entryMC) / pos.entryMC * 100).toFixed(1);
        const capturedPct = ((currentMC - pos.entryMC) / (pos.highestMC - pos.entryMC) * 100).toFixed(0);
        this.closePosition(tokenAddress);
        return this.sell(100, 1.0, 'RIDE',
          `📉 TRAILING ${(dropFromHigh*100).toFixed(0)}%>${(trailingPct*100).toFixed(0)}% from $${pos.highestMC.toFixed(0)} | P&L +${realPnl}% (captured ${capturedPct}% of peak)`,
          this.emptySignals());
      }
    }

    // 4. MAX HOLD TIME — per-wallet
    const holdSec = (Date.now() - pos.entryTime.getTime()) / 1000;
    if (holdSec > ws.maxHoldSec) {
      const pnl = ((currentMC - pos.entryMC) / pos.entryMC * 100).toFixed(1);
      this.closePosition(tokenAddress);
      return this.sell(100, 1.0, 'RIDE',
        `⏱ MAX HOLD ${holdSec.toFixed(0)}s > ${ws.maxHoldSec.toFixed(0)}s (P&L ${pnl}%)`,
        this.emptySignals());
    }

    // 5. HOLD
    const pnl = ((currentMC - pos.entryMC) / pos.entryMC * 100).toFixed(1);
    const high = ((pos.highestMC - pos.entryMC) / pos.entryMC * 100).toFixed(1);
    return {
      action: 'HOLD', confidence: 0.5, playbook_strategy: 'RIDE',
      reason: `HOLD ${pnl}% (high ${high}%) | hold=${holdSec.toFixed(0)}s/${ws.maxHoldSec.toFixed(0)}s | SL=${(ws.stopLossPct*100).toFixed(0)}% TS=${(ws.trailingStopPct*100).toFixed(0)}%`
    };
  }

  // ─────────────────────────────────────────────────────────────
  // ENTRY EVALUATION (per-wallet parameters)
  // ─────────────────────────────────────────────────────────────

  private evaluateEntry(
    tokenAddress: string,
    ws: WalletStrategy,
    currentMC: number,
    baselineMC: number,
    mcRatio: number,
    elapsedSec: number,
    state: LiveTradeState | undefined,
    walletAddress: string
  ): TradeSignal {

    // No re-entry
    if (this.closedTokens.has(tokenAddress)) {
      return this.none('Token déjà sorti — pas de re-entry', 'RIDE');
    }

    // Too late (per-wallet timing)
    if (elapsedSec > ws.maxEntrySec) {
      return this.none(`⏰ Trop tard (${elapsedSec.toFixed(0)}s > ${ws.maxEntrySec.toFixed(0)}s)`, 'RIDE');
    }

    const pumpPct = mcRatio - 1;
    const history = this.priceHistory.get(tokenAddress);
    
    // ══════════════════════════════════════════════════════════════
    // CONFIDENCE-BASED ENTRY — NO trade without market confirmation
    //
    // DB analysis (902 tokens, 14 days):
    //   - Baseline (no filter): 10% pump rate
    //   - ≥3 buys + ≥2 unique buyers in 10s: 55-60% pump rate
    //   - DUD tokens get 0.1 buys; PUMP tokens get 2.2 buys in 10s
    //
    // RULE: Do NOT buy unless market confirms demand first.
    // ══════════════════════════════════════════════════════════════

    const buyCount = state?.buyCount ?? 0;
    const uniqueBuyerCount = state?.uniqueBuyers?.size ?? 0;
    const buyVol = state?.buyVol ?? 0;
    
    // ── PHASE 0 (T+0-2s): OBSERVE — never buy during bot spike
    if (elapsedSec < 3) {
      return this.none(`👁️ OBSERVE (${elapsedSec.toFixed(1)}s) — collecting market data`, 'RIDE');
    }

    // ── MARKET CONFIDENCE: require ≥3 buys from ≥2 unique wallets
    const minBuys = 3;
    const minBuyers = 2;
    
    if (buyCount < minBuys || uniqueBuyerCount < minBuyers) {
      if (elapsedSec > 20) {
        return this.none(`💀 NO INTEREST: ${buyCount}b/${uniqueBuyerCount}w après ${elapsedSec.toFixed(0)}s — skip`, 'RIDE');
      }
      return this.none(`⏳ CONFIRMING: ${buyCount}/${minBuys} buys, ${uniqueBuyerCount}/${minBuyers} buyers — attente`, 'RIDE');
    }
    
    // ── PRICE: don't buy above max entry ratio
    if (mcRatio > ws.maxEntryRatio) {
      return this.none(`Ratio ${mcRatio.toFixed(2)}x > ${ws.maxEntryRatio.toFixed(2)}x max entry`, 'RIDE');
    }

    // ── PRICE: don't buy during active bot spike (>1.15x before T+5s)
    if (mcRatio > 1.15 && elapsedSec < 5) {
      return this.none(`⏳ Bot spike zone (${mcRatio.toFixed(2)}x) — attente dip`, 'RIDE');
    }

    // ── MOMENTUM: price should not be crashing
    if (history && history.length >= 3) {
      const now = Date.now();
      const recent3s = history.filter(h => h.ts > now - 3000);
      if (recent3s.length >= 2) {
        const trend = (recent3s[recent3s.length - 1].mc - recent3s[0].mc) / recent3s[0].mc;
        if (trend < -0.05) {
          return this.none(`📉 CRASHING ${(trend*100).toFixed(1)}% — pas d'entrée en chute`, 'RIDE');
        }
      }
    }

    // ── CASCADE / SELL PRESSURE
    if (state?.cascadeDetected) {
      return this.none('CASCADE en cours', 'RIDE');
    }
    if (state && state.sellCount > state.buyCount * 1.5 && state.sellCount > 3) {
      return this.none(`Sell pressure (${state.sellCount}s > ${state.buyCount}b)`, 'RIDE');
    }
    
    // ── TIMEOUT: 30s max entry window
    if (elapsedSec > 30) {
      return this.none(`⏰ Trop tard (${elapsedSec.toFixed(0)}s) — fenêtre passée`, 'RIDE');
    }


    // ✅ BUY — phased entry confirmed
    this.openPositions.set(tokenAddress, {
      entryMC: currentMC,
      entryTime: new Date(),
      highestMC: currentMC,
      lowestMCAfterEntry: currentMC,
      tradeCount: 0,
      walletAddress,
      peakTime: Date.now(),
      hadSignificantPump: false,
    });

    const evStr = ws.evPerTrade.toFixed(1);
    const wrStr = (ws.winRate * 100).toFixed(0);
    // const slStr = (ws.stopLossPct * 100).toFixed(0);
    const targetStr = ((ws.targetRatio - 1) * 100).toFixed(0);

    logger.info({
      token: tokenAddress.slice(0, 8),
      wallet: walletAddress.slice(0, 8),
      mc: currentMC.toFixed(0),
      baseline: baselineMC.toFixed(0),
      pump: (pumpPct * 100).toFixed(1) + '%',
      buys: buyCount,
      buyers: uniqueBuyerCount,
      buyVol: buyVol.toFixed(0),
      ev: evStr + '%',
      winRate: wrStr + '%',
    }, '🟢 BUY — market-confirmed entry');

    return {
      action: 'BUY', confidence: Math.min(ws.winRate + 0.3, 0.95), percentage: 100, playbook_strategy: 'RIDE',
      reason: `BUY — ${buyCount}b/${uniqueBuyerCount}w $${buyVol.toFixed(0)}vol | ${mcRatio.toFixed(2)}x base | EV=${evStr}% WR=${wrStr}% target=+${targetStr}% maxHold=${ws.maxHoldSec.toFixed(0)}s`
    };
  }

  /** Override in PaperTradeExecutor to log sweep closes */
  protected onSweepClose(_token: string, _signal: TradeSignal, _mc: number): void {
    // base: no-op. PaperTradeExecutor overrides to log.
  }

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────

  private none(reason: string, strategy?: 'RIDE'|'FADE'|'WATCH'|'AVOID'): TradeSignal {
    return { action: 'NONE', confidence: 0, reason, playbook_strategy: strategy };
  }

  private sell(pct: number, confidence: number, strategy: 'RIDE', reason: string, signals: SignalBreakdown): TradeSignal {
    return { action: 'SELL', confidence, percentage: pct, reason, playbook_strategy: strategy, signals };
  }

  private emptySignals(): SignalBreakdown {
    return { timing_score: 0, momentum_score: 0, consistency_score: 0, risk_score: 0, wallet_score: 0 };
  }

  private closePosition(tokenAddress: string): void {
    const pos = this.openPositions.get(tokenAddress);
    if (pos) {
      const holdSec = (Date.now() - pos.entryTime.getTime()) / 1000;
      const pnl = ((pos.highestMC - pos.entryMC) / pos.entryMC * 100).toFixed(1);
      logger.info({
        token: tokenAddress.slice(0, 8),
        wallet: pos.walletAddress.slice(0, 8),
        entryMC: pos.entryMC.toFixed(0),
        highMC: pos.highestMC.toFixed(0),
        holdSec: holdSec.toFixed(0),
        maxPnlPct: pnl + '%'
      }, '🔴 POSITION CLOSED');
      this.openPositions.delete(tokenAddress);
      this.closedTokens.add(tokenAddress);
    }
    this.firstMC.delete(tokenAddress);
    this.liveState.delete(tokenAddress);
    this.priceHistory.delete(tokenAddress);
  }

  closePositionIfOpen(tokenAddress: string): void {
    if (this.openPositions.has(tokenAddress)) this.closePosition(tokenAddress);
    this.firstMC.delete(tokenAddress);
    this.liveState.delete(tokenAddress);
  }

  hasPosition(tokenAddress: string): boolean {
    return this.openPositions.has(tokenAddress);
  }
}
