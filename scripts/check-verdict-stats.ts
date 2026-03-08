#!/usr/bin/env tsx
/**
 * Check verdict statistics
 */

import { getDb } from '../src/db/connection.js';

async function checkVerdicts(): Promise<void> {
  const pool = await getDb();

  try {
    const result = await pool.query(`
      SELECT
        verdict,
        COUNT(*) as count,
        ROUND(AVG(peak_mc)::numeric, 2) as avg_peak_mc,
        ROUND(AVG(COALESCE(liquidity_at_peak, 0))::numeric, 2) as avg_liquidity,
        ROUND(MIN(peak_mc)::numeric, 2) as min_peak,
        ROUND(MAX(peak_mc)::numeric, 2) as max_peak
      FROM token_events
      WHERE verdict IS NOT NULL
      GROUP BY verdict
      ORDER BY count DESC
    `);

    console.log('\n📊 Verdict Statistics:');
    console.log('='.repeat(100));
    console.log('Verdict'.padEnd(15), 'Count'.padStart(8), 'Avg Peak MC'.padStart(15), 'Avg Liquidity'.padStart(15), 'Min Peak'.padStart(12), 'Max Peak'.padStart(12));
    console.log('-'.repeat(100));

    for (const row of result.rows) {
      console.log(
        row.verdict.padEnd(15),
        row.count.toString().padStart(8),
        `$${row.avg_peak_mc}`.padStart(15),
        `$${row.avg_liquidity}`.padStart(15),
        `$${row.min_peak}`.padStart(12),
        `$${row.max_peak}`.padStart(12)
      );
    }
    console.log('='.repeat(100));

    // Check for rugs with significant market cap
    const tradableRugs = await pool.query(`
      SELECT COUNT(*) as count
      FROM token_events
      WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
      AND peak_mc >= 1000
    `);

    console.log(`\n💡 Tradable rugs (peak_mc >= $1000): ${tradableRugs.rows[0].count}`);

    // Check for instant rugs
    const instantRugs = await pool.query(`
      SELECT COUNT(*) as count
      FROM token_events
      WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
      AND peak_mc < 500
    `);

    console.log(`🚫 Instant rugs (peak_mc < $500): ${instantRugs.rows[0].count}`);

  } catch (error) {
    console.error('Failed to check verdicts:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

checkVerdicts().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
