import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { DexScreenerClient } from '../api/DexScreenerClient.js';
import { TokenEventRepo } from '../repositories/TokenEventRepo.js';
import { WalletRepo } from '../repositories/WalletRepo.js';
import { MonitoringRepo } from '../repositories/MonitoringRepo.js';
import { CartelRepo } from '../repositories/CartelRepo.js';
import { TaintScorer } from '../scoring/TaintScorer.js';
import { computeToxicity, computeRiskScore, getStrategy } from '../scoring/SigmoidScorer.js';

const SCAN_INTERVAL_MS = 60 * 1000; // 60 seconds
const REQUEST_DELAY_MS = 300;
const REQUEUE_DELAY_MINUTES = 5;

// Verdict thresholds from PRD section 3
const THRESHOLDS = {
  RUG_METRICS_LIQUIDITY: 2000, // USD
  RUG_METRICS_PRICE_CHANGE: -75, // %
  SUCCESS_FDV: 30000, // USD
  SUCCESS_LIQUIDITY: 5000 // USD
};

type Verdict = 'RUG_NO_PAIR' | 'RUG_METRICS' | 'SUCCESS' | 'NEUTRAL';

export class RugScannerWorker {
  private tokenRepo: TokenEventRepo;
  private walletRepo: WalletRepo;
  private monitoringRepo: MonitoringRepo;
  private cartelRepo: CartelRepo;
  private dexScreenerClient: DexScreenerClient;
  private taintScorer: TaintScorer;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(pool: Pool) {
    this.tokenRepo = new TokenEventRepo(pool);
    this.walletRepo = new WalletRepo(pool);
    this.monitoringRepo = new MonitoringRepo(pool);
    this.cartelRepo = new CartelRepo(pool);
    this.dexScreenerClient = new DexScreenerClient();
    this.taintScorer = new TaintScorer(pool);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('RugScannerWorker already running');
      return;
    }

    this.isRunning = true;
    logger.info({ intervalMs: SCAN_INTERVAL_MS }, 'RugScannerWorker starting');

    // Run immediately
    await this.scan();

    // Then run every 60 seconds
    this.intervalId = setInterval(async () => {
      await this.scan();
    }, SCAN_INTERVAL_MS);
  }

  private async scan(): Promise<void> {
    try {
      // Get tokens due for checking
      const dueTokens = await this.monitoringRepo.getDueTokens();

      if (dueTokens.length === 0) {
        logger.debug('No tokens due for scanning');
        return;
      }

      logger.info({ count: dueTokens.length }, 'Scanning due tokens');

      for (const queueItem of dueTokens) {
        try {
          // Mark as processing
          await this.monitoringRepo.updateStatus(queueItem.token_address, 'PROCESSING');

          // Check rate limit
          const remainingQuota = this.dexScreenerClient.getRemainingQuota();
          if (remainingQuota < 10) {
            logger.warn({ remainingQuota }, 'Rate limit low, re-enqueueing token');
            const newCheckAt = new Date(Date.now() + REQUEUE_DELAY_MINUTES * 60 * 1000);
            await this.monitoringRepo.reEnqueue(queueItem.token_address, newCheckAt);
            continue;
          }

          // Fetch token data from DexScreener
          const response = await this.dexScreenerClient.getToken(queueItem.token_address);

          // Determine verdict
          const verdict = this.determineVerdict(response);

          // Extract metrics
          const pair = response.pairs?.[0];
          const fdvAtCheck = pair?.fdv ?? null;
          const liquidityAtCheck = pair?.liquidity?.usd ?? null;
          const priceChange5m = pair?.priceChange?.m5 ?? null;
          const dexscreenerPair = pair?.pairAddress ?? null;

          // Update token_events
          await this.tokenRepo.updateVerdict(
            queueItem.token_address,
            verdict,
            fdvAtCheck,
            liquidityAtCheck,
            priceChange5m,
            dexscreenerPair
          );

          // Update wallet counters
          await this.updateWalletCounters(queueItem.creator_wallet, verdict);

          // Phase 3 - If RUG, propagate taint
          if (verdict === 'RUG_NO_PAIR' || verdict === 'RUG_METRICS') {
            await this.taintScorer.propagate(queueItem.token_address, queueItem.creator_wallet, verdict);
          }

          // Phase 4 - Update wallet scores with sigmoid functions
          await this.updateWalletScores(queueItem.creator_wallet);

          // Mark as processed
          await this.monitoringRepo.markProcessed(queueItem.token_address);

          logger.info({
            token: queueItem.token_address,
            wallet: queueItem.creator_wallet,
            verdict,
            fdv: fdvAtCheck,
            liquidity: liquidityAtCheck
          }, 'Token verdict processed');

          // Add delay between requests
          await this.sleep(REQUEST_DELAY_MS);
        } catch (error) {
          logger.error({ error, token: queueItem.token_address }, 'Failed to process token');

          // Retry logic
          if (queueItem.retry_count < 3) {
            const newCheckAt = new Date(Date.now() + REQUEUE_DELAY_MINUTES * 60 * 1000);
            await this.monitoringRepo.reEnqueue(queueItem.token_address, newCheckAt);
            logger.info({ token: queueItem.token_address, retryCount: queueItem.retry_count + 1 }, 'Token re-enqueued for retry');
          } else {
            await this.monitoringRepo.markProcessed(queueItem.token_address);
            logger.warn({ token: queueItem.token_address }, 'Token failed after max retries');
          }
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error during scan cycle');
    }
  }

  private determineVerdict(response: { pairs: Array<{ fdv?: number; liquidity?: { usd?: number }; priceChange?: { m5?: number } }> | null }): Verdict {
    // No pair found = immediate rug
    if (!response.pairs || response.pairs.length === 0) {
      return 'RUG_NO_PAIR';
    }

    const pair = response.pairs[0];
    const liquidity = pair.liquidity?.usd ?? 0;
    const fdv = pair.fdv ?? 0;
    const priceChange5m = pair.priceChange?.m5 ?? 0;

    // Check for rug based on metrics
    if (liquidity < THRESHOLDS.RUG_METRICS_LIQUIDITY || priceChange5m < THRESHOLDS.RUG_METRICS_PRICE_CHANGE) {
      return 'RUG_METRICS';
    }

    // Check for success
    if (fdv > THRESHOLDS.SUCCESS_FDV && liquidity > THRESHOLDS.SUCCESS_LIQUIDITY) {
      return 'SUCCESS';
    }

    // Otherwise neutral
    return 'NEUTRAL';
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

  /**
   * Update wallet sigmoid scores after verdict.
   * Phase 4: toxicity_score, risk_score, strategy
   */
  private async updateWalletScores(walletAddress: string): Promise<void> {
    try {
      // Get updated wallet data (with new rug_count/taint_score)
      const wallet = await this.walletRepo.getByAddress(walletAddress);
      if (!wallet) {
        logger.warn({ wallet: walletAddress }, 'Wallet not found for score update');
        return;
      }

      // Compute toxicity score from taint
      const toxicityScore = computeToxicity(wallet.taint_score);

      // Get cartel info if wallet belongs to one
      let cartelRugRate = 0;
      if (wallet.cartel_id) {
        const cartel = await this.cartelRepo.getById(wallet.cartel_id);
        cartelRugRate = cartel?.avg_rug_rate ?? 0;
      }

      // Compute risk score
      const riskScore = computeRiskScore(wallet.rug_rate, toxicityScore, cartelRugRate);

      // Determine strategy
      const strategy = getStrategy(riskScore);

      // Update wallet with new scores
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

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;
    logger.info('RugScannerWorker stopped');
  }
}
