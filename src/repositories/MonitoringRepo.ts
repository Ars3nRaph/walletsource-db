import type { Pool } from 'pg';
import type { MonitoringQueue } from '../types/index.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

export class MonitoringRepo {
  constructor(private pool: Pool) {}

  async enqueue(
    tokenAddress: string,
    creatorWallet: string,
    checkAt: Date
  ): Promise<MonitoringQueue> {
    try {
      const result = await this.pool.query<MonitoringQueue>(
        `INSERT INTO monitoring_queue (token_address, creator_wallet, check_at)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [tokenAddress, creatorWallet, checkAt]
      );

      logger.debug({ token_address: tokenAddress, check_at: checkAt }, 'Token enqueued for monitoring');
      return result.rows[0];
    } catch (error) {
      logger.error({ error, tokenAddress, creatorWallet }, 'Failed to enqueue token');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to enqueue token ${tokenAddress}`,
        { error }
      );
    }
  }

  async getDueTokens(): Promise<MonitoringQueue[]> {
    try {
      const result = await this.pool.query<MonitoringQueue>(
        `SELECT * FROM monitoring_queue
         WHERE status = 'PENDING' AND check_at <= CURRENT_TIMESTAMP
         ORDER BY check_at ASC`
      );

      logger.debug({ count: result.rows.length }, 'Due tokens retrieved');
      return result.rows;
    } catch (error) {
      logger.error({ error }, 'Failed to get due tokens');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        'Failed to get due tokens',
        { error }
      );
    }
  }

  async markProcessed(tokenAddress: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE monitoring_queue
         SET status = 'DONE', processed_at = CURRENT_TIMESTAMP
         WHERE token_address = $1`,
        [tokenAddress]
      );

      logger.debug({ token_address: tokenAddress }, 'Token marked as processed');
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to mark token as processed');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to mark token ${tokenAddress} as processed`,
        { error }
      );
    }
  }

  async reEnqueue(tokenAddress: string, newCheckAt: Date): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE monitoring_queue
         SET status = 'RETRY', check_at = $1, retry_count = retry_count + 1
         WHERE token_address = $2`,
        [newCheckAt, tokenAddress]
      );

      logger.debug({ token_address: tokenAddress, new_check_at: newCheckAt }, 'Token re-enqueued');
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to re-enqueue token');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to re-enqueue token ${tokenAddress}`,
        { error }
      );
    }
  }

  async updateStatus(
    tokenAddress: string,
    status: 'PENDING' | 'PROCESSING' | 'DONE' | 'RETRY'
  ): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE monitoring_queue SET status = $1 WHERE token_address = $2',
        [status, tokenAddress]
      );

      logger.debug({ token_address: tokenAddress, status }, 'Token status updated');
    } catch (error) {
      logger.error({ error, tokenAddress, status }, 'Failed to update token status');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to update status for token ${tokenAddress}`,
        { error }
      );
    }
  }
}
