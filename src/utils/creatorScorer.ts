import pg from 'pg';
import { logger } from './logger.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://walletsource:walletsource_dev@localhost:5432/walletsource`,
});

// In-memory cache of creator scores
const scoreCache = new Map<string, { score: number; rugRate: number; avgPeakMC: number; totalTokens: number; cachedAt: number }>();
const CACHE_TTL = 300_000; // 5 minutes

/**
 * Get creator score for a deployer wallet
 * Returns null if deployer unknown (new deployer = pass through)
 */
export async function getCreatorScore(deployerWallet: string): Promise<{
  score: number;
  rugRate: number;
  avgPeakMC: number;
  totalTokens: number;
} | null> {
  const cached = scoreCache.get(deployerWallet);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return cached;
  }

  try {
    const { rows } = await pool.query(
      'SELECT creator_score, rug_rate, avg_peak_mc, total_tokens FROM creator_scores WHERE deployer_wallet = $1',
      [deployerWallet]
    );
    if (rows.length === 0) return null; // Unknown deployer = new, let pass

    const result = {
      score: parseFloat(rows[0].creator_score) || 0,
      rugRate: parseFloat(rows[0].rug_rate) || 0,
      avgPeakMC: parseFloat(rows[0].avg_peak_mc) || 0,
      totalTokens: parseInt(rows[0].total_tokens) || 0,
      cachedAt: Date.now(),
    };
    scoreCache.set(deployerWallet, result);
    return result;
  } catch (e: any) {
    logger.error({ error: e.message }, 'Failed to get creator score');
    return null;
  }
}

/**
 * Get the deployer (first buyer) of a token from trade_events
 */
export async function getTokenDeployer(tokenAddress: string): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      "SELECT trader_wallet FROM trade_events WHERE token_address = $1 AND tx_type = 'buy' ORDER BY event_at ASC LIMIT 1",
      [tokenAddress]
    );
    return rows.length > 0 ? rows[0].trader_wallet : null;
  } catch (e: any) {
    return null;
  }
}

/**
 * Refresh creator scores periodically (called from cron or startup)
 */
export async function refreshCreatorScores(): Promise<number> {
  try {
    const result = await pool.query(`
      INSERT INTO creator_scores (deployer_wallet, total_tokens, avg_peak_mc, tokens_above_10k, tokens_dead, rug_rate, graduation_rate)
      WITH first_buys AS (
        SELECT DISTINCT ON (token_address) token_address, trader_wallet as deployer
        FROM trade_events WHERE tx_type = 'buy'
        ORDER BY token_address, event_at ASC
      ),
      token_peaks AS (
        SELECT fb.deployer, fb.token_address, MAX(te.market_cap_usd) as peak_mc
        FROM first_buys fb
        JOIN trade_events te ON te.token_address = fb.token_address
        GROUP BY fb.deployer, fb.token_address
      )
      SELECT deployer, COUNT(*), ROUND(AVG(peak_mc)::numeric, 0),
        COUNT(*) FILTER (WHERE peak_mc > 10000),
        COUNT(*) FILTER (WHERE peak_mc < 5000),
        ROUND(COUNT(*) FILTER (WHERE peak_mc < 5000)::numeric / NULLIF(COUNT(*), 0) * 100, 1),
        ROUND(COUNT(*) FILTER (WHERE peak_mc > 50000)::numeric / NULLIF(COUNT(*), 0) * 100, 1)
      FROM token_peaks GROUP BY deployer HAVING COUNT(*) >= 2
      ON CONFLICT (deployer_wallet) DO UPDATE SET
        total_tokens = EXCLUDED.total_tokens, avg_peak_mc = EXCLUDED.avg_peak_mc,
        tokens_above_10k = EXCLUDED.tokens_above_10k, tokens_dead = EXCLUDED.tokens_dead,
        rug_rate = EXCLUDED.rug_rate, graduation_rate = EXCLUDED.graduation_rate, last_updated = NOW();
      
      UPDATE creator_scores SET creator_score = LEAST(100, GREATEST(0,
        LEAST(40, GREATEST(0, (avg_peak_mc - 3000) / 300)) +
        LEAST(40, GREATEST(0, (100 - rug_rate) * 0.4)) +
        LEAST(20, graduation_rate * 2)
      ));
    `);
    scoreCache.clear();
    logger.info('✅ Creator scores refreshed');
    return result.rowCount || 0;
  } catch (e: any) {
    logger.error({ error: e.message }, 'Failed to refresh creator scores');
    return 0;
  }
}
