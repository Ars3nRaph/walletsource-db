#!/usr/bin/env tsx
import { getDb } from '../src/db/connection.js';
import { PlaybookBuilder } from '../src/scoring/PlaybookBuilder.js';

const BATCH_SIZE = 20;

async function main() {
  const pool = await getDb();
  const builder = new PlaybookBuilder(pool);

  const result = await pool.query(`
    SELECT creator_wallet, COUNT(*) as rug_count
    FROM token_events
    WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
      AND time_to_peak_min IS NOT NULL AND time_to_rug_min IS NOT NULL
    GROUP BY creator_wallet HAVING COUNT(*) >= 3
    ORDER BY COUNT(*) DESC
  `);

  const wallets = result.rows;
  console.log(`\n🔄 Rebuilding ${wallets.length} playbooks...`);
  let done = 0, success = 0, skipped = 0, errors = 0;

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async ({ creator_wallet }) => {
      try {
        const p = await builder.buildPlaybook(creator_wallet);
        p ? success++ : skipped++;
      } catch { errors++; }
      done++;
    }));
    process.stdout.write(`\r  ${done}/${wallets.length} — ✓${success} ⊘${skipped} ✗${errors}`);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n\n✅ Rebuild terminé:');
  console.log(`  Rebuilt: ${success} | Skipped: ${skipped} | Errors: ${errors}`);

  const stats = await pool.query(`
    SELECT rugger_playbook->>'recommended_strategy' as strategy, COUNT(*) as count,
      ROUND(AVG((rugger_playbook->>'avg_pump_multiple')::float)::numeric, 2) as avg_pump_x
    FROM wallet_profiles WHERE rugger_playbook IS NOT NULL
    GROUP BY strategy ORDER BY count DESC
  `);
  console.log('\n📊 Distribution après rebuild:');
  for (const r of stats.rows) console.log(`  ${r.strategy}: ${r.count} wallets (avg pump: ${r.avg_pump_x}x)`);

  const fb = await pool.query(`SELECT COUNT(*) FROM wallet_profiles WHERE (rugger_playbook->>'avg_pump_multiple')::float = 3.0`);
  console.log(`\n  Fallbacks pump=3.0 restants: ${fb.rows[0].count}`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
