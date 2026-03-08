#!/usr/bin/env tsx
/**
 * Backfill lifecycle data for existing RUG_NO_PAIR tokens.
 * Processes tokens in small batches to avoid overloading the database.
 */

import { getDb } from '../src/db/connection.js';
import { SnapshotRepo } from '../src/repositories/SnapshotRepo.js';
import { logger } from '../src/utils/logger.js';
import type { TokenSnapshot } from '../src/types/index.js';

const BATCH_SIZE = 20; // Process 20 tokens at a time
const BATCH_DELAY_MS = 2000; // 2 seconds between batches

interface TokenEvent {
  token_address: string;
  creator_wallet: string;
  detected_at: Date;
}

async function backfillLifecycleData(): Promise<void> {
  const pool = await getDb();
  const snapshotRepo = new SnapshotRepo(pool);

  try {
    // Get all RUG_NO_PAIR tokens without lifecycle data
    const result = await pool.query<TokenEvent>(
      `SELECT token_address, creator_wallet, detected_at
       FROM token_events
       WHERE verdict = 'RUG_NO_PAIR'
         AND (time_to_peak_min IS NULL OR time_to_rug_min IS NULL)
       ORDER BY detected_at DESC`
    );

    const tokens = result.rows;
    logger.info({ total: tokens.length }, 'Starting lifecycle data backfill');

    if (tokens.length === 0) {
      logger.info('No tokens to backfill');
      return;
    }

    // Process in batches
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batch = tokens.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(tokens.length / BATCH_SIZE);

      logger.info({ batchNum, totalBatches, size: batch.length }, 'Processing batch');

      for (const token of batch) {
        try {
          await backfillToken(pool, snapshotRepo, token);
        } catch (error) {
          logger.error({ error, token: token.token_address }, 'Failed to backfill token');
        }
      }

      // Delay between batches
      if (i + BATCH_SIZE < tokens.length) {
        logger.info({ delayMs: BATCH_DELAY_MS }, 'Waiting before next batch');
        await sleep(BATCH_DELAY_MS);
      }
    }

    logger.info({ processed: tokens.length }, 'Backfill complete');
  } catch (error) {
    logger.error({ error }, 'Backfill failed');
    throw error;
  }
}

async function backfillToken(
  pool: any,
  snapshotRepo: SnapshotRepo,
  token: TokenEvent
): Promise<void> {
  const { token_address, creator_wallet, detected_at } = token;

  // Get snapshots for this token
  const snapshots = await snapshotRepo.getByToken(token_address);

  if (snapshots.length === 0) {
    logger.debug({ token: token_address }, 'No snapshots - skipping');
    return;
  }

  // Calculate lifecycle metrics
  const metrics = calculateLifecycleMetrics(snapshots, detected_at);

  // Update token_events with calculated metrics
  await pool.query(
    `UPDATE token_events
     SET peak_mc = $1,
         peak_at = $2,
         peak_price = $3,
         time_to_peak_min = $4,
         time_to_rug_min = $5,
         liquidity_at_peak = $6
     WHERE token_address = $7`,
    [
      metrics.peak_mc,
      metrics.peak_at,
      metrics.peak_price,
      metrics.time_to_peak_min,
      metrics.time_to_rug_min,
      metrics.liquidity_at_peak,
      token_address
    ]
  );

  logger.debug({
    token: token_address,
    snapshots: snapshots.length,
    time_to_peak: metrics.time_to_peak_min,
    time_to_rug: metrics.time_to_rug_min
  }, 'Token backfilled');
}

function calculateLifecycleMetrics(
  snapshots: TokenSnapshot[],
  detectedAt: Date
): {
  peak_mc: number | null;
  peak_at: Date | null;
  peak_price: number | null;
  time_to_peak_min: number | null;
  time_to_rug_min: number | null;
  liquidity_at_peak: number | null;
} {
  if (snapshots.length === 0) {
    return {
      peak_mc: null,
      peak_at: null,
      peak_price: null,
      time_to_peak_min: null,
      time_to_rug_min: null,
      liquidity_at_peak: null
    };
  }

  // Find peak FDV
  let peakSnapshot: TokenSnapshot | null = null;
  let maxFdv = 0;

  for (const snapshot of snapshots) {
    if (snapshot.fdv && snapshot.fdv > maxFdv) {
      maxFdv = snapshot.fdv;
      peakSnapshot = snapshot;
    }
  }

  const lastSnapshot = snapshots[snapshots.length - 1];
  const maxLiquidity = Math.max(...snapshots.map(s => s.liquidity_usd ?? 0));

  // Calculate timing
  const timeToPeakMin = peakSnapshot
    ? (new Date(peakSnapshot.snapshot_at).getTime() - new Date(detectedAt).getTime()) / (60 * 1000)
    : null;

  const timeToRugMin = lastSnapshot
    ? (new Date(lastSnapshot.snapshot_at).getTime() - new Date(detectedAt).getTime()) / (60 * 1000)
    : null;

  return {
    peak_mc: maxFdv,
    peak_at: peakSnapshot?.snapshot_at ?? null,
    peak_price: peakSnapshot?.price_usd ?? null,
    time_to_peak_min: timeToPeakMin,
    time_to_rug_min: timeToRugMin,
    liquidity_at_peak: maxLiquidity
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run backfill
backfillLifecycleData().catch(error => {
  logger.error({ error }, 'Backfill script failed');
  process.exit(1);
});
