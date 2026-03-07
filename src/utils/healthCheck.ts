import type { Pool } from 'pg';
import { logger } from './logger.js';

export interface HealthMetrics {
  tokensPerHour: number;
  rugRate: number;
  successRate: number;
  uniqueWalletsToday: number;
  apiCallsPerHour: number;
  heliusCallsToday: number;
  avgLatency: number;
  cartelsTotal: number;
}

export class HealthCheck {
  private pool: Pool;
  private apiCallTimestamps: number[] = [];
  private heliusCallTimestamps: number[] = [];
  private latencyMeasurements: number[] = [];

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Record an API call (DexScreener).
   */
  recordApiCall(): void {
    this.apiCallTimestamps.push(Date.now());
    this.cleanupOldTimestamps();
  }

  /**
   * Record a Helius API call.
   */
  recordHeliusCall(): void {
    this.heliusCallTimestamps.push(Date.now());
    this.cleanupOldTimestamps();
  }

  /**
   * Record operation latency in milliseconds.
   */
  recordLatency(latencyMs: number): void {
    this.latencyMeasurements.push(latencyMs);

    // Keep only last 100 measurements
    if (this.latencyMeasurements.length > 100) {
      this.latencyMeasurements.shift();
    }
  }

  /**
   * Get comprehensive health metrics.
   */
  async getHealthMetrics(): Promise<HealthMetrics> {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    try {
      // Calculate timestamps (avoid INTERVAL for pg-mem compatibility)
      const oneHourAgoDate = new Date(oneHourAgo);
      const oneDayAgoDate = new Date(oneDayAgo);

      // Tokens per hour
      const tokensPerHourResult = await this.pool.query<{ count: number }>(
        `SELECT COUNT(*) as count
         FROM token_events
         WHERE detected_at >= $1`,
        [oneHourAgoDate]
      );
      const tokensPerHour = parseInt(tokensPerHourResult.rows[0]?.count?.toString() || '0', 10);

      // Rug rate (last 24h)
      const rugRateResult = await this.pool.query<{ rug_count: number; total_count: number }>(
        `SELECT
           SUM(CASE WHEN verdict IN ('RUG_NO_PAIR', 'RUG_METRICS') THEN 1 ELSE 0 END) as rug_count,
           COUNT(*) as total_count
         FROM token_events
         WHERE checked_at >= $1
           AND verdict IS NOT NULL`,
        [oneDayAgoDate]
      );
      const rugCount = parseInt(rugRateResult.rows[0]?.rug_count?.toString() || '0', 10);
      const totalCount = parseInt(rugRateResult.rows[0]?.total_count?.toString() || '0', 10);
      const rugRate = totalCount > 0 ? rugCount / totalCount : 0;

      // Success rate (last 24h)
      const successRateResult = await this.pool.query<{ success_count: number }>(
        `SELECT COUNT(*) as success_count
         FROM token_events
         WHERE checked_at >= $1
           AND verdict = 'SUCCESS'`,
        [oneDayAgoDate]
      );
      const successCount = parseInt(successRateResult.rows[0]?.success_count?.toString() || '0', 10);
      const successRate = totalCount > 0 ? successCount / totalCount : 0;

      // Unique wallets today
      const uniqueWalletsResult = await this.pool.query<{ count: number }>(
        `SELECT COUNT(DISTINCT creator_wallet) as count
         FROM token_events
         WHERE detected_at >= $1`,
        [oneDayAgoDate]
      );
      const uniqueWalletsToday = parseInt(uniqueWalletsResult.rows[0]?.count?.toString() || '0', 10);

      // Total cartels
      const cartelsResult = await this.pool.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM cartel_groups`
      );
      const cartelsTotal = parseInt(cartelsResult.rows[0]?.count?.toString() || '0', 10);

      // API calls per hour (from tracked timestamps)
      const apiCallsPerHour = this.apiCallTimestamps.filter(ts => ts >= oneHourAgo).length;

      // Helius calls today
      const heliusCallsToday = this.heliusCallTimestamps.filter(ts => ts >= oneDayAgo).length;

      // Average latency
      const avgLatency = this.latencyMeasurements.length > 0
        ? this.latencyMeasurements.reduce((sum, lat) => sum + lat, 0) / this.latencyMeasurements.length
        : 0;

      return {
        tokensPerHour,
        rugRate,
        successRate,
        uniqueWalletsToday,
        apiCallsPerHour,
        heliusCallsToday,
        avgLatency,
        cartelsTotal
      };
    } catch (error) {
      logger.error({ error }, 'Failed to compute health metrics');
      throw error;
    }
  }

  /**
   * Check health metrics against thresholds and log alerts.
   * Thresholds from PRD section 8.5.
   */
  async checkAndAlert(): Promise<void> {
    const metrics = await this.getHealthMetrics();

    logger.info({ metrics }, 'Health check');

    // Alert: Abnormal rug rate
    if (metrics.rugRate > 0.8 && metrics.tokensPerHour > 10) {
      logger.warn({ rugRate: metrics.rugRate }, 'ALERT: Abnormally high rug rate (>80%)');
    }

    // Alert: Very low success rate
    if (metrics.successRate < 0.05 && metrics.tokensPerHour > 10) {
      logger.warn({ successRate: metrics.successRate }, 'ALERT: Very low success rate (<5%)');
    }

    // Alert: High API usage
    if (metrics.apiCallsPerHour > 900) {
      logger.warn({ apiCallsPerHour: metrics.apiCallsPerHour }, 'ALERT: Approaching DexScreener rate limit (900/1000)');
    }

    // Alert: High Helius usage
    if (metrics.heliusCallsToday > 12000) { // ~66k/month limit estimate
      logger.warn({ heliusCallsToday: metrics.heliusCallsToday }, 'ALERT: High Helius API usage today');
    }

    // Alert: High latency
    if (metrics.avgLatency > 1000) {
      logger.warn({ avgLatency: metrics.avgLatency }, 'ALERT: High average latency (>1s)');
    }

    // Alert: No tokens detected
    if (metrics.tokensPerHour === 0) {
      logger.warn('ALERT: No tokens detected in the last hour - possible WSS connection issue');
    }
  }

  /**
   * Remove timestamps older than 24 hours to prevent memory leak.
   */
  private cleanupOldTimestamps(): void {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    this.apiCallTimestamps = this.apiCallTimestamps.filter(ts => ts >= oneDayAgo);
    this.heliusCallTimestamps = this.heliusCallTimestamps.filter(ts => ts >= oneDayAgo);
  }
}
