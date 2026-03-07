import dotenv from 'dotenv';
import { logger } from './utils/logger.js';
import { getDb, closeDb } from './db/connection.js';
import { ForensicWorker } from './workers/ForensicWorker.js';
import { RugScannerWorker } from './workers/RugScannerWorker.js';

// Load environment variables
dotenv.config();

logger.info('WalletSourceDB v3.0 starting...');

let forensicWorker: ForensicWorker | null = null;
let rugScannerWorker: RugScannerWorker | null = null;

async function start(): Promise<void> {
  try {
    // Initialize database
    const pool = await getDb();
    logger.info('Database initialized');

    // Start ForensicWorker (WebSocket listener)
    forensicWorker = new ForensicWorker(pool);
    await forensicWorker.start();

    // Start RugScannerWorker (verdict scanner)
    rugScannerWorker = new RugScannerWorker(pool);
    await rugScannerWorker.start();

    logger.info('All workers started successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to start workers');
    process.exit(1);
  }
}

async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  // Stop workers
  if (forensicWorker) {
    await forensicWorker.stop();
  }

  if (rugScannerWorker) {
    await rugScannerWorker.stop();
  }

  // Close database
  await closeDb();

  logger.info('Shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the application
start().catch((error) => {
  logger.error({ error }, 'Fatal error during startup');
  process.exit(1);
});
