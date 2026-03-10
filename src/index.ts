import dotenv from 'dotenv';
import { logger } from './utils/logger.js';
import { getDb, closeDb } from './db/connection.js';
import { ForensicWorker } from './workers/ForensicWorker.js';
import { TokenTracker } from './workers/TokenTracker.js';
import { CartelDetector } from './cartels/CartelDetector.js';
import { HealthCheck } from './utils/healthCheck.js';
import type { Pool } from 'pg';

// Load environment variables
dotenv.config();

const CARTEL_DETECTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

class WalletSourceDB {
  private pool: Pool | null = null;
  private forensicWorker: ForensicWorker | null = null;
  private tokenTracker: TokenTracker | null = null;
  private cartelDetector: CartelDetector | null = null;
  private healthCheck: HealthCheck | null = null;
  private cartelDetectionInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  async start(): Promise<void> {
    try {
      logger.info('WalletSourceDB v4.0 "Ride the Rugger" starting...');

      // 1. Initialize database connection
      this.pool = await getDb();
      logger.info('Database connection established');

      // 2. Initialize health check
      this.healthCheck = new HealthCheck(this.pool);

      // 3. Start ForensicWorker (WSS token detection + ancestry)
      this.forensicWorker = new ForensicWorker(this.pool);
      await this.forensicWorker.start();
      logger.info('ForensicWorker started');

      // 4. Start TokenTracker (continuous polling for 30 minutes)
      this.tokenTracker = new TokenTracker(this.pool);
      await this.tokenTracker.start();
      logger.info('TokenTracker started');

      // Wire PumpTradeStream → TradeExecutor for live tick-level signals
      if (this.forensicWorker && this.tokenTracker) {
        const te = this.tokenTracker.tradeExecutor;
        this.forensicWorker.pumpTradeStream.setTradeExecutor(te);
        this.forensicWorker.tradeExecutor = te;  // v5.1: instant RIDE entry
        te.startPositionSweep();  // v5.3.1: periodic stale position cleanup
        logger.info('PumpTradeStream → TradeExecutor wired');
      }

      // 5. Start CartelDetector (batch every 5 min)
      this.cartelDetector = new CartelDetector(this.pool);
      this.cartelDetectionInterval = setInterval(async () => {
        try {
          await this.cartelDetector!.detectCartels();
        } catch (error) {
          logger.error({ error }, 'Cartel detection failed');
        }
      }, CARTEL_DETECTION_INTERVAL_MS);
      logger.info({ intervalMs: CARTEL_DETECTION_INTERVAL_MS }, 'CartelDetector scheduled');

      // 6. Start HealthCheck (every 5 min)
      this.healthCheckInterval = setInterval(async () => {
        try {
          await this.healthCheck!.checkAndAlert();
        } catch (error) {
          logger.error({ error }, 'Health check failed');
        }
      }, HEALTH_CHECK_INTERVAL_MS);
      logger.info({ intervalMs: HEALTH_CHECK_INTERVAL_MS }, 'HealthCheck scheduled');

      // Run initial health check
      await this.healthCheck.checkAndAlert();

      logger.info('🚀 WalletSourceDB is running');
      logger.info('Press Ctrl+C to stop');
    } catch (error) {
      logger.error({ error }, 'Failed to start WalletSourceDB');
      await this.stop();
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    logger.info('WalletSourceDB shutting down...');

    try {
      // 1. Stop health check interval
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
        logger.info('HealthCheck stopped');
      }

      // 2. Stop cartel detection interval
      if (this.cartelDetectionInterval) {
        clearInterval(this.cartelDetectionInterval);
        this.cartelDetectionInterval = null;
        logger.info('CartelDetector stopped');
      }

      // 3. Stop TokenTracker
      if (this.tokenTracker) {
        await this.tokenTracker.stop();
      }

      // 4. Stop ForensicWorker (close WSS)
      if (this.forensicWorker) {
        await this.forensicWorker.stop();
      }

      // 5. Close database connection
      if (this.pool) {
        await closeDb();
        logger.info('Database connection closed');
      }

      logger.info('✅ WalletSourceDB stopped gracefully');
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  }
}

// Main execution
const app = new WalletSourceDB();

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  logger.info('Received SIGINT');
  await app.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM');
  await app.stop();
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
  process.exit(1);
});

// Start the application
app.start().catch((error) => {
  logger.error({ error }, 'Failed to start application');
  process.exit(1);
});
