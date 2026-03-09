import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DexScreenerClient } from '../../src/api/DexScreenerClient.js';
import type { DexScreenerResponse } from '../../src/types/index.js';

// Mock node-fetch
vi.mock('node-fetch', () => ({
  default: vi.fn()
}));

import fetch from 'node-fetch';
const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

describe('DexScreenerClient', () => {
  let client: DexScreenerClient;

  beforeEach(() => {
    client = new DexScreenerClient();
    vi.clearAllMocks();
  });

  it('should fetch token with pairs', async () => {
    const mockResponse: DexScreenerResponse = {
      pairs: [{
        pairAddress: 'pair123',
        fdv: 50000,
        marketCap: null,
        priceUsd: null,
        liquidity: { usd: 10000, base: null, quote: null },
        priceChange: { m1: null, m5: -2.5, h1: null, h6: null, h24: null },
        volume: { m1: null, m5: null, h1: null, h6: null, h24: null },
        txns: { m1: null, m5: null, h1: null, h6: null, h24: null },
        pairCreatedAt: null
      }]
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse
    } as never);

    const result = await client.getToken('token123');

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs?.[0].fdv).toBe(50000);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('token123'),
      expect.objectContaining({
        method: 'GET'
      })
    );
  });

  it('should return null pairs for non-existent token', async () => {
    const mockResponse: DexScreenerResponse = {
      pairs: null
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse
    } as never);

    const result = await client.getToken('nonexistent');

    expect(result.pairs).toBeNull();
  });

  it('should retry on network error', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ pairs: [] })
      } as never);

    const result = await client.getToken('token456');

    expect(result.pairs).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should fail after max retries', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await expect(client.getToken('token789')).rejects.toThrow('Failed to fetch token');
    expect(mockFetch).toHaveBeenCalledTimes(3); // MAX_RETRIES = 3
  });

  it('should handle HTTP errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests'
    } as never);

    await expect(client.getToken('token_rate_limited')).rejects.toThrow();
  });
});
