import { TradeExecutor } from '../execution/TradeExecutor.js';
import WebSocket from 'ws';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { PumpTradeStream } from './PumpTradeStream.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { MonitoringRepo } from '../repositories/MonitoringRepo.js';

const PUMP_FUN_PROGRAM_ID = process.env.PUMP_FUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MONITORING_DELAY_MINUTES = 0; // v4.2: start tracking IMMEDIATELY (RUGs happen in 3-7 min)
const RECONNECT_BASE_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;
const MAX_RECONNECT_ATTEMPTS_BEFORE_FALLBACK = 3;
const PUMPPORTAL_WSS_URL = 'wss://pumpportal.fun/api/data';

interface SolanaLogMessage {
  signature: string;
  err: unknown | null;
  logs: string[];
  accounts: string[];
}

export class ForensicWorker {
  private ws: WebSocket | null = null;
  private walletRepo: WalletRepo;
  public pumpTradeStream: PumpTradeStream;
  public tradeExecutor: TradeExecutor | null = null;
  private tokenRepo: TokenEventRepo;
  private monitoringRepo: MonitoringRepo;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private usingFallback = false;

  constructor(pool: Pool) {
    this.walletRepo = new WalletRepo(pool);
    this.tokenRepo = new TokenEventRepo(pool);
    this.monitoringRepo = new MonitoringRepo(pool);
    this.pumpTradeStream = new PumpTradeStream(pool);
  }

  async start(): Promise<void> {
    const wssUrl = process.env.SOLANA_WSS_URL;
    if (!wssUrl) {
      throw new WalletSourceError(
        ErrorCode.WSS_CONNECTION_FAILED,
        'SOLANA_WSS_URL not configured in environment'
      );
    }

    logger.info({ url: wssUrl.replace(/api-key=[^&]+/, 'api-key=***') }, 'ForensicWorker starting');
    await this.pumpTradeStream.start();
    await this.connect(wssUrl);
  }

  private async connect(wssUrl: string): Promise<void> {
    try {
      this.ws = new WebSocket(wssUrl);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        const service = this.usingFallback ? 'PumpPortal' : 'Helius';
        logger.info({ service }, `WebSocket connected to ${service}`);

        // Subscribe based on service
        if (this.usingFallback) {
          // PumpPortal subscription
          const subscribeMessage = {
            method: 'subscribeNewToken'
          };
          this.ws?.send(JSON.stringify(subscribeMessage));
          logger.info('Subscribed to PumpPortal new tokens');
        } else {
          // Helius subscription
          const subscribeMessage = {
            jsonrpc: '2.0',
            id: 1,
            method: 'transactionSubscribe',
            params: [
              {
                accountInclude: [PUMP_FUN_PROGRAM_ID]
              },
              {
                commitment: 'confirmed',
                encoding: 'jsonParsed',
                transactionDetails: 'full',
                showRewards: false,
                maxSupportedTransactionVersion: 0
              }
            ]
          };
          this.ws?.send(JSON.stringify(subscribeMessage));
          logger.info({ programId: PUMP_FUN_PROGRAM_ID }, 'Subscribed to Helius Pump.fun transactions');
        }
      });

      this.ws.on('message', async (data: WebSocket.Data) => {
        try {
          await this.handleMessage(data.toString());
        } catch (error) {
          logger.error({ error }, 'Error handling WebSocket message');
        }
      });

      this.ws.on('error', (error: Error) => {
        logger.error({ error }, 'WebSocket error');
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        logger.warn({ code, reason: reason.toString() }, 'WebSocket closed');
        this.ws = null;

        if (!this.isShuttingDown) {
          this.scheduleReconnect(wssUrl);
        }
      });
    } catch (error) {
      logger.error({ error }, 'Failed to connect WebSocket');
      throw new WalletSourceError(
        ErrorCode.WSS_CONNECTION_FAILED,
        'Failed to connect to Solana WebSocket',
        { error }
      );
    }
  }

  private scheduleReconnect(wssUrl: string): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectAttempts++;

    // Fallback to PumpPortal after multiple failures
    if (!this.usingFallback && this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS_BEFORE_FALLBACK) {
      logger.warn(
        { attempts: this.reconnectAttempts },
        'Multiple Helius connection failures, switching to PumpPortal fallback'
      );
      this.usingFallback = true;
      this.reconnectAttempts = 0;
      this.connect(PUMPPORTAL_WSS_URL).catch((error) => {
        logger.error({ error }, 'PumpPortal connection failed');
      });
      return;
    }

    // Exponential backoff with max delay
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS
    );

    logger.info({ delay, attempt: this.reconnectAttempts, fallback: this.usingFallback }, 'Scheduling WebSocket reconnect');

    this.reconnectTimeout = setTimeout(() => {
      const targetUrl = this.usingFallback ? PUMPPORTAL_WSS_URL : wssUrl;
      this.connect(targetUrl).catch((error) => {
        logger.error({ error }, 'Reconnect failed');
      });
    }, delay);
  }

  private async handleMessage(data: string): Promise<void> {
    try {
      const message = JSON.parse(data);

      if (this.usingFallback) {
        // PumpPortal format
        if (message.txType === 'create' && message.mint && message.traderPublicKey) {
          await this.processNewTokenPumpPortal(message);
        }
      } else {
        // Helius format
        // Subscription confirmation
        if (message.result) {
          logger.debug({ result: message.result }, 'Subscription confirmed');
          return;
        }

        // Transaction notification
        if (message.params && message.params.result) {
          const txData = message.params.result;

          // Check for Pump.fun Create instruction
          if (this.isPumpFunCreateTransaction(txData)) {
            await this.processNewToken(txData);
          }
        }
      }
    } catch (error) {
      logger.error({ error, data: data.substring(0, 200) }, 'Failed to parse WebSocket message');
    }
  }

  private isPumpFunCreateTransaction(txData: SolanaLogMessage): boolean {
    // Check if logs contain the Create instruction marker
    if (!txData.logs || !Array.isArray(txData.logs)) {
      return false;
    }

    return txData.logs.some(log =>
      log.includes('Program log: Instruction: Create')
    );
  }

  private async processNewToken(txData: SolanaLogMessage): Promise<void> {
    try {
      // Extract creator wallet and token mint from transaction accounts
      // accountKeys[0] = creator wallet (signer)
      // accountKeys[1] = token mint
      const accounts = txData.accounts;

      if (!accounts || accounts.length < 2) {
        logger.warn({ signature: txData.signature }, 'Insufficient accounts in Create transaction');
        return;
      }

      const creatorWallet = accounts[0];
      const tokenMint = accounts[1];

      logger.info({ token: tokenMint, wallet: creatorWallet, signature: txData.signature }, 'Token detected');

      // Ensure wallet exists in database
      const existingWallet = await this.walletRepo.getByAddress(creatorWallet);
      const isNewWallet = !existingWallet;

      if (isNewWallet) {
        await this.walletRepo.upsertWallet(creatorWallet);
        logger.info({ wallet: creatorWallet }, 'New wallet created');

        // Ancestry deferred: Build only on RUG verdict (in TaintScorer) to save Helius credits
        // This reduces credit usage from 400k/day to ~50k/day (only for ruggers)
      }

      // Record token event
      await this.tokenRepo.recordEvent(tokenMint, creatorWallet);


      // Determine tracking mode based on wallet history
      const walletProfile = await this.walletRepo.getByAddress(creatorWallet);
      const rugCount = walletProfile?.rug_count ?? 0;
      const strategy = walletProfile?.strategy ?? 'WATCH';

      let trackingMode: 'deep' | 'medium' | 'fast_verdict';
      if (strategy === 'RIDE' || strategy === 'FADE' || strategy === 'AVOID') {
        trackingMode = 'deep'; // Known interesting — full 10s/20min tracking
      } else if (rugCount >= 3) {
        trackingMode = 'medium'; // Known rugger — 30s/10min tracking
      } else {
        trackingMode = 'fast_verdict'; // Unknown/new — 2 checks only (T+3min, T+10min)
      }

      await this.monitoringRepo.enqueue(tokenMint, creatorWallet, MONITORING_DELAY_MINUTES, trackingMode);

      // v8.1: Only subscribe RIDE tokens to trade stream (preserve 100 slots for what matters)
      if (strategy === 'RIDE') {
        this.pumpTradeStream.subscribe(tokenMint);
        logger.info({ token: tokenMint, strategy }, '🎯 RIDE token subscribed to trade stream');
      }

      logger.info({ token: tokenMint, tracking_mode: trackingMode, rug_count: rugCount, strategy }, 'Token enqueued for monitoring');
    } catch (error) {
      logger.error({ error, signature: txData.signature }, 'Failed to process new token');
    }
  }

  private async processNewTokenPumpPortal(message: {
    mint: string;
    traderPublicKey: string;
    signature?: string;
    marketCapSol?: number;
    solAmount?: number;
    initialBuy?: number;
    vSolInBondingCurve?: number;
    vTokensInBondingCurve?: number;
    name?: string;
    symbol?: string;
    uri?: string;
    is_mayhem_mode?: boolean;
  }): Promise<void> {
    try {
      const tokenMint = message.mint;
      const creatorWallet = message.traderPublicKey;

      logger.info({ token: tokenMint, wallet: creatorWallet, signature: message.signature }, 'Token detected (PumpPortal)');

      // Ensure wallet exists in database
      const existingWallet = await this.walletRepo.getByAddress(creatorWallet);
      const isNewWallet = !existingWallet;

      if (isNewWallet) {
        await this.walletRepo.upsertWallet(creatorWallet);
        logger.info({ wallet: creatorWallet }, 'New wallet created');

        // Ancestry deferred: Build only on RUG verdict (in TaintScorer) to save Helius credits
      }

      // Record token event
      await this.tokenRepo.recordEvent(tokenMint, creatorWallet);

      // Store PumpPortal creation data immediately (true block-1 data)
      let entryMcUsd = 0;
      if (message.marketCapSol !== undefined) {
        // Fetch SOL price for USD conversion (cached, 1 req/5min max)
        const solPriceUsd = await this.getSolPrice();
        entryMcUsd = message.marketCapSol * solPriceUsd;

        await this.tokenRepo.pool.query(`
          UPDATE token_events SET
            market_cap_sol_at_creation = $1,
            sol_amount_initial = $2,
            initial_buy_tokens = $3,
            v_sol_in_bonding_curve = $4,
            v_tokens_in_bonding_curve = $5,
            token_name = $6,
            token_symbol = $7,
            is_mayhem_mode = $8,
            sol_price_at_creation = $9,
            fdv_at_detection = $10
          WHERE token_address = $11 AND fdv_at_detection IS NULL
        `, [
          message.marketCapSol,
          message.solAmount ?? null,
          message.initialBuy ?? null,
          message.vSolInBondingCurve ?? null,
          message.vTokensInBondingCurve ?? null,
          message.name ?? null,
          message.symbol ?? null,
          message.is_mayhem_mode ?? false,
          solPriceUsd,
          entryMcUsd,
          tokenMint
        ]);

        logger.info({
          token: tokenMint,
          marketCapSol: message.marketCapSol,
          entryMcUsd: Math.round(entryMcUsd),
          name: message.symbol,
          solPrice: solPriceUsd
        }, 'Block-1 entry MC captured');
      }

      // Determine tracking mode based on wallet history
      const walletProfile = await this.walletRepo.getByAddress(creatorWallet);
      const rugCount = walletProfile?.rug_count ?? 0;
      const strategy = walletProfile?.strategy ?? 'WATCH';

      let trackingMode: 'deep' | 'medium' | 'fast_verdict';
      if (strategy === 'RIDE' || strategy === 'FADE' || strategy === 'AVOID') {
        trackingMode = 'deep'; // Known interesting — full 10s/20min tracking
      } else if (rugCount >= 3) {
        trackingMode = 'medium'; // Known rugger — 30s/10min tracking
      } else {
        trackingMode = 'fast_verdict'; // Unknown/new — 2 checks only (T+3min, T+10min)
      }

      await this.monitoringRepo.enqueue(tokenMint, creatorWallet, MONITORING_DELAY_MINUTES, trackingMode);

      // v8.1: Only subscribe RIDE tokens to trade stream (preserve 100 slots for what matters)
      // Before: subscribed ALL tokens → 1500+/hour → 100 slot cap → RIDE tokens dropped
      // After: only RIDE → ~25/hour → always fits in 100 slots
      if (strategy === 'RIDE') {
        this.pumpTradeStream.subscribe(tokenMint);
        logger.info({ token: tokenMint, strategy }, '🎯 RIDE token subscribed to trade stream');
      }

      // v5.3: No instant entry — phased entry waits for T+3-8s dip after bot spike
      // The tradeExecutor will enter via trade ticks from PumpTradeStream
      if (strategy === 'RIDE' && entryMcUsd && this.tradeExecutor) {
        // Seed the baseline price for the phased entry system
        this.tradeExecutor.onTrade(tokenMint, 'buy', entryMcUsd, 0, 'creator');
        logger.info({ token: tokenMint, wallet: creatorWallet.slice(0, 8), baselineMC: Math.round(entryMcUsd) }, '👁️ RIDE watching — phased entry armed');
      }

      logger.info({ token: tokenMint, tracking_mode: trackingMode, rug_count: rugCount, strategy }, 'Token enqueued for monitoring');
    } catch (error) {
      logger.error({ error, token: message.mint }, 'Failed to process new token (PumpPortal)');
    }
  }

  // SOL price cache (refresh every 5 minutes)
  private cachedSolPrice = 150; // fallback
  private solPriceCachedAt = 0;

  private async getSolPrice(): Promise<number> {
    const now = Date.now();
    if (now - this.solPriceCachedAt < 5 * 60 * 1000) return this.cachedSolPrice;
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
        signal: AbortSignal.timeout(3000)
      });
      const data = await res.json() as { solana?: { usd?: number } };
      if (data?.solana?.usd) {
        this.cachedSolPrice = data.solana.usd;
        this.solPriceCachedAt = now;
      }
    } catch {
      // keep cached value
    }
    return this.cachedSolPrice;
  }

  // NOTE: buildWalletAncestry() moved to TokenTracker (RUG verdict only) to save Helius credits

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    await this.pumpTradeStream.stop();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info('ForensicWorker stopped');
  }
}
