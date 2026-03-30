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
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
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
const PUMP_FUN_VOLUME_ACC = new PublicKey('Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y');

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

// ━━━ DYNAMIC JITO TIP ━━━
const JITO_TIP_API = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
const SOL = 1_000_000_000; // lamports per SOL

interface JitoTipCache {
  p50: number; p75: number; p95: number; p99: number;
  fetchedAt: number;
}
let jitoTipCache: JitoTipCache | null = null;

async function fetchJitoTips(): Promise<JitoTipCache> {
  // Cache 30s — évite de spammer l'API
  if (jitoTipCache && Date.now() - jitoTipCache.fetchedAt < 30_000) return jitoTipCache;
  try {
    const res = await fetch(JITO_TIP_API, { signal: AbortSignal.timeout(3000) });
    const [data] = await res.json() as any[];
    jitoTipCache = {
      p50: Math.round((data.landed_tips_50th_percentile ?? 0.000002) * SOL),
      p75: Math.round((data.landed_tips_75th_percentile ?? 0.000005) * SOL),
      p95: Math.round((data.landed_tips_95th_percentile ?? 0.00005)  * SOL),
      p99: Math.round((data.landed_tips_99th_percentile ?? 0.0005)   * SOL),
      fetchedAt: Date.now(),
    };
  } catch {
    // Fallback sur les valeurs statiques si l'API échoue
    jitoTipCache = jitoTipCache ?? { p50: 2000, p75: 5000, p95: 50000, p99: 500000, fetchedAt: Date.now() };
  }
  return jitoTipCache!;
}

// Retourne le tip en lamports selon le mode
async function getDynamicTip(mode: 'buy' | 'sell' | 'urgent'): Promise<number> {
  const tips = await fetchJitoTips();
  const MIN_BUY  = 5_000;    // 0.000005 SOL floor
  const MIN_SELL = 10_000;   // 0.00001 SOL floor (exits critiques)
  switch (mode) {
    case 'buy':    return Math.max(tips.p75, MIN_BUY);   // 75e percentile — bon rapport vitesse/coût
    case 'sell':   return Math.max(tips.p95, MIN_SELL);  // 95e percentile — priorité maximale à la sortie
    case 'urgent': return Math.max(tips.p99, MIN_SELL);  // 99e percentile — stop loss / liquidation urgente
  }
}



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
  buyReason: string;
  realEntrySol: number;
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

  // ═══ OPTIMIZATIONS: cache blockhash + ATA existence ═══
  // Dedup: prevent same token being bought/sold twice in rapid succession
  private recentSignals = new Map<string, number>();

  private blockhashCache: { blockhash: string; fetchedAt: number } = { blockhash: '', fetchedAt: 0 };
  private ataExistsCache = new Set<string>();

  private async getCachedBlockhash(): Promise<string> {
    const now = Date.now();
    if (now - this.blockhashCache.fetchedAt < 30_000 && this.blockhashCache.blockhash) {
      return this.blockhashCache.blockhash;
    }
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    this.blockhashCache = { blockhash, fetchedAt: now };
    return blockhash;
  }

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
            // Pre-warm blockhash cache
    this.getCachedBlockhash().catch(() => {});

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

    // Dedup: skip if same token+action in last 5s
    const dedupKey = `${signal.action}:${tokenMint}`;
    const lastSeen = this.recentSignals.get(dedupKey);
    if (lastSeen && Date.now() - lastSeen < 5000) {
      logger.info({ token: tokenMint, action: signal.action }, '🔄 DEDUP — skipping duplicate signal');
      return null;
    }
    this.recentSignals.set(dedupKey, Date.now());
    // Cleanup old entries
    if (this.recentSignals.size > 100) {
      const cutoff = Date.now() - 10000;
      for (const [k, t] of this.recentSignals) { if (t < cutoff) this.recentSignals.delete(k); }
    }

    if (this.config.dryRun) {
      logger.info({ token: tokenMint, action: signal.action }, '🏜️ DRY RUN — skipped');
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

  private async recoverPositions(): Promise<void> {
    try {
      const { rows } = await this.pool.query(`
        SELECT b.token_address, b.sol_intended, b.sol_actual, b.tx_signature, b.executed_at, b.reason
        FROM live_trades_v2 b
        WHERE b.side = 'BUY' 
          AND b.executed_at > NOW() - INTERVAL '24 hours'
          AND b.token_address NOT IN (
            SELECT s.token_address FROM live_trades_v2 s WHERE s.side = 'SELL' AND s.executed_at > b.executed_at
          )
      `);
      for (const r of rows) {
        if (!this.openPositions.has(r.token_address)) {
          this.openPositions.set(r.token_address, {
            tokenMint: r.token_address,
            tokenAccount: '',
            entryTxSig: r.tx_signature || '',
            entryPrice: 0,
            entryMC: 0,
            entrySol: parseFloat(r.sol_actual || r.sol_intended || '0'),
            tokenAmount: 0n, // unknown — SELL will use max fallback
            entryTime: new Date(r.executed_at),
            walletAddress: this.keypair.publicKey.toBase58(),
            buyReason: r.reason || '',
            realEntrySol: parseFloat(r.sol_actual || '0'),
          });
          logger.info({ token: r.token_address, sol: r.sol_actual }, '♻️ Recovered open position from DB');
        }
      }
      if (rows.length > 0) logger.info({ count: rows.length }, '♻️ Position recovery complete');
    } catch (e: any) { logger.warn({ error: e.message }, 'Position recovery query failed'); }
  }

  async emergencyCloseAll(): Promise<void> {
    logger.error('🚨 EMERGENCY CLOSE ALL');
    this.killed = true;
    for (const [mint] of this.openPositions) {
      try { await this.executeSell(mint, { action: 'SELL', confidence: 1, percentage: 100, reason: '🚨 EMERGENCY', playbook_strategy: 'RIDE' }); }
      catch (e) { logger.error({ error: e, token: mint }, 'Emergency close failed'); }
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

      logger.info({ token: tokenMint, sol: positionSol.toFixed(4), mc: currentMC.toFixed(0), risk: signal.wallet_risk_score?.toFixed(2) ?? '?' }, '🟢 LIVE BUY');

      const mintPk = new PublicKey(tokenMint);
      const tx = await this.buildBuyTx(mintPk, positionSol);
      // Tip dynamique : 75e percentile ou config statique selon env
      const buyTipLamports = process.env.JITO_DYNAMIC_TIP !== 'false'
        ? await getDynamicTip('buy')
        : this.config.jitoTipBuyLamports;
      const result = await this.send(tx, buyTipLamports, 'BUY');

      if (result.success && result.txSignature) {
        const ata = await getAssociatedTokenAddress(mintPk, this.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
        this.openPositions.set(tokenMint, {
          tokenMint, tokenAccount: ata.toBase58(),
          entryTxSig: result.txSignature, entryPrice: 0,
          entryMC: currentMC, entrySol: positionSol,
          tokenAmount: result.tokensReceived ?? 0n,
          entryTime: new Date(), walletAddress: '',
          buyReason: signal.reason ?? "", realEntrySol: 0,
        });
        this.dailyStats.trades++;
        this.dailyStats.totalTipSol += this.config.jitoTipBuyLamports / LAMPORTS_PER_SOL;
        // Parse on-chain en BACKGROUND — ne bloque pas le trade
        const jitoTipSol = this.config.jitoTipBuyLamports / 1e9;
        logger.info({ token: tokenMint, tx: result.txSignature.slice(0, 16), ms: result.latencyMs }, '✅ BUY TX CONFIRMED');
        
        // Fire-and-forget: parse + DB log en arrière-plan
        const txSig = result.txSignature;
        const reason = signal.reason ?? '';
        setImmediate(async () => {
          try {
            const onChainBuy = await this.parseOnChainTx(txSig, this.keypair.publicKey.toBase58());
            const realSolSpent = onChainBuy.parsedOk ? Math.abs(onChainBuy.solDelta) : positionSol;
            const slippageSol  = onChainBuy.parsedOk ? (realSolSpent - positionSol) : 0;

            if (onChainBuy.parsedOk) {
              const pos = this.openPositions.get(tokenMint);
              if (pos) {
                if (onChainBuy.tokenDelta > 0n) pos.tokenAmount = onChainBuy.tokenDelta;
                pos.realEntrySol = Math.abs(onChainBuy.solDelta);
              }
            }

            await this.dbLogFull({
              side: 'BUY', mint: tokenMint, solIn: positionSol, solOut: 0,
              tx: txSig, reason,
              tokensAmount: onChainBuy.tokenDelta,
              feeSol: onChainBuy.feeSol, jitoTipSol, slippageSol,
              slippagePct: positionSol > 0 ? (slippageSol / positionSol * 100) : 0,
              parsedOk: onChainBuy.parsedOk,
              latencyMs: result.latencyMs,
            });
            logger.info({ token: tokenMint, realSol: realSolSpent.toFixed(6), tokens: onChainBuy.tokenDelta.toString().slice(0, 10) }, '📊 BUY on-chain parsed (background)');
          } catch (e: any) { logger.warn({ error: e.message }, 'BUY background parse failed'); }
        });
      }
      return result;
    } catch (err: any) {
      logger.error({ error: err.message, token: tokenMint }, '❌ BUY FAIL');
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }

  // ━━━ SELL ━━━

  private async executeSell(tokenMint: string, signal: TradeSignal): Promise<TradeResult> {
    const t0 = Date.now();
    const pos = this.openPositions.get(tokenMint);
    if (!pos) return { success: false, error: 'No position', latencyMs: 0 };

    try {
      logger.info({ token: tokenMint, reason: signal.reason?.slice(0, 50) }, '🔴 LIVE SELL');

      // Tip dynamique selon urgence: HARD_STOP → urgent (p99), sinon sell (p95)
      const isUrgent = (signal.reason ?? '').includes('HARD_STOP') || (signal.reason ?? '').includes('STOP_LOSS');
      const sellTipMode = isUrgent ? 'urgent' : 'sell';
      const sellTipLamports = process.env.JITO_DYNAMIC_TIP !== 'false'
        ? await getDynamicTip(sellTipMode)
        : this.config.jitoTipSellLamports;

      logger.info({ tip: sellTipLamports, mode: sellTipMode, isUrgent }, '⚡ Jito dynamic tip');

      const mintPk = new PublicKey(tokenMint);
      const tx = await this.buildSellTx(mintPk, pos.tokenAmount);
      const result = await this.send(tx, sellTipLamports, 'SELL');

      if (result.success && result.txSignature) {
        // Parse on-chain — lire le vrai SOL reçu
        const jitoTipSol = this.config.jitoTipSellLamports / 1e9;
        logger.info({ token: tokenMint, tx: result.txSignature.slice(0, 16), ms: result.latencyMs }, '✅ SELL TX CONFIRMED');
        this.openPositions.delete(tokenMint);

        // Parse on-chain en background pour P&L et DB
        const txSig = result.txSignature;
        const sellReason = signal.reason ?? '';
        const entryTxSig = pos.entryTxSig;
        const entrySol = pos.entrySol;
        const realEntry = pos.realEntrySol || pos.entrySol;
        const tokenAmt = pos.tokenAmount;
        const buyReason = pos.buyReason;
        setImmediate(async () => {
          try {
            const onChainSell = await this.parseOnChainTx(txSig, this.keypair.publicKey.toBase58());
            const realSolReceived = onChainSell.parsedOk ? Math.abs(onChainSell.solDelta) : 0;
            const pnlSol = realSolReceived - realEntry;
            const pnlPct = realEntry > 0 ? (pnlSol / realEntry * 100) : 0;
            const slippageSol = onChainSell.parsedOk ? (realSolReceived - entrySol) : 0;

            this.dailyStats.trades++;
            this.dailyStats.totalPnlSol += pnlSol;
            this.dailyStats.totalFeeSol += onChainSell.feeSol;
            this.dailyStats.totalTipSol += jitoTipSol;
            if (pnlSol > 0) this.dailyStats.wins++; else this.dailyStats.losses++;

            await this.dbLogFull({
              side: 'SELL', mint: tokenMint, solIn: entrySol, solOut: realSolReceived,
              tx: txSig, reason: sellReason,
              pnl: pnlSol, pnlPct,
              tokensAmount: tokenAmt,
              feeSol: onChainSell.feeSol,
              jitoTipSol,
              slippageSol,
              slippagePct: entrySol > 0 ? (slippageSol / entrySol * 100) : 0,
              txSigBuy: entryTxSig,
              parsedOk: onChainSell.parsedOk,
              buyReason,
              latencyMs: result.latencyMs,
            });

            logger.info({
              token: tokenMint,
              pnl: `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(6)} SOL`,
              realReceived: realSolReceived.toFixed(6),
              feeSol: onChainSell.feeSol.toFixed(6),
            }, pnlSol >= 0 ? '✅ SELL WIN (background)' : '❌ SELL LOSS (background)');
          } catch (e: any) { logger.warn({ error: e.message }, 'SELL background parse failed'); }
        });
      }
      return result;
    } catch (err: any) {
      logger.error({ error: err.message, token: tokenMint }, '❌ SELL FAIL — RETRY');
      // Sell failures are critical — retry once (but NOT recursively to avoid PumpPortal ban)
      if (!(signal as any)._retried) {
        (signal as any)._retried = true;
        try { return await this.executeSell(tokenMint, signal); }
        catch { /* fall through */ }
      }
      return { success: false, error: err.message, latencyMs: Date.now() - t0 };
    }
  }

  // ━━━ PUMP.FUN TX BUILDERS ━━━

  // ━━━ PumpPortal trade-local API ━━━
  // Builds TX server-side with correct accounts (Token-2022, volume accumulator, etc.)
  
  private async buildBuyTx(mint: PublicKey, solAmount: number): Promise<VersionedTransaction> {
    const buildT0 = Date.now();
    const response = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        publicKey: this.keypair.publicKey.toBase58(),
        action: 'buy',
        mint: mint.toBase58(),
        amount: solAmount,
        denominatedInSol: 'true',
        slippage: Math.floor(this.config.slippageBps / 100),
        priorityFee: 0.00005, // SOL — PumpPortal expects SOL directly
        pool: 'pump',
      }),
    });
    
    if (response.status !== 200) {
      const errText = await response.text();
      throw new Error(`PumpPortal buildBuyTx failed (${response.status}): ${errText}`);
    }
    
    const data = await response.arrayBuffer();
    const tx = VersionedTransaction.deserialize(new Uint8Array(data));
    
    // Add Jito tip if using bundles
    // PumpPortal TX is pre-built, we just sign it
    return tx;
  }

  private async buildSellTx(mint: PublicKey, tokenAmount: bigint): Promise<VersionedTransaction> {
    const buildT0 = Date.now();
    // Convert raw token amount (with decimals) to UI amount
    // pump.fun tokens have 6 decimals
    const uiAmount = Number(tokenAmount) / 1e6;
    
    // If tokenAmount is 0 (BUY parse not finished), sell max by using a huge amount
    // PumpPortal will sell whatever we hold
    const sellAmount = uiAmount > 0 ? uiAmount : 999_999_999_999;
    
    const response = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        publicKey: this.keypair.publicKey.toBase58(),
        action: 'sell',
        mint: mint.toBase58(),
        amount: sellAmount,
        denominatedInSol: 'false',
        slippage: Math.floor(this.config.slippageBps / 100),
        priorityFee: 0.00005, // SOL
        pool: 'pump',
      }),
    });
    
    if (response.status !== 200) {
      const errText = await response.text();
      throw new Error(`PumpPortal buildSellTx failed (${response.status}): ${errText}`);
    }
    
    const data = await response.arrayBuffer();
    const tx = VersionedTransaction.deserialize(new Uint8Array(data));
    return tx;
  }


  private jitoTipIx(lamports: number): TransactionInstruction {
    const tip = JITO_TIP_ACCOUNTS[this.jitoEndpointIdx % JITO_TIP_ACCOUNTS.length];
    return SystemProgram.transfer({ fromPubkey: this.keypair.publicKey, toPubkey: tip, lamports });
  }

  private async send(tx: VersionedTransaction, tipLamports: number, side: string): Promise<TradeResult> {
    const t0 = Date.now();
    tx.sign([this.keypair]);

    // Race: sendRaw + Jito en parallèle — premier confirmé gagne
    // sendRaw est plus fiable (~2s), Jito peut être plus rapide mais souvent timeout
    if (this.config.useJitoBundle) {
      const rawPromise = this.sendRaw(tx, t0, side);
      const jitoPromise = this.sendJito(tx, tipLamports, t0, side).catch(() => null);
      
      // Race: take the first successful result
      const result = await Promise.race([
        rawPromise,
        jitoPromise.then(r => r && r.success ? r : new Promise(() => {})), // never resolve if Jito fails
      ]);
      return result as TradeResult;
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

  private async sendRaw(tx: VersionedTransaction, t0: number, side: string): Promise<TradeResult> {
    try {
      logger.info({ side }, '📡 sendRaw: sending TX...');
      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true, maxRetries: this.config.maxRetries,
      });
      logger.info({ sig: sig.slice(0, 20), side, ms: Date.now() - t0 }, '📡 sendRaw: TX sent, confirming...');
      const conf = await this.connection.confirmTransaction(sig, 'confirmed');
      if (conf.value.err) {
        logger.warn({ sig: sig.slice(0, 20), error: JSON.stringify(conf.value.err), side }, '📡 sendRaw: TX confirmed but FAILED');
        return { success: false, txSignature: sig, error: JSON.stringify(conf.value.err), latencyMs: Date.now() - t0, jitoBundle: false };
      }
      logger.info({ sig: sig.slice(0, 20), side, ms: Date.now() - t0 }, '✅ sendRaw: TX CONFIRMED');
      return { success: true, txSignature: sig, latencyMs: Date.now() - t0, jitoBundle: false };
    } catch (err: any) {
      logger.error({ error: err.message, side, ms: Date.now() - t0 }, '❌ sendRaw: EXCEPTION');
      return { success: false, error: err.message, latencyMs: Date.now() - t0, jitoBundle: false };
    }
  }

  // ━━━ HELPERS ━━━

  private async buildV0Tx(ixs: TransactionInstruction[]): Promise<VersionedTransaction> {
    const blockhash = await this.getCachedBlockhash();
    const msg = new TransactionMessage({ payerKey: this.keypair.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    return new VersionedTransaction(msg);
  }

  private async sizePosition(signal: TradeSignal, currentMC: number): Promise<number> {
    const balance = await this.getBalance();
    const available = Math.max(0, balance - 0.05); // keep 0.05 SOL for fees
    let size = available * this.config.maxPositionPctWallet;
    size = Math.min(size, this.config.maxPositionSol);
    // MC cap: max 10% of market cap (assume ~$150/SOL)
    const solPrice = parseFloat(process.env.SOL_PRICE_USD || '80');
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
  // ━━━ ON-CHAIN PARSE — lit les vraies valeurs depuis la blockchain ━━━

  private async parseOnChainTx(sig: string, walletPubkey: string): Promise<OnChainResult> {
    try {
      // Attendre que la tx soit disponible (jusqu'à 10 tentatives)
      let tx = null;
      for (let i = 0; i < 8; i++) {
        tx = await this.connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (tx) break;
        await new Promise(r => setTimeout(r, i < 3 ? 500 : 1000)); // fast first, then slower
      }
      if (!tx?.meta) return { solDelta: 0, tokenDelta: 0n, feeSol: 0, parsedOk: false };

      // Trouver l'index du wallet dans accountKeys
      const keys = tx.transaction.message.staticAccountKeys ?? 
                   (tx.transaction.message as any).accountKeys ?? [];
      const walletIdx = keys.findIndex((k: any) => k.toBase58() === walletPubkey);
      
      if (walletIdx === -1) return { solDelta: 0, tokenDelta: 0n, feeSol: 0, parsedOk: false };

      // SOL delta réel (pre → post balance)
      const preSol  = (tx.meta.preBalances[walletIdx]  ?? 0) / 1e9;
      const postSol = (tx.meta.postBalances[walletIdx] ?? 0) / 1e9;
      const feeSol  = (tx.meta.fee ?? 0) / 1e9;
      // solDelta inclut les fees — on les sépare pour avoir le montant net d'échange
      const solDelta = postSol - preSol + feeSol; // positif = reçu, négatif = dépensé

      // Token delta (pre → post token balances)
      let tokenDelta = 0n;
      const preTokens  = tx.meta.preTokenBalances  ?? [];
      const postTokens = tx.meta.postTokenBalances ?? [];
      for (const post of postTokens) {
        if (post.owner === walletPubkey) {
          const pre = preTokens.find(p => p.accountIndex === post.accountIndex);
          const preAmt  = BigInt(pre?.uiTokenAmount?.amount  ?? '0');
          const postAmt = BigInt(post.uiTokenAmount?.amount  ?? '0');
          tokenDelta += postAmt - preAmt;
        }
      }

      logger.info({
        sig: sig.slice(0, 16),
        solDelta: solDelta.toFixed(6),
        tokenDelta: tokenDelta.toString(),
        feeSol: feeSol.toFixed(6),
      }, '🔍 On-chain parse OK');

      return { solDelta, tokenDelta, feeSol, parsedOk: true };
    } catch (err: any) {
      logger.warn({ sig: sig.slice(0, 16), error: err.message }, '⚠️ On-chain parse failed');
      return { solDelta: 0, tokenDelta: 0n, feeSol: 0, parsedOk: false };
    }
  }

  // ━━━ DB LOG enrichi avec données on-chain ━━━

  private async dbLogFull(params: {
    side: string; mint: string; solIn: number; solOut: number;
    tx: string; reason: string; pnl?: number; pnlPct?: number;
    tokensAmount?: bigint; feeSol?: number; jitoTipSol?: number;
    slippageSol?: number; slippagePct?: number;
    txSigBuy?: string; parsedOk?: boolean; exitType?: string; pnlGross?: number; buyReason?: string; latencyMs?: number;
  }) {
    try {
      await this.pool.query(`
        INSERT INTO live_trades_v2 
          (token_address, side, sol_intended, sol_out_actual, pnl_sol, pnl_pct, tx_signature,
           reason, jito_bundle, jito_tip_sol, latency_ms,
           sol_actual, tokens_amount, fee_sol,
           slippage_sol, slippage_pct, tx_sig_buy, wallet_address, parsed_ok,
           buy_strategy, strategy_version, exit_type, mc_usd, buyers, ratio, quality_score)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [
          params.mint, params.side, params.solIn, params.solOut,
          params.pnl ?? null, params.pnlPct ?? null, params.tx,
          params.reason, true, params.jitoTipSol ?? (this.config.jitoTipBuyLamports / 1e9), params.latencyMs ?? null,
          Math.abs(params.side === 'BUY' ? (params.solIn + (params.slippageSol ?? 0)) : params.solOut),
          params.tokensAmount ? params.tokensAmount.toString() : null,
          params.feeSol ?? null,
          params.slippageSol ?? null,
          params.slippagePct ?? null,
          params.txSigBuy ?? null,
          this.keypair.publicKey.toBase58(),
          params.parsedOk ?? false,
          // Detect strategy from reason
          (params.buyReason || params.reason).includes('SWARM') ? 'SWARM' : (params.buyReason || params.reason).includes('NEO') ? 'NEO' : (params.buyReason || params.reason).includes('CARTEL') ? 'CARTEL' : 'STD',
          params.reason.match(/v[\d.]+/)?.[0] ?? null,
          params.exitType ?? null,
          // Parse buyers/ratio/quality from reason string
          null, // mc_usd — not reliably available in reason
          (() => { const m = (params.buyReason || params.reason).match(/(\d+)b\s/); return m ? parseInt(m[1]) : null; })(),  // buyers
          (() => { const m = (params.buyReason || params.reason).match(/(\d+\.\d+)x/); return m ? parseFloat(m[1]) : null; })(),  // ratio
          (() => { const m = (params.buyReason || params.reason).match(/Q(\d)/); return m ? parseInt(m[1]) : null; })(),  // quality_score
        ]
      );
    } catch (e: any) {
      logger.warn({ error: e.message }, 'dbLogFull failed');
    }
  }

}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ON-CHAIN TRANSACTION PARSER
// Lit les données réelles depuis la blockchain après confirmation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface OnChainResult {
  solDelta: number;       // SOL réellement échangé (négatif = dépensé, positif = reçu)
  tokenDelta: bigint;     // tokens reçus/vendus
  feeSol: number;         // frais réseau Solana
  parsedOk: boolean;
}
