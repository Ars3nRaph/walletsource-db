import type { Pool } from 'pg';
import { TradeExecutor, type TradeSignal } from './TradeExecutor.js';
import { LiveTradeExecutor } from './LiveTradeExecutor.js';
import { AutoTuner } from './AutoTuner.js';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * PaperTradeExecutor — Paper trading wrapper for TradeExecutor (v4.2 Spot)
 *
 * Logs all BUY/SELL spot trade signals with intelligent exit detection.
 * Tracks stagnation-based exits and temporal window-based exits.
 * Useful for production testing and strategy validation.
 */
export class PaperTradeExecutor extends TradeExecutor {
  private logFilePath: string;
  private paperMode: boolean;
  private liveExecutor: LiveTradeExecutor | null = null;
  private liveMode: boolean;
  private autoTuner: AutoTuner;
  private pendingBuys = new Map<string, { mc: number; time: Date }>();

  constructor(pool: Pool) {
    super(pool);
    this.paperMode = process.env.PAPER_TRADING_MODE === 'true';
    this.liveMode = process.env.LIVE_TRADING === 'true';
    logger.info({ LIVE_TRADING: process.env.LIVE_TRADING, DRY_RUN: process.env.DRY_RUN, liveMode: this.liveMode }, '🔧 Live mode check');
    this.logFilePath = process.env.PAPER_TRADING_LOG_FILE || './data/paper-trades.log';

    if (this.paperMode) {
      logger.info({ logFile: this.logFilePath }, 'Paper trading mode ENABLED');
      this.ensureLogDirectory().catch(error => {
        logger.error({ error }, 'Failed to create paper trading log directory');
      });
    }

    // Initialize AutoTuner
    this.autoTuner = new AutoTuner(pool, {
      tuneEveryN: parseInt(process.env.AUTOTUNE_EVERY_N || '10'),
      minTrades: parseInt(process.env.AUTOTUNE_MIN_TRADES || '10'),
    });

    // Initialize live executor if enabled
    if (this.liveMode) {
      this.liveExecutor = new LiveTradeExecutor(pool);
      logger.info('🔴 LIVE TRADING MODE — real transactions will be executed via Jito');
    }
  }

  /** Get live executor for status/control */
  getLiveExecutor(): LiveTradeExecutor | null { return this.liveExecutor; }
  /** Get auto-tuner for status/manual trigger */
  getAutoTuner(): AutoTuner { return this.autoTuner; }


  /**
   * v10.10i: Recover open positions from paper-trades.log after restart
   * Scans for BUY without matching SELL and restores them to openPositions
   */
  /** Graceful shutdown — save all open positions state to DB before exit */
  async gracefulShutdown(): Promise<void> {
    const openCount = this.openPositions.size;
    if (openCount === 0) return;
    
    logger.warn({ openPositions: openCount }, '⚠️ GRACEFUL SHUTDOWN — saving open positions');
    
    // CRITICAL: In live trading mode, close all positions on-chain BEFORE shutdown
    if (this.liveExecutor && !this.liveExecutor.config?.dryRun) {
      logger.warn({ openPositions: openCount }, '🚨 LIVE MODE — emergency closing all positions on-chain');
      try {
        await this.liveExecutor.emergencyCloseAll();
        logger.info('✅ All live positions closed on-chain');
      } catch (err: any) {
        logger.error({ error: err?.message }, '❌ CRITICAL: Failed to close live positions on shutdown!');
      }
    }
    
    for (const [tok, pos] of this.openPositions.entries()) {
      try {
        const lastMC = pos.tickMCs?.length > 0 ? pos.tickMCs[pos.tickMCs.length - 1] : pos.highestMC || pos.entryMC;
        const pnl = ((lastMC - pos.entryMC) / pos.entryMC * 100);
        
        // Mark position as "shutdown_pending" in DB so recovery knows it was clean
        await this.pool.query(
          `INSERT INTO paper_trades (token_address, action, strategy, timestamp, mc_usd, pnl_pct, exit_type, reason, buy_strategy)
           VALUES ($1, 'SHUTDOWN', 'RIDE', NOW(), $2, $3, 'SHUTDOWN', $4, $5)`,
          [tok, lastMC, pnl,
           'SHUTDOWN: ' + openCount + ' positions saved. Entry MC=' + pos.entryMC.toFixed(0) + ' Peak=' + pos.highestMC.toFixed(0) + ' Last=' + lastMC.toFixed(0),
           (pos as any).ultraStrategy ? 'ULTRA' : (pos as any).ultraStrategy ? 'ULTRA' : (pos as any).swarm3Strategy ? 'SWARM3' : pos.swarmStrategy ? 'SWARM' : pos.neoStrategy ? 'NEO' : pos.cartelStrategy ? 'CARTEL' : 'STD']
        );
        
        logger.info({
          token: tok.slice(0, 8),
          entryMC: pos.entryMC.toFixed(0),
          lastMC: lastMC.toFixed(0),
          pnl: pnl.toFixed(1) + '%',
          strategy: (pos as any).ultraStrategy ? 'ULTRA' : (pos as any).ultraStrategy ? 'ULTRA' : (pos as any).swarm3Strategy ? 'SWARM3' : pos.swarmStrategy ? 'SWARM' : pos.neoStrategy ? 'NEO' : pos.cartelStrategy ? 'CARTEL' : 'STD'
        }, '💾 Position state saved to DB');
      } catch (err: any) {
        logger.error({ token: tok.slice(0, 8), error: err?.message }, 'Failed to save position on shutdown');
      }
    }
  }

  async recoverOpenPositions(): Promise<void> {
    try {
      // v10.14.5: Recover open positions from PostgreSQL (not log file)
      // Find BUY records that have no corresponding SELL
      const openRows = await this.pool.query(`
        SELECT b.token_address, b.mc_usd, b.timestamp, b.reason, b.peak_pct, b.position_sol,
               b.buy_strategy
        FROM paper_trades b
        WHERE b.action = 'BUY'
          AND b.token_address NOT IN (
            SELECT token_address FROM paper_trades WHERE action = 'SELL'
          )
          AND b.timestamp > NOW() - INTERVAL '24 hours'
        ORDER BY b.timestamp DESC
      `);

      // Clean up SHUTDOWN markers from graceful shutdown
      try {
        const shutdownRows = await this.pool.query(
          "SELECT token_address FROM paper_trades WHERE action = 'SHUTDOWN' AND timestamp > NOW() - INTERVAL '30 minutes'"
        );
        if (shutdownRows.rows.length > 0) {
          await this.pool.query("DELETE FROM paper_trades WHERE action = 'SHUTDOWN'");
          logger.info({ count: shutdownRows.rows.length }, '🔄 Found SHUTDOWN entries, cleaning up');
        }
      } catch (dbErr: any) {
        logger.warn({ error: dbErr?.message }, 'Could not check SHUTDOWN entries');
      }

      let recovered = 0;
      for (const row of openRows.rows) {
        const tok = row.token_address;
        if (this.openPositions.has(tok)) continue;

        const entryMC = parseFloat(row.mc_usd) || 5000;
        const peakPct = parseFloat(row.peak_pct) || 0;
        const peakMC = entryMC * (1 + peakPct / 100);
        const buyReason = row.reason || row.buy_strategy || '';

        const isNeoRecovery = buyReason.includes('NEO');
        const isCartelRecovery = buyReason.includes('CARTEL');
        const isEliteRecovery = buyReason.includes('ELITE');
        const isSwarmRecovery = buyReason.includes('SWARM');

        this.openPositions.set(tok, {
          entryMC,
          entryTime: new Date(row.timestamp),
          highestMC: peakMC,
          lowestMCAfterEntry: entryMC,
          tradeCount: 100, // prevent immediate sweep after restart
          walletAddress: '',
          peakTime: Date.now(),
          hadSignificantPump: peakMC > entryMC * 1.2,
          entryBuyVol: 0,
          entryBuyCount: 0,
          entryBuyerCount: 0,
          entrySellersCount: 0,
          staleTicks: 0,
          ceilingHigh: peakMC,
          pumpPeaks: [],
          pumpState: 'PUMP' as const,
          cycleHigh: peakMC,
          dipLow: entryMC,
          tickMCs: [],
          confirmationDone: true,
          neoStrategy: isNeoRecovery,
          cartelStrategy: isCartelRecovery,
          swarmStrategy: isSwarmRecovery,
        });
        recovered++;
        logger.info({
          token: tok.slice(0, 8),
          strategy: isSwarmRecovery ? 'SWARM' : isEliteRecovery ? 'ELITE' : isCartelRecovery ? 'CARTEL' : isNeoRecovery ? 'NEO' : 'STD',
          entryMC: entryMC.toFixed(0),
          peakMC: peakMC.toFixed(0),
        }, '🔄 RECOVERED open position from DB');
      }

      if (recovered > 0) {
        logger.info({ recovered, total: this.openPositions.size }, '🔄 Position recovery complete');
      }
    } catch (err) {
      logger.error({ err }, 'Position recovery failed');
    }
  }

  
  /** Get all open position token addresses (for re-subscribing after recovery) */
  getOpenPositionTokens(): string[] {
    return Array.from(this.openPositions.keys());
  }

  /**
   * Ensure log directory exists
   */
  private async ensureLogDirectory(): Promise<void> {
    const dir = path.dirname(this.logFilePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.error({ error, dir }, 'Failed to create log directory');
    }
  }

  /**
   * Override evaluateTrade to log signals in paper mode
   */
  async evaluateTrade(
    tokenAddress: string,
    elapsedMinutes: number,
    currentMC: number
  ): Promise<TradeSignal> {
    const signal = await super.evaluateTrade(tokenAddress, elapsedMinutes, currentMC);

    // v10.10h: Save live snapshot to DB
    void this.saveSnapshot(tokenAddress, elapsedMinutes * 60, currentMC, signal);

    if (this.paperMode) {
      await this.logPaperTrade(tokenAddress, elapsedMinutes, currentMC, signal);

      // Track completed trades for AutoTuner
      if (signal.action === 'BUY') {
        this.pendingBuys.set(tokenAddress, { mc: currentMC, time: new Date() });
      } else if (signal.action === 'SELL' && this.pendingBuys.has(tokenAddress)) {
        const buy = this.pendingBuys.get(tokenAddress)!;
        this.pendingBuys.delete(tokenAddress);
        const pnlPct = buy.mc > 0 ? ((currentMC - buy.mc) / buy.mc * 100) : 0;
        // Fire-and-forget: notify AutoTuner of completed trade
        this.autoTuner.onTradeCompleted(tokenAddress, pnlPct, signal.reason || '').catch(() => {});
      }
    }

    // Forward BUY/SELL signals to live executor
    if (this.liveExecutor && (signal.action === 'BUY' || signal.action === 'SELL')) {
      try {
        const result = await this.liveExecutor.executeSignal(signal, tokenAddress, currentMC);
        if (result) {
          logger.info({
            action: signal.action,
            token: tokenAddress.slice(0, 8),
            success: result.success,
            tx: result.txSignature?.slice(0, 16),
            ms: result.latencyMs,
            jito: result.jitoBundle,
          }, result.success ? '💰 LIVE TRADE OK' : '⚠️ LIVE TRADE FAIL');
        }
      } catch (err) {
        logger.error({ error: err, token: tokenAddress.slice(0, 8) }, 'Live execution error');
      }
    }

    return signal;
  }

  /**
   * Log paper trade to file (v4.2 spot with stagnation detection)
   */

  /** Forward BUY/SELL signals to LiveTradeExecutor */
  protected onLiveSignal(signal: any, tokenAddress: string, currentMC: number): void {
    if (!this.liveExecutor) return;
    
    // Per-strategy live toggle check
    const reason = signal.reason || signal.playbook_strategy || '';
    const pos = this.openPositions?.get(tokenAddress);
    const isSwarm = reason.includes('SWARM') || pos?.swarmStrategy;
    const isNeo = reason.includes('NEO') || pos?.neoStrategy;
    const isCartel = reason.includes('CARTEL') || pos?.cartelStrategy;
    const isStd = !isSwarm && !isNeo && !isCartel;
    
    // Only block BUY signals — SELL must always go through to close open positions
    if (signal.action === 'BUY') {
      const liveStd = process.env.LIVE_STD === 'true';
      const liveNeo = process.env.LIVE_NEO === 'true';
      const liveSwarm = process.env.LIVE_SWARM === 'true';
      
      if (isStd && !liveStd) return;
      if (isNeo && !liveNeo) return;
      if (isSwarm && !liveSwarm) return;
      if (isCartel) return; // CARTEL always off
    }
    
    this.liveExecutor.executeSignal(signal, tokenAddress, currentMC)
      .then((result: any) => {
        if (result) {
          logger.info({
            action: signal.action,
            token: tokenAddress.slice(0, 8),
            success: result.success,
            tx: result.txSignature?.slice(0, 16),
            ms: result.latencyMs,
            jito: result.jitoBundle,
          }, result.success ? '💰 LIVE TRADE OK' : '⚠️ LIVE TRADE FAIL');
        }
      })
      .catch((err: any) => {
        logger.error({ error: err?.message, token: tokenAddress.slice(0, 8) }, '❌ Live execution error');
      });
  }

  // ═══ TIER EXIT: forward partial sells to LiveTradeExecutor ═══
  protected onTierExit(tokenAddress: string, pctToSell: number, reason: string, currentMC: number): void {
    if (!this.liveExecutor) return;
    if (this.liveExecutor.config?.dryRun) return;
    
    const pos = this.openPositions?.get(tokenAddress);
    const isSwarm = pos?.swarmStrategy;
    const isNeo = pos?.neoStrategy;
    const isStd = !isSwarm && !isNeo;
    
    if (isStd && process.env.LIVE_STD !== 'true') return;
    if (isNeo && process.env.LIVE_NEO !== 'true') return;
    if (isSwarm && process.env.LIVE_SWARM !== 'true') return;
    
    this.liveExecutor.executePartialSell(tokenAddress, pctToSell, reason, currentMC)
      .then((result: any) => {
        if (result?.success) {
          logger.info({ token: tokenAddress.slice(0, 8), pct: Math.round(pctToSell * 100), ms: result.latencyMs }, '🔶 TIER EXIT OK');
        }
      })
      .catch((e: any) => logger.warn({ error: e.message }, '⚠️ Tier exit failed'));
  }

  public onSweepClose(token: string, signal: TradeSignal, mc: number): void {
    // v10.10h: compute elapsed from token detection (consistent with all other log entries)
    const rideEntry = this.rideCache?.get(token);
    const detectedAt = rideEntry?.detectedAt || this.pendingBuys?.get(token)?.time;
    const elapsed = detectedAt ? (Date.now() - new Date(detectedAt).getTime()) / 60000 : 0;
    void this.logPaperTrade(token, elapsed, mc, signal);
    
    // Clean up pendingBuys + notify AutoTuner
    const buyInfo = this.pendingBuys.get(token);
    if (buyInfo) {
      const pnlPct = buyInfo.mc > 0 ? ((mc - buyInfo.mc) / buyInfo.mc * 100) : 0;
      this.autoTuner.onTradeCompleted(token, pnlPct, signal.reason || '').catch(() => {});
      this.pendingBuys.delete(token);
    }
  }

  private async logPaperTrade(
    tokenAddress: string,
    elapsedMinutes: number,
    currentMC: number,
    signal: TradeSignal
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const logEntry: Record<string, any> = {
      timestamp,
      token: tokenAddress,
      elapsed_min: elapsedMinutes.toFixed(2),
      current_mc: currentMC,
      action: signal.action,
      confidence: signal.confidence.toFixed(3),
      percentage: signal.percentage || 0,
      reason: signal.reason,
      strategy: signal.playbook_strategy || 'NONE',
    };
    // v10.10j: Risk-adjusted position sizing
    if (signal.wallet_risk_score !== undefined) logEntry.wallet_risk_score = signal.wallet_risk_score;
    if (signal.position_sol !== undefined) logEntry.position_sol = signal.position_sol;
    if (signal.quality_score !== undefined) logEntry.quality_score = signal.quality_score;

    const logLine = JSON.stringify(logEntry) + '\n';

    try {
      await fs.appendFile(this.logFilePath, logLine);
      logger.info(logEntry, '[PAPER TRADE]');
    } catch (error) {
      logger.error({ error, logEntry }, 'Failed to write paper trade log');
    }

    // Write to paper_trades DB table
    try {
      const reason = signal.reason || '';
      const buyStrategy = reason.includes('ULTRA') ? 'ULTRA' : reason.includes('ELITE') ? 'ELITE' : reason.includes('SWARM v3') ? 'SWARM3' : reason.includes('SWARM') ? 'SWARM' : reason.includes('CARTEL') ? 'CARTEL' : reason.includes('NEO') ? 'NEO' : reason.includes('EARLY') ? 'EARLY' : 'STD';

      if (signal.action === 'BUY') {
        const bm = reason.match(/(\d+)\s*buyers/);
        const rm = reason.match(/([\d.]+)x\s*base/);
        const dm = reason.match(/dumps=(\d+)/);
        const sm = reason.match(/sells=(\d+)\/(\d+)/);
        const th = reason.match(/topHolder=(\d+)%/);
        const ab = reason.match(/avgBuy=\$(\d+)/);

        await this.pool.query(
          `INSERT INTO paper_trades (token_address, action, strategy, timestamp, elapsed_min, mc_usd,
           confidence, position_sol, quality_score, wallet_risk, buyers, ratio, dumps,
           sell_ratio, top_holder_pct, avg_buy_usd, reason, buy_strategy, strategy_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [tokenAddress, 'BUY', signal.playbook_strategy || 'NONE', timestamp,
           elapsedMinutes, currentMC, signal.confidence,
           signal.position_sol || null, signal.quality_score || null, signal.wallet_risk_score || null,
           bm ? parseInt(bm[1]) : null, rm ? parseFloat(rm[1]) : null, dm ? parseInt(dm[1]) : null,
           sm && parseInt(sm[2]) > 0 ? +(parseInt(sm[1]) / parseInt(sm[2])).toFixed(3) : null,
           th ? parseFloat(th[1]) / 100 : null, ab ? parseFloat(ab[1]) : null,
           reason, buyStrategy,
           // v10.14.3: Extract strategy version from reason
           (() => { if (reason.includes('ELITE')) return 'ELITE v1.0';
                    if (reason.includes('ULTRA v7')) return 'ULTRA v7'; if (reason.includes('SWARM v3')) return 'SWARM v3'; if (reason.includes('SWARM')) return 'SWARM v1.2';
                    const vm = reason.match(/NEO (v4\.\d+)/); if (vm) return 'NEO ' + vm[1];
                    const cm = reason.match(/CARTEL (v[\d.]+)/); if (cm) return 'CARTEL ' + cm[1];
                    if (reason.includes('CARTEL')) return 'CARTEL v1.2';
                    if (buyStrategy === 'STD') return 'STD v10.19'; // CARTEL v2.3 = DISABLED
                    return buyStrategy; })()]
        );
      } else if (signal.action === 'SELL') {
        // Determine buy_strategy from the original BUY record (RT exits don't include strategy in reason)
        let sellBuyStrategy = buyStrategy; // default from reason parsing
        let sellStrategyVersion = sellBuyStrategy;
        try {
          const buyRow = await this.pool.query(
            "SELECT buy_strategy, strategy_version FROM paper_trades WHERE token_address = $1 AND action = 'BUY' ORDER BY timestamp DESC LIMIT 1",
            [tokenAddress]
          );
          if (buyRow.rows.length > 0) {
            sellBuyStrategy = buyRow.rows[0].buy_strategy;
            sellStrategyVersion = buyRow.rows[0].strategy_version || sellBuyStrategy;
          }
        } catch (_) {}
        
        let exitType = 'OTHER';
        if (reason.includes('HARD_STOP')) exitType = 'HARD_STOP';
        else if (reason.includes('RT-TRAIL')) exitType = 'RT-TRAIL';
        else if (reason.includes('PUMP3')) exitType = 'PUMP3';
        else if (reason.includes('MAX_HOLD')) exitType = 'MAX_HOLD';
        else if (reason.includes('SELLER_PRESSURE') || reason.includes('SP_EXIT')) exitType = 'SELLER_PRESSURE';
        else if (reason.includes('TRACKING END') || reason.includes('TRACKING_END')) exitType = 'TRACKING_END';
        else if (reason.includes('STALE_EXIT')) exitType = 'STALE_EXIT';
        else if (reason.includes('SWEEP')) exitType = 'SWEEP_EXIT';
        else if (reason.includes('LOWER_HIGH')) exitType = 'LOWER_HIGH';
        else if (reason.includes('SELL_DOM_60s')) exitType = 'SELL_DOM_60s';

        const pm = reason.match(/P&L\s+([+-]?[\d.]+)%/) || reason.match(/HARD_STOP\s+([+-]?[\d.]+)%/);
        const cm = reason.match(/captured\s+~?([\d.]+)%/);
        const pk = reason.match(/peak\s+\+?([\d.]+)%/);
        const pnlPct = pm ? parseFloat(pm[1]) : (cm ? parseFloat(cm[1]) : null);

        await this.pool.query(
          `INSERT INTO paper_trades (token_address, action, strategy, timestamp, elapsed_min, mc_usd,
           confidence, exit_type, pnl_pct, peak_pct, reason, buy_strategy, strategy_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [tokenAddress, 'SELL', signal.playbook_strategy || 'NONE', timestamp,
           elapsedMinutes, currentMC, signal.confidence,
           exitType, pnlPct, pk ? parseFloat(pk[1]) : null,
           reason, sellBuyStrategy, sellStrategyVersion]
        );
      }
    } catch (dbErr: any) {
      logger.error({ error: dbErr?.message }, 'Failed to insert paper trade into DB');
    }
  }

  /**
   * Get statistics from paper trading log
   */
  async getPaperTradingStats(): Promise<{
    total_signals: number;
    by_action: Record<string, number>;
    by_strategy: Record<string, number>;
    avg_confidence: number;
  }> {
    try {
      const content = await fs.readFile(this.logFilePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      const entries = lines.map(line => JSON.parse(line));

      const byAction: Record<string, number> = {};
      const byStrategy: Record<string, number> = {};
      let totalConfidence = 0;

      for (const entry of entries) {
        byAction[entry.action] = (byAction[entry.action] || 0) + 1;
        byStrategy[entry.strategy] = (byStrategy[entry.strategy] || 0) + 1;
        totalConfidence += parseFloat(entry.confidence);
      }

      return {
        total_signals: entries.length,
        by_action: byAction,
        by_strategy: byStrategy,
        avg_confidence: entries.length > 0 ? totalConfidence / entries.length : 0
      };
    } catch (error) {
      logger.error({ error }, 'Failed to read paper trading stats');
      return {
        total_signals: 0,
        by_action: {},
        by_strategy: {},
        avg_confidence: 0
      };
    }
  }
}
