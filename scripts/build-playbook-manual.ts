#!/usr/bin/env tsx
/**
 * Manually build playbook for a wallet with 3+ RUGs
 */

import { getDb } from '../src/db/connection.js';
import { PlaybookBuilder } from '../src/scoring/PlaybookBuilder.js';
import { logger } from '../src/utils/logger.js';

async function buildPlaybookForWallet(walletAddress: string): Promise<void> {
  const pool = await getDb();
  const playbookBuilder = new PlaybookBuilder(pool);

  try {
    logger.info({ wallet: walletAddress }, 'Building playbook manually...');
    await playbookBuilder.buildPlaybook(walletAddress);
    logger.info({ wallet: walletAddress }, 'Playbook built successfully!');

    // Show playbook
    const result = await pool.query(
      `SELECT
        wallet_address,
        rugger_playbook,
        playbook_confidence,
        playbook_updated_at
       FROM wallet_profiles
       WHERE wallet_address = $1`,
      [walletAddress]
    );

    if (result.rows.length > 0) {
      console.log('\n✅ Playbook built:');
      console.log(JSON.stringify(result.rows[0].rugger_playbook, null, 2));
      console.log(`\nConfidence: ${result.rows[0].playbook_confidence}`);
    }
  } catch (error) {
    logger.error({ error, wallet: walletAddress }, 'Failed to build playbook');
    throw error;
  } finally {
    await pool.end();
  }
}

// Build for the wallet with 5 RUGs (AVOID strategy expected)
buildPlaybookForWallet('EHe3TnyDNDLioGa6J5ZH2mztvaNduaAr66VJTD1AE35Z')
  .catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  });
