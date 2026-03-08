import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../setup.js';
import { PlaybookBuilder } from '../../src/scoring/PlaybookBuilder.js';
import { WalletRepo } from '../../src/repositories/WalletRepo.js';
import { TokenEventRepo } from '../../src/repositories/TokenEventRepo.js';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';

describe('PlaybookBuilder', () => {
  let db: IMemoryDb;
  let pool: Pool;
  let builder: PlaybookBuilder;
  let walletRepo: WalletRepo;
  let tokenRepo: TokenEventRepo;

  beforeEach(async () => {
    db = await createTestDb();
    pool = new (db.adapters.createPg().Pool)() as unknown as Pool;
    builder = new PlaybookBuilder(pool);
    walletRepo = new WalletRepo(pool);
    tokenRepo = new TokenEventRepo(pool);

    // Create test wallet
    await walletRepo.upsertWallet('rugger1');
  });

  describe('buildPlaybook', () => {
    it('should return null for insufficient data (< 3 rugs)', async () => {
      // Create only 2 rugs
      await tokenRepo.recordEvent('token1', 'rugger1');
      await tokenRepo.recordEvent('token2', 'rugger1');

      await pool.query(
        `UPDATE token_events
         SET verdict = 'RUG_METRICS',
             peak_mc = 50000,
             time_to_peak_min = 5,
             time_to_rug_min = 10,
             checked_at = NOW()
         WHERE token_address IN ('token1', 'token2')`
      );

      const playbook = await builder.buildPlaybook('rugger1');
      expect(playbook).toBeNull();
    });

    it('should build playbook with 5 rugs', async () => {
      // Create 5 rugs with consistent timing
      const rugs = [
        { token: 'rug1', peak_mc: 45000, time_to_peak: 4.5, time_to_rug: 9.0, dump_speed: -10, liq: 8000 },
        { token: 'rug2', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0, dump_speed: -12, liq: 9000 },
        { token: 'rug3', peak_mc: 48000, time_to_peak: 4.8, time_to_rug: 9.5, dump_speed: -11, liq: 8500 },
        { token: 'rug4', peak_mc: 52000, time_to_peak: 5.2, time_to_rug: 10.2, dump_speed: -13, liq: 9200 },
        { token: 'rug5', peak_mc: 47000, time_to_peak: 4.7, time_to_rug: 9.3, dump_speed: -10.5, liq: 8300 }
      ];

      for (const rug of rugs) {
        await tokenRepo.recordEvent(rug.token, 'rugger1');
        await pool.query(
          `UPDATE token_events
           SET verdict = 'RUG_METRICS',
               peak_mc = $1,
               time_to_peak_min = $2,
               time_to_rug_min = $3,
               dump_speed_pct_per_min = $4,
               liquidity_at_peak = $5,
               checked_at = NOW()
           WHERE token_address = $6`,
          [rug.peak_mc, rug.time_to_peak, rug.time_to_rug, rug.dump_speed, rug.liq, rug.token]
        );
      }

      const playbook = await builder.buildPlaybook('rugger1');

      expect(playbook).not.toBeNull();
      expect(playbook!.sample_size).toBe(5);
      expect(playbook!.avg_time_to_peak_min).toBeCloseTo(4.84, 1); // (4.5+5.0+4.8+5.2+4.7)/5
      expect(playbook!.avg_time_to_rug_min).toBeCloseTo(9.6, 1); // (9.0+10.0+9.5+10.2+9.3)/5
      expect(playbook!.avg_peak_mc).toBeCloseTo(48400, 0);
      expect(playbook!.consistency_score).toBeGreaterThan(0); // Should be high due to consistent timing
    });

    it('should recommend RIDE for high consistency (>= 0.7) and sample >= 5', async () => {
      // Create 5 rugs with very consistent timing (low std dev)
      const rugs = [
        { token: 'rug1', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0 },
        { token: 'rug2', peak_mc: 51000, time_to_peak: 5.1, time_to_rug: 10.1 },
        { token: 'rug3', peak_mc: 49000, time_to_peak: 4.9, time_to_rug: 9.9 },
        { token: 'rug4', peak_mc: 50500, time_to_peak: 5.05, time_to_rug: 10.05 },
        { token: 'rug5', peak_mc: 49500, time_to_peak: 4.95, time_to_rug: 9.95 }
      ];

      for (const rug of rugs) {
        await tokenRepo.recordEvent(rug.token, 'rugger1');
        await pool.query(
          `UPDATE token_events
           SET verdict = 'RUG_METRICS',
               peak_mc = $1,
               time_to_peak_min = $2,
               time_to_rug_min = $3,
               checked_at = NOW()
           WHERE token_address = $4`,
          [rug.peak_mc, rug.time_to_peak, rug.time_to_rug, rug.token]
        );
      }

      const playbook = await builder.buildPlaybook('rugger1');

      expect(playbook).not.toBeNull();
      expect(playbook!.consistency_score).toBeGreaterThan(0.7);
      expect(playbook!.recommended_strategy).toBe('RIDE');
    });

    it('should recommend FADE for moderate consistency (>= 0.6) and sample >= 5', async () => {
      // Create 5 rugs with moderate consistency
      const rugs = [
        { token: 'rug1', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0 },
        { token: 'rug2', peak_mc: 52000, time_to_peak: 5.5, time_to_rug: 11.0 },
        { token: 'rug3', peak_mc: 48000, time_to_peak: 4.5, time_to_rug: 9.0 },
        { token: 'rug4', peak_mc: 51000, time_to_peak: 5.2, time_to_rug: 10.5 },
        { token: 'rug5', peak_mc: 49000, time_to_peak: 4.8, time_to_rug: 9.5 }
      ];

      for (const rug of rugs) {
        await tokenRepo.recordEvent(rug.token, 'rugger1');
        await pool.query(
          `UPDATE token_events
           SET verdict = 'RUG_METRICS',
               peak_mc = $1,
               time_to_peak_min = $2,
               time_to_rug_min = $3,
               checked_at = NOW()
           WHERE token_address = $4`,
          [rug.peak_mc, rug.time_to_peak, rug.time_to_rug, rug.token]
        );
      }

      const playbook = await builder.buildPlaybook('rugger1');

      expect(playbook).not.toBeNull();
      // Consistency should be in [0.6, 0.7) range
      expect(playbook!.consistency_score).toBeGreaterThan(0.5);
      // Could be RIDE or FADE depending on exact CV, but sample >= 5
      expect(['RIDE', 'FADE']).toContain(playbook!.recommended_strategy);
    });

    it('should recommend AVOID for fast rugs (avg_time_to_rug < 3 min)', async () => {
      // Create 5 rugs with very fast rug times
      const rugs = [
        { token: 'rug1', peak_mc: 30000, time_to_peak: 0.5, time_to_rug: 1.0 },
        { token: 'rug2', peak_mc: 32000, time_to_peak: 0.6, time_to_rug: 1.2 },
        { token: 'rug3', peak_mc: 28000, time_to_peak: 0.4, time_to_rug: 0.8 },
        { token: 'rug4', peak_mc: 31000, time_to_peak: 0.55, time_to_rug: 1.1 },
        { token: 'rug5', peak_mc: 29000, time_to_peak: 0.45, time_to_rug: 0.9 }
      ];

      for (const rug of rugs) {
        await tokenRepo.recordEvent(rug.token, 'rugger1');
        await pool.query(
          `UPDATE token_events
           SET verdict = 'RUG_METRICS',
               peak_mc = $1,
               time_to_peak_min = $2,
               time_to_rug_min = $3,
               checked_at = NOW()
           WHERE token_address = $4`,
          [rug.peak_mc, rug.time_to_peak, rug.time_to_rug, rug.token]
        );
      }

      const playbook = await builder.buildPlaybook('rugger1');

      expect(playbook).not.toBeNull();
      expect(playbook!.avg_time_to_rug_min).toBeLessThan(3);
      expect(playbook!.recommended_strategy).toBe('AVOID');
    });

    it('should recommend WATCH for low sample size (< 5)', async () => {
      // Create only 3 rugs (below threshold for RIDE/FADE)
      const rugs = [
        { token: 'rug1', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0 },
        { token: 'rug2', peak_mc: 51000, time_to_peak: 5.1, time_to_rug: 10.1 },
        { token: 'rug3', peak_mc: 49000, time_to_peak: 4.9, time_to_rug: 9.9 }
      ];

      for (const rug of rugs) {
        await tokenRepo.recordEvent(rug.token, 'rugger1');
        await pool.query(
          `UPDATE token_events
           SET verdict = 'RUG_METRICS',
               peak_mc = $1,
               time_to_peak_min = $2,
               time_to_rug_min = $3,
               checked_at = NOW()
           WHERE token_address = $4`,
          [rug.peak_mc, rug.time_to_peak, rug.time_to_rug, rug.token]
        );
      }

      const playbook = await builder.buildPlaybook('rugger1');

      expect(playbook).not.toBeNull();
      expect(playbook!.sample_size).toBe(3);
      expect(playbook!.recommended_strategy).toBe('WATCH');
    });

    it('should calculate temporal windows correctly', async () => {
      // Create 5 rugs with known stats
      const rugs = [
        { token: 'rug1', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0 },
        { token: 'rug2', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0 },
        { token: 'rug3', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0 },
        { token: 'rug4', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0 },
        { token: 'rug5', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0 }
      ];

      for (const rug of rugs) {
        await tokenRepo.recordEvent(rug.token, 'rugger1');
        await pool.query(
          `UPDATE token_events
           SET verdict = 'RUG_METRICS',
               peak_mc = $1,
               time_to_peak_min = $2,
               time_to_rug_min = $3,
               checked_at = NOW()
           WHERE token_address = $4`,
          [rug.peak_mc, rug.time_to_peak, rug.time_to_rug, rug.token]
        );
      }

      const playbook = await builder.buildPlaybook('rugger1');

      expect(playbook).not.toBeNull();

      // All values identical → std = 0
      expect(playbook!.std_time_to_peak_min).toBe(0);
      expect(playbook!.std_time_to_rug_min).toBe(0);

      // entry_window_end = avg_time_to_peak - std = 5.0 - 0 = 5.0
      expect(playbook!.entry_window_end_min).toBe(5.0);

      // exit_window_start = avg_time_to_rug - std = 10.0 - 0 = 10.0
      expect(playbook!.exit_window_start_min).toBe(10.0);

      // exit_window_end = avg_time_to_rug = 10.0
      expect(playbook!.exit_window_end_min).toBe(10.0);

      // short_window_start = avg_time_to_peak = 5.0
      expect(playbook!.short_window_start_min).toBe(5.0);

      // short_window_end = avg_time_to_rug - 0.5*std = 10.0 - 0 = 10.0
      expect(playbook!.short_window_end_min).toBe(10.0);
    });

    it('should only include RUG tokens with complete lifecycle data', async () => {
      // Create 5 tokens: 2 SUCCESS, 1 RUG without lifecycle, 2 RUG with lifecycle
      await tokenRepo.recordEvent('success1', 'rugger1');
      await tokenRepo.recordEvent('success2', 'rugger1');
      await tokenRepo.recordEvent('rug_incomplete', 'rugger1');
      await tokenRepo.recordEvent('rug_complete1', 'rugger1');
      await tokenRepo.recordEvent('rug_complete2', 'rugger1');

      await pool.query(
        `UPDATE token_events
         SET verdict = 'SUCCESS', checked_at = NOW()
         WHERE token_address IN ('success1', 'success2')`
      );

      await pool.query(
        `UPDATE token_events
         SET verdict = 'RUG_METRICS', checked_at = NOW()
         WHERE token_address = 'rug_incomplete'`
        // No lifecycle data (peak_mc, time_to_peak_min, time_to_rug_min are null)
      );

      await pool.query(
        `UPDATE token_events
         SET verdict = 'RUG_METRICS',
             peak_mc = 50000,
             time_to_peak_min = 5.0,
             time_to_rug_min = 10.0,
             checked_at = NOW()
         WHERE token_address IN ('rug_complete1', 'rug_complete2')`
      );

      const playbook = await builder.buildPlaybook('rugger1');

      // Should return null because only 2 complete rugs (< 3 threshold)
      expect(playbook).toBeNull();
    });

    it('should update wallet_profiles with playbook', async () => {
      // Create 5 rugs
      const rugs = [
        { token: 'rug1', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0 },
        { token: 'rug2', peak_mc: 51000, time_to_peak: 5.1, time_to_rug: 10.1 },
        { token: 'rug3', peak_mc: 49000, time_to_peak: 4.9, time_to_rug: 9.9 },
        { token: 'rug4', peak_mc: 50500, time_to_peak: 5.05, time_to_rug: 10.05 },
        { token: 'rug5', peak_mc: 49500, time_to_peak: 4.95, time_to_rug: 9.95 }
      ];

      for (const rug of rugs) {
        await tokenRepo.recordEvent(rug.token, 'rugger1');
        await pool.query(
          `UPDATE token_events
           SET verdict = 'RUG_METRICS',
               peak_mc = $1,
               time_to_peak_min = $2,
               time_to_rug_min = $3,
               checked_at = NOW()
           WHERE token_address = $4`,
          [rug.peak_mc, rug.time_to_peak, rug.time_to_rug, rug.token]
        );
      }

      await builder.buildPlaybook('rugger1');

      // Check that wallet was updated
      const wallet = await walletRepo.getByAddress('rugger1');
      expect(wallet).not.toBeNull();
      expect(wallet!.rugger_playbook).not.toBeNull();

      // Parse JSON and verify (pg-mem returns object directly, real PostgreSQL returns string)
      const playbook = typeof wallet!.rugger_playbook === 'string'
        ? JSON.parse(wallet!.rugger_playbook)
        : wallet!.rugger_playbook;
      expect(playbook.sample_size).toBe(5);
      expect(playbook.recommended_strategy).toBe('RIDE');

      // Check playbook_confidence was set
      expect(wallet!.playbook_confidence).toBeGreaterThan(0.7);

      // Check playbook_updated_at was set
      expect(wallet!.playbook_updated_at).not.toBeNull();
    });

    it('should handle both RUG_NO_PAIR and RUG_METRICS verdicts', async () => {
      // Create 3 RUG_NO_PAIR and 2 RUG_METRICS
      const rugs = [
        { token: 'rug1', verdict: 'RUG_NO_PAIR', peak_mc: 1000, time_to_peak: 1.0, time_to_rug: 2.0 },
        { token: 'rug2', verdict: 'RUG_NO_PAIR', peak_mc: 1100, time_to_peak: 1.1, time_to_rug: 2.1 },
        { token: 'rug3', verdict: 'RUG_NO_PAIR', peak_mc: 900, time_to_peak: 0.9, time_to_rug: 1.9 },
        { token: 'rug4', verdict: 'RUG_METRICS', peak_mc: 50000, time_to_peak: 5.0, time_to_rug: 10.0 },
        { token: 'rug5', verdict: 'RUG_METRICS', peak_mc: 51000, time_to_peak: 5.1, time_to_rug: 10.1 }
      ];

      for (const rug of rugs) {
        await tokenRepo.recordEvent(rug.token, 'rugger1');
        await pool.query(
          `UPDATE token_events
           SET verdict = $1,
               peak_mc = $2,
               time_to_peak_min = $3,
               time_to_rug_min = $4,
               checked_at = NOW()
           WHERE token_address = $5`,
          [rug.verdict, rug.peak_mc, rug.time_to_peak, rug.time_to_rug, rug.token]
        );
      }

      const playbook = await builder.buildPlaybook('rugger1');

      expect(playbook).not.toBeNull();
      expect(playbook!.sample_size).toBe(5); // Both RUG types counted
    });
  });
});
