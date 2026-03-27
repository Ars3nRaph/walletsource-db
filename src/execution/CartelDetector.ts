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
  eliteWalletCount: number;   // v1.2: wallets with WR >= 75% (real P&L)
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
      // Fast read from persistent wallet_stats (populated by WalletStatsWorker)
      const result = await this.pool.query(`
        SELECT wallet_address, tokens_total, win_rate
        FROM wallet_stats
        WHERE category IN ('ELITE', 'GOOD')
        ORDER BY win_rate DESC
      `);

      this.goodWallets.clear();
      for (const row of result.rows) {
        this.goodWallets.set(row.wallet_address, {
          tokens: parseInt(row.tokens_total),
          wr: parseFloat(row.win_rate) * 100,
        });
      }
      this.lastRefresh = Date.now();
      this.ready = true;
      logger.info({ count: this.goodWallets.size }, 'Good wallets refreshed from wallet_stats');
    } catch (err) {
      logger.error({ err }, 'Failed to refresh good wallets');
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
    // v1.2: count ELITE wallets (WR >= 75% real P&L)
    let eliteCount = 0;
    for (const w of buyers) {
      const info = this.goodWallets.get(w);
      if (info && info.wr >= 75) eliteCount++;
    }
    // Sizing: 2→0.50, 3→0.60, 4+→0.70
    const positionSol = count >= 4 ? 0.70 : count >= 3 ? 0.60 : 0.50;
    const confidence = Math.min(0.95, 0.70 + count * 0.05);

    return {
      goodWalletCount: count,
      eliteWalletCount: eliteCount,
      goodWallets: Array.from(buyers),
      confidence,
      positionSol,
    };
  }

  /** Get ELITE wallets that bought this token (WR >= 75%) */
  getEliteBuyers(tokenAddress: string): Set<string> | null {
    const buyers = this.tokenGoodBuyers.get(tokenAddress);
    if (!buyers || buyers.size === 0) return null;

    const elites = new Set<string>();
    for (const w of buyers) {
      const info = this.goodWallets.get(w);
      if (info && info.wr >= 75) elites.add(w);
    }
    return elites.size > 0 ? elites : null;
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
  // Track watched wallet buys for cross-wallet cartel detection (even untracked tokens)
  private watchedWalletTokenBuys: Map<string, { wallets: Set<string>; firstAt: number }> = new Map();

  /**
   * Called by WalletWatcher when a monitored (ELITE/GOOD) wallet buys any token.
   * 2+ watched wallets buying same token within 120s emits a CARTEL signal.
   */
  onWatchedWalletBuy(tokenAddress: string, walletAddress: string): void {
    const now = Date.now();
    const WINDOW_MS = 120_000;
    if (!this.watchedWalletTokenBuys.has(tokenAddress)) {
      this.watchedWalletTokenBuys.set(tokenAddress, { wallets: new Set(), firstAt: now });
    }
    const entry = this.watchedWalletTokenBuys.get(tokenAddress)!;
    if (now - entry.firstAt > WINDOW_MS) {
      entry.wallets.clear();
      entry.firstAt = now;
    }
    entry.wallets.add(walletAddress);
    if (entry.wallets.size >= 2) {
      const count = entry.wallets.size;
      logger.info({
        token: tokenAddress.slice(0, 8),
        watchedCount: count,
      }, 'CARTEL SIGNAL: watched wallets converging on token');
      if (!this.tokenGoodBuyers.has(tokenAddress)) {
        this.tokenGoodBuyers.set(tokenAddress, new Set());
      }
      const buyers = this.tokenGoodBuyers.get(tokenAddress)!;
      for (const w of entry.wallets) buyers.add(w);
    }
    if (this.watchedWalletTokenBuys.size > 2000) {
      const cutoff = now - WINDOW_MS * 2;
      for (const [tok, e] of this.watchedWalletTokenBuys) {
        if (e.firstAt < cutoff) this.watchedWalletTokenBuys.delete(tok);
      }
    }
  }

}

