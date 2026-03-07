import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { CartelRepo } from '../../src/repositories/CartelRepo.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('CartelRepo', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let repo: CartelRepo;
  let walletRepo: WalletRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    repo = new CartelRepo(pool);
    walletRepo = new WalletRepo(pool);
  });

  it('should upsert cartel', async () => {
    const cartel = await repo.upsertCartel(
      'cartel1',
      'Test Cartel',
      5,
      10,
      15,
      0.4,
      0.75,
      0.8,
      'WATCH'
    );

    expect(cartel.cartel_id).toBe('cartel1');
    expect(cartel.name).toBe('Test Cartel');
    expect(cartel.wallet_count).toBe(5);
    expect(cartel.total_rug_count).toBe(10);
    expect(cartel.total_survival_count).toBe(15);
    expect(cartel.avg_rug_rate).toBe(0.4);
    expect(cartel.confidence_score).toBe(0.75);
    expect(cartel.confidence_score_v2).toBe(0.8);
    expect(cartel.auto_strategy).toBe('WATCH');
  });

  it('should update existing cartel on conflict', async () => {
    await repo.upsertCartel('cartel2', 'Cartel V1', 3, 5, 10, 0.3, 0.6, 0.65, 'WATCH');
    await repo.upsertCartel('cartel2', 'Cartel V2', 5, 8, 12, 0.4, 0.7, 0.75, 'SHORT');

    const cartel = await repo.getById('cartel2');

    expect(cartel?.name).toBe('Cartel V2');
    expect(cartel?.wallet_count).toBe(5);
    expect(cartel?.auto_strategy).toBe('SHORT');
  });

  it('should get cartel by id', async () => {
    await repo.upsertCartel('cartel3', 'My Cartel', 2, 1, 5, 0.167, 0.8, 0.85, 'LONG');

    const cartel = await repo.getById('cartel3');

    expect(cartel).not.toBeNull();
    expect(cartel?.cartel_id).toBe('cartel3');
    expect(cartel?.name).toBe('My Cartel');
  });

  it('should return null for non-existent cartel', async () => {
    const cartel = await repo.getById('nonexistent');

    expect(cartel).toBeNull();
  });

  it('should get cartel members', async () => {
    await repo.upsertCartel('cartel4', 'Test Members', 3, 0, 0, 0, 0.5, 0.5, 'WATCH');

    await walletRepo.upsertWallet('member1');
    await walletRepo.upsertWallet('member2');
    await walletRepo.upsertWallet('member3');
    await walletRepo.upsertWallet('outsider');

    await walletRepo.updateCartel('member1', 'cartel4');
    await walletRepo.updateCartel('member2', 'cartel4');
    await walletRepo.updateCartel('member3', 'cartel4');

    const members = await repo.getMembers('cartel4');

    expect(members.length).toBe(3);
    expect(members.map(m => m.wallet_address).sort()).toEqual(['member1', 'member2', 'member3']);
  });

  it('should update cartel scores', async () => {
    await repo.upsertCartel('cartel5', 'Score Test', 1, 0, 0, 0, 0.5, 0.5, 'WATCH');
    await repo.updateCartelScores('cartel5', 0.9, 0.95);

    const cartel = await repo.getById('cartel5');

    expect(cartel?.confidence_score).toBe(0.9);
    expect(cartel?.confidence_score_v2).toBe(0.95);
  });

  it('should respect confidence score constraints (0-1)', async () => {
    await expect(
      repo.upsertCartel('cartel_valid', 'Valid', 1, 0, 0, 0, 0.0, 0.0, 'WATCH')
    ).resolves.toBeDefined();

    await expect(
      repo.upsertCartel('cartel_valid2', 'Valid2', 1, 0, 0, 0, 1.0, 1.0, 'WATCH')
    ).resolves.toBeDefined();
  });

  it('should respect auto_strategy constraint', async () => {
    const strategies: Array<'AVOID' | 'SHORT' | 'WATCH' | 'LONG'> = ['AVOID', 'SHORT', 'WATCH', 'LONG'];

    for (const strategy of strategies) {
      await expect(
        repo.upsertCartel(`cartel_${strategy}`, `Test ${strategy}`, 1, 0, 0, 0, 0.5, 0.5, strategy)
      ).resolves.toBeDefined();
    }
  });
});
