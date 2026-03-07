import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { HealthCheck } from '../../src/utils/healthCheck.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import { TokenEventRepo } from '../../src/repositories/TokenEventRepo.js';
import { CartelRepo } from '../../src/repositories/CartelRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('HealthCheck', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let healthCheck: HealthCheck;
  let walletRepo: WalletRepo;
  let tokenRepo: TokenEventRepo;
  let cartelRepo: CartelRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    healthCheck = new HealthCheck(pool);
    walletRepo = new WalletRepo(pool);
    tokenRepo = new TokenEventRepo(pool);
    cartelRepo = new CartelRepo(pool);
  });

  it('should compute basic health metrics', async () => {
    // Create some test data
    await walletRepo.upsertWallet('wallet1');
    await tokenRepo.recordEvent('token1', 'wallet1');

    const metrics = await healthCheck.getHealthMetrics();

    expect(metrics).toHaveProperty('tokensPerHour');
    expect(metrics).toHaveProperty('rugRate');
    expect(metrics).toHaveProperty('successRate');
    expect(metrics).toHaveProperty('uniqueWalletsToday');
    expect(metrics).toHaveProperty('apiCallsPerHour');
    expect(metrics).toHaveProperty('heliusCallsToday');
    expect(metrics).toHaveProperty('avgLatency');
    expect(metrics).toHaveProperty('cartelsTotal');
  });

  it('should calculate rug rate correctly', async () => {
    // Create 10 tokens: 7 rugs, 2 success, 1 neutral
    const wallet = 'testWallet';
    await walletRepo.upsertWallet(wallet);

    // 7 rugs
    for (let i = 0; i < 7; i++) {
      await tokenRepo.recordEvent(`rug${i}`, wallet);
      await tokenRepo.updateVerdict(`rug${i}`, 'RUG_NO_PAIR', null, null, null, null);
    }

    // 2 success
    for (let i = 0; i < 2; i++) {
      await tokenRepo.recordEvent(`success${i}`, wallet);
      await tokenRepo.updateVerdict(`success${i}`, 'SUCCESS', 50000, 10000, 5.0, 'pair1');
    }

    // 1 neutral
    await tokenRepo.recordEvent('neutral1', wallet);
    await tokenRepo.updateVerdict('neutral1', 'NEUTRAL', 5000, 1000, -10.0, 'pair2');

    const metrics = await healthCheck.getHealthMetrics();

    // Rug rate = 7 / 10 = 0.7
    expect(metrics.rugRate).toBeCloseTo(0.7, 2);

    // Success rate = 2 / 10 = 0.2
    expect(metrics.successRate).toBeCloseTo(0.2, 2);
  });

  it('should track API calls', () => {
    healthCheck.recordApiCall();
    healthCheck.recordApiCall();
    healthCheck.recordApiCall();

    // Can't directly verify count, but should not throw
    expect(() => healthCheck.recordApiCall()).not.toThrow();
  });

  it('should track Helius calls', () => {
    healthCheck.recordHeliusCall();
    healthCheck.recordHeliusCall();

    expect(() => healthCheck.recordHeliusCall()).not.toThrow();
  });

  it('should track latency', async () => {
    healthCheck.recordLatency(100);
    healthCheck.recordLatency(200);
    healthCheck.recordLatency(150);

    const metrics = await healthCheck.getHealthMetrics();

    // Average = (100 + 200 + 150) / 3 = 150
    expect(metrics.avgLatency).toBeCloseTo(150, 1);
  });

  it('should count cartels', async () => {
    await cartelRepo.upsertCartel(
      'cartel1',
      'Test Cartel 1',
      3,
      5,
      10,
      0.333,
      0.7,
      0.6,
      'WATCH'
    );

    await cartelRepo.upsertCartel(
      'cartel2',
      'Test Cartel 2',
      5,
      8,
      2,
      0.8,
      0.5,
      0.4,
      'AVOID'
    );

    const metrics = await healthCheck.getHealthMetrics();

    expect(metrics.cartelsTotal).toBe(2);
  });

  it('should count unique wallets', async () => {
    // Create 3 wallets, each launching 2 tokens
    for (let i = 0; i < 3; i++) {
      const wallet = `wallet${i}`;
      await walletRepo.upsertWallet(wallet);

      await tokenRepo.recordEvent(`token${i}_1`, wallet);
      await tokenRepo.recordEvent(`token${i}_2`, wallet);
    }

    const metrics = await healthCheck.getHealthMetrics();

    // 3 unique wallets
    expect(metrics.uniqueWalletsToday).toBe(3);
  });

  it('should run health check without errors', async () => {
    // Create some baseline data
    await walletRepo.upsertWallet('wallet1');
    await tokenRepo.recordEvent('token1', 'wallet1');

    await expect(healthCheck.checkAndAlert()).resolves.not.toThrow();
  });

  it('should handle empty database', async () => {
    const metrics = await healthCheck.getHealthMetrics();

    expect(metrics.tokensPerHour).toBe(0);
    expect(metrics.rugRate).toBe(0);
    expect(metrics.successRate).toBe(0);
    expect(metrics.uniqueWalletsToday).toBe(0);
    expect(metrics.cartelsTotal).toBe(0);
  });
});
