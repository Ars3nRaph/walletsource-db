import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import { TokenEventRepo } from '../../src/repositories/TokenEventRepo.js';
import { MonitoringRepo } from '../../src/repositories/MonitoringRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('RugScannerWorker - Repository Integration', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let walletRepo: WalletRepo;
  let tokenRepo: TokenEventRepo;
  let monitoringRepo: MonitoringRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    walletRepo = new WalletRepo(pool);
    tokenRepo = new TokenEventRepo(pool);
    monitoringRepo = new MonitoringRepo(pool);
  });

  it('should update wallet rug count', async () => {
    const wallet = 'creator1';
    await walletRepo.upsertWallet(wallet);
    
    await walletRepo.incrementRug(wallet);
    
    const updated = await walletRepo.getByAddress(wallet);
    expect(updated?.rug_count).toBe(1);
  });

  it('should update wallet survival count', async () => {
    const wallet = 'creator2';
    await walletRepo.upsertWallet(wallet);
    
    await walletRepo.incrementSurvival(wallet);
    
    const updated = await walletRepo.getByAddress(wallet);
    expect(updated?.survival_count).toBe(1);
  });

  it('should enqueue tokens for monitoring', async () => {
    const wallet = 'creator3';
    const token = 'token123';
    
    await walletRepo.upsertWallet(wallet);
    await tokenRepo.recordEvent(token, wallet);

    await monitoringRepo.enqueue(token, wallet, 15);

    // Verify enqueued
    const result = await pool.query(
      'SELECT * FROM monitoring_queue WHERE token_address = $1',
      [token]
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].status).toBe('PENDING');
  });

  it('should mark token as processed', async () => {
    const wallet = 'creator4';
    const token = 'token456';

    await walletRepo.upsertWallet(wallet);
    await tokenRepo.recordEvent(token, wallet);
    await monitoringRepo.enqueue(token, wallet, -1); // 1 min ago

    await monitoringRepo.markProcessed(token);

    const result = await pool.query(
      'SELECT * FROM monitoring_queue WHERE token_address = $1',
      [token]
    );
    expect(result.rows[0].status).toBe('DONE');
  });

  it('should re-enqueue token with retry', async () => {
    const wallet = 'creator5';
    const token = 'token789';

    await walletRepo.upsertWallet(wallet);
    await tokenRepo.recordEvent(token, wallet);
    await monitoringRepo.enqueue(token, wallet, -1);

    await monitoringRepo.reEnqueue(token, 5);

    const result = await pool.query(
      'SELECT * FROM monitoring_queue WHERE token_address = $1',
      [token]
    );
    expect(result.rows[0].status).toBe('PENDING');
    expect(result.rows[0].retry_count).toBe(1);
  });
});
