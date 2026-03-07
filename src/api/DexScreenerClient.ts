import fetch from 'node-fetch';
import type { DexScreenerResponse } from '../types/index.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rateLimiter.js';

const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com/latest/dex';
const REQUEST_DELAY_MS = 300;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

export class DexScreenerClient {
  private rateLimiter: RateLimiter;

  constructor() {
    this.rateLimiter = RateLimiter.getInstance();
  }

  async getToken(tokenAddress: string): Promise<DexScreenerResponse> {
    // Acquire rate limit slot
    await this.rateLimiter.acquire();

    let lastError: Error | null = null;

    // Retry with exponential backoff
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Add delay between requests (except first attempt)
        if (attempt > 0) {
          const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
          logger.debug({ attempt, backoffMs, tokenAddress }, 'Retrying DexScreener request');
          await this.sleep(backoffMs);
        }

        const url = `${DEXSCREENER_BASE_URL}/tokens/${tokenAddress}`;
        logger.debug({ url, tokenAddress }, 'Fetching from DexScreener');

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'WalletSourceDB/3.0'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json() as DexScreenerResponse;

        logger.debug({ tokenAddress, hasPairs: data.pairs !== null }, 'DexScreener response received');

        // Add standard delay between requests
        await this.sleep(REQUEST_DELAY_MS);

        return data;
      } catch (error) {
        lastError = error as Error;
        logger.warn({ error, attempt, tokenAddress }, 'DexScreener request failed');

        // If this is the last attempt, throw
        if (attempt === MAX_RETRIES - 1) {
          break;
        }
      }
    }

    // All retries exhausted
    logger.error({ error: lastError, tokenAddress }, 'DexScreener request failed after retries');
    throw new WalletSourceError(
      ErrorCode.API_REQUEST_FAILED,
      `Failed to fetch token ${tokenAddress} from DexScreener after ${MAX_RETRIES} attempts`,
      { error: lastError }
    );
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getRemainingQuota(): number {
    return this.rateLimiter.getRemainingQuota();
  }
}
