#!/usr/bin/env node
/**
 * WalletSourceDB v4.0 — Web Dashboard API Server
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
app.use(express.static(__dirname));

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
        checked_at
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

// Start server
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  WalletSourceDB v4.0 — Web Dashboard API Server             ║
╚══════════════════════════════════════════════════════════════╝

📡 API Server:  http://localhost:${PORT}
🌐 Dashboard:   http://localhost:${PORT}/index.html

Endpoints:
  GET /api/stats           - Main dashboard stats
  GET /api/health          - Health check
  GET /api/recent-tokens   - Recent tokens
  GET /api/top-playbooks   - Top playbooks

Press Ctrl+C to stop
  `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

// GET /api/paper-trades - Paper trading P&L bilan
app.get('/api/paper-trades', async (req, res) => {
  try {
    const logPath = process.env.PAPER_TRADING_LOG_FILE || './data/paper-trades.log';
    let entries = [];

    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile(logPath, 'utf-8');
      entries = content.trim().split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
    } catch {
      // No log file yet
    }

    // Grouper par token
    const byToken = {};
    for (const e of entries) {
      if (!byToken[e.token]) byToken[e.token] = [];
      byToken[e.token].push(e);
    }

    // Calculer P&L par trade (BUY → SELL pair)
    const trades = [];
    for (const [token, events] of Object.entries(byToken)) {
      const buys  = events.filter(e => e.action === 'BUY');
      const sells = events.filter(e => e.action === 'SELL');
      if (!buys.length) continue;

      const buy  = buys[0];
      const sell = sells.find(s => s.timestamp >= buy.timestamp) || null;

      const buyMC  = parseFloat(buy.current_mc);
      const sellMC = sell ? parseFloat(sell.current_mc) : null;
      const pnlPct = sellMC !== null && buyMC > 0 ? ((sellMC - buyMC) / buyMC) * 100 : null;

      trades.push({
        token: token.slice(0, 12) + '…',
        token_full: token,
        buy_time: buy.timestamp,
        buy_mc: buyMC,
        buy_reason: buy.reason,
        sell_time: sell?.timestamp || null,
        sell_mc: sellMC,
        sell_reason: sell?.reason || null,
        pnl_pct: pnlPct !== null ? parseFloat(pnlPct.toFixed(2)) : null,
        status: sellMC !== null ? (pnlPct >= 0 ? 'WIN' : 'LOSS') : 'OPEN'
      });
    }

    trades.sort((a, b) => new Date(a.buy_time) - new Date(b.buy_time));

    const completed = trades.filter(t => t.pnl_pct !== null);
    const wins      = completed.filter(t => t.pnl_pct > 0);
    const losses    = completed.filter(t => t.pnl_pct <= 0);
    const avgPnl    = completed.length ? completed.reduce((s, t) => s + t.pnl_pct, 0) / completed.length : 0;
    const totalPnl  = completed.reduce((s, t) => s + t.pnl_pct, 0);
    const winRate   = completed.length ? (wins.length / completed.length * 100) : 0;

    // Compter signaux bruts (hors NONE/HOLD)
    const rawBuy  = entries.filter(e => e.action === 'BUY').length;
    const rawSell = entries.filter(e => e.action === 'SELL').length;

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
        raw_buy_signals: rawBuy,
        raw_sell_signals: rawSell
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

// GET /api/paper-trades/:token/chart - Price history for chart
app.get('/api/paper-trades/:token/chart', async (req, res) => {
  try {
    const tokenPrefix = req.params.token;
    const logPath = process.env.PAPER_TRADING_LOG_FILE || './data/paper-trades.log';
    let entries = [];
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      entries = content.trim().split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
    } catch { return res.json({ success: true, ticks: [], buy: null, sell: null }); }

    // Filter for this token (match prefix or full)
    const tokenEntries = entries.filter(e => 
      e.token === tokenPrefix || e.token.startsWith(tokenPrefix) || tokenPrefix.startsWith(e.token?.slice(0,12))
    );

    if (!tokenEntries.length) return res.json({ success: true, ticks: [], buy: null, sell: null });

    // All ticks (BUY, SELL, HOLD, NONE with strategy=RIDE)
    const ticks = tokenEntries
      .filter(e => ['BUY', 'SELL', 'HOLD'].includes(e.action))
      .map(e => ({
        time: parseFloat(e.elapsed_min) * 60,
        mc: parseFloat(e.current_mc),
        action: e.action,
        reason: e.reason || ''
      }))
      .sort((a, b) => a.time - b.time);

    const buy = ticks.find(t => t.action === 'BUY') || null;
    const sell = ticks.find(t => t.action === 'SELL') || null;

    // Also get baseline from rideCache via DB
    let baseline = null;
    try {
      const fullToken = tokenEntries[0].token;
      const dbResult = await pool.query(
        'SELECT fdv_at_detection FROM token_events WHERE token_address = $1 LIMIT 1',
        [fullToken]
      );
      if (dbResult.rows.length) baseline = parseFloat(dbResult.rows[0].fdv_at_detection);
    } catch {}

    res.json({ success: true, ticks, buy, sell, baseline });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
