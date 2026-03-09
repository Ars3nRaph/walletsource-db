import { PlaybookBuilder } from '../dist/src/scoring/PlaybookBuilder.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(
  `SELECT wallet_address FROM wallet_profiles WHERE rug_count >= 3 ORDER BY rug_count DESC`
);

const builder = new PlaybookBuilder(pool);
let ok = 0, skipped = 0, errors = 0;
const total = rows.length;

console.log(`🔧 Rebuilding ${total} playbooks...`);

for (const row of rows) {
  try {
    const pb = await builder.buildPlaybook(row.wallet_address);
    if (pb) ok++; else skipped++;
  } catch (e) {
    errors++;
  }
  if ((ok + skipped + errors) % 100 === 0) {
    console.log(`  ${ok + skipped + errors}/${total} | ✅ ${ok}  ⏭️  ${skipped}  ❌ ${errors}`);
  }
}

console.log(`\n✅ Done. ok=${ok} skipped=${skipped} errors=${errors}`);
await pool.end();
