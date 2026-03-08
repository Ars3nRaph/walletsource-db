import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { SnapshotRepo } from '../../src/repositories/SnapshotRepo.js';
import { TokenEventRepo } from '../../src/repositories/TokenEventRepo.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('SnapshotRepo', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let repo: SnapshotRepo;
  let tokenRepo: TokenEventRepo;
  let walletRepo: WalletRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    repo = new SnapshotRepo(pool);
    tokenRepo = new TokenEventRepo(pool);
    walletRepo = new WalletRepo(pool);

    // Create test wallet and token
    await walletRepo.upsertWallet('creator1');
    await tokenRepo.recordEvent('token1', 'creator1');
  });

  it('should insert a snapshot', async () => {
    const snapshot = await repo.insertSnapshot({
      token_address: 'token1',
      snapshot_at: new Date('2026-03-07T10:00:00Z'),
      fdv: 50000,
      liquidity_usd: 8000,
      price_usd: 0.005,
      price_change_5m: 15.5,
      volume_5m: 3000,
      buy_count_5m: 45,
      sell_count_5m: 12
    });

    expect(snapshot.id).toBeDefined();
    expect(snapshot.token_address).toBe('token1');
    expect(snapshot.fdv).toBe(50000);
    expect(snapshot.liquidity_usd).toBe(8000);
  });

  it('should get all snapshots for a token ordered by time', async () => {
    // Insert 3 snapshots at different times
    await repo.insertSnapshot({
      token_address: 'token1',
      snapshot_at: new Date('2026-03-07T10:02:00Z'),
      fdv: 60000,
      liquidity_usd: 9000,
      price_usd: 0.006,
      price_change_5m: null,
      volume_5m: null,
      buy_count_5m: null,
      sell_count_5m: null
    });

    await repo.insertSnapshot({
      token_address: 'token1',
      snapshot_at: new Date('2026-03-07T10:00:00Z'),
      fdv: 50000,
      liquidity_usd: 8000,
      price_usd: 0.005,
      price_change_5m: null,
      volume_5m: null,
      buy_count_5m: null,
      sell_count_5m: null
    });

    await repo.insertSnapshot({
      token_address: 'token1',
      snapshot_at: new Date('2026-03-07T10:01:00Z'),
      fdv: 55000,
      liquidity_usd: 8500,
      price_usd: 0.0055,
      price_change_5m: null,
      volume_5m: null,
      buy_count_5m: null,
      sell_count_5m: null
    });

    const snapshots = await repo.getByToken('token1');

    expect(snapshots).toHaveLength(3);
    // Should be ordered by snapshot_at ASC
    expect(snapshots[0].fdv).toBe(50000); // 10:00
    expect(snapshots[1].fdv).toBe(55000); // 10:01
    expect(snapshots[2].fdv).toBe(60000); // 10:02
  });

  it('should get the latest snapshot for a token', async () => {
    await repo.insertSnapshot({
      token_address: 'token1',
      snapshot_at: new Date('2026-03-07T10:00:00Z'),
      fdv: 50000,
      liquidity_usd: 8000,
      price_usd: 0.005,
      price_change_5m: null,
      volume_5m: null,
      buy_count_5m: null,
      sell_count_5m: null
    });

    await repo.insertSnapshot({
      token_address: 'token1',
      snapshot_at: new Date('2026-03-07T10:05:00Z'),
      fdv: 70000,
      liquidity_usd: 10000,
      price_usd: 0.007,
      price_change_5m: null,
      volume_5m: null,
      buy_count_5m: null,
      sell_count_5m: null
    });

    const latest = await repo.getLatestByToken('token1');

    expect(latest).not.toBeNull();
    expect(latest!.fdv).toBe(70000); // Latest snapshot
    expect(latest!.snapshot_at).toEqual(new Date('2026-03-07T10:05:00Z'));
  });

  it('should return null if no snapshots exist for a token', async () => {
    const latest = await repo.getLatestByToken('token1');
    expect(latest).toBeNull();
  });

  it('should count snapshots for a token', async () => {
    // Insert 5 snapshots
    for (let i = 0; i < 5; i++) {
      await repo.insertSnapshot({
        token_address: 'token1',
        snapshot_at: new Date(`2026-03-07T10:${i.toString().padStart(2, '0')}:00Z`),
        fdv: 50000 + i * 1000,
        liquidity_usd: 8000,
        price_usd: 0.005,
        price_change_5m: null,
        volume_5m: null,
        buy_count_5m: null,
        sell_count_5m: null
      });
    }

    const count = await repo.countByToken('token1');
    expect(count).toBe(5);
  });

  it('should return 0 count for token with no snapshots', async () => {
    const count = await repo.countByToken('token1');
    expect(count).toBe(0);
  });

  it('should handle null values for optional fields', async () => {
    const snapshot = await repo.insertSnapshot({
      token_address: 'token1',
      snapshot_at: new Date('2026-03-07T10:00:00Z'),
      fdv: null,
      liquidity_usd: null,
      price_usd: null,
      price_change_5m: null,
      volume_5m: null,
      buy_count_5m: null,
      sell_count_5m: null
    });

    expect(snapshot.fdv).toBeNull();
    expect(snapshot.liquidity_usd).toBeNull();
    expect(snapshot.price_usd).toBeNull();
  });

  it('should isolate snapshots by token address', async () => {
    // Create another token
    await tokenRepo.recordEvent('token2', 'creator1');

    // Insert snapshots for both tokens
    await repo.insertSnapshot({
      token_address: 'token1',
      snapshot_at: new Date('2026-03-07T10:00:00Z'),
      fdv: 50000,
      liquidity_usd: null,
      price_usd: null,
      price_change_5m: null,
      volume_5m: null,
      buy_count_5m: null,
      sell_count_5m: null
    });

    await repo.insertSnapshot({
      token_address: 'token2',
      snapshot_at: new Date('2026-03-07T10:00:00Z'),
      fdv: 60000,
      liquidity_usd: null,
      price_usd: null,
      price_change_5m: null,
      volume_5m: null,
      buy_count_5m: null,
      sell_count_5m: null
    });

    const token1Snapshots = await repo.getByToken('token1');
    const token2Snapshots = await repo.getByToken('token2');

    expect(token1Snapshots).toHaveLength(1);
    expect(token2Snapshots).toHaveLength(1);
    expect(token1Snapshots[0].fdv).toBe(50000);
    expect(token2Snapshots[0].fdv).toBe(60000);
  });
});
