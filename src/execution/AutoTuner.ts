import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AutoTuner — Self-optimizing trading strategy
//
// Every N completed trades (BUY→SELL pairs), this module:
//   1. Analyzes recent trade performance
//   2. Identifies loss patterns (spike buy, early exit, etc.)
//   3. Proposes parameter changes
//   4. Backtests proposals against ALL historical data
//   5. Only applies changes if backtest shows improvement
//   6. Logs everything to calibration_log for audit trail
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ━━━ Tunable Parameters ━━━
export interface TunableParams {
  // Entry (CLEAN wallets)
  clean_observe_sec: number;        // Min observe before entry
  clean_max_ratio: number;          // Max MC/baseline ratio to buy
  clean_min_dip_pct: number;        // Required dip from spike (0.10 = 10%)
  clean_min_buys: number;           // Min buy count
  clean_min_vol: number;            // Min buy volume USD
  clean_max_window_sec: number;     // Max entry window
  clean_trend_floor: number;        // Min 5s trend to enter (e.g. -0.03)

  // Entry (Rugger wallets)
  rugger_min_hwr: number;           // Min historical win rate
  rugger_min_buyers: number;        // Min unique buyers

  // Position — CLEAN
  clean_grace_sec: number;          // Grace period
  clean_hard_stop: number;          // Hard stop loss (0.30 = -30%)
  clean_cascade_thresh: number;     // Cascade sell threshold
  clean_nopump_sec: number;         // No pump timeout
  clean_nopump_thresh: number;      // Min gain to prove life
  clean_maxhold_sec: number;        // Max hold time

  // Position — Rugger
  rugger_grace_sec: number;
  rugger_hard_stop: number;
  rugger_cascade_thresh: number;
  rugger_nopump_sec: number;
  rugger_nopump_thresh: number;
  rugger_maxhold_sec: number;

  // Shared
  trailing_drop_pct: number;        // Trailing stop: drop from peak (0.25 = 25%)
  trailing_min_peak: number;        // Min peak before trailing activates
  breakeven_peak_thresh: number;    // Peak gain before breakeven lock (0.10 = 10%)
}

// Current v9.1 defaults
const CURRENT_PARAMS: TunableParams = {
  clean_observe_sec: 8,
  clean_max_ratio: 2.5,
  clean_min_dip_pct: 0.10,
  clean_min_buys: 2,
  clean_min_vol: 100,
  clean_max_window_sec: 90,
  clean_trend_floor: -0.03,

  rugger_min_hwr: 0.30,
  rugger_min_buyers: 3,

  clean_grace_sec: 15,
  clean_hard_stop: 0.30,
  clean_cascade_thresh: 8,
  clean_nopump_sec: 45,
  clean_nopump_thresh: 0.05,
  clean_maxhold_sec: 90,

  rugger_grace_sec: 8,
  rugger_hard_stop: 0.20,
  rugger_cascade_thresh: 4,
  rugger_nopump_sec: 20,
  rugger_nopump_thresh: 0.08,
  rugger_maxhold_sec: 45,

  trailing_drop_pct: 0.25,
  trailing_min_peak: 0.10,
  breakeven_peak_thresh: 0.10,
};

// ━━━ Loss Pattern Signatures ━━━
type LossPattern =
  | 'SPIKE_BUY'        // Bought during initial spike (high ratio, low elapsed)
  | 'EARLY_EXIT'       // Sold too early, token continued pumping
  | 'NO_PUMP_KILL'     // NO PUMP timeout killed a slow grower
  | 'CASCADE_FALSE'    // CASCADE triggered but token recovered
  | 'HARD_STOP_TIGHT'  // Hard stop hit during normal retrace
  | 'LATE_ENTRY'       // Entered too late, momentum gone
  | 'LOW_QUALITY'      // Token had low buy activity / no real interest
  | 'UNKNOWN';

interface TradeAnalysis {
  token: string;
  entryTime: string;
  exitTime: string;
  entryMC: number;
  exitMC: number;
  peakMC: number;
  pnlPct: number;
  holdSec: number;
  exitReason: string;
  isClean: boolean;
  // Derived
  entryRatio: number;       // MC/baseline at entry
  peakAfterExit: number;    // How high did token go after we sold?
  patterns: LossPattern[];
  missedGainPct: number;    // Gain we missed by exiting early
}

interface TuneProposal {
  param: keyof TunableParams;
  oldValue: number;
  newValue: number;
  reason: string;
  pattern: LossPattern;
  affectedTrades: number;
}

interface BacktestResult {
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  tradeCount: number;
  avgHoldSec: number;
  maxDrawdown: number;
  sharpeApprox: number;  // Simplified Sharpe
}

// ━━━ AutoTuner ━━━

export class AutoTuner {
  private pool: Pool;
  private params: TunableParams;
  private completedTradeCount = 0;
  private tuneEveryN: number;
  public _lastTuneAt = 0;
  private logPath: string;
  private minTrades: number;

  constructor(pool: Pool, options?: { tuneEveryN?: number; minTrades?: number }) {
    this.pool = pool;
    this.params = { ...CURRENT_PARAMS };
    this.tuneEveryN = options?.tuneEveryN ?? 10;
    this.minTrades = options?.minTrades ?? 10;
    this.logPath = './data/autotuner.log';

    logger.info({
      tuneEvery: this.tuneEveryN,
      minTrades: this.minTrades,
      params: Object.keys(this.params).length,
    }, '🧬 AutoTuner initialized');
  }

  /** Current active parameters */
  getParams(): TunableParams { return { ...this.params }; }

  /** Call this after every completed trade (BUY→SELL pair) */
  async onTradeCompleted(token: string, pnlPct: number, _exitReason: string): Promise<void> {
    this.completedTradeCount++;

    logger.debug({
      trade: this.completedTradeCount,
      nextTune: this.tuneEveryN - (this.completedTradeCount % this.tuneEveryN),
      token: token.slice(0, 8),
      pnl: pnlPct.toFixed(1) + '%',
    }, '🧬 Trade registered');

    if (this.completedTradeCount % this.tuneEveryN === 0 &&
        this.completedTradeCount >= this.minTrades) {
      await this.runTuningCycle();
    }
  }

  /** Force a tuning cycle (can be called manually or via API) */
  async runTuningCycle(): Promise<{ applied: TuneProposal[]; rejected: TuneProposal[] }> {
    const cycleStart = Date.now();
    logger.info({ tradeCount: this.completedTradeCount }, '🧬 ═══ AutoTuner cycle START ═══');

    try {
      // Step 1: Analyze recent trades
      const trades = await this.analyzeRecentTrades();
      if (trades.length < this.minTrades) {
        logger.info({ trades: trades.length, min: this.minTrades }, '🧬 Not enough trades for tuning');
        return { applied: [], rejected: [] };
      }

      // Step 2: Identify loss patterns
      const patterns = this.identifyPatterns(trades);
      logger.info({
        trades: trades.length,
        wins: trades.filter(t => t.pnlPct > 0).length,
        losses: trades.filter(t => t.pnlPct <= 0).length,
        patterns: Object.entries(patterns).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`),
      }, '🧬 Pattern analysis');

      // Step 3: Generate proposals
      const proposals = this.generateProposals(trades, patterns);
      if (proposals.length === 0) {
        logger.info('🧬 No parameter changes proposed — strategy OK');
        return { applied: [], rejected: [] };
      }

      // Step 4: Backtest each proposal
      const applied: TuneProposal[] = [];
      const rejected: TuneProposal[] = [];

      const baselineResult = await this.backtestParams(this.params);
      logger.info({
        winRate: (baselineResult.winRate * 100).toFixed(1) + '%',
        avgPnl: baselineResult.avgPnl.toFixed(1) + '%',
        trades: baselineResult.tradeCount,
      }, '🧬 Baseline backtest');

      for (const proposal of proposals) {
        const testParams = { ...this.params, [proposal.param]: proposal.newValue };
        const testResult = await this.backtestParams(testParams);

        const improved =
          testResult.winRate > baselineResult.winRate * 1.02 ||  // 2% better WR
          testResult.avgPnl > baselineResult.avgPnl * 1.05 ||   // 5% better avg P&L
          (testResult.winRate >= baselineResult.winRate && testResult.totalPnl > baselineResult.totalPnl * 1.03); // Same WR but more total P&L

        if (improved) {
          logger.info({
            param: proposal.param,
            old: proposal.oldValue,
            new: proposal.newValue,
            reason: proposal.reason,
            wr: `${(baselineResult.winRate*100).toFixed(1)}→${(testResult.winRate*100).toFixed(1)}%`,
            pnl: `${baselineResult.avgPnl.toFixed(1)}→${testResult.avgPnl.toFixed(1)}%`,
          }, '✅ ACCEPTED — backtest improved');

          this.params[proposal.param] = proposal.newValue;
          applied.push(proposal);

          await this.logCalibration(proposal, baselineResult, testResult, true);
        } else {
          logger.info({
            param: proposal.param,
            old: proposal.oldValue,
            new: proposal.newValue,
            wr: `${(baselineResult.winRate*100).toFixed(1)}→${(testResult.winRate*100).toFixed(1)}%`,
            pnl: `${baselineResult.avgPnl.toFixed(1)}→${testResult.avgPnl.toFixed(1)}%`,
          }, '❌ REJECTED — no improvement');

          rejected.push(proposal);
          await this.logCalibration(proposal, baselineResult, testResult, false);
        }
      }

      // Step 5: If any params changed, write them out
      if (applied.length > 0) {
        await this.applyParamsToCode(applied);
        await this.logTuneEvent(trades, patterns, applied, rejected);
      }

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      logger.info({
        applied: applied.length,
        rejected: rejected.length,
        elapsed: elapsed + 's',
      }, '🧬 ═══ AutoTuner cycle DONE ═══');

      this._lastTuneAt = Date.now();
      return { applied, rejected };

    } catch (err: any) {
      logger.error({ error: err.message }, '🧬 AutoTuner cycle FAILED');
      return { applied: [], rejected: [] };
    }
  }

  // ━━━ STEP 1: Analyze trades from paper log + DB ━━━

  private async analyzeRecentTrades(): Promise<TradeAnalysis[]> {
    // Read paper trade log and extract BUY→SELL pairs
    const trades: TradeAnalysis[] = [];

    try {
      const logContent = await fs.readFile('./data/paper-trades.log', 'utf-8');
      const lines = logContent.trim().split('\n').filter(l => l.length > 0);
      const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

      // Build BUY→SELL pairs
      const openBuys = new Map<string, any>();

      for (const entry of entries) {
        if (entry.action === 'BUY') {
          openBuys.set(entry.token, entry);
        } else if (entry.action === 'SELL' && openBuys.has(entry.token)) {
          const buy = openBuys.get(entry.token)!;
          openBuys.delete(entry.token);

          const entryMC = buy.current_mc;
          const exitMC = entry.current_mc;
          const pnl = entryMC > 0 ? ((exitMC - entryMC) / entryMC * 100) : 0;

          // Get peak/post-exit data from DB
          const dbData = await this.getTokenDBData(entry.token);
          const isClean = buy.reason?.includes('CLEAN') || false;

          trades.push({
            token: entry.token,
            entryTime: buy.timestamp,
            exitTime: entry.timestamp,
            entryMC,
            exitMC,
            peakMC: dbData.peakMC,
            pnlPct: pnl,
            holdSec: (new Date(entry.timestamp).getTime() - new Date(buy.timestamp).getTime()) / 1000,
            exitReason: entry.reason || '',
            isClean,
            entryRatio: dbData.entryRatio,
            peakAfterExit: dbData.peakAfterExit,
            patterns: [],
            missedGainPct: 0,
          });
        }
      }

      // Calculate missed gains
      for (const t of trades) {
        if (t.peakAfterExit > t.exitMC) {
          t.missedGainPct = ((t.peakAfterExit - t.entryMC) / t.entryMC * 100) - t.pnlPct;
        }
      }

      return trades;
    } catch (err) {
      logger.error({ error: err }, 'Failed to analyze trades');
      return [];
    }
  }

  private async getTokenDBData(tokenAddress: string): Promise<{
    peakMC: number; entryRatio: number; peakAfterExit: number;
  }> {
    try {
      const r = await this.pool.query(`
        SELECT
          te.peak_mc,
          te.fdv_at_detection,
          COALESCE(te.peak_mc, te.fdv_at_check) as peak_after_exit,
          CASE WHEN te.fdv_at_detection > 0 THEN te.fdv_at_check / te.fdv_at_detection ELSE 1 END as entry_ratio
        FROM token_events te
        WHERE te.token_address = $1
        LIMIT 1
      `, [tokenAddress]);

      if (r.rows.length > 0) {
        return {
          peakMC: r.rows[0].peak_mc ?? 0,
          entryRatio: r.rows[0].entry_ratio ?? 1,
          peakAfterExit: r.rows[0].peak_after_exit ?? 0,
        };
      }
    } catch { /* ignore */ }
    return { peakMC: 0, entryRatio: 1, peakAfterExit: 0 };
  }

  // ━━━ STEP 2: Identify loss patterns ━━━

  private identifyPatterns(trades: TradeAnalysis[]): Record<LossPattern, number> {
    const counts: Record<LossPattern, number> = {
      SPIKE_BUY: 0, EARLY_EXIT: 0, NO_PUMP_KILL: 0, CASCADE_FALSE: 0,
      HARD_STOP_TIGHT: 0, LATE_ENTRY: 0, LOW_QUALITY: 0, UNKNOWN: 0,
    };

    for (const t of trades) {
      if (t.pnlPct >= 0) continue; // Only analyze losses

      // SPIKE_BUY: entered at high ratio, quick loss
      if (t.entryRatio > 1.3 && t.holdSec < 15) {
        t.patterns.push('SPIKE_BUY');
        counts.SPIKE_BUY++;
      }

      // HARD_STOP_TIGHT: hit hard stop but token recovered
      if (t.exitReason.includes('HARD STOP') && t.peakAfterExit > t.entryMC * 1.1) {
        t.patterns.push('HARD_STOP_TIGHT');
        counts.HARD_STOP_TIGHT++;
      }

      // CASCADE_FALSE: cascade exit but token pumped
      if (t.exitReason.includes('CASCADE') && t.peakAfterExit > t.entryMC * 1.2) {
        t.patterns.push('CASCADE_FALSE');
        counts.CASCADE_FALSE++;
      }

      // NO_PUMP_KILL: no pump exit but token eventually pumped
      if (t.exitReason.includes('NO PUMP') && t.peakAfterExit > t.entryMC * 1.15) {
        t.patterns.push('NO_PUMP_KILL');
        counts.NO_PUMP_KILL++;
      }

      // LOW_QUALITY: token never showed any life
      if (t.peakMC < t.entryMC * 1.03 && t.peakAfterExit < t.entryMC * 1.05) {
        t.patterns.push('LOW_QUALITY');
        counts.LOW_QUALITY++;
      }

      if (t.patterns.length === 0) {
        t.patterns.push('UNKNOWN');
        counts.UNKNOWN++;
      }
    }

    // Check wins for EARLY_EXIT
    for (const t of trades) {
      if (t.pnlPct > 0 && t.missedGainPct > t.pnlPct * 2) {
        t.patterns.push('EARLY_EXIT');
        counts.EARLY_EXIT++;
      }
    }

    return counts;
  }

  // ━━━ STEP 3: Generate param proposals ━━━

  private generateProposals(trades: TradeAnalysis[], patterns: Record<LossPattern, number>): TuneProposal[] {
    const proposals: TuneProposal[] = [];
    const total = trades.length;
    const losses = trades.filter(t => t.pnlPct < 0);

    // SPIKE_BUY is dominant → increase observe time or decrease max ratio
    if (patterns.SPIKE_BUY >= 2 && patterns.SPIKE_BUY / losses.length > 0.25) {
      const spikeAvgHold = trades
        .filter(t => t.patterns.includes('SPIKE_BUY'))
        .reduce((s, t) => s + t.holdSec, 0) / patterns.SPIKE_BUY;

      // If entries happening at T+8-12, we need more observe time
      if (this.params.clean_observe_sec < 15) {
        proposals.push({
          param: 'clean_observe_sec',
          oldValue: this.params.clean_observe_sec,
          newValue: Math.min(this.params.clean_observe_sec + 3, 20),
          reason: `${patterns.SPIKE_BUY} spike buys, avg hold ${spikeAvgHold.toFixed(0)}s before loss`,
          pattern: 'SPIKE_BUY',
          affectedTrades: patterns.SPIKE_BUY,
        });
      }

      if (this.params.clean_max_ratio > 1.2) {
        proposals.push({
          param: 'clean_max_ratio',
          oldValue: this.params.clean_max_ratio,
          newValue: Math.max(this.params.clean_max_ratio - 0.2, 1.1),
          reason: `Spike entries at high ratio, lowering cap`,
          pattern: 'SPIKE_BUY',
          affectedTrades: patterns.SPIKE_BUY,
        });
      }
    }

    // HARD_STOP_TIGHT → widen hard stop
    if (patterns.HARD_STOP_TIGHT >= 2) {
      const cleanHits = trades.filter(t => t.patterns.includes('HARD_STOP_TIGHT') && t.isClean).length;
      const ruggerHits = trades.filter(t => t.patterns.includes('HARD_STOP_TIGHT') && !t.isClean).length;

      if (cleanHits >= 1 && this.params.clean_hard_stop < 0.40) {
        proposals.push({
          param: 'clean_hard_stop',
          oldValue: this.params.clean_hard_stop,
          newValue: Math.min(this.params.clean_hard_stop + 0.05, 0.40),
          reason: `${cleanHits} clean tokens hit hard stop then recovered`,
          pattern: 'HARD_STOP_TIGHT',
          affectedTrades: cleanHits,
        });
      }
      if (ruggerHits >= 1 && this.params.rugger_hard_stop < 0.30) {
        proposals.push({
          param: 'rugger_hard_stop',
          oldValue: this.params.rugger_hard_stop,
          newValue: Math.min(this.params.rugger_hard_stop + 0.05, 0.30),
          reason: `${ruggerHits} rugger tokens hit hard stop then recovered`,
          pattern: 'HARD_STOP_TIGHT',
          affectedTrades: ruggerHits,
        });
      }
    }

    // CASCADE_FALSE → raise cascade threshold
    if (patterns.CASCADE_FALSE >= 1) {
      const cleanCasc = trades.filter(t => t.patterns.includes('CASCADE_FALSE') && t.isClean).length;
      if (cleanCasc >= 1 && this.params.clean_cascade_thresh < 12) {
        proposals.push({
          param: 'clean_cascade_thresh',
          oldValue: this.params.clean_cascade_thresh,
          newValue: this.params.clean_cascade_thresh + 2,
          reason: `${cleanCasc} false cascade exits on clean wallets`,
          pattern: 'CASCADE_FALSE',
          affectedTrades: cleanCasc,
        });
      }
    }

    // NO_PUMP_KILL → extend timeout
    if (patterns.NO_PUMP_KILL >= 2) {
      const cleanNP = trades.filter(t => t.patterns.includes('NO_PUMP_KILL') && t.isClean).length;
      if (cleanNP >= 1 && this.params.clean_nopump_sec < 75) {
        proposals.push({
          param: 'clean_nopump_sec',
          oldValue: this.params.clean_nopump_sec,
          newValue: Math.min(this.params.clean_nopump_sec + 10, 90),
          reason: `${cleanNP} clean tokens killed by NO PUMP but pumped later`,
          pattern: 'NO_PUMP_KILL',
          affectedTrades: cleanNP,
        });
      }
    }

    // EARLY_EXIT dominant → loosen trailing stop or extend maxhold
    if (patterns.EARLY_EXIT >= 3 && patterns.EARLY_EXIT / total > 0.2) {
      const avgMissed = trades
        .filter(t => t.patterns.includes('EARLY_EXIT'))
        .reduce((s, t) => s + t.missedGainPct, 0) / patterns.EARLY_EXIT;

      if (avgMissed > 20 && this.params.trailing_drop_pct < 0.35) {
        proposals.push({
          param: 'trailing_drop_pct',
          oldValue: this.params.trailing_drop_pct,
          newValue: Math.min(this.params.trailing_drop_pct + 0.05, 0.40),
          reason: `Avg missed gain ${avgMissed.toFixed(0)}% — need wider trailing`,
          pattern: 'EARLY_EXIT',
          affectedTrades: patterns.EARLY_EXIT,
        });
      }
    }

    // LOW_QUALITY dominant → tighten entry filters
    if (patterns.LOW_QUALITY >= 3 && patterns.LOW_QUALITY / losses.length > 0.3) {
      if (this.params.clean_min_buys < 5) {
        proposals.push({
          param: 'clean_min_buys',
          oldValue: this.params.clean_min_buys,
          newValue: this.params.clean_min_buys + 1,
          reason: `${patterns.LOW_QUALITY} low-quality entries — need more buy confirmation`,
          pattern: 'LOW_QUALITY',
          affectedTrades: patterns.LOW_QUALITY,
        });
      }
      if (this.params.clean_min_vol < 250) {
        proposals.push({
          param: 'clean_min_vol',
          oldValue: this.params.clean_min_vol,
          newValue: this.params.clean_min_vol + 50,
          reason: `Low quality entries — need higher volume threshold`,
          pattern: 'LOW_QUALITY',
          affectedTrades: patterns.LOW_QUALITY,
        });
      }
    }

    return proposals;
  }

  // ━━━ STEP 4: Backtest against historical data ━━━

  private async backtestParams(params: TunableParams): Promise<BacktestResult> {
    // Simulate entry + exit on ALL historical token_events
    // where the creator wallet is RIDE-classified
    try {
      const r = await this.pool.query(`
        WITH ride_tokens AS (
          SELECT
            te.token_address,
            te.creator_wallet,
            te.fdv_at_detection as baseline_mc,
            te.fdv_at_check as entry_mc,
            te.peak_mc,
            te.time_to_peak_sec,
            te.time_to_rug_sec,
            te.buy_wallet_count,
            te.total_buy_vol_usd,
            te.cascade_score,
            te.unique_traders,
            wp.rug_count,
            wp.survival_count,
            wp.strategy,
            CASE WHEN wp.rug_count = 0 AND wp.survival_count >= 3 THEN true ELSE false END as is_clean,
            CASE
              WHEN te.fdv_at_detection > 0 THEN te.fdv_at_check / te.fdv_at_detection
              ELSE 1
            END as mc_ratio,
            CASE
              WHEN te.peak_mc IS NOT NULL AND te.fdv_at_check > 0
              THEN ((te.peak_mc - te.fdv_at_check) / te.fdv_at_check * 100)
              ELSE 0
            END as max_pnl_pct
          FROM token_events te
          JOIN wallet_profiles wp ON wp.wallet_address = te.creator_wallet
          WHERE wp.strategy IN ('RIDE', 'RIDE_v2', 'CLEAN_RIDE')
            AND te.fdv_at_detection > 0
            AND te.tracking_complete = true
        )
        SELECT
          is_clean,
          mc_ratio,
          max_pnl_pct,
          buy_wallet_count,
          total_buy_vol_usd,
          time_to_peak_sec,
          time_to_rug_sec,
          cascade_score,
          unique_traders,
          baseline_mc,
          entry_mc,
          peak_mc
        FROM ride_tokens
      `);

      const rows = r.rows;
      if (rows.length === 0) return { winRate: 0, avgPnl: 0, totalPnl: 0, tradeCount: 0, avgHoldSec: 0, maxDrawdown: 0, sharpeApprox: 0 };

      // Simulate with params
      let wins = 0;
      let totalPnl = 0;
      let totalHold = 0;
      let traded = 0;
      let maxDD = 0;
      const pnls: number[] = [];

      for (const row of rows) {
        const isClean = row.is_clean;
        const ratio = parseFloat(row.mc_ratio);
        const buys = parseInt(row.buy_wallet_count) || 0;
        const vol = parseFloat(row.total_buy_vol_usd) || 0;
        const peakSec = parseFloat(row.time_to_peak_sec) || 0;
        const rugSec = parseFloat(row.time_to_rug_sec) || 999;
        const maxPnl = parseFloat(row.max_pnl_pct) || 0;
        const cascScore = parseFloat(row.cascade_score) || 0;

        // Simulate ENTRY filter
        if (isClean) {
          if (ratio > params.clean_max_ratio) continue;
          if (buys < params.clean_min_buys) continue;
          if (vol < params.clean_min_vol) continue;
        } else {
          if (buys < params.rugger_min_buyers) continue;
        }

        // We would have entered — simulate EXIT
        traded++;
        const grace = isClean ? params.clean_grace_sec : params.rugger_grace_sec;
        const hardStop = isClean ? params.clean_hard_stop : params.rugger_hard_stop;
        const noPumpSec = isClean ? params.clean_nopump_sec : params.rugger_nopump_sec;
        const noPumpThresh = (isClean ? params.clean_nopump_thresh : params.rugger_nopump_thresh) * 100;
        const maxHold = isClean ? params.clean_maxhold_sec : params.rugger_maxhold_sec;
        const cascThresh = isClean ? params.clean_cascade_thresh : params.rugger_cascade_thresh;

        let exitPnl: number;
        let holdSec: number;

        // Token pumped enough and we'd have caught some
        if (maxPnl > noPumpThresh) {
          // Estimate exit: trailing stop from peak or max hold
          const trailingExit = maxPnl * (1 - params.trailing_drop_pct);

          // If peak happens after maxHold, we exit at maxHold with partial gains
          if (peakSec > maxHold) {
            exitPnl = maxPnl * (maxHold / peakSec) * 0.7; // Partial capture
            holdSec = maxHold;
          }
          // Breakeven protection: if we had > breakeven_peak_thresh and it crashed
          else if (maxPnl > params.breakeven_peak_thresh * 100 && rugSec < peakSec + 30) {
            exitPnl = Math.max(0, trailingExit * 0.5); // Breakeven exit
            holdSec = rugSec;
          }
          // Normal trailing exit
          else {
            exitPnl = trailingExit;
            holdSec = Math.min(peakSec + 5, maxHold);
          }
        }
        // No pump — either NO PUMP exit or HARD STOP
        else if (peakSec < noPumpSec) {
          // Token peaked quickly then died — hard stop
          exitPnl = Math.max(-hardStop * 100, maxPnl - 10); // Some loss
          holdSec = Math.min(noPumpSec, rugSec);
        }
        // Dead token
        else {
          exitPnl = -hardStop * 100 * 0.5; // Average loss
          holdSec = noPumpSec;
        }

        // Cascade hit — tokens with high cascade score
        if (cascScore > cascThresh && maxPnl < 15) {
          exitPnl = Math.min(exitPnl, -10); // Cascade exit at loss
          holdSec = Math.min(holdSec, grace + 5);
        }

        pnls.push(exitPnl);
        totalPnl += exitPnl;
        totalHold += holdSec;
        if (exitPnl > 0) wins++;
        maxDD = Math.min(maxDD, exitPnl);
      }

      // Sharpe approximation
      const avgPnl = traded > 0 ? totalPnl / traded : 0;
      const variance = traded > 0
        ? pnls.reduce((s, p) => s + (p - avgPnl) ** 2, 0) / traded
        : 1;
      const stdDev = Math.sqrt(variance) || 1;
      const sharpe = avgPnl / stdDev;

      return {
        winRate: traded > 0 ? wins / traded : 0,
        avgPnl,
        totalPnl,
        tradeCount: traded,
        avgHoldSec: traded > 0 ? totalHold / traded : 0,
        maxDrawdown: maxDD,
        sharpeApprox: sharpe,
      };
    } catch (err: any) {
      logger.error({ error: err.message }, 'Backtest query failed');
      return { winRate: 0, avgPnl: 0, totalPnl: 0, tradeCount: 0, avgHoldSec: 0, maxDrawdown: 0, sharpeApprox: 0 };
    }
  }

  // ━━━ STEP 5: Apply params to TradeExecutor at runtime ━━━

  private async applyParamsToCode(applied: TuneProposal[]): Promise<void> {
    // Write params to a JSON file that TradeExecutor reads on each cycle
    const paramFile = './data/tuned-params.json';
    try {
      await fs.writeFile(paramFile, JSON.stringify({
        version: Date.now(),
        updated_at: new Date().toISOString(),
        trade_count: this.completedTradeCount,
        params: this.params,
        last_changes: applied.map(a => ({
          param: a.param,
          old: a.oldValue,
          new: a.newValue,
          reason: a.reason,
        })),
      }, null, 2));

      logger.info({ file: paramFile, changes: applied.length }, '🧬 Tuned params written');
    } catch (err) {
      logger.error({ error: err }, 'Failed to write tuned params');
    }
  }

  // ━━━ LOGGING ━━━

  private async logCalibration(
    proposal: TuneProposal,
    baseline: BacktestResult,
    test: BacktestResult,
    accepted: boolean
  ): Promise<void> {
    try {
      const improvement = baseline.avgPnl !== 0
        ? ((test.avgPnl - baseline.avgPnl) / Math.abs(baseline.avgPnl) * 100)
        : 0;

      await this.pool.query(`
        INSERT INTO calibration_log (param_name, old_value, new_value, improvement_pct, tokens_evaluated, accepted)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [proposal.param, proposal.oldValue, proposal.newValue, improvement, test.tradeCount, accepted]);
    } catch { /* ignore */ }
  }

  private async logTuneEvent(
    trades: TradeAnalysis[],
    patterns: Record<LossPattern, number>,
    applied: TuneProposal[],
    rejected: TuneProposal[]
  ): Promise<void> {
    const event = {
      timestamp: new Date().toISOString(),
      trade_count: this.completedTradeCount,
      analyzed: trades.length,
      win_rate: (trades.filter(t => t.pnlPct > 0).length / trades.length * 100).toFixed(1) + '%',
      patterns,
      applied: applied.map(a => ({ param: a.param, old: a.oldValue, new: a.newValue })),
      rejected: rejected.map(r => ({ param: r.param, old: r.oldValue, new: r.newValue })),
    };

    try {
      await fs.appendFile(this.logPath, JSON.stringify(event) + '\n');
    } catch { /* ignore */ }
  }
}
