import { Connection, PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h cache
const LOOKUP_TIMEOUT_MS = 5000; // 5s max per lookup
const MAX_SIGS = 20; // Only scan last 20 txs
const MIN_FUNDING_SOL = 0.01;

interface FunderResult {
  funder: string;
  amountSol: number;
  confidence: number;
}

/**
 * RPC-based funder lookup — replaces Helius API for wallet ancestry.
 * Uses standard Solana RPC (getSignaturesForAddress + getParsedTransaction).
 * Fast enough for OBSERVE phase (~1-2s).
 */
export class FunderLookup {
  private connection: Connection;
  private cache = new Map<string, { result: FunderResult | null; ts: number }>();
  private inflight = new Map<string, Promise<FunderResult | null>>();

  constructor(rpcUrl?: string) {
    this.connection = new Connection(
      rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      { commitment: 'confirmed' }
    );
  }

  /**
   * Find the primary funder of a wallet (largest SOL transfer IN).
   * Returns cached result if available. Non-blocking — returns null on timeout/error.
   */
  async getFunder(walletAddress: string): Promise<FunderResult | null> {
    const cached = this.cache.get(walletAddress);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.result;
    }

    const existing = this.inflight.get(walletAddress);
    if (existing) return existing;

    const promise = this._lookup(walletAddress);
    this.inflight.set(walletAddress, promise);

    try {
      const result = await promise;
      this.cache.set(walletAddress, { result, ts: Date.now() });
      return result;
    } finally {
      this.inflight.delete(walletAddress);
    }
  }

  /** Prefetch funder during OBSERVE phase (fire-and-forget). */
  prefetch(walletAddress: string): void {
    if (this.cache.has(walletAddress)) return;
    this.getFunder(walletAddress).catch(() => {});
  }

  private async _lookup(walletAddress: string): Promise<FunderResult | null> {
    try {
      const pubkey = new PublicKey(walletAddress);
      return await Promise.race([
        this._fetchFunder(pubkey, walletAddress),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS))
      ]);
    } catch (error) {
      logger.debug({ wallet: walletAddress.slice(0, 8), error: (error as Error).message }, 'Funder lookup failed');
      return null;
    }
  }

  private async _fetchFunder(pubkey: PublicKey, walletAddress: string): Promise<FunderResult | null> {
    const sigs = await this.connection.getSignaturesForAddress(pubkey, { limit: MAX_SIGS });
    if (!sigs.length) return null;

    const funders = new Map<string, number>();
    const batchSize = 5;

    for (let i = 0; i < Math.min(sigs.length, MAX_SIGS); i += batchSize) {
      const batch = sigs.slice(i, i + batchSize);
      const txs = await Promise.all(
        batch.map(s => this.connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null))
      );
      for (const tx of txs) {
        if (!tx?.meta) continue;
        this._extractFunders(tx, walletAddress, funders);
      }
    }

    if (funders.size === 0) return null;

    let bestFunder = '';
    let bestAmount = 0;
    for (const [addr, amount] of funders) {
      if (amount > bestAmount) { bestFunder = addr; bestAmount = amount; }
    }

    if (bestAmount < MIN_FUNDING_SOL) return null;

    const confidence = Math.min(1, bestAmount / 1.0);
    logger.info({ wallet: walletAddress.slice(0, 8), funder: bestFunder.slice(0, 8), sol: bestAmount.toFixed(3), confidence: confidence.toFixed(2) }, '🔍 Funder identified via RPC');

    return { funder: bestFunder, amountSol: bestAmount, confidence };
  }

  private _extractFunders(tx: ParsedTransactionWithMeta, targetWallet: string, funders: Map<string, number>): void {
    const meta = tx.meta;
    if (!meta) return;

    const accounts = tx.transaction.message.accountKeys.map(k =>
      typeof k === 'string' ? k : k.pubkey.toBase58()
    );

    const targetIdx = accounts.indexOf(targetWallet);
    if (targetIdx === -1) return;

    const preBal = meta.preBalances[targetIdx] ?? 0;
    const postBal = meta.postBalances[targetIdx] ?? 0;
    const received = (postBal - preBal) / 1e9;

    if (received < MIN_FUNDING_SOL) return;

    for (let i = 0; i < accounts.length; i++) {
      if (i === targetIdx) continue;
      const pre = meta.preBalances[i] ?? 0;
      const post = meta.postBalances[i] ?? 0;
      const sent = (pre - post) / 1e9;
      if (sent >= MIN_FUNDING_SOL && accounts[i] !== '11111111111111111111111111111111') {
        funders.set(accounts[i], (funders.get(accounts[i]) || 0) + sent);
      }
    }
  }

  getCacheSize(): number { return this.cache.size; }
}
