import { logger } from '../utils/logger.js';
import { creditTracker } from './HeliusCreditTracker.js';
import type { Pool } from 'pg';

/**
 * HeliusBuyerScanner — Scan token buyers via Helius Enhanced Transactions API
 * Used by CARTEL detector to identify good wallet convergence in real-time
 * 
 * Cost: ~100 credits per getSignatures + 100 per parsed tx = ~200 per token scan
 * Budget allows ~1350 token scans per day (270K / 200)
 */
export class HeliusBuyerScanner {
  private rpcUrl: string;
  private pool: Pool;
  private scanCache = new Map<string, { buyers: BuyerInfo[]; scannedAt: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache

  constructor(pool: Pool) {
    this.rpcUrl = process.env.HELIUS_RPC_URL || 
      `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`;
    this.pool = pool;
  }

  /**
   * Get all buyers of a token from on-chain data
   * Returns wallet addresses + amounts + timing
   * ~200 credits per call
   */
  async getTokenBuyers(tokenMint: string, maxSignatures: number = 50): Promise<BuyerInfo[]> {
    // Check cache
    const cached = this.scanCache.get(tokenMint);
    if (cached && Date.now() - cached.scannedAt < this.CACHE_TTL_MS) {
      return cached.buyers;
    }

    // Check budget
    if (!creditTracker.canSpend(200)) {
      logger.debug({ token: tokenMint.slice(0, 8) }, 'Helius budget exceeded — skipping buyer scan');
      return [];
    }

    try {
      // Step 1: Get recent signatures for this token's bonding curve
      // Use getSignaturesForAddress on the token mint
      const sigResponse = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [tokenMint, { limit: maxSignatures }]
        }),
        signal: AbortSignal.timeout(10000)
      });
      
      creditTracker.spend(100, 'buyer_scan_sigs');
      
      const sigData = await sigResponse.json() as any;
      const signatures = sigData?.result?.map((s: any) => s.signature) || [];
      
      if (signatures.length === 0) return [];

      // Step 2: Parse transactions via Helius Enhanced API
      const parseResponse = await fetch(
        `https://api.helius.xyz/v0/transactions?api-key=${process.env.HELIUS_API_KEY || this.extractApiKey()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactions: signatures.slice(0, 20) }), // Max 20 per batch
          signal: AbortSignal.timeout(15000)
        }
      );

      creditTracker.spend(100, 'buyer_scan_parse');

      const parsed = await parseResponse.json() as any[];
      
      const buyers: BuyerInfo[] = [];
      for (const tx of (parsed || [])) {
        if (!tx?.type || tx.type !== 'SWAP') continue;
        
        // Extract buyer info from swap
        const feePayer = tx.feePayer;
        const timestamp = tx.timestamp;
        const solAmount = tx.nativeTransfers?.find((t: any) => t.fromUserAccount === feePayer)?.amount || 0;
        
        if (feePayer && solAmount > 0) {
          buyers.push({
            wallet: feePayer,
            solAmount: solAmount / 1e9, // lamports to SOL
            timestamp: timestamp,
            signature: tx.signature
          });
        }
      }

      // Cache result
      this.scanCache.set(tokenMint, { buyers, scannedAt: Date.now() });
      
      // Evict old cache entries
      if (this.scanCache.size > 500) {
        const cutoff = Date.now() - this.CACHE_TTL_MS;
        for (const [k, v] of this.scanCache) {
          if (v.scannedAt < cutoff) this.scanCache.delete(k);
        }
      }

      logger.debug({ token: tokenMint.slice(0, 8), buyers: buyers.length }, 
        '🔍 Helius buyer scan complete');
      
      return buyers;
    } catch (err) {
      logger.debug({ token: tokenMint.slice(0, 8), err }, 'Helius buyer scan failed');
      return [];
    }
  }

  /**
   * Check if any of the token's buyers are known "good" wallets (for CARTEL)
   * Returns matching good wallets with their stats
   */
  async findGoodWalletBuyers(tokenMint: string, goodWallets: Map<string, WalletStats>): Promise<CartelMatch[]> {
    const buyers = await this.getTokenBuyers(tokenMint);
    const matches: CartelMatch[] = [];

    for (const buyer of buyers) {
      const stats = goodWallets.get(buyer.wallet);
      if (stats && stats.winRate >= 0.65 && stats.tokenCount >= 15) {
        matches.push({
          wallet: buyer.wallet,
          solAmount: buyer.solAmount,
          buyTime: buyer.timestamp,
          walletWR: stats.winRate,
          walletTokens: stats.tokenCount,
          walletAvgPnl: stats.avgPnl
        });
      }
    }

    if (matches.length >= 2) {
      logger.info({ 
        token: tokenMint.slice(0, 8), 
        matches: matches.length,
        wallets: matches.map(m => m.wallet.slice(0, 8))
      }, '🎯 CARTEL SIGNAL — good wallet convergence detected via Helius');
    }

    return matches;
  }

  private extractApiKey(): string {
    const url = process.env.HELIUS_WSS_URL || process.env.HELIUS_RPC_URL || '';
    const match = url.match(/api-key=([^&]+)/);
    return match ? match[1] : process.env.HELIUS_API_KEY || '';
  }
}

export interface BuyerInfo {
  wallet: string;
  solAmount: number;
  timestamp: number;
  signature: string;
}

export interface WalletStats {
  winRate: number;
  tokenCount: number;
  avgPnl: number;
}

export interface CartelMatch {
  wallet: string;
  solAmount: number;
  buyTime: number;
  walletWR: number;
  walletTokens: number;
  walletAvgPnl: number;
}
