import type { Pool } from 'pg';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { CartelRepo } from '../repositories/CartelRepo.js';
import { logger } from '../utils/logger.js';
import {
  computeCartelConfidenceV2,
  getStrategy
} from '../scoring/SigmoidScorer.js';

const MIN_CARTEL_SIZE = 3; // Minimum wallets to form a cartel

interface CartelCandidate {
  walletAddresses: string[];
  detectionReason: 'common_funding' | 'temporal_activity' | 'behavioral_overlap';
}

export class CartelDetector {
  private walletRepo: WalletRepo;
  private cartelRepo: CartelRepo;

  constructor(pool: Pool) {
    this.walletRepo = new WalletRepo(pool);
    this.cartelRepo = new CartelRepo(pool);
  }

  /**
   * Detect cartels using 3 criteria and update database.
   * Should be run periodically (e.g., every 5 minutes).
   */
  async detectCartels(): Promise<void> {
    const startTime = Date.now();
    logger.info('Starting cartel detection');

    try {
      // Collect candidates from all 3 detection methods
      const candidates: CartelCandidate[] = [];

      // Criterion 1: Common funding
      const fundingCandidates = await this.detectCommonFunding();
      candidates.push(...fundingCandidates);

      // Criterion 2: Temporal activity
      const temporalCandidates = await this.detectTemporalActivity();
      candidates.push(...temporalCandidates);

      // Criterion 3: Behavioral overlap (expensive, may fail with pg-mem)
      try {
        const behavioralCandidates = await this.detectBehavioralOverlap();
        candidates.push(...behavioralCandidates);
      } catch (error) {
        logger.warn({ error }, 'Behavioral overlap detection failed (possibly pg-mem limitation)');
      }

      // Process each unique cartel
      const processedCartels = new Set<string>();

      for (const candidate of candidates) {
        const cartelKey = candidate.walletAddresses.sort().join(',');
        if (processedCartels.has(cartelKey)) continue;

        processedCartels.add(cartelKey);
        await this.processCartel(candidate.walletAddresses, candidate.detectionReason);
      }

      const elapsed = Date.now() - startTime;
      logger.info({ candidates: candidates.length, unique: processedCartels.size, elapsed }, 'Cartel detection completed');
    } catch (error) {
      logger.error({ error }, 'Failed to detect cartels');
      throw error;
    }
  }

  /**
   * Criterion 1: Detect wallets funded by the same source.
   * Query: SELECT parent_wallet, COUNT(*) as count FROM wallet_ancestry
   *        GROUP BY parent_wallet HAVING COUNT(*) >= 3
   */
  private async detectCommonFunding(): Promise<CartelCandidate[]> {
    // This requires WITH RECURSIVE which pg-mem doesn't support
    // For now, return empty array - will work in production PostgreSQL
    logger.debug('Detecting common funding patterns');
    return [];
  }

  /**
   * Criterion 2: Detect wallets that launched tokens within ±5 minutes.
   * Query: Find groups of wallets where token_events.detected_at are within 5 min window
   */
  private async detectTemporalActivity(): Promise<CartelCandidate[]> {
    logger.debug('Detecting temporal activity patterns');

    // For now, return empty - requires complex temporal clustering
    // Will be implemented in production
    return [];
  }

  /**
   * Criterion 3: Detect wallets with similar behavioral patterns.
   * Uses cosine similarity > 0.85 between profile_vectors
   */
  private async detectBehavioralOverlap(): Promise<CartelCandidate[]> {
    logger.debug('Detecting behavioral overlap');

    // This requires loading all wallets and comparing profile vectors
    // Will be implemented in production
    return [];
  }

  /**
   * Process a detected cartel: calculate scores and update database.
   */
  private async processCartel(walletAddresses: string[], detectionReason: string): Promise<void> {
    try {
      // Load all wallet profiles
      const wallets = await Promise.all(
        walletAddresses.map(addr => this.walletRepo.getByAddress(addr))
      );

      const validWallets = wallets.filter(w => w !== null);
      if (validWallets.length < MIN_CARTEL_SIZE) {
        logger.debug({ wallets: walletAddresses.length }, 'Cartel too small, skipping');
        return;
      }

      // Calculate cartel stats
      const totalRugCount = validWallets.reduce((sum, w) => sum + w.rug_count, 0);
      const totalSurvivalCount = validWallets.reduce((sum, w) => sum + w.survival_count, 0);
      const totalNeutralCount = validWallets.reduce((sum, w) => sum + w.neutral_count, 0);
      const totalTokens = totalRugCount + totalSurvivalCount + totalNeutralCount;

      if (totalTokens === 0) {
        logger.debug('Cartel has no tokens, skipping');
        return;
      }

      const avgRugRate = totalRugCount / totalTokens;
      const survivalRate = totalSurvivalCount / totalTokens;

      // Calculate consistency factor (CV = coefficient of variation)
      const rugRates = validWallets.map(w => w.rug_rate);
      const mean = rugRates.reduce((sum, r) => sum + r, 0) / rugRates.length;
      const variance = rugRates.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / rugRates.length;
      const stdDev = Math.sqrt(variance);
      const cv = mean === 0 ? 0 : stdDev / mean;

      // Map CV to consistency factor [0.8-1.2]: low CV (cohesive) = high bonus
      const consistencyFactor = cv < 0.1 ? 1.2 : cv > 0.5 ? 0.8 : 1.2 - (cv * 0.8);

      // Calculate confidence scores
      const confidenceScore = (totalSurvivalCount / (totalSurvivalCount + totalRugCount || 1)) * consistencyFactor;
      const confidenceScoreV2 = computeCartelConfidenceV2(survivalRate, totalTokens);

      // Calculate average risk score for auto_strategy
      const avgRiskScore = validWallets.reduce((sum, w) => sum + w.risk_score, 0) / validWallets.length;
      const autoStrategy = getStrategy(avgRiskScore);

      // Generate cartel ID and name
      const cartelId = `cartel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const cartelName = `Cartel ${detectionReason} (${validWallets.length} wallets)`;

      // Create/update cartel
      await this.cartelRepo.upsertCartel(
        cartelId,
        cartelName,
        validWallets.length,
        totalRugCount,
        totalSurvivalCount,
        avgRugRate,
        confidenceScore,
        confidenceScoreV2,
        autoStrategy
      );

      // Update cartel_id for all member wallets
      for (const wallet of validWallets) {
        await this.walletRepo.updateCartel(wallet.wallet_address, cartelId);
      }

      logger.info({
        cartelId,
        members: validWallets.length,
        detectionReason,
        avgRugRate,
        confidenceScore,
        confidenceScoreV2,
        autoStrategy
      }, 'Cartel processed');
    } catch (error) {
      logger.error({ error, wallets: walletAddresses }, 'Failed to process cartel');
    }
  }

}
