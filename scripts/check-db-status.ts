#!/usr/bin/env tsx
/**
 * Quick check of current database schema status
 */

import { getDb } from '../src/db/connection.js';
import { logger } from '../src/utils/logger.js';

async function checkDatabaseStatus(): Promise<void> {
  const pool = await getDb();

  try {
    console.log('\n📊 Database Schema Status Check\n');
    console.log('='.repeat(70));

    // Check tables
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    const tableNames = tables.rows.map(r => r.table_name);
    const expectedTables = [
      'calibration_log',
      'cartel_groups',
      'monitoring_queue',
      'taint_log',
      'token_events',
      'token_snapshots',
      'wallet_ancestry',
      'wallet_profiles'
    ];

    console.log('\n📋 Tables Found: ' + tableNames.length);
    console.log('-'.repeat(70));

    let allTablesPresent = true;
    for (const table of expectedTables) {
      const present = tableNames.includes(table);
      const icon = present ? '✅' : '❌';
      console.log(`  ${icon} ${table}`);
      if (!present) allTablesPresent = false;
    }

    // Check wallet_profiles columns
    console.log('\n📝 wallet_profiles Playbook Columns:');
    console.log('-'.repeat(70));

    const profileCols = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'wallet_profiles'
        AND column_name IN ('rugger_playbook', 'playbook_confidence', 'playbook_updated_at')
      ORDER BY column_name
    `);

    const expectedProfileCols = ['playbook_confidence', 'playbook_updated_at', 'rugger_playbook'];
    let allColsPresent = profileCols.rows.length === 3;

    for (const col of expectedProfileCols) {
      const found = profileCols.rows.find(r => r.column_name === col);
      const icon = found ? '✅' : '❌';
      const type = found ? ` (${found.data_type})` : '';
      console.log(`  ${icon} ${col}${type}`);
      if (!found) allColsPresent = false;
    }

    // Check token_snapshots structure
    if (tableNames.includes('token_snapshots')) {
      console.log('\n📸 token_snapshots Columns:');
      console.log('-'.repeat(70));

      const snapshotCols = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'token_snapshots'
        ORDER BY ordinal_position
      `);

      for (const col of snapshotCols.rows) {
        console.log(`  ✅ ${col.column_name} (${col.data_type})`);
      }
    }

    // Row counts
    console.log('\n📈 Data Summary:');
    console.log('-'.repeat(70));

    if (tableNames.includes('token_events')) {
      const tokens = await pool.query('SELECT COUNT(*) FROM token_events');
      console.log(`  Tokens: ${tokens.rows[0].count}`);
    }

    if (tableNames.includes('token_snapshots')) {
      const snapshots = await pool.query('SELECT COUNT(*) FROM token_snapshots');
      console.log(`  Snapshots: ${snapshots.rows[0].count}`);
    }

    if (tableNames.includes('wallet_profiles')) {
      const wallets = await pool.query('SELECT COUNT(*) FROM wallet_profiles');
      const playbooks = await pool.query('SELECT COUNT(*) FROM wallet_profiles WHERE rugger_playbook IS NOT NULL');
      console.log(`  Wallets: ${wallets.rows[0].count}`);
      console.log(`  Playbooks: ${playbooks.rows[0].count}`);
    }

    // Final verdict
    console.log('\n' + '='.repeat(70));
    if (allTablesPresent && allColsPresent) {
      console.log('✅✅✅ SCHEMA IS COMPLETE - v4.0 READY! ✅✅✅');
      console.log('\nYour database has all required tables and columns.');
      console.log('You can proceed with running the application.');
    } else {
      console.log('⚠️  SCHEMA INCOMPLETE - MIGRATION REQUIRED');
      console.log('\nMissing elements detected. Run migration:');
      console.log('  npm run build');
      console.log('  # Then on VPS/production:');
      console.log('  bash scripts/migrate-to-v4.sh');
      console.log('\nOr for fresh install:');
      console.log('  psql $DATABASE_URL -f src/db/schema.sql');
    }
    console.log('='.repeat(70));
    console.log('');

  } catch (error) {
    logger.error({ error }, 'Failed to check database status');
    console.error('\n❌ Error checking database:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

checkDatabaseStatus().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
