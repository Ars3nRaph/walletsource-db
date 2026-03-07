import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('WalletRepo', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let repo: WalletRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    repo = new WalletRepo(pool);
  });

  it('should insert a new wallet', async () => {
    const wallet = await repo.upsertWallet('wallet123');

    expect(wallet.wallet_address).toBe('wallet123');
    expect(wallet.rug_count).toBe(0);
    expect(wallet.survival_count).toBe(0);
    expect(wallet.neutral_count).toBe(0);
    expect(wallet.strategy).toBe('WATCH');
  });

  it('should update existing wallet on conflict', async () => {
    const wallet1 = await repo.upsertWallet('wallet123');
    const wallet2 = await repo.upsertWallet('wallet123');

    expect(wallet1.wallet_address).toBe(wallet2.wallet_address);
    expect(wallet2.last_seen_at.getTime()).toBeGreaterThanOrEqual(wallet1.last_seen_at.getTime());
  });

  it('should get wallet by address', async () => {
    await repo.upsertWallet('wallet456');

    const wallet = await repo.getByAddress('wallet456');

    expect(wallet).not.toBeNull();
    expect(wallet?.wallet_address).toBe('wallet456');
  });

  it('should return null for non-existent wallet', async () => {
    const wallet = await repo.getByAddress('nonexistent');

    expect(wallet).toBeNull();
  });

  it('should update strategy', async () => {
    await repo.upsertWallet('wallet789');
    await repo.updateStrategy('wallet789', 'AVOID');

    const wallet = await repo.getByAddress('wallet789');

    expect(wallet?.strategy).toBe('AVOID');
  });

  it('should increment rug count', async () => {
    await repo.upsertWallet('wallet_rug');
    await repo.incrementRug('wallet_rug');
    await repo.incrementRug('wallet_rug');

    const wallet = await repo.getByAddress('wallet_rug');

    expect(wallet?.rug_count).toBe(2);
  });

  it('should increment survival count', async () => {
    await repo.upsertWallet('wallet_survival');
    await repo.incrementSurvival('wallet_survival');

    const wallet = await repo.getByAddress('wallet_survival');

    expect(wallet?.survival_count).toBe(1);
  });

  it('should increment neutral count', async () => {
    await repo.upsertWallet('wallet_neutral');
    await repo.incrementNeutral('wallet_neutral');

    const wallet = await repo.getByAddress('wallet_neutral');

    expect(wallet?.neutral_count).toBe(1);
  });

  it('should update scores', async () => {
    await repo.upsertWallet('wallet_scores');
    await repo.updateScores('wallet_scores', 100, 0.75, 0.85);

    const wallet = await repo.getByAddress('wallet_scores');

    expect(wallet?.taint_score).toBe(100);
    expect(wallet?.toxicity_score).toBe(0.75);
    expect(wallet?.risk_score).toBe(0.85);
  });

  it('should calculate rug_rate automatically', async () => {
    await repo.upsertWallet('wallet_rate');
    await repo.incrementRug('wallet_rate');
    await repo.incrementRug('wallet_rate');
    await repo.incrementSurvival('wallet_rate');
    await repo.incrementNeutral('wallet_rate');

    const wallet = await repo.getByAddress('wallet_rate');

    // 2 rugs out of 4 total = 0.5
    expect(wallet?.rug_rate).toBe(0.5);
  });

  it('should get wallets by cartel', async () => {
    const cartelId = 'cartel_test';

    // First create a cartel
    await pool.query(
      `INSERT INTO cartel_groups (cartel_id, name) VALUES ($1, $2)`,
      [cartelId, 'Test Cartel']
    );

    await repo.upsertWallet('wallet1');
    await repo.upsertWallet('wallet2');
    await repo.upsertWallet('wallet3');

    await repo.updateCartel('wallet1', cartelId);
    await repo.updateCartel('wallet2', cartelId);

    const wallets = await repo.getByCartel(cartelId);

    expect(wallets.length).toBe(2);
    expect(wallets.map(w => w.wallet_address).sort()).toEqual(['wallet1', 'wallet2']);
  });
});
