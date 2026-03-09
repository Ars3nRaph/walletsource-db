import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { DexScreenerClient } from '../api/DexScreenerClient.js';
import { HeliusClient } from '../api/HeliusClient.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { MonitoringRepo } from '../repositories/MonitoringRepo.js';
import { CartelRepo } from '../repositories/CartelRepo.js';
import { SnapshotRepo } from '../repositories/SnapshotRepo.js';
import { AncestryRepo } from '../repositories/AncestryRepo.js';
import { TaintScorer } from '../scoring/TaintScorer.js';
import { PlaybookBuilder } from '../scoring/PlaybookBuilder.js';
import { computeToxicity, computeRiskScore, getStrategy } from '../scoring/SigmoidScorer.js';
import { StagnationDetector } from '../execution/StagnationDetector.js';
import { PeakDurationDetector } from '../execution/PeakDurationDetector.js';
import { PaperTradeExecutor } from '../execution/PaperTradeExecutor.js';
import type { TokenSnapshot } from '../types/index.js';

const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds (optimal: excellent data quality, 2× capacity, 60% rate limit)
const TRACKING_DURATION_MS = 10 * 60 * 1000; // 10 minutes (full duration to preserve data quality for playbook building)
const RUG_GRACE_PERIOD_MS = 3 * 60 * 1000; // 3 minutes - continue tracking after RUG detection to collect lifecycle data

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
  private heliusClient: HeliusClient;
  private taintScorer: TaintScorer;
  private playbookBuilder: PlaybookBuilder;
  private stagnationDetector: StagnationDetector;
  private peakDetector: PeakDurationDetector;
  private tradeExecutor: PaperTradeExecutor;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
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
    this.heliusClient = new HeliusClient();
    this.taintScorer = new TaintScorer(pool);
    this.playbookBuilder = new PlaybookBuilder(pool);
    this.stagnationDetector = new StagnationDetector();
    this.peakDetector = new PeakDurationDetector();
    this.tradeExecutor = new PaperTradeExecutor(pool);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('TokenTracker already running');
      return;
    }

    this.isRunning = true;
    logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'TokenTracker starting');

    // Reset orphaned PROCESSING tokens from previous run
    await this.monitoringRepo.resetOrphanedProcessing();

    // Check for due tokens every 10 seconds
    this.intervalId = setInterval(async () => {
      await this.checkDueTokens();
    }, 10 * 1000);

    // Run immediately
    await this.checkDueTokens();
  }

  private async checkDueTokens(): Promise<void> {
    try {
      logger.debug('Checking for due tokens...');
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
          maxCapacity: 135
        }, 'Rate limit check (90% utilization)');

        // Each token consumes 2 req/min (1 per 30s), rate limit = 300 req/min
        // Max capacity = 300 / 2 = 150 tokens theoretical. Use 135 (270 req/min = 90% utilization).
        // With 10min tracking + 30s polling: 135 slots × 6 cycles/h = 810 tokens/h capacity!
        if (activeCount >= 135 || remainingQuota < 30) {
          logger.warn({
            activeCount,
            remainingQuota,
            token: queueItem.token_address
          }, 'Capacity limit reached, re-enqueueing token');

          await this.monitoringRepo.reEnqueue(queueItem.token_address, 5);
          continue;
        }

        logger.info({
          token: queueItem.token_address,
          wallet: queueItem.creator_wallet
        }, 'About to start tracking token');

        // Always track to collect lifecycle data for playbook building
        // (no skip for known ruggers - we need data to improve strategy!)

        // Reserve slot immediately to update activeCount synchronously
        this.activeTracking.set(queueItem.token_address, setInterval(() => {}, 999999));

        // Start tracking this token
        await this.startTracking(queueItem.token_address, queueItem.creator_wallet, queueItem.detected_at);
      }
    } catch (error) {
      logger.error({ error }, 'Error checking due tokens');
    }
  }

  private async startTracking(tokenAddress: string, creatorWallet: string, detectedAt: Date): Promise<void> {
    try {
      // Mark as processing
      await this.monitoringRepo.updateStatus(tokenAddress, 'PROCESSING');

      logger.info({ token: tokenAddress, wallet: creatorWallet }, 'Starting token tracking');

      let snapshotCount = 0;
      const startTime = Date.now();

      // Poll every 60 seconds for 10 minutes
      const pollInterval = setInterval(async () => {
        try {
          snapshotCount++;

          // Fetch current state from DexScreener
          const response = await this.dexScreenerClient.getToken(tokenAddress);
          const pair = response.pairs?.[0];

          const currentFdv = pair?.fdv ?? null;

          // Record snapshot for detectors (v4.2)
          if (currentFdv !== null) {
            this.stagnationDetector.recordSnapshot(tokenAddress, currentFdv);
            this.peakDetector.recordSnapshot(tokenAddress, currentFdv);
          }

          // Store snapshot
          await this.snapshotRepo.insertSnapshot({
            token_address: tokenAddress,
            snapshot_at: new Date(),
            fdv: currentFdv,
            liquidity_usd: pair?.liquidity?.usd ?? null,
            price_usd: pair?.fdv && pair?.liquidity?.usd
              ? pair.fdv / 1000000 // Rough estimate
              : null,
            price_change_5m: pair?.priceChange?.m5 ?? null,
            volume_5m: null, // DexScreener doesn't provide this in current schema
            buy_count_5m: null,
            sell_count_5m: null
          });

          logger.debug({
            token: tokenAddress,
            snapshot: snapshotCount,
            fdv: currentFdv,
            liquidity: pair?.liquidity?.usd
          }, 'Snapshot recorded');

          // Evaluate trade signal in real-time (v4.2)
          if (currentFdv !== null) {
            const elapsedMs = Date.now() - new Date(detectedAt).getTime();
            const elapsedMin = elapsedMs / (60 * 1000);

            await this.tradeExecutor.evaluateTrade(tokenAddress, elapsedMin, currentFdv);
          }

          // EARLY EXIT: Check if RUG detected (no pair, low liquidity, or major dump)
          const isRug = (
            // No pair found (RUG_NO_PAIR)
            response.pairs === null ||
            // Low liquidity (RUG_METRICS)
            (pair?.liquidity?.usd && pair.liquidity.usd < THRESHOLDS.RUG_NO_MARKET_LIQUIDITY) ||
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
                reason: response.pairs === null ? 'NO_PAIR' :
                        pair?.liquidity?.usd && pair.liquidity.usd < THRESHOLDS.RUG_NO_MARKET_LIQUIDITY ? 'LOW_LIQUIDITY' :
                        'DUMP_DETECTED'
              }, 'RUG detected - continuing tracking for lifecycle data collection');
            } else if (now - rugFirstDetected >= RUG_GRACE_PERIOD_MS) {
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

              // Clean up detectors
              this.stagnationDetector.clear(tokenAddress);
              this.peakDetector.clear(tokenAddress);
              return; // Exit polling loop
            }
            // else: still within grace period, continue tracking
          }

          // Check if tracking duration complete (normal exit)
          if (Date.now() - startTime >= TRACKING_DURATION_MS) {
            clearInterval(pollInterval);
            this.activeTracking.delete(tokenAddress);
            this.rugDetectionTime.delete(tokenAddress);

            // Analyze lifecycle and emit verdict
            await this.finalizeTracking(tokenAddress, creatorWallet, detectedAt);

            // Clean up detectors (v4.2)
            this.stagnationDetector.clear(tokenAddress);
            this.peakDetector.clear(tokenAddress);
          }
        } catch (error) {
          logger.error({ error, token: tokenAddress }, 'Error recording snapshot');
        }
      }, POLL_INTERVAL_MS);

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
             peak_time = $16
         WHERE token_address = $17`,
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
    if (maxFdv < THRESHOLDS.RUG_NO_MARKET_FDV && maxLiquidity < THRESHOLDS.RUG_NO_MARKET_LIQUIDITY) {
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

      const transactions = await this.heliusClient.getWalletTransactions(childWallet);
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
