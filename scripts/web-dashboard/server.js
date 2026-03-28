#!/usr/bin/env node
/**
 * WalletSource v10.14 — Dashboard API Server
 * Exposes real-time metrics via REST API
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs/promises';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

// PostgreSQL pool
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname, { etag: false, maxAge: 0 }));

// ━━━ API Endpoints ━━━

// GET /api/stats - Main dashboard stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = {};

    // Token detection
    const detection = await pool.query(`
      SELECT
        COUNT(*) as total_tokens,
        COUNT(DISTINCT creator_wallet) as unique_wallets,
        COUNT(*) FILTER (WHERE detected_at > NOW() - INTERVAL '5 minutes') as last_5min
      FROM token_events
    `);
    stats.detection = detection.rows[0];

    // Queue status
    const queue = await pool.query(`
      SELECT
        status,
        COUNT(*) as count
      FROM monitoring_queue
      GROUP BY status
    `);
    stats.queue = queue.rows.reduce((acc, row) => {
      acc[row.status.toLowerCase()] = parseInt(row.count);
      return acc;
    }, { pending: 0, processing: 0, done: 0, retry: 0 });

    // Snapshots
    const snapshots = await pool.query(`SELECT COUNT(*) as count FROM token_snapshots`);
    stats.snapshots = parseInt(snapshots.rows[0].count);

    // Verdicts
    const verdicts = await pool.query(`
      SELECT
        verdict,
        COUNT(*) as count
      FROM token_events
      WHERE verdict IS NOT NULL
      GROUP BY verdict
    `);
    stats.verdicts = verdicts.rows.reduce((acc, row) => {
      acc[row.verdict.toLowerCase()] = parseInt(row.count);
      return acc;
    }, {});
    stats.verdicts.pending = await pool.query(`SELECT COUNT(*) FROM token_events WHERE verdict IS NULL`)
      .then(r => parseInt(r.rows[0].count));

    // Playbooks
    const playbooks = await pool.query(`
      SELECT
        rugger_playbook->>'recommended_strategy' as strategy,
        COUNT(*) as count
      FROM wallet_profiles
      WHERE rugger_playbook IS NOT NULL
      GROUP BY rugger_playbook->>'recommended_strategy'
    `);
    stats.playbooks = {
      total: playbooks.rows.reduce((sum, r) => sum + parseInt(r.count), 0),
      strategies: playbooks.rows.reduce((acc, row) => {
        acc[row.strategy.toLowerCase()] = parseInt(row.count);
        return acc;
      }, { ride: 0, fade: 0, avoid: 0, watch: 0 })
    };

    // Wallet stats
    const wallets = await pool.query(`
      WITH wallet_counts AS (
        SELECT creator_wallet, COUNT(*) as token_count
        FROM token_events
        GROUP BY creator_wallet
      )
      SELECT
        COUNT(*) FILTER (WHERE token_count = 1) as wallets_1,
        COUNT(*) FILTER (WHERE token_count = 2) as wallets_2,
        COUNT(*) FILTER (WHERE token_count >= 3) as wallets_3plus,
        COUNT(*) FILTER (WHERE token_count >= 5) as wallets_5plus,
        COUNT(*) FILTER (WHERE token_count >= 10) as wallets_10plus
      FROM wallet_counts
    `);
    stats.wallets = wallets.rows[0];

    // Rugger-specific
    const ruggers = await pool.query(`
      WITH rugger_counts AS (
        SELECT creator_wallet, COUNT(*) as rug_count
        FROM token_events
        WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
        AND time_to_peak_min IS NOT NULL
        AND time_to_rug_min IS NOT NULL
        GROUP BY creator_wallet
      )
      SELECT
        COUNT(*) FILTER (WHERE rug_count >= 3) as rugs_3plus,
        COUNT(*) FILTER (WHERE rug_count >= 5) as rugs_5plus
      FROM rugger_counts
    `);
    stats.ruggers = ruggers.rows[0];

    // Paper trades (if file exists)
    try {
      const paperLog = await fs.readFile(path.join(__dirname, '../../data/paper-trades.log'), 'utf-8');
      const lines = paperLog.trim().split('\n').filter(l => l.length > 0);
      const trades = lines.map(l => JSON.parse(l));

      stats.paperTrades = {
        total: trades.length,
        buy: trades.filter(t => t.action === 'BUY').length,
        sell: trades.filter(t => t.action === 'SELL').length,
        short: trades.filter(t => t.action === 'SHORT').length,
        hold: trades.filter(t => t.action === 'HOLD').length
      };
    } catch (err) {
      stats.paperTrades = { total: 0, buy: 0, sell: 0, short: 0, hold: 0 };
    }

    // Helius credits (read from env for now)
    stats.helius = {
      dailyLimit: parseInt(process.env.HELIUS_DAILY_CREDIT_LIMIT || '270000'),
      note: 'Credit tracking is in-process — check pm2 logs for usage'
    };

    // CARTEL stats
    const cartelStats = await pool.query(`
      SELECT
        count(*) FILTER (WHERE action='SELL') as trades,
        round(100.0 * count(*) FILTER (WHERE action='SELL' AND pnl_pct > 0) / NULLIF(count(*) FILTER (WHERE action='SELL'), 0), 1) as wr,
        round(avg(pnl_pct) FILTER (WHERE action='SELL'), 1) as avg_pnl
      FROM paper_trades WHERE strategy = 'CARTEL' OR buy_strategy = 'CARTEL'
    `);
    stats.cartel = cartelStats.rows[0];

    // STD stats
    const stdStats = await pool.query(`
      SELECT
        count(*) FILTER (WHERE action='SELL') as trades,
        round(100.0 * count(*) FILTER (WHERE action='SELL' AND pnl_pct > 0) / NULLIF(count(*) FILTER (WHERE action='SELL'), 0), 1) as wr,
        round(avg(pnl_pct) FILTER (WHERE action='SELL'), 1) as avg_pnl
      FROM paper_trades WHERE (strategy = 'STD' OR buy_strategy = 'STD' OR buy_strategy = 'v10-MARKET' OR (buy_strategy IS NULL AND strategy IS NULL))
    `);
    stats.std = stdStats.rows[0];

    // NEO stats
    const neoStats = await pool.query(`
      SELECT
        count(*) FILTER (WHERE action='SELL') as trades,
        round(100.0 * count(*) FILTER (WHERE action='SELL' AND pnl_pct > 0) / NULLIF(count(*) FILTER (WHERE action='SELL'), 0), 1) as wr,
        round(avg(pnl_pct) FILTER (WHERE action='SELL'), 1) as avg_pnl
      FROM paper_trades WHERE strategy = 'NEO' OR buy_strategy = 'NEO'
    `);
    stats.neo = neoStats.rows[0];

    // CARTEL wallet stats (from wallet_stats table — real P&L based)
    try {
      const walletStats = await pool.query(`
        SELECT
          count(*) FILTER (WHERE category = 'ELITE') as elite_count,
          count(*) FILTER (WHERE category = 'GOOD') as good_count,
          count(*) as total_profiled
        FROM wallet_stats
      `);
      stats.cartelGroups = { 
        good_wallets: parseInt(walletStats.rows[0].elite_count) || 0,
        good_count: parseInt(walletStats.rows[0].good_count) || 0,
        total_profiled: parseInt(walletStats.rows[0].total_profiled) || 0
      };
    } catch { stats.cartelGroups = { good_wallets: 0, good_count: 0, total_profiled: 0 }; }

    // Performance
    const performance = await pool.query(`
      SELECT COUNT(*) as done_last_hour
      FROM monitoring_queue
      WHERE status = 'DONE'
      AND processed_at > NOW() - INTERVAL '1 hour'
    `);
    stats.performance = {
      doneLastHour: parseInt(performance.rows[0].done_last_hour),
      expectedRate: 810,
      apiUsage: stats.queue.processing * 2,
      apiLimit: 300
    };

    // Latest activity
    const latest = await pool.query(`
      SELECT token_address, creator_wallet, detected_at
      FROM token_events
      ORDER BY detected_at DESC
      LIMIT 1
    `);
    const latestSnapshot = await pool.query(`
      SELECT token_address, snapshot_at,
      EXTRACT(EPOCH FROM (NOW() - snapshot_at))/60 as minutes_ago
      FROM token_snapshots
      ORDER BY snapshot_at DESC
      LIMIT 1
    `);

    stats.latest = {
      token: latest.rows[0] || null,
      snapshot: latestSnapshot.rows[0] || null
    };

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      stats
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/health - Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
});

// GET /api/recent-tokens - Recent tokens
app.get('/api/recent-tokens', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const result = await pool.query(`
      SELECT
        token_address,
        creator_wallet,
        verdict,
        peak_mc,
        detected_at,
        snapshot_at
      FROM token_events
      ORDER BY detected_at DESC
      LIMIT $1
    `, [limit]);

    res.json({
      success: true,
      tokens: result.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/top-playbooks - Top playbooks
app.get('/api/top-playbooks', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const result = await pool.query(`
      SELECT
        wallet_address,
        rugger_playbook->>'recommended_strategy' as strategy,
        playbook_confidence,
        (rugger_playbook->>'sample_size')::int as sample_size,
        (rugger_playbook->>'consistency_score')::numeric as consistency
      FROM wallet_profiles
      WHERE rugger_playbook IS NOT NULL
      ORDER BY playbook_confidence DESC
      LIMIT $1
    `, [limit]);

    res.json({
      success: true,
      playbooks: result.rows
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/system-health - System health metrics
app.get('/api/system-health', async (req, res) => {
  try {
    const conns = await pool.query(`
      SELECT count(*) as total,
        count(*) FILTER (WHERE state='active') as active,
        count(*) FILTER (WHERE state='idle') as idle
      FROM pg_stat_activity WHERE datname='walletsource'
    `);
    const openPos = await pool.query(`
      SELECT count(*) as open FROM paper_trades
      WHERE action='BUY' AND token_address NOT IN (SELECT token_address FROM paper_trades WHERE action='SELL')
    `);
    const mem = process.memoryUsage();
    res.json({
      db: conns.rows[0],
      openPositions: parseInt(openPos.rows[0].open),
      helius: { dailyLimit: 270000, note: 'In-process tracking' },
      uptime: process.uptime(),
      memory: { heapMB: Math.round(mem.heapUsed / 1024 / 1024) },
      wsReconnects: '-'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  WalletSource v10.14 — Dashboard API Server              ║
╚══════════════════════════════════════════════════════════════╝

📡 API Server:  http://localhost:${PORT}
🌐 Dashboard:   http://localhost:${PORT}/index.html

Endpoints:
  GET /api/stats           - Main dashboard stats
  GET /api/health          - Health check
  GET /api/system-health   - System health metrics
  GET /api/recent-tokens   - Recent tokens
  GET /api/top-playbooks   - Top playbooks
  GET /api/paper-trades    - Paper trading P&L

Press Ctrl+C to stop
  `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

// GET /api/paper-trades - Paper trading P&L bilan (v10.13: reads from PostgreSQL)
app.get('/api/paper-trades', async (req, res) => {
  try {
    const buyRows = await pool.query(`
      SELECT token_address, timestamp, mc_usd::float as mc, reason, buy_strategy, strategy_version, quality_score
      FROM paper_trades WHERE action = 'BUY' ORDER BY timestamp
    `);
    const sellRows = await pool.query(`
      SELECT token_address, timestamp, mc_usd::float as mc, reason, exit_type, pnl_pct::float as pnl_pct, peak_pct::float as peak_pct, buy_strategy
      FROM paper_trades WHERE action = 'SELL' ORDER BY timestamp
    `);

    const sellMap = {};
    for (const s of sellRows.rows) {
      if (!sellMap[s.token_address]) sellMap[s.token_address] = [];
      sellMap[s.token_address].push(s);
    }

    const trades = [];
    for (const buy of buyRows.rows) {
      const sells = sellMap[buy.token_address] || [];
      const sell = sells.find(s => new Date(s.timestamp) >= new Date(buy.timestamp)) || null;
      trades.push({
        token: buy.token_address.slice(0, 12) + '\u2026',
        token_full: buy.token_address,
        buy_time: buy.timestamp,
        buy_mc: buy.mc,
        buy_reason: buy.reason,
        entry_strategy: buy.buy_strategy || 'STD',
        strategy_version: buy.strategy_version,
        quality_score: buy.quality_score,
        sell_time: sell?.timestamp || null,
        sell_mc: sell?.mc || null,
        sell_reason: sell?.reason || null,
        exit_type: sell?.exit_type || null,
        pnl_pct: sell?.pnl_pct != null ? parseFloat(sell.pnl_pct.toFixed(2)) : null,
        peak_pct: sell?.peak_pct != null ? parseFloat(sell.peak_pct.toFixed(2)) : null,
        status: sell ? (sell.pnl_pct >= 0 ? 'WIN' : 'LOSS') : 'OPEN'
      });
    }

    const completed = trades.filter(t => t.pnl_pct !== null);
    const wins = completed.filter(t => t.pnl_pct > 0);
    const losses = completed.filter(t => t.pnl_pct <= 0);
    const avgPnl = completed.length ? completed.reduce((s, t) => s + t.pnl_pct, 0) / completed.length : 0;
    const totalPnl = completed.reduce((s, t) => s + t.pnl_pct, 0);
    const winRate = completed.length ? (wins.length / completed.length * 100) : 0;

    const strategies = {};
    for (const t of completed) {
      const strat = t.entry_strategy || 'STD';
      if (!strategies[strat]) strategies[strat] = { count: 0, wins: 0, total_pnl: 0 };
      strategies[strat].count++;
      if (t.pnl_pct > 0) strategies[strat].wins++;
      strategies[strat].total_pnl += t.pnl_pct;
    }
    for (const [k, v] of Object.entries(strategies)) {
      v.win_rate = parseFloat((v.wins / v.count * 100).toFixed(1));
      v.avg_pnl = parseFloat((v.total_pnl / v.count).toFixed(1));
    }

    res.json({
      success: true,
      summary: {
        total_trades: trades.length,
        completed: completed.length,
        open: trades.filter(t => t.status === 'OPEN').length,
        wins: wins.length,
        losses: losses.length,
        win_rate_pct: parseFloat(winRate.toFixed(1)),
        avg_pnl_pct: parseFloat(avgPnl.toFixed(2)),
        total_pnl_pct: parseFloat(totalPnl.toFixed(2)),
        best_pct: completed.length ? Math.max(...completed.map(t => t.pnl_pct)) : null,
        worst_pct: completed.length ? Math.min(...completed.map(t => t.pnl_pct)) : null,
        strategies
      },
      trades
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ━━━ GRAPH API Endpoints ━━━

// GET /api/graphs/success - Tokens SUCCESS avec leur MC peak
app.get('/api/graphs/success', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        token_address,
        creator_wallet,
        peak_mc,
        fdv_at_detection,
        time_to_peak_min,
        time_to_rug_min,
        detected_at
      FROM token_events
      WHERE verdict = 'SUCCESS'
        AND peak_mc IS NOT NULL
      ORDER BY peak_mc DESC
      LIMIT 50
    `);
    res.json({ success: true, tokens: result.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/graphs/ride - Tokens des wallets RIDE avec leur MC peak
app.get('/api/graphs/ride', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        te.token_address,
        te.creator_wallet,
        te.verdict,
        te.peak_mc,
        te.fdv_at_detection,
        te.time_to_peak_min,
        te.time_to_rug_min,
        te.detected_at,
        (wp.rugger_playbook->>'avg_peak_mc')::float AS wallet_avg_peak_mc,
        (wp.rugger_playbook->>'consistency_score')::float AS consistency
      FROM token_events te
      JOIN wallet_profiles wp ON wp.wallet_address = te.creator_wallet
      WHERE wp.strategy = 'RIDE'
        AND wp.rugger_playbook IS NOT NULL
        AND te.peak_mc IS NOT NULL
      ORDER BY te.detected_at DESC
      LIMIT 100
    `);
    res.json({ success: true, tokens: result.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/graphs/pnl - P&L paper trades dans le temps
app.get('/api/graphs/pnl', async (req, res) => {
  try {
    const logPath = process.env.PAPER_TRADING_LOG_FILE || './data/paper-trades.log';
    let entries = [];
    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile(logPath, 'utf-8');
      entries = content.trim().split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
    } catch { }

    const byToken = {};
    for (const e of entries) {
      if (!byToken[e.token]) byToken[e.token] = [];
      byToken[e.token].push(e);
    }

    const trades = [];
    for (const [token, evts] of Object.entries(byToken)) {
      const buy = evts.find(e => e.action === 'BUY');
      const sell = evts.find(e => e.action === 'SELL');
      if (!buy) continue;
      const buyMC = parseFloat(buy.current_mc);
      const sellMC = sell ? parseFloat(sell.current_mc) : null;
      const pnl = sellMC && buyMC ? ((sellMC - buyMC) / buyMC) * 100 : null;
      trades.push({
        token: token.slice(0, 12) + '…',
        time: buy.timestamp,
        pnl_pct: pnl !== null ? parseFloat(pnl.toFixed(2)) : null,
        status: pnl !== null ? (pnl >= 0 ? 'WIN' : 'LOSS') : 'OPEN',
        buy_mc: buyMC,
        sell_mc: sellMC
      });
    }
    trades.sort((a, b) => new Date(a.time) - new Date(b.time));
    res.json({ success: true, trades });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/graphs/wallets - Distribution des wallets par stratégie + rug rate
app.get('/api/graphs/wallets', async (req, res) => {
  try {
    const strategies = await pool.query(`
      SELECT strategy, COUNT(*) as count
      FROM wallet_profiles
      GROUP BY strategy ORDER BY count DESC
    `);
    const rugRate = await pool.query(`
      SELECT
        ROUND(rug_rate::numeric * 100, 0) as bucket,
        COUNT(*) as count
      FROM wallet_profiles
      WHERE rug_count > 0
      GROUP BY bucket ORDER BY bucket
    `);
    const topRuggers = await pool.query(`
      SELECT wallet_address, rug_count, rug_rate, strategy
      FROM wallet_profiles
      WHERE rug_count >= 5
      ORDER BY rug_count DESC
      LIMIT 20
    `);
    res.json({
      success: true,
      strategies: strategies.rows,
      rug_rate_distribution: rugRate.rows,
      top_ruggers: topRuggers.rows
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/graphs/verdict - Évolution des verdicts dans le temps (par heure)
app.get('/api/graphs/verdict', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        DATE_TRUNC('hour', detected_at) as hour,
        verdict,
        COUNT(*) as count
      FROM token_events
      WHERE detected_at > NOW() - INTERVAL '24 hours'
        AND verdict IS NOT NULL
      GROUP BY hour, verdict
      ORDER BY hour
    `);
    res.json({ success: true, data: result.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /graphs/* - Serve graph pages
app.get('/graphs', (req, res) => res.sendFile(path.join(__dirname, 'graphs.html')));
app.get('/graphs/*', (req, res) => res.sendFile(path.join(__dirname, 'graphs.html')));

// GET /api/paper-trades/:token/chart - Price history from DB snapshots + paper_trades
app.get('/api/paper-trades/:token/chart', async (req, res) => {
  try {
    const token = req.params.token;

    // Get BUY/SELL from paper_trades
    const { rows: pts } = await pool.query(
      `SELECT action, mc_usd, elapsed_min, reason, timestamp
       FROM paper_trades WHERE token_address = $1 ORDER BY timestamp`, [token]
    );
    const buyPt = pts.find(p => p.action === 'BUY');
    const sellPt = pts.find(p => p.action === 'SELL');

    // Get ALL price ticks: token_snapshots + trade_events combined
    const { rows: snaps } = await pool.query(
      `SELECT mc AS mc_live, ts AS snapshot_at, src FROM (
        SELECT mc_live::numeric AS mc, snapshot_at AS ts, 's' AS src FROM token_snapshots WHERE token_address = $1
        UNION ALL
        SELECT market_cap_usd::numeric AS mc, event_at AS ts, 't' AS src FROM trade_events WHERE token_address = $1 AND market_cap_usd > 0
      ) combined ORDER BY ts`, [token]
    );

    // Get detection time for baseline
    const { rows: evts } = await pool.query(
      `SELECT fdv_at_detection, detected_at FROM token_events WHERE token_address = $1 LIMIT 1`, [token]
    );
    const detectedAt = evts[0]?.detected_at || (snaps[0]?.snapshot_at) || null;
    const baseline = evts[0] ? parseFloat(evts[0].fdv_at_detection) : null;

    // Build ticks from snapshots
    const t0 = detectedAt ? new Date(detectedAt).getTime() : (snaps[0] ? new Date(snaps[0].snapshot_at).getTime() : 0);
    const ticks = snaps.map(s => ({
      time: (new Date(s.snapshot_at).getTime() - t0) / 1000,
      mc: parseFloat(s.mc_live),
      action: null,
      reason: ''
    }));

    // Inject BUY/SELL markers
    const buy = buyPt ? { time: parseFloat(buyPt.elapsed_min) * 60, mc: parseFloat(buyPt.mc_usd), action: 'BUY', reason: buyPt.reason || '' } : null;
    const sell = sellPt ? { time: parseFloat(sellPt.elapsed_min) * 60, mc: parseFloat(sellPt.mc_usd), action: 'SELL', reason: sellPt.reason || '' } : null;

    if (buy) ticks.push(buy);
    if (sell) ticks.push(sell);
    ticks.sort((a, b) => a.time - b.time);

    res.json({ success: true, ticks, buy, sell, baseline });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ━━━ WALLET SIMULATION API ━━━

// GET /api/wallet-sim - Full wallet simulation from DB (paper_trades table)
app.get('/api/wallet-sim', async (req, res) => {
  try {
    const INITIAL_SOL = 10;
    const BUY_SLIP = 0.025, SELL_SLIP = 0.035, PUMP_FEE = 0.01;
    const JITO_BUY = 0.0001, JITO_SELL = 0.00045, BASE_FEE = 0.000005;

    const { rows: buys } = await pool.query(
      `SELECT token_address, timestamp, mc_usd, confidence, position_sol, quality_score,
              wallet_risk, buyers, ratio, dumps, sell_ratio, top_holder_pct, avg_buy_usd,
              reason, buy_strategy, strategy, strategy_version
       FROM paper_trades WHERE action='BUY' ORDER BY timestamp`
    );
    const { rows: sells } = await pool.query(
      `SELECT token_address, timestamp, mc_usd, exit_type, pnl_pct, peak_pct, reason
       FROM paper_trades WHERE action='SELL'`
    );
    const sellMap = {};
    for (const s of sells) { sellMap[s.token_address] = sellMap[s.token_address] || []; sellMap[s.token_address].push(s); }

    let balance = INITIAL_SOL;
    const tradeLog = [];
    let totalFees = 0, totalSlip = 0, totalJito = 0, totalPump = 0;
    let wins = 0, losses = 0;

    for (const buy of buys) {
      const sell = sellMap[buy.token_address]?.slice(-1)[0];
      const pos = parseFloat(buy.position_sol) || 0;
      if (pos <= 0) continue;
      const buyMC = parseFloat(buy.mc_usd) || 0;
      const sellMC = sell ? parseFloat(sell.mc_usd) || 0 : null;

      const bSlip = pos * BUY_SLIP, bPump = pos * PUMP_FEE, bJito = JITO_BUY + BASE_FEE;
      const effBuy = pos - bSlip - bPump;
      const before = balance;
      balance -= (pos + bJito);

      let pnlPct = null, pnlSOL = null, exitType = null, exitReason = null;
      let sSlip = 0, sPump = 0, sJito = 0;

      if (sell && sellMC && buyMC > 0) {
        const gross = effBuy * (sellMC / buyMC);
        sSlip = gross * SELL_SLIP; sPump = gross * PUMP_FEE; sJito = JITO_SELL + BASE_FEE;
        const net = gross - sSlip - sPump - sJito;
        balance += net;
        pnlSOL = net - pos - bJito;
        pnlPct = (pnlSOL / pos) * 100;
        exitType = sell.exit_type;
        exitReason = sell.reason;
        if (pnlSOL > 0) wins++; else losses++;
      }

      const tFee = bJito + sJito, tSlip = bSlip + sSlip + bPump + sPump;
      totalFees += tFee; totalSlip += tSlip; totalJito += bJito + sJito; totalPump += bPump + sPump;

      tradeLog.push({
        token: buy.token_address.slice(0, 12) + '…', token_full: buy.token_address,
        action: sell && pnlSOL !== null ? (pnlSOL >= 0 ? 'WIN' : 'LOSS') : 'OPEN',
        timestamp: buy.timestamp, sell_timestamp: sell?.timestamp || null,
        position_sol: parseFloat(pos.toFixed(4)),
        position_tier: buy.buy_strategy || 'STD',
        quality_score: buy.quality_score,
        buy_mc: buyMC ? parseFloat(buyMC.toFixed(0)) : null,
        sell_mc: sellMC ? parseFloat(sellMC.toFixed(0)) : null,
        mc_change_pct: sellMC && buyMC > 0 ? parseFloat(((sellMC / buyMC - 1) * 100).toFixed(2)) : null,
        confidence: parseFloat(buy.confidence) || 0,
        buy_reason: buy.reason, exit_reason: exitReason, exit_type: exitType,
        buy_strategy: buy.buy_strategy,
        strategy_version: buy.strategy_version || buy.buy_strategy,
        fees_sol: parseFloat(tFee.toFixed(6)), slippage_sol: parseFloat(tSlip.toFixed(6)),
        jito_sol: parseFloat((bJito + sJito).toFixed(6)),
        jito_buy_sol: parseFloat(JITO_BUY.toFixed(6)),
        jito_sell_sol: parseFloat((sell ? JITO_SELL : 0).toFixed(6)),
        base_fee_sol: parseFloat((BASE_FEE + (sell ? BASE_FEE : 0)).toFixed(6)),
        pump_fees_sol: parseFloat((bPump + sPump).toFixed(6)),
        pump_fee_buy_sol: parseFloat(bPump.toFixed(6)),
        pump_fee_sell_sol: parseFloat(sPump.toFixed(6)),
        slippage_buy_sol: parseFloat(bSlip.toFixed(6)),
        slippage_sell_sol: parseFloat(sSlip.toFixed(6)),
        wallet_impact_pct: pnlSOL !== null ? parseFloat((pnlSOL / before * 100).toFixed(2)) : null,
        pnl_sol: pnlSOL !== null ? parseFloat(pnlSOL.toFixed(6)) : null,
        pnl_pct: pnlPct !== null ? parseFloat(pnlPct.toFixed(2)) : null,
        balance_before: parseFloat(before.toFixed(4)),
        balance_after: parseFloat(balance.toFixed(4))
      });
    }

    const completed = tradeLog.filter(t => t.pnl_pct !== null);
    const avgPnl = completed.length ? completed.reduce((s, t) => s + t.pnl_pct, 0) / completed.length : 0;
    const wr = (wins + losses) > 0 ? parseFloat((wins / (wins + losses) * 100).toFixed(1)) : 0;
    const drag = balance > INITIAL_SOL ?
      parseFloat(((totalFees + totalSlip) / (totalFees + totalSlip + balance - INITIAL_SOL) * 100).toFixed(1)) : 0;

    res.json({
      success: true,
      config: {
        initial_sol: INITIAL_SOL, sol_price_usd: 140,
        slippage_buy_bps: BUY_SLIP * 10000, slippage_sell_bps: SELL_SLIP * 10000,
        pump_fee_bps: PUMP_FEE * 10000, priority_fee_sol: JITO_BUY, jito_tip_buy_sol: JITO_BUY, jito_tip_sell_sol: JITO_SELL, max_mc_pct: 10
      },
      summary: {
        final_balance_sol: parseFloat(balance.toFixed(4)),
        total_pnl_sol: parseFloat((balance - INITIAL_SOL).toFixed(4)),
        total_pnl_pct: parseFloat(((balance / INITIAL_SOL - 1) * 100).toFixed(2)),
        total_trades: completed.length + tradeLog.filter(t => t.action === 'OPEN').length,
        wins, losses,
        open: tradeLog.filter(t => t.action === 'OPEN').length,
        win_rate_pct: wr, avg_pnl_pct: parseFloat(avgPnl.toFixed(2)),
        total_fees_sol: parseFloat(totalFees.toFixed(6)),
        total_slippage_sol: parseFloat(totalSlip.toFixed(6)),
        total_jito_sol: parseFloat(totalJito.toFixed(6)),
        total_pump_fees_sol: parseFloat(totalPump.toFixed(6)),
        fees_drag_pct: drag
      },
      trades: tradeLog
    });
  } catch (err) {
    console.error('wallet-sim error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/neo-config - NEO strategy config
app.get('/api/neo-config', async (req, res) => {
  try {
    const content = await fs.readFile('./data/neo-config.json', 'utf-8');
    res.json(JSON.parse(content));
  } catch (err) {
    res.json({ error: 'No config found' });
  }
});

// Serve wallet page
app.get('/wallet', (req, res) => res.sendFile(path.join(__dirname, 'wallet.html')));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET /api/live-wallet — Live trading data from live_trades table
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/live-wallet', async (req, res) => {
  try {
    // Solde réel du wallet via RPC
    let walletBalance = null;
    let walletAddress = null;
    try {
      const { rows: wRows } = await pool.query(
        `SELECT wallet_address FROM live_trades WHERE wallet_address IS NOT NULL ORDER BY executed_at DESC LIMIT 1`
      );
      if (wRows[0]?.wallet_address) {
        walletAddress = wRows[0].wallet_address;
        const rpcRes = await fetch(process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [walletAddress] })
        });
        const rpcData = await rpcRes.json();
        walletBalance = (rpcData?.result?.value ?? 0) / 1e9;
      }
    } catch(e) { /* ignore */ }

    // Récupérer les BUY
    const { rows: buys } = await pool.query(`
      SELECT id, token_address, sol_in, sol_actual, tokens_amount,
             fee_sol, jito_tip_sol, slippage_sol, slippage_pct,
             tx_signature, reason, jito_bundle, tip_lamports,
             latency_ms, executed_at, wallet_address, parsed_ok
      FROM live_trades WHERE side='BUY' ORDER BY executed_at
    `);

    // Récupérer les SELL
    const { rows: sells } = await pool.query(`
      SELECT id, token_address, sol_in, sol_out, sol_actual,
             pnl_sol, pnl_pct, tokens_amount,
             fee_sol, jito_tip_sol, slippage_sol, slippage_pct,
             tx_signature, tx_sig_buy, reason,
             latency_ms, executed_at, parsed_ok
      FROM live_trades WHERE side='SELL' ORDER BY executed_at
    `);

    const sellMap = {};
    for (const s of sells) {
      sellMap[s.token_address] = sellMap[s.token_address] || [];
      sellMap[s.token_address].push(s);
    }

    let totalPnl = 0, totalFees = 0, totalJito = 0, totalSlippage = 0;
    let wins = 0, losses = 0;
    const tradeLog = [];

    for (const buy of buys) {
      const sell = sellMap[buy.token_address]?.find(s => !s._used);
      if (sell) sell._used = true;

      const solIn = parseFloat(buy.sol_in) || 0;
      const solOut = sell ? parseFloat(sell.sol_out || sell.sol_actual || 0) : null;
      const pnlSol = sell ? parseFloat(sell.pnl_sol) || 0 : null;
      const pnlPct = sell ? parseFloat(sell.pnl_pct) || 0 : null;
      const feeSol = (parseFloat(buy.fee_sol) || 0) + (sell ? parseFloat(sell.fee_sol) || 0 : 0);
      const jitoSol = (parseFloat(buy.jito_tip_sol) || 0) + (sell ? parseFloat(sell.jito_tip_sol) || 0 : 0);
      const slipSol = (parseFloat(buy.slippage_sol) || 0) + (sell ? parseFloat(sell.slippage_sol) || 0 : 0);

      if (pnlSol !== null) {
        totalPnl += pnlSol;
        totalFees += feeSol;
        totalJito += jitoSol;
        totalSlippage += slipSol;
        if (pnlSol > 0) wins++; else losses++;
      }

      // Extraire exit_type depuis le reason
      const sellReason = sell?.reason || '';
      let exitType = 'OPEN';
      if (sellReason.includes('HARD_STOP')) exitType = 'HARD_STOP';
      else if (sellReason.includes('RT-TRAIL') || sellReason.includes('TRAIL')) exitType = 'RT-TRAIL';
      else if (sellReason.includes('PUMP3')) exitType = 'PUMP3';
      else if (sell) exitType = 'OTHER';

      tradeLog.push({
        token: buy.token_address.slice(0, 12) + '…',
        token_full: buy.token_address,
        action: sell && pnlSol !== null ? (pnlSol >= 0 ? 'WIN' : 'LOSS') : 'OPEN',
        timestamp: buy.executed_at,
        sell_timestamp: sell?.executed_at || null,
        position_sol: solIn,
        buy_strategy: 'LIVE',
        strategy_version: 'LIVE v1.0',
        pnl_sol: pnlSol !== null ? parseFloat(pnlSol.toFixed(6)) : null,
        pnl_pct: pnlPct !== null ? parseFloat(pnlPct.toFixed(2)) : null,
        exit_type: exitType,
        exit_reason: sellReason,
        buy_reason: buy.reason,
        fees_sol: parseFloat(feeSol.toFixed(6)),
        jito_sol: parseFloat(jitoSol.toFixed(6)),
        slippage_sol: parseFloat(slipSol.toFixed(6)),
        fee_sol_buy: parseFloat(buy.fee_sol || 0),
        fee_sol_sell: sell ? parseFloat(sell.fee_sol || 0) : 0,
        jito_tip_sol_buy: parseFloat(buy.jito_tip_sol || 0),
        jito_tip_sol_sell: sell ? parseFloat(sell.jito_tip_sol || 0) : 0,
        slippage_pct: parseFloat(buy.slippage_pct || 0),
        tx_buy: buy.tx_signature,
        tx_sell: sell?.tx_signature || null,
        latency_buy_ms: buy.latency_ms,
        latency_sell_ms: sell?.latency_ms || null,
        parsed_ok: buy.parsed_ok && (sell ? sell.parsed_ok : true),
        sol_out: solOut,
      });
    }

    const completed = tradeLog.filter(t => t.pnl_pct !== null);
    const avgPnl = completed.length ? completed.reduce((s, t) => s + t.pnl_pct, 0) / completed.length : 0;
    const wr = (wins + losses) > 0 ? parseFloat((wins / (wins + losses) * 100).toFixed(1)) : 0;

    res.json({
      success: true,
      wallet: {
        address: walletAddress,
        balance_sol: walletBalance !== null ? parseFloat(walletBalance.toFixed(4)) : null,
      },
      summary: {
        total_trades: completed.length,
        open: tradeLog.filter(t => t.action === 'OPEN').length,
        wins, losses, win_rate_pct: wr,
        avg_pnl_pct: parseFloat(avgPnl.toFixed(2)),
        total_pnl_sol: parseFloat(totalPnl.toFixed(6)),
        total_fees_sol: parseFloat(totalFees.toFixed(6)),
        total_jito_sol: parseFloat(totalJito.toFixed(6)),
        total_slippage_sol: parseFloat(totalSlippage.toFixed(6)),
      },
      trades: tradeLog
    });
  } catch (err) {
    console.error('live-wallet error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/wallet2', (req, res) => res.sendFile(path.join(__dirname, 'wallet2.html')));
