#!/usr/bin/env tsx
/**
 * Check EHe3... wallet rugs
 */

import { getDb } from '../src/db/connection.js';

async function checkRugs(): Promise<void> {
  const pool = await getDb();

  try {
    const result = await pool.query(`
      SELECT
        token_address,
        verdict,
        peak_mc,
        time_to_peak_min,
        time_to_rug_min,
        detected_at
      FROM token_events
      WHERE creator_wallet = 'EHe3TnyDNDLioGa6J5ZH2mztvaNduaAr66VJTD1AE35Z'
      AND verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
      ORDER BY detected_at DESC
    `);

    console.log('\n🔍 EHe3... wallet RUGs:', result.rows.length);
    console.log('='.repeat(80));

    let totalPeakMC = 0;
    for (const row of result.rows) {
      console.log(`\nToken: ${row.token_address}`);
      console.log(`  Verdict: ${row.verdict}`);
      console.log(`  Peak MC: $${row.peak_mc}`);
      console.log(`  Time to Peak: ${row.time_to_peak_min} min`);
      console.log(`  Time to Rug: ${row.time_to_rug_min} min`);
      totalPeakMC += parseFloat(row.peak_mc) || 0;
    }

    const avgPeakMC = result.rows.length > 0 ? totalPeakMC / result.rows.length : 0;
    console.log('\n' + '='.repeat(80));
    console.log(`Average Peak MC: $${avgPeakMC.toFixed(2)}`);
    console.log(`Expected Strategy: ${avgPeakMC < 500 ? 'AVOID' : 'RIDE (if consistency >= 0.7)'}`);

  } catch (error) {
    console.error('Failed to check rugs:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

checkRugs().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
