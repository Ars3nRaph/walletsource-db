import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';

/**
 * Computes rich metrics from trade_events for a single token.
 * Called after token lifecycle is complete (verdict time).
 */
export class TradeAnalyzer {
  constructor(private pool: Pool) {}

  async analyze(tokenAddress: string, creatorWallet: string): Promise<void> {
    try {
      const result = await this.pool.query<{
        total_trades: string; buy_count: string; sell_count: string;
        buy_wallets: string; sell_wallets: string; unique_wallets: string;
        buy_vol: number; sell_vol: number;
        avg_buy: number; avg_sell: number;
        max_buy_wallet_vol: number; max_sell_wallet_vol: number;
        max_single_sell: number;
        first_at: Date; last_at: Date;
        peak_mc: number; peak_at: Date;
        entry_mc: number;
        first_sell_at: Date | null;
        creator_sold: boolean;
      }>(`
        WITH
        first_trade AS (
          SELECT event_at, market_cap_usd FROM trade_events
          WHERE token_address = $1 ORDER BY event_at ASC LIMIT 1
        ),
        peak_trade AS (
          SELECT event_at, market_cap_usd FROM trade_events
          WHERE token_address = $1 ORDER BY market_cap_usd DESC LIMIT 1
        ),
        first_sell AS (
          SELECT event_at FROM trade_events
          WHERE token_address = $1 AND tx_type = 'sell' ORDER BY event_at ASC LIMIT 1
        ),
        creator_sell AS (
          SELECT COUNT(*) > 0 AS sold FROM trade_events
          WHERE token_address = $1 AND tx_type = 'sell' AND trader_wallet = $2
        ),
        by_wallet AS (
          SELECT
            trader_wallet,
            SUM(volume_usd) FILTER (WHERE tx_type='buy')  AS buy_vol,
            SUM(volume_usd) FILTER (WHERE tx_type='sell') AS sell_vol
          FROM trade_events WHERE token_address = $1
          GROUP BY trader_wallet
        )
        SELECT
          COUNT(*)                                                   AS total_trades,
          COUNT(*) FILTER (WHERE tx_type='buy')                      AS buy_count,
          COUNT(*) FILTER (WHERE tx_type='sell')                     AS sell_count,
          COUNT(DISTINCT trader_wallet) FILTER (WHERE tx_type='buy') AS buy_wallets,
          COUNT(DISTINCT trader_wallet) FILTER (WHERE tx_type='sell')AS sell_wallets,
          COUNT(DISTINCT trader_wallet)                              AS unique_wallets,
          SUM(volume_usd) FILTER (WHERE tx_type='buy')               AS buy_vol,
          SUM(volume_usd) FILTER (WHERE tx_type='sell')              AS sell_vol,
          AVG(volume_usd) FILTER (WHERE tx_type='buy')               AS avg_buy,
          AVG(volume_usd) FILTER (WHERE tx_type='sell')              AS avg_sell,
          (SELECT MAX(buy_vol) FROM by_wallet)                       AS max_buy_wallet_vol,
          (SELECT MAX(sell_vol) FROM by_wallet)                      AS max_sell_wallet_vol,
          MAX(volume_usd) FILTER (WHERE tx_type='sell')              AS max_single_sell,
          (SELECT event_at FROM first_trade)                         AS first_at,
          MAX(te.event_at)                                           AS last_at,
          (SELECT market_cap_usd FROM peak_trade)                    AS peak_mc,
          (SELECT event_at FROM peak_trade)                          AS peak_at,
          (SELECT market_cap_usd FROM first_trade)                   AS entry_mc,
          (SELECT event_at FROM first_sell)                          AS first_sell_at,
          (SELECT sold FROM creator_sell)                            AS creator_sold
        FROM trade_events te
        WHERE te.token_address = $1
      `, [tokenAddress, creatorWallet]);

      if (!result.rows.length || !result.rows[0].total_trades) return;
      const r = result.rows[0];

      const totalTrades   = parseInt(r.total_trades);
      const buyVol        = r.buy_vol ?? 0;
      const sellVol       = r.sell_vol ?? 0;
      const peakMc        = r.peak_mc ?? 0;
      const entryMc       = r.entry_mc ?? 0;

      // Timing (seconds)
      const timeToPeakSec = r.peak_at && r.first_at
        ? (new Date(r.peak_at).getTime() - new Date(r.first_at).getTime()) / 1000 : null;
      const timeToRugSec  = r.last_at && r.first_at
        ? (new Date(r.last_at).getTime() - new Date(r.first_at).getTime()) / 1000 : null;
      const firstSellDelaySec = r.first_sell_at && r.first_at
        ? (new Date(r.first_sell_at).getTime() - new Date(r.first_at).getTime()) / 1000 : null;
      const rugDurationSec = timeToPeakSec && timeToRugSec
        ? timeToRugSec - timeToPeakSec : null;

      // Speed
      const pumpSpeedMcPerSec = timeToPeakSec && timeToPeakSec > 0 && entryMc > 0
        ? (peakMc - entryMc) / timeToPeakSec : null;
      const dumpSpeedMcPerSec = rugDurationSec && rugDurationSec > 0
        ? (peakMc - (r.buy_vol ?? 0)) / rugDurationSec : null; // rough
      const pumpDumpRatio = pumpSpeedMcPerSec && dumpSpeedMcPerSec && dumpSpeedMcPerSec !== 0
        ? Math.abs(pumpSpeedMcPerSec / dumpSpeedMcPerSec) : null;

      // Concentration
      const topBuyerPct   = buyVol > 0 ? (r.max_buy_wallet_vol ?? 0) / buyVol * 100 : null;
      const topSellerPct  = sellVol > 0 ? (r.max_sell_wallet_vol ?? 0) / sellVol * 100 : null;
      const largestSellPct = peakMc > 0 ? (r.max_single_sell ?? 0) / peakMc * 100 : null;

      // Pattern: micro-buy bot (avg buy < $1)
      const microBuyPattern = r.avg_buy !== null && r.avg_buy < 1.0;

      // Cascade score: ratio sells / (buys + sells) when selling > 70% = cascade
      
      const sells = parseInt(r.sell_count);
      const cascadeScore = totalTrades > 0 ? sells / totalTrades : 0;

      await this.pool.query(`
        UPDATE token_events SET
          time_to_peak_sec      = $1,
          time_to_rug_sec       = $2,
          first_sell_delay_sec  = $3,
          rug_duration_sec      = $4,
          pump_speed_mc_per_sec = $5,
          buy_wallet_count      = $6,
          sell_wallet_count     = $7,
          unique_traders        = $8,
          top_buyer_pct         = $9,
          top_seller_pct        = $10,
          creator_sold          = $11,
          buy_sell_ratio        = $12,
          net_sol_flow          = $13,
          avg_buy_size_usd      = $14,
          avg_sell_size_usd     = $15,
          largest_sell_pct      = $16,
          total_buy_vol_usd     = $17,
          total_sell_vol_usd    = $18,
          micro_buy_pattern     = $19,
          cascade_score         = $20,
          pump_dump_speed_ratio = $21,
          total_trade_count     = $22
        WHERE token_address = $23
      `, [
        timeToPeakSec, timeToRugSec, firstSellDelaySec, rugDurationSec, pumpSpeedMcPerSec,
        parseInt(r.buy_wallets), parseInt(r.sell_wallets), parseInt(r.unique_wallets),
        topBuyerPct, topSellerPct, r.creator_sold,
        buyVol > 0 ? buyVol / sellVol : null,
        buyVol - sellVol,
        r.avg_buy, r.avg_sell,
        largestSellPct, buyVol, sellVol,
        microBuyPattern, cascadeScore, pumpDumpRatio,
        totalTrades,
        tokenAddress
      ]);

      logger.debug({
        token: tokenAddress.slice(0, 8),
        trades: totalTrades,
        pumpX: entryMc > 0 ? (peakMc / entryMc).toFixed(2) : null,
        peakSec: timeToPeakSec?.toFixed(1),
        buyers: r.buy_wallets,
        sellers: r.sell_wallets,
        creatorSold: r.creator_sold,
        cascade: cascadeScore.toFixed(2)
      }, 'TradeAnalyzer complete');

    } catch (err) {
      logger.warn({ err, token: tokenAddress }, 'TradeAnalyzer failed');
    }
  }
}
