import pg from 'pg';
import { Connection, PublicKey } from '@solana/web3.js';

const pool = new pg.Pool({ connectionString: 'postgresql://walletsource:walletsource_dev@localhost:5432/walletsource' });
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=981f9d6d-2dbb-4171-8424-f12b610e290d';
const conn = new Connection(RPC_URL, 'confirmed');

async function traceFunder(wallet: string): Promise<{ funder: string | null; amount: number }> {
  try {
    let before: string | undefined;
    let lastSigs: any[] = [];
    
    for (let page = 0; page < 10; page++) {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(wallet), { limit: 1000, before });
      if (sigs.length === 0) break;
      lastSigs = sigs;
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
    }
    
    if (lastSigs.length === 0) return { funder: null, amount: 0 };
    
    const tx = await conn.getParsedTransaction(lastSigs[lastSigs.length - 1].signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return { funder: null, amount: 0 };
    
    const accounts = tx.transaction.message.accountKeys;
    const pre = tx.meta.preBalances;
    const post = tx.meta.postBalances;
    const walletIdx = accounts.findIndex(a => a.pubkey.toBase58() === wallet);
    
    if (walletIdx >= 0 && post[walletIdx] > pre[walletIdx]) {
      for (let i = 0; i < accounts.length; i++) {
        if (i !== walletIdx && pre[i] > post[i]) {
          const delta = (pre[i] - post[i]) / 1e9;
          if (delta > 0.001) {
            return { funder: accounts[i].pubkey.toBase58(), amount: delta };
          }
        }
      }
    }
  } catch (e: any) {
    console.log(`  Error tracing ${wallet.slice(0,8)}: ${e.message}`);
  }
  return { funder: null, amount: 0 };
}

async function main() {
  // Get top 100 ruggers (rug_rate >= 80%, 3+ tokens)
  const { rows } = await pool.query(`
    SELECT deployer_wallet, total_tokens, rug_rate 
    FROM creator_scores 
    WHERE rug_rate >= 80 AND total_tokens >= 3
    ORDER BY total_tokens DESC LIMIT 100
  `);
  
  console.log(`Tracing funders for ${rows.length} ruggers...`);
  let traced = 0;
  
  for (const row of rows) {
    const wallet = row.deployer_wallet;
    
    // Skip if already traced
    const existing = await pool.query('SELECT 1 FROM wallet_funders WHERE wallet = $1', [wallet]);
    if (existing.rows.length > 0) { traced++; continue; }
    
    const { funder, amount } = await traceFunder(wallet);
    if (funder) {
      await pool.query(
        `INSERT INTO wallet_funders (wallet, funder, funding_amount_sol) VALUES ($1, $2, $3)
         ON CONFLICT (wallet) DO UPDATE SET funder = $2, funding_amount_sol = $3`,
        [wallet, funder, amount]
      );
      traced++;
      console.log(`✅ ${wallet.slice(0,8)} ← funded by ${funder.slice(0,8)} (${amount.toFixed(2)} SOL) [${row.total_tokens}t, rug ${row.rug_rate}%]`);
    } else {
      console.log(`❌ ${wallet.slice(0,8)} — no funder found`);
    }
    
    // Rate limit: 200ms between traces
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Rebuild funder scores
  await pool.query(`
    INSERT INTO funder_scores (funder_wallet, funded_wallets, funded_ruggers, funded_legit, avg_child_rug_rate, funder_score)
    SELECT 
      wf.funder, COUNT(DISTINCT wf.wallet),
      COUNT(DISTINCT wf.wallet) FILTER (WHERE cs.rug_rate >= 50),
      COUNT(DISTINCT wf.wallet) FILTER (WHERE cs.rug_rate < 30),
      COALESCE(AVG(cs.rug_rate), 50),
      LEAST(100, GREATEST(0, 100 - COALESCE(AVG(cs.rug_rate), 50) - COUNT(DISTINCT wf.wallet) FILTER (WHERE cs.rug_rate >= 80) * 10))
    FROM wallet_funders wf
    LEFT JOIN creator_scores cs ON cs.deployer_wallet = wf.wallet
    GROUP BY wf.funder HAVING COUNT(DISTINCT wf.wallet) >= 2
    ON CONFLICT (funder_wallet) DO UPDATE SET
      funded_wallets=EXCLUDED.funded_wallets, funded_ruggers=EXCLUDED.funded_ruggers,
      funded_legit=EXCLUDED.funded_legit, avg_child_rug_rate=EXCLUDED.avg_child_rug_rate,
      funder_score=EXCLUDED.funder_score, last_updated=NOW();
  `);
  
  const { rows: stats } = await pool.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE funder_score < 20) as bad FROM funder_scores');
  console.log(`\n📊 Funder scores: ${stats[0].total} total, ${stats[0].bad} bad (score < 20)`);
  
  await pool.end();
}

main().catch(console.error);
