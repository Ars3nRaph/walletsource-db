import WebSocket from 'ws';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import type { TradeExecutor } from '../execution/TradeExecutor.js';

const PUMPPORTAL_WSS_URL = 'wss://pumpportal.fun/api/data';
const MAX_SUBSCRIPTIONS = 2000; // v10.13: raised from 500. PumpPortal allows unlimited, concurrent peak ~100
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
  private lastMessageAt: number = Date.now();
  private lastPongAt: number = Date.now();

  // Token expiry: stop tracking after 10min
  private tokenExpiry = new Map<string, number>();
  private tradeExecutor: TradeExecutor | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  setTradeExecutor(executor: TradeExecutor): void {
    this.tradeExecutor = executor;
  }

  async start(): Promise<void> {
    await this.connect();
    // Refresh SOL price every 5min
    setInterval(() => this.fetchSolPrice(), 5 * 60 * 1000);
    await this.fetchSolPrice();
    // Cleanup expired tokens every minute
    setInterval(() => this.cleanupExpired(), 60 * 1000);
    // v10.13: Ping keepalive every 30s to detect dead connections
    setInterval(() => {
      if (this.ws && this.isConnected) {
        try { this.ws.ping(); } catch { /* ignore */ }
      }
    }, 30000);
    // v10.13: Periodic MC check for positions with no ticks (every 60s)
    setInterval(() => this.checkStalePositions(), 60000);
    // v10.13: Watchdog — if no message received in 60s, force reconnect
    this.lastMessageAt = Date.now();
    this.lastPongAt = Date.now();
    setInterval(() => {
      const silentMsg = Date.now() - this.lastMessageAt;
      const silentPong = Date.now() - this.lastPongAt;
      // v10.14: Only watchdog if we actually have subscriptions (otherwise silence is normal)
      if (this.isConnected && this.subscribedTokens.size > 0 && (silentMsg > 60000 || silentPong > 90000)) {
        const openPositions = this.tradeExecutor ? 
          this.tradeExecutor.getOpenPositionTokens?.()?.length || 0 : 0;
        logger.warn({ silentMsgSec: Math.round(silentMsg / 1000), silentPongSec: Math.round(silentPong / 1000), openPositions }, 
          '⚠️ PumpTradeStream WATCHDOG — connection dead, forcing reconnect');
        this.ws?.terminate();
      }
    }, 15000);
  }

  /** Subscribe to trade stream for a specific token */
  subscribe(tokenMint: string, priority: boolean = false): void {
    if (this.subscribedTokens.has(tokenMint)) return;
    if (this.subscribedTokens.size >= MAX_SUBSCRIPTIONS) {
      if (priority) {
        // Evict oldest non-priority token WITHOUT an open position
        let evicted = false;
        for (const [tok, _expiry] of this.tokenExpiry) {
          if (this.tradeExecutor && this.tradeExecutor.hasPosition(tok)) continue;
          this.unsubscribe(tok);
          logger.info({ evicted: tok.slice(0,8), forPriority: tokenMint.slice(0,8) }, '🎯 Evicted token for rugger priority');
          evicted = true;
          break;
        }
        if (!evicted && false) { // v10.13: DISABLED force-evict — never evict tokens with open positions
          // All tokens have positions — evict oldest anyway
          const oldestEntry = this.tokenExpiry.entries().next();
          if (!oldestEntry.done && oldestEntry.value) {
            const oldToken = oldestEntry.value![0];
            this.unsubscribe(oldToken);
            logger.warn({ evicted: oldToken.slice(0,8) }, '⚠️ Force-evicted token with position for priority');
          }
        }
      } else {
        logger.debug({ token: tokenMint, size: this.subscribedTokens.size }, 'PumpTradeStream at capacity, dropping');
        return;
      }
    }

    // Track expiry (10 min from now, extended if position opens)
    this.tokenExpiry.set(tokenMint, Date.now() + 10 * 60 * 1000);

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
      
      // v10.13: Ensure ALL tokens with open positions are in the re-subscribe list
      if (this.tradeExecutor) {
        const positionTokens = this.tradeExecutor.getOpenPositionTokens?.() || [];
        for (const tok of positionTokens) {
          if (!all.includes(tok)) {
            all.push(tok);
            logger.warn({ token: tok.slice(0,8) }, '🔄 Re-adding missing position token to subscription');
          }
        }
      }
      
      const openCount = this.tradeExecutor ? all.filter(t => this.tradeExecutor!.hasPosition(t)).length : 0;
      logger.info({ total: all.length, openPositions: openCount }, '🔄 PumpTradeStream reconnected — re-subscribing');
      
      this.subscribedTokens.clear();
      this.pendingSubscriptions = [];

      // Batch in groups of 100
      for (let i = 0; i < all.length; i += 100) {
        this.sendSubscribe(all.slice(i, i + 100));
      }
      
      // v10.13: After reconnect, fetch current MC for all open positions
      // If token rugged during the gap, we need to know immediately
      if (this.tradeExecutor && openCount > 0) {
        setTimeout(async () => {
          const posTokens = this.tradeExecutor?.getOpenPositionTokens?.() || [];
          for (const tok of posTokens) {
            try {
              // Fetch latest trade from PumpPortal API
              const res = await fetch(`https://frontend-api-v2.pump.fun/coins/${tok}`, {
                signal: AbortSignal.timeout(5000)
              });
              if (res.ok) {
                const data = await res.json() as any;
                if (data.market_cap) {
                  const mc = data.market_cap * this.solPrice;
                  logger.info({ token: tok.slice(0,8), mc: Math.round(mc) }, 
                    '📡 Post-reconnect MC check');
                  // Feed the MC to TradeExecutor as a synthetic tick
                  this.tradeExecutor?.onTrade(tok, 'buy', mc, 0, 'reconnect_check');
                }
              }
            } catch (e) {
              logger.debug({ token: tok.slice(0,8) }, 'Post-reconnect MC fetch failed');
            }
          }
        }, 5000);
      }
    });

    this.ws.on('message', async (data: WebSocket.Data) => {
      try {
        this.lastMessageAt = Date.now();
        const msg = JSON.parse(data.toString()) as PumpTradeEvent;
        if (msg.txType === 'buy' || msg.txType === 'sell') {
          await this.handleTrade(msg);
        }
      } catch {
        // ignore parse errors
      }
    });

    // v10.13: Track pong responses for dead connection detection
    this.ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });

    this.ws.on('close', (code) => {
      this.isConnected = false;
      this.ws = null;
      const openPositions = this.tradeExecutor ? 
        [...this.subscribedTokens].filter(t => this.tradeExecutor!.hasPosition(t)).length : 0;
      logger.warn({ code, subscribed: this.subscribedTokens.size, openPositions }, 
        '🔌 PumpTradeStream DISCONNECTED — reconnecting...');
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
    const volumeUsd2 = solAmount * this.solPrice;

    // Notify TradeExecutor with live tick data (before DB insert for minimal latency)
    if (this.tradeExecutor) {
      this.tradeExecutor.onTrade(mint, txType, marketCapUsd, volumeUsd2, traderPublicKey, event.tokenAmount, event.newTokenBalance);
    }
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
      // v10: Skip snapshot insert for trade ticks (trade_events is sufficient, saves ~50% DB writes)
      // Update fdv_at_detection if not yet set
      await this.pool.query(
        'UPDATE token_events SET fdv_at_detection = $1 WHERE token_address = $2 AND fdv_at_detection IS NULL',
        [marketCapUsd, mint]
      );

      // Insert trade event for analysis
      await this.pool.query(`
        INSERT INTO trade_events (token_address, tx_type, market_cap_usd, price_usd, volume_usd,
          v_sol, v_tokens, trader_wallet, signature, event_at, token_amount, new_token_balance)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11)
        ON CONFLICT (signature) DO NOTHING
      `, [mint, txType, marketCapUsd, priceUsd, volumeUsd,
          vSolInBondingCurve, vTokensInBondingCurve, traderPublicKey, signature,
          event.tokenAmount, event.newTokenBalance]);

    } catch (err) {
      logger.debug({ err, token: mint }, 'Trade event insert failed');
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [token, expiry] of this.tokenExpiry) {
      if (now > expiry) {
        // v10.10i: Don't unsubscribe if position is still open
        if (this.tradeExecutor && this.tradeExecutor.hasPosition(token)) {
          // Extend expiry by 5 minutes
          this.tokenExpiry.set(token, now + 5 * 60 * 1000);
          continue;
        }
        this.unsubscribe(token);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: this.subscribedTokens.size }, 'PumpTradeStream cleanup');
    }
  }

  private async checkStalePositions(): Promise<void> {
    if (!this.tradeExecutor) return;
    const posTokens = this.tradeExecutor.getOpenPositionTokens?.() || [];
    if (posTokens.length === 0) return;
    
    for (const tok of posTokens) {
      // Only check if token hasn't had a tick in 2+ minutes
      if (!this.subscribedTokens.has(tok)) {
        // Token not even subscribed! Re-subscribe immediately
        logger.warn({ token: tok.slice(0,8) }, '⚠️ Position token NOT subscribed — re-subscribing');
        this.subscribe(tok, true);
      }
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
