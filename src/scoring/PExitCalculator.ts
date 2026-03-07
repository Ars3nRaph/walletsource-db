import type { Pool } from 'pg';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { CartelRepo } from '../repositories/CartelRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { sigmoid } from './SigmoidScorer.js';
import { logger } from '../utils/logger.js';

const ALPHA_PEXIT = 3.0; // Steepness parameter for P_exit v2 sigmoid

export interface ExitAction {
  action: 'EXIT_IMMEDIATE' | 'EXIT_PROGRESSIF' | 'HOLD' | 'WATCH' | 'SELL';
  sellPct: number;
}

/**
 * PExitCalculator — Formule de probabilité de sortie pour positions de trading.
 *
 * P_exit v1 (linéaire): (MC_actuel / MC_profil) × Confiance_cartel
 * P_exit v2 (sigmoïde): sigmoid(α × (MC_ratio - 1)) × Confiance_cartel_v2
 *
 * MC_profil = médiane des fdv_at_check des tokens SUCCESS du créateur
 * MC_actuel = FDV actuel du token
 *
 * Section 9 du PRD.
 */
export class PExitCalculator {
  private tokenRepo: TokenEventRepo;
  private cartelRepo: CartelRepo;
  private walletRepo: WalletRepo;

  constructor(pool: Pool) {
    this.tokenRepo = new TokenEventRepo(pool);
    this.cartelRepo = new CartelRepo(pool);
    this.walletRepo = new WalletRepo(pool);
  }

  /**
   * Get median market cap (FDV) from creator's SUCCESS tokens.
   * @param creatorWallet - Creator wallet address
   * @returns Median FDV or 0 if no SUCCESS tokens exist
   */
  async getMedianMC(creatorWallet: string): Promise<number> {
    const medianFDV = await this.tokenRepo.getMedianFDV(creatorWallet, 'SUCCESS');

    if (medianFDV === null || medianFDV === 0) {
      logger.debug({ creatorWallet }, 'No SUCCESS tokens found for creator, MC_profil = 0');
      return 0;
    }

    return medianFDV;
  }

  /**
   * Compute P_exit v1 (linear formula).
   * Formula: (MC_actuel / MC_profil) × Confiance_cartel
   *
   * @param mcActuel - Current token market cap (FDV)
   * @param mcProfil - Median FDV of creator's SUCCESS tokens
   * @param confianceCartel - Cartel confidence score (0-1)
   * @returns P_exit score (unbounded, typically 0-2+)
   */
  computePExitV1(mcActuel: number, mcProfil: number, confianceCartel: number): number {
    if (mcProfil === 0) {
      logger.warn('MC_profil is 0, cannot compute P_exit v1');
      return 0;
    }

    const mcRatio = mcActuel / mcProfil;
    return mcRatio * confianceCartel;
  }

  /**
   * Compute P_exit v2 (sigmoid formula).
   * Formula: sigmoid(α × (MC_ratio - 1)) × Confiance_cartel_v2
   *
   * @param mcActuel - Current token market cap (FDV)
   * @param mcProfil - Median FDV of creator's SUCCESS tokens
   * @param confianceCartelV2 - Cartel confidence score v2 (0-1)
   * @returns P_exit score (0-1)
   */
  computePExitV2(mcActuel: number, mcProfil: number, confianceCartelV2: number): number {
    if (mcProfil === 0) {
      logger.warn('MC_profil is 0, cannot compute P_exit v2');
      return 0;
    }

    const mcRatio = mcActuel / mcProfil;
    const sigmoidValue = sigmoid(ALPHA_PEXIT * (mcRatio - 1));
    return sigmoidValue * confianceCartelV2;
  }

  /**
   * Get exit action from P_exit v1 score.
   * Zones:
   * - ≥1.5: EXIT IMMEDIATE (sell 100%)
   * - 1.0-1.49: EXIT PROGRESSIF (sell 50% + trailing stop)
   * - 0.5-0.99: HOLD (sell 0%)
   * - <0.5: WATCH (stop-loss serré)
   *
   * @param pExit - P_exit v1 score
   * @returns Exit action with sell percentage
   */
  getExitActionV1(pExit: number): ExitAction {
    if (pExit >= 1.5) {
      return { action: 'EXIT_IMMEDIATE', sellPct: 100 };
    } else if (pExit >= 1.0) {
      return { action: 'EXIT_PROGRESSIF', sellPct: 50 };
    } else if (pExit >= 0.5) {
      return { action: 'HOLD', sellPct: 0 };
    } else {
      return { action: 'WATCH', sellPct: 0 };
    }
  }

  /**
   * Get exit action from P_exit v2 score.
   * Continuous sell percentage: pExit × 100% (capped at 100%)
   *
   * @param pExit - P_exit v2 score (0-1)
   * @returns Exit action with sell percentage
   */
  getExitActionV2(pExit: number): ExitAction {
    const sellPct = Math.min(100, pExit * 100);
    return { action: 'SELL', sellPct };
  }

  /**
   * Recalculate P_exit for a token and persist to database.
   *
   * @param tokenAddress - Token address
   * @param currentMC - Current market cap (FDV)
   * @returns Updated P_exit scores
   */
  async recalculatePExit(
    tokenAddress: string,
    currentMC: number
  ): Promise<{ pExitV1: number; pExitV2: number }> {
    const startTime = Date.now();

    try {
      // Get token event
      const token = await this.tokenRepo.getByAddress(tokenAddress);
      if (!token) {
        throw new Error(`Token ${tokenAddress} not found`);
      }

      // Get MC_profil
      const mcProfil = await this.getMedianMC(token.creator_wallet);
      if (mcProfil === 0) {
        logger.debug({ tokenAddress }, 'MC_profil is 0, skipping P_exit calculation');
        return { pExitV1: 0, pExitV2: 0 };
      }

      // Get cartel confidence scores
      const wallet = await this.walletRepo.getByAddress(token.creator_wallet);
      let confianceV1 = 1.0;
      let confianceV2 = 1.0;

      if (wallet?.cartel_id) {
        const cartel = await this.cartelRepo.getById(wallet.cartel_id);
        if (cartel) {
          confianceV1 = cartel.confidence_score;
          confianceV2 = cartel.confidence_score_v2;
        }
      }

      // Compute P_exit
      const pExitV1 = this.computePExitV1(currentMC, mcProfil, confianceV1);
      const pExitV2 = this.computePExitV2(currentMC, mcProfil, confianceV2);

      // Persist to database
      await this.tokenRepo.updatePExit(tokenAddress, pExitV1, pExitV2);

      const elapsed = Date.now() - startTime;
      logger.debug(
        { tokenAddress, pExitV1, pExitV2, elapsed },
        'P_exit recalculated'
      );

      return { pExitV1, pExitV2 };
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to recalculate P_exit');
      throw error;
    }
  }
}
