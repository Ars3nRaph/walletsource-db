import type { Pool } from 'pg';
import type { TokenEvent } from '../types/index.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

export class TokenEventRepo {
  constructor(public pool: Pool) {}

  async recordEvent(tokenAddress: string, creatorWallet: string): Promise<TokenEvent> {
    try {
      const result = await this.pool.query<TokenEvent>(
        `INSERT INTO token_events (token_address, creator_wallet)
         VALUES ($1, $2)
         RETURNING *`,
        [tokenAddress, creatorWallet]
      );

      logger.debug({ token_address: tokenAddress, creator_wallet: creatorWallet }, 'Token event recorded');
      return result.rows[0];
    } catch (error) {
      logger.error({ error, tokenAddress, creatorWallet }, 'Failed to record token event');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to record token event for ${tokenAddress}`,
        { error }
      );
    }
  }

  async updateVerdict(
    tokenAddress: string,
    verdict: 'RUG_NO_PAIR' | 'RUG_METRICS' | 'SUCCESS' | 'NEUTRAL',
    fdvAtCheck: number | null,
    liquidityAtCheck: number | null,
    priceChange5m: number | null,
    dexscreenerPair: string | null
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE token_events
         SET verdict = $1, checked_at = CURRENT_TIMESTAMP, fdv_at_check = $2,
             liquidity_at_check = $3, price_change_5m = $4, dexscreener_pair = $5
         WHERE token_address = $6`,
        [verdict, fdvAtCheck, liquidityAtCheck, priceChange5m, dexscreenerPair, tokenAddress]
      );

      logger.info({ token_address: tokenAddress, verdict }, 'Verdict updated');
    } catch (error) {
      logger.error({ error, tokenAddress, verdict }, 'Failed to update verdict');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to update verdict for ${tokenAddress}`,
        { error }
      );
    }
  }

  async getByCreator(creatorWallet: string): Promise<TokenEvent[]> {
    try {
      const result = await this.pool.query<TokenEvent>(
        'SELECT * FROM token_events WHERE creator_wallet = $1 ORDER BY detected_at DESC',
        [creatorWallet]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, creatorWallet }, 'Failed to get tokens by creator');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get tokens for creator ${creatorWallet}`,
        { error }
      );
    }
  }

  async getMedianFDV(
    creatorWallet: string,
    verdict: 'RUG_NO_PAIR' | 'RUG_METRICS' | 'SUCCESS' | 'NEUTRAL'
  ): Promise<number | null> {
    try {
      // Try PERCENTILE_CONT (native PostgreSQL)
      const result = await this.pool.query<{ median: number | null }>(
        `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fdv_at_check) as median
         FROM token_events
         WHERE creator_wallet = $1 AND verdict = $2 AND fdv_at_check IS NOT NULL`,
        [creatorWallet, verdict]
      );

      const median = result.rows[0]?.median || null;
      logger.debug({ creator_wallet: creatorWallet, verdict, median }, 'Median FDV calculated');
      return median;
    } catch (error) {
      // Fallback for pg-mem: manual median calculation
      logger.debug({ creatorWallet, verdict }, 'PERCENTILE_CONT failed, using manual median calculation');

      try {
        const result = await this.pool.query<{ fdv_at_check: number }>(
          `SELECT fdv_at_check
           FROM token_events
           WHERE creator_wallet = $1 AND verdict = $2 AND fdv_at_check IS NOT NULL
           ORDER BY fdv_at_check ASC`,
          [creatorWallet, verdict]
        );

        if (result.rows.length === 0) {
          return null;
        }

        const fdvValues = result.rows.map(row => row.fdv_at_check);
        const mid = Math.floor(fdvValues.length / 2);

        let median: number;
        if (fdvValues.length % 2 === 0) {
          // Even number of values: average of two middle values
          median = (fdvValues[mid - 1] + fdvValues[mid]) / 2;
        } else {
          // Odd number of values: middle value
          median = fdvValues[mid];
        }

        logger.debug({ creator_wallet: creatorWallet, verdict, median, count: fdvValues.length }, 'Manual median calculated');
        return median;
      } catch (fallbackError) {
        logger.error({ error: fallbackError, creatorWallet, verdict }, 'Failed to get median FDV (fallback)');
        throw new WalletSourceError(
          ErrorCode.DB_QUERY_FAILED,
          `Failed to get median FDV for creator ${creatorWallet}`,
          { error: fallbackError }
        );
      }
    }
  }

  async getByAddress(tokenAddress: string): Promise<TokenEvent | null> {
    try {
      const result = await this.pool.query<TokenEvent>(
        'SELECT * FROM token_events WHERE token_address = $1',
        [tokenAddress]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to get token event');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get token event for ${tokenAddress}`,
        { error }
      );
    }
  }

  async updatePExit(
    tokenAddress: string,
    pExitV1: number,
    pExitV2: number
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE token_events
         SET p_exit_v1 = $1, p_exit_v2 = $2
         WHERE token_address = $3`,
        [pExitV1, pExitV2, tokenAddress]
      );

      logger.debug({ token_address: tokenAddress, p_exit_v1: pExitV1, p_exit_v2: pExitV2 }, 'P_exit updated');
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to update P_exit');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to update P_exit for ${tokenAddress}`,
        { error }
      );
    }
  }
}
