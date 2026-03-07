import type { Pool } from 'pg';
import type { TaintLog } from '../types/index.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

export class TaintLogRepo {
  constructor(private pool: Pool) {}

  async logTaint(
    walletAddress: string,
    sourceToken: string,
    pointsApplied: number,
    propagationDepth: number,
    reason: 'RUG_NO_PAIR' | 'RUG_METRICS'
  ): Promise<TaintLog> {
    try {
      const result = await this.pool.query<TaintLog>(
        `INSERT INTO taint_log (wallet_address, source_token, points_applied, propagation_depth, reason)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [walletAddress, sourceToken, pointsApplied, propagationDepth, reason]
      );

      logger.debug(
        { wallet_address: walletAddress, source_token: sourceToken, points_applied: pointsApplied, depth: propagationDepth },
        'Taint logged'
      );
      return result.rows[0];
    } catch (error) {
      logger.error({ error, walletAddress, sourceToken }, 'Failed to log taint');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to log taint for ${walletAddress}`,
        { error }
      );
    }
  }

  async getHistory(walletAddress: string): Promise<TaintLog[]> {
    try {
      const result = await this.pool.query<TaintLog>(
        'SELECT * FROM taint_log WHERE wallet_address = $1 ORDER BY applied_at DESC',
        [walletAddress]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to get taint history');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get taint history for ${walletAddress}`,
        { error }
      );
    }
  }

  async getTotalByWallet(walletAddress: string): Promise<number> {
    try {
      const result = await this.pool.query<{ total: number }>(
        'SELECT COALESCE(SUM(points_applied), 0) as total FROM taint_log WHERE wallet_address = $1',
        [walletAddress]
      );

      const total = result.rows[0]?.total || 0;
      logger.debug({ wallet_address: walletAddress, total }, 'Total taint calculated');
      return total;
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to get total taint');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get total taint for ${walletAddress}`,
        { error }
      );
    }
  }
}
