import type { Pool } from 'pg';
import type { TokenEvent, RuggerPlaybook } from '../types/index.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { logger } from '../utils/logger.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';

/**
 * PlaybookBuilder — Phase 3 of v4.0 "Ride the Rugger" (v9.0 strategy overhaul)
 *
 * Analyzes all RUG tokens from a wallet and builds a predictive playbook
 * with temporal windows (entry, exit, short) and consistency scoring.
 *
 * Strategy logic (v9.0 — backtest-validated 2026-03-12):
 * - CLEAN_RIDE (→RIDE): rug_count=0 AND survival_count>=3 (100% pump rate on 51 tokens)
 * - RIDE: (consistency>=0.7 + samples>=5 + pump>=1.5x + survival>=1) OR
 *         (pump_x>=2.0 + samples>=3 + peak>=2000 + survival>=1) (37.1% pump rate)
 * - FADE: consistency>=0.6 + samples>=5 + pump>=1.5x + rug_rate<=0.90 (25.6% pump rate)
 * - AVOID: peak_mc<500 OR avg_time_to_rug<3min OR rug_rate>0.95
 * - WATCH: insufficient data or low consistency
 */
export class PlaybookBuilder {
  private walletRepo: WalletRepo;

  constructor(pool: Pool) {
    this.walletRepo = new WalletRepo(pool);
  }

  /**
   * Build a rugger playbook for a wallet based on its RUG history.
   * Returns null if insufficient data (< 3 rugs with complete lifecycle data).
   */
  async buildPlaybook(walletAddress: string): Promise<RuggerPlaybook | null> {
    try {
      logger.info({ wallet: walletAddress }, 'Building rugger playbook');

      // v9.0: Check for CLEAN_RIDE BEFORE rug data — clean wallets have 0 rugs
      const walletProfileEarly = await this.walletRepo.getByAddress(walletAddress);
      if ((walletProfileEarly?.rug_count ?? 0) === 0 && (walletProfileEarly?.survival_count ?? 0) >= 3) {
        logger.info({
          wallet: walletAddress,
          survivalCount: walletProfileEarly!.survival_count,
        }, '🌟 CLEAN_RIDE — clean wallet with proven success, setting RIDE strategy');
        // No playbook to build (no rug data), but set strategy to RIDE
        await this.walletRepo.updateStrategy(walletAddress, 'RIDE');
        // Return a minimal playbook marker
        const minimalPlaybook: RuggerPlaybook = {
          sample_size: 0,
          recommended_strategy: 'RIDE',
          consistency_score: 1.0,
          avg_time_to_peak_min: 0, std_time_to_peak_min: 0,
          avg_time_to_rug_min: 0, std_time_to_rug_min: 0,
          avg_peak_duration_min: 0, std_peak_duration_min: 0,
          avg_time_to_peak_sec: null, std_time_to_peak_sec: null,
          avg_time_to_rug_sec: null, std_time_to_rug_sec: null,
          avg_first_sell_delay_sec: null, avg_rug_duration_sec: null,
          consistency_score_sec: null,
          avg_peak_mc: 0, std_peak_mc: 0,
          avg_pump_multiple: 1.0, avg_pump_speed_mc_per_sec: null,
          avg_dump_speed: 0, avg_liquidity_at_peak: 0,
          avg_total_buy_vol_usd: null, avg_total_sell_vol_usd: null,
          avg_buy_sell_ratio: null, avg_largest_sell_pct: null,
          avg_buy_wallet_count: null, avg_sell_wallet_count: null,
          creator_sold_rate: null, avg_top_buyer_pct: null, avg_top_seller_pct: null,
          micro_buy_rate: null, avg_cascade_score: null, avg_pump_dump_speed_ratio: null,
          entry_window_end_min: 5, exit_window_start_min: 0,
          exit_window_end_min: 10, short_window_start_min: 0, short_window_end_min: 5,
        };
        await this.walletRepo.updatePlaybook(walletAddress, minimalPlaybook);
        return minimalPlaybook;
      }

      // Get all RUG tokens with complete lifecycle data
      const rugs = await this.getRugsWithLifecycleData(walletAddress);

      if (rugs.length < 3) {
        logger.debug({ wallet: walletAddress, rugCount: rugs.length }, 'Insufficient RUG data for playbook');
        return null;
      }

      // ── Legacy metrics (minutes, snapshot-based) ──────────────
      const timesToPeak = rugs.map(r => r.time_to_peak_min!);
      const peakMCs = rugs.map(r => r.peak_mc!);
      const timesToRug = rugs.map(r => r.time_to_rug_min!);
      const dumpSpeeds = rugs.filter(r => r.dump_speed_pct_per_min !== null).map(r => r.dump_speed_pct_per_min!);
      const liquiditiesAtPeak = rugs.filter(r => r.liquidity_at_peak !== null).map(r => r.liquidity_at_peak!);
      const peakDurations = rugs.filter(r => r.peak_duration_min !== null).map(r => r.peak_duration_min!);

      // ── v4.4 Trade-level metrics (seconds, tick-precision) ────
      const timesToPeakSec   = rugs.filter(r => (r as any).time_to_peak_sec != null).map(r => (r as any).time_to_peak_sec as number);
      const timesToRugSec    = rugs.filter(r => (r as any).time_to_rug_sec != null).map(r => (r as any).time_to_rug_sec as number);
      const firstSellDelays  = rugs.filter(r => (r as any).first_sell_delay_sec != null).map(r => (r as any).first_sell_delay_sec as number);
      const rugDurations     = rugs.filter(r => (r as any).rug_duration_sec != null).map(r => (r as any).rug_duration_sec as number);
      const pumpSpeeds       = rugs.filter(r => (r as any).pump_speed_mc_per_sec != null).map(r => (r as any).pump_speed_mc_per_sec as number);
      const buyWalletCounts  = rugs.filter(r => (r as any).buy_wallet_count != null).map(r => (r as any).buy_wallet_count as number);
      const sellWalletCounts = rugs.filter(r => (r as any).sell_wallet_count != null).map(r => (r as any).sell_wallet_count as number);
      const buySellRatios    = rugs.filter(r => (r as any).buy_sell_ratio != null).map(r => (r as any).buy_sell_ratio as number);
      const largestSellPcts  = rugs.filter(r => (r as any).largest_sell_pct != null).map(r => (r as any).largest_sell_pct as number);
      const buyVols          = rugs.filter(r => (r as any).total_buy_vol_usd != null).map(r => (r as any).total_buy_vol_usd as number);
      const sellVols         = rugs.filter(r => (r as any).total_sell_vol_usd != null).map(r => (r as any).total_sell_vol_usd as number);
      const topBuyerPcts     = rugs.filter(r => (r as any).top_buyer_pct != null).map(r => (r as any).top_buyer_pct as number);
      const topSellerPcts    = rugs.filter(r => (r as any).top_seller_pct != null).map(r => (r as any).top_seller_pct as number);
      const cascadeScores    = rugs.filter(r => (r as any).cascade_score != null).map(r => (r as any).cascade_score as number);
      const pumpDumpRatios   = rugs.filter(r => (r as any).pump_dump_speed_ratio != null).map(r => (r as any).pump_dump_speed_ratio as number);
      const creatorSoldCount = rugs.filter(r => (r as any).creator_sold === true).length;
      const microBuyCount    = rugs.filter(r => (r as any).micro_buy_pattern === true).length;
      // v4.3 — Pump multiple: ratio peak_mc / fdv_at_detection (true entry MC)
      const pumpMultiples = rugs
        .filter(r => r.peak_mc !== null && r.peak_mc > 0)
        .map(r => {
          // Fix #1: use fdv_at_detection (first snapshot FDV) as true entry price
          const entryMC = (r.fdv_at_detection && r.fdv_at_detection > 0 && r.fdv_at_detection < r.peak_mc!)
            ? r.fdv_at_detection
            : (r.fdv_at_check && r.fdv_at_check > 0 && r.fdv_at_check < r.peak_mc!)
            ? r.fdv_at_check // fallback to fdv_at_check if detection not stored
            : null;
          if (!entryMC) return null; // skip if no entry MC available
          return r.peak_mc! / entryMC;
        })
        .filter((m): m is number => m !== null && m > 1.0); // only real pumps

      // ── Legacy aggregates ──────────────────────────────────────
      const avgTimeToPeak = this.mean(timesToPeak);
      const stdTimeToPeak = this.stdDev(timesToPeak);
      const avgPeakMC = this.mean(peakMCs);
      const stdPeakMC = this.stdDev(peakMCs);
      const avgTimeToRug = this.mean(timesToRug);
      const stdTimeToRug = this.stdDev(timesToRug);
      const avgDumpSpeed = dumpSpeeds.length > 0 ? this.mean(dumpSpeeds) : 0;
      const avgLiquidityAtPeak = liquiditiesAtPeak.length > 0 ? this.mean(liquiditiesAtPeak) : 0;
      const avgPeakDuration = peakDurations.length > 0 ? this.mean(peakDurations) : 0;
      const stdPeakDuration = peakDurations.length > 0 ? this.stdDev(peakDurations) : 0;
      // No fallback: if no real pumps found, avgPumpMultiple = 1.0 (no pump)
      // This ensures determineStrategy() correctly returns WATCH instead of RIDE
      const avgPumpMultiple = pumpMultiples.length > 0 ? this.mean(pumpMultiples) : 1.0;
      const consistencyScore = this.computeConsistency(timesToRug);

      // ── v4.4 Trade-level aggregates ────────────────────────────
      const avgTimeToPeakSec   = timesToPeakSec.length   > 0 ? this.mean(timesToPeakSec)   : null;
      const stdTimeToPeakSec   = timesToPeakSec.length   > 0 ? this.stdDev(timesToPeakSec)  : null;
      const avgTimeToRugSec    = timesToRugSec.length     > 0 ? this.mean(timesToRugSec)     : null;
      const stdTimeToRugSec    = timesToRugSec.length     > 0 ? this.stdDev(timesToRugSec)   : null;
      const avgFirstSellDelay  = firstSellDelays.length   > 0 ? this.mean(firstSellDelays)   : null;
      const avgRugDurationSec  = rugDurations.length      > 0 ? this.mean(rugDurations)      : null;
      const avgPumpSpeedMcSec  = pumpSpeeds.length        > 0 ? this.mean(pumpSpeeds)        : null;
      const avgBuyWallets      = buyWalletCounts.length   > 0 ? this.mean(buyWalletCounts)   : null;
      const avgSellWallets     = sellWalletCounts.length  > 0 ? this.mean(sellWalletCounts)  : null;
      const avgBuySellRatio    = buySellRatios.length     > 0 ? this.mean(buySellRatios)     : null;
      const avgLargestSellPct  = largestSellPcts.length   > 0 ? this.mean(largestSellPcts)   : null;
      const avgBuyVol          = buyVols.length           > 0 ? this.mean(buyVols)           : null;
      const avgSellVol         = sellVols.length          > 0 ? this.mean(sellVols)          : null;
      const avgTopBuyerPct     = topBuyerPcts.length      > 0 ? this.mean(topBuyerPcts)      : null;
      const avgTopSellerPct    = topSellerPcts.length     > 0 ? this.mean(topSellerPcts)     : null;
      const avgCascadeScore    = cascadeScores.length     > 0 ? this.mean(cascadeScores)     : null;
      const avgPumpDumpRatio   = pumpDumpRatios.length    > 0 ? this.mean(pumpDumpRatios)    : null;
      const creatorSoldRate    = rugs.length              > 0 ? creatorSoldCount / rugs.length : null;
      const microBuyRate       = rugs.length              > 0 ? microBuyCount / rugs.length  : null;
      // Consistency on seconds (more precise than minutes)
      const consistencyScoreSec = timesToRugSec.length >= 3 ? this.computeConsistency(timesToRugSec) : null;

      // Temporal windows
      // v4.4: Entry window = peak + 1σ (old formula gave 0 because peak is ~15s with std>15s)
      const entryWindowEnd = Math.max(0.5, avgTimeToPeak + stdTimeToPeak);
      const exitWindowStart = Math.max(0, avgTimeToRug - stdTimeToRug);
      const exitWindowEnd = avgTimeToRug;
      const shortWindowStart = avgTimeToPeak;
      const shortWindowEnd = Math.max(avgTimeToPeak, avgTimeToRug - 0.5 * stdTimeToRug);

      // Get wallet profile for survival/rug data (v9.0)
      const walletProfile = await this.walletRepo.getByAddress(walletAddress);
      const survivalCount = walletProfile?.survival_count ?? 0;
      const rugRate = walletProfile?.rug_rate ?? 1.0;

      // v9.0: CLEAN_RIDE — wallets with 0 rugs and proven track record
      // Backtest: 100% pump rate on 51 tokens, avg P&L +50%
      const isCleanRide = (walletProfile?.rug_count ?? 0) === 0 && survivalCount >= 3;
      if (isCleanRide) {
        logger.info({
          wallet: walletAddress,
          survivalCount,
          sampleSize: rugs.length,
        }, '🌟 CLEAN_RIDE — clean wallet with proven success, forcing RIDE');
      }

      // Determine strategy with v9.0 rules (CLEAN_RIDE overrides below)
      const recommendedStrategy = this.determineStrategy(
        consistencyScore,
        rugs.length,
        avgTimeToRug,
        avgPeakMC,
        avgPumpMultiple,
        survivalCount,
        rugRate
      );

      // v9.0: CLEAN_RIDE override — force RIDE regardless of determineStrategy result
      const finalStrategy = isCleanRide ? 'RIDE' as const : recommendedStrategy;

      const playbook: RuggerPlaybook = {
        // Core
        sample_size: rugs.length,
        recommended_strategy: finalStrategy,
        consistency_score: consistencyScore,

        // Timing — minutes (legacy)
        avg_time_to_peak_min: avgTimeToPeak,
        std_time_to_peak_min: stdTimeToPeak,
        avg_time_to_rug_min: avgTimeToRug,
        std_time_to_rug_min: stdTimeToRug,
        avg_peak_duration_min: avgPeakDuration,
        std_peak_duration_min: stdPeakDuration,

        // Timing — seconds (v4.4)
        avg_time_to_peak_sec: avgTimeToPeakSec,
        std_time_to_peak_sec: stdTimeToPeakSec,
        avg_time_to_rug_sec: avgTimeToRugSec,
        std_time_to_rug_sec: stdTimeToRugSec,
        avg_first_sell_delay_sec: avgFirstSellDelay,
        avg_rug_duration_sec: avgRugDurationSec,
        consistency_score_sec: consistencyScoreSec,

        // Market cap
        avg_peak_mc: avgPeakMC,
        std_peak_mc: stdPeakMC,
        avg_pump_multiple: avgPumpMultiple,
        avg_pump_speed_mc_per_sec: avgPumpSpeedMcSec,

        // Volume
        avg_dump_speed: avgDumpSpeed,
        avg_liquidity_at_peak: avgLiquidityAtPeak,
        avg_total_buy_vol_usd: avgBuyVol,
        avg_total_sell_vol_usd: avgSellVol,
        avg_buy_sell_ratio: avgBuySellRatio,
        avg_largest_sell_pct: avgLargestSellPct,

        // Wallet behaviour
        avg_buy_wallet_count: avgBuyWallets,
        avg_sell_wallet_count: avgSellWallets,
        creator_sold_rate: creatorSoldRate,
        avg_top_buyer_pct: avgTopBuyerPct,
        avg_top_seller_pct: avgTopSellerPct,

        // Pattern signatures
        micro_buy_rate: microBuyRate,
        avg_cascade_score: avgCascadeScore,
        avg_pump_dump_speed_ratio: avgPumpDumpRatio,

        // Windows
        entry_window_end_min: entryWindowEnd,
        exit_window_start_min: exitWindowStart,
        exit_window_end_min: exitWindowEnd,
        short_window_start_min: shortWindowStart,
        short_window_end_min: shortWindowEnd,
      };

      // Update wallet with playbook
      await this.walletRepo.updatePlaybook(walletAddress, playbook);

      // Update wallet strategy based on playbook recommendation (v4.0)
      await this.walletRepo.updateStrategy(walletAddress, finalStrategy);

      logger.info({
        wallet: walletAddress,
        sample_size: rugs.length,
        consistency: consistencyScore,
        strategy: finalStrategy,
        isCleanRide
      }, 'Playbook built successfully');

      return playbook;
    } catch (error) {
      logger.error({ error, wallet: walletAddress }, 'Failed to build playbook');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to build playbook for ${walletAddress}`,
        { error }
      );
    }
  }

  /**
   * Get all RUG tokens (RUG_NO_PAIR or RUG_METRICS) with complete lifecycle data.
   * Filters for tokens with peak_mc, time_to_peak_min, and time_to_rug_min non-null.
   */
  private async getRugsWithLifecycleData(walletAddress: string): Promise<TokenEvent[]> {
    // Use direct pool query to include v4.4 trade-level columns
    const pool = (this.walletRepo as unknown as { pool: import('pg').Pool }).pool;
    const rows = await pool.query<TokenEvent>(`
      SELECT * FROM token_events
      WHERE creator_wallet = $1
        AND verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
        AND peak_mc IS NOT NULL
        AND time_to_peak_min IS NOT NULL
        AND time_to_rug_min IS NOT NULL
      ORDER BY detected_at DESC
    `, [walletAddress]);
    return rows.rows;
  }

  /**
   * Calculate arithmetic mean.
   */
  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  /**
   * Calculate standard deviation (population).
   */
  private stdDev(values: number[]): number {
    if (values.length === 0) return 0;
    const avg = this.mean(values);
    const variance = values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Calculate coefficient of variation (CV = std / mean).
   * Returns 1.0 if mean is zero (avoid division by zero).
   */
  private coefficientOfVariation(values: number[]): number {
    const avg = this.mean(values);
    if (avg === 0) return 1.0; // Maximum inconsistency
    const std = this.stdDev(values);
    return std / avg;
  }

  /**
   * Compute consistency score: 1 - CV(time_to_rug).
   * Higher score = more predictable timing.
   * Clamped to [0, 1].
   */
  private computeConsistency(timesToRug: number[]): number {
    const cv = this.coefficientOfVariation(timesToRug);
    const consistency = 1 - cv;
    return Math.max(0, Math.min(1, consistency));
  }

  /**
   * Determine recommended strategy based on consistency, sample size, and avg rug time.
   *
   * Logic:
   * - avg_time_to_rug < 3 min → AVOID (too fast, unpredictable)
   * - consistency >= 0.7 AND sample_size >= 5 → RIDE (exploit predictable ruggers)
   * - consistency >= 0.6 AND sample_size >= 5 → FADE (short predictable dumps)
   * - Otherwise → WATCH (insufficient confidence)
   */
  /**
   * Determine recommended strategy based on consistency, sample size, avg rug time,
   * peak MC, pump multiple, and wallet survival history.
   *
   * v9.0 changes (backtest-validated on 93K tokens, 2026-03-12):
   * - Path 1 & 2 now require survival_count >= 1 (eliminates 447 dead wallets, +8% pump rate)
   * - New rug_rate cap: >0.95 → AVOID (serial ruggers with zero value)
   * - FADE capped at rug_rate <= 0.90 (eliminates worst performers)
   * - CLEAN_RIDE handled externally in buildPlaybook() for rug_count=0 + surv>=3
   */
  private determineStrategy(
    consistencyScore: number,
    sampleSize: number,
    avgTimeToRug: number,
    avgPeakMC: number,
    avgPumpMultiple: number,
    survivalCount: number,
    rugRate: number
  ): 'RIDE' | 'FADE' | 'WATCH' | 'AVOID' {
    // Instant rugs (no market) → no trading possible
    if (avgPeakMC < 500) {
      return 'AVOID';
    }

    // Too fast → unpredictable
    if (avgTimeToRug < 3) {
      return 'AVOID';
    }

    // v9.0: Serial rugger cap — rug_rate > 95% means wallet has NEVER produced value
    // Backtest: these wallets have <1% pump rate, negative EV
    if (rugRate > 0.95) {
      return 'AVOID';
    }

    const hasRealPump = avgPumpMultiple >= 1.5;

    // Path 1: High consistency + sufficient data + real pump + MUST have survival
    // v9.0: Added survivalCount >= 1 requirement
    // Backtest: surv>=1 RIDE wallets = 37.1% pump rate vs 28.5% for surv=0
    if (consistencyScore >= 0.7 && sampleSize >= 5 && hasRealPump && survivalCount >= 1) {
      return 'RIDE';
    }

    // Path 2: Strong pumper — avg pump ≥2.0x + MUST have survival
    // v9.0: Added survivalCount >= 1 requirement
    // Backtest: without survival filter, 417 wallets with 0 survival dragged pump rate to 28.5%
    if (avgPumpMultiple >= 2.0 && sampleSize >= 3 && avgPeakMC >= 2000 && survivalCount >= 1) {
      return 'RIDE';
    }

    // FADE: moderate consistency + real pump + rug_rate capped at 90%
    // v9.0: Added rugRate <= 0.90 cap
    // Backtest: FADE+rr<=0.90 = 26.1% pump rate (marginal improvement, but cuts dead weight)
    if (consistencyScore >= 0.6 && sampleSize >= 5 && hasRealPump && rugRate <= 0.90) {
      return 'FADE';
    }

    // Insufficient confidence, data, or no pump
    return 'WATCH';
  }
}
