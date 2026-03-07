import { logger } from './logger.js';

interface RequestTimestamp {
  timestamp: number;
}

export class RateLimiter {
  private static instance: RateLimiter;
  private requests: RequestTimestamp[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  private constructor() {
    this.maxRequests = parseInt(process.env.DEXSCREENER_RATE_LIMIT || '1000', 10);
    this.windowMs = 60 * 60 * 1000; // 1 hour
  }

  static getInstance(): RateLimiter {
    if (!RateLimiter.instance) {
      RateLimiter.instance = new RateLimiter();
    }
    return RateLimiter.instance;
  }

  async acquire(): Promise<void> {
    const now = Date.now();

    // Remove requests outside the window
    this.requests = this.requests.filter(
      req => now - req.timestamp < this.windowMs
    );

    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest.timestamp);

      logger.warn(
        { waitTime, currentCount: this.requests.length },
        'Rate limit reached, waiting'
      );

      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.acquire(); // Retry after waiting
    }

    this.requests.push({ timestamp: now });
  }

  getRemainingQuota(): number {
    const now = Date.now();
    const activeRequests = this.requests.filter(
      req => now - req.timestamp < this.windowMs
    );
    return this.maxRequests - activeRequests.length;
  }
}
