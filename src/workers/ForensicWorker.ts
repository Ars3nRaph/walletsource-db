import WebSocket from 'ws';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
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

      // Enqueue for tracking (start immediately in v4.2)
      await this.monitoringRepo.enqueue(tokenMint, creatorWallet, MONITORING_DELAY_MINUTES);

      logger.info({ token: tokenMint, delay_minutes: MONITORING_DELAY_MINUTES }, 'Token enqueued for monitoring');
    } catch (error) {
      logger.error({ error, signature: txData.signature }, 'Failed to process new token');
    }
  }

  private async processNewTokenPumpPortal(message: { mint: string; traderPublicKey: string; signature?: string }): Promise<void> {
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

      // Enqueue for tracking (start immediately in v4.2)
      await this.monitoringRepo.enqueue(tokenMint, creatorWallet, MONITORING_DELAY_MINUTES);

      logger.info({ token: tokenMint, delay_minutes: MONITORING_DELAY_MINUTES }, 'Token enqueued for monitoring');
    } catch (error) {
      logger.error({ error, token: message.mint }, 'Failed to process new token (PumpPortal)');
    }
  }

  // NOTE: buildWalletAncestry() moved to TokenTracker (RUG verdict only) to save Helius credits

  async stop(): Promise<void> {
    this.isShuttingDown = true;

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
