import type { Pool } from 'pg';
import { TradeExecutor, type TradeSignal } from './TradeExecutor.js';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * PaperTradeExecutor — Paper trading wrapper for TradeExecutor (v4.2 Spot)
 *
 * Logs all BUY/SELL spot trade signals with intelligent exit detection.
 * Tracks stagnation-based exits and temporal window-based exits.
 * Useful for production testing and strategy validation.
 */
export class PaperTradeExecutor extends TradeExecutor {
  private logFilePath: string;
  private paperMode: boolean;

  constructor(pool: Pool) {
    super(pool);
    this.paperMode = process.env.PAPER_TRADING_MODE === 'true';
    this.logFilePath = process.env.PAPER_TRADING_LOG_FILE || './data/paper-trades.log';

    if (this.paperMode) {
      logger.info({ logFile: this.logFilePath }, 'Paper trading mode ENABLED - trades will be logged but not executed');
      this.ensureLogDirectory().catch(error => {
        logger.error({ error }, 'Failed to create paper trading log directory');
      });
    }
  }

  /**
   * Ensure log directory exists
   */
  private async ensureLogDirectory(): Promise<void> {
    const dir = path.dirname(this.logFilePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.error({ error, dir }, 'Failed to create log directory');
    }
  }

  /**
   * Override evaluateTrade to log signals in paper mode
   */
  async evaluateTrade(
    tokenAddress: string,
    elapsedMinutes: number,
    currentMC: number
  ): Promise<TradeSignal> {
    const signal = await super.evaluateTrade(tokenAddress, elapsedMinutes, currentMC);

    if (this.paperMode) {
      await this.logPaperTrade(tokenAddress, elapsedMinutes, currentMC, signal);
    }

    return signal;
  }

  /**
   * Log paper trade to file (v4.2 spot with stagnation detection)
   */
  private async logPaperTrade(
    tokenAddress: string,
    elapsedMinutes: number,
    currentMC: number,
    signal: TradeSignal
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      token: tokenAddress,
      elapsed_min: elapsedMinutes.toFixed(2),
      current_mc: currentMC,
      action: signal.action,
      confidence: signal.confidence.toFixed(3),
      percentage: signal.percentage || 0,
      reason: signal.reason,
      strategy: signal.playbook_strategy || 'NONE'
    };

    const logLine = JSON.stringify(logEntry) + '\n';

    try {
      await fs.appendFile(this.logFilePath, logLine);
      logger.info(logEntry, '[PAPER TRADE]');
    } catch (error) {
      logger.error({ error, logEntry }, 'Failed to write paper trade log');
    }
  }

  /**
   * Get statistics from paper trading log
   */
  async getPaperTradingStats(): Promise<{
    total_signals: number;
    by_action: Record<string, number>;
    by_strategy: Record<string, number>;
    avg_confidence: number;
  }> {
    try {
      const content = await fs.readFile(this.logFilePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      const entries = lines.map(line => JSON.parse(line));

      const byAction: Record<string, number> = {};
      const byStrategy: Record<string, number> = {};
      let totalConfidence = 0;

      for (const entry of entries) {
        byAction[entry.action] = (byAction[entry.action] || 0) + 1;
        byStrategy[entry.strategy] = (byStrategy[entry.strategy] || 0) + 1;
        totalConfidence += parseFloat(entry.confidence);
      }

      return {
        total_signals: entries.length,
        by_action: byAction,
        by_strategy: byStrategy,
        avg_confidence: entries.length > 0 ? totalConfidence / entries.length : 0
      };
    } catch (error) {
      logger.error({ error }, 'Failed to read paper trading stats');
      return {
        total_signals: 0,
        by_action: {},
        by_strategy: {},
        avg_confidence: 0
      };
    }
  }
}
