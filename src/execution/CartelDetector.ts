import type { Pool } from 'pg';
import type { HeliusBuyerScanner } from '../api/HeliusBuyerScanner.js';
import { logger } from '../utils/logger.js';

/**
 * CartelDetector v1.0 — Detects high-WR wallet convergence on tokens
 * 
 * A "good wallet" = one that historically buys early (within 90s of detection)
 * on tokens that subsequently pump 20%+, with 65%+ win rate on 15+ tokens.
 * 
 * When multiple good wallets buy the same token early, it's a strong buy signal:
 *   2 good wallets → 67.6% WR, +51% avg
 *   3 good wallets → 61.4% WR (but higher avg peak)
 *   5+ good wallets → 88.9% WR
 */

export interface CartelSignal {
  goodWalletCount: number;
  goodWallets: string[];      // which good wallets bought this token
  confidence: number;          // 0-1 based on count
  positionSol: number;        // sized by confidence
}

export class CartelDetector {
  private pool: Pool;
  private goodWallets: Map<string, { tokens: number; wr: number }> = new Map();
  private lastRefresh = 0;
  private refreshing = false;
  private refreshIntervalMs = 3600_000; // refresh every hour
  private ready = false;

  // Track which good wallets bought each active token
  private tokenGoodBuyers: Map<string, Set<string>> = new Map();
  private buyerScanner: HeliusBuyerScanner | null = null;
  private scannedTokens = new Set<string>(); // prevent duplicate scans

  constructor(pool: Pool) {
    this.pool = pool;
  }

  setBuyerScanner(scanner: HeliusBuyerScanner): void {
    this.buyerScanner = scanner;
    logger.info('🤝 CartelDetector: HeliusBuyerScanner wired');
  }

  /**
   * Scan a token's on-chain buyers via Helius Enhanced API
   * Called when a token looks promising (30+ buyers) to discover
   * good wallets that bought before our WS detected them
   * Cost: ~200 credits per scan. Budget: ~1350 scans/day.
   */
  async heliusScan(tokenAddress: string): Promise<CartelSignal | null> {
    if (!this.buyerScanner || !this.ready) return null;
    if (this.scannedTokens.has(tokenAddress)) return null; // already scanned
    this.scannedTokens.add(tokenAddress);
    
    // Evict old entries to prevent memory leak
    if (this.scannedTokens.size > 5000) {
      const arr = Array.from(this.scannedTokens);
      for (let i = 0; i < 2500; i++) this.scannedTokens.delete(arr[i]);
    }

    const matches = await this.buyerScanner.findGoodWalletBuyers(tokenAddress, this.goodWallets as any);
    
    // Add discovered good wallets to our in-memory tracker
    for (const match of matches) {
      if (!this.tokenGoodBuyers.has(tokenAddress)) {
        this.tokenGoodBuyers.set(tokenAddress, new Set());
      }
      this.tokenGoodBuyers.get(tokenAddress)!.add(match.wallet);
    }

    return this.getSignal(tokenAddress);
  }

  async init(): Promise<void> {
    this.refreshing = true;
    await this.refreshGoodWallets();
    this.refreshing = false;
    logger.info({ goodWallets: this.goodWallets.size }, '🤝 CartelDetector initialized');
  }

  private async refreshGoodWallets(): Promise<void> {
    try {
      const result = await this.pool.query(`
        WITH early_buys AS (
          SELECT te.trader_wallet, te.token_address
          FROM trade_events te
          JOIN token_events tok ON tok.token_address = te.token_address
          WHERE te.tx_type = 'buy' AND te.volume_usd > 10
            AND te.event_at > now() - interval '3 days'
            AND te.event_at <= tok.detected_at + interval '90 seconds'
          GROUP BY te.trader_wallet, te.token_address
        ),
        wallet_perf AS (
          SELECT eb.trader_wallet,
            count(DISTINCT eb.token_address) as n,
            count(DISTINCT eb.token_address) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM token_snapshots ts
                WHERE ts.token_address = eb.token_address
                  AND ts.snapshot_at > now() - interval '3 days'
                GROUP BY ts.token_address
                HAVING max(mc_live) / NULLIF(min(mc_live), 0) > 1.20
              )
            ) as wins
          FROM early_buys eb
          GROUP BY eb.trader_wallet
          HAVING count(DISTINCT eb.token_address) >= 15
        )
        SELECT trader_wallet, n, round(100.0 * wins / n, 1) as wr
        FROM wallet_perf
        WHERE (100.0 * wins / n) >= 65
      `);

      this.goodWallets.clear();
      for (const row of result.rows) {
        this.goodWallets.set(row.trader_wallet, {
          tokens: parseInt(row.n),
          wr: parseFloat(row.wr),
        });
      }
      this.lastRefresh = Date.now();
      this.ready = true;
      logger.info({ count: this.goodWallets.size }, '🤝 Good wallets refreshed');
    } catch (err) {
      logger.error({ err }, '🤝 Failed to refresh good wallets');
    }
  }

  /** Call on each trade event to track good wallet activity per token */
  onTrade(tokenAddress: string, traderWallet: string, txType: string): void {
    if (txType !== 'buy') return;
    if (!this.ready) return;

    // Auto-refresh hourly (with stampede guard)
    if (!this.refreshing && Date.now() - this.lastRefresh > this.refreshIntervalMs) {
      this.refreshing = true;
      this.refreshGoodWallets().catch(() => {}).finally(() => { this.refreshing = false; });
    }

    if (!this.goodWallets.has(traderWallet)) return;

    if (!this.tokenGoodBuyers.has(tokenAddress)) {
      this.tokenGoodBuyers.set(tokenAddress, new Set());
    }
    const buyers = this.tokenGoodBuyers.get(tokenAddress)!;
    if (!buyers.has(traderWallet)) {
      buyers.add(traderWallet);
      const count = buyers.size;
      const walletInfo = this.goodWallets.get(traderWallet)!;
      logger.info({
        token: tokenAddress.slice(0, 8),
        wallet: traderWallet.slice(0, 8),
        walletWR: walletInfo.wr,
        goodCount: count,
      }, `🤝 Good wallet #${count} detected`);
    }
  }

  /** Check if a token has cartel signal — call from TradeExecutor */
  getSignal(tokenAddress: string): CartelSignal | null {
    const buyers = this.tokenGoodBuyers.get(tokenAddress);
    if (!buyers || buyers.size < 2) return null;

    const count = buyers.size;
    // Sizing: 2→0.50, 3→0.60, 4+→0.70
    const positionSol = count >= 4 ? 0.70 : count >= 3 ? 0.60 : 0.50;
    const confidence = Math.min(0.95, 0.70 + count * 0.05);

    return {
      goodWalletCount: count,
      goodWallets: Array.from(buyers),
      confidence,
      positionSol,
    };
  }

  /** Clean up expired tokens (call periodically) */
  cleanupToken(tokenAddress: string): void {
    this.tokenGoodBuyers.delete(tokenAddress);
  }

  /** Get stats for dashboard */
  getStats(): { goodWalletCount: number; trackedTokens: number } {
    return {
      goodWalletCount: this.goodWallets.size,
      trackedTokens: this.tokenGoodBuyers.size,
    };
  }

  isGoodWallet(wallet: string): boolean {
    return this.goodWallets.has(wallet);
  }
}
