import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { TokenEventRepo } from '../../src/repositories/TokenEventRepo.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('TokenEventRepo', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let repo: TokenEventRepo;
  let walletRepo: WalletRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    repo = new TokenEventRepo(pool);
    walletRepo = new WalletRepo(pool);
  });

  it('should record token event', async () => {
    await walletRepo.upsertWallet('creator1');

    const event = await repo.recordEvent('token123', 'creator1');

    expect(event.token_address).toBe('token123');
    expect(event.creator_wallet).toBe('creator1');
    expect(event.verdict).toBeNull();
  });

  it('should update verdict', async () => {
    await walletRepo.upsertWallet('creator1');
    await repo.recordEvent('token456', 'creator1');

    await repo.updateVerdict('token456', 'SUCCESS', 50000, 3000, -10, 'pair123');

    const event = await repo.getByAddress('token456');

    expect(event?.verdict).toBe('SUCCESS');
    expect(event?.fdv_at_check).toBe(50000);
    expect(event?.liquidity_at_check).toBe(3000);
    expect(event?.price_change_5m).toBe(-10);
    expect(event?.dexscreener_pair).toBe('pair123');
  });

  it('should get tokens by creator', async () => {
    await walletRepo.upsertWallet('creator2');

    await repo.recordEvent('token1', 'creator2');
    await repo.recordEvent('token2', 'creator2');
    await repo.recordEvent('token3', 'creator2');

    const events = await repo.getByCreator('creator2');

    expect(events.length).toBe(3);
    expect(events.map(e => e.token_address).sort()).toEqual(['token1', 'token2', 'token3']);
  });

  it('should calculate median FDV correctly', async () => {
    await walletRepo.upsertWallet('creator_median');

    // Create 5 tokens: 3 SUCCESS, 2 RUG
    await repo.recordEvent('token_s1', 'creator_median');
    await repo.recordEvent('token_s2', 'creator_median');
    await repo.recordEvent('token_s3', 'creator_median');
    await repo.recordEvent('token_r1', 'creator_median');
    await repo.recordEvent('token_r2', 'creator_median');

    // Update verdicts with FDV values
    // SUCCESS: 50000, 70000, 90000 (median should be 70000)
    await repo.updateVerdict('token_s1', 'SUCCESS', 50000, 5000, 0, null);
    await repo.updateVerdict('token_s2', 'SUCCESS', 70000, 5000, 0, null);
    await repo.updateVerdict('token_s3', 'SUCCESS', 90000, 5000, 0, null);

    // RUG: 5000, 8000 (should not affect SUCCESS median)
    await repo.updateVerdict('token_r1', 'RUG_METRICS', 5000, 1000, -80, null);
    await repo.updateVerdict('token_r2', 'RUG_NO_PAIR', 8000, 500, -90, null);

    const median = await repo.getMedianFDV('creator_median', 'SUCCESS');

    // Median of [50000, 70000, 90000] = 70000
    expect(median).toBe(70000);
  });

  it('should return null for median FDV when no tokens match', async () => {
    await walletRepo.upsertWallet('creator_empty');

    const median = await repo.getMedianFDV('creator_empty', 'SUCCESS');

    expect(median).toBeNull();
  });

  it('should calculate median FDV with single token', async () => {
    await walletRepo.upsertWallet('creator_single');

    await repo.recordEvent('token_single', 'creator_single');
    await repo.updateVerdict('token_single', 'SUCCESS', 100000, 5000, 0, null);

    const median = await repo.getMedianFDV('creator_single', 'SUCCESS');

    expect(median).toBe(100000);
  });

  it('should ignore tokens with null FDV in median calculation', async () => {
    await walletRepo.upsertWallet('creator_null');

    await repo.recordEvent('token_null1', 'creator_null');
    await repo.recordEvent('token_null2', 'creator_null');
    await repo.recordEvent('token_valid', 'creator_null');

    await repo.updateVerdict('token_null1', 'SUCCESS', null, 5000, 0, null);
    await repo.updateVerdict('token_null2', 'SUCCESS', null, 5000, 0, null);
    await repo.updateVerdict('token_valid', 'SUCCESS', 80000, 5000, 0, null);

    const median = await repo.getMedianFDV('creator_null', 'SUCCESS');

    expect(median).toBe(80000);
  });
});
