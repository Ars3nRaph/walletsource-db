import WebSocket from 'ws';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { MonitoringRepo } from '../repositories/MonitoringRepo.js';

const PUMP_FUN_PROGRAM_ID = process.env.PUMP_FUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MONITORING_DELAY_MINUTES = 15;
const RECONNECT_BASE_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;

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
        logger.info('WebSocket connected to Helius');

        // Subscribe to Pump.fun program transactions
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
        logger.info({ programId: PUMP_FUN_PROGRAM_ID }, 'Subscribed to Pump.fun transactions');
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

    // Exponential backoff with max delay
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS
    );

    this.reconnectAttempts++;

    logger.info({ delay, attempt: this.reconnectAttempts }, 'Scheduling WebSocket reconnect');

    this.reconnectTimeout = setTimeout(() => {
      this.connect(wssUrl).catch((error) => {
        logger.error({ error }, 'Reconnect failed');
      });
    }, delay);
  }

  private async handleMessage(data: string): Promise<void> {
    try {
      const message = JSON.parse(data);

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
      if (!existingWallet) {
        await this.walletRepo.upsertWallet(creatorWallet);
        logger.info({ wallet: creatorWallet }, 'New wallet created');
      }

      // Record token event
      await this.tokenRepo.recordEvent(tokenMint, creatorWallet);

      // Enqueue for verdict check in 15 minutes
      const checkAt = new Date(Date.now() + MONITORING_DELAY_MINUTES * 60 * 1000);
      await this.monitoringRepo.enqueue(tokenMint, creatorWallet, checkAt);

      logger.info({ token: tokenMint, checkAt }, 'Token enqueued for monitoring');
    } catch (error) {
      logger.error({ error, signature: txData.signature }, 'Failed to process new token');
    }
  }

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
