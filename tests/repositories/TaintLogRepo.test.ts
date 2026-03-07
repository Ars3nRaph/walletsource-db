import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { TaintLogRepo } from '../../src/repositories/TaintLogRepo.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import { TokenEventRepo } from '../../src/repositories/TokenEventRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('TaintLogRepo', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let repo: TaintLogRepo;
  let walletRepo: WalletRepo;
  let tokenRepo: TokenEventRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    repo = new TaintLogRepo(pool);
    walletRepo = new WalletRepo(pool);
    tokenRepo = new TokenEventRepo(pool);
  });

  it('should log taint', async () => {
    await walletRepo.upsertWallet('wallet1');
    await walletRepo.upsertWallet('creator1');
    await tokenRepo.recordEvent('token1', 'creator1');

    const log = await repo.logTaint('wallet1', 'token1', 50, 0, 'RUG_METRICS');

    expect(log.wallet_address).toBe('wallet1');
    expect(log.source_token).toBe('token1');
    expect(log.points_applied).toBe(50);
    expect(log.propagation_depth).toBe(0);
    expect(log.reason).toBe('RUG_METRICS');
  });

  it('should get taint history', async () => {
    await walletRepo.upsertWallet('wallet2');
    await walletRepo.upsertWallet('creator2');
    await tokenRepo.recordEvent('token2', 'creator2');
    await tokenRepo.recordEvent('token3', 'creator2');

    await repo.logTaint('wallet2', 'token2', 50, 0, 'RUG_NO_PAIR');
    await repo.logTaint('wallet2', 'token3', 35, 1, 'RUG_METRICS');

    const history = await repo.getHistory('wallet2');

    expect(history.length).toBe(2);
    expect(history.map(h => h.source_token).sort()).toEqual(['token2', 'token3']);
  });

  it('should calculate total taint by wallet', async () => {
    await walletRepo.upsertWallet('wallet3');
    await walletRepo.upsertWallet('creator3');
    await tokenRepo.recordEvent('tokenA', 'creator3');
    await tokenRepo.recordEvent('tokenB', 'creator3');
    await tokenRepo.recordEvent('tokenC', 'creator3');

    // Simulate taint propagation: depth 0 = 50, depth 1 = 35, depth 2 = 24.5
    await repo.logTaint('wallet3', 'tokenA', 50, 0, 'RUG_METRICS');
    await repo.logTaint('wallet3', 'tokenB', 35, 1, 'RUG_NO_PAIR');
    await repo.logTaint('wallet3', 'tokenC', 24.5, 2, 'RUG_METRICS');

    const total = await repo.getTotalByWallet('wallet3');

    expect(total).toBe(109.5);
  });

  it('should return 0 for wallet with no taint', async () => {
    const total = await repo.getTotalByWallet('nonexistent');

    expect(total).toBe(0);
  });

  it('should log taint with different propagation depths', async () => {
    await walletRepo.upsertWallet('wallet_depth');
    await walletRepo.upsertWallet('creator_depth');
    await tokenRepo.recordEvent('token_depth', 'creator_depth');

    const depths = [0, 1, 2, 3];

    for (const depth of depths) {
      const log = await repo.logTaint('wallet_depth', 'token_depth', 50 * Math.pow(0.7, depth), depth, 'RUG_METRICS');
      expect(log.propagation_depth).toBe(depth);
    }

    const history = await repo.getHistory('wallet_depth');
    expect(history.length).toBe(4);
  });

  it('should support both RUG reasons', async () => {
    await walletRepo.upsertWallet('wallet_reasons');
    await walletRepo.upsertWallet('creator_reasons');
    await tokenRepo.recordEvent('token_no_pair', 'creator_reasons');
    await tokenRepo.recordEvent('token_metrics', 'creator_reasons');

    const log1 = await repo.logTaint('wallet_reasons', 'token_no_pair', 50, 0, 'RUG_NO_PAIR');
    const log2 = await repo.logTaint('wallet_reasons', 'token_metrics', 50, 0, 'RUG_METRICS');

    expect(log1.reason).toBe('RUG_NO_PAIR');
    expect(log2.reason).toBe('RUG_METRICS');
  });
});
