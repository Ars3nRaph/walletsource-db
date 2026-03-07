import type { Pool } from 'pg';
import type { WalletAncestry } from '../types/index.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

export class AncestryRepo {
  constructor(private pool: Pool) {}

  async addLink(
    parentWallet: string,
    childWallet: string,
    fundingTx: string,
    fundingAmountSol: number,
    depth: number,
    confidence: number
  ): Promise<WalletAncestry> {
    try {
      const result = await this.pool.query<WalletAncestry>(
        `INSERT INTO wallet_ancestry (parent_wallet, child_wallet, funding_tx, funding_amount_sol, depth, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [parentWallet, childWallet, fundingTx, fundingAmountSol, depth, confidence]
      );

      logger.debug(
        { parent_wallet: parentWallet, child_wallet: childWallet, depth },
        'Ancestry link added'
      );
      return result.rows[0];
    } catch (error) {
      logger.error({ error, parentWallet, childWallet }, 'Failed to add ancestry link');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to add ancestry link from ${parentWallet} to ${childWallet}`,
        { error }
      );
    }
  }

  async getAncestors(wallet: string, maxDepth: number = 3): Promise<WalletAncestry[]> {
    try {
      const result = await this.pool.query<WalletAncestry>(
        `WITH RECURSIVE ancestors AS (
           SELECT * FROM wallet_ancestry WHERE child_wallet = $1 AND depth <= $2 AND confidence >= 0.7
           UNION
           SELECT wa.* FROM wallet_ancestry wa
           INNER JOIN ancestors a ON wa.child_wallet = a.parent_wallet
           WHERE wa.depth <= $2 AND wa.confidence >= 0.7
         )
         SELECT * FROM ancestors ORDER BY depth`,
        [wallet, maxDepth]
      );

      logger.debug({ wallet, maxDepth, count: result.rows.length }, 'Ancestors retrieved');
      return result.rows;
    } catch (error) {
      logger.error({ error, wallet, maxDepth }, 'Failed to get ancestors');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get ancestors for ${wallet}`,
        { error }
      );
    }
  }

  async getDescendants(wallet: string): Promise<WalletAncestry[]> {
    try {
      const result = await this.pool.query<WalletAncestry>(
        `WITH RECURSIVE descendants AS (
           SELECT * FROM wallet_ancestry WHERE parent_wallet = $1 AND confidence >= 0.7
           UNION
           SELECT wa.* FROM wallet_ancestry wa
           INNER JOIN descendants d ON wa.parent_wallet = d.child_wallet
           WHERE wa.confidence >= 0.7
         )
         SELECT * FROM descendants ORDER BY depth`,
        [wallet]
      );

      logger.debug({ wallet, count: result.rows.length }, 'Descendants retrieved');
      return result.rows;
    } catch (error) {
      logger.error({ error, wallet }, 'Failed to get descendants');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get descendants for ${wallet}`,
        { error }
      );
    }
  }

  async getChain(wallet: string): Promise<WalletAncestry[]> {
    try {
      const result = await this.pool.query<WalletAncestry>(
        `SELECT * FROM wallet_ancestry
         WHERE (child_wallet = $1 OR parent_wallet = $1) AND confidence >= 0.7
         ORDER BY depth`,
        [wallet]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, wallet }, 'Failed to get chain');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get chain for ${wallet}`,
        { error }
      );
    }
  }
}
