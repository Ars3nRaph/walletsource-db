import type { Pool } from 'pg';
import type { WalletProfile } from '../types/index.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

export class WalletRepo {
  constructor(private pool: Pool) {}

  async upsertWallet(walletAddress: string): Promise<WalletProfile> {
    try {
      const result = await this.pool.query<WalletProfile>(
        `INSERT INTO wallet_profiles (wallet_address)
         VALUES ($1)
         ON CONFLICT (wallet_address)
         DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [walletAddress]
      );

      logger.debug({ wallet_address: walletAddress }, 'Wallet upserted');
      return result.rows[0];
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to upsert wallet');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to upsert wallet ${walletAddress}`,
        { error }
      );
    }
  }

  async getByAddress(walletAddress: string): Promise<WalletProfile | null> {
    try {
      const result = await this.pool.query<WalletProfile>(
        'SELECT * FROM wallet_profiles WHERE wallet_address = $1',
        [walletAddress]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to get wallet');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get wallet ${walletAddress}`,
        { error }
      );
    }
  }

  async updateStrategy(
    walletAddress: string,
    strategy: 'AVOID' | 'SHORT' | 'WATCH' | 'LONG'
  ): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE wallet_profiles SET strategy = $1 WHERE wallet_address = $2',
        [strategy, walletAddress]
      );

      logger.debug({ wallet_address: walletAddress, strategy }, 'Strategy updated');
    } catch (error) {
      logger.error({ error, walletAddress, strategy }, 'Failed to update strategy');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to update strategy for ${walletAddress}`,
        { error }
      );
    }
  }

  async getByCartel(cartelId: string): Promise<WalletProfile[]> {
    try {
      const result = await this.pool.query<WalletProfile>(
        'SELECT * FROM wallet_profiles WHERE cartel_id = $1',
        [cartelId]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, cartelId }, 'Failed to get wallets by cartel');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get wallets for cartel ${cartelId}`,
        { error }
      );
    }
  }

  async incrementRug(walletAddress: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE wallet_profiles
         SET rug_count = rug_count + 1,
             rug_rate = CASE
               WHEN (rug_count + survival_count + neutral_count) = 0 THEN 0
               ELSE rug_count::REAL / (rug_count + survival_count + neutral_count)
             END,
             last_seen_at = CURRENT_TIMESTAMP
         WHERE wallet_address = $1`,
        [walletAddress]
      );

      logger.debug({ wallet_address: walletAddress }, 'Rug count incremented');
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to increment rug count');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to increment rug count for ${walletAddress}`,
        { error }
      );
    }
  }

  async incrementSurvival(walletAddress: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE wallet_profiles
         SET survival_count = survival_count + 1,
             rug_rate = CASE
               WHEN (rug_count + survival_count + neutral_count) = 0 THEN 0
               ELSE rug_count::REAL / (rug_count + survival_count + neutral_count)
             END,
             last_seen_at = CURRENT_TIMESTAMP
         WHERE wallet_address = $1`,
        [walletAddress]
      );

      logger.debug({ wallet_address: walletAddress }, 'Survival count incremented');
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to increment survival count');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to increment survival count for ${walletAddress}`,
        { error }
      );
    }
  }

  async incrementNeutral(walletAddress: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE wallet_profiles
         SET neutral_count = neutral_count + 1,
             rug_rate = CASE
               WHEN (rug_count + survival_count + neutral_count) = 0 THEN 0
               ELSE rug_count::REAL / (rug_count + survival_count + neutral_count)
             END,
             last_seen_at = CURRENT_TIMESTAMP
         WHERE wallet_address = $1`,
        [walletAddress]
      );

      logger.debug({ wallet_address: walletAddress }, 'Neutral count incremented');
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to increment neutral count');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to increment neutral count for ${walletAddress}`,
        { error }
      );
    }
  }

  async updateScores(
    walletAddress: string,
    taintScore: number,
    toxicityScore: number,
    riskScore: number
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE wallet_profiles
         SET taint_score = $1, toxicity_score = $2, risk_score = $3, last_seen_at = CURRENT_TIMESTAMP
         WHERE wallet_address = $4`,
        [taintScore, toxicityScore, riskScore, walletAddress]
      );

      logger.debug({ wallet_address: walletAddress, taintScore, toxicityScore, riskScore }, 'Scores updated');
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to update scores');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to update scores for ${walletAddress}`,
        { error }
      );
    }
  }

  async updateCartel(walletAddress: string, cartelId: string | null): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE wallet_profiles SET cartel_id = $1, last_seen_at = CURRENT_TIMESTAMP WHERE wallet_address = $2',
        [cartelId, walletAddress]
      );

      logger.debug({ wallet_address: walletAddress, cartel_id: cartelId }, 'Cartel updated');
    } catch (error) {
      logger.error({ error, walletAddress, cartelId }, 'Failed to update cartel');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to update cartel for ${walletAddress}`,
        { error }
      );
    }
  }
}
