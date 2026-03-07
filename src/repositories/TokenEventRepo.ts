import type { Pool } from 'pg';
import type { TokenEvent } from '../types/index.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

export class TokenEventRepo {
  constructor(private pool: Pool) {}

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
      logger.error({ error, creatorWallet, verdict }, 'Failed to get median FDV');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get median FDV for creator ${creatorWallet}`,
        { error }
      );
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
}
