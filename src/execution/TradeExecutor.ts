import type { Pool } from 'pg';
import type { RuggerPlaybook } from '../types/index.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { StagnationDetector } from './StagnationDetector.js';
import { PeakDurationDetector } from './PeakDurationDetector.js';
import { logger } from '../utils/logger.js';

export type TradeAction = 'BUY' | 'SELL' | 'HOLD' | 'NONE';

export interface TradeSignal {
  action: TradeAction;
  confidence: number; // 0-1
  percentage?: number; // 0-100, % of position to enter/exit
  reason: string;
  playbook_strategy?: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID';
}

/**
 * TradeExecutor — v4.2 Spot Trading with Intelligent Exit
 *
 * Uses BUY/SELL spot trading with intelligent exit signals:
 * - Exit on stagnation detection (no 5% MC rise in 20s)
 * - Exit in temporal exit window (playbook-based)
 * - Peak duration tracking for optimized sell timing
 *
 * Strategy execution:
 * - RIDE only (consistency >= 0.70)
 * - BUY: Entry in entry_window
 * - SELL: Stagnation detected OR exit_window reached
 */
export class TradeExecutor {
  private tokenRepo: TokenEventRepo;
  private walletRepo: WalletRepo;
  private stagnationDetector: StagnationDetector;
  private peakDetector: PeakDurationDetector;

  constructor(pool: Pool) {
    this.tokenRepo = new TokenEventRepo(pool);
    this.walletRepo = new WalletRepo(pool);
    this.stagnationDetector = new StagnationDetector();
    this.peakDetector = new PeakDurationDetector();
  }

  /**
   * Evaluate trade action based on spot BUY/SELL with intelligent exit.
   *
   * @param tokenAddress - Token address
   * @param elapsedMinutes - Minutes elapsed since token detection
   * @param currentMC - Current market cap (FDV)
   * @returns Trade signal with BUY/SELL/HOLD action
   */
  async evaluateTrade(
    tokenAddress: string,
    elapsedMinutes: number,
    currentMC: number
  ): Promise<TradeSignal> {
    try {
      // Record snapshot for detectors
      this.stagnationDetector.recordSnapshot(tokenAddress, currentMC);
      this.peakDetector.recordSnapshot(tokenAddress, currentMC);

      // Get token and creator wallet
      const token = await this.tokenRepo.getByAddress(tokenAddress);
      if (!token) {
        return {
          action: 'NONE',
          confidence: 0,
          reason: 'Token not found'
        };
      }

      // Get wallet with playbook
      const wallet = await this.walletRepo.getByAddress(token.creator_wallet);
      if (!wallet) {
        return {
          action: 'NONE',
          confidence: 0,
          reason: 'Wallet not found'
        };
      }

      // Parse playbook
      let playbook: RuggerPlaybook | null = null;
      if (wallet.rugger_playbook) {
        playbook = typeof wallet.rugger_playbook === 'string'
          ? JSON.parse(wallet.rugger_playbook)
          : wallet.rugger_playbook;
      }

      // No playbook → NO TRADE
      if (!playbook) {
        return {
          action: 'NONE',
          confidence: 0,
          reason: 'No playbook - not a predictable rugger'
        };
      }

      // ONLY trade RIDE strategy (predictable ruggers)
      if (playbook.recommended_strategy !== 'RIDE') {
        return {
          action: 'NONE',
          confidence: 0,
          reason: `Strategy ${playbook.recommended_strategy} - only trading RIDE ruggers`,
          playbook_strategy: playbook.recommended_strategy
        };
      }

      // Require high confidence (≥ 0.7)
      if (playbook.consistency_score < 0.7) {
        return {
          action: 'NONE',
          confidence: playbook.consistency_score,
          reason: `Low consistency ${playbook.consistency_score.toFixed(2)} - minimum 0.70 required`,
          playbook_strategy: 'RIDE'
        };
      }

      // Evaluate RIDE strategy with intelligent exit
      return this.evaluateRide(playbook, elapsedMinutes, tokenAddress, currentMC);
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to evaluate trade');
      return {
        action: 'NONE',
        confidence: 0,
        reason: 'Evaluation error'
      };
    }
  }

  /**
   * Evaluate RIDE strategy with intelligent exit detection.
   *
   * Timeline:
   * 1. Entry window: [0, entry_window_end] → BUY (if MC not too high)
   * 2. Hold period with stagnation monitoring → HOLD or SELL (if stagnation)
   * 3. Exit window: [exit_window_start, exit_window_end] → SELL (progressive)
   * 4. Past exit: > exit_window_end → SELL 100%
   */
  private evaluateRide(
    playbook: RuggerPlaybook,
    elapsedMinutes: number,
    tokenAddress: string,
    currentMC: number
  ): TradeSignal {
    const {
      entry_window_end_min,
      exit_window_start_min,
      exit_window_end_min,
      avg_peak_mc,
      consistency_score
    } = playbook;

    // Phase 1: Entry window (before peak, low risk)
    if (elapsedMinutes <= entry_window_end_min) {
      // Protection: ne pas acheter si le prix a déjà explosé (> 70% du peak moyen)
      if (currentMC > avg_peak_mc * 0.7) {
        return {
          action: 'NONE',
          confidence: 0.5,
          percentage: 0,
          reason: `MC too high (${currentMC.toFixed(0)} > 70% of avg peak ${avg_peak_mc.toFixed(0)}) - missed entry`,
          playbook_strategy: 'RIDE'
        };
      }

      return {
        action: 'BUY',
        confidence: consistency_score,
        percentage: 100,
        reason: `Entry window (0-${entry_window_end_min.toFixed(1)} min, MC: ${currentMC.toFixed(0)} < 70% peak)`,
        playbook_strategy: 'RIDE'
      };
    }

    // Phase 2: Hold period with dump/stagnation detection
    if (elapsedMinutes < exit_window_start_min) {
      // Priority 1: Check for dump (MC dropping after peak)
      if (this.stagnationDetector.checkDump(tokenAddress)) {
        const stats = this.stagnationDetector.getStats(tokenAddress);
        return {
          action: 'SELL',
          confidence: 1.0,
          percentage: 100,
          reason: `Dump detected (MC dropped ${stats ? (stats.dumpFromPeak * 100).toFixed(1) : '?'}% from peak) - exit immediately`,
          playbook_strategy: 'RIDE'
        };
      }

      // Priority 2: Check for stagnation AFTER peak
      if (this.stagnationDetector.checkStagnation(tokenAddress)) {
        return {
          action: 'SELL',
          confidence: 0.9,
          percentage: 100,
          reason: `Stagnation after peak (no 5% MC rise in 20s) - early exit`,
          playbook_strategy: 'RIDE'
        };
      }

      // Continue holding (monitoring for peak/dump)
      const hasPeak = this.stagnationDetector.hasPeakBeenReached(tokenAddress);
      return {
        action: 'HOLD',
        confidence: consistency_score,
        percentage: 0,
        reason: hasPeak
          ? `Hold after peak (${entry_window_end_min.toFixed(1)}-${exit_window_start_min.toFixed(1)} min, monitoring for dump)`
          : `Hold period (${entry_window_end_min.toFixed(1)}-${exit_window_start_min.toFixed(1)} min, waiting for peak)`,
        playbook_strategy: 'RIDE'
      };
    }

    // Phase 3: Exit window (progressive sell, but prioritize dump/stagnation)
    if (elapsedMinutes <= exit_window_end_min) {
      // Priority 1: Check for dump first
      if (this.stagnationDetector.checkDump(tokenAddress)) {
        const stats = this.stagnationDetector.getStats(tokenAddress);
        return {
          action: 'SELL',
          confidence: 1.0,
          percentage: 100,
          reason: `Dump detected in exit window (MC dropped ${stats ? (stats.dumpFromPeak * 100).toFixed(1) : '?'}% from peak) - immediate full exit`,
          playbook_strategy: 'RIDE'
        };
      }

      // Priority 2: Check for stagnation (immediate exit)
      if (this.stagnationDetector.checkStagnation(tokenAddress)) {
        return {
          action: 'SELL',
          confidence: 1.0,
          percentage: 100,
          reason: `Stagnation detected in exit window - immediate full exit`,
          playbook_strategy: 'RIDE'
        };
      }

      // Progressive sell based on time
      const windowDuration = exit_window_end_min - exit_window_start_min;
      const progress = windowDuration > 0
        ? (elapsedMinutes - exit_window_start_min) / windowDuration
        : 1.0;

      return {
        action: 'SELL',
        confidence: consistency_score * progress,
        percentage: Math.min(100, Math.round(progress * 100)),
        reason: `Exit window (${exit_window_start_min.toFixed(1)}-${exit_window_end_min.toFixed(1)} min, ${Math.round(progress * 100)}% complete)`,
        playbook_strategy: 'RIDE'
      };
    }

    // Phase 4: Past exit window → emergency exit
    return {
      action: 'SELL',
      confidence: 1.0,
      percentage: 100,
      reason: `Past exit window (>${exit_window_end_min.toFixed(1)} min)`,
      playbook_strategy: 'RIDE'
    };
  }

}
