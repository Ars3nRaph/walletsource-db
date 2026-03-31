import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { DexScreenerClient } from '../api/DexScreenerClient.js';
import { GeckoTerminalClient } from '../api/GeckoTerminalClient.js';
import { HeliusClient } from '../api/HeliusClient.js';
import { FunderLookup } from '../api/FunderLookup.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { MonitoringRepo } from '../repositories/MonitoringRepo.js';
import { CartelRepo } from '../repositories/CartelRepo.js';
import { SnapshotRepo } from '../repositories/SnapshotRepo.js';
import { AncestryRepo } from '../repositories/AncestryRepo.js';
import { TaintScorer } from '../scoring/TaintScorer.js';
import { PlaybookBuilder } from '../scoring/PlaybookBuilder.js';
import { TradeAnalyzer } from '../scoring/TradeAnalyzer.js';
import { computeToxicity, computeRiskScore, getStrategy } from '../scoring/SigmoidScorer.js';
import { StagnationDetector } from '../execution/StagnationDetector.js';
import { PeakDurationDetector } from '../execution/PeakDurationDetector.js';
import { PaperTradeExecutor } from '../execution/PaperTradeExecutor.js';
import type { TokenSnapshot } from '../types/index.js';

const POLL_INTERVAL_MS = 20 * 1000; // 20s: entry via WS onTrade, DexScreener only for playbook/analytics data
const TRACKING_DURATION_MS = 10 * 60 * 1000; // 10 minutes (was 20 — pump.fun action 90% in first 5min, 20min wastes slots)
const RUG_GRACE_PERIOD_MS = 3 * 60 * 1000; // 3 minutes - continue tracking after RUG detection to collect lifecycle data
// Batch mode: DexScreener allows 30 tokens/req. With 10s interval and 25 active tokens:
// Max 1 batch/10s = 6 batches/min = 6 req/min (well within 300/min free limit)

// Verdict thresholds from PRD section 3
const THRESHOLDS = {
  RUG_NO_MARKET_FDV: 500, // USD - dead token (reduced from 5000 to avoid false positives)
  RUG_NO_MARKET_LIQUIDITY: 100, // USD - dead token (reduced from 2000)
  RUG_DUMP_THRESHOLD: 0.50, // 50% drop from peak
  RUG_LIQUIDITY_REMOVED: 0.60, // 60% liquidity removed
  SUCCESS_FDV: 30000, // USD
  SUCCESS_LIQUIDITY: 5000 // USD
};

type Verdict = 'RUG_NO_PAIR' | 'RUG_METRICS' | 'SUCCESS' | 'NEUTRAL';

interface LifecycleAnalysis {
  peak_mc: number | null;
  peak_at: Date | null;
  peak_price: number | null;
  time_to_peak_min: number | null;
  time_to_rug_min: number | null;
  dump_speed_pct_per_min: number | null;
  liquidity_at_peak: number | null;
  liquidity_removed: number | null;
  buy_volume_before_dump: number | null;
  rug_price: number | null;
  price_change_5m: number | null;
  verdict: Verdict;
}

export class TokenTracker {
  private tokenRepo: TokenEventRepo;
  private walletRepo: WalletRepo;
  private monitoringRepo: MonitoringRepo;
  private cartelRepo: CartelRepo;
  private snapshotRepo: SnapshotRepo;
  private ancestryRepo: AncestryRepo;
  private dexScreenerClient: DexScreenerClient;
  private geckoClient: GeckoTerminalClient;
  private heliusClient: HeliusClient;
  private funderLookup: FunderLookup;
  private taintScorer: TaintScorer;
  private playbookBuilder: PlaybookBuilder;
  private tradeAnalyzer: TradeAnalyzer;
  private stagnationDetector: StagnationDetector;
  private peakDetector: PeakDurationDetector;
  public tradeExecutor: PaperTradeExecutor;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private _purgeCounter = 0;
  private activeTracking: Map<string, NodeJS.Timeout> = new Map();
  private rugDetectionTime: Map<string, number> = new Map(); // Track when RUG was first detected

  constructor(pool: Pool) {
    this.tokenRepo = new TokenEventRepo(pool);
    this.walletRepo = new WalletRepo(pool);
    this.monitoringRepo = new MonitoringRepo(pool);
    this.cartelRepo = new CartelRepo(pool);
    this.snapshotRepo = new SnapshotRepo(pool);
    this.ancestryRepo = new AncestryRepo(pool);
    this.dexScreenerClient = new DexScreenerClient();
    this.geckoClient = new GeckoTerminalClient();
    this.heliusClient = new HeliusClient();
    this.funderLookup = new FunderLookup();
    this.taintScorer = new TaintScorer(pool);
    this.playbookBuilder = new PlaybookBuilder(pool);
    this.tradeAnalyzer = new TradeAnalyzer(pool);
    // Wire PumpTradeStream → TradeExecutor for live tick signals
    // (set after both are constructed via start())
    this.stagnationDetector = new StagnationDetector();
    this.peakDetector = new PeakDurationDetector();
    this.tradeExecutor = new PaperTradeExecutor(pool);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('TokenTracker already running');
      return;
    }
    
    // v10.10i: Recover open positions from paper-trades.log after restart
    if (this.tradeExecutor && typeof (this.tradeExecutor as any).recoverOpenPositions === 'function') {
      await (this.tradeExecutor as any).recoverOpenPositions();
    }

    this.isRunning = true;
    logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'TokenTracker starting');

    // Reset orphaned PROCESSING tokens from previous run
    await this.monitoringRepo.resetOrphanedProcessing();

    // Check for due tokens every 10 seconds
    this.intervalId = setInterval(async () => {
      await this.checkDueTokens();
    }, 5 * 1000); // v4.36: faster dequeue (was 10s)

    // Run immediately
    await this.checkDueTokens();
  }

  private async checkDueTokens(): Promise<void> {
    try {
      // Auto-purge stale pending tokens (older than 20min = already dead)
      await this.monitoringRepo.pool.query(`
        UPDATE monitoring_queue
        SET status = 'DONE', processed_at = NOW()
        WHERE status = 'PENDING'
          AND detected_at < NOW() - INTERVAL '20 minutes'
      `);

      // v9.0: Auto-cleanup orphaned PROCESSING tokens not in activeTracking
      // These are left behind when the process restarts mid-tracking
      const orphaned = await this.monitoringRepo.pool.query(`
        SELECT token_address FROM monitoring_queue
        WHERE status = 'PROCESSING'
          AND detected_at < NOW() - INTERVAL '15 minutes'
      `);
      if (orphaned.rows.length > 0) {
        await this.monitoringRepo.pool.query(`
          UPDATE monitoring_queue
          SET status = 'DONE', processed_at = NOW()
          WHERE status = 'PROCESSING'
            AND detected_at < NOW() - INTERVAL '15 minutes'
        `);
        logger.info({ count: orphaned.rows.length }, '🧹 Cleaned orphaned PROCESSING tokens (>15min old)');
      }
      // Also reset recent orphans that aren't in our activeTracking set
      const recentOrphans = await this.monitoringRepo.pool.query(`
        SELECT token_address FROM monitoring_queue
        WHERE status = 'PROCESSING'
      `);
      let resetCount = 0;
      for (const row of recentOrphans.rows) {
        if (!this.activeTracking.has(row.token_address)) {
          await this.monitoringRepo.pool.query(
            "UPDATE monitoring_queue SET status = 'PENDING', check_at = NOW() WHERE token_address = $1 AND status = 'PROCESSING'",
            [row.token_address]
          );
          resetCount++;
        }
      }
      if (resetCount > 0) {
        logger.info({ count: resetCount }, '🧹 Reset orphaned PROCESSING tokens not in activeTracking');
      }

      logger.debug('Checking for due tokens...');
      // v9.2: Recover stuck DONE tokens without verdict (from restart-killed setTimeouts)
      // fast_verdict tokens use setTimeout which dies on PM2 restart
      try {
        const stuckCount = await this.monitoringRepo.pool.query(`
          UPDATE monitoring_queue SET status = 'PENDING', check_at = NOW()
          WHERE status = 'DONE' 
            AND detected_at > NOW() - INTERVAL '15 minutes'
            AND token_address IN (
              SELECT token_address FROM token_events 
              WHERE verdict IS NULL AND tracking_complete = false
            )
          RETURNING token_address
        `);
        if (stuckCount.rowCount && stuckCount.rowCount > 0) {
          logger.info({ count: stuckCount.rowCount }, '🔄 Recovered stuck tokens (DONE without verdict) → re-queued');
        }
      } catch (e) { /* ignore */ }

      // v10: Purge old trade_events and snapshots (every ~1 hour, triggered by counter)
      if (!this._purgeCounter) this._purgeCounter = 0;
      this._purgeCounter++;
      if (this._purgeCounter % 360 === 1) { // every 360 * 10s = 1 hour
        try {
          const purged = await this.monitoringRepo.pool.query(
            "DELETE FROM trade_events WHERE event_at < NOW() - INTERVAL '7 days' RETURNING token_address"
          );
          const snapPurged = await this.monitoringRepo.pool.query(
            "DELETE FROM token_snapshots WHERE snapshot_at < NOW() - INTERVAL '7 days' AND data_source = 'pumpportal_trade' RETURNING token_address"
          );
          if ((purged.rowCount ?? 0) > 0 || (snapPurged.rowCount ?? 0) > 0) {
            logger.info({ trade_events: purged.rowCount, snapshots: snapPurged.rowCount }, '🧹 Retention purge complete');
          }
        } catch (e) { /* ignore */ }
      }

      const dueTokens = await this.monitoringRepo.getDueTokens();

      logger.info({
        count: dueTokens.length,
        activeTracking: this.activeTracking.size
      }, 'Due tokens check result');

      if (dueTokens.length === 0) {
        return;
      }

      logger.info({ count: dueTokens.length }, 'New tokens due for tracking');

      for (const queueItem of dueTokens) {
        logger.debug({
          token: queueItem.token_address,
          checkAt: queueItem.check_at,
          status: queueItem.status
        }, 'Processing due token');

        // Check rate limit capacity
        const remainingQuota = this.dexScreenerClient.getRemainingQuota();
        const activeCount = this.activeTracking.size;

        logger.debug({
          activeCount,
          remainingQuota,
          maxCapacity: 50
        }, 'Rate limit check (90% utilization)');

        // Each token consumes 2 req/min (1 per 30s), rate limit = 300 req/min
        // Max capacity = 300 / 2 = 150 tokens theoretical. Use 135 (270 req/min = 90% utilization).
        // With 10min tracking + 30s polling: 135 slots × 6 cycles/h = 810 tokens/h capacity!
        if (activeCount >= 50 || remainingQuota < 10) { // 50 slots: 20 deep@20s + 30 medium@30s = 100 req/min safe
          // Check if this is a rugger priority token
          const isRuggerToken = false; // ruggerProfiler removed
          if (!isRuggerToken) {
            logger.warn({
              activeCount,
              remainingQuota,
              token: queueItem.token_address
            }, 'Capacity full — dropping stale token');
            await this.monitoringRepo.markProcessed(queueItem.token_address);
            continue;
          }
          logger.info({ token: queueItem.token_address }, '🎯 Rugger priority — bypassing capacity limit');
        }

        logger.info({
          token: queueItem.token_address,
          wallet: queueItem.creator_wallet
        }, 'About to start tracking token');

        // Always track to collect lifecycle data for playbook building
        // (no skip for known ruggers - we need data to improve strategy!)

        // Reserve slot immediately to update activeCount synchronously
        this.activeTracking.set(queueItem.token_address, setInterval(() => {}, 999999));

        // Route to appropriate tracking mode
        const mode = (queueItem as unknown as { tracking_mode?: string }).tracking_mode ?? 'fast_verdict';
        if (mode === 'fast_verdict') {
          // Only 2 checks: T+3min and T+10min — no slot occupation
          this.activeTracking.delete(queueItem.token_address);
          this.startFastVerdict(queueItem.token_address, queueItem.creator_wallet, queueItem.detected_at);
        } else {
          const interval = mode === 'deep' ? POLL_INTERVAL_MS : 30 * 1000;
          const duration = mode === 'deep' ? TRACKING_DURATION_MS : 10 * 60 * 1000;
          await this.startTracking(queueItem.token_address, queueItem.creator_wallet, queueItem.detected_at, interval, duration);
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error checking due tokens');
    }
  }

  private async startTracking(tokenAddress: string, creatorWallet: string, detectedAt: Date, pollIntervalMs: number = POLL_INTERVAL_MS, trackingDurationMs: number = TRACKING_DURATION_MS): Promise<void> {
    try {
      // Mark as processing
      await this.monitoringRepo.updateStatus(tokenAddress, 'PROCESSING');

      logger.info({ token: tokenAddress, wallet: creatorWallet }, 'Starting token tracking');

      let snapshotCount = 0;
      const startTime = Date.now();
      let fdvAtDetectionStored = false; // Fix #1: store first FDV snapshot

      // Poll every 60 seconds for 10 minutes
      const pollInterval = setInterval(async () => {
        try {
          snapshotCount++;

          // Fetch current state: DexScreener primary, GeckoTerminal fallback
          const response = await this.dexScreenerClient.getToken(tokenAddress);
          const pair = response.pairs?.[0];

          let currentFdv = pair?.fdv ?? null;
          let currentLiquidity = pair?.liquidity?.usd ?? null;
          let usedGecko = false;

          // GeckoTerminal fallback: if DexScreener has no pair yet, try GeckoTerminal
          if (!pair && snapshotCount <= 6) {
            try {
              const geckoData = await this.geckoClient.getToken(tokenAddress);
              if (geckoData.hasPair) {
                currentFdv = geckoData.fdv;
                currentLiquidity = geckoData.liquidityUsd;
                usedGecko = true;
                logger.debug({ token: tokenAddress, snapshot: snapshotCount, fdv: currentFdv, liquidity: currentLiquidity }, 'GeckoTerminal fallback used');
              }
            } catch (_geckoErr) {
              // GeckoTerminal failure is non-fatal
            }
          }

          // Record snapshot for detectors (v4.2)
          if (currentFdv !== null) {
            this.stagnationDetector.recordSnapshot(tokenAddress, currentFdv);
            this.peakDetector.recordSnapshot(tokenAddress, currentFdv);
          }

          // Store snapshot — full metrics
          const priceUsd = pair?.priceUsd ? parseFloat(pair.priceUsd) : null;
          await this.snapshotRepo.pool.query(`
            INSERT INTO token_snapshots (
              token_address, snapshot_at,
              fdv, liquidity_usd, price_usd,
              market_cap,
              price_change_5m, price_change_1m, price_change_5m_v2, price_change_1h,
              volume_5m, volume_5m_usd, volume_1m, volume_1h, volume_6h, volume_24h,
              buy_count_5m, sell_count_5m,
              txns_1m_buys, txns_1m_sells,
              txns_5m_buys_v2, txns_5m_sells_v2,
              txns_1h_buys, txns_1h_sells,
              liquidity_base, liquidity_quote,
              pair_created_at, data_source
            ) VALUES (
              $1, NOW(),
              $2, $3, $4,
              $5,
              $6, $7, $8, $9,
              $10, $11, $12, $13, $14, $15,
              $16, $17,
              $18, $19,
              $20, $21,
              $22, $23,
              $24, $25,
              $26, $27
            )
          `, [
            tokenAddress,
            currentFdv,
            currentLiquidity,
            priceUsd,
            // market_cap (DexScreener sometimes has marketCap separate from fdv)
            pair?.marketCap ?? currentFdv,
            // price changes
            usedGecko ? null : (pair?.priceChange?.m5 ?? null),
            usedGecko ? null : (pair?.priceChange?.m1 ?? null),
            usedGecko ? null : (pair?.priceChange?.m5 ?? null),
            usedGecko ? null : (pair?.priceChange?.h1 ?? null),
            // volumes
            usedGecko ? null : (pair?.volume?.m5 ?? null),
            usedGecko ? null : (pair?.volume?.m5 ?? null),
            usedGecko ? null : (pair?.volume?.m1 ?? null),
            usedGecko ? null : (pair?.volume?.h1 ?? null),
            usedGecko ? null : (pair?.volume?.h6 ?? null),
            usedGecko ? null : (pair?.volume?.h24 ?? null),
            // txns 5m
            usedGecko ? null : (pair?.txns?.m5?.buys ?? null),
            usedGecko ? null : (pair?.txns?.m5?.sells ?? null),
            // txns 1m
            usedGecko ? null : (pair?.txns?.m1?.buys ?? null),
            usedGecko ? null : (pair?.txns?.m1?.sells ?? null),
            // txns 5m v2
            usedGecko ? null : (pair?.txns?.m5?.buys ?? null),
            usedGecko ? null : (pair?.txns?.m5?.sells ?? null),
            // txns 1h
            usedGecko ? null : (pair?.txns?.h1?.buys ?? null),
            usedGecko ? null : (pair?.txns?.h1?.sells ?? null),
            // liquidity breakdown
            usedGecko ? null : (pair?.liquidity?.base ?? null),
            usedGecko ? null : (pair?.liquidity?.quote ?? null),
            // pair metadata
            usedGecko ? null : (pair?.pairCreatedAt ?? null),
            usedGecko ? 'gecko' : 'dexscreener'
          ]);

          logger.debug({
            token: tokenAddress,
            snapshot: snapshotCount,
            fdv: currentFdv,
            liquidity: currentLiquidity,
            source: usedGecko ? 'gecko' : 'dexscreener'
          }, 'Snapshot recorded');

          // Fix #1: store fdv_at_detection on first snapshot with valid FDV
          if (!fdvAtDetectionStored && currentFdv !== null && currentFdv > 0) {
            await this.tokenRepo.pool.query(
              `UPDATE token_events SET fdv_at_detection = $1 WHERE token_address = $2 AND fdv_at_detection IS NULL`,
              [currentFdv, tokenAddress]
            );
            fdvAtDetectionStored = true;
          }

          // Evaluate trade signal — skip for RIDE tokens (handled by live PumpTradeStream ticks)
          // DexScreener FDV has artifacts ($25k spikes, $1900 dips) that corrupt stop-loss/trailing
          if (currentFdv !== null && !this.tradeExecutor.isLiveTracked(tokenAddress)) {
            const elapsedMs = Date.now() - new Date(detectedAt).getTime();
            const elapsedMin = elapsedMs / (60 * 1000);

            await this.tradeExecutor.evaluateTrade(tokenAddress, elapsedMin, currentFdv);
          }

          // EARLY EXIT: Check if RUG detected (no pair, low liquidity, or major dump)
          // Fix #1: treat pairs===null OR pairs===[] OR pairs===undefined as RUG_NO_PAIR (unless GeckoTerminal found a pair)
          const noPair = !usedGecko && (response.pairs === null || response.pairs === undefined || response.pairs.length === 0);
          // Fix #2: treat null/undefined liquidity as RUG (token listed but no liquidity = dead)
          const noLiquidity = (pair !== undefined || usedGecko) && (
            currentLiquidity === null ||
            currentLiquidity === undefined ||
            currentLiquidity < THRESHOLDS.RUG_NO_MARKET_LIQUIDITY
          );
          const isRug = (
            // No pair found or empty pairs array (RUG_NO_PAIR)
            noPair ||
            // Low or null liquidity (RUG_METRICS)
            noLiquidity ||
            // Major dump detected (50%+ drop from peak)
            (currentFdv !== null && this.peakDetector.getPeakMC(tokenAddress) &&
             currentFdv < this.peakDetector.getPeakMC(tokenAddress)! * (1 - THRESHOLDS.RUG_DUMP_THRESHOLD))
          );

          if (isRug && snapshotCount >= 3) {
            const now = Date.now();
            const rugFirstDetected = this.rugDetectionTime.get(tokenAddress);

            if (!rugFirstDetected) {
              // First time detecting this RUG - mark timestamp and continue tracking for grace period
              this.rugDetectionTime.set(tokenAddress, now);
              logger.info({
                token: tokenAddress,
                snapshotCount,
                elapsedMin: (now - startTime) / (60 * 1000),
                gracePeriodMin: RUG_GRACE_PERIOD_MS / (60 * 1000),
                reason: noPair ? 'NO_PAIR' :
                        noLiquidity ? 'LOW_OR_NULL_LIQUIDITY' :
                        'DUMP_DETECTED'
              }, 'RUG detected - continuing tracking for lifecycle data collection');
            } else if (now - rugFirstDetected >= RUG_GRACE_PERIOD_MS) {
              // v10.10i: NEVER finalize while a position is open — keep tracking
              const hasPos = this.tradeExecutor.hasPosition(tokenAddress);
              if (hasPos) {
                logger.info({ token: tokenAddress.slice(0, 8) }, '⏳ Rug grace expired but position open — continuing tracking');
                return; // Keep polling, let trade exit normally
              }

              // Grace period elapsed - finalize now
              logger.info({
                token: tokenAddress,
                snapshotCount,
                gracePeriodMin: (now - rugFirstDetected) / (60 * 1000)
              }, 'RUG grace period complete - finalizing with lifecycle data');

              clearInterval(pollInterval);
              this.activeTracking.delete(tokenAddress);
              this.rugDetectionTime.delete(tokenAddress);

              // Analyze lifecycle and emit verdict
              await this.finalizeTracking(tokenAddress, creatorWallet, detectedAt);

              // Clean up detectors + close any open paper position
              this.stagnationDetector.clear(tokenAddress);
              this.peakDetector.clear(tokenAddress);
              // v10.10i: Pass current MC so position closes at real price, not entryMC
              this.tradeExecutor.closePositionIfOpen(tokenAddress, currentFdv ?? undefined);
              return; // Exit polling loop
            }
            // else: still within grace period, continue tracking
          }


          // Check if tracking duration complete (normal exit)
          if (Date.now() - startTime >= trackingDurationMs) {
            // v10.10d: Don't cut tracking if position is still open and in profit
            const hasPos = this.tradeExecutor.hasPosition(tokenAddress);
            if (hasPos) {
              // NEVER stop tracking while a position is open — keep polling indefinitely
              return;
            }

            clearInterval(pollInterval);
            this.activeTracking.delete(tokenAddress);
            this.rugDetectionTime.delete(tokenAddress);

            // Analyze lifecycle and emit verdict
            await this.finalizeTracking(tokenAddress, creatorWallet, detectedAt);

            // Clean up detectors + close any open paper position (v4.3)
            this.stagnationDetector.clear(tokenAddress);
            this.peakDetector.clear(tokenAddress);
            // v10.10i: Pass current MC for accurate exit price
            this.tradeExecutor.closePositionIfOpen(tokenAddress, currentFdv ?? undefined);
          }
        } catch (error) {

          logger.error({ error, token: tokenAddress }, 'Error recording snapshot');
        }
      }, pollIntervalMs);

      // Clear placeholder interval and replace with real polling interval
      const existing = this.activeTracking.get(tokenAddress);
      if (existing) {
        clearInterval(existing);
      }
      this.activeTracking.set(tokenAddress, pollInterval);
    } catch (error) {
      // Clean up placeholder if setup fails
      const existing = this.activeTracking.get(tokenAddress);
      if (existing) {
        clearInterval(existing);
        this.activeTracking.delete(tokenAddress);
      }
      this.rugDetectionTime.delete(tokenAddress);
      logger.error({ error, token: tokenAddress }, 'Failed to start tracking');
    }
  }

  private async finalizeTracking(tokenAddress: string, creatorWallet: string, detectedAt: Date): Promise<void> {
    try {
      logger.info({ token: tokenAddress }, 'Finalizing token tracking');

      // Get all snapshots
      const snapshots = await this.snapshotRepo.getByToken(tokenAddress);

      // Analyze lifecycle
      const analysis = this.analyzeTokenLifecycle(snapshots, detectedAt);

      // Extract peak duration from detector (v4.2)
      const peakDuration = this.peakDetector.getPeakDuration(tokenAddress);
      const peakMC = this.peakDetector.getPeakMC(tokenAddress);
      const peakTime = peakMC && analysis.peak_at ? analysis.peak_at : null;

      // Update token_events with lifecycle data
      await this.tokenRepo.pool.query(
        `UPDATE token_events
         SET checked_at = NOW(),
             verdict = $1,
             fdv_at_check = $2,
             liquidity_at_check = $3,
             peak_mc = $4,
             peak_at = $5,
             time_to_peak_min = $6,
             time_to_rug_min = $7,
             dump_speed_pct_per_min = $8,
             liquidity_at_peak = $9,
             liquidity_removed = $10,
             buy_volume_before_dump = $11,
             peak_price = $12,
             rug_price = $13,
             tracking_complete = TRUE,
             snapshot_count = $14,
             peak_duration_min = $15,
             peak_time = $16,
             price_change_5m = $17
         WHERE token_address = $18`,
        [
          analysis.verdict,
          snapshots[snapshots.length - 1]?.fdv ?? null,
          snapshots[snapshots.length - 1]?.liquidity_usd ?? null,
          analysis.peak_mc,
          analysis.peak_at,
          analysis.time_to_peak_min,
          analysis.time_to_rug_min,
          analysis.dump_speed_pct_per_min,
          analysis.liquidity_at_peak,
          analysis.liquidity_removed,
          analysis.buy_volume_before_dump,
          analysis.peak_price,
          analysis.rug_price,
          snapshots.length,
          peakDuration,
          peakTime,
          analysis.price_change_5m,
          tokenAddress
        ]
      );

      // Update wallet counters
      await this.updateWalletCounters(creatorWallet, analysis.verdict);

      // If RUG, build ancestry (if not exists) then propagate taint
      if (analysis.verdict === 'RUG_NO_PAIR' || analysis.verdict === 'RUG_METRICS') {
        // Build ancestry on-demand for RUG only (saves Helius credits - ~90% reduction)
        const existingAncestry = await this.ancestryRepo.getAncestors(creatorWallet, 1);
        if (existingAncestry.length === 0) {
          logger.info({ wallet: creatorWallet }, 'Building ancestry for RUG wallet (deferred from detection)');
          await this.buildWalletAncestry(creatorWallet);
        }

        await this.taintScorer.propagate(tokenAddress, creatorWallet, analysis.verdict);
      }

      // Update wallet sigmoid scores
      await this.updateWalletScores(creatorWallet);

      // Compute rich trade metrics from trade_events (tick-level data)
      await this.tradeAnalyzer.analyze(tokenAddress, creatorWallet);

      // If RUG, rebuild playbook to update temporal windows
      if (analysis.verdict === 'RUG_NO_PAIR' || analysis.verdict === 'RUG_METRICS') {
        try {
          await this.playbookBuilder.buildPlaybook(creatorWallet);
          logger.debug({ wallet: creatorWallet }, 'Playbook updated after RUG verdict');
        } catch (error) {
          logger.warn({ error, wallet: creatorWallet }, 'Failed to rebuild playbook (non-critical)');
        }
      }

      // Mark as processed
      await this.monitoringRepo.markProcessed(tokenAddress);

      logger.info({
        token: tokenAddress,
        verdict: analysis.verdict,
        peak_mc: analysis.peak_mc,
        time_to_peak: analysis.time_to_peak_min,
        snapshots: snapshots.length
      }, 'Token tracking complete');
    } catch (error) {
      logger.error({ error, token: tokenAddress }, 'Error finalizing tracking');
      await this.monitoringRepo.markProcessed(tokenAddress);
    }
  }

  /**
   * Analyze token lifecycle from snapshots.
   * Detects peak, dump, and calculates all timing metrics.
   */
  private analyzeTokenLifecycle(snapshots: TokenSnapshot[], detectedAt: Date): LifecycleAnalysis {
    if (snapshots.length === 0) {
      return {
        peak_mc: null,
        peak_at: null,
        peak_price: null,
        time_to_peak_min: null,
        time_to_rug_min: null,
        dump_speed_pct_per_min: null,
        liquidity_at_peak: null,
        liquidity_removed: null,
        buy_volume_before_dump: null,
        rug_price: null,
        price_change_5m: null,
        verdict: 'RUG_NO_PAIR'
      };
    }

    // Find peak FDV
    let peakSnapshot: TokenSnapshot | null = null;
    let maxFdv = 0;

    for (const snapshot of snapshots) {
      if (snapshot.fdv && snapshot.fdv > maxFdv) {
        maxFdv = snapshot.fdv;
        peakSnapshot = snapshot;
      }
    }

    // Check for dead token (no market)
    const maxLiquidity = Math.max(...snapshots.map(s => s.liquidity_usd ?? 0));
    // Fix #2: OR instead of AND — a dead token has no FDV OR no liquidity (not necessarily both)
    if (maxFdv < THRESHOLDS.RUG_NO_MARKET_FDV || maxLiquidity < THRESHOLDS.RUG_NO_MARKET_LIQUIDITY) {
      // For RUG_NO_PAIR, calculate timing metrics based on available snapshots
      // This enables playbook building for "fast abandon" ruggers
      const lastSnapshot = snapshots[snapshots.length - 1];

      // For instant rugs (peak_mc=0), set time_to_peak=0 to enable playbook building
      const timeToPeakMin = peakSnapshot
        ? (new Date(peakSnapshot.snapshot_at).getTime() - new Date(detectedAt).getTime()) / (60 * 1000)
        : 0; // Instant rug - no peak, set to 0 instead of null

      const timeToRugMin = lastSnapshot
        ? (new Date(lastSnapshot.snapshot_at).getTime() - new Date(detectedAt).getTime()) / (60 * 1000)
        : null;

      return {
        peak_mc: maxFdv,
        peak_at: peakSnapshot?.snapshot_at ?? null,
        peak_price: peakSnapshot?.price_usd ?? null,
        time_to_peak_min: timeToPeakMin,
        time_to_rug_min: timeToRugMin,
        dump_speed_pct_per_min: null,
        liquidity_at_peak: maxLiquidity,
        liquidity_removed: null,
        buy_volume_before_dump: null,
        rug_price: null,
        price_change_5m: null,
        verdict: 'RUG_NO_PAIR'
      };
    }

    if (!peakSnapshot) {
      return this.defaultAnalysis('NEUTRAL');
    }

    const timeToPeakMs = new Date(peakSnapshot.snapshot_at).getTime() - new Date(detectedAt).getTime();
    const timeToPeakMin = timeToPeakMs / (60 * 1000);

    // Find dump: first snapshot after peak where FDV drops > 50% or liquidity drops > 60%
    let dumpSnapshot: TokenSnapshot | null = null;
    const peakIndex = snapshots.findIndex(s => s.snapshot_at === peakSnapshot!.snapshot_at);

    for (let i = peakIndex + 1; i < snapshots.length; i++) {
      const snapshot = snapshots[i];
      const fdvDrop = snapshot.fdv ? (snapshot.fdv - maxFdv) / maxFdv : 0;
      const liquidityDrop = snapshot.liquidity_usd && peakSnapshot.liquidity_usd
        ? (snapshot.liquidity_usd - peakSnapshot.liquidity_usd) / peakSnapshot.liquidity_usd
        : 0;

      if (fdvDrop < -THRESHOLDS.RUG_DUMP_THRESHOLD || liquidityDrop < -THRESHOLDS.RUG_LIQUIDITY_REMOVED) {
        dumpSnapshot = snapshot;
        break;
      }
    }

    // Calculate metrics
    let timeToRugMin: number | null = null;
    let dumpSpeed: number | null = null;
    let liquidityRemoved: number | null = null;
    let rugPrice: number | null = null;

    if (dumpSnapshot) {
      const timeToRugMs = new Date(dumpSnapshot.snapshot_at).getTime() - new Date(detectedAt).getTime();
      timeToRugMin = timeToRugMs / (60 * 1000);

      const priceDrop = dumpSnapshot.price_usd && peakSnapshot.price_usd
        ? ((dumpSnapshot.price_usd - peakSnapshot.price_usd) / peakSnapshot.price_usd) * 100
        : 0;

      const dumpDuration = timeToRugMin - timeToPeakMin;
      dumpSpeed = dumpDuration > 0 ? priceDrop / dumpDuration : null;

      liquidityRemoved = dumpSnapshot.liquidity_usd && peakSnapshot.liquidity_usd
        ? peakSnapshot.liquidity_usd - dumpSnapshot.liquidity_usd
        : null;

      rugPrice = dumpSnapshot.price_usd;
    }

    // Calculate buy volume before dump (sum of volume_5m before peak)
    const buyVolumeBeforeDump = snapshots
      .slice(0, peakIndex + 1)
      .reduce((sum, s) => sum + (s.volume_5m ?? 0), 0);

    // Determine verdict
    let verdict: Verdict;

    if (dumpSnapshot) {
      verdict = 'RUG_METRICS';
    } else if (maxFdv > THRESHOLDS.SUCCESS_FDV && maxLiquidity > THRESHOLDS.SUCCESS_LIQUIDITY) {
      verdict = 'SUCCESS';
    } else {
      verdict = 'NEUTRAL';
    }

    // Get price_change_5m from last snapshot with a non-null value
    const priceChange5m = [...snapshots].reverse().find(s => s.price_change_5m != null)?.price_change_5m ?? null;

    return {
      peak_mc: maxFdv,
      peak_at: peakSnapshot.snapshot_at,
      peak_price: peakSnapshot.price_usd,
      time_to_peak_min: timeToPeakMin,
      time_to_rug_min: timeToRugMin,
      dump_speed_pct_per_min: dumpSpeed,
      liquidity_at_peak: peakSnapshot.liquidity_usd,
      liquidity_removed: liquidityRemoved,
      buy_volume_before_dump: buyVolumeBeforeDump > 0 ? buyVolumeBeforeDump : null,
      rug_price: rugPrice,
      price_change_5m: priceChange5m,
      verdict
    };
  }

  private defaultAnalysis(verdict: Verdict): LifecycleAnalysis {
    return {
      peak_mc: null,
      peak_at: null,
      peak_price: null,
      time_to_peak_min: null,
      time_to_rug_min: null,
      dump_speed_pct_per_min: null,
      liquidity_at_peak: null,
      liquidity_removed: null,
      buy_volume_before_dump: null,
      rug_price: null,
      price_change_5m: null,
      verdict
    };
  }

  private async updateWalletCounters(walletAddress: string, verdict: Verdict): Promise<void> {
    switch (verdict) {
      case 'RUG_NO_PAIR':
      case 'RUG_METRICS':
        await this.walletRepo.incrementRug(walletAddress);
        break;
      case 'SUCCESS':
        await this.walletRepo.incrementSurvival(walletAddress);
        break;
      case 'NEUTRAL':
        await this.walletRepo.incrementNeutral(walletAddress);
        break;
    }
  }

  private async updateWalletScores(walletAddress: string): Promise<void> {
    try {
      const wallet = await this.walletRepo.getByAddress(walletAddress);
      if (!wallet) {
        return;
      }

      const toxicityScore = computeToxicity(wallet.taint_score);

      let cartelRugRate = 0;
      if (wallet.cartel_id) {
        const cartel = await this.cartelRepo.getById(wallet.cartel_id);
        cartelRugRate = cartel?.avg_rug_rate ?? 0;
      }

      const riskScore = computeRiskScore(wallet.rug_rate, toxicityScore, cartelRugRate);
      const strategy = getStrategy(riskScore);

      await this.walletRepo.updateScores(walletAddress, wallet.taint_score, toxicityScore, riskScore);
      await this.walletRepo.updateStrategy(walletAddress, strategy);

      logger.debug({
        wallet: walletAddress,
        toxicityScore,
        riskScore,
        strategy
      }, 'Wallet scores updated');
    } catch (error) {
      logger.error({ error, wallet: walletAddress }, 'Failed to update wallet scores');
    }
  }

  /**
   * Build wallet ancestry on-demand for RUG wallets only (Helius credit optimization).
   * Called after RUG verdict, before taint propagation.
   *
   * OPTIMIZATION: Check if ancestry already exists before calling Helius API.
   */
  private async buildWalletAncestry(childWallet: string, currentDepth = 0): Promise<void> {
    const MAX_DEPTH = 2; // Reduced from 3 to 2 to limit Helius credit consumption (depth 0, 1, 2 only)
    const MIN_FUNDING_AMOUNT_SOL = 0.01;
    const MIN_CONFIDENCE = 0.7;

    if (currentDepth >= MAX_DEPTH) {
      return;
    }

    try {
      // CRITICAL: Skip if this wallet already has ancestry built (avoid duplicate Helius calls)
      if (currentDepth === 0) {
        const existingLinks = await this.ancestryRepo.getAncestors(childWallet, 1);
        if (existingLinks.length > 0) {
          logger.debug({ wallet: childWallet }, 'Ancestry already exists, skipping Helius call');
          return;
        }
      }

      let transactions;
      try {
        transactions = await this.heliusClient.getWalletTransactions(childWallet);
      } catch {
        // Helius failed — use RPC fallback for funder lookup
        const funderResult = await this.funderLookup.getFunder(childWallet);
        if (funderResult) {
          await this.walletRepo.upsertWallet(funderResult.funder);
          await this.ancestryRepo.addLink(funderResult.funder, childWallet, 'rpc-fallback', funderResult.amountSol, currentDepth, funderResult.confidence);
          if (currentDepth + 1 < MAX_DEPTH) {
            await this.buildWalletAncestry(funderResult.funder, currentDepth + 1);
          }
        }
        return;
      }
      const fundingSources = new Map<string, { amount: number; txHash: string }>();

      for (const tx of transactions) {
        if (!tx.nativeTransfers || tx.nativeTransfers.length === 0) {
          continue;
        }

        for (const transfer of tx.nativeTransfers) {
          if (transfer.toUserAccount !== childWallet) {
            continue;
          }

          const parentWallet = transfer.fromUserAccount;
          const amount = transfer.amount / 1e9;

          if (amount < MIN_FUNDING_AMOUNT_SOL) {
            continue;
          }

          const existing = fundingSources.get(parentWallet);
          if (!existing || amount > existing.amount) {
            fundingSources.set(parentWallet, { amount, txHash: tx.signature });
          }
        }
      }

      for (const [parentWallet, { amount, txHash }] of fundingSources.entries()) {
        await this.walletRepo.upsertWallet(parentWallet);

        const confidence = Math.min(1, amount / 1);
        if (confidence < MIN_CONFIDENCE) {
          continue;
        }

        await this.ancestryRepo.addLink(
          parentWallet,
          childWallet,
          txHash,
          amount,
          currentDepth,
          confidence
        );

        if (confidence >= MIN_CONFIDENCE && currentDepth + 1 < MAX_DEPTH) {
          await this.buildWalletAncestry(parentWallet, currentDepth + 1);
        }
      }
    } catch (error) {
      logger.warn({ error, wallet: childWallet }, 'Failed to build ancestry (non-blocking)');
    }
  }


  // Fast verdict: only 2 lightweight checks (T+3min, T+10min)
  // Uses 2 req/token vs 120 for deep — allows scanning 1400+ tokens/hour for wallet profiling
  private startFastVerdict(tokenAddress: string, creatorWallet: string, detectedAt: Date): void {
    const check = async (label: string) => {
      try {
        // v10.14.1: Use PumpTradeStream liveState (free, tick-by-tick) instead of DexScreener (rate-limited)
        const liveState = this.tradeExecutor?.liveState?.get(tokenAddress);
        let fdv: number | null = liveState?.recentMCs?.length ? liveState.recentMCs[liveState.recentMCs.length - 1] : null;
        let liquidity: number | null = null; // Not available from PumpTradeStream

        // Fallback to DexScreener only if no PumpTradeStream data available
        if (fdv === null) {
          try {
            const response = await this.dexScreenerClient.getToken(tokenAddress);
            const pair = response.pairs?.[0];
            fdv = pair?.fdv ?? null;
            liquidity = pair?.liquidity?.usd ?? null;
          } catch { /* DexScreener fallback failed, skip */ }
        }

        // Store snapshot for verdict
        if (fdv !== null || liquidity !== null) {
          await this.snapshotRepo.pool.query(`
            INSERT INTO token_snapshots (token_address, snapshot_at, fdv, liquidity_usd, data_source)
            VALUES ($1, NOW(), $2, $3, $4)
            ON CONFLICT DO NOTHING
          `, [tokenAddress, fdv, liquidity, liveState ? 'pump_ws' : 'fast_verdict']);
        }

        logger.debug({ token: tokenAddress, label, fdv, source: liveState ? 'ws' : 'dex' }, 'Fast verdict snapshot');
      } catch (err) {
        logger.debug({ token: tokenAddress, label, err }, 'Fast verdict snapshot failed');
      }
    };

    // Check at T+3min
    setTimeout(() => check('T+3min'), 3 * 60 * 1000);

    // Check at T+10min — then run verdict (unless position is open)
    const checkAndFinalize = async () => {
      await check('T+10min');
      
      // NEVER finalize while a position is open — reschedule check in 30s
      if (this.tradeExecutor.hasPosition(tokenAddress)) {
        logger.info({ token: tokenAddress.slice(0, 8) }, '⏳ Fast verdict delayed — position still open');
        setTimeout(checkAndFinalize, 30_000);
        return;
      }
      
      try {
        await this.finalizeTracking(tokenAddress, creatorWallet, detectedAt);
        await this.monitoringRepo.markProcessed(tokenAddress);
      } catch (err) {
        logger.warn({ token: tokenAddress, err }, 'Fast verdict lifecycle analysis failed');
        await this.monitoringRepo.markProcessed(tokenAddress);
      }
    };
    setTimeout(checkAndFinalize, 10 * 60 * 1000);
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Stop all active tracking
    for (const [tokenAddress, intervalId] of this.activeTracking.entries()) {
      clearInterval(intervalId);
      logger.info({ token: tokenAddress }, 'Stopped tracking');
    }
    this.activeTracking.clear();
    this.rugDetectionTime.clear();

    this.isRunning = false;
    logger.info('TokenTracker stopped');
  }
}
