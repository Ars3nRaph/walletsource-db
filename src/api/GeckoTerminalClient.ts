import fetch from 'node-fetch';
import { logger } from '../utils/logger.js';

const GECKO_BASE_URL = 'https://api.geckoterminal.com/api/v2';
const REQUEST_TIMEOUT_MS = 5000;
// Free tier: ~30 req/min → 1 req/2s safe
const MIN_DELAY_MS = 2000;

export interface GeckoTokenData {
  hasPair: boolean;
  fdv: number | null;
  liquidityUsd: number | null;
  priceUsd: number | null;
  poolAddress: string | null;
}

interface GeckoPool {
  id: string;
  type: string;
  attributes: {
    address: string;
    fdv_usd: string | null;
    reserve_in_usd: string | null;
    token_price_usd: string | null;
    pool_created_at: string | null;
  };
}

export class GeckoTerminalClient {
  private lastRequestAt = 0;

  async getToken(tokenAddress: string): Promise<GeckoTokenData> {
    await this.rateLimit();

    try {
      const url = `${GECKO_BASE_URL}/networks/solana/tokens/${tokenAddress}/pools?page=1`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json;version=20230302',
          'User-Agent': 'WalletSourceDB/4.0',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        logger.warn({ status: response.status, token: tokenAddress }, 'GeckoTerminal non-OK response');
        return this.emptyResult();
      }

      const data = await response.json() as { data: GeckoPool[] };
      const pools = data?.data ?? [];

      if (pools.length === 0) {
        return { hasPair: false, fdv: null, liquidityUsd: null, priceUsd: null, poolAddress: null };
      }

      // Use first pool (highest liquidity)
      const pool = pools[0].attributes;
      const fdv = pool.fdv_usd ? parseFloat(pool.fdv_usd) : null;
      const liquidity = pool.reserve_in_usd ? parseFloat(pool.reserve_in_usd) : null;
      const price = pool.token_price_usd ? parseFloat(pool.token_price_usd) : null;

      logger.debug(
        { token: tokenAddress, fdv, liquidity, pool: pools[0].attributes.address },
        'GeckoTerminal data fetched'
      );

      return {
        hasPair: true,
        fdv,
        liquidityUsd: liquidity,
        priceUsd: price,
        poolAddress: pools[0].attributes.address ?? null,
      };
    } catch (error) {
      logger.warn({ error, token: tokenAddress }, 'GeckoTerminal request failed');
      return this.emptyResult();
    }
  }

  private emptyResult(): GeckoTokenData {
    return { hasPair: false, fdv: null, liquidityUsd: null, priceUsd: null, poolAddress: null };
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < MIN_DELAY_MS) {
      await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed));
    }
    this.lastRequestAt = Date.now();
  }
}
