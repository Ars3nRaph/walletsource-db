import { logger } from '../utils/logger.js';

/**
 * HeliusCreditTracker — Track and limit daily Helius API credit usage
 * 
 * Credit costs (approximate):
 * - WebSocket subscription: 1 credit per message received
 * - getTransaction: 100 credits
 * - getSignaturesForAddress: 100 credits  
 * - Enhanced transaction API: 100 credits
 * - programSubscribe: 1 credit per notification
 * 
 * Budget: 10M credits/month = ~333K/day
 * We target 270K/day (80% utilization, 20% reserve)
 */
export class HeliusCreditTracker {
  private dailyUsage: number = 0;
  private dailyLimit: number;
  private lastResetDate: string = '';
  private usageByCategory: Map<string, number> = new Map();

  constructor(dailyLimit?: number) {
    this.dailyLimit = dailyLimit || parseInt(process.env.HELIUS_DAILY_CREDIT_LIMIT || '270000');
    this.resetIfNewDay();
  }

  private resetIfNewDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      if (this.lastResetDate) {
        logger.info({ 
          date: this.lastResetDate, 
          totalUsed: this.dailyUsage, 
          limit: this.dailyLimit,
          categories: Object.fromEntries(this.usageByCategory)
        }, '📊 Helius daily credit reset');
      }
      this.dailyUsage = 0;
      this.usageByCategory.clear();
      this.lastResetDate = today;
    }
  }

  /** Check if we can spend credits. Returns false if over budget. */
  canSpend(credits: number): boolean {
    this.resetIfNewDay();
    return (this.dailyUsage + credits) <= this.dailyLimit;
  }

  /** Record credit usage */
  spend(credits: number, category: string = 'general'): void {
    this.resetIfNewDay();
    this.dailyUsage += credits;
    this.usageByCategory.set(category, (this.usageByCategory.get(category) || 0) + credits);
  }

  /** Check remaining budget */
  remaining(): number {
    this.resetIfNewDay();
    return Math.max(0, this.dailyLimit - this.dailyUsage);
  }

  /** Usage percentage */
  usagePct(): number {
    return Math.round((this.dailyUsage / this.dailyLimit) * 100);
  }

  /** Get stats */
  getStats(): { used: number; limit: number; pct: number; categories: Record<string, number> } {
    this.resetIfNewDay();
    return {
      used: this.dailyUsage,
      limit: this.dailyLimit,
      pct: this.usagePct(),
      categories: Object.fromEntries(this.usageByCategory)
    };
  }
}

// Singleton
export const creditTracker = new HeliusCreditTracker();
