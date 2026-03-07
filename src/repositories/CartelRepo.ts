import type { Pool } from 'pg';
import type { CartelGroup, WalletProfile } from '../types/index.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

export class CartelRepo {
  constructor(private pool: Pool) {}

  async upsertCartel(
    cartelId: string,
    name: string,
    walletCount: number,
    totalRugCount: number,
    totalSurvivalCount: number,
    avgRugRate: number,
    confidenceScore: number,
    confidenceScoreV2: number,
    autoStrategy: 'AVOID' | 'SHORT' | 'WATCH' | 'LONG'
  ): Promise<CartelGroup> {
    try {
      const result = await this.pool.query<CartelGroup>(
        `INSERT INTO cartel_groups (cartel_id, name, wallet_count, total_rug_count, total_survival_count, avg_rug_rate, confidence_score, confidence_score_v2, auto_strategy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (cartel_id)
         DO UPDATE SET
           name = EXCLUDED.name,
           wallet_count = EXCLUDED.wallet_count,
           total_rug_count = EXCLUDED.total_rug_count,
           total_survival_count = EXCLUDED.total_survival_count,
           avg_rug_rate = EXCLUDED.avg_rug_rate,
           confidence_score = EXCLUDED.confidence_score,
           confidence_score_v2 = EXCLUDED.confidence_score_v2,
           auto_strategy = EXCLUDED.auto_strategy
         RETURNING *`,
        [cartelId, name, walletCount, totalRugCount, totalSurvivalCount, avgRugRate, confidenceScore, confidenceScoreV2, autoStrategy]
      );

      logger.debug({ cartel_id: cartelId, name }, 'Cartel upserted');
      return result.rows[0];
    } catch (error) {
      logger.error({ error, cartelId, name }, 'Failed to upsert cartel');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to upsert cartel ${cartelId}`,
        { error }
      );
    }
  }

  async getById(cartelId: string): Promise<CartelGroup | null> {
    try {
      const result = await this.pool.query<CartelGroup>(
        'SELECT * FROM cartel_groups WHERE cartel_id = $1',
        [cartelId]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, cartelId }, 'Failed to get cartel');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get cartel ${cartelId}`,
        { error }
      );
    }
  }

  async getMembers(cartelId: string): Promise<WalletProfile[]> {
    try {
      const result = await this.pool.query<WalletProfile>(
        'SELECT * FROM wallet_profiles WHERE cartel_id = $1',
        [cartelId]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, cartelId }, 'Failed to get cartel members');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get members for cartel ${cartelId}`,
        { error }
      );
    }
  }

  async detectCartels(): Promise<CartelGroup[]> {
    // Stub implementation - will be filled in Phase 5
    logger.info('detectCartels() called - stub implementation');
    return [];
  }

  async computeConfidence(cartelId: string): Promise<number> {
    // Stub implementation - will be filled in Phase 5
    logger.info({ cartel_id: cartelId }, 'computeConfidence() called - stub implementation');
    return 0.5;
  }

  async updateCartelScores(
    cartelId: string,
    confidenceScore: number,
    confidenceScoreV2: number
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE cartel_groups
         SET confidence_score = $1, confidence_score_v2 = $2
         WHERE cartel_id = $3`,
        [confidenceScore, confidenceScoreV2, cartelId]
      );

      logger.debug({ cartel_id: cartelId, confidenceScore, confidenceScoreV2 }, 'Cartel scores updated');
    } catch (error) {
      logger.error({ error, cartelId }, 'Failed to update cartel scores');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to update scores for cartel ${cartelId}`,
        { error }
      );
    }
  }
}
