import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { MonitoringRepo } from '../../src/repositories/MonitoringRepo.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('MonitoringRepo', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let repo: MonitoringRepo;
  let walletRepo: WalletRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    repo = new MonitoringRepo(pool);
    walletRepo = new WalletRepo(pool);
  });

  it('should enqueue token', async () => {
    await walletRepo.upsertWallet('creator1');

    const queued = await repo.enqueue('token1', 'creator1', 15); // +15 min
    expect(queued.token_address).toBe('token1');
    expect(queued.creator_wallet).toBe('creator1');
    expect(queued.status).toBe('PENDING');
    expect(queued.retry_count).toBe(0);
  });

  it('should get due tokens (tokens past check_at)', async () => {
    await walletRepo.upsertWallet('creator_due');

    await repo.enqueue('tokenA', 'creator_due', -10); // -10 min (due)
    await repo.enqueue('tokenB', 'creator_due', 5);   // +5 min (not due)
    await repo.enqueue('tokenC', 'creator_due', -5);  // -5 min (due)

    const dueTokens = await repo.getDueTokens();

    expect(dueTokens.length).toBe(2);
    expect(dueTokens.map(t => t.token_address).sort()).toEqual(['tokenA', 'tokenC']);
  });

  it('should only return PENDING tokens in getDueTokens', async () => {
    await walletRepo.upsertWallet('creator_status');

    await repo.enqueue('token_pending', 'creator_status', -10);
    await repo.enqueue('token_done', 'creator_status', -10);
    await repo.enqueue('token_processing', 'creator_status', -10);

    await repo.updateStatus('token_done', 'DONE');
    await repo.updateStatus('token_processing', 'PROCESSING');

    const dueTokens = await repo.getDueTokens();

    expect(dueTokens.length).toBe(1);
    expect(dueTokens[0].token_address).toBe('token_pending');
  });

  it('should mark token as processed', async () => {
    await walletRepo.upsertWallet('creator2');

    await repo.enqueue('token2', 'creator2', 15);
    await repo.markProcessed('token2');

    const result = await pool.query(
      'SELECT * FROM monitoring_queue WHERE token_address = $1',
      ['token2']
    );

    expect(result.rows[0].status).toBe('DONE');
    expect(result.rows[0].processed_at).not.toBeNull();
  });

  it('should re-enqueue token with retry', async () => {
    await walletRepo.upsertWallet('creator3');

    await repo.enqueue('token3', 'creator3', 15);
    await repo.reEnqueue('token3', 20);

    const result = await pool.query(
      'SELECT * FROM monitoring_queue WHERE token_address = $1',
      ['token3']
    );

    expect(result.rows[0].status).toBe('PENDING');
    expect(result.rows[0].retry_count).toBe(1);
  });

  it('should update token status', async () => {
    await walletRepo.upsertWallet('creator4');

    await repo.enqueue('token4', 'creator4', 15);
    await repo.updateStatus('token4', 'PROCESSING');

    const result = await pool.query(
      'SELECT * FROM monitoring_queue WHERE token_address = $1',
      ['token4']
    );

    expect(result.rows[0].status).toBe('PROCESSING');
  });

  it('should increment retry count on re-enqueue', async () => {
    await walletRepo.upsertWallet('creator_retry');

    await repo.enqueue('token_retry', 'creator_retry', 15);

    // Re-enqueue 3 times
    for (let i = 0; i < 3; i++) {
      await repo.reEnqueue('token_retry', 20 + i * 5);
    }

    const result = await pool.query(
      'SELECT * FROM monitoring_queue WHERE token_address = $1',
      ['token_retry']
    );

    expect(result.rows[0].retry_count).toBe(3);
  });
});
