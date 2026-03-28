#!/usr/bin/env node
/**
 * Fund Watcher — détecte les fonds et bascule en live automatiquement
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH  = path.join(__dirname, '../.env');
const HELIUS_KEY = process.env.HELIUS_API_KEY || '981f9d6d-2dbb-4171-8424-f12b610e290d';
const RPC_URL   = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const MIN_SOL   = parseFloat(process.env.MIN_FUNDING_SOL || '0.5');

function getEnv() { return fs.readFileSync(ENV_PATH, 'utf8'); }

function getWalletAddress() {
  const match = getEnv().match(/TRADING_WALLET_ADDRESS=([^\n]+)/);
  return match ? match[1].trim() : null;
}

async function getBalance(address) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] })
  });
  const data = await res.json();
  return (data?.result?.value ?? 0) / 1e9;
}

function isDryRun() { return getEnv().includes('DRY_RUN=true'); }

function setLiveMode() {
  fs.writeFileSync(ENV_PATH, getEnv().replace('DRY_RUN=true', 'DRY_RUN=false'));
  console.log('✅ DRY_RUN=false');
}

async function main() {
  const address = getWalletAddress();
  if (!address) { console.error('❌ TRADING_WALLET_ADDRESS manquant dans .env'); process.exit(1); }

  console.log(`👀 Fund Watcher actif`);
  console.log(`   Wallet : ${address}`);
  console.log(`   Seuil  : ≥ ${MIN_SOL} SOL pour démarrer`);
  console.log(`   Polling: toutes les 2 minutes\n`);

  let lastBalance = -1;

  const check = async () => {
    try {
      const balance = await getBalance(address);

      if (Math.abs(balance - lastBalance) > 0.0001) {
        console.log(`[${new Date().toISOString()}] Balance: ${balance.toFixed(6)} SOL`);
        lastBalance = balance;
      }

      if (balance >= MIN_SOL && isDryRun()) {
        console.log(`\n🚀 FONDS DÉTECTÉS — ${balance.toFixed(4)} SOL`);
        console.log('   Passage en mode LIVE...');
        setLiveMode();
        console.log('   Redémarrage sécurisé...');
        execSync('bash /root/walletsource-db/scripts/safe-restart.sh --force', { stdio: 'inherit' });
        console.log('\n✅ Bot live — STD (3 slots) + NEO (1) + SWARM (2)');
        process.exit(0);
      }
    } catch(e) {
      console.error(`[${new Date().toISOString()}] Erreur: ${e.message}`);
    }
  };

  await check();
  setInterval(check, 2 * 60 * 1000);
}

main();
