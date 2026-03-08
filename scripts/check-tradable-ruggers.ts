#!/usr/bin/env tsx
/**
 * Check wallets with tradable rugs
 */

import { getDb } from '../src/db/connection.js';

async function checkTradableRuggers(): Promise<void> {
  const pool = await getDb();

  try {
    // Wallets with 3+ tradable rugs
    const result = await pool.query(`
      SELECT
        creator_wallet,
        COUNT(*) as tradable_rugs,
        ROUND(AVG(peak_mc)::numeric, 2) as avg_peak_mc,
        ROUND(AVG(time_to_rug_min)::numeric, 2) as avg_time_to_rug,
        ARRAY_AGG(token_address ORDER BY detected_at DESC) as tokens
      FROM token_events
      WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
      AND peak_mc >= 1000
      AND time_to_peak_min IS NOT NULL
      AND time_to_rug_min IS NOT NULL
      GROUP BY creator_wallet
      HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC, AVG(peak_mc) DESC
    `);

    console.log('\n🎯 Wallets with 3+ Tradable Rugs (peak_mc >= $1000):');
    console.log('='.repeat(100));

    if (result.rows.length === 0) {
      console.log('❌ No wallets found with 3+ tradable rugs');
      console.log('\n💡 This is why we have 0 RIDE playbooks!');
    } else {
      for (const row of result.rows) {
        console.log(`\nWallet: ${row.creator_wallet}`);
        console.log(`  Tradable Rugs: ${row.tradable_rugs}`);
        console.log(`  Avg Peak MC: $${row.avg_peak_mc}`);
        console.log(`  Avg Time to Rug: ${row.avg_time_to_rug} min`);
        console.log(`  Tokens: ${row.tokens.slice(0, 3).join(', ')}...`);
      }
    }

    console.log('\n' + '='.repeat(100));

    // Distribution of tradable rugs by wallet
    const distribution = await pool.query(`
      SELECT
        rug_count,
        COUNT(*) as wallets
      FROM (
        SELECT
          creator_wallet,
          COUNT(*) as rug_count
        FROM token_events
        WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
        AND peak_mc >= 1000
        GROUP BY creator_wallet
      ) sub
      GROUP BY rug_count
      ORDER BY rug_count DESC
    `);

    console.log('\n📊 Distribution of Tradable Rugs by Wallet:');
    console.log('-'.repeat(50));
    for (const row of distribution.rows) {
      console.log(`  ${row.rug_count} rug(s): ${row.wallets} wallet(s)`);
    }

  } catch (error) {
    console.error('Failed to check tradable ruggers:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

checkTradableRuggers().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
