import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import type { TokenSnapshot } from '../types/index.js';

export class SnapshotRepo {
  constructor(private pool: Pool) {}

  /**
   * Insert a new snapshot record.
   */
  async insertSnapshot(
    snapshot: Omit<TokenSnapshot, 'id'>
  ): Promise<TokenSnapshot> {
    try {
      const result = await this.pool.query<TokenSnapshot>(
        `INSERT INTO token_snapshots (
          token_address, snapshot_at, fdv, liquidity_usd,
          price_usd, price_change_5m, volume_5m, buy_count_5m, sell_count_5m
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          snapshot.token_address,
          snapshot.snapshot_at,
          snapshot.fdv,
          snapshot.liquidity_usd,
          snapshot.price_usd,
          snapshot.price_change_5m,
          snapshot.volume_5m,
          snapshot.buy_count_5m,
          snapshot.sell_count_5m
        ]
      );

      logger.debug(
        { token: snapshot.token_address, snapshot_at: snapshot.snapshot_at },
        'Snapshot inserted'
      );

      return result.rows[0];
    } catch (error) {
      logger.error({ error, snapshot }, 'Failed to insert snapshot');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        'Failed to insert snapshot',
        { error }
      );
    }
  }

  /**
   * Get all snapshots for a token, ordered by snapshot_at ASC.
   */
  async getByToken(tokenAddress: string): Promise<TokenSnapshot[]> {
    try {
      const result = await this.pool.query<TokenSnapshot>(
        `SELECT * FROM token_snapshots
         WHERE token_address = $1
         ORDER BY snapshot_at ASC`,
        [tokenAddress]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, token: tokenAddress }, 'Failed to get snapshots by token');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        'Failed to get snapshots by token',
        { error }
      );
    }
  }

  /**
   * Get the most recent snapshot for a token.
   */
  async getLatestByToken(tokenAddress: string): Promise<TokenSnapshot | null> {
    try {
      const result = await this.pool.query<TokenSnapshot>(
        `SELECT * FROM token_snapshots
         WHERE token_address = $1
         ORDER BY snapshot_at DESC
         LIMIT 1`,
        [tokenAddress]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, token: tokenAddress }, 'Failed to get latest snapshot');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        'Failed to get latest snapshot',
        { error }
      );
    }
  }

  /**
   * Count snapshots for a token.
   */
  async countByToken(tokenAddress: string): Promise<number> {
    try {
      const result = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM token_snapshots
         WHERE token_address = $1`,
        [tokenAddress]
      );

      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, token: tokenAddress }, 'Failed to count snapshots');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        'Failed to count snapshots',
        { error }
      );
    }
  }
}
