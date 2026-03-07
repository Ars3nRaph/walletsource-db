import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { AncestryRepo } from '../../src/repositories/AncestryRepo.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('AncestryRepo', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let repo: AncestryRepo;
  let walletRepo: WalletRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    repo = new AncestryRepo(pool);
    walletRepo = new WalletRepo(pool);
  });

  it('should add ancestry link', async () => {
    await walletRepo.upsertWallet('parent1');
    await walletRepo.upsertWallet('child1');

    const link = await repo.addLink('parent1', 'child1', 'tx123', 1.5, 0, 0.95);

    expect(link.parent_wallet).toBe('parent1');
    expect(link.child_wallet).toBe('child1');
    expect(link.funding_tx).toBe('tx123');
    expect(link.funding_amount_sol).toBe(1.5);
    expect(link.depth).toBe(0);
    expect(link.confidence).toBe(0.95);
  });

  it('should get ancestors with max depth', async () => {
    // Create chain: grandparent -> parent -> child
    await walletRepo.upsertWallet('grandparent');
    await walletRepo.upsertWallet('parent');
    await walletRepo.upsertWallet('child');

    await repo.addLink('grandparent', 'parent', 'tx1', 2.0, 1, 0.9);
    await repo.addLink('parent', 'child', 'tx2', 1.5, 0, 0.85);

    const ancestors = await repo.getAncestors('child', 2);

    expect(ancestors.length).toBe(2);
    expect(ancestors.map(a => a.parent_wallet)).toContain('parent');
    expect(ancestors.map(a => a.parent_wallet)).toContain('grandparent');
  });

  it('should filter out low confidence links', async () => {
    await walletRepo.upsertWallet('parent_low');
    await walletRepo.upsertWallet('parent_high');
    await walletRepo.upsertWallet('child');

    await repo.addLink('parent_low', 'child', 'tx1', 1.0, 0, 0.5); // confidence < 0.7
    await repo.addLink('parent_high', 'child', 'tx2', 1.0, 0, 0.9); // confidence >= 0.7

    const ancestors = await repo.getAncestors('child', 3);

    expect(ancestors.length).toBe(1);
    expect(ancestors[0].parent_wallet).toBe('parent_high');
  });

  it('should get descendants', async () => {
    await walletRepo.upsertWallet('parent');
    await walletRepo.upsertWallet('child1');
    await walletRepo.upsertWallet('child2');

    await repo.addLink('parent', 'child1', 'tx1', 1.0, 0, 0.9);
    await repo.addLink('parent', 'child2', 'tx2', 1.5, 0, 0.85);

    const descendants = await repo.getDescendants('parent');

    expect(descendants.length).toBe(2);
    expect(descendants.map(d => d.child_wallet).sort()).toEqual(['child1', 'child2']);
  });

  it('should get full chain', async () => {
    await walletRepo.upsertWallet('wallet1');
    await walletRepo.upsertWallet('wallet2');
    await walletRepo.upsertWallet('wallet3');

    await repo.addLink('wallet1', 'wallet2', 'tx1', 1.0, 0, 0.9);
    await repo.addLink('wallet2', 'wallet3', 'tx2', 1.5, 1, 0.85);

    const chain = await repo.getChain('wallet2');

    expect(chain.length).toBe(2);
    expect(chain.some(c => c.parent_wallet === 'wallet1')).toBe(true);
    expect(chain.some(c => c.child_wallet === 'wallet3')).toBe(true);
  });

  it('should respect depth constraint (0-3)', async () => {
    await walletRepo.upsertWallet('parent');
    await walletRepo.upsertWallet('child');

    // Should succeed for depths 0-3
    await expect(repo.addLink('parent', 'child', 'tx0', 1.0, 0, 0.9)).resolves.toBeDefined();

    // Clear previous link
    await pool.query('DELETE FROM wallet_ancestry');

    await expect(repo.addLink('parent', 'child', 'tx3', 1.0, 3, 0.9)).resolves.toBeDefined();
  });

  it('should respect confidence constraint (0-1)', async () => {
    await walletRepo.upsertWallet('parent');
    await walletRepo.upsertWallet('child');

    // Should succeed for confidence 0-1
    await expect(repo.addLink('parent', 'child', 'tx1', 1.0, 0, 0.0)).resolves.toBeDefined();

    // Clear previous link
    await pool.query('DELETE FROM wallet_ancestry');

    await expect(repo.addLink('parent', 'child', 'tx2', 1.0, 0, 1.0)).resolves.toBeDefined();
  });
});
