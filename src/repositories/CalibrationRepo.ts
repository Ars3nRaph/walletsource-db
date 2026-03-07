import type { Pool } from 'pg';
import type { CalibrationLog } from '../types/index.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { logger } from '../utils/logger.js';

export class CalibrationRepo {
  constructor(private pool: Pool) {}

  /**
   * Log a calibration attempt.
   * @param paramName - Parameter name (e.g., 'k_confidence', 'alpha_pexit')
   * @param oldValue - Previous parameter value
   * @param newValue - Proposed new value
   * @param improvementPct - Performance improvement percentage
   * @param tokensEvaluated - Number of tokens used for evaluation
   * @param accepted - Whether the new value was accepted
   */
  async logCalibration(
    paramName: string,
    oldValue: number,
    newValue: number,
    improvementPct: number,
    tokensEvaluated: number,
    accepted: boolean
  ): Promise<CalibrationLog> {
    try {
      const result = await this.pool.query<CalibrationLog>(
        `INSERT INTO calibration_log (calibrated_at, param_name, old_value, new_value, improvement_pct, tokens_evaluated, accepted)
         VALUES (NOW(), $1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [paramName, oldValue, newValue, improvementPct, tokensEvaluated, accepted]
      );

      logger.info(
        { param_name: paramName, old_value: oldValue, new_value: newValue, improvement_pct: improvementPct, accepted },
        'Calibration logged'
      );

      return result.rows[0];
    } catch (error) {
      logger.error({ error, paramName }, 'Failed to log calibration');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to log calibration for ${paramName}`,
        { error }
      );
    }
  }

  /**
   * Get calibration history for a specific parameter.
   * @param paramName - Parameter name
   * @returns Array of calibration logs ordered by date (newest first)
   */
  async getHistory(paramName: string): Promise<CalibrationLog[]> {
    try {
      const result = await this.pool.query<CalibrationLog>(
        'SELECT * FROM calibration_log WHERE param_name = $1 ORDER BY calibrated_at DESC',
        [paramName]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, paramName }, 'Failed to get calibration history');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get calibration history for ${paramName}`,
        { error }
      );
    }
  }

  /**
   * Get all calibration logs from the last N days.
   * @param days - Number of days to look back
   * @returns Array of calibration logs
   */
  async getRecentLogs(days: number): Promise<CalibrationLog[]> {
    try {
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const result = await this.pool.query<CalibrationLog>(
        'SELECT * FROM calibration_log WHERE calibrated_at >= $1 ORDER BY calibrated_at DESC',
        [cutoffDate]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, days }, 'Failed to get recent calibration logs');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get calibration logs from last ${days} days`,
        { error }
      );
    }
  }

  /**
   * Get the most recent accepted calibration for a parameter.
   * @param paramName - Parameter name
   * @returns Latest accepted calibration log or null if none exists
   */
  async getLatestAccepted(paramName: string): Promise<CalibrationLog | null> {
    try {
      const result = await this.pool.query<CalibrationLog>(
        `SELECT * FROM calibration_log
         WHERE param_name = $1 AND accepted = TRUE
         ORDER BY calibrated_at DESC
         LIMIT 1`,
        [paramName]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, paramName }, 'Failed to get latest accepted calibration');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get latest accepted calibration for ${paramName}`,
        { error }
      );
    }
  }

  /**
   * Get count of accepted calibrations in the last N days.
   * @param days - Number of days to look back
   * @returns Count of accepted calibrations
   */
  async getAcceptedCount(days: number): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const result = await this.pool.query<{ count: number }>(
        'SELECT COUNT(*) as count FROM calibration_log WHERE calibrated_at >= $1 AND accepted = TRUE',
        [cutoffDate]
      );

      return parseInt(result.rows[0]?.count?.toString() || '0', 10);
    } catch (error) {
      logger.error({ error, days }, 'Failed to get accepted calibration count');
      throw new WalletSourceError(
        ErrorCode.DB_QUERY_FAILED,
        `Failed to get accepted calibration count from last ${days} days`,
        { error }
      );
    }
  }
}
