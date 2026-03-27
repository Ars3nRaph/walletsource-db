import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';

/**
 * CartelDetector v2.0 — Sniper Wallet Convergence
 *
 * Replaces fake ELITE/GOOD (wallet_stats WR) with REAL on-chain verified snipers.
 *
 * These 17 wallets were identified by analyzing 4 days of trade_events:
 * - Each was present in the first 60s of tokens that did 10x+
 * - Rocket precision: 3-40% (vs 0.46% base rate = up to 87x edge)
 * - When 2+ converge: 6.6% rocket rate, 16.3% rate for x4+
 *
 * Detection flow:
 *   trade_events stream → onTrade() → tokenSniperBuyers map
 *   evaluateEntry() → getSignal() → sniperCount >= 2 within 60s → BUY
 *
 * No Helius needed. Pure PumpPortal stream.
 */

export interface CartelSignal {
  sniperCount: number;
  snipers: string[];           // which sniper wallets bought
  confidence: number;          // 0-1
  positionSol: number;         // sized by sniper count
  combinedScore: number;       // sum of signal_scores
  // Legacy fields for compatibility
  goodWalletCount: number;
  eliteWalletCount: number;
  goodWallets: string[];
}

interface SniperInfo {
  rocketPct: number;
  signalScore: number;
  avgEntrySec: number;
}

export class CartelDetector {
  private pool: Pool;
  private snipers: Map<string, SniperInfo> = new Map();
  private lastRefresh = 0;
  private refreshing = false;
  private readonly REFRESH_MS = 3_600_000; // 1h
  private ready = false;

  // token → set of sniper wallets that bought early
  private tokenSniperBuyers: Map<string, { wallets: Set<string>; firstAt: number }> = new Map();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // No-op: Helius scanner no longer needed
  setBuyerScanner(_scanner: unknown): void {}
  async heliusScan(_token: string): Promise<CartelSignal | null> { return null; }

  async init(): Promise<void> {
    this.refreshing = true;
    await this.refreshSnipers();
    this.refreshing = false;
    logger.info({ snipers: this.snipers.size }, '🎯 CartelDetector v2.0 initialized — real on-chain snipers');
  }

  private async refreshSnipers(): Promise<void> {
    try {
      const res = await this.pool.query(`
        SELECT wallet_address, rocket_pct, signal_score, avg_entry_sec
        FROM sniper_wallets
        ORDER BY signal_score DESC
      `);
      this.snipers.clear();
      for (const row of res.rows) {
        this.snipers.set(row.wallet_address, {
          rocketPct: parseFloat(row.rocket_pct),
          signalScore: parseFloat(row.signal_score),
          avgEntrySec: parseFloat(row.avg_entry_sec),
        });
      }
      this.lastRefresh = Date.now();
      this.ready = true;
      logger.info({ count: this.snipers.size }, '🎯 Sniper wallets refreshed from DB');
    } catch (err) {
      logger.error({ err }, 'Failed to refresh sniper wallets');
    }
  }

  /** Called on every trade_event from PumpPortal stream */
  onTrade(tokenAddress: string, traderWallet: string, txType: string): void {
    if (txType !== 'buy' || !this.ready) return;

    // Auto-refresh hourly
    if (!this.refreshing && Date.now() - this.lastRefresh > this.REFRESH_MS) {
      this.refreshing = true;
      this.refreshSnipers().catch(() => {}).finally(() => { this.refreshing = false; });
    }

    if (!this.snipers.has(traderWallet)) return;

    const now = Date.now();
    if (!this.tokenSniperBuyers.has(tokenAddress)) {
      this.tokenSniperBuyers.set(tokenAddress, { wallets: new Set(), firstAt: now });
    }
    const entry = this.tokenSniperBuyers.get(tokenAddress)!;

    // Reset window if first sniper was >60s ago (token too old)
    if (now - entry.firstAt > 60_000) {
      entry.wallets.clear();
      entry.firstAt = now;
    }

    if (!entry.wallets.has(traderWallet)) {
      entry.wallets.add(traderWallet);
      const info = this.snipers.get(traderWallet)!;
      logger.info({
        token: tokenAddress.slice(0, 8),
        wallet: traderWallet.slice(0, 8),
        rocketPct: info.rocketPct.toFixed(1) + '%',
        sniperCount: entry.wallets.size,
      }, `🎯 Sniper #${entry.wallets.size} detected`);
    }
  }

  /** Returns signal if ≥2 snipers bought this token within 60s */
  getSignal(tokenAddress: string): CartelSignal | null {
    const entry = this.tokenSniperBuyers.get(tokenAddress);
    if (!entry || entry.wallets.size < 2) return null;

    // Check window still valid
    if (Date.now() - entry.firstAt > 90_000) return null;

    const walletList = Array.from(entry.wallets);
    const count = walletList.length;

    // Combined signal score from all converging snipers
    const combinedScore = walletList.reduce((sum, w) => {
      return sum + (this.snipers.get(w)?.signalScore ?? 0);
    }, 0);

    // Position sizing: 2 snipers→0.40, 3→0.55, 4+→0.70 SOL
    const positionSol = count >= 4 ? 0.70 : count >= 3 ? 0.55 : 0.40;
    const confidence = Math.min(0.95, 0.65 + count * 0.10);

    return {
      sniperCount: count,
      snipers: walletList,
      confidence,
      positionSol,
      combinedScore,
      // Legacy compat
      goodWalletCount: count,
      eliteWalletCount: count,
      goodWallets: walletList,
    };
  }

  /** Legacy compat — used by old Helius RT path, now returns null */
  getEliteBuyers(_token: string): Set<string> | null { return null; }

  cleanupToken(tokenAddress: string): void {
    this.tokenSniperBuyers.delete(tokenAddress);
  }

  getStats(): { goodWalletCount: number; trackedTokens: number; sniperCount: number } {
    return {
      goodWalletCount: this.snipers.size,
      sniperCount: this.snipers.size,
      trackedTokens: this.tokenSniperBuyers.size,
    };
  }

  isGoodWallet(wallet: string): boolean {
    return this.snipers.has(wallet);
  }

  // Legacy compat
  onWatchedWalletBuy(tokenAddress: string, walletAddress: string): void {
    this.onTrade(tokenAddress, walletAddress, 'buy');
  }
}
