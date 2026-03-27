import WebSocket from 'ws';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { creditTracker } from '../api/HeliusCreditTracker.js';

/**
 * WalletWatcher — Real-time monitoring of ELITE/GOOD wallets via Helius WSS accountSubscribe
 *
 * Credit budget: max 50K credits/day for this worker.
 * Track all ELITE wallets via real P&L WR (buy_mc vs sell_mc).
 * Auto-throttle if budget exceeded.
 */

const HELIUS_WSS_URL = 'wss://mainnet.helius-rpc.com/?api-key=981f9d6d-2dbb-4171-8424-f12b610e290d';
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DAILY_CREDIT_BUDGET = 200_000; // v10.14.3: 60% of 333K daily budget for wallet monitoring
const MAX_WALLETS = 500; // v10.14.3: track ALL ELITE wallets (~448), budget allows it (21% of daily credits)

export interface WalletBuyCallback {
  onWatchedWalletBuy(tokenAddress: string, walletAddress: string): void;
}

export class WalletWatcher {
  private pool: Pool;
  private ws: WebSocket | null = null;
  private isConnected = false;
  private isShuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private consecutiveErrors = 0;

  // wallet → subscription id
  private subscriptions = new Map<string, number>();
  // subscription id → wallet
  private subIdToWallet = new Map<number, string>();
  // wallet ranked list (by category then win_rate)
  private watchedWallets: string[] = [];
  private pendingRequests = new Map<number, string>(); // req id → wallet

  private dailyCredits = 0;
  private lastCreditReset = new Date().toISOString().slice(0, 10);

  private callback: WalletBuyCallback | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  setCallback(cb: WalletBuyCallback): void {
    this.callback = cb;
  }

  async start(): Promise<void> {
    await this.loadWallets();
    await this.connect();
    // Refresh wallet list every 30 min (aligned with WalletStatsWorker)
    this.refreshTimer = setInterval(async () => {
      await this.loadWallets();
      this.resubscribeAll();
    }, 30 * 60 * 1000);
    logger.info({ watching: this.watchedWallets.length }, '👁️ WalletWatcher started');
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) { this.ws.close(); this.ws = null; }
  }

  private async loadWallets(): Promise<void> {
    try {
      const result = await this.pool.query(`
        SELECT wallet_address, win_rate, tokens_total
        FROM wallet_stats
        WHERE category IN ('ELITE', 'GOOD')
        ORDER BY
          CASE category WHEN 'ELITE' THEN 0 WHEN 'GOOD' THEN 1 ELSE 2 END,
          win_rate DESC, tokens_total DESC
        LIMIT $1
      `, [MAX_WALLETS]);
      this.watchedWallets = result.rows.map((r: any) => r.wallet_address);
      logger.info({ count: this.watchedWallets.length }, '👁️ WalletWatcher: wallet list refreshed');
    } catch (err) {
      logger.error({ err }, '👁️ WalletWatcher: failed to load wallets');
    }
  }

  private resubscribeAll(): void {
    if (!this.isConnected || !this.ws) return;
    // Unsubscribe wallets no longer in list
    for (const [wallet, subId] of this.subscriptions) {
      if (!this.watchedWallets.includes(wallet)) {
        this.sendUnsubscribe(subId);
        this.subscriptions.delete(wallet);
        this.subIdToWallet.delete(subId);
      }
    }
    // Subscribe new wallets
    for (const wallet of this.watchedWallets) {
      if (!this.subscriptions.has(wallet)) {
        this.sendSubscribe(wallet);
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;
    logger.info('👁️ WalletWatcher connecting...');
    this.ws = new WebSocket(HELIUS_WSS_URL);

    this.ws.on('open', () => {
      this.isConnected = true;
      this.consecutiveErrors = 0;
      this.subscriptions.clear();
      this.subIdToWallet.clear();
      this.pendingRequests.clear();
      logger.info({ wallets: this.watchedWallets.length }, '👁️ WalletWatcher connected');
      for (const w of this.watchedWallets) {
        this.sendSubscribe(w);
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        this.trackCredits(1);
        const msg = JSON.parse(data.toString());

        // Subscription confirmation
        if (msg.id !== undefined && msg.result !== undefined && typeof msg.result === 'number') {
          const wallet = this.pendingRequests.get(msg.id);
          if (wallet) {
            this.subscriptions.set(wallet, msg.result);
            this.subIdToWallet.set(msg.result, wallet);
            this.pendingRequests.delete(msg.id);
          }
          return;
        }

        if (msg.method === 'logsNotification' && msg.params) {
          this.handleNotification(msg.params);
        }
      } catch { /* ignore */ }
    });

    this.ws.on('pong', () => { /* keepalive */ });

    this.ws.on('close', (code) => {
      this.isConnected = false;
      this.ws = null;
      if (!this.isShuttingDown) {
        this.consecutiveErrors++;
        const delay = Math.min(2000 * Math.pow(2, this.consecutiveErrors - 1), 30000);
        logger.warn({ code, delay }, '👁️ WalletWatcher disconnected — reconnecting');
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    });

    this.ws.on('error', (err) => {
      logger.warn({ err: (err as Error).message }, '👁️ WalletWatcher error');
    });

    // Ping keepalive + status log
    setInterval(() => {
      if (this.ws && this.isConnected) {
        try { this.ws.ping(); } catch { /* ignore */ }
        logger.info({ subscribed: this.subscriptions.size, credits: this.dailyCredits, watching: this.watchedWallets.length }, 'WalletWatcher heartbeat');
      }
    }, 60000);
  }

  private sendSubscribe(wallet: string): void {
    if (!this.ws || !this.isConnected) return;
    // Check credit budget before adding more subscriptions
    if (!this.checkBudget()) {
      logger.warn({ wallet: wallet.slice(0, 8) }, '👁️ WalletWatcher: daily credit budget reached, skipping subscribe');
      return;
    }
    const id = Date.now() + Math.floor(Math.random() * 10000);
    this.pendingRequests.set(id, wallet);
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'logsSubscribe',
      params: [
        { mentions: [wallet] },
        { commitment: 'processed' }
      ]
    }));
  }

  private sendUnsubscribe(subId: number): void {
    if (!this.ws || !this.isConnected) return;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'logsUnsubscribe',
      params: [subId]
    }));
  }

  private handleNotification(params: any): void {
    try {
      const subId: number = params?.subscription;
      const wallet = this.subIdToWallet.get(subId);
      if (!wallet) return;

      // logsNotification gives us transaction logs
      const value = params?.result?.value;
      if (!value) return;

      const logs = value?.logs as string[] | undefined;
      if (!logs || logs.length === 0) return;

      // Check if this involves pump.fun program
      const isPumpFun = logs.some((l: string) => l.includes(PUMP_FUN_PROGRAM));
      if (!isPumpFun) return;

      // Check if it's a buy (not a sell)
      const isBuy = logs.some((l: string) => l.includes('Buy') || l.includes('buy'));
      if (!isBuy) return;

      // Extract token mint from log lines
      // Pump.fun logs typically include the mint address in the instruction data
      let tokenAddress: string | null = null;
      
      // Method 1: look for token addresses in accountKeys from the signature
      const sig = value?.signature;
      
      // Method 2: parse Program log lines for mint references
      for (const log of logs) {
        // pump.fun logs often have format: "Program log: Instruction: Buy" followed by token data
        // Look for base58 addresses (32-44 chars) that end with "pump"
        const matches = log.match(/([A-HJ-NP-Za-km-z1-9]{32,44}pump)/g);
        if (matches) {
          tokenAddress = matches[0];
          break;
        }
        // Also try generic token address patterns
        const mintMatch = log.match(/mint[:\s]+([A-HJ-NP-Za-km-z1-9]{32,44})/i);
        if (mintMatch) {
          tokenAddress = mintMatch[1];
          break;
        }
      }

      if (tokenAddress && this.callback) {
        logger.info({ wallet: wallet.slice(0, 8), token: tokenAddress.slice(0, 8), sig: sig?.slice(0, 12) },
          '\xf0\x9f\x91\x81\xef\xb8\x8f WalletWatcher: ELITE wallet pump.fun buy detected');
        this.callback.onWatchedWalletBuy(tokenAddress, wallet);
      }
    } catch (err) {
      logger.debug({ err }, 'WalletWatcher notification parse error');
    }
  }

  private trackCredits(n: number): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastCreditReset) {
      this.dailyCredits = 0;
      this.lastCreditReset = today;
    }
    this.dailyCredits += n;
    creditTracker.spend(n, 'wallet_watcher');

    // Auto-throttle: unsubscribe lowest-ranked wallets if over budget
    if (this.dailyCredits > DAILY_CREDIT_BUDGET && this.subscriptions.size > 0) {
      const walletsToRemove = this.watchedWallets.slice(Math.floor(this.watchedWallets.length / 2));
      for (const w of walletsToRemove) {
        const subId = this.subscriptions.get(w);
        if (subId !== undefined) {
          this.sendUnsubscribe(subId);
          this.subscriptions.delete(w);
          this.subIdToWallet.delete(subId);
        }
      }
      logger.warn({ removed: walletsToRemove.length, dailyCredits: this.dailyCredits },
        '👁️ WalletWatcher: auto-throttled due to credit budget');
    }
  }

  private checkBudget(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastCreditReset) {
      this.dailyCredits = 0;
      this.lastCreditReset = today;
    }
    return this.dailyCredits < DAILY_CREDIT_BUDGET;
  }

  getStats(): { watching: number; subscribed: number; dailyCredits: number } {
    return {
      watching: this.watchedWallets.length,
      subscribed: this.subscriptions.size,
      dailyCredits: this.dailyCredits
    };
  }
}
