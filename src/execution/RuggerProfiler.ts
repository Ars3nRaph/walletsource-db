import { Pool } from 'pg';
import { logger } from '../utils/logger.js';

/**
 * RuggerProfiler — Per-wallet strategy based on historical token behavior
 * 
 * Qualification criteria (from backtest):
 *   - 10+ tokens with known peak_mc
 *   - P25 of peak_mc > 4000 (tokens pump enough to profit)
 *   - CV of peak_mc < 0.5 (predictable behavior)
 *   - Simulated WR > 50% on training set
 * 
 * Strategy: enter at detection, exit at P25 target or hard stop
 */

export interface RuggerProfile {
  walletAddress: string;
  tokenCount: number;
  medianPeak: number;
  p25Peak: number;       // Conservative target — 75% of tokens reach this
  avgPeak: number;
  cvPeak: number;        // Coefficient of variation (lower = more predictable)
  avgTimeToRug: number;  // Average minutes to rug
  trainWR: number;       // Win rate on training tokens (%)
  targetExitMC: number;  // = P25 peak
  timeStopMin: number;   // = avgTimeToRug * 0.8
  lastUpdated: Date;
}

const MIN_TOKENS = 10;
const MIN_TARGET_MC = 4000;
const MAX_CV = 0.38;  // v10.10h: was 0.5, CV>0.38 = 0% WR live
const MIN_TRAIN_WR = 50;
const FEES = 0.08;    // v10.10h: realistic fees (2.5% buy slip + 3.5% sell slip + 2% pump fees)
const HARD_STOP = -0.35;
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // Refresh profiles every 30 min

export class RuggerProfiler {
  private pool: Pool;
  private profiles = new Map<string, RuggerProfile>();
  private lastRefresh = 0;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Load/refresh all qualifying rugger profiles from DB */
  async refreshProfiles(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh < REFRESH_INTERVAL_MS && this.profiles.size > 0) return;
    
    try {
      // Get all wallets with 10+ tokens that have peak data
      const result = await this.pool.query(`
        WITH wallet_tokens AS (
          SELECT 
            t.creator_wallet,
            t.peak_mc,
            t.fdv_at_detection,
            t.time_to_rug_min,
            ROW_NUMBER() OVER (PARTITION BY t.creator_wallet ORDER BY t.detected_at) as rn,
            COUNT(*) OVER (PARTITION BY t.creator_wallet) as total_tokens
          FROM token_events t
          JOIN wallet_profiles w ON w.wallet_address = t.creator_wallet
          WHERE w.rug_count >= 5
            AND t.peak_mc IS NOT NULL AND t.peak_mc > 0
        ),
        wallet_stats AS (
          SELECT 
            creator_wallet,
            total_tokens,
            AVG(peak_mc) as avg_peak,
            STDDEV(peak_mc) as std_peak,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY peak_mc) as p25_peak,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY peak_mc) as med_peak,
            AVG(time_to_rug_min) FILTER (WHERE time_to_rug_min > 0) as avg_ttr,
            -- Compute per-token results for training WR
            ARRAY_AGG(peak_mc ORDER BY rn) as peaks,
            ARRAY_AGG(COALESCE(fdv_at_detection, 2500) ORDER BY rn) as entries
          FROM wallet_tokens
          WHERE total_tokens >= ${MIN_TOKENS}
          GROUP BY creator_wallet, total_tokens
        )
        SELECT 
          creator_wallet,
          total_tokens,
          avg_peak,
          std_peak,
          p25_peak,
          med_peak,
          avg_ttr,
          peaks[1:${MIN_TOKENS}] as train_peaks,
          entries[1:${MIN_TOKENS}] as train_entries
        FROM wallet_stats
        WHERE p25_peak > ${MIN_TARGET_MC}
          AND std_peak / NULLIF(avg_peak, 0) < ${MAX_CV}
      `);

      const newProfiles = new Map<string, RuggerProfile>();
      
      for (const row of result.rows) {
        const trainPeaks: number[] = row.train_peaks.map(Number);
        const trainEntries: number[] = row.train_entries.map(Number);
        const p25 = row.p25_peak;
        
        // Simulate training WR
        let wins = 0;
        for (let i = 0; i < trainPeaks.length; i++) {
          const entry = trainEntries[i] || 2500;
          const peak = trainPeaks[i];
          let pnl: number;
          if (peak >= p25) {
            pnl = (p25 - entry) / Math.max(entry, 1) - FEES;
          } else if (peak > entry * 1.05) {
            pnl = (peak * 0.6 - entry) / Math.max(entry, 1) - FEES;
          } else {
            pnl = Math.max(HARD_STOP, (peak * 0.5 - entry) / Math.max(entry, 1)) - FEES;
          }
          if (pnl > 0) wins++;
        }
        
        const trainWR = (wins / trainPeaks.length) * 100;
        if (trainWR < MIN_TRAIN_WR) continue;
        
        const cv = (row.std_peak || 0) / Math.max(row.avg_peak, 1);
        const avgTTR = row.avg_ttr || 5;
        
        const profile: RuggerProfile = {
          walletAddress: row.creator_wallet,
          tokenCount: row.total_tokens,
          medianPeak: row.med_peak,
          p25Peak: p25,
          avgPeak: row.avg_peak,
          cvPeak: cv,
          avgTimeToRug: avgTTR,
          trainWR,
          targetExitMC: p25,
          timeStopMin: avgTTR * 0.8,
          lastUpdated: new Date(),
        };
        
        newProfiles.set(row.creator_wallet, profile);
      }
      
      this.profiles = newProfiles;
      this.lastRefresh = now;
      
      logger.info({ 
        qualified: newProfiles.size,
        avgTarget: Math.round([...newProfiles.values()].reduce((s, p) => s + p.targetExitMC, 0) / Math.max(newProfiles.size, 1)),
        avgWR: Math.round([...newProfiles.values()].reduce((s, p) => s + p.trainWR, 0) / Math.max(newProfiles.size, 1)),
      }, '🎯 RuggerProfiler refreshed');
      
    } catch (err) {
      logger.error({ err }, 'RuggerProfiler.refreshProfiles error');
    }
  }

  /** Check if a wallet has a qualifying rugger profile */
  getProfile(walletAddress: string): RuggerProfile | null {
    return this.profiles.get(walletAddress) || null;
  }

  /** Get all qualifying profiles */
  getAllProfiles(): Map<string, RuggerProfile> {
    return this.profiles;
  }

  get profileCount(): number {
    return this.profiles.size;
  }
}
