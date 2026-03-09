import type { Pool } from 'pg';
import type { MonitoringQueue } from '../types/index.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

export class MonitoringRepo {
  constructor(public pool: Pool) {}

  async enqueue(
    tokenAddress: string,
    creatorWallet: string,
    delayMinutes: number = 0,
    trackingMode: 'deep' | 'medium' | 'fast_verdict' = 'fast_verdict'
  ): Promise<MonitoringQueue> {
    try {
      const result = await this.pool.query<MonitoringQueue>(
        `INSERT INTO monitoring_queue (token_address, creator_wallet, check_at, tracking_mode)
         VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '1 minute' * $3, $4)
         ON CONFLICT (token_address) DO NOTHING
         RETURNING *`,
        [tokenAddress, creatorWallet, delayMinutes, trackingMode]
      );

      logger.debug({ token_address: tokenAddress, delay_minutes: delayMinutes }, 'Token enqueued for monitoring');
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
        `SELECT mq.*
         FROM monitoring_queue mq
         WHERE mq.status = 'PENDING'
           AND mq.check_at <= CURRENT_TIMESTAMP
           AND mq.detected_at > NOW() - INTERVAL '20 minutes'
         ORDER BY
           -- RIDE wallets first
           EXISTS(
             SELECT 1 FROM wallet_profiles wp
             WHERE wp.wallet_address = mq.creator_wallet
               AND wp.strategy = 'RIDE'
               AND wp.rugger_playbook IS NOT NULL
           ) DESC,
           -- Then freshest tokens first
           mq.detected_at DESC
         LIMIT 5`
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

  async reEnqueue(tokenAddress: string, delayMinutes: number = 5): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE monitoring_queue
         SET status = 'PENDING', check_at = CURRENT_TIMESTAMP + INTERVAL '1 minute' * $1, retry_count = retry_count + 1
         WHERE token_address = $2`,
        [delayMinutes, tokenAddress]
      );

      logger.debug({ token_address: tokenAddress, delay_minutes: delayMinutes }, 'Token re-enqueued');
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

  async resetOrphanedProcessing(): Promise<number> {
    try {
      const result = await this.pool.query(
        "UPDATE monitoring_queue SET status = 'PENDING', check_at = CURRENT_TIMESTAMP WHERE status = 'PROCESSING' RETURNING token_address"
      );

      const count = result.rowCount || 0;
      if (count > 0) {
        logger.info({ count }, 'Reset orphaned PROCESSING tokens to PENDING');
      }
      return count;
    } catch (error) {
      logger.error({ error }, 'Failed to reset orphaned PROCESSING tokens');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        'Failed to reset orphaned PROCESSING tokens',
        { error }
      );
    }
  }
}
