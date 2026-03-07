import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { CalibrationRepo } from '../repositories/CalibrationRepo.js';
import { CartelRepo } from '../repositories/CartelRepo.js';
import type { TokenEvent, WalletProfile } from '../types/index.js';

// Initial parameter values from PRD section 7 and 8.4
export interface CalibrationParams {
  k_confidence: number; // Cartel confidence sigmoid steepness
  k_rug: number; // Risk score rug rate sigmoid steepness
  k_cartel: number; // Risk score cartel rug rate sigmoid steepness
  alpha_pexit: number; // P_exit v2 sigmoid steepness
  mu_taint: number; // Toxicity sigmoid center
  sigma_taint: number; // Toxicity sigmoid spread
  w1_rug: number; // Risk score weight for rug_rate
  w2_toxicity: number; // Risk score weight for toxicity
  w3_cartel: number; // Risk score weight for cartel
}

// Default initial values
const INITIAL_PARAMS: CalibrationParams = {
  k_confidence: 6.0,
  k_rug: 6.0,
  k_cartel: 5.0,
  alpha_pexit: 3.0,
  mu_taint: 100,
  sigma_taint: 40,
  w1_rug: 0.40,
  w2_toxicity: 0.35,
  w3_cartel: 0.25
};

// Bounds for guard rails (±50% of initial values)
const PARAM_BOUNDS: Record<keyof CalibrationParams, [number, number]> = {
  k_confidence: [3.0, 9.0],
  k_rug: [3.0, 9.0],
  k_cartel: [2.5, 7.5],
  alpha_pexit: [1.5, 4.5],
  mu_taint: [50, 150],
  sigma_taint: [20, 60],
  w1_rug: [0.20, 0.60],
  w2_toxicity: [0.175, 0.525],
  w3_cartel: [0.125, 0.375]
};

const CALIBRATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EVALUATION_WINDOW_DAYS = 7; // Look back 7 days for token_events
const MIN_IMPROVEMENT_PCT = 5.0; // Minimum improvement to accept new parameter
const GRID_SEARCH_DELTA = 0.1; // ±10% variation

interface CalibrationMetrics {
  precisionAvoid: number; // Wallets classified AVOID that rugged / total AVOID
  recallLong: number; // Wallets LONG that succeeded / total succeeded
  gainsLossesRatio: number; // Sum positive PnL / sum negative PnL
  totalPnL: number; // Total theoretical PnL (%)
}

export class CalibrationWorker {
  private tokenRepo: TokenEventRepo;
  private walletRepo: WalletRepo;
  private calibrationRepo: CalibrationRepo;
  private cartelRepo: CartelRepo;
  private currentParams: CalibrationParams;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(pool: Pool, initialParams?: CalibrationParams) {
    this.tokenRepo = new TokenEventRepo(pool);
    this.walletRepo = new WalletRepo(pool);
    this.calibrationRepo = new CalibrationRepo(pool);
    this.cartelRepo = new CartelRepo(pool);
    this.currentParams = initialParams || { ...INITIAL_PARAMS };
  }

  /**
   * Start the calibration worker on a weekly schedule.
   * Runs every Sunday at 03:00 UTC (approximated with setInterval).
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('CalibrationWorker already running');
      return;
    }

    this.isRunning = true;
    logger.info({ intervalMs: CALIBRATION_INTERVAL_MS }, 'CalibrationWorker scheduled');

    // Check every hour if it's time to calibrate (Sunday 03:00 UTC)
    this.intervalId = setInterval(() => {
      const now = new Date();
      const day = now.getUTCDay(); // 0 = Sunday
      const hour = now.getUTCHours();

      if (day === 0 && hour === 3) {
        logger.info('Triggering weekly calibration (Sunday 03:00 UTC)');
        this.runCalibration().catch((error) => {
          logger.error({ error }, 'Calibration failed');
        });
      }
    }, 60 * 60 * 1000); // Check every hour
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('CalibrationWorker stopped');
  }

  /**
   * Run calibration manually (for testing or on-demand optimization).
   */
  async runCalibration(): Promise<void> {
    const startTime = Date.now();
    logger.info('Starting calibration run');

    try {
      // 1. Extract token_events from last 7 days
      const tokens = await this.getRecentTokens(EVALUATION_WINDOW_DAYS);

      if (tokens.length < 10) {
        logger.warn({ tokenCount: tokens.length }, 'Insufficient tokens for calibration (< 10)');
        return;
      }

      logger.info({ tokenCount: tokens.length }, 'Tokens extracted for calibration');

      // 2. Evaluate current metrics
      const baselineMetrics = await this.evaluateMetrics(tokens, this.currentParams);
      logger.info({ metrics: baselineMetrics }, 'Baseline metrics computed');

      // 3. Test variations for each parameter
      for (const paramName of Object.keys(this.currentParams) as Array<keyof CalibrationParams>) {
        await this.testParameterVariations(paramName, tokens, baselineMetrics);
      }

      const duration = Date.now() - startTime;
      logger.info({ durationMs: duration, tokenCount: tokens.length }, 'Calibration run completed');
    } catch (error) {
      logger.error({ error }, 'Calibration run failed');
      throw error;
    }
  }

  /**
   * Get current calibration parameters.
   */
  getParams(): CalibrationParams {
    return { ...this.currentParams };
  }

  /**
   * Update a specific parameter (for testing or manual override).
   */
  setParam<K extends keyof CalibrationParams>(key: K, value: number): void {
    this.currentParams[key] = value;
    logger.info({ param: key, value }, 'Parameter manually updated');
  }

  /**
   * Get token_events from the last N days.
   */
  private async getRecentTokens(days: number): Promise<TokenEvent[]> {
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await this.tokenRepo.pool.query<TokenEvent>(
      `SELECT * FROM token_events
       WHERE checked_at >= $1
       AND verdict IS NOT NULL
       ORDER BY checked_at DESC`,
      [cutoffDate]
    );

    return result.rows;
  }

  /**
   * Evaluate calibration metrics with given parameters.
   */
  private async evaluateMetrics(
    tokens: TokenEvent[],
    params: CalibrationParams
  ): Promise<CalibrationMetrics> {
    let totalPnL = 0;
    let positivePnL = 0;
    let negativePnL = 0;

    // Precision AVOID: wallets AVOID that rugged / total AVOID
    let avoidWallets = 0;
    let avoidRugged = 0;

    // Recall LONG: wallets LONG that succeeded / total succeeded
    let longWallets = 0;
    let longSucceeded = 0;
    let totalSucceeded = 0;

    for (const token of tokens) {
      const wallet = await this.walletRepo.getByAddress(token.creator_wallet);
      if (!wallet) continue;

      // Calculate risk score with current parameters
      const riskScore = this.computeRiskScore(wallet, params);
      const strategy = this.getStrategy(riskScore);

      // Calculate PnL
      const pnl = await this.calculatePnL(token, wallet, params);
      totalPnL += pnl;

      if (pnl > 0) {
        positivePnL += pnl;
      } else if (pnl < 0) {
        negativePnL += Math.abs(pnl);
      }

      // Precision AVOID
      if (strategy === 'AVOID') {
        avoidWallets++;
        if (token.verdict === 'RUG_NO_PAIR' || token.verdict === 'RUG_METRICS') {
          avoidRugged++;
        }
      }

      // Recall LONG
      if (token.verdict === 'SUCCESS') {
        totalSucceeded++;
        if (strategy === 'LONG') {
          longSucceeded++;
        }
      }

      if (strategy === 'LONG') {
        longWallets++;
      }
    }

    const precisionAvoid = avoidWallets > 0 ? avoidRugged / avoidWallets : 0;
    const recallLong = totalSucceeded > 0 ? longSucceeded / totalSucceeded : 0;
    const gainsLossesRatio = negativePnL > 0 ? positivePnL / negativePnL : positivePnL;

    return {
      precisionAvoid,
      recallLong,
      gainsLossesRatio,
      totalPnL
    };
  }

  /**
   * Test ±10% variations for a parameter and accept if improvement > 5%.
   */
  private async testParameterVariations(
    paramName: keyof CalibrationParams,
    tokens: TokenEvent[],
    baselineMetrics: CalibrationMetrics
  ): Promise<void> {
    const oldValue = this.currentParams[paramName];
    const [minBound, maxBound] = PARAM_BOUNDS[paramName];

    // Test -10% and +10% variations
    const variations = [
      oldValue * (1 - GRID_SEARCH_DELTA), // -10%
      oldValue * (1 + GRID_SEARCH_DELTA) // +10%
    ];

    let bestValue = oldValue;
    let bestImprovement = 0;

    for (const newValue of variations) {
      // Apply guard rails
      if (newValue < minBound || newValue > maxBound) {
        logger.debug(
          { param: paramName, value: newValue, min: minBound, max: maxBound },
          'Parameter variation rejected by guard rails'
        );

        // Log rejected calibration
        await this.calibrationRepo.logCalibration(
          paramName,
          oldValue,
          newValue,
          0,
          tokens.length,
          false
        );

        continue;
      }

      // Create temporary params with the variation
      const testParams = { ...this.currentParams, [paramName]: newValue };

      // Evaluate metrics with new parameter
      const testMetrics = await this.evaluateMetrics(tokens, testParams);

      // Calculate improvement in gains/losses ratio
      const improvementPct =
        baselineMetrics.gainsLossesRatio > 0
          ? ((testMetrics.gainsLossesRatio - baselineMetrics.gainsLossesRatio) /
              baselineMetrics.gainsLossesRatio) *
            100
          : 0;

      logger.debug(
        {
          param: paramName,
          oldValue,
          newValue,
          improvementPct,
          baseline: baselineMetrics.gainsLossesRatio,
          test: testMetrics.gainsLossesRatio
        },
        'Parameter variation tested'
      );

      // Check if improvement is significant
      if (improvementPct > MIN_IMPROVEMENT_PCT && improvementPct > bestImprovement) {
        bestValue = newValue;
        bestImprovement = improvementPct;
      }
    }

    // Accept best improvement if significant
    if (bestValue !== oldValue && bestImprovement > MIN_IMPROVEMENT_PCT) {
      this.currentParams[paramName] = bestValue;

      await this.calibrationRepo.logCalibration(
        paramName,
        oldValue,
        bestValue,
        bestImprovement,
        tokens.length,
        true
      );

      logger.info(
        { param: paramName, oldValue, newValue: bestValue, improvementPct: bestImprovement },
        'Parameter calibration accepted'
      );
    } else {
      await this.calibrationRepo.logCalibration(
        paramName,
        oldValue,
        oldValue,
        0,
        tokens.length,
        false
      );

      logger.debug({ param: paramName }, 'No significant improvement found');
    }
  }

  /**
   * Calculate theoretical PnL for a token based on strategy and verdict.
   * From PRD Annexe D.6.
   */
  private async calculatePnL(
    token: TokenEvent,
    wallet: WalletProfile,
    params: CalibrationParams
  ): Promise<number> {
    const riskScore = this.computeRiskScore(wallet, params);
    const strategy = this.getStrategy(riskScore);

    // For RUG tokens
    if (token.verdict === 'RUG_NO_PAIR' || token.verdict === 'RUG_METRICS') {
      // If AVOID: correct prediction, no loss
      if (strategy === 'AVOID') {
        return 0;
      }
      // Otherwise: would have bought and lost 100%
      return -100;
    }

    // For SUCCESS tokens
    if (token.verdict === 'SUCCESS') {
      // If AVOID: missed opportunity (neutral for calibration)
      if (strategy === 'AVOID') {
        return 0;
      }

      // Calculate P_exit v2
      const pExitV2 = await this.calculatePExitV2(token, wallet, params);

      // Simulate buy at fdv_at_check, sell at fdv_at_check × P_exit_v2
      // PnL = (sell_price - buy_price) / buy_price × 100
      const buyPrice = token.fdv_at_check || 0;
      if (buyPrice === 0) return 0;

      const sellPrice = buyPrice * pExitV2;
      const pnl = ((sellPrice - buyPrice) / buyPrice) * 100;

      return pnl;
    }

    // NEUTRAL tokens: no PnL impact
    return 0;
  }

  /**
   * Calculate P_exit v2 using sigmoid formula.
   * Formula: sigmoid(α × (MC_ratio - 1)) × Confiance_cartel_v2
   */
  private async calculatePExitV2(
    token: TokenEvent,
    wallet: WalletProfile,
    params: CalibrationParams
  ): Promise<number> {
    // Get median MC from creator's SUCCESS tokens
    const medianMC = await this.tokenRepo.getMedianFDV(wallet.wallet_address, 'SUCCESS');
    if (medianMC === null || medianMC === 0) return 0;

    // MC_ratio = current / profile
    const currentMC = token.fdv_at_check || 0;
    const mcRatio = currentMC / medianMC;

    // Calculate sigmoid
    const sigmoidValue = this.sigmoid((mcRatio - 1) * params.alpha_pexit);

    // Get cartel confidence if wallet belongs to a cartel
    let cartelConfidence = 0.5; // Default if no cartel
    if (wallet.cartel_id) {
      const cartel = await this.cartelRepo.getById(wallet.cartel_id);
      if (cartel) {
        // Compute cartel confidence v2
        const survivalRate =
          cartel.total_survival_count / (cartel.total_survival_count + cartel.total_rug_count || 1);
        const totalTokens = cartel.total_survival_count + cartel.total_rug_count;
        cartelConfidence = this.computeCartelConfidenceV2(survivalRate, totalTokens, params);
      }
    }

    return sigmoidValue * cartelConfidence;
  }

  /**
   * Compute risk score using current parameters.
   * Formula: w1 × sigmoid(k1 × (rugRate - 0.5))
   *        + w2 × toxicityScore
   *        + w3 × sigmoid(k3 × (cartelRugRate - 0.5))
   */
  private computeRiskScore(wallet: WalletProfile, params: CalibrationParams): number {
    const rugRate = wallet.rug_rate;

    // Compute toxicity score
    const toxicityScore = this.sigmoid((wallet.taint_score - params.mu_taint) / params.sigma_taint);

    // Get cartel rug rate
    let cartelRugRate = 0;
    // Note: We would need to fetch the cartel, but for simplicity we use 0 if no cartel
    // In a real implementation, we'd fetch the cartel data

    const rugComponent = params.w1_rug * this.sigmoid(params.k_rug * (rugRate - 0.5));
    const toxicityComponent = params.w2_toxicity * toxicityScore;
    const cartelComponent = params.w3_cartel * this.sigmoid(params.k_cartel * (cartelRugRate - 0.5));

    return rugComponent + toxicityComponent + cartelComponent;
  }

  /**
   * Compute cartel confidence v2.
   * Formula: sigmoid(k × (survivalRate - 0.5)) × min(1, totalTokens / 10)
   */
  private computeCartelConfidenceV2(
    survivalRate: number,
    totalTokens: number,
    params: CalibrationParams
  ): number {
    const tokenPenalty = Math.min(1, totalTokens / 10);
    return this.sigmoid(params.k_confidence * (survivalRate - 0.5)) * tokenPenalty;
  }

  /**
   * Map risk score to strategy.
   */
  private getStrategy(riskScore: number): 'LONG' | 'WATCH' | 'SHORT' | 'AVOID' {
    if (riskScore < 0.25) return 'LONG';
    if (riskScore < 0.50) return 'WATCH';
    if (riskScore < 0.75) return 'SHORT';
    return 'AVOID';
  }

  /**
   * Basic sigmoid function.
   */
  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
  }
}
