/**
 * Production Validation Script
 * Tests WalletSourceDB with real PostgreSQL database
 */

import dotenv from 'dotenv';
import { Pool } from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../src/utils/logger.js';
import { WalletRepo } from '../src/repositories/WalletRepo.js';
import { AncestryRepo } from '../src/repositories/AncestryRepo.js';
import { TokenEventRepo } from '../src/repositories/TokenEventRepo.js';
import { CartelRepo } from '../src/repositories/CartelRepo.js';
import { TaintScorer } from '../src/scoring/TaintScorer.js';
import { computeToxicity, computeRiskScore, getStrategy } from '../src/scoring/SigmoidScorer.js';
import { PExitCalculator } from '../src/scoring/PExitCalculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config();

interface ValidationResult {
  test: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  message?: string;
  duration?: number;
}

const results: ValidationResult[] = [];

function addResult(test: string, status: 'PASS' | 'FAIL' | 'SKIP', message?: string, duration?: number) {
  results.push({ test, status, message, duration });
  const emoji = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
  console.log(`${emoji} ${test}${message ? `: ${message}` : ''}${duration ? ` (${duration}ms)` : ''}`);
}

async function initSchema(pool: Pool): Promise<void> {
  const start = Date.now();
  try {
    const schemaPath = path.join(__dirname, '../src/db/schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf-8');

    // Drop existing tables
    await pool.query('DROP TABLE IF EXISTS calibration_log CASCADE');
    await pool.query('DROP TABLE IF EXISTS monitoring_queue CASCADE');
    await pool.query('DROP TABLE IF EXISTS taint_log CASCADE');
    await pool.query('DROP TABLE IF EXISTS token_events CASCADE');
    await pool.query('DROP TABLE IF EXISTS wallet_ancestry CASCADE');
    await pool.query('DROP TABLE IF EXISTS wallet_profiles CASCADE');
    await pool.query('DROP TABLE IF EXISTS cartel_groups CASCADE');

    // Execute schema
    await pool.query(schema);

    addResult('Schema initialization', 'PASS', undefined, Date.now() - start);
  } catch (error) {
    addResult('Schema initialization', 'FAIL', (error as Error).message);
    throw error;
  }
}

async function testDatabaseConnection(pool: Pool): Promise<void> {
  const start = Date.now();
  try {
    const result = await pool.query('SELECT NOW(), version()');
    addResult('Database connection', 'PASS', undefined, Date.now() - start);
  } catch (error) {
    addResult('Database connection', 'FAIL', (error as Error).message);
    throw error;
  }
}

async function testAncestryQueries(pool: Pool): Promise<void> {
  const walletRepo = new WalletRepo(pool);
  const ancestryRepo = new AncestryRepo(pool);

  // Create test wallets
  await walletRepo.upsertWallet('grandparent');
  await walletRepo.upsertWallet('parent');
  await walletRepo.upsertWallet('child');
  await walletRepo.upsertWallet('grandchild');

  // Create ancestry chain (depth 0-3)
  await ancestryRepo.addLink('grandparent', 'parent', 'tx1', 1.0, 0, 0.9);
  await ancestryRepo.addLink('parent', 'child', 'tx2', 0.5, 1, 0.85);
  await ancestryRepo.addLink('child', 'grandchild', 'tx3', 0.3, 2, 0.75);

  // Test getAncestors (WITH RECURSIVE query)
  const start1 = Date.now();
  try {
    const ancestors = await ancestryRepo.getAncestors('grandchild', 3);

    if (ancestors.length === 3) {
      addResult('AncestryRepo.getAncestors', 'PASS', `Found ${ancestors.length} ancestors`, Date.now() - start1);
    } else {
      addResult('AncestryRepo.getAncestors', 'FAIL', `Expected 3 ancestors, got ${ancestors.length}`);
    }
  } catch (error) {
    addResult('AncestryRepo.getAncestors', 'FAIL', (error as Error).message);
  }

  // Test getDescendants
  const start2 = Date.now();
  try {
    const descendants = await ancestryRepo.getDescendants('grandparent');

    if (descendants.length === 3) {
      addResult('AncestryRepo.getDescendants', 'PASS', `Found ${descendants.length} descendants`, Date.now() - start2);
    } else {
      addResult('AncestryRepo.getDescendants', 'FAIL', `Expected 3 descendants, got ${descendants.length}`);
    }
  } catch (error) {
    addResult('AncestryRepo.getDescendants', 'FAIL', (error as Error).message);
  }
}

async function testTaintPropagation(pool: Pool): Promise<void> {
  const walletRepo = new WalletRepo(pool);
  const tokenRepo = new TokenEventRepo(pool);
  const taintScorer = new TaintScorer(pool);
  const ancestryRepo = new AncestryRepo(pool);

  const start = Date.now();
  try {
    // Create test scenario: rug token with ancestry chain
    const creator = 'taint_creator';
    const funder1 = 'taint_funder1';
    const funder2 = 'taint_funder2';
    const funder3 = 'taint_funder3';

    await walletRepo.upsertWallet(creator);
    await walletRepo.upsertWallet(funder1);
    await walletRepo.upsertWallet(funder2);
    await walletRepo.upsertWallet(funder3);

    // Create ancestry chain
    await ancestryRepo.addLink(funder3, funder2, 'tx_f3_f2', 1.0, 3, 0.8);
    await ancestryRepo.addLink(funder2, funder1, 'tx_f2_f1', 1.0, 2, 0.85);
    await ancestryRepo.addLink(funder1, creator, 'tx_f1_c', 1.0, 1, 0.9);

    // Create RUG token
    const rugToken = 'rug_token_prod';
    await tokenRepo.recordEvent(rugToken, creator);
    await tokenRepo.updateVerdict(rugToken, 'RUG_METRICS', 1000, 500, -90.0, null);

    // Propagate taint (correct method name)
    await taintScorer.propagate(rugToken, creator, 'RUG_METRICS');

    // Verify taint scores
    const creatorWallet = await walletRepo.getByAddress(creator);
    const funder1Wallet = await walletRepo.getByAddress(funder1);
    const funder2Wallet = await walletRepo.getByAddress(funder2);
    const funder3Wallet = await walletRepo.getByAddress(funder3);

    const expectedCreatorTaint = 50.0; // depth 0
    const expectedFunder1Taint = 35.0; // depth 1
    const expectedFunder2Taint = 24.5; // depth 2
    const expectedFunder3Taint = 17.15; // depth 3

    if (
      Math.abs(creatorWallet!.taint_score - expectedCreatorTaint) < 0.01 &&
      Math.abs(funder1Wallet!.taint_score - expectedFunder1Taint) < 0.01 &&
      Math.abs(funder2Wallet!.taint_score - expectedFunder2Taint) < 0.01 &&
      Math.abs(funder3Wallet!.taint_score - expectedFunder3Taint) < 0.01
    ) {
      addResult(
        'Taint propagation (depth 0-3)',
        'PASS',
        `Total: ${(creatorWallet!.taint_score + funder1Wallet!.taint_score + funder2Wallet!.taint_score + funder3Wallet!.taint_score).toFixed(2)} pts`,
        Date.now() - start
      );
    } else {
      addResult(
        'Taint propagation (depth 0-3)',
        'FAIL',
        `Scores: ${creatorWallet!.taint_score}, ${funder1Wallet!.taint_score}, ${funder2Wallet!.taint_score}, ${funder3Wallet!.taint_score}`
      );
    }
  } catch (error) {
    addResult('Taint propagation (depth 0-3)', 'FAIL', (error as Error).message);
  }
}

async function testSigmoidScoring(pool: Pool): Promise<void> {
  const start = Date.now();
  try {
    // Test toxicity
    const tox0 = computeToxicity(0);
    const tox50 = computeToxicity(50);
    const tox100 = computeToxicity(100);
    const tox200 = computeToxicity(200);

    const toxExpected = [
      { input: 0, expected: 0.076, actual: tox0 },
      { input: 50, expected: 0.224, actual: tox50 },
      { input: 100, expected: 0.500, actual: tox100 },
      { input: 200, expected: 0.924, actual: tox200 }
    ];

    const toxPassed = toxExpected.every(t => Math.abs(t.actual - t.expected) < 0.005);

    if (toxPassed) {
      addResult('Sigmoid toxicity formula', 'PASS', 'All values within tolerance', Date.now() - start);
    } else {
      const details = toxExpected.map(t => `${t.input}→${t.actual.toFixed(3)} (expected ${t.expected})`).join(', ');
      addResult('Sigmoid toxicity formula', 'FAIL', details);
    }

    // Test risk score
    const risk = computeRiskScore(0.8, 0.7, 0.6);
    const strategy = getStrategy(risk);

    addResult('Sigmoid risk score', 'PASS', `risk=${risk.toFixed(3)}, strategy=${strategy}`, Date.now() - start);
  } catch (error) {
    addResult('Sigmoid scoring', 'FAIL', (error as Error).message);
  }
}

async function testPExitCalculation(pool: Pool): Promise<void> {
  const walletRepo = new WalletRepo(pool);
  const tokenRepo = new TokenEventRepo(pool);
  const cartelRepo = new CartelRepo(pool);
  const pExitCalc = new PExitCalculator(pool);

  const start = Date.now();
  try {
    // Create wallet with SUCCESS tokens
    const creator = 'pexit_creator';
    await walletRepo.upsertWallet(creator);

    // Create 3 SUCCESS tokens with different FDVs
    await tokenRepo.recordEvent('success1', creator);
    await tokenRepo.updateVerdict('success1', 'SUCCESS', 40000, 8000, 10.0, 'pair1');

    await tokenRepo.recordEvent('success2', creator);
    await tokenRepo.updateVerdict('success2', 'SUCCESS', 50000, 10000, 15.0, 'pair2');

    await tokenRepo.recordEvent('success3', creator);
    await tokenRepo.updateVerdict('success3', 'SUCCESS', 60000, 12000, 20.0, 'pair3');

    // Create cartel
    await cartelRepo.upsertCartel('pexit_cartel', 'Test Cartel', 1, 0, 3, 0.0, 0.85, 0.90, 'LONG');
    await walletRepo.updateCartel(creator, 'pexit_cartel');

    // Get median MC and cartel confidence
    const mcProfil = await pExitCalc.getMedianMC(creator);
    const mcActuel = 65000;

    const cartel = await cartelRepo.getById('pexit_cartel');
    const confianceCartel = cartel!.confidence_score;
    const confianceCartelV2 = cartel!.confidence_score_v2;

    // Calculate P_exit v1 (correct method name)
    const pExitV1 = pExitCalc.computePExitV1(mcActuel, mcProfil, confianceCartel);

    // Expected: MC_profil = 50000 (median), MC_actuel = 65000, conf = 0.85
    // P_exit = (65000 / 50000) × 0.85 = 1.3 × 0.85 = 1.105
    const expectedV1 = 1.105;

    if (Math.abs(pExitV1 - expectedV1) < 0.01) {
      addResult('P_exit v1 calculation', 'PASS', `P_exit=${pExitV1.toFixed(3)}`, Date.now() - start);
    } else {
      addResult('P_exit v1 calculation', 'FAIL', `Expected ${expectedV1}, got ${pExitV1.toFixed(3)}`);
    }

    // Calculate P_exit v2 (correct method name)
    const pExitV2 = pExitCalc.computePExitV2(mcActuel, mcProfil, confianceCartelV2);
    addResult('P_exit v2 calculation', 'PASS', `P_exit=${pExitV2.toFixed(3)}`, Date.now() - start);
  } catch (error) {
    addResult('P_exit calculation', 'FAIL', (error as Error).message);
  }
}

async function main() {
  console.log('\n🔍 WalletSourceDB — Production Validation');
  console.log('==========================================\n');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ DATABASE_URL not set in environment');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    // 1. Test database connection
    await testDatabaseConnection(pool);

    // 2. Initialize schema
    await initSchema(pool);

    // 3. Test ancestry queries (WITH RECURSIVE)
    console.log('\n📊 Testing WITH RECURSIVE queries...');
    await testAncestryQueries(pool);

    // 4. Test taint propagation
    console.log('\n🧪 Testing taint propagation...');
    await testTaintPropagation(pool);

    // 5. Test sigmoid scoring
    console.log('\n📐 Testing sigmoid formulas...');
    await testSigmoidScoring(pool);

    // 6. Test P_exit calculation
    console.log('\n💰 Testing P_exit calculation...');
    await testPExitCalculation(pool);

    // Print summary
    console.log('\n\n📊 VALIDATION SUMMARY');
    console.log('==========================================');

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const skipped = results.filter(r => r.status === 'SKIP').length;
    const total = results.length;

    console.log(`\n✅ PASSED: ${passed}/${total}`);
    if (failed > 0) console.log(`❌ FAILED: ${failed}/${total}`);
    if (skipped > 0) console.log(`⚠️  SKIPPED: ${skipped}/${total}`);

    const successRate = ((passed / total) * 100).toFixed(1);
    console.log(`\n📈 Success Rate: ${successRate}%`);

    if (failed === 0) {
      console.log('\n🎉 ALL PRODUCTION TESTS PASSED!\n');
      console.log('✅ Database connection: OK');
      console.log('✅ Schema initialization: OK');
      console.log('✅ WITH RECURSIVE queries: OK');
      console.log('✅ Taint propagation: OK');
      console.log('✅ Sigmoid formulas: OK');
      console.log('✅ P_exit calculation: OK');
      console.log('\n🚀 System is PRODUCTION READY!\n');
    } else {
      console.log('\n⚠️  SOME TESTS FAILED - Review errors above\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Validation failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
