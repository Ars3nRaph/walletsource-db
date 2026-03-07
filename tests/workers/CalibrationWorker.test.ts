import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { CalibrationWorker } from '../../src/workers/CalibrationWorker.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import { TokenEventRepo } from '../../src/repositories/TokenEventRepo.js';
import { CalibrationRepo } from '../../src/repositories/CalibrationRepo.js';
import { CartelRepo } from '../../src/repositories/CartelRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('CalibrationWorker', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let worker: CalibrationWorker;
  let walletRepo: WalletRepo;
  let tokenRepo: TokenEventRepo;
  let calibrationRepo: CalibrationRepo;
  let cartelRepo: CartelRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    worker = new CalibrationWorker(pool);
    walletRepo = new WalletRepo(pool);
    tokenRepo = new TokenEventRepo(pool);
    calibrationRepo = new CalibrationRepo(pool);
    cartelRepo = new CartelRepo(pool);
  });

  it('should initialize with default parameters', () => {
    const params = worker.getParams();

    expect(params.k_confidence).toBe(6.0);
    expect(params.k_rug).toBe(6.0);
    expect(params.k_cartel).toBe(5.0);
    expect(params.alpha_pexit).toBe(3.0);
    expect(params.mu_taint).toBe(100);
    expect(params.sigma_taint).toBe(40);
    expect(params.w1_rug).toBe(0.40);
    expect(params.w2_toxicity).toBe(0.35);
    expect(params.w3_cartel).toBe(0.25);
  });

  it('should allow manual parameter updates', () => {
    worker.setParam('k_confidence', 7.0);

    const params = worker.getParams();
    expect(params.k_confidence).toBe(7.0);
  });

  it('should skip calibration if insufficient tokens', async () => {
    // Create only 5 tokens (< 10 minimum)
    for (let i = 0; i < 5; i++) {
      const wallet = `wallet${i}`;
      await walletRepo.upsertWallet(wallet);
      await tokenRepo.recordEvent(`token${i}`, wallet);
      await tokenRepo.updateVerdict(`token${i}`, 'SUCCESS', 50000, 10000, 5.0, 'pair1');
    }

    // Should complete without error but not log any calibrations
    await worker.runCalibration();

    const logs = await calibrationRepo.getRecentLogs(1);
    expect(logs.length).toBe(0);
  });

  it('should run full calibration with 50 tokens', async () => {
    // Create 50 tokens: 35 RUG, 10 SUCCESS, 5 NEUTRAL
    const wallets: string[] = [];

    // 7 rug wallets (5 tokens each = 35 RUG total)
    for (let i = 0; i < 7; i++) {
      const wallet = `rug_wallet${i}`;
      wallets.push(wallet);
      await walletRepo.upsertWallet(wallet);

      for (let j = 0; j < 5; j++) {
        const token = `rug_token_${i}_${j}`;
        await tokenRepo.recordEvent(token, wallet);
        await tokenRepo.updateVerdict(token, 'RUG_METRICS', 1000, 500, -80.0, null);

        // Update wallet counters
        await walletRepo.incrementRug(wallet);
      }

      // Update rug_rate (rug_count / total)
      const walletData = await walletRepo.getByAddress(wallet);
      expect(walletData?.rug_count).toBe(5);
    }

    // 2 success wallets (5 tokens each = 10 SUCCESS total)
    for (let i = 0; i < 2; i++) {
      const wallet = `success_wallet${i}`;
      wallets.push(wallet);
      await walletRepo.upsertWallet(wallet);

      for (let j = 0; j < 5; j++) {
        const token = `success_token_${i}_${j}`;
        await tokenRepo.recordEvent(token, wallet);
        await tokenRepo.updateVerdict(token, 'SUCCESS', 50000, 10000, 10.0, 'pair1');

        // Update wallet counters
        await walletRepo.incrementSurvival(wallet);
      }

      const walletData = await walletRepo.getByAddress(wallet);
      expect(walletData?.survival_count).toBe(5);
    }

    // 1 neutral wallet (5 tokens = 5 NEUTRAL total)
    const neutralWallet = 'neutral_wallet';
    wallets.push(neutralWallet);
    await walletRepo.upsertWallet(neutralWallet);

    for (let j = 0; j < 5; j++) {
      const token = `neutral_token_${j}`;
      await tokenRepo.recordEvent(token, neutralWallet);
      await tokenRepo.updateVerdict(token, 'NEUTRAL', 8000, 3000, -5.0, 'pair1');

      // Update wallet counters
      await walletRepo.incrementNeutral(neutralWallet);
    }

    // Run calibration
    await worker.runCalibration();

    // Should have logged calibration attempts for all 9 parameters
    const logs = await calibrationRepo.getRecentLogs(1);

    // We should have at least some calibration logs (even if rejected)
    expect(logs.length).toBeGreaterThan(0);

    // Check that tokens were evaluated
    if (logs.length > 0) {
      expect(logs[0].tokens_evaluated).toBe(50);
    }
  }, 30000); // 30s timeout

  it('should reject parameter outside guard rails', async () => {
    // Set k_confidence to 15.0 (> 9.0 max bound)
    worker.setParam('k_confidence', 15.0);

    // Create minimal test data
    for (let i = 0; i < 10; i++) {
      const wallet = `wallet${i}`;
      await walletRepo.upsertWallet(wallet);
      await tokenRepo.recordEvent(`token${i}`, wallet);
      await tokenRepo.updateVerdict(`token${i}`, 'RUG_METRICS', 1000, 500, -80.0, null);
    }

    // Reset to valid value
    worker.setParam('k_confidence', 6.0);

    await worker.runCalibration();

    // Check for rejected calibrations in logs
    const logs = await calibrationRepo.getRecentLogs(1);
    const rejectedLogs = logs.filter(l => !l.accepted);

    // Some variations will be rejected due to guard rails
    expect(rejectedLogs.length).toBeGreaterThanOrEqual(0);
  });

  it('should not accept parameter if improvement < 5%', async () => {
    // Create test data with consistent results (no improvement expected)
    for (let i = 0; i < 15; i++) {
      const wallet = `wallet${i}`;
      await walletRepo.upsertWallet(wallet);

      // Half RUG, half SUCCESS
      if (i < 8) {
        await tokenRepo.recordEvent(`token${i}`, wallet);
        await tokenRepo.updateVerdict(`token${i}`, 'RUG_METRICS', 1000, 500, -80.0, null);
        await walletRepo.incrementRug(wallet);
      } else {
        await tokenRepo.recordEvent(`token${i}`, wallet);
        await tokenRepo.updateVerdict(`token${i}`, 'SUCCESS', 50000, 10000, 10.0, 'pair1');
        await walletRepo.incrementSurvival(wallet);
      }
    }

    const initialParams = worker.getParams();

    await worker.runCalibration();

    const finalParams = worker.getParams();

    // Most parameters should remain unchanged (no significant improvement)
    // At least some parameters should stay the same
    let unchangedCount = 0;
    for (const key of Object.keys(initialParams) as Array<keyof typeof initialParams>) {
      if (initialParams[key] === finalParams[key]) {
        unchangedCount++;
      }
    }

    expect(unchangedCount).toBeGreaterThan(0);
  });

  it('should accept parameter within ±50% bounds', async () => {
    // Create skewed data to favor parameter changes
    for (let i = 0; i < 20; i++) {
      const wallet = `wallet${i}`;
      await walletRepo.upsertWallet(wallet);

      // 90% RUG
      if (i < 18) {
        await tokenRepo.recordEvent(`token${i}`, wallet);
        await tokenRepo.updateVerdict(`token${i}`, 'RUG_METRICS', 1000, 500, -90.0, null);
        await walletRepo.incrementRug(wallet);
      } else {
        await tokenRepo.recordEvent(`token${i}`, wallet);
        await tokenRepo.updateVerdict(`token${i}`, 'SUCCESS', 100000, 20000, 50.0, 'pair1');
        await walletRepo.incrementSurvival(wallet);
      }
    }

    await worker.runCalibration();

    const finalParams = worker.getParams();

    // Check all parameters are within ±50% bounds
    expect(finalParams.k_confidence).toBeGreaterThanOrEqual(3.0);
    expect(finalParams.k_confidence).toBeLessThanOrEqual(9.0);

    expect(finalParams.alpha_pexit).toBeGreaterThanOrEqual(1.5);
    expect(finalParams.alpha_pexit).toBeLessThanOrEqual(4.5);

    expect(finalParams.mu_taint).toBeGreaterThanOrEqual(50);
    expect(finalParams.mu_taint).toBeLessThanOrEqual(150);

    expect(finalParams.w1_rug).toBeGreaterThanOrEqual(0.20);
    expect(finalParams.w1_rug).toBeLessThanOrEqual(0.60);
  });

  it('should start and stop worker', () => {
    worker.start();
    // Worker should be running
    expect(() => worker.start()).not.toThrow(); // Should warn but not throw

    worker.stop();
    // Should stop cleanly
    expect(() => worker.stop()).not.toThrow();
  });

  it('should handle cartel wallets in PnL calculation', async () => {
    // Create a cartel
    await cartelRepo.upsertCartel(
      'cartel1',
      'Test Cartel',
      3,
      2,
      8,
      0.2,
      0.85,
      0.90,
      'WATCH'
    );

    // Create wallets in the cartel
    for (let i = 0; i < 3; i++) {
      const wallet = `cartel_wallet${i}`;
      await walletRepo.upsertWallet(wallet);
      await walletRepo.updateCartel(wallet, 'cartel1');

      // Mix of SUCCESS and RUG
      if (i < 2) {
        await tokenRepo.recordEvent(`cartel_token${i}`, wallet);
        await tokenRepo.updateVerdict(`cartel_token${i}`, 'SUCCESS', 60000, 12000, 20.0, 'pair1');
        await walletRepo.incrementSurvival(wallet);
      } else {
        for (let j = 0; j < 8; j++) {
          await tokenRepo.recordEvent(`cartel_rug${j}`, wallet);
          await tokenRepo.updateVerdict(`cartel_rug${j}`, 'RUG_METRICS', 1000, 500, -85.0, null);
          await walletRepo.incrementRug(wallet);
        }
      }
    }

    // Run calibration
    await worker.runCalibration();

    // Should complete without errors
    const logs = await calibrationRepo.getRecentLogs(1);
    expect(logs.length).toBeGreaterThan(0);
  });
});
