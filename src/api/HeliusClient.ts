import fetch, { type Response } from 'node-fetch';
import { logger } from '../utils/logger.js';
import { ErrorCode, WalletSourceError } from '../types/errors.js';
import type { HeliusTransaction } from '../types/index.js';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const HELIUS_CREDITS_PER_CALL = 5;
const MONTHLY_CREDIT_LIMIT = 1_000_000; // Free tier

export class HeliusClient {
  private apiKey: string;
  private creditsUsedToday = 0;
  private lastResetDate: Date;

  constructor() {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      throw new WalletSourceError(
        ErrorCode.API_REQUEST_FAILED,
        'HELIUS_API_KEY not configured in environment'
      );
    }

    this.apiKey = apiKey;
    this.lastResetDate = new Date();
  }

  /**
   * Get wallet transactions to discover funding sources (ancestry).
   * Returns native SOL transfers to map parent → child wallet relationships.
   *
   * @param address - Wallet address to query
   * @returns Array of Helius transactions with native transfers
   */
  async getWalletTransactions(address: string): Promise<HeliusTransaction[]> {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${this.apiKey}&type=TRANSFER`;

    try {
      const response = await this.fetchWithRetry(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const transactions: HeliusTransaction[] = await response.json() as HeliusTransaction[];

      // Track credit usage
      this.creditsUsedToday += HELIUS_CREDITS_PER_CALL;
      this.checkDailyLimit();

      logger.debug({
        address,
        txCount: transactions.length,
        creditsUsed: this.creditsUsedToday
      }, 'Helius transactions fetched');

      return transactions;
    } catch (error) {
      logger.error({ error, address }, 'Failed to fetch Helius transactions');
      throw new WalletSourceError(
        ErrorCode.API_REQUEST_FAILED,
        `Failed to fetch transactions for ${address}`,
        { error }
      );
    }
  }

  /**
   * Fetch with exponential backoff retry logic.
   */
  private async fetchWithRetry(url: string, retries = 0): Promise<Response> {
    try {
      const response = await fetch(url);

      // Retry on 5xx errors
      if (response.status >= 500 && retries < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retries);
        logger.warn({ status: response.status, retries, delay }, 'Helius API error, retrying');
        await this.sleep(delay);
        return this.fetchWithRetry(url, retries + 1);
      }

      return response;
    } catch (error) {
      if (retries < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retries);
        logger.warn({ error, retries, delay }, 'Helius API network error, retrying');
        await this.sleep(delay);
        return this.fetchWithRetry(url, retries + 1);
      }

      throw error;
    }
  }

  /**
   * Check if approaching monthly credit limit.
   */
  private checkDailyLimit(): void {
    // Reset counter daily
    const now = new Date();
    if (now.getDate() !== this.lastResetDate.getDate()) {
      this.creditsUsedToday = 0;
      this.lastResetDate = now;
    }

    // Estimate monthly usage (30 days)
    const estimatedMonthlyUsage = this.creditsUsedToday * 30;

    if (estimatedMonthlyUsage > MONTHLY_CREDIT_LIMIT * 0.8) {
      logger.warn({
        creditsToday: this.creditsUsedToday,
        estimatedMonthly: estimatedMonthlyUsage,
        limit: MONTHLY_CREDIT_LIMIT
      }, 'Approaching Helius monthly credit limit (80%)');
    }
  }

  /**
   * Get remaining monthly credit budget.
   */
  getRemainingCredits(): number {
    const estimatedMonthlyUsage = this.creditsUsedToday * 30;
    return Math.max(0, MONTHLY_CREDIT_LIMIT - estimatedMonthlyUsage);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
