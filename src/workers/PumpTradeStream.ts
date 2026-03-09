import WebSocket from 'ws';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';

const PUMPPORTAL_WSS_URL = 'wss://pumpportal.fun/api/data';
const MAX_SUBSCRIPTIONS = 100; // PumpPortal safe limit per connection
const RECONNECT_DELAY_MS = 2000;

interface PumpTradeEvent {
  txType: 'buy' | 'sell';
  mint: string;
  traderPublicKey: string;
  tokenAmount: number;
  solAmount: number;
  newTokenBalance: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  signature: string;
  timestamp?: number;
  pool?: string;
}

export class PumpTradeStream {
  private ws: WebSocket | null = null;
  private pool: Pool;
  private subscribedTokens = new Set<string>();
  private pendingSubscriptions: string[] = [];
  private isConnected = false;
  private isShuttingDown = false;
  private solPrice = 150;
  
  private reconnectTimer: NodeJS.Timeout | null = null;

  // Token expiry: stop tracking after 20min
  private tokenExpiry = new Map<string, number>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async start(): Promise<void> {
    await this.connect();
    // Refresh SOL price every 5min
    setInterval(() => this.fetchSolPrice(), 5 * 60 * 1000);
    await this.fetchSolPrice();
    // Cleanup expired tokens every minute
    setInterval(() => this.cleanupExpired(), 60 * 1000);
  }

  /** Subscribe to trade stream for a specific token */
  subscribe(tokenMint: string): void {
    if (this.subscribedTokens.has(tokenMint)) return;
    if (this.subscribedTokens.size >= MAX_SUBSCRIPTIONS) {
      logger.debug({ token: tokenMint, size: this.subscribedTokens.size }, 'PumpTradeStream at capacity, dropping');
      return;
    }

    // Track expiry (20 min from now)
    this.tokenExpiry.set(tokenMint, Date.now() + 20 * 60 * 1000);

    if (this.isConnected && this.ws) {
      this.sendSubscribe([tokenMint]);
    } else {
      this.pendingSubscriptions.push(tokenMint);
    }
  }

  /** Unsubscribe from a token's trade stream */
  unsubscribe(tokenMint: string): void {
    if (!this.subscribedTokens.has(tokenMint)) return;
    this.subscribedTokens.delete(tokenMint);
    this.tokenExpiry.delete(tokenMint);
    if (this.isConnected && this.ws) {
      this.ws.send(JSON.stringify({
        method: 'unsubscribeTokenTrade',
        keys: [tokenMint]
      }));
    }
  }

  private sendSubscribe(tokens: string[]): void {
    if (!this.ws || !this.isConnected) return;
    tokens.forEach(t => this.subscribedTokens.add(t));
    this.ws.send(JSON.stringify({
      method: 'subscribeTokenTrade',
      keys: tokens
    }));
    logger.debug({ tokens: tokens.length, total: this.subscribedTokens.size }, 'PumpTradeStream subscribed');
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;
    this.ws = new WebSocket(PUMPPORTAL_WSS_URL);

    this.ws.on('open', () => {
      this.isConnected = true;
      logger.info({ pending: this.pendingSubscriptions.length }, 'PumpTradeStream connected');

      // Re-subscribe to all active tokens (reconnect case)
      const all = [...this.subscribedTokens, ...this.pendingSubscriptions];
      this.subscribedTokens.clear();
      this.pendingSubscriptions = [];

      // Batch in groups of 100
      for (let i = 0; i < all.length; i += 100) {
        this.sendSubscribe(all.slice(i, i + 100));
      }
    });

    this.ws.on('message', async (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as PumpTradeEvent;
        if (msg.txType === 'buy' || msg.txType === 'sell') {
          await this.handleTrade(msg);
        }
      } catch {
        // ignore parse errors
      }
    });

    this.ws.on('close', (code) => {
      this.isConnected = false;
      this.ws = null;
      logger.warn({ code, subscribed: this.subscribedTokens.size }, 'PumpTradeStream disconnected, reconnecting...');
      if (!this.isShuttingDown) {
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    });

    this.ws.on('error', (err) => {
      logger.warn({ err }, 'PumpTradeStream WebSocket error');
    });
  }

  private async handleTrade(event: PumpTradeEvent): Promise<void> {
    const { mint, txType, solAmount, vSolInBondingCurve, vTokensInBondingCurve, marketCapSol, traderPublicKey, signature } = event;

    // Compute USD values
    const marketCapUsd = marketCapSol * this.solPrice;
    const priceUsd = vTokensInBondingCurve > 0
      ? (vSolInBondingCurve / vTokensInBondingCurve) * this.solPrice
      : null;
    const volumeUsd = solAmount * this.solPrice;

    logger.debug({
      token: mint.slice(0, 8),
      type: txType,
      mcUsd: Math.round(marketCapUsd),
      priceUsd: priceUsd?.toFixed(8),
      vol: volumeUsd.toFixed(2)
    }, 'Trade event');

    try {
      // Insert snapshot from trade event (0 credits, real-time)
      await this.pool.query(`
        INSERT INTO token_snapshots (
          token_address, snapshot_at,
          fdv, market_cap, price_usd,
          volume_1m, volume_5m_usd,
          txns_1m_buys, txns_1m_sells,
          liquidity_base, liquidity_quote,
          data_source
        ) VALUES (
          $1, NOW(),
          $2, $3, $4,
          $5, $5,
          $6, $7,
          $8, $9,
          'pumpportal_trade'
        )
      `, [
        mint,
        marketCapUsd,        // fdv (MC on bonding curve)
        marketCapUsd,        // market_cap
        priceUsd,
        volumeUsd,           // volume_1m / volume_5m (single trade)
        txType === 'buy' ? 1 : 0,
        txType === 'sell' ? 1 : 0,
        vTokensInBondingCurve,  // liquidity_base
        vSolInBondingCurve,     // liquidity_quote (SOL)
      ]);

      // Update fdv_at_detection if not yet set (should be set by create event, but safety net)
      await this.pool.query(`
        UPDATE token_events
        SET fdv_at_detection = $1
        WHERE token_address = $2 AND fdv_at_detection IS NULL
      `, [marketCapUsd, mint]);

      // Notify TokenTracker via DB flag for real-time trade evaluation
      await this.pool.query(`
        INSERT INTO trade_events (token_address, tx_type, market_cap_usd, price_usd, volume_usd,
          v_sol, v_tokens, trader_wallet, signature, event_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (signature) DO NOTHING
      `, [mint, txType, marketCapUsd, priceUsd, volumeUsd,
          vSolInBondingCurve, vTokensInBondingCurve, traderPublicKey, signature]);

    } catch (err) {
      logger.debug({ err, token: mint }, 'Trade event insert failed');
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [token, expiry] of this.tokenExpiry) {
      if (now > expiry) {
        this.unsubscribe(token);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: this.subscribedTokens.size }, 'PumpTradeStream cleanup');
    }
  }

  private async fetchSolPrice(): Promise<void> {
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
        signal: AbortSignal.timeout(3000)
      });
      const data = await res.json() as { solana?: { usd?: number } };
      if (data?.solana?.usd) {
        this.solPrice = data.solana.usd;
        
      }
    } catch { /* keep cached */ }
  }

  getSolPrice(): number { return this.solPrice; }
  getSubscribedCount(): number { return this.subscribedTokens.size; }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
