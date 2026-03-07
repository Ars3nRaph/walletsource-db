import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { CalibrationRepo } from '../../src/repositories/CalibrationRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('CalibrationRepo', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let repo: CalibrationRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    repo = new CalibrationRepo(pool);
  });

  it('should log a calibration attempt', async () => {
    const log = await repo.logCalibration('k_confidence', 6.0, 6.6, 8.5, 50, true);

    expect(log.param_name).toBe('k_confidence');
    expect(log.old_value).toBe(6.0);
    expect(log.new_value).toBe(6.6);
    expect(log.improvement_pct).toBe(8.5);
    expect(log.tokens_evaluated).toBe(50);
    expect(log.accepted).toBe(true);
  });

  it('should log rejected calibration', async () => {
    const log = await repo.logCalibration('alpha_pexit', 3.0, 5.0, 0, 50, false);

    expect(log.accepted).toBe(false);
    expect(log.improvement_pct).toBe(0);
  });

  it('should get calibration history for a parameter', async () => {
    await repo.logCalibration('k_rug', 6.0, 6.6, 5.5, 50, true);
    await repo.logCalibration('k_rug', 6.6, 7.26, 6.2, 50, true);
    await repo.logCalibration('k_rug', 7.26, 6.5, -2.0, 50, false);

    const history = await repo.getHistory('k_rug');

    expect(history.length).toBe(3);
    // Should be ordered by date DESC (newest first)
    expect(history[0].new_value).toBe(6.5);
    expect(history[1].new_value).toBe(7.26);
    expect(history[2].new_value).toBe(6.6);
  });

  it('should get recent logs within date range', async () => {
    // Log some calibrations
    await repo.logCalibration('mu_taint', 100, 110, 3.0, 50, true);
    await repo.logCalibration('sigma_taint', 40, 44, 4.0, 50, true);

    const recentLogs = await repo.getRecentLogs(7);

    expect(recentLogs.length).toBe(2);
    expect(recentLogs.map(l => l.param_name).sort()).toEqual(['mu_taint', 'sigma_taint']);
  });

  it('should get latest accepted calibration for a parameter', async () => {
    await repo.logCalibration('w1_rug', 0.40, 0.36, -3.0, 50, false);
    await repo.logCalibration('w1_rug', 0.40, 0.44, 6.0, 50, true);
    await repo.logCalibration('w1_rug', 0.44, 0.48, 3.0, 50, false);

    const latest = await repo.getLatestAccepted('w1_rug');

    expect(latest).not.toBeNull();
    expect(latest?.new_value).toBe(0.44);
    expect(latest?.accepted).toBe(true);
  });

  it('should return null if no accepted calibrations exist', async () => {
    await repo.logCalibration('w2_toxicity', 0.35, 0.38, 2.0, 50, false);

    const latest = await repo.getLatestAccepted('w2_toxicity');

    expect(latest).toBeNull();
  });

  it('should count accepted calibrations', async () => {
    await repo.logCalibration('k_cartel', 5.0, 5.5, 6.0, 50, true);
    await repo.logCalibration('k_cartel', 5.5, 6.0, 2.0, 50, false);
    await repo.logCalibration('alpha_pexit', 3.0, 3.3, 7.0, 50, true);

    const count = await repo.getAcceptedCount(7);

    expect(count).toBe(2);
  });

  it('should handle multiple parameters in history', async () => {
    // Log calibrations for different parameters
    await repo.logCalibration('k_confidence', 6.0, 6.6, 5.0, 50, true);
    await repo.logCalibration('alpha_pexit', 3.0, 3.3, 6.0, 50, true);
    await repo.logCalibration('mu_taint', 100, 110, 4.0, 50, false);

    const kHistory = await repo.getHistory('k_confidence');
    const alphaHistory = await repo.getHistory('alpha_pexit');

    expect(kHistory.length).toBe(1);
    expect(alphaHistory.length).toBe(1);
    expect(kHistory[0].param_name).toBe('k_confidence');
    expect(alphaHistory[0].param_name).toBe('alpha_pexit');
  });

  it('should preserve improvement percentage with decimals', async () => {
    const log = await repo.logCalibration('w3_cartel', 0.25, 0.275, 7.834, 100, true);

    expect(log.improvement_pct).toBeCloseTo(7.834, 3);
  });
});
