import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { TokenTracker } from '../../src/workers/TokenTracker.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import { TokenEventRepo } from '../../src/repositories/TokenEventRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

// Mock DexScreenerClient
vi.mock('../../src/api/DexScreenerClient.js', () => {
  return {
    DexScreenerClient: vi.fn().mockImplementation(() => ({
      getToken: vi.fn(),
      getRemainingQuota: vi.fn().mockReturnValue(250)
    }))
  };
});

describe('TokenTracker', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let tracker: TokenTracker;
  let walletRepo: WalletRepo;
  let tokenRepo: TokenEventRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    tracker = new TokenTracker(pool);
    walletRepo = new WalletRepo(pool);
    tokenRepo = new TokenEventRepo(pool);

    // Create test wallet
    await walletRepo.upsertWallet('rugger1');
  });

  afterEach(async () => {
    await tracker.stop();
  });

  describe('analyzeTokenLifecycle', () => {
    it('should detect RUG_NO_PAIR for dead token (no market)', async () => {
      await tokenRepo.recordEvent('deadToken', 'rugger1');

      // Create snapshots with no market activity
      const detectedAt = new Date('2026-03-07T10:00:00Z');

      const snapshots = [
        {
          id: 1,
          token_address: 'deadToken',
          snapshot_at: new Date('2026-03-07T10:00:30Z'),
          fdv: null,
          liquidity_usd: null,
          price_usd: null,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        },
        {
          id: 2,
          token_address: 'deadToken',
          snapshot_at: new Date('2026-03-07T10:01:00Z'),
          fdv: 1000, // Below threshold
          liquidity_usd: 500, // Below threshold
          price_usd: 0.001,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        }
      ];

      // Access private method via any for testing
      const analysis = (tracker as any).analyzeTokenLifecycle(snapshots, detectedAt);

      expect(analysis.verdict).toBe('RUG_NO_PAIR');
      expect(analysis.peak_mc).toBeLessThan(5000);
    });

    it('should detect RUG_METRICS for pump and dump', async () => {
      await tokenRepo.recordEvent('pumpDump', 'rugger1');

      const detectedAt = new Date('2026-03-07T10:00:00Z');

      // Simulate pump then dump
      const snapshots = [
        {
          id: 1,
          token_address: 'pumpDump',
          snapshot_at: new Date('2026-03-07T10:00:30Z'),
          fdv: 10000,
          liquidity_usd: 3000,
          price_usd: 0.01,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        },
        {
          id: 2,
          token_address: 'pumpDump',
          snapshot_at: new Date('2026-03-07T10:02:00Z'),
          fdv: 25000,
          liquidity_usd: 6000,
          price_usd: 0.025,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        },
        {
          id: 3,
          token_address: 'pumpDump',
          snapshot_at: new Date('2026-03-07T10:05:00Z'),
          fdv: 45000, // Peak
          liquidity_usd: 9000,
          price_usd: 0.045,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        },
        {
          id: 4,
          token_address: 'pumpDump',
          snapshot_at: new Date('2026-03-07T10:08:00Z'),
          fdv: 20000, // Dump: 55% drop from peak
          liquidity_usd: 4000,
          price_usd: 0.02,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        }
      ];

      const analysis = (tracker as any).analyzeTokenLifecycle(snapshots, detectedAt);

      expect(analysis.verdict).toBe('RUG_METRICS');
      expect(analysis.peak_mc).toBe(45000);
      expect(analysis.time_to_peak_min).toBeCloseTo(5, 1); // 5 minutes to peak
      expect(analysis.time_to_rug_min).toBeCloseTo(8, 1); // 8 minutes to dump
      expect(analysis.dump_speed_pct_per_min).toBeDefined();
      expect(analysis.liquidity_at_peak).toBe(9000);
    });

    it('should detect SUCCESS for sustained high FDV', async () => {
      await tokenRepo.recordEvent('successToken', 'rugger1');

      const detectedAt = new Date('2026-03-07T10:00:00Z');

      // Token pumps and stays stable above thresholds
      const snapshots = [
        {
          id: 1,
          token_address: 'successToken',
          snapshot_at: new Date('2026-03-07T10:00:30Z'),
          fdv: 15000,
          liquidity_usd: 4000,
          price_usd: 0.015,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        },
        {
          id: 2,
          token_address: 'successToken',
          snapshot_at: new Date('2026-03-07T10:05:00Z'),
          fdv: 50000, // Above SUCCESS threshold
          liquidity_usd: 8000, // Above SUCCESS threshold
          price_usd: 0.05,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        },
        {
          id: 3,
          token_address: 'successToken',
          snapshot_at: new Date('2026-03-07T10:15:00Z'),
          fdv: 55000, // Still high, no dump
          liquidity_usd: 9000,
          price_usd: 0.055,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        }
      ];

      const analysis = (tracker as any).analyzeTokenLifecycle(snapshots, detectedAt);

      expect(analysis.verdict).toBe('SUCCESS');
      expect(analysis.peak_mc).toBeGreaterThan(30000);
      expect(analysis.time_to_rug_min).toBeNull(); // No dump detected
    });

    it('should detect NEUTRAL for moderate performance', async () => {
      await tokenRepo.recordEvent('neutralToken', 'rugger1');

      const detectedAt = new Date('2026-03-07T10:00:00Z');

      const snapshots = [
        {
          id: 1,
          token_address: 'neutralToken',
          snapshot_at: new Date('2026-03-07T10:00:30Z'),
          fdv: 15000, // Below SUCCESS threshold
          liquidity_usd: 3500, // Below SUCCESS threshold
          price_usd: 0.015,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        },
        {
          id: 2,
          token_address: 'neutralToken',
          snapshot_at: new Date('2026-03-07T10:10:00Z'),
          fdv: 20000,
          liquidity_usd: 4000,
          price_usd: 0.02,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        }
      ];

      const analysis = (tracker as any).analyzeTokenLifecycle(snapshots, detectedAt);

      expect(analysis.verdict).toBe('NEUTRAL');
      expect(analysis.peak_mc).toBeGreaterThan(0);
      expect(analysis.peak_mc).toBeLessThan(30000);
    });

    it('should calculate timing metrics correctly', async () => {
      await tokenRepo.recordEvent('timingToken', 'rugger1');

      const detectedAt = new Date('2026-03-07T10:00:00Z');

      const snapshots = [
        {
          id: 1,
          token_address: 'timingToken',
          snapshot_at: new Date('2026-03-07T10:00:30Z'),
          fdv: 10000,
          liquidity_usd: 3000,
          price_usd: 0.01,
          price_change_5m: null,
          volume_5m: 1000,
          buy_count_5m: null,
          sell_count_5m: null
        },
        {
          id: 2,
          token_address: 'timingToken',
          snapshot_at: new Date('2026-03-07T10:08:00Z'), // Peak at 8 min
          fdv: 42000,
          liquidity_usd: 8500,
          price_usd: 0.042,
          price_change_5m: null,
          volume_5m: 2000,
          buy_count_5m: null,
          sell_count_5m: null
        },
        {
          id: 3,
          token_address: 'timingToken',
          snapshot_at: new Date('2026-03-07T10:12:00Z'), // Dump at 12 min
          fdv: 18000, // 57% drop
          liquidity_usd: 3000,
          price_usd: 0.018,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        }
      ];

      const analysis = (tracker as any).analyzeTokenLifecycle(snapshots, detectedAt);

      expect(analysis.verdict).toBe('RUG_METRICS');
      expect(analysis.time_to_peak_min).toBeCloseTo(8, 1); // 8 minutes
      expect(analysis.time_to_rug_min).toBeCloseTo(12, 1); // 12 minutes
      expect(analysis.peak_mc).toBe(42000);
      expect(analysis.peak_price).toBe(0.042);
      expect(analysis.rug_price).toBe(0.018);
      expect(analysis.buy_volume_before_dump).toBe(3000); // 1000 + 2000
    });

    it('should handle empty snapshots array', async () => {
      await tokenRepo.recordEvent('emptyToken', 'rugger1');

      const detectedAt = new Date('2026-03-07T10:00:00Z');
      const snapshots: any[] = [];

      const analysis = (tracker as any).analyzeTokenLifecycle(snapshots, detectedAt);

      expect(analysis.verdict).toBe('RUG_NO_PAIR');
      expect(analysis.peak_mc).toBeNull();
      expect(analysis.time_to_peak_min).toBeNull();
    });

    it('should detect liquidity removal as dump trigger', async () => {
      await tokenRepo.recordEvent('liqRemovalToken', 'rugger1');

      const detectedAt = new Date('2026-03-07T10:00:00Z');

      const snapshots = [
        {
          id: 1,
          token_address: 'liqRemovalToken',
          snapshot_at: new Date('2026-03-07T10:05:00Z'),
          fdv: 40000,
          liquidity_usd: 10000, // Peak liquidity
          price_usd: 0.04,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        },
        {
          id: 2,
          token_address: 'liqRemovalToken',
          snapshot_at: new Date('2026-03-07T10:08:00Z'),
          fdv: 38000, // FDV only slightly down
          liquidity_usd: 3000, // Liquidity removed 70%
          price_usd: 0.038,
          price_change_5m: null,
          volume_5m: null,
          buy_count_5m: null,
          sell_count_5m: null
        }
      ];

      const analysis = (tracker as any).analyzeTokenLifecycle(snapshots, detectedAt);

      expect(analysis.verdict).toBe('RUG_METRICS');
      expect(analysis.liquidity_removed).toBe(7000); // 10000 - 3000
    });
  });

  describe('updateWalletCounters', () => {
    it('should increment rug_count for RUG_METRICS verdict', async () => {
      await (tracker as any).updateWalletCounters('rugger1', 'RUG_METRICS');

      const wallet = await walletRepo.getByAddress('rugger1');
      expect(wallet?.rug_count).toBe(1);
      expect(wallet?.survival_count).toBe(0);
    });

    it('should increment survival_count for SUCCESS verdict', async () => {
      await (tracker as any).updateWalletCounters('rugger1', 'SUCCESS');

      const wallet = await walletRepo.getByAddress('rugger1');
      expect(wallet?.rug_count).toBe(0);
      expect(wallet?.survival_count).toBe(1);
    });

    it('should increment neutral_count for NEUTRAL verdict', async () => {
      await (tracker as any).updateWalletCounters('rugger1', 'NEUTRAL');

      const wallet = await walletRepo.getByAddress('rugger1');
      expect(wallet?.neutral_count).toBe(1);
    });
  });
});
