import { getDb } from '../db/connection.js';
import { PlaybookBuilder } from '../scoring/PlaybookBuilder.js';

const BATCH_SIZE = 20;

async function main() {
  const pool = await getDb();
  const builder = new PlaybookBuilder(pool);

  const { rows: wallets } = await pool.query(`
    SELECT DISTINCT creator_wallet as wallet_address
    FROM token_events
    WHERE creator_wallet IS NOT NULL
      AND verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
  `);

  console.log(`Total wallets à rebuilder: ${wallets.length}`);

  let rebuilt = 0, skipped = 0, errors = 0;

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async ({ wallet_address }: { wallet_address: string }) => {
      try {
        const profile = await builder.buildPlaybook(wallet_address);
        if (profile) rebuilt++;
        else skipped++;
      } catch (e) {
        errors++;
      }
    }));
    if (i % 100 === 0) console.log(`  ${i}/${wallets.length}...`);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone — Rebuilt: ${rebuilt}, Skipped: ${skipped}, Errors: ${errors}`);

  const { rows: stats } = await pool.query(`
    SELECT (rugger_playbook->>'recommended_strategy') as strategy, COUNT(*) as count
    FROM wallet_profiles WHERE rugger_playbook IS NOT NULL
    GROUP BY (rugger_playbook->>'recommended_strategy') ORDER BY count DESC
  `);
  console.log('\nDistribution stratégies:');
  stats.forEach((r: any) => console.log(`  ${r.strategy}: ${r.count}`));

  const { rows: fallback } = await pool.query(`
    SELECT COUNT(*) as cnt FROM wallet_profiles 
    WHERE (rugger_playbook->>'avg_pump_multiple')::float = 3.0
  `);
  console.log(`\nFallback pump=3.0 restants: ${fallback[0].cnt}`);

  await pool.end();
}

main().catch(console.error);
