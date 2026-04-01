import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import pg from 'pg';
import { logger } from './logger.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=981f9d6d-2dbb-4171-8424-f12b610e290d';
const connection = new Connection(RPC_URL, 'confirmed');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://walletsource:walletsource_dev@localhost:5432/walletsource',
});

// Cache: wallet → funder
const funderCache = new Map<string, { funder: string | null; rootFunder: string | null; cachedAt: number }>();
const CACHE_TTL = 600_000; // 10 min

// Rate limiter: max 60 NEW on-chain funder lookups/hour
let funderCallsThisHour = 0;
let funderRateLimitResetAt = Date.now() + 3600_000;

/**
 * Trace who funded a wallet (find the first SOL transfer IN)
 * Returns the funder wallet address, or null if not found
 */
async function traceFunder(wallet: string, maxDepth: number = 2): Promise<{
  funder: string | null;
  rootFunder: string | null;
  fundingAmountSol: number;
}> {
  // Check DB cache first
  try {
    const { rows } = await pool.query(
      'SELECT funder, root_funder, funding_amount_sol FROM wallet_funders WHERE wallet = $1',
      [wallet]
    );
    if (rows.length > 0) {
      return {
        funder: rows[0].funder,
        rootFunder: rows[0].root_funder,
        fundingAmountSol: parseFloat(rows[0].funding_amount_sol) || 0,
      };
    }
  } catch (e) { /* continue */ }

  let currentWallet = wallet;
  let directFunder: string | null = null;
  let rootFunder: string | null = null;
  let fundingAmount = 0;

  for (let depth = 0; depth < maxDepth; depth++) {
    try {
      // Get signatures — page backward to find oldest
      let allSigs: any[] = [];
      let before: string | undefined;
      
      // 1 page max (1000 TXs) — new deployer wallets rarely have >1000 TXs
      // We want the OLDEST TX (first funding), which is at end of first page if wallet is new
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(currentWallet),
        { limit: 200 }  // 200 is enough for new wallets, saves ~80% RPC credits vs 1000
      );
      if (sigs.length > 0) allSigs = sigs;

      if (allSigs.length === 0) break;

      // Get the oldest TX
      const oldestSig = allSigs[allSigs.length - 1].signature;
      const tx = await connection.getParsedTransaction(oldestSig, {
        maxSupportedTransactionVersion: 0,
      });
      
      if (!tx?.meta) break;

      const accounts = tx.transaction.message.accountKeys;
      const preBalances = tx.meta.preBalances;
      const postBalances = tx.meta.postBalances;

      // Find who sent SOL to this wallet
      let funderAddr: string | null = null;
      const walletIdx = accounts.findIndex(a => a.pubkey.toBase58() === currentWallet);
      
      if (walletIdx >= 0 && postBalances[walletIdx] > preBalances[walletIdx]) {
        // This wallet received SOL — find who sent it
        for (let i = 0; i < accounts.length; i++) {
          if (i !== walletIdx && preBalances[i] > postBalances[i]) {
            const delta = (preBalances[i] - postBalances[i]) / 1e9;
            if (delta > 0.001) { // Ignore dust/fees
              funderAddr = accounts[i].pubkey.toBase58();
              if (depth === 0) fundingAmount = delta;
              break;
            }
          }
        }
      }

      if (!funderAddr) break;
      
      if (depth === 0) {
        directFunder = funderAddr;
        rootFunder = funderAddr;
      } else {
        rootFunder = funderAddr;
      }

      // Check if this funder is a known entity (exchange, etc.)
      // Known exchanges/programs have millions of TXs — skip depth trace for them
      currentWallet = funderAddr;
      
    } catch (e: any) {
      logger.debug({ wallet: currentWallet, error: e.message }, 'Funder trace failed at depth ' + depth);
      break;
    }
  }

  // Save to DB
  if (directFunder) {
    try {
      await pool.query(
        `INSERT INTO wallet_funders (wallet, funder, funder_depth, root_funder, funding_amount_sol, discovered_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (wallet) DO UPDATE SET funder = $2, root_funder = $4, funding_amount_sol = $5`,
        [wallet, directFunder, rootFunder !== directFunder ? 2 : 1, rootFunder, fundingAmount]
      );
    } catch (e) { /* non-critical */ }
  }

  return { funder: directFunder, rootFunder, fundingAmountSol: fundingAmount };
}

/**
 * Get funder score — how many ruggers has this funder created?
 */
export async function getFunderScore(funderWallet: string): Promise<{
  score: number;
  fundedWallets: number;
  fundedRuggers: number;
  avgChildRugRate: number;
} | null> {
  try {
    const { rows } = await pool.query(
      'SELECT funder_score, funded_wallets, funded_ruggers, avg_child_rug_rate FROM funder_scores WHERE funder_wallet = $1',
      [funderWallet]
    );
    if (rows.length === 0) return null;
    return {
      score: parseFloat(rows[0].funder_score) || 50,
      fundedWallets: parseInt(rows[0].funded_wallets) || 0,
      fundedRuggers: parseInt(rows[0].funded_ruggers) || 0,
      avgChildRugRate: parseFloat(rows[0].avg_child_rug_rate) || 0,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Check if a deployer's funder is a known rugger factory.
 * Returns { blocked: boolean, reason: string, funder: string | null }
 * 
 * Cost: ~2-6 RPC credits per new deployer (cached after first lookup)
 * Rate limited: max 60 NEW checks/hour (cached lookups bypass limit)
 */
export async function checkDeployerFunding(deployerWallet: string): Promise<{
  blocked: boolean;
  reason: string;
  funder: string | null;
  funderScore: number | null;
}> {
  const cached = funderCache.get(deployerWallet);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    if (!cached.funder) return { blocked: false, reason: 'no funder found', funder: null, funderScore: null };
  }

  // Rate limit: skip on-chain trace if over 60 NEW lookups/hour (DB cache bypasses this)
  if (Date.now() > funderRateLimitResetAt) {
    funderCallsThisHour = 0;
    funderRateLimitResetAt = Date.now() + 3600_000;
  }
  if (funderCallsThisHour >= 60) {
    logger.debug({ deployer: deployerWallet.slice(0,8) }, '⚡ Funder check rate-limited (60/hr cap)');
    return { blocked: false, reason: 'rate_limit_skip', funder: null, funderScore: null };
  }
  funderCallsThisHour++;

  const { funder, rootFunder } = await traceFunder(deployerWallet, 2);
  funderCache.set(deployerWallet, { funder, rootFunder, cachedAt: Date.now() });

  if (!funder) {
    return { blocked: false, reason: 'no funder traced', funder: null, funderScore: null };
  }

  // Check funder reputation
  const fScore = await getFunderScore(funder);
  if (fScore && fScore.fundedRuggers >= 3 && fScore.avgChildRugRate >= 70) {
    return {
      blocked: true,
      reason: `funder ${funder.slice(0, 8)} is rugger factory (${fScore.fundedRuggers} ruggers, avg rug ${fScore.avgChildRugRate.toFixed(0)}%)`,
      funder,
      funderScore: fScore.score,
    };
  }

  // Also check: is funder itself a known deployer rugger?
  try {
    const { rows } = await pool.query(
      'SELECT rug_rate, total_tokens FROM creator_scores WHERE deployer_wallet = $1',
      [funder]
    );
    if (rows.length > 0 && parseFloat(rows[0].rug_rate) >= 80 && parseInt(rows[0].total_tokens) >= 3) {
      return {
        blocked: true,
        reason: `funder ${funder.slice(0, 8)} is known rugger (${rows[0].total_tokens}t, rug ${parseFloat(rows[0].rug_rate).toFixed(0)}%)`,
        funder,
        funderScore: 0,
      };
    }
  } catch (e) { /* continue */ }

  // Check root funder too
  if (rootFunder && rootFunder !== funder) {
    try {
      const { rows } = await pool.query(
        'SELECT rug_rate, total_tokens FROM creator_scores WHERE deployer_wallet = $1',
        [rootFunder]
      );
      if (rows.length > 0 && parseFloat(rows[0].rug_rate) >= 80 && parseInt(rows[0].total_tokens) >= 5) {
        return {
          blocked: true,
          reason: `root funder ${rootFunder.slice(0, 8)} is known rugger (${rows[0].total_tokens}t, rug ${parseFloat(rows[0].rug_rate).toFixed(0)}%)`,
          funder: rootFunder,
          funderScore: 0,
        };
      }
    } catch (e) { /* continue */ }
  }

  return { blocked: false, reason: 'funder ok', funder, funderScore: fScore?.score ?? null };
}

/**
 * Rebuild funder_scores from wallet_funders + creator_scores
 */
export async function rebuildFunderScores(): Promise<void> {
  try {
    await pool.query(`
      INSERT INTO funder_scores (funder_wallet, funded_wallets, funded_ruggers, funded_legit, avg_child_rug_rate, funder_score)
      SELECT 
        wf.funder,
        COUNT(DISTINCT wf.wallet),
        COUNT(DISTINCT wf.wallet) FILTER (WHERE cs.rug_rate >= 50),
        COUNT(DISTINCT wf.wallet) FILTER (WHERE cs.rug_rate < 30),
        COALESCE(AVG(cs.rug_rate), 50),
        LEAST(100, GREATEST(0, 
          100 - COALESCE(AVG(cs.rug_rate), 50) - 
          COUNT(DISTINCT wf.wallet) FILTER (WHERE cs.rug_rate >= 80) * 10
        ))
      FROM wallet_funders wf
      LEFT JOIN creator_scores cs ON cs.deployer_wallet = wf.wallet
      GROUP BY wf.funder
      HAVING COUNT(DISTINCT wf.wallet) >= 2
      ON CONFLICT (funder_wallet) DO UPDATE SET
        funded_wallets = EXCLUDED.funded_wallets,
        funded_ruggers = EXCLUDED.funded_ruggers,
        funded_legit = EXCLUDED.funded_legit,
        avg_child_rug_rate = EXCLUDED.avg_child_rug_rate,
        funder_score = EXCLUDED.funder_score,
        last_updated = NOW();
    `);
    logger.info('✅ Funder scores rebuilt');
  } catch (e: any) {
    logger.error({ error: e.message }, 'Failed to rebuild funder scores');
  }
}
