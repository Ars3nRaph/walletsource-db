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
  confidence: number;
  percentage?: number;
  reason: string;
  playbook_strategy?: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID';
}

interface OpenPosition {
  entryMC: number;
  entryTime: Date;
  highestMC: number; // trailing high for stop-loss
}

/**
 * TradeExecutor — v4.3 Strict Entry/Exit with Position Tracking
 *
 * Fixes vs v4.2:
 * 1. Position tracking — no SELL without an open BUY, no double BUY
 * 2. Pre-buy pump confirmation — MC must have risen ≥5% from first snapshot before buying
 * 3. Hard stop-loss — exit if MC drops 20% from entry price
 * 4. pumpRatio gate — block entry if already at/past expected peak (ratio ≥ 1.0x of expected move)
 * 5. Discard RIDE wallets with fallback pump=3.0 and avg_peak_mc < $2000 (not real traders)
 * 6. Min liquidity check via MC floor — don't buy if MC hasn't moved (DexScreener cache = token dead)
 */
export class TradeExecutor {
  private tokenRepo: TokenEventRepo;
  private walletRepo: WalletRepo;
  private stagnationDetector: StagnationDetector;
  private peakDetector: PeakDurationDetector;

  // Position state — only one position per token at a time
  private openPositions: Map<string, OpenPosition> = new Map();
  // First snapshot MC per token (for pump confirmation)
  private firstSnapshotMC: Map<string, number> = new Map();

  constructor(pool: Pool) {
    this.tokenRepo = new TokenEventRepo(pool);
    this.walletRepo = new WalletRepo(pool);
    this.stagnationDetector = new StagnationDetector();
    this.peakDetector = new PeakDurationDetector();
  }

  async evaluateTrade(
    tokenAddress: string,
    elapsedMinutes: number,
    currentMC: number
  ): Promise<TradeSignal> {
    try {
      // Record MC for detectors + first snapshot tracking
      this.stagnationDetector.recordSnapshot(tokenAddress, currentMC);
      this.peakDetector.recordSnapshot(tokenAddress, currentMC);

      if (!this.firstSnapshotMC.has(tokenAddress)) {
        this.firstSnapshotMC.set(tokenAddress, currentMC);
      }

      // Update trailing high on open position (for stop-loss)
      const pos = this.openPositions.get(tokenAddress);
      if (pos && currentMC > pos.highestMC) {
        pos.highestMC = currentMC;
      }

      // Get token and wallet
      const token = await this.tokenRepo.getByAddress(tokenAddress);
      if (!token) return { action: 'NONE', confidence: 0, reason: 'Token not found' };

      const wallet = await this.walletRepo.getByAddress(token.creator_wallet);
      if (!wallet) return { action: 'NONE', confidence: 0, reason: 'Wallet not found' };

      // Parse playbook
      let playbook: RuggerPlaybook | null = null;
      if (wallet.rugger_playbook) {
        playbook = typeof wallet.rugger_playbook === 'string'
          ? JSON.parse(wallet.rugger_playbook)
          : wallet.rugger_playbook;
      }

      if (!playbook) {
        return { action: 'NONE', confidence: 0, reason: 'No playbook - not a predictable rugger' };
      }

      // ONLY trade RIDE strategy
      if (playbook.recommended_strategy !== 'RIDE') {
        return {
          action: 'NONE',
          confidence: 0,
          reason: `Strategy ${playbook.recommended_strategy} - only trading RIDE ruggers`,
          playbook_strategy: playbook.recommended_strategy
        };
      }

      // FIX: Discard wallets with fallback pump=3.0 and low avg_peak_mc
      // These wallets have insufficient real data (fdv_at_detection was null)
      const avgPumpMultiple = playbook.avg_pump_multiple ?? 3.0;
      const avgPeakMC = playbook.avg_peak_mc ?? 0;
      if (avgPumpMultiple >= 2.9 && avgPeakMC < 2000) {
        return {
          action: 'NONE',
          confidence: 0,
          reason: `Fallback pump data (${avgPumpMultiple.toFixed(1)}x on avg_peak $${avgPeakMC.toFixed(0)}) — insufficient real entry data`,
          playbook_strategy: 'RIDE'
        };
      }

      // Minimum avg_peak_mc threshold
      if (avgPeakMC < 2000) {
        return {
          action: 'NONE',
          confidence: 0,
          reason: `avg_peak_mc $${avgPeakMC.toFixed(0)} < $2000 minimum — no real pump`,
          playbook_strategy: 'RIDE'
        };
      }

      // Minimum consistency
      if (playbook.consistency_score < 0.7) {
        return {
          action: 'NONE',
          confidence: playbook.consistency_score,
          reason: `Low consistency ${playbook.consistency_score.toFixed(2)} < 0.70`,
          playbook_strategy: 'RIDE'
        };
      }

      return this.evaluateRide(playbook, elapsedMinutes, tokenAddress, currentMC);
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to evaluate trade');
      return { action: 'NONE', confidence: 0, reason: 'Evaluation error' };
    }
  }

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
      consistency_score,
    } = playbook;

    const avgPumpMultiple = playbook.avg_pump_multiple ?? 3.0;
    const hasOpenPosition = this.openPositions.has(tokenAddress);
    const pos = this.openPositions.get(tokenAddress);

    // ── POSITION OPEN: manage the existing trade ──────────────────────────────
    if (hasOpenPosition && pos) {
      const entryMC = pos.entryMC;

      // STOP-LOSS: MC dropped 5%+ from entry → cut immediately
      const dropFromEntry = (entryMC - currentMC) / entryMC;
      if (dropFromEntry >= 0.05) {
        this.closePosition(tokenAddress);
        return {
          action: 'SELL',
          confidence: 1.0,
          percentage: 100,
          reason: `🛑 STOP-LOSS: MC dropped ${(dropFromEntry * 100).toFixed(1)}% from entry ($${entryMC.toFixed(0)} → $${currentMC.toFixed(0)})`,
          playbook_strategy: 'RIDE'
        };
      }

      // TRAILING STOP: MC dropped 5%+ from highest point since entry
      const dropFromHigh = (pos.highestMC - currentMC) / pos.highestMC;
      if (dropFromHigh >= 0.05 && pos.highestMC > entryMC * 1.05) {
        this.closePosition(tokenAddress);
        return {
          action: 'SELL',
          confidence: 1.0,
          percentage: 100,
          reason: `📉 TRAILING STOP: MC dropped ${(dropFromHigh * 100).toFixed(1)}% from high ($${pos.highestMC.toFixed(0)} → $${currentMC.toFixed(0)})`,
          playbook_strategy: 'RIDE'
        };
      }

      // DUMP detection (StagnationDetector)
      if (this.stagnationDetector.checkDump(tokenAddress)) {
        const stats = this.stagnationDetector.getStats(tokenAddress);
        this.closePosition(tokenAddress);
        return {
          action: 'SELL',
          confidence: 1.0,
          percentage: 100,
          reason: `Dump detected (${stats ? (stats.dumpFromPeak * 100).toFixed(1) : '?'}% from peak) — immediate exit`,
          playbook_strategy: 'RIDE'
        };
      }

      // STAGNATION after peak
      if (this.stagnationDetector.checkStagnation(tokenAddress)) {
        this.closePosition(tokenAddress);
        return {
          action: 'SELL',
          confidence: 0.9,
          percentage: 100,
          reason: `Stagnation after peak (no 5% MC rise in 20s) — early exit`,
          playbook_strategy: 'RIDE'
        };
      }

      // EXIT WINDOW
      if (elapsedMinutes >= exit_window_start_min) {
        if (elapsedMinutes <= exit_window_end_min) {
          const windowDuration = exit_window_end_min - exit_window_start_min;
          const progress = windowDuration > 0
            ? (elapsedMinutes - exit_window_start_min) / windowDuration
            : 1.0;
          const pct = Math.min(100, Math.round(progress * 100));
          if (pct >= 100) {
            this.closePosition(tokenAddress);
          }
          return {
            action: 'SELL',
            confidence: consistency_score * progress,
            percentage: pct,
            reason: `Exit window (${exit_window_start_min.toFixed(1)}-${exit_window_end_min.toFixed(1)} min, ${pct}% complete)`,
            playbook_strategy: 'RIDE'
          };
        }

        // Past exit window
        this.closePosition(tokenAddress);
        return {
          action: 'SELL',
          confidence: 1.0,
          percentage: 100,
          reason: `Past exit window (>${exit_window_end_min.toFixed(1)} min) — force close`,
          playbook_strategy: 'RIDE'
        };
      }

      // HOLD — within position, monitoring
      return {
        action: 'HOLD',
        confidence: consistency_score,
        percentage: 0,
        reason: `Holding (elapsed ${elapsedMinutes.toFixed(1)} min, entry $${entryMC.toFixed(0)}, high $${pos.highestMC.toFixed(0)}, current $${currentMC.toFixed(0)})`,
        playbook_strategy: 'RIDE'
      };
    }

    // ── NO OPEN POSITION: evaluate entry ─────────────────────────────────────

    // Past entry window → don't open
    if (elapsedMinutes > entry_window_end_min) {
      return {
        action: 'NONE',
        confidence: 0,
        reason: `Past entry window (${elapsedMinutes.toFixed(1)} > ${entry_window_end_min.toFixed(1)} min)`,
        playbook_strategy: 'RIDE'
      };
    }

    // FIX: Require minimum pump confirmation before entry
    // MC must have risen ≥5% from first snapshot to confirm token is live & pumping
    const firstMC = this.firstSnapshotMC.get(tokenAddress) ?? currentMC;
    const mcRiseFromFirst = (currentMC - firstMC) / Math.max(firstMC, 1);
    if (mcRiseFromFirst < 0.05 && elapsedMinutes > 0.5) {
      return {
        action: 'NONE',
        confidence: 0,
        reason: `No pump confirmed yet (MC +${(mcRiseFromFirst * 100).toFixed(1)}% from start, need +5%) — flat/dead token`,
        playbook_strategy: 'RIDE'
      };
    }

    // FIX: pumpRatio gate — don't enter if already past expected pump
    // estimatedEntryMC = where token starts (avg_peak / avg_pump_multiple)
    const estimatedEntryMC = avg_peak_mc / Math.max(avgPumpMultiple, 1.5);
    const currentPumpRatio = currentMC / Math.max(estimatedEntryMC, 1);
    const maxEntryRatio = 1 + (avgPumpMultiple - 1) * 0.50; // max 50% into the expected move

    if (currentPumpRatio > maxEntryRatio) {
      return {
        action: 'NONE',
        confidence: 0,
        reason: `Entry missed — pumped ${currentPumpRatio.toFixed(2)}x already (max ${maxEntryRatio.toFixed(2)}x, expected total ${avgPumpMultiple.toFixed(1)}x)`,
        playbook_strategy: 'RIDE'
      };
    }

    // FIX: MC floor sanity — if current MC == first MC and > 30s elapsed, likely DexScreener cache (token dead)
    if (currentMC === firstMC && elapsedMinutes > 0.5) {
      return {
        action: 'NONE',
        confidence: 0,
        reason: `MC unchanged since start ($${currentMC.toFixed(0)}) — DexScreener cache or dead token`,
        playbook_strategy: 'RIDE'
      };
    }

    // All checks passed → open position
    this.openPositions.set(tokenAddress, {
      entryMC: currentMC,
      entryTime: new Date(),
      highestMC: currentMC
    });

    logger.info({
      token: tokenAddress,
      entryMC: currentMC,
      elapsedMin: elapsedMinutes.toFixed(2),
      pumpRatio: currentPumpRatio.toFixed(2),
      expectedPump: avgPumpMultiple.toFixed(1),
      mcRiseFromFirst: (mcRiseFromFirst * 100).toFixed(1) + '%'
    }, '[POSITION OPENED]');

    return {
      action: 'BUY',
      confidence: consistency_score,
      percentage: 100,
      reason: `BUY confirmed: +${(mcRiseFromFirst*100).toFixed(1)}% rise, pumpRatio ${currentPumpRatio.toFixed(2)}x/${maxEntryRatio.toFixed(2)}x max, window 0-${entry_window_end_min.toFixed(1)}min`,
      playbook_strategy: 'RIDE'
    };
  }

  private closePosition(tokenAddress: string): void {
    const pos = this.openPositions.get(tokenAddress);
    if (pos) {
      const holdMin = (Date.now() - pos.entryTime.getTime()) / 60000;
      logger.info({
        token: tokenAddress,
        entryMC: pos.entryMC,
        highestMC: pos.highestMC,
        holdMin: holdMin.toFixed(2)
      }, '[POSITION CLOSED]');
      this.openPositions.delete(tokenAddress);
    }
    // Clean first snapshot (token lifecycle done)
    this.firstSnapshotMC.delete(tokenAddress);
  }

  /**
   * Called when token tracking ends — close any lingering position
   */
  closePositionIfOpen(tokenAddress: string): void {
    if (this.openPositions.has(tokenAddress)) {
      this.closePosition(tokenAddress);
    }
    this.firstSnapshotMC.delete(tokenAddress);
  }
}
