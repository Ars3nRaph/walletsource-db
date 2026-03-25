import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { logger } from '../utils/logger.js';
import type { Pool } from 'pg';
import type { TradeSignal } from './TradeExecutor.js';

// ━━━ Constants ━━━
const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJt85qtTWDCR');
const PUMP_FUN_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FUN_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
const RENT_PROGRAM = new PublicKey('SysvarRent111111111111111111111111111111111');

const JITO_TIP_ACCOUNTS = [
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkihtHTYQL',
  'ADaUMid9yfUC67HyGE6yXGpM3rX2axvGz3CQoUYqPJms',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'DttWaMuVvTiDuNER5vNrNLa6xzgiMBT8Wqg2r8p4pXk7',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map(a => new PublicKey(a));

const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// ━━━ Types ━━━
interface LiveTradeConfig {
  privateKey: string;
  rpcUrl: string;
  wsUrl?: string;
  jitoTipLamports: number;
  jitoTipBuyLamports: number;
  jitoTipSellLamports: number;
  useJitoBundle: boolean;
  maxPositionSol: number;
  maxPositionPctWallet: number;
  maxOpenPositions: number;
  maxDailyLossSol: number;
  slippageBps: number;
  computeUnitLimit: number;
  computeUnitPrice: number;
  txTimeoutMs: number;
  maxRetries: number;
  enabled: boolean;
  paperFallback: boolean;
  dryRun: boolean;
}

interface OpenLivePosition {
  tokenMint: string;
  tokenAccount: string;
  entryTxSig: string;
  entryPrice: number;
  entryMC: number;
  entrySol: number;
  tokenAmount: bigint;
  entryTime: Date;
  walletAddress: string;
}

interface TradeResult {
  success: boolean;
  txSignature?: string;
  error?: string;
  solSpent?: number;
  solReceived?: number;
  tokensReceived?: bigint;
  tokensSold?: bigint;
  latencyMs: number;
  jitoBundle?: boolean;
  tipLamports?: number;
  slot?: number;
}

interface DailyStats {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  totalPnlSol: number;
  totalFeeSol: number;
  totalTipSol: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LiveTradeExecutor — Real on-chain trading with Jito bundles
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class LiveTradeExecutor {
  private connection: Connection;
  private keypair: Keypair;
  public config: LiveTradeConfig;
  private pool: Pool;
  private openPositions = new Map<string, OpenLivePosition>();
  private dailyStats: DailyStats;
  private killed = false;
  private jitoEndpointIdx = 0;

  constructor(pool: Pool) {
    this.pool = pool;

    this.config = {
      privateKey:           process.env.TRADING_PRIVATE_KEY || '',
      rpcUrl:               process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com',
      wsUrl:                process.env.SOLANA_WSS_URL,
      jitoTipLamports:      parseInt(process.env.JITO_TIP_LAMPORTS      || '10000'),
      jitoTipBuyLamports:   parseInt(process.env.JITO_TIP_BUY_LAMPORTS  || '100000'),   // 0.00005 SOL — speed critical
      jitoTipSellLamports:  parseInt(process.env.JITO_TIP_SELL_LAMPORTS || '450000'),   // 0.00003 SOL
      useJitoBundle:        process.env.JITO_BUNDLE !== 'false',
      maxPositionSol:       parseFloat(process.env.MAX_POSITION_SOL     || '0.1'),
      maxPositionPctWallet: parseFloat(process.env.MAX_POSITION_PCT     || '0.05'),
      maxOpenPositions:     parseInt(process.env.MAX_OPEN_POSITIONS     || '3'),
      maxDailyLossSol:      parseFloat(process.env.MAX_DAILY_LOSS_SOL   || '1.0'),
      slippageBps:          parseInt(process.env.SLIPPAGE_BPS           || '1500'),     // 15%
      computeUnitLimit:     parseInt(process.env.COMPUTE_UNIT_LIMIT     || '200000'),
      computeUnitPrice:     parseInt(process.env.COMPUTE_UNIT_PRICE     || '50000'),
      txTimeoutMs:          parseInt(process.env.TX_TIMEOUT_MS          || '30000'),
      maxRetries:           parseInt(process.env.TX_MAX_RETRIES         || '2'),
      enabled:              process.env.LIVE_TRADING === 'true',
      paperFallback:        process.env.PAPER_FALLBACK !== 'false',
      dryRun:               process.env.DRY_RUN === 'true',
    };

    this.connection = new Connection(this.config.rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: this.config.wsUrl,
    });

    if (this.config.privateKey) {
      try {
        this.keypair = Keypair.fromSecretKey(bs58.decode(this.config.privateKey));
        logger.info({
          wallet: this.keypair.publicKey.toBase58().slice(0, 8) + '…',
          enabled: this.config.enabled,
          dryRun: this.config.dryRun,
          jito: this.config.useJitoBundle,
          maxPos: this.config.maxPositionSol + ' SOL',
          maxDaily: this.config.maxDailyLossSol + ' SOL loss',
        }, '💰 LiveTradeExecutor initialized');
      } catch {
        logger.error('Invalid TRADING_PRIVATE_KEY — live trading disabled');
        this.keypair = Keypair.generate();
        this.config.enabled = false;
      }
    } else {
      logger.warn('No TRADING_PRIVATE_KEY — live trading disabled');
      this.keypair = Keypair.generate();
      this.config.enabled = false;
    }

    this.dailyStats = this.freshDailyStats();
  }

  // ━━━ PUBLIC API ━━━

  async executeSignal(signal: TradeSignal, tokenMint: string, currentMC: number): Promise<TradeResult | null> {
    if (!this.config.enabled || this.killed) return null;

    if (this.config.dryRun) {
      logger.info({ token: tokenMint.slice(0, 8), action: signal.action }, '🏜️ DRY RUN — skipped');
      return { success: true, latencyMs: 0, txSignature: 'DRY_RUN' };
    }

    this.rotateDailyStats();
    if (this.killed) {
      logger.error('🛑 CIRCUIT BREAKER — daily loss limit hit');
      return null;
    }

    if (signal.action === 'BUY')  return this.executeBuy(tokenMint, signal, currentMC);
    if (signal.action === 'SELL') return this.executeSell(tokenMint, signal);
    return null;
  }

  async emergencyCloseAll(): Promise<void> {
    logger.error('🚨 EMERGENCY CLOSE ALL');
    this.killed = true;
    for (const [mint] of this.openPositions) {
      try { await this.executeSell(mint, { action: 'SELL', confidence: 1, percentage: 100, reason: '🚨 EMERGENCY', playbook_strategy: 'RIDE' }); }
      catch (e) { logger.error({ error: e, token: mint.slice(0, 8) }, 'Emergency close failed'); }
    }
  }

  kill()   { this.killed = true;  logger.error('🛑 KILL SWITCH'); }
  resume() { this.killed = false; logger.info('✅ Trading resumed'); }

  getStatus() {
    return {
      enabled: this.config.enabled, killed: this.killed, dryRun: this.config.dryRun,
      openPositions: this.openPositions.size, dailyStats: { ...this.dailyStats },
      wallet: this.keypair.publicKey.toBase58(),
    };
  }

  async getBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.keypair.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  // ━━━ BUY ━━━

  private async executeBuy(tokenMint: string, signal: TradeSignal, currentMC: number): Promise<TradeResult> {
    const t0 = Date.now();
    try {
      if (this.openPositions.size >= this.config.maxOpenPositions)
        return { success: false, error: `Max ${this.config.maxOpenPositions} positions`, latencyMs: Date.now() - t0 };

      // v10.10j: Use risk-adjusted position from signal, fallback to sizePosition()
      let positionSol = signal.position_sol ?? await this.sizePosition(signal, currentMC);
      positionSol = Math.min(positionSol, this.config.maxPositionSol); // safety cap
      positionSol = Math.max(positionSol, 0.01); // minimum
      if (positionSol <= 0)
        return { success: false, error: 'Position 0', latencyMs: Date.now() - t0 };

      logger.info({ token: tokenMint.slice(0, 8), sol: positionSol.toFixed(4), mc: currentMC.toFixed(0), risk: signal.wallet_risk_score?.toFixed(2) ?? '?' }, '🟢 LIVE BUY');

      const mintPk = new PublicKey(tokenMint);
      const tx = await this.buildBuyTx(mintPk, positionSol);
      const result = await this.send(tx, this.config.jitoTipBuyLamports, 'BUY');

      if (result.success && result.txSignature) {
        const ata = await getAssociatedTokenAddress(mintPk, this.keypair.publicKey);
        this.openPositions.set(tokenMint, {
          tokenMint, tokenAccount: ata.toBase58(),
          entryTxSig: result.txSignature, entryPrice: 0,
          entryMC: currentMC, entrySol: positionSol,
          tokenAmount: result.tokensReceived ?? 0n,
          entryTime: new Date(), walletAddress: '',
        });
        this.dailyStats.trades++;
        this.dailyStats.totalTipSol += this.config.jitoTipBuyLamports / LAMPORTS_PER_SOL;
        await this.dbLog('BUY', tokenMint, positionSol, 0, result.txSignature, signal.reason ?? '');
        logger.info({ token: tokenMint.slice(0, 8), tx: result.txSignature.slice(0, 16), ms: result.latencyMs }, '✅ BUY OK');
      }
      return result;
    } catch (err: any) {
      logger.error({ error: err.message, token: tokenMint.slice(0, 8) }, '❌ BUY FAIL');
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }

  // ━━━ SELL ━━━

  private async executeSell(tokenMint: string, signal: TradeSignal): Promise<TradeResult> {
    const t0 = Date.now();
    const pos = this.openPositions.get(tokenMint);
    if (!pos) return { success: false, error: 'No position', latencyMs: 0 };

    try {
      logger.info({ token: tokenMint.slice(0, 8), reason: signal.reason?.slice(0, 50) }, '🔴 LIVE SELL');

      const mintPk = new PublicKey(tokenMint);
      const tx = await this.buildSellTx(mintPk, pos.tokenAmount);
      const result = await this.send(tx, this.config.jitoTipSellLamports, 'SELL');

      if (result.success) {
        const pnlSol = (result.solReceived ?? 0) - pos.entrySol;
        const pnlPct = pos.entrySol > 0 ? (pnlSol / pos.entrySol * 100) : 0;
        this.dailyStats.trades++;
        this.dailyStats.totalPnlSol += pnlSol;
        this.dailyStats.totalTipSol += this.config.jitoTipSellLamports / LAMPORTS_PER_SOL;
        if (pnlSol > 0) this.dailyStats.wins++; else this.dailyStats.losses++;
        this.openPositions.delete(tokenMint);
        await this.dbLog('SELL', tokenMint, pos.entrySol, result.solReceived ?? 0,
          result.txSignature ?? '', signal.reason ?? '', pnlSol, pnlPct);
        logger.info({
          token: tokenMint.slice(0, 8), pnl: `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`,
          ms: result.latencyMs,
        }, pnlSol >= 0 ? '✅ SELL WIN' : '❌ SELL LOSS');
      }
      return result;
    } catch (err: any) {
      logger.error({ error: err.message, token: tokenMint.slice(0, 8) }, '❌ SELL FAIL — RETRY');
      // Sell failures are critical — retry once
      try { return await this.executeSell(tokenMint, signal); }
      catch { return { success: false, error: err.message, latencyMs: Date.now() - t0 }; }
    }
  }

  // ━━━ PUMP.FUN TX BUILDERS ━━━

  private async buildBuyTx(mint: PublicKey, solAmount: number): Promise<VersionedTransaction> {
    const buyer = this.keypair.publicKey;
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
    const maxSolLamports = lamports + Math.floor(lamports * this.config.slippageBps / 10000);

    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_FUN_PROGRAM_ID
    );
    const bondingCurveAta = await getAssociatedTokenAddress(mint, bondingCurve, true);
    const buyerAta = await getAssociatedTokenAddress(mint, buyer);

    // pump.fun buy discriminator
    const disc = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
    const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(0n); // let program calc
    const maxBuf = Buffer.alloc(8); maxBuf.writeBigUInt64LE(BigInt(maxSolLamports));
    const data = Buffer.concat([disc, amtBuf, maxBuf]);

    const buyIx = new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM_ID,
      keys: [
        { pubkey: PUMP_FUN_GLOBAL,           isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_FEE_RECIPIENT,    isSigner: false, isWritable: true },
        { pubkey: mint,                       isSigner: false, isWritable: false },
        { pubkey: bondingCurve,               isSigner: false, isWritable: true },
        { pubkey: bondingCurveAta,            isSigner: false, isWritable: true },
        { pubkey: buyerAta,                   isSigner: false, isWritable: true },
        { pubkey: buyer,                      isSigner: true,  isWritable: true },
        { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false },
        { pubkey: RENT_PROGRAM,               isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_EVENT_AUTHORITY,   isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM_ID,        isSigner: false, isWritable: false },
      ],
      data,
    });

    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice }),
    ];

    // Create ATA if needed
    try {
      if (!(await this.connection.getAccountInfo(buyerAta))) {
        ixs.push(createAssociatedTokenAccountInstruction(buyer, buyerAta, buyer, mint));
      }
    } catch {
      ixs.push(createAssociatedTokenAccountInstruction(buyer, buyerAta, buyer, mint));
    }

    ixs.push(buyIx);
    if (this.config.useJitoBundle) ixs.push(this.jitoTipIx(this.config.jitoTipBuyLamports));

    return this.buildV0Tx(ixs);
  }

  private async buildSellTx(mint: PublicKey, tokenAmount: bigint): Promise<VersionedTransaction> {
    const seller = this.keypair.publicKey;

    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_FUN_PROGRAM_ID
    );
    const bondingCurveAta = await getAssociatedTokenAddress(mint, bondingCurve, true);
    const sellerAta = await getAssociatedTokenAddress(mint, seller);

    // pump.fun sell discriminator
    const disc = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
    const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(tokenAmount);
    const minBuf = Buffer.alloc(8); minBuf.writeBigUInt64LE(0n); // accept any — speed > slippage for exits
    const data = Buffer.concat([disc, amtBuf, minBuf]);

    const sellIx = new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM_ID,
      keys: [
        { pubkey: PUMP_FUN_GLOBAL,           isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_FEE_RECIPIENT,    isSigner: false, isWritable: true },
        { pubkey: mint,                       isSigner: false, isWritable: false },
        { pubkey: bondingCurve,               isSigner: false, isWritable: true },
        { pubkey: bondingCurveAta,            isSigner: false, isWritable: true },
        { pubkey: sellerAta,                  isSigner: false, isWritable: true },
        { pubkey: seller,                     isSigner: true,  isWritable: true },
        { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_EVENT_AUTHORITY,   isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM_ID,        isSigner: false, isWritable: false },
      ],
      data,
    });

    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice }),
      sellIx,
    ];
    if (this.config.useJitoBundle) ixs.push(this.jitoTipIx(this.config.jitoTipSellLamports));

    return this.buildV0Tx(ixs);
  }

  // ━━━ JITO ━━━

  private jitoTipIx(lamports: number): TransactionInstruction {
    const tip = JITO_TIP_ACCOUNTS[this.jitoEndpointIdx % JITO_TIP_ACCOUNTS.length];
    return SystemProgram.transfer({ fromPubkey: this.keypair.publicKey, toPubkey: tip, lamports });
  }

  private async send(tx: VersionedTransaction, tipLamports: number, side: string): Promise<TradeResult> {
    const t0 = Date.now();
    tx.sign([this.keypair]);

    if (this.config.useJitoBundle) {
      return this.sendJito(tx, tipLamports, t0, side);
    }
    return this.sendRaw(tx, t0, side);
  }

  private async sendJito(tx: VersionedTransaction, tipLamports: number, t0: number, side: string): Promise<TradeResult> {
    const serialized = bs58.encode(tx.serialize());
    const endpoint = JITO_ENDPOINTS[this.jitoEndpointIdx % JITO_ENDPOINTS.length];
    this.jitoEndpointIdx++;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[serialized]] }),
      });
      const json = await res.json() as any;

      if (json.error) {
        logger.warn({ error: json.error, side }, 'Jito error — falling back');
        return this.sendRaw(tx, t0, side);
      }

      const bundleId = json.result;
      logger.info({ bundleId, endpoint: endpoint.split('/')[2], tip: tipLamports, side }, '📦 Jito bundle sent');

      const txSig = await this.confirmBundle(bundleId, endpoint);
      return { success: !!txSig, txSignature: txSig ?? undefined, latencyMs: Date.now() - t0, jitoBundle: true, tipLamports };
    } catch (err: any) {
      logger.warn({ error: err.message, side }, 'Jito failed — fallback');
      return this.sendRaw(tx, t0, side);
    }
  }

  private async confirmBundle(bundleId: string, endpoint: string): Promise<string | null> {
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBundleStatuses', params: [[bundleId]] }),
        });
        const data = await res.json() as any;
        const st = data?.result?.value?.[0];
        if (st?.confirmation_status === 'confirmed' || st?.confirmation_status === 'finalized') {
          logger.info({ bundleId, slot: st.slot, status: st.confirmation_status }, '✅ Jito confirmed');
          return st.transactions?.[0] ?? bundleId;
        }
        if (st?.err) { logger.error({ bundleId, err: st.err }, 'Jito bundle failed'); return null; }
      } catch { /* retry */ }
    }
    logger.warn({ bundleId }, 'Jito confirmation timeout (24s)');
    return null;
  }

  private async sendRaw(tx: VersionedTransaction, t0: number, _side: string): Promise<TradeResult> {
    try {
      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true, maxRetries: this.config.maxRetries,
      });
      const conf = await this.connection.confirmTransaction(sig, 'confirmed');
      if (conf.value.err) return { success: false, txSignature: sig, error: JSON.stringify(conf.value.err), latencyMs: Date.now() - t0, jitoBundle: false };
      return { success: true, txSignature: sig, latencyMs: Date.now() - t0, jitoBundle: false };
    } catch (err: any) {
      return { success: false, error: err.message, latencyMs: Date.now() - t0, jitoBundle: false };
    }
  }

  // ━━━ HELPERS ━━━

  private async buildV0Tx(ixs: TransactionInstruction[]): Promise<VersionedTransaction> {
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: this.keypair.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    return new VersionedTransaction(msg);
  }

  private async sizePosition(signal: TradeSignal, currentMC: number): Promise<number> {
    const balance = await this.getBalance();
    const available = Math.max(0, balance - 0.05); // keep 0.05 SOL for fees
    let size = available * this.config.maxPositionPctWallet;
    size = Math.min(size, this.config.maxPositionSol);
    // MC cap: max 10% of market cap (assume ~$150/SOL)
    const solPrice = parseFloat(process.env.SOL_PRICE_USD || '150');
    size = Math.min(size, currentMC * 0.10 / solPrice);
    // Confidence scaling
    const conf = signal.confidence ?? 0.5;
    if (conf < 0.7) size *= 0.5;
    else if (conf < 0.85) size *= 0.75;
    return size < 0.01 ? 0 : Math.round(size * 10000) / 10000;
  }

  private rotateDailyStats() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyStats.date !== today) this.dailyStats = this.freshDailyStats();
    if (this.dailyStats.totalPnlSol < -this.config.maxDailyLossSol) this.killed = true;
  }

  private freshDailyStats(): DailyStats {
    return { date: new Date().toISOString().slice(0, 10), trades: 0, wins: 0, losses: 0, totalPnlSol: 0, totalFeeSol: 0, totalTipSol: 0 };
  }

  private async dbLog(side: string, mint: string, solIn: number, solOut: number, tx: string, reason: string, pnl?: number, pnlPct?: number) {
    try {
      await this.pool.query(
        `INSERT INTO live_trades (token_address, side, sol_in, sol_out, pnl_sol, pnl_pct, tx_signature, reason, executed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`, [mint, side, solIn, solOut, pnl ?? null, pnlPct ?? null, tx, reason]
      );
    } catch { /* table may not exist yet */ }
  }
}
