import type { Pool } from 'pg';
import type { TokenEvent, RuggerPlaybook } from '../types/index.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { logger } from '../utils/logger.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';

/**
 * PlaybookBuilder — Phase 3 of v4.0 "Ride the Rugger"
 *
 * Analyzes all RUG tokens from a wallet and builds a predictive playbook
 * with temporal windows (entry, exit, short) and consistency scoring.
 *
 * Strategy logic:
 * - RIDE: consistency >= 0.7 AND sample_size >= 5 (exploit predictable ruggers)
 * - FADE: consistency >= 0.6 AND sample_size >= 5 (short predictable dumps)
 * - AVOID: avg_time_to_rug < 3 min (too fast, unpredictable)
 * - WATCH: insufficient data or low consistency
 */
export class PlaybookBuilder {
  private tokenRepo: TokenEventRepo;
  private walletRepo: WalletRepo;

  constructor(pool: Pool) {
    this.tokenRepo = new TokenEventRepo(pool);
    this.walletRepo = new WalletRepo(pool);
  }

  /**
   * Build a rugger playbook for a wallet based on its RUG history.
   * Returns null if insufficient data (< 3 rugs with complete lifecycle data).
   */
  async buildPlaybook(walletAddress: string): Promise<RuggerPlaybook | null> {
    try {
      logger.info({ wallet: walletAddress }, 'Building rugger playbook');

      // Get all RUG tokens with complete lifecycle data
      const rugs = await this.getRugsWithLifecycleData(walletAddress);

      if (rugs.length < 3) {
        logger.debug({ wallet: walletAddress, rugCount: rugs.length }, 'Insufficient RUG data for playbook');
        return null;
      }

      // Extract metrics arrays
      const timesToPeak = rugs.map(r => r.time_to_peak_min!);
      const peakMCs = rugs.map(r => r.peak_mc!);
      const timesToRug = rugs.map(r => r.time_to_rug_min!);
      const dumpSpeeds = rugs.filter(r => r.dump_speed_pct_per_min !== null).map(r => r.dump_speed_pct_per_min!);
      const liquiditiesAtPeak = rugs.filter(r => r.liquidity_at_peak !== null).map(r => r.liquidity_at_peak!);
      const peakDurations = rugs.filter(r => r.peak_duration_min !== null).map(r => r.peak_duration_min!); // v4.2

      // Calculate aggregate statistics
      const avgTimeToPeak = this.mean(timesToPeak);
      const stdTimeToPeak = this.stdDev(timesToPeak);
      const avgPeakMC = this.mean(peakMCs);
      const stdPeakMC = this.stdDev(peakMCs);
      const avgTimeToRug = this.mean(timesToRug);
      const stdTimeToRug = this.stdDev(timesToRug);
      const avgDumpSpeed = dumpSpeeds.length > 0 ? this.mean(dumpSpeeds) : 0;
      const avgLiquidityAtPeak = liquiditiesAtPeak.length > 0 ? this.mean(liquiditiesAtPeak) : 0;
      const avgPeakDuration = peakDurations.length > 0 ? this.mean(peakDurations) : 0; // v4.2
      const stdPeakDuration = peakDurations.length > 0 ? this.stdDev(peakDurations) : 0; // v4.2

      // Consistency score: 1 - CV(time_to_rug)
      const consistencyScore = this.computeConsistency(timesToRug);

      // Temporal windows
      const entryWindowEnd = Math.max(0, avgTimeToPeak - stdTimeToPeak);
      const exitWindowStart = Math.max(0, avgTimeToRug - stdTimeToRug);
      const exitWindowEnd = avgTimeToRug;
      const shortWindowStart = avgTimeToPeak;
      const shortWindowEnd = Math.max(avgTimeToPeak, avgTimeToRug - 0.5 * stdTimeToRug);

      // Determine strategy
      const recommendedStrategy = this.determineStrategy(
        consistencyScore,
        rugs.length,
        avgTimeToRug,
        avgPeakMC
      );

      const playbook: RuggerPlaybook = {
        sample_size: rugs.length,
        avg_time_to_peak_min: avgTimeToPeak,
        std_time_to_peak_min: stdTimeToPeak,
        avg_peak_mc: avgPeakMC,
        std_peak_mc: stdPeakMC,
        avg_time_to_rug_min: avgTimeToRug,
        std_time_to_rug_min: stdTimeToRug,
        avg_dump_speed: avgDumpSpeed,
        avg_liquidity_at_peak: avgLiquidityAtPeak,
        consistency_score: consistencyScore,
        entry_window_end_min: entryWindowEnd,
        exit_window_start_min: exitWindowStart,
        exit_window_end_min: exitWindowEnd,
        short_window_start_min: shortWindowStart,
        short_window_end_min: shortWindowEnd,
        recommended_strategy: recommendedStrategy,
        avg_peak_duration_min: avgPeakDuration, // v4.2
        std_peak_duration_min: stdPeakDuration // v4.2
      };

      // Update wallet with playbook
      await this.walletRepo.updatePlaybook(walletAddress, playbook);

      // Update wallet strategy based on playbook recommendation (v4.0)
      await this.walletRepo.updateStrategy(walletAddress, recommendedStrategy);

      logger.info({
        wallet: walletAddress,
        sample_size: rugs.length,
        consistency: consistencyScore,
        strategy: recommendedStrategy
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
    const allTokens = await this.tokenRepo.getByCreator(walletAddress);

    return allTokens.filter(token => {
      const isRug = token.verdict === 'RUG_NO_PAIR' || token.verdict === 'RUG_METRICS';
      const hasLifecycleData = token.peak_mc !== null
        && token.time_to_peak_min !== null
        && token.time_to_rug_min !== null;

      return isRug && hasLifecycleData;
    });
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
  private determineStrategy(
    consistencyScore: number,
    sampleSize: number,
    avgTimeToRug: number,
    avgPeakMC: number
  ): 'RIDE' | 'FADE' | 'WATCH' | 'AVOID' {
    // Instant rugs (no market) → no trading possible
    if (avgPeakMC < 500) {
      return 'AVOID';
    }

    // Too fast → unpredictable
    if (avgTimeToRug < 3) {
      return 'AVOID';
    }

    // High consistency and sufficient data → exploit
    if (consistencyScore >= 0.7 && sampleSize >= 5) {
      return 'RIDE';
    }

    // Moderate consistency and sufficient data → short
    if (consistencyScore >= 0.6 && sampleSize >= 5) {
      return 'FADE';
    }

    // Insufficient confidence or data
    return 'WATCH';
  }
}
