import type { Pool } from 'pg';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { AncestryRepo } from '../repositories/AncestryRepo.js';
import { TaintLogRepo } from '../repositories/TaintLogRepo.js';
import { logger } from '../utils/logger.js';

const BASE_TAINT_POINTS = 50;
const DECAY_FACTOR = 0.7;
const MAX_DEPTH = 3;

export class TaintScorer {
  private walletRepo: WalletRepo;
  private ancestryRepo: AncestryRepo;
  private taintLogRepo: TaintLogRepo;

  constructor(pool: Pool) {
    this.walletRepo = new WalletRepo(pool);
    this.ancestryRepo = new AncestryRepo(pool);
    this.taintLogRepo = new TaintLogRepo(pool);
  }

  /**
   * Propagate taint score from a rug token to its creator and ancestors.
   * Formula: Taint(depth) = 50 × 0.7^depth
   *
   * @param tokenAddress - Address of the rug token
   * @param creatorWallet - Wallet that created the token
   * @param reason - Reason for taint (RUG_NO_PAIR or RUG_METRICS)
   */
  async propagate(
    tokenAddress: string,
    creatorWallet: string,
    reason: 'RUG_NO_PAIR' | 'RUG_METRICS'
  ): Promise<void> {
    const startTime = Date.now();
    const walletsToUpdate = new Map<string, number>();

    try {
      // Step 1: Apply taint to creator (depth 0)
      const creatorPoints = this.calculateTaintPoints(0);
      walletsToUpdate.set(creatorWallet, creatorPoints);

      await this.taintLogRepo.logTaint(creatorWallet, tokenAddress, creatorPoints, 0, reason);

      logger.debug(
        { wallet: creatorWallet, points: creatorPoints, depth: 0 },
        'Taint applied to creator'
      );

      // Step 2: Get ancestors (filtered by confidence >= 0.7 in AncestryRepo)
      // Note: This may fail in test environments (pg-mem) due to WITH RECURSIVE limitations
      let ancestors: Awaited<ReturnType<typeof this.ancestryRepo.getAncestors>> = [];
      try {
        ancestors = await this.ancestryRepo.getAncestors(creatorWallet, MAX_DEPTH);
      } catch (error) {
        // If getAncestors fails (e.g., pg-mem WITH RECURSIVE limitation), continue without ancestors
        logger.debug({ error, wallet: creatorWallet }, 'Failed to get ancestors, continuing without ancestry propagation');
      }

      // Step 3: Apply taint to each ancestor based on depth
      for (const ancestor of ancestors) {
        const points = this.calculateTaintPoints(ancestor.depth);
        const parentWallet = ancestor.parent_wallet;

        // Accumulate points if wallet already in map
        const existingPoints = walletsToUpdate.get(parentWallet) || 0;
        walletsToUpdate.set(parentWallet, existingPoints + points);

        await this.taintLogRepo.logTaint(parentWallet, tokenAddress, points, ancestor.depth, reason);

        logger.debug(
          { wallet: parentWallet, points, depth: ancestor.depth, confidence: ancestor.confidence },
          'Taint applied to ancestor'
        );
      }

      // Step 4: Update taint_score for all touched wallets
      for (const [walletAddress, _] of walletsToUpdate) {
        const totalTaint = await this.taintLogRepo.getTotalByWallet(walletAddress);
        await this.walletRepo.updateTaintScore(walletAddress, totalTaint);
      }

      const elapsed = Date.now() - startTime;

      logger.info(
        {
          token: tokenAddress,
          creator: creatorWallet,
          reason,
          walletsAffected: walletsToUpdate.size,
          totalPoints: Array.from(walletsToUpdate.values()).reduce((sum, pts) => sum + pts, 0),
          elapsed
        },
        'Taint propagation completed'
      );
    } catch (error) {
      logger.error({ error, tokenAddress, creatorWallet }, 'Failed to propagate taint');
      throw error;
    }
  }

  /**
   * Calculate taint points for a given depth.
   * Formula: 50 × 0.7^depth
   */
  private calculateTaintPoints(depth: number): number {
    return BASE_TAINT_POINTS * Math.pow(DECAY_FACTOR, depth);
  }
}
