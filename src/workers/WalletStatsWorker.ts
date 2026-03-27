import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';

/**
 * WalletStatsWorker — Persistent wallet performance accumulator
 *
 * Runs every 30 minutes, incrementally processing trade_events + token_snapshots
 * to upsert into wallet_stats. Survives trade_events pruning.
 *
 * Categories:
 *   ELITE:   WR >= 75% AND tokens_total >= 20
 *   GOOD:    WR >= 65% AND tokens_total >= 15
 *   AVERAGE: WR >= 50% AND tokens_total >= 10
 *   TOXIC:   WR <  30% AND tokens_total >= 10
 *   WEAK:    tokens_total >= 5 (anything else)
 *   UNKNOWN: tokens_total < 5
 */
export class WalletStatsWorker {
  private pool: Pool;
  private intervalMs = 30 * 60 * 1000; // 30 minutes
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async start(): Promise<void> {
    logger.info('📊 WalletStatsWorker starting...');
    // Check if wallet_stats already has data (persistent across restarts)
    const existing = await this.pool.query('SELECT count(*) as n FROM wallet_stats');
    const hasData = parseInt(existing.rows[0].n) > 0;
    if (hasData) {
      logger.info({ existing: existing.rows[0].n }, '📊 WalletStatsWorker: table has data, incremental mode');
      // Non-blocking incremental update
      this.run(false).catch(err => logger.error({ err }, 'WalletStatsWorker initial run error'));
    } else {
      logger.info('📊 WalletStatsWorker: empty table, seeding (non-blocking)...');
      // Non-blocking seed — don't hold up other workers
      this.run(true).catch(err => logger.error({ err }, 'WalletStatsWorker seed error'));
    }
    // Subsequent runs: incremental
    this.timer = setInterval(() => {
      this.run(false).catch(err => logger.error({ err }, 'WalletStatsWorker run error'));
    }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, '📊 WalletStatsWorker scheduled');
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(fullSeed: boolean): Promise<void> {
    if (this.running) return;
    this.running = true;
    const t0 = Date.now();
    try {
      await this.upsertStats(fullSeed);
      const elapsed = Date.now() - t0;
      logger.info({ elapsed, fullSeed }, '📊 WalletStatsWorker run complete');
    } catch (err) {
      logger.error({ err }, '📊 WalletStatsWorker run failed');
    } finally {
      this.running = false;
    }
  }

  private async upsertStats(fullSeed: boolean): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Determine cutoff time: for incremental runs use min(updated_at) from wallet_stats
      // so we re-process any wallets that might have new data
      let cutoffClause = '';
      if (!fullSeed) {
        const cutoffResult = await client.query(`
          SELECT COALESCE(MIN(updated_at), NOW() - INTERVAL '3 days') as cutoff
          FROM wallet_stats
        `);
        const cutoff: Date = cutoffResult.rows[0].cutoff;
        cutoffClause = `AND te.event_at > '${cutoff.toISOString()}'`;
      }

      // v10.14.3: Real P&L based WR — buy_mc vs sell_mc per wallet per token
      // Old method used token peak (all wallets got same WR). New method: actual trading profit.
      const query = `
        WITH wallet_buys AS (
          SELECT trader_wallet, token_address,
            AVG(market_cap_usd) as buy_mc,
            SUM(COALESCE(v_sol, 0)) as buy_vol,
            MIN(event_at) as first_buy_at
          FROM trade_events
          WHERE tx_type = 'buy' AND market_cap_usd > 0 AND trader_wallet IS NOT NULL
            ${cutoffClause}
          GROUP BY trader_wallet, token_address
        ),
        wallet_sells AS (
          SELECT trader_wallet, token_address,
            AVG(market_cap_usd) as sell_mc
          FROM trade_events
          WHERE tx_type = 'sell' AND market_cap_usd > 0 AND trader_wallet IS NOT NULL
            ${cutoffClause}
          GROUP BY trader_wallet, token_address
        ),
        round_trips AS (
          SELECT b.trader_wallet, b.token_address,
            b.buy_mc, s.sell_mc,
            CASE WHEN s.sell_mc > b.buy_mc THEN 1 ELSE 0 END as is_win,
            (s.sell_mc - b.buy_mc) / NULLIF(b.buy_mc, 0) * 100.0 as pnl_pct,
            b.buy_vol as volume_sol,
            b.first_buy_at
          FROM wallet_buys b
          JOIN wallet_sells s ON b.trader_wallet = s.trader_wallet AND b.token_address = s.token_address
        ),
        wallet_perf AS (
          SELECT
            trader_wallet,
            COUNT(*) AS tokens_total,
            SUM(is_win) AS tokens_won,
            AVG(pnl_pct) AS avg_peak_pct,
            0 AS avg_entry_delay_sec,
            SUM(volume_sol) AS total_volume_sol,
            MAX(first_buy_at) AS last_active_at,
            MIN(first_buy_at) AS first_seen_at
          FROM round_trips
          GROUP BY trader_wallet
        )
        SELECT
          trader_wallet,
          tokens_total,
          tokens_won,
          CASE WHEN tokens_total > 0 THEN tokens_won::REAL / tokens_total ELSE 0 END AS win_rate,
          avg_peak_pct,
          avg_entry_delay_sec,
          total_volume_sol,
          last_active_at,
          first_seen_at
        FROM wallet_perf
        WHERE tokens_total >= 5
      `;

      const result = await client.query(query);
      if (result.rows.length === 0) {
        logger.info('📊 WalletStatsWorker: no new data to process');
        return;
      }

      let upserted = 0;
      for (const row of result.rows) {
        const winRate: number = parseFloat(row.win_rate) || 0;
        const tokensTotal: number = parseInt(row.tokens_total) || 0;
        const tokensWon: number = parseInt(row.tokens_won) || 0;

        const category = this.classifyWallet(winRate, tokensTotal);

        await client.query(`
          INSERT INTO wallet_stats (
            wallet_address, tokens_total, tokens_won, win_rate,
            avg_peak_pct, avg_entry_delay_sec, total_volume_sol,
            last_active_at, first_seen_at, updated_at, category
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10)
          ON CONFLICT (wallet_address) DO UPDATE SET
            tokens_total = EXCLUDED.tokens_total,
            tokens_won = EXCLUDED.tokens_won,
            win_rate = EXCLUDED.win_rate,
            avg_peak_pct = EXCLUDED.avg_peak_pct,
            avg_entry_delay_sec = EXCLUDED.avg_entry_delay_sec,
            total_volume_sol = EXCLUDED.total_volume_sol,
            last_active_at = GREATEST(wallet_stats.last_active_at, EXCLUDED.last_active_at),
            first_seen_at = LEAST(COALESCE(wallet_stats.first_seen_at, EXCLUDED.first_seen_at), EXCLUDED.first_seen_at),
            updated_at = NOW(),
            category = $10
        `, [
          row.trader_wallet,
          tokensTotal,
          tokensWon,
          winRate,
          parseFloat(row.avg_peak_pct) || 0,
          parseFloat(row.avg_entry_delay_sec) || 0,
          parseFloat(row.total_volume_sol) || 0,
          row.last_active_at,
          row.first_seen_at,
          category
        ]);
        upserted++;
      }

      logger.info({ upserted, fullSeed }, '📊 wallet_stats upserted');
    } finally {
      client.release();
    }
  }

  private classifyWallet(winRate: number, tokensTotal: number): string {
    if (winRate >= 0.75 && tokensTotal >= 20) return 'ELITE';
    if (winRate >= 0.65 && tokensTotal >= 15) return 'GOOD';
    if (winRate < 0.30 && tokensTotal >= 10) return 'TOXIC';
    if (winRate >= 0.50 && tokensTotal >= 10) return 'AVERAGE';
    if (tokensTotal >= 5) return 'WEAK';
    return 'UNKNOWN';
  }
}
