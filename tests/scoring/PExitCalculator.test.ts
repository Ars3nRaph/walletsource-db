import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { PExitCalculator } from '../../src/scoring/PExitCalculator.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import { TokenEventRepo } from '../../src/repositories/TokenEventRepo.js';
import { CartelRepo } from '../../src/repositories/CartelRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('PExitCalculator', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let calculator: PExitCalculator;
  let walletRepo: WalletRepo;
  let tokenRepo: TokenEventRepo;
  let cartelRepo: CartelRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    calculator = new PExitCalculator(pool);
    walletRepo = new WalletRepo(pool);
    tokenRepo = new TokenEventRepo(pool);
    cartelRepo = new CartelRepo(pool);
  });

  describe('getMedianMC', () => {
    it('should return 0 if no SUCCESS tokens exist', async () => {
      const creator = 'noSuccessWallet';
      await walletRepo.upsertWallet(creator);

      // Create token with RUG verdict
      await tokenRepo.recordEvent('rugToken1', creator);
      await tokenRepo.updateVerdict('rugToken1', 'RUG_NO_PAIR', null, null, null, null);

      const medianMC = await calculator.getMedianMC(creator);
      expect(medianMC).toBe(0);
    });

    it('should return median FDV from SUCCESS tokens', async () => {
      const creator = 'successfulWallet';
      await walletRepo.upsertWallet(creator);

      // Create 3 SUCCESS tokens with different FDVs
      await tokenRepo.recordEvent('token1', creator);
      await tokenRepo.updateVerdict('token1', 'SUCCESS', 50000, 10000, 5.0, 'pair1');

      await tokenRepo.recordEvent('token2', creator);
      await tokenRepo.updateVerdict('token2', 'SUCCESS', 70000, 15000, 3.0, 'pair2');

      await tokenRepo.recordEvent('token3', creator);
      await tokenRepo.updateVerdict('token3', 'SUCCESS', 90000, 20000, 2.0, 'pair3');

      // Median of [50000, 70000, 90000] = 70000
      const medianMC = await calculator.getMedianMC(creator);
      expect(medianMC).toBe(70000);
    });
  });

  describe('computePExitV1', () => {
    it('should compute P_exit v1 correctly (PRD example)', () => {
      // PRD example: MC_profil=50000, MC_actuel=65000, confidence=0.85
      // Expected: (65000/50000) × 0.85 = 1.3 × 0.85 = 1.105
      const pExit = calculator.computePExitV1(65000, 50000, 0.85);
      expect(pExit).toBeCloseTo(1.105, 3);
    });

    it('should return 0 if MC_profil is 0', () => {
      const pExit = calculator.computePExitV1(65000, 0, 0.85);
      expect(pExit).toBe(0);
    });

    it('should handle edge cases', () => {
      // MC_actuel = MC_profil → ratio = 1.0
      const pExit1 = calculator.computePExitV1(50000, 50000, 1.0);
      expect(pExit1).toBeCloseTo(1.0, 3);

      // MC_actuel = 2 × MC_profil → ratio = 2.0
      const pExit2 = calculator.computePExitV1(100000, 50000, 1.0);
      expect(pExit2).toBeCloseTo(2.0, 3);
    });
  });

  describe('computePExitV2', () => {
    it('should compute P_exit v2 correctly (PRD example)', () => {
      // PRD example: MC_profil=50000, MC_actuel=65000, confidence_v2=0.85
      // Expected: sigmoid(3 × (1.3 - 1)) × 0.85 = sigmoid(0.9) × 0.85
      // sigmoid(0.9) ≈ 0.711
      // 0.711 × 0.85 ≈ 0.604
      const pExit = calculator.computePExitV2(65000, 50000, 0.85);
      expect(pExit).toBeCloseTo(0.604, 2);
    });

    it('should return 0 if MC_profil is 0', () => {
      const pExit = calculator.computePExitV2(65000, 0, 0.85);
      expect(pExit).toBe(0);
    });

    it('should use sigmoid for smooth transition', () => {
      // At MC_actuel = MC_profil, sigmoid(0) = 0.5
      const pExit1 = calculator.computePExitV2(50000, 50000, 1.0);
      expect(pExit1).toBeCloseTo(0.5, 2);

      // At MC_actuel = 2 × MC_profil, sigmoid(3.0) ≈ 0.953
      const pExit2 = calculator.computePExitV2(100000, 50000, 1.0);
      expect(pExit2).toBeGreaterThan(0.9);
    });
  });

  describe('getExitActionV1', () => {
    it('should map P_exit v1 to EXIT_IMMEDIATE for pExit >= 1.5', () => {
      const action = calculator.getExitActionV1(1.5);
      expect(action.action).toBe('EXIT_IMMEDIATE');
      expect(action.sellPct).toBe(100);

      const action2 = calculator.getExitActionV1(2.0);
      expect(action2.action).toBe('EXIT_IMMEDIATE');
      expect(action2.sellPct).toBe(100);
    });

    it('should map P_exit v1 to EXIT_PROGRESSIF for 1.0 <= pExit < 1.5', () => {
      const action = calculator.getExitActionV1(1.105); // PRD example
      expect(action.action).toBe('EXIT_PROGRESSIF');
      expect(action.sellPct).toBe(50);

      const action2 = calculator.getExitActionV1(1.25);
      expect(action2.action).toBe('EXIT_PROGRESSIF');
      expect(action2.sellPct).toBe(50);
    });

    it('should map P_exit v1 to HOLD for 0.5 <= pExit < 1.0', () => {
      const action = calculator.getExitActionV1(0.8);
      expect(action.action).toBe('HOLD');
      expect(action.sellPct).toBe(0);
    });

    it('should map P_exit v1 to WATCH for pExit < 0.5', () => {
      const action = calculator.getExitActionV1(0.3);
      expect(action.action).toBe('WATCH');
      expect(action.sellPct).toBe(0);
    });
  });

  describe('getExitActionV2', () => {
    it('should map P_exit v2 to continuous sell percentage', () => {
      const action = calculator.getExitActionV2(0.604); // PRD example
      expect(action.action).toBe('SELL');
      expect(action.sellPct).toBeCloseTo(60.4, 1);
    });

    it('should cap sell percentage at 100%', () => {
      const action = calculator.getExitActionV2(1.5); // > 1.0
      expect(action.action).toBe('SELL');
      expect(action.sellPct).toBe(100);
    });

    it('should handle edge cases', () => {
      const action1 = calculator.getExitActionV2(0.0);
      expect(action1.sellPct).toBe(0);

      const action2 = calculator.getExitActionV2(0.5);
      expect(action2.sellPct).toBe(50);

      const action3 = calculator.getExitActionV2(1.0);
      expect(action3.sellPct).toBe(100);
    });
  });

  describe('recalculatePExit', () => {
    it('should recalculate and persist P_exit scores', async () => {
      const creator = 'recalcWallet';
      const token = 'recalcToken';

      await walletRepo.upsertWallet(creator);
      await tokenRepo.recordEvent(token, creator);

      // Create SUCCESS token for MC_profil
      await tokenRepo.recordEvent('successToken', creator);
      await tokenRepo.updateVerdict('successToken', 'SUCCESS', 50000, 10000, 5.0, 'pair1');

      // Recalculate with currentMC = 65000
      const result = await calculator.recalculatePExit(token, 65000);

      expect(result.pExitV1).toBeCloseTo(1.3, 2); // No cartel, confidence = 1.0
      expect(result.pExitV2).toBeGreaterThan(0.5);

      // Verify persistence
      const updatedToken = await tokenRepo.getByAddress(token);
      expect(updatedToken?.p_exit_v1).toBeCloseTo(1.3, 2);
    });

    it('should use cartel confidence scores if wallet is in cartel', async () => {
      const creator = 'cartelWallet';
      const token = 'cartelToken';
      const cartelId = 'testCartel';

      await walletRepo.upsertWallet(creator);
      await tokenRepo.recordEvent(token, creator);

      // Create SUCCESS token for MC_profil
      await tokenRepo.recordEvent('successToken', creator);
      await tokenRepo.updateVerdict('successToken', 'SUCCESS', 50000, 10000, 5.0, 'pair1');

      // Create cartel with confidence scores
      await cartelRepo.upsertCartel(
        cartelId,
        'Test Cartel',
        3,
        5,
        10,
        0.333,
        0.7, // confidence_score v1
        0.6, // confidence_score_v2
        'RIDE'
      );

      // Associate wallet with cartel
      await walletRepo.updateCartel(creator, cartelId);

      // Recalculate with currentMC = 65000
      const result = await calculator.recalculatePExit(token, 65000);

      // V1: (65000/50000) × 0.7 = 1.3 × 0.7 = 0.91
      expect(result.pExitV1).toBeCloseTo(0.91, 2);

      // V2: sigmoid(3 × 0.3) × 0.6 = sigmoid(0.9) × 0.6 ≈ 0.426
      expect(result.pExitV2).toBeCloseTo(0.426, 2);
    });

    it('should return 0 if no SUCCESS tokens exist for creator', async () => {
      const creator = 'noSuccessWallet2';
      const token = 'noSuccessToken';

      await walletRepo.upsertWallet(creator);
      await tokenRepo.recordEvent(token, creator);

      const result = await calculator.recalculatePExit(token, 65000);

      expect(result.pExitV1).toBe(0);
      expect(result.pExitV2).toBe(0);
    });
  });

  describe('Performance', () => {
    it('should complete calculation in less than 10ms', async () => {
      const creator = 'perfWallet';
      const token = 'perfToken';

      await walletRepo.upsertWallet(creator);
      await tokenRepo.recordEvent(token, creator);

      // Create SUCCESS token for MC_profil
      await tokenRepo.recordEvent('successToken', creator);
      await tokenRepo.updateVerdict('successToken', 'SUCCESS', 50000, 10000, 5.0, 'pair1');

      const startTime = Date.now();

      // Perform calculation
      await calculator.getMedianMC(creator);
      calculator.computePExitV1(65000, 50000, 0.85);
      calculator.computePExitV2(65000, 50000, 0.85);

      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(10);
    });

    it('should complete full recalculation in less than 50ms', async () => {
      const creator = 'fullPerfWallet';
      const token = 'fullPerfToken';

      await walletRepo.upsertWallet(creator);
      await tokenRepo.recordEvent(token, creator);

      // Create SUCCESS token for MC_profil
      await tokenRepo.recordEvent('successToken', creator);
      await tokenRepo.updateVerdict('successToken', 'SUCCESS', 50000, 10000, 5.0, 'pair1');

      const startTime = Date.now();
      await calculator.recalculatePExit(token, 65000);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });
  });
});
