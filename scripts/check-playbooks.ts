#!/usr/bin/env tsx
/**
 * Check playbooks and their strategies
 */

import { getDb } from '../src/db/connection.js';
import { logger } from '../src/utils/logger.js';

async function checkPlaybooks(): Promise<void> {
  const pool = await getDb();

  try {
    const result = await pool.query(`
      SELECT
        wallet_address,
        rugger_playbook->>'recommended_strategy' as strategy,
        (rugger_playbook->>'consistency_score')::numeric as consistency,
        (rugger_playbook->>'avg_peak_mc')::numeric as avg_peak_mc,
        (rugger_playbook->>'sample_size')::int as sample_size,
        playbook_confidence
      FROM wallet_profiles
      WHERE rugger_playbook IS NOT NULL
      ORDER BY playbook_confidence DESC
    `);

    console.log('\n📖 Playbooks construits:', result.rows.length);
    console.log('='.repeat(80));
    for (const row of result.rows) {
      console.log(`\nWallet: ${row.wallet_address}`);
      console.log(`  Strategy: ${row.strategy}`);
      console.log(`  Consistency: ${row.consistency}`);
      console.log(`  Avg Peak MC: $${row.avg_peak_mc}`);
      console.log(`  Sample Size: ${row.sample_size} RUGs`);
      console.log(`  Confidence: ${row.playbook_confidence}`);
    }
    console.log('\n' + '='.repeat(80));

    // Count strategies
    const strategies = result.rows.reduce((acc: Record<string, number>, row) => {
      acc[row.strategy] = (acc[row.strategy] || 0) + 1;
      return acc;
    }, {});

    console.log('\n📊 Strategy Distribution:');
    for (const [strategy, count] of Object.entries(strategies)) {
      console.log(`  ${strategy}: ${count}`);
    }

  } catch (error) {
    logger.error({ error }, 'Failed to check playbooks');
    throw error;
  } finally {
    await pool.end();
  }
}

checkPlaybooks().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
