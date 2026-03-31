#!/usr/bin/env node
/**
 * WalletSource v10.18 — Dashboard API Server
 * Exposes real-time metrics via REST API
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';

dotenv.config();

// ═══ SOL Price — Live from CoinGecko, cached 12h ═══
let solPriceCache = { price: 140, fetchedAt: 0 };
const SOL_PRICE_TTL = 12 * 60 * 60 * 1000; // 12 hours

async function getSolPrice() {
  const now = Date.now();
  if (now - solPriceCache.fetchedAt < SOL_PRICE_TTL && solPriceCache.price > 0) {
    return solPriceCache.price;
  }
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d?.solana?.usd) {
      solPriceCache = { price: d.solana.usd, fetchedAt: now };
      console.log('[SOL PRICE] Updated: $' + d.solana.usd);
    }
  } catch(e) {
    console.error('[SOL PRICE] Fetch failed, using cached:', solPriceCache.price, e.message);
  }
  return solPriceCache.price;
}

// Fetch on startup
getSolPrice();


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTH — HTTP Basic Auth sur toutes les routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const DASH_USER = process.env.DASHBOARD_USER || 'raph';
const DASH_PASS = process.env.DASHBOARD_PASS || 'changeme';

app.use((req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="WalletSource Dashboard"');
    return res.status(401).send('Authentification requise');
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user !== DASH_USER || pass !== DASH_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="WalletSource Dashboard"');
    return res.status(401).send('Identifiants incorrects');
  }
  next();
});


const PORT = process.env.DASHBOARD_PORT || 3001;

// PostgreSQL pool
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname, { etag: false, maxAge: 0, setHeaders: (res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}}));

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
      FROM paper_trades WHERE buy_strategy = 'ULTRA'
    `);
    stats.std = stdStats.rows[0];

    // NEO stats
    const neoStats = await pool.query(`
      SELECT
        count(*) FILTER (WHERE action='SELL') as trades,
        round(100.0 * count(*) FILTER (WHERE action='SELL' AND pnl_pct > 0) / NULLIF(count(*) FILTER (WHERE action='SELL'), 0), 1) as wr,
        round(avg(pnl_pct) FILTER (WHERE action='SELL'), 1) as avg_pnl
      FROM paper_trades WHERE buy_strategy = 'SWARM3'
    `);
    stats.neo = neoStats.rows[0];

    // SWARM stats
    const swarmStats = await pool.query(`
      SELECT
        count(*) FILTER (WHERE action='SELL') as trades,
        round(100.0 * count(*) FILTER (WHERE action='SELL' AND pnl_pct > 0) / NULLIF(count(*) FILTER (WHERE action='SELL'), 0), 1) as wr,
        round(avg(pnl_pct) FILTER (WHERE action='SELL'), 1) as avg_pnl
      FROM paper_trades WHERE buy_strategy = 'SWARM'
    `);
    stats.swarm = swarmStats.rows[0];

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
// Auto-fix: reclassify any SWARM trades still tagged as STD at startup
pool.query(`UPDATE paper_trades SET buy_strategy='ULTRA', strategy_version='ULTRA v7' WHERE buy_strategy='STD' AND reason ILIKE '%ULTRA%'`)
  .catch(() => {});
pool.query(`UPDATE paper_trades SET buy_strategy='SWARM3', strategy_version='SWARM v3' WHERE buy_strategy='SWARM' AND reason ILIKE '%SWARM v3%'`)
  .catch(() => {});
pool.query(`UPDATE paper_trades SET buy_strategy='SWARM', strategy_version='SWARM v1.2' WHERE buy_strategy='STD' AND reason ILIKE '%SWARM%'`)
  .then(r => { if (r.rowCount > 0) console.log('[startup] Fixed ' + r.rowCount + ' SWARM trades tagged as STD'); })
  .catch(() => {});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  WalletSource v10.18 — Dashboard API Server              ║
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
        entry_strategy: buy.buy_strategy || 'ULTRA',
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
      const strat = t.entry_strategy || 'ULTRA';
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
    // Realistic fees from live trade data (30 Mar 2026)
    // Buy slip: 6.5% avg (entry cost higher than MC). Sell slip: 5% normal, 15% HS (rug gaps)
    const BUY_SLIP = 0.065, SELL_SLIP_NORMAL = 0.05, SELL_SLIP_HS = 0.15, PUMP_FEE = 0.01;
    const JITO_BUY = 0.0001, JITO_SELL = 0.00045, BASE_FEE = 0.000005;

    const { rows: buys } = await pool.query(
      `SELECT token_address, timestamp, mc_usd, confidence, position_sol, quality_score,
              wallet_risk, buyers, ratio, dumps, sell_ratio, top_holder_pct, avg_buy_usd,
              reason, buy_strategy, strategy, strategy_version
       FROM paper_trades WHERE action='BUY' AND buy_strategy != 'CARTEL' ORDER BY timestamp`
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
      // Handle DEPOSIT/WITHDRAW entries
      if (buy.side === 'DEPOSIT' || buy.side === 'WITHDRAW') {
        tradeLog.push({
          token: buy.side,
          token_full: 'SOL',
          action: buy.side,
          timestamp: buy.executed_at,
          sell_timestamp: null,
          position_sol: parseFloat(buy.sol_actual || 0),
          buy_strategy: buy.side,
          strategy_version: '',
          buy_reason: buy.reason,
          exit_reason: null,
          exit_type: null,
          pnl_sol: null,
          pnl_pct: null,
          fees_sol: 0,
          balance_after: buy.balance_after ? parseFloat(buy.balance_after) : null,
          balance_before: null,
          wallet_impact_pct: null,
        });
        continue;
      }
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
        const isHS = (sell.exit_type || sell.reason || '').includes('HARD_STOP');
        const sellSlip = isHS ? SELL_SLIP_HS : SELL_SLIP_NORMAL;
        sSlip = gross * sellSlip; sPump = gross * PUMP_FEE; sJito = JITO_SELL + BASE_FEE;
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
        position_tier: buy.buy_strategy || 'ULTRA',
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
        peak_pct: sell?.peak_pct != null ? parseFloat(parseFloat(sell.peak_pct).toFixed(1)) : null,
        balance_before: null, // computed after balance walk
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
        initial_sol: INITIAL_SOL, sol_price_usd: await getSolPrice(),
        slippage_buy_bps: BUY_SLIP * 10000, slippage_sell_bps: SELL_SLIP_NORMAL * 10000, slippage_sell_hs_bps: SELL_SLIP_HS * 10000,
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
// GET /api/live-wallet — même format que wallet-sim, données réelles
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/live-wallet', async (req, res) => {
  try {
    // 1. Solde réel on-chain
    let walletBalance = null;
    let walletAddress = process.env.TRADING_WALLET_ADDRESS || null;
    try {
      if (!walletAddress) {
        const { rows } = await pool.query(
          `SELECT wallet_address FROM live_trades_v2 WHERE wallet_address IS NOT NULL ORDER BY executed_at DESC LIMIT 1`
        );
        walletAddress = rows[0]?.wallet_address || null;
      }
      if (walletAddress) {
        const rpcUrl = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
        const rpcRes = await fetch(rpcUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [walletAddress] })
        });
        const rpcData = await rpcRes.json();
        walletBalance = (rpcData?.result?.value ?? 0) / 1e9;
      }
    } catch(e) { console.error('RPC balance error:', e.message); }

    // 2. Récupérer les BUY depuis live_trades_v2
    const { rows: buys } = await pool.query(`
      SELECT id, side, token_address, sol_intended, sol_actual,
             fee_sol, jito_tip_sol, slippage_sol, slippage_pct,
             tx_signature, reason, buy_strategy, strategy_version,
             quality_score, buyers, ratio, mc_usd, latency_ms, executed_at, wallet_address, parsed_ok, balance_after
      FROM live_trades_v2 WHERE side IN ('BUY','DEPOSIT','WITHDRAW') ORDER BY executed_at
    `);

    // 3. Récupérer les SELL
    const { rows: sells } = await pool.query(`
      SELECT token_address, sol_out_actual, sol_actual,
             pnl_sol, pnl_pct, pnl_gross_sol,
             fee_sol, jito_tip_sol, slippage_sol,
             tx_signature, tx_sig_buy, reason, exit_type,
             mc_usd, latency_ms, executed_at, parsed_ok, balance_after
      FROM live_trades_v2 WHERE side='SELL' ORDER BY executed_at
    `);

    const sellMap = {};
    for (const s of sells) {
      const key = s.tx_sig_buy || s.token_address;
      sellMap[key] = sellMap[key] || [];
      sellMap[key].push(s);
    }

    // 4. Reconstruire le wallet réel
    // Use RPC balance as anchor, walk backward to find initial, then forward for per-trade balance
    let totalFees = 0, totalJito = 0, totalSlip = 0;
    let wins = 0, losses = 0;
    const tradeLog = [];
    
    // Compute net flow from all trades to derive initial balance
    // initial = currentRPC - sum(all sell proceeds) + sum(all buy costs)
    let netFlow = 0; // positive = wallet gained, negative = wallet lost

    for (const buy of buys) {
      // Handle DEPOSIT/WITHDRAW entries
      if (buy.side === 'DEPOSIT' || buy.side === 'WITHDRAW') {
        tradeLog.push({
          token: buy.side,
          token_full: 'SOL',
          action: buy.side,
          timestamp: buy.executed_at,
          sell_timestamp: null,
          position_sol: parseFloat(buy.sol_actual || 0),
          buy_strategy: buy.side,
          strategy_version: '',
          buy_reason: buy.reason,
          exit_reason: null,
          exit_type: null,
          pnl_sol: null,
          pnl_pct: null,
          fees_sol: 0,
          balance_after: buy.balance_after ? parseFloat(buy.balance_after) : null,
          balance_before: null,
          wallet_impact_pct: null,
        });
        continue;
      }
      const key = buy.tx_signature || buy.token_address;
      const sellArr = sellMap[key] || sellMap[buy.token_address] || [];
      // Mark ALL sells for this buy (tier exits + final trail = multiple SELLs per BUY)
      const matchedSells = sellArr.filter(s => !s._used);
      matchedSells.forEach(s => s._used = true);
      // Aggregate: combine tier exits + trail into one result
      const sell = matchedSells.length > 0 ? (() => {
        if (matchedSells.length === 1) return matchedSells[0];
        // Multiple sells: sum SOL received, aggregate P&L, use last sell's reason/time
        const agg = { ...matchedSells[matchedSells.length - 1] }; // base on last (trail close)
        let totalSolOut = 0, totalPnl = 0, totalFee = 0, totalJito = 0;
        const reasons = [];
        for (const s of matchedSells) {
          totalSolOut += parseFloat(s.sol_out_actual || s.sol_actual || 0);
          totalPnl += parseFloat(s.pnl_sol || 0);
          totalFee += parseFloat(s.fee_sol || 0);
          totalJito += parseFloat(s.jito_tip_sol || 0);
          reasons.push(s.reason);
        }
        agg.sol_actual = totalSolOut;
        agg.sol_out_actual = totalSolOut;
        agg.pnl_sol = totalPnl;
        agg.pnl_pct = buy.sol_actual > 0 ? (totalPnl / parseFloat(buy.sol_actual) * 100) : 0;
        agg.fee_sol = totalFee;
        agg.jito_tip_sol = totalJito;
        agg.reason = reasons.join(' → ');
        agg.exit_type = reasons[reasons.length - 1]?.includes('TRAIL') ? 'RT-TRAIL' : 
                         reasons[reasons.length - 1]?.includes('HARD_STOP') ? 'HARD_STOP' : 'TIER';
        return agg;
      })() : null;

      const pos     = parseFloat(buy.sol_intended || buy.sol_actual || 0);
      const feeBuy  = parseFloat(buy.fee_sol || 0);
      const jitoBuy = parseFloat(buy.jito_tip_sol || 0);
      const slipBuy = parseFloat(buy.slippage_sol || 0);
      // balance tracking deferred to after loop
      const buyCost = parseFloat(buy.sol_actual || pos) + feeBuy + jitoBuy;

      let pnlSol = null, pnlPct = null, exitType = null, exitReason = null;
      let feeSell = 0, jitoSell = 0, slipSell = 0, solReceived = null;

      if (sell) {
        solReceived = parseFloat(sell.sol_out_actual || sell.sol_actual || 0);
        feeSell  = parseFloat(sell.fee_sol  || 0);
        jitoSell = parseFloat(sell.jito_tip_sol || 0);
        slipSell = parseFloat(sell.slippage_sol || 0);
        pnlSol   = parseFloat(sell.pnl_sol);
        pnlPct   = parseFloat(sell.pnl_pct);
        exitType = sell.exit_type || (() => {
          const r = sell.reason || '';
          if (r.includes('HARD_STOP')) return 'HARD_STOP';
          if (r.includes('RT-TRAIL') || r.includes('TRAIL')) return 'RT-TRAIL';
          if (r.includes('PUMP3')) return 'PUMP3';
          return 'OTHER';
        })();
        exitReason = sell.reason;
        const sellProceeds = solReceived;
        if (pnlSol > 0) wins++; else losses++;
      }

      const tFee  = feeBuy  + feeSell;
      const tJito = jitoBuy + jitoSell;
      const tSlip = slipBuy + slipSell;
      if (sell) { totalFees += tFee; totalJito += tJito; totalSlip += tSlip; }

      tradeLog.push({
        // identique wallet-sim
        token: buy.token_address.slice(0,12) + '…',
        token_full: buy.token_address,
        action: sell && pnlSol !== null ? (pnlSol >= 0 ? 'WIN' : 'LOSS') : 'OPEN',
        timestamp: buy.executed_at,
        sell_timestamp: sell?.executed_at || null,
        position_sol: parseFloat(pos.toFixed(4)),
        position_tier: buy.buy_strategy || 'LIVE',
        buy_strategy: buy.buy_strategy || 'LIVE',
        strategy_version: buy.strategy_version || 'LIVE',
        quality_score: buy.quality_score,
        buy_mc: parseFloat(buy.mc_usd) || null,
        sell_mc: sell ? (parseFloat(sell.mc_usd) || null) : null,
        mc_change_pct: (parseFloat(buy.mc_usd) && sell && parseFloat(sell.mc_usd)) 
          ? parseFloat(((parseFloat(sell.mc_usd) - parseFloat(buy.mc_usd)) / parseFloat(buy.mc_usd) * 100).toFixed(1)) 
          : null,
        confidence: null,
        buyers: buy.buyers ? parseInt(buy.buyers) : null,
        ratio: buy.ratio ? parseFloat(buy.ratio) : null,
        buy_reason: buy.reason,
        exit_reason: exitReason,
        exit_type: exitType,
        fees_sol: parseFloat(tFee.toFixed(6)),
        slippage_sol: parseFloat(tSlip.toFixed(6)),
        jito_sol: parseFloat(tJito.toFixed(6)),
        jito_buy_sol: parseFloat(jitoBuy.toFixed(6)),
        jito_sell_sol: parseFloat((sell ? jitoSell : 0).toFixed(6)),
        base_fee_sol: parseFloat((feeBuy + feeSell).toFixed(6)),
        pump_fees_sol: 0,
        slippage_buy_sol: parseFloat(slipBuy.toFixed(6)),
        slippage_sell_sol: parseFloat(slipSell.toFixed(6)),
        wallet_impact_pct: null, // computed after balance walk
        pnl_sol: pnlSol !== null ? parseFloat(pnlSol.toFixed(6)) : null,
        pnl_pct: pnlPct !== null ? parseFloat(pnlPct.toFixed(2)) : null,
        balance_before: null, // computed after balance walk
        balance_after: sell?.balance_after ? parseFloat(sell.balance_after) : null,
        // extra live
        tx_buy: buy.tx_signature,
        tx_sell: sell?.tx_signature || null,
        parsed_ok: buy.parsed_ok,
        latency_buy_ms: buy.latency_ms,
        latency_sell_ms: sell?.latency_ms || null,
      });
    }

    const completed = tradeLog.filter(t => t.pnl_pct !== null);
    const avgPnl = completed.length ? completed.reduce((s,t) => s+t.pnl_pct, 0)/completed.length : 0;
    const wr = (wins+losses) > 0 ? parseFloat((wins/(wins+losses)*100).toFixed(1)) : 0;
    // Use RPC balance as authoritative
    const finalBal = walletBalance ?? 0;

    // ── Recompute balance_after as running total (ordered by event time) ──
    // Walk BACKWARD from current RPC balance
    // Include closed trades (by sell_timestamp) AND deposits/withdrawals (by timestamp)
    const balanceEvents = [];
    
    // Closed trades: use sell_timestamp as event time, delta = pnl_sol
    for (const t of tradeLog) {
      if (t.pnl_sol !== null && t.sell_timestamp) {
        balanceEvents.push({ ref: t, time: new Date(t.sell_timestamp), delta: t.pnl_sol });
      }
    }
    
    // DEPOSIT/WITHDRAW: use timestamp as event time, delta = +/- position_sol
    for (const t of tradeLog) {
      if (t.action === 'DEPOSIT') {
        balanceEvents.push({ ref: t, time: new Date(t.timestamp), delta: t.position_sol || 0 });
      } else if (t.action === 'WITHDRAW') {
        balanceEvents.push({ ref: t, time: new Date(t.timestamp), delta: -(t.position_sol || 0) });
      }
    }
    
    // Sort newest first (walk backward)
    balanceEvents.sort((a, b) => b.time - a.time);
    
    let runBal = finalBal;
    // Account for open positions (tokens not yet converted to SOL)
    const openTrades = tradeLog.filter(t => t.action === 'OPEN' && t.action !== 'DEPOSIT' && t.action !== 'WITHDRAW');
    for (const ot of openTrades) {
      runBal += ot.position_sol || 0;
    }
    
    for (const evt of balanceEvents) {
      evt.ref.balance_after = parseFloat(runBal.toFixed(6));
      evt.ref.balance_before = parseFloat((runBal - evt.delta).toFixed(6));
      if (evt.ref.action !== 'DEPOSIT' && evt.ref.action !== 'WITHDRAW') {
        evt.ref.wallet_impact_pct = evt.ref.balance_before > 0
          ? parseFloat(((evt.delta / evt.ref.balance_before) * 100).toFixed(2))
          : null;
      }
      runBal -= evt.delta; // go back in time
    }
    const initialBalance = parseFloat(runBal.toFixed(6));
    
    for (const ot of openTrades) {
      ot.balance_after = null;
    }
    const drag = finalBal > initialBalance
      ? parseFloat(((totalFees+totalSlip)/(totalFees+totalSlip+finalBal-initialBalance)*100).toFixed(1)) : 0;

    res.json({
      success: true,
      wallet: { address: walletAddress, balance_sol: walletBalance },
      config: {
        initial_sol: parseFloat(initialBalance.toFixed(4)),
        sol_price_usd: await getSolPrice(),
        slippage_buy_bps: 0, slippage_sell_bps: 0,
        pump_fee_bps: 0, priority_fee_sol: 0,
        jito_tip_buy_sol: 0, jito_tip_sell_sol: 0, max_mc_pct: 0
      },
      summary: {
        final_balance_sol: parseFloat(finalBal.toFixed(4)),
        total_pnl_sol: parseFloat((finalBal - initialBalance).toFixed(4)),
        total_pnl_pct: initialBalance > 0 ? parseFloat(((finalBal/initialBalance-1)*100).toFixed(2)) : 0,
        total_trades: completed.length + tradeLog.filter(t=>t.action==='OPEN').length,
        wins, losses,
        open: tradeLog.filter(t=>t.action==='OPEN').length,
        win_rate_pct: wr,
        avg_pnl_pct: parseFloat(avgPnl.toFixed(2)),
        total_fees_sol: parseFloat(totalFees.toFixed(6)),
        total_slippage_sol: parseFloat(totalSlip.toFixed(6)),
        total_jito_sol: parseFloat(totalJito.toFixed(6)),
        total_pump_fees_sol: 0,
        fees_drag_pct: drag,
      },
      trades: tradeLog
    });
  } catch (err) {
    console.error('live-wallet error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/wallet2', (req, res) => res.sendFile(path.join(__dirname, 'wallet2.html')));

// ═══ LIVE CONTROL APIs ═══

// ═══ DEFERRED RESTART — waits for positions to close ═══
let _deferredRestartTimer = null;
function scheduleDeferredRestart(reason) {
  if (_deferredRestartTimer) {
    console.log('⏳ Deferred restart already scheduled, skipping duplicate');
    return;
  }
  let attempts = 0;
  const maxAttempts = 60; // 10s × 60 = 10 minutes max
  _deferredRestartTimer = setInterval(async () => {
    attempts++;
    try {
      const cp = await import('child_process');
      const result = cp.execSync('bash scripts/safe-restart.sh', { 
        cwd: path.join(__dirname, '../..'), timeout: 10000 
      }).toString();
      console.log(`✅ Deferred restart succeeded (${reason}) after ${attempts} attempts`);
      clearInterval(_deferredRestartTimer);
      _deferredRestartTimer = null;
    } catch (e) {
      if (attempts >= maxAttempts) {
        console.error(`❌ Deferred restart timed out after ${maxAttempts} attempts (${reason})`);
        clearInterval(_deferredRestartTimer);
        _deferredRestartTimer = null;
      }
      // else keep polling
    }
  }, 10000);
  console.log(`⏳ Deferred restart scheduled (${reason}) — polling every 10s`);
}

// ═══ MARKET REGIME DETECTOR ═══
// Uses rolling 6h window of SWARM paper trades to detect market conditions
// BULL: avg6h > 15% AND wr6h > 50% → live ON
// WARM: avg6h > 5% AND wr6h > 40% → live ON
// NEUTRAL: between warm and bear → live stays as-is (no change)
// BEAR: avg6h < -5% OR wr6h < 35% → live OFF

let _lastRegime = null;
let _regimeCheckInterval = null;

async function checkMarketRegime() {
  try {
    const { rows } = await pool.query(`
      WITH recent AS (
        SELECT 
          s.pnl_pct,
          b.timestamp as buy_time,
          b.buy_strategy
        FROM paper_trades b
        JOIN paper_trades s ON s.token_address = b.token_address 
          AND s.action = 'SELL' AND s.timestamp > b.timestamp
        WHERE b.action = 'BUY' 
          AND b.buy_strategy = 'SWARM'
          AND b.timestamp > NOW() - INTERVAL '6 hours'
      )
      SELECT 
        COUNT(*) AS trades,
        ROUND(AVG(pnl_pct)::numeric, 1) AS avg_pnl,
        ROUND(COUNT(*) FILTER (WHERE pnl_pct > 0)::numeric / NULLIF(COUNT(*), 0), 2) AS wr,
        COUNT(*) FILTER (WHERE pnl_pct < -20) AS hard_stops
      FROM recent
    `);
    
    const r = rows[0];
    const trades = parseInt(r.trades);
    const avgPnl = parseFloat(r.avg_pnl) || 0;
    const wr = parseFloat(r.wr) || 0;
    const hs = parseInt(r.hard_stops);
    
    let regime, shouldTrade;
    
    if (trades < 5) {
      regime = 'INSUFFICIENT';
      shouldTrade = null; // don't change
    } else if (avgPnl > 15 && wr > 0.50) {
      regime = 'BULL';
      shouldTrade = true;
    } else if (avgPnl > 5 && wr > 0.40) {
      regime = 'WARM';
      shouldTrade = true;
    } else if (avgPnl < -5 || wr < 0.35) {
      regime = 'BEAR';
      shouldTrade = false;
    } else {
      regime = 'NEUTRAL';
      shouldTrade = null; // don't change
    }
    
    return { regime, shouldTrade, trades, avgPnl, wr, hs, timestamp: new Date().toISOString() };
  } catch (e) {
    console.error('Market regime check failed:', e.message);
    return { regime: 'ERROR', shouldTrade: null, error: e.message };
  }
}

async function autoToggleLive(regimeData) {
  if (regimeData.shouldTrade === null) return; // NEUTRAL/INSUFFICIENT → no change
  
  const fsSync = await import('fs');
  const cp = await import('child_process');
  const envPath = path.join(__dirname, '../../.env');
  const content = fsSync.readFileSync(envPath, 'utf-8');
  const currentDryRun = content.match(/^DRY_RUN=(.*)$/m)?.[1] === 'true';
  const isLive = !currentDryRun;
  
  if (regimeData.shouldTrade === isLive) return; // already in correct state
  
  const newDryRun = regimeData.shouldTrade ? 'false' : 'true';
  const newContent = content.replace(/^DRY_RUN=.*$/m, `DRY_RUN=${newDryRun}`);
  fsSync.writeFileSync(envPath, newContent);
  
  console.log(`🔄 Market regime: ${regimeData.regime} → DRY_RUN=${newDryRun} (was ${currentDryRun})`);
  
  // Schedule deferred restart
  scheduleDeferredRestart(`market-regime:${regimeData.regime}`);
}



// GET /api/market-regime — current market regime detection
app.get('/api/market-regime', async (req, res) => {
  const data = await checkMarketRegime();
  res.json(data);
});

// POST /api/market-regime/auto — enable/disable auto market regime toggle
let _autoRegimeEnabled = false;
app.post('/api/market-regime/auto', async (req, res) => {
  const { enabled } = req.body;
  _autoRegimeEnabled = !!enabled;
  
  if (_autoRegimeEnabled && !_regimeCheckInterval) {
    // Check every 5 minutes
    _regimeCheckInterval = setInterval(async () => {
      if (!_autoRegimeEnabled) return;
      const data = await checkMarketRegime();
      console.log(`📊 Regime check: ${data.regime} | trades=${data.trades} avg=${data.avgPnl}% wr=${(data.wr*100).toFixed(0)}%`);
      _lastRegime = data;
      await autoToggleLive(data);
    }, 5 * 60 * 1000);
    // Immediate first check
    const data = await checkMarketRegime();
    _lastRegime = data;
    console.log(`📊 Regime auto-toggle ENABLED: ${data.regime}`);
  } else if (!_autoRegimeEnabled && _regimeCheckInterval) {
    clearInterval(_regimeCheckInterval);
    _regimeCheckInterval = null;
    console.log('📊 Regime auto-toggle DISABLED');
  }
  
  res.json({ success: true, autoEnabled: _autoRegimeEnabled, currentRegime: _lastRegime });
});

// POST /api/send-sol — send SOL from trading wallet
app.post('/api/send-sol', async (req, res) => {
  try {
    const { to, amount } = req.body;
    if (!to || !amount || amount <= 0) return res.status(400).json({ success: false, error: 'Invalid params' });
    
    const { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } = await import('@solana/web3.js');
    const bs58 = await import('bs58');
    
    const conn = new Connection(process.env.HELIUS_RPC_URL);
    const kp = Keypair.fromSecretKey(bs58.default.decode(process.env.TRADING_PRIVATE_KEY));
    
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: new PublicKey(to),
        lamports: Math.round(amount * 1e9),
      })
    );
    
    const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
    const parsed = { success: true, tx: sig };
    if (parsed.success) {
      // Log the withdrawal in DB
      const balance = await (async () => {
        try {
          const rpcRes = await fetch(process.env.HELIUS_RPC_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [process.env.TRADING_WALLET_ADDRESS] })
          });
          const d = await rpcRes.json();
          return (d?.result?.value ?? 0) / 1e9;
        } catch { return null; }
      })();
      
      await pool.query(
        "INSERT INTO live_trades_v2 (token_address, side, sol_actual, reason, wallet_address, balance_after, tx_signature, executed_at, parsed_ok) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), true)",
        ['SOL', 'WITHDRAW', amount, '📤 WITHDRAW ' + amount.toFixed(4) + ' SOL → ' + to.slice(0, 8) + '...', process.env.TRADING_WALLET_ADDRESS, balance, parsed.tx]
      );
      
      res.json({ success: true, tx: parsed.tx, balance });
    } else {
      res.json({ success: false, error: 'TX failed' });
    }
  } catch (err) {
    console.error('send-sol error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ═══ RUNTIME CONFIG API — dynamic params, no restart needed ═══
const RUNTIME_CONFIG_PATH = path.join(__dirname, '../../runtime-config.json');

app.get('/api/runtime-config', (req, res) => {
  try {
    const raw = readFileSync(RUNTIME_CONFIG_PATH, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/runtime-config', (req, res) => {
  try {
    const current = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, 'utf-8'));
    const patch = req.body;
    
    // Deep merge
    function deepMerge(target, source) {
      for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key]) {
          deepMerge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
    }
    deepMerge(current, patch);
    current._updated = new Date().toISOString();
    current._version = (current._version || 0) + 1;
    
    // Also sync key values to .env for restart persistence
    if (patch.general?.max_position_sol !== undefined) {
      const envPath = path.join(__dirname, '../../.env');
      let env = readFileSync(envPath, 'utf-8');
      env = env.replace(/^MAX_POSITION_SOL=.*$/m, 'MAX_POSITION_SOL=' + patch.general.max_position_sol);
      writeFileSync(envPath, env);
    }
    if (patch.strategies) {
      const envPath = path.join(__dirname, '../../.env');
      let env = readFileSync(envPath, 'utf-8');
      if (patch.strategies.ULTRA?.enabled_live !== undefined) env = env.replace(/^LIVE_STD=.*$/m, 'LIVE_STD=' + patch.strategies.STD.enabled_live);
      if (patch.strategies.SWARM3?.enabled_live !== undefined) env = env.replace(/^LIVE_NEO=.*$/m, 'LIVE_NEO=' + patch.strategies.NEO.enabled_live);
      if (patch.strategies.SWARM?.enabled_live !== undefined) env = env.replace(/^LIVE_SWARM=.*$/m, 'LIVE_SWARM=' + patch.strategies.SWARM.enabled_live);
      writeFileSync(envPath, env);
    }
    
    writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(current, null, 2));
    res.json({ success: true, version: current._version, message: 'Applied — no restart needed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/config — read all strategy params from .env + TradeExecutor constants
app.get('/api/config', async (req, res) => {
  try {
    const fsSync = await import('fs');
    const envPath = path.join(__dirname, '../../.env');
    const envContent = fsSync.readFileSync(envPath, 'utf-8');
    const env = {};
    envContent.split('\n').forEach(line => {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    });
    
    // Read TradeExecutor.ts for hardcoded params
    const tsPath = path.join(__dirname, '../../src/execution/TradeExecutor.ts');
    const ts = fsSync.readFileSync(tsPath, 'utf-8');
    
    const extract = (pattern, fallback) => {
      const m = ts.match(pattern);
      return m ? m[1] : fallback;
    };
    
    res.json({
      success: true,
      live: {
        DRY_RUN: env.DRY_RUN === 'true',
        LIVE_TRADING: env.LIVE_TRADING === 'true',
        TRADING_WALLET: env.TRADING_WALLET_ADDRESS || '',
        MAX_POSITION_SOL: parseFloat(env.MAX_POSITION_SOL || '0.5'),
        MAX_DAILY_LOSS_SOL: parseFloat(env.MAX_DAILY_LOSS_SOL || '3.0'),
        SLIPPAGE_BPS: parseInt(env.SLIPPAGE_BPS || '1500'),
      },
      strategies: {
        STD: {
          enabled: true,
          slots: parseInt(extract(/MAX_STD\s*=\s*(\d+)/, '3')),
          min_buyers: parseInt(extract(/MIN_BUYERS\s*=\s*(\d+)/, '80')),
          min_ratio: parseFloat(extract(/mcRatio\s*<\s*([\d.]+)\).*v10\.1[78]/, '2.2')),
          max_ratio: parseFloat(extract(/mcRatio\s*>\s*([\d.]+)\)/, '3.0')),
          max_dumps: parseInt(extract(/totalDumps\s*>=\s*(\d+)/, '21')),
          max_avg_buy: parseInt(extract(/avgBuyUsd\s*>\s*(\d+)/, '50')),
          tier_exits: '20%@+30, +60, +100, +200',
          trail_pct: 22,
          trail_after_tiers: '15% (1 tier) → 10% (3+ tiers)',
          trail_activate: 15,
          hard_stop: -20,
          max_hold_sec: 600,
          window_sec: 110,
        },
        NEO: {
          enabled: true,
          slots: parseInt(extract(/MAX_NEO\s*=\s*(\d+)/, '1')),
          tier_exits: '20%@+30, +60, +100, +200',
          trail_base: 25,
          trail_tight: 15,
          trail_tight_at: 125,
          trail_after_tiers: '12% (1 tier) → 8% (3+ tiers)',
          trail_activate: 15,
          hard_stop: -20,
          max_hold_sec: 900,
          min_ratio: 1.3,
          max_ratio: 2.0,
          min_buyers: 20,
          q_min: 3,
        },
        SWARM: {
          enabled: true,
          slots: parseInt(extract(/MAX_SWARM\s*=\s*(\d+)/, '2')),
          min_buyers: 80,
          max_avg_buy: 25,
          min_ratio: 2.0,
          max_ratio: 3.5,
          tier_exits: '20%@+30, +60, +100, +200',
          trail_base: 18,
          trail_mid: 13,
          trail_mid_at: 50,
          trail_tight: 8,
          trail_tight_at: 200,
          trail_after_tiers: '13% (1T) → 10% (2T) → 8% (3T) → 6% (4T)',
          trail_activate: 30,
          hard_stop: -20,
          max_hold_sec: 600,
          max_hold_exempt_pnl: 50,
        },
        CARTEL: {
          enabled: false,
          slots: 0,
        }
      }
    });
  } catch (err) {
    console.error('config error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/live-toggle — toggle DRY_RUN in .env
app.post('/api/live-toggle', async (req, res) => {
  try {
    const fsSync = await import('fs');
    const cp = await import('child_process');
    const envPath = path.join(__dirname, '../../.env');
    let content = fsSync.readFileSync(envPath, 'utf-8');
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'enabled must be boolean' });
    
    content = content.replace(/^DRY_RUN=.*$/m, `DRY_RUN=${enabled ? 'false' : 'true'}`);
    fsSync.writeFileSync(envPath, content);
    
    // Try restart — deferred if positions open
    try {
      cp.execSync('bash scripts/safe-restart.sh', { cwd: path.join(__dirname, '../..'), timeout: 10000 });
      res.json({ success: true, DRY_RUN: !enabled, restarted: true, message: enabled ? 'LIVE TRADING ENABLED' : 'LIVE TRADING DISABLED (paper only)' });
    } catch (restartErr) {
      scheduleDeferredRestart('live-toggle');
      res.json({ success: true, DRY_RUN: !enabled, restarted: false, deferred: true, message: 'Changement enregistré — restart auto dès fermeture des positions' });
    }
  } catch (err) {
    console.error('live-toggle error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/strategy-toggle — enable/disable a strategy by setting slots to 0
app.post('/api/strategy-toggle', async (req, res) => {
  try {
    const fsSync = await import('fs');
    const cp = await import('child_process');
    const { strategy, enabled } = req.body;
    
    if (!['STD', 'NEO', 'SWARM', 'CARTEL'].includes(strategy)) {
      return res.status(400).json({ success: false, error: 'Invalid strategy' });
    }
    
    const tsPath = path.join(__dirname, '../../src/execution/TradeExecutor.ts');
    let ts = fsSync.readFileSync(tsPath, 'utf-8');
    
    const defaults = { STD: 3, NEO: 1, SWARM: 2, CARTEL: 0 };
    const varName = `MAX_${strategy}`;
    const newVal = enabled ? defaults[strategy] : 0;
    
    // Replace MAX_XXX = N
    const re = new RegExp(`(const\\s+${varName}\\s*=\\s*)\\d+`);
    ts = ts.replace(re, `$1${newVal}`);
    fsSync.writeFileSync(tsPath, ts);
    
    // Compile always (instant)
    cp.execSync('npx tsc', { cwd: path.join(__dirname, '../..'), timeout: 30000 });
    
    // Try restart — if positions open, schedule deferred restart
    try {
      cp.execSync('bash scripts/safe-restart.sh', { cwd: path.join(__dirname, '../..'), timeout: 10000 });
      res.json({ success: true, strategy, enabled, slots: newVal, restarted: true });
    } catch (restartErr) {
      // Positions open — schedule deferred restart that polls every 10s
      console.log(`⏳ Positions open — scheduling deferred restart for ${strategy} toggle`);
      scheduleDeferredRestart(`strategy-toggle:${strategy}`);
      res.json({ success: true, strategy, enabled, slots: newVal, restarted: false, deferred: true, message: 'Positions ouvertes — restart automatique dès fermeture' });
    }
  } catch (err) {
    console.error('strategy-toggle error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/live-strategy-toggle — enable/disable live trading per strategy (no restart needed)
app.post('/api/live-strategy-toggle', async (req, res) => {
  try {
    const fsSync = await import('fs');
    const { strategy, enabled } = req.body;
    
    if (!['ULTRA', 'SWARM', 'SWARM3'].includes(strategy)) {
      return res.status(400).json({ success: false, error: 'Invalid strategy' });
    }
    
    const envPath = path.join(__dirname, '../../.env');
    let env = fsSync.readFileSync(envPath, 'utf-8');
    const varName = `LIVE_${strategy}`;
    const val = enabled ? 'true' : 'false';
    
    const re = new RegExp(`^${varName}=.*$`, 'm');
    if (re.test(env)) {
      env = env.replace(re, `${varName}=${val}`);
    } else {
      env += `\n${varName}=${val}`;
    }
    fsSync.writeFileSync(envPath, env);
    
    // Update process.env in-memory for the dashboard
    process.env[varName] = val;
    
    // Also update the running bot's env via PM2 (no restart needed — env read at signal time)
    const cp = await import('child_process');
    try {
      cp.execSync(`pm2 set walletsource-db:env:${varName} ${val}`, { timeout: 5000 });
    } catch {}
    // Restart bot to pick up new env
    try {
      cp.execSync('bash scripts/safe-restart.sh', { cwd: path.join(__dirname, '../..'), timeout: 10000 });
      res.json({ success: true, strategy, live_enabled: enabled, restarted: true });
    } catch {
      scheduleDeferredRestart(`live-toggle:${strategy}`);
      res.json({ success: true, strategy, live_enabled: enabled, restarted: false, deferred: true });
    }
  } catch (err) {
    console.error('live-strategy-toggle error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/live-strategy-status — get per-strategy live/paper status
app.get('/api/live-strategy-status', async (req, res) => {
  const fsSync = await import('fs');
  const tsPath = path.join(__dirname, '../../src/execution/TradeExecutor.ts');
  const ts = fsSync.readFileSync(tsPath, 'utf-8');
  
  const getMax = (name) => { const m = ts.match(new RegExp(`const ${name} = (\\d+)`)); return m ? parseInt(m[1]) : 0; };
  
  res.json({
    success: true,
    strategies: {
      ULTRA: { paper_slots: getMax('MAX_ULTRA'), paper_enabled: getMax('MAX_ULTRA') > 0, live_enabled: process.env.LIVE_STD === 'true' },
      SWARM3: { paper_slots: getMax('MAX_SWARM3'), paper_enabled: getMax('MAX_SWARM3') > 0, live_enabled: false },
      SWARM: { paper_slots: getMax('MAX_SWARM'), paper_enabled: getMax('MAX_SWARM') > 0, live_enabled: process.env.LIVE_SWARM === 'true' },
    }
  });
});

// POST /api/config/save — save params to TradeExecutor.ts + .env, compile, safe-restart
app.post('/api/config/save', async (req, res) => {
  try {
    const fsSync = await import('fs');
    const cp = await import('child_process');
    const { params } = req.body; // { strategy: 'STD', key: 'min_buyers', value: 80 }
    
    if (!params || !Array.isArray(params)) {
      return res.status(400).json({ success: false, error: 'params must be an array' });
    }
    
    const tsPath = path.join(__dirname, '../../src/execution/TradeExecutor.ts');
    const envPath = path.join(__dirname, '../../.env');
    let ts = fsSync.readFileSync(tsPath, 'utf-8');
    let env = fsSync.readFileSync(envPath, 'utf-8');
    let changed = false;
    
    // Map of param keys to their regex patterns in the source
    const paramMap = {
      'ULTRA.min_buyers':    { pattern: /(const\s+MIN_BUYERS\s*=\s*)\d+/, file: 'ts' },
      'ULTRA.slots':         { pattern: /(const\s+MAX_ULTRA\s*=\s*)\d+/, file: 'ts' },
      'ULTRA.max_dumps':     { pattern: /(totalDumps\s*>=\s*)\d+/, file: 'ts' },
      'SWARM3.slots':         { pattern: /(const\s+MAX_SWARM3\s*=\s*)\d+/, file: 'ts' },
      'SWARM.slots':       { pattern: /(const\s+MAX_SWARM\s*=\s*)\d+/, file: 'ts' },
      'live.MAX_POSITION_SOL':   { pattern: /^(MAX_POSITION_SOL=).*$/m, file: 'env' },
      'live.MAX_DAILY_LOSS_SOL': { pattern: /^(MAX_DAILY_LOSS_SOL=).*$/m, file: 'env' },
      'live.SLIPPAGE_BPS':       { pattern: /^(SLIPPAGE_BPS=).*$/m, file: 'env' },
    };
    
    for (const p of params) {
      const key = `${p.strategy || 'live'}.${p.key}`;
      const mapping = paramMap[key];
      if (mapping) {
        if (mapping.file === 'ts') {
          ts = ts.replace(mapping.pattern, `$1${p.value}`);
        } else {
          env = env.replace(mapping.pattern, `$1${p.value}`);
        }
        changed = true;
      }
    }
    
    if (changed) {
      fsSync.writeFileSync(tsPath, ts);
      fsSync.writeFileSync(envPath, env);
      cp.execSync('npx tsc', { cwd: path.join(__dirname, '../..'), timeout: 30000 });
      cp.execSync('bash scripts/safe-restart.sh', { cwd: path.join(__dirname, '../..'), timeout: 30000 });
    }
    
    res.json({ success: true, message: changed ? 'Config saved + bot restarted' : 'No changes' });
  } catch (err) {
    console.error('config/save error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══ LOGS LIVE — Legal/Tax CSV exports ═══

import { createReadStream } from 'fs';
import { readdir, writeFile, stat, mkdir } from 'fs/promises';

const LOGS_DIR = path.join(__dirname, 'logs-live');

// Generate CSV for a given month
async function generateCSV(year, month) {
  const start = `${year}-${String(month).padStart(2,'0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const end = `${endYear}-${String(endMonth).padStart(2,'0')}-01`;
  
  const { rows } = await pool.query(`
    SELECT 
      id,
      executed_at AT TIME ZONE 'UTC' AS date_utc,
      confirmed_at AT TIME ZONE 'UTC' AS confirmed_utc,
      side,
      token_address,
      buy_strategy,
      strategy_version,
      exit_type,
      reason,
      sol_intended,
      sol_actual,
      sol_out_actual,
      tokens_amount,
      fee_sol,
      jito_tip_sol,
      slippage_sol,
      slippage_pct,
      pnl_sol,
      pnl_pct,
      pnl_gross_sol,
      mc_usd,
      ratio,
      buyers,
      quality_score,
      tx_signature,
      tx_sig_buy,
      wallet_address,
      jito_bundle,
      latency_ms,
      parsed_ok,
      balance_after,
      sol_price_chf,
      sol_price_usd
    FROM live_trades_v2
    WHERE executed_at >= $1 AND executed_at < $2
    ORDER BY executed_at ASC
  `, [start, end]);
  
  if (rows.length === 0) return null;
  
  // CSV header
  const headers = [
    'ID','Date_UTC','Confirmed_UTC','Side','Token','Strategy','Version',
    'Exit_Type','SOL_Intended','SOL_Actual','SOL_Out','Tokens',
    'Fee_SOL','Jito_Tip_SOL','Slippage_SOL','Slippage_PCT',
    'PnL_SOL','PnL_PCT','PnL_Gross_SOL','MC_USD','Ratio','Buyers',
    'Quality','TX_Signature','TX_Sig_Buy','Wallet','Jito_Bundle',
    'Latency_MS','Parsed_OK','Balance_After_SOL',
    'SOL_Price_CHF','SOL_Price_USD',
    'Acquisition_CHF','Cession_CHF','PnL_CHF','Fees_CHF','Portfolio_Value_CHF',
    'Reason'
  ];
  
  const csvRows = [headers.join(',')];
  
  // Check if we need to split (>5000 rows per file)
  const SPLIT = 5000;
  let fileIndex = 1;
  let currentRows = [headers.join(',')];
  const files = [];
  
  for (const r of rows) {
    const escapeCsv = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    
    const line = [
      r.id,
      r.date_utc ? new Date(r.date_utc).toISOString() : '',
      r.confirmed_utc ? new Date(r.confirmed_utc).toISOString() : '',
      r.side,
      r.token_address,
      r.buy_strategy,
      r.strategy_version,
      r.exit_type || '',
      r.sol_intended,
      r.sol_actual,
      r.sol_out_actual || '',
      r.tokens_amount || '',
      r.fee_sol,
      r.jito_tip_sol,
      r.slippage_sol || '',
      r.slippage_pct || '',
      r.pnl_sol || '',
      r.pnl_pct || '',
      r.pnl_gross_sol || '',
      r.mc_usd || '',
      r.ratio || '',
      r.buyers || '',
      r.quality_score ?? '',
      r.tx_signature || '',
      r.tx_sig_buy || '',
      r.wallet_address || '',
      r.jito_bundle ?? '',
      r.latency_ms || '',
      r.parsed_ok ?? '',
      r.balance_after || '',
      r.sol_price_chf || '',
      r.sol_price_usd || '',
      // Fiscal EUR calculations
      r.side === 'BUY' && r.sol_actual && r.sol_price_chf ? (parseFloat(r.sol_actual) * parseFloat(r.sol_price_chf)).toFixed(2) : '',
      r.side === 'SELL' && r.sol_out_actual && r.sol_price_chf ? (parseFloat(r.sol_out_actual) * parseFloat(r.sol_price_chf)).toFixed(2) : '',
      r.pnl_sol && r.sol_price_chf ? (parseFloat(r.pnl_sol) * parseFloat(r.sol_price_chf)).toFixed(2) : '',
      (parseFloat(r.fee_sol || 0) + parseFloat(r.jito_tip_sol || 0)) * (parseFloat(r.sol_price_chf) || 0) ? ((parseFloat(r.fee_sol || 0) + parseFloat(r.jito_tip_sol || 0)) * parseFloat(r.sol_price_chf)).toFixed(4) : '',
      r.balance_after && r.sol_price_chf ? (parseFloat(r.balance_after) * parseFloat(r.sol_price_chf)).toFixed(2) : '',
      escapeCsv(r.reason || '')
    ].map(v => escapeCsv(v)).join(',');
    
    currentRows.push(line);
    
    if (currentRows.length > SPLIT) {
      const fname = `live_trades_${year}-${String(month).padStart(2,'0')}_part${fileIndex}.csv`;
      await mkdir(LOGS_DIR, { recursive: true });
      await writeFile(path.join(LOGS_DIR, fname), currentRows.join('\n'), 'utf-8');
      files.push(fname);
      fileIndex++;
      currentRows = [headers.join(',')];
    }
  }
  
  // Write remaining
  if (currentRows.length > 1) {
    const fname = fileIndex > 1 
      ? `live_trades_${year}-${String(month).padStart(2,'0')}_part${fileIndex}.csv`
      : `live_trades_${year}-${String(month).padStart(2,'0')}.csv`;
    await mkdir(LOGS_DIR, { recursive: true });
    await writeFile(path.join(LOGS_DIR, fname), currentRows.join('\n'), 'utf-8');
    // Protect CSV: append-only
    try { cp.execSync('chattr +a ' + path.join(LOGS_DIR, fname)); } catch(e) {}
    files.push(fname);
  }
  
  return { files, totalRows: rows.length };
}

// GET /api/logs-live — list available CSVs + stats
app.get('/api/logs-live', async (req, res) => {
  try {
    // Get months with data
    const { rows: months } = await pool.query(`
      SELECT 
        EXTRACT(YEAR FROM executed_at)::int AS year,
        EXTRACT(MONTH FROM executed_at)::int AS month,
        COUNT(*) AS trades,
        COUNT(*) FILTER (WHERE side='BUY') AS buys,
        COUNT(*) FILTER (WHERE side='SELL') AS sells,
        COALESCE(SUM(pnl_sol) FILTER (WHERE side='SELL'), 0)::numeric(10,6) AS total_pnl_sol,
        COALESCE(SUM(fee_sol), 0)::numeric(10,6) AS total_fees,
        COALESCE(SUM(jito_tip_sol), 0)::numeric(10,6) AS total_jito,
        MIN(executed_at) AS first_trade,
        MAX(executed_at) AS last_trade
      FROM live_trades_v2
      WHERE executed_at IS NOT NULL
      GROUP BY year, month
      ORDER BY year DESC, month DESC
    `);
    
    // List existing CSV files
    let existingFiles = [];
    try {
      const dir = await readdir(LOGS_DIR);
      for (const f of dir) {
        if (!f.endsWith('.csv')) continue;
        const s = await stat(path.join(LOGS_DIR, f));
        existingFiles.push({ name: f, size: s.size, modified: s.mtime });
      }
    } catch(e) { /* dir doesn't exist yet */ }
    
    res.json({ success: true, months: months.map(m => ({
      year: m.year, month: m.month,
      trades: parseInt(m.trades), buys: parseInt(m.buys), sells: parseInt(m.sells),
      total_pnl_sol: parseFloat(m.total_pnl_sol), total_fees: parseFloat(m.total_fees),
      total_jito: parseFloat(m.total_jito),
      first_trade: m.first_trade, last_trade: m.last_trade
    })), files: existingFiles });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/logs-live/generate — generate CSV for a month
app.post('/api/logs-live/generate', async (req, res) => {
  try {
    const { year, month } = req.body;
    if (!year || !month) return res.status(400).json({ success: false, error: 'year and month required' });
    const result = await generateCSV(year, month);
    if (!result) return res.json({ success: true, message: 'No trades for this month', files: [] });
    res.json({ success: true, ...result });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/logs-live/download/:filename — download CSV
app.get('/api/logs-live/download/:filename', (req, res) => {
  const fname = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  const fpath = path.join(LOGS_DIR, fname);
  res.download(fpath, fname, (err) => {
    if (err) res.status(404).json({ success: false, error: 'File not found' });
  });
});

// GET /logs-live — serve the page
app.get('/logs-live', (req, res) => res.sendFile(path.join(__dirname, 'logs-live.html')));

// GET /api/sol-price — current price + last update
app.get('/api/sol-price', async (req, res) => {
  const price = await getSolPrice();
  res.json({ 
    success: true, 
    price, 
    fetchedAt: new Date(solPriceCache.fetchedAt).toISOString(),
    ageMinutes: Math.round((Date.now() - solPriceCache.fetchedAt) / 60000)
  });
});

// POST /api/sol-price/refresh — force refresh
app.post('/api/sol-price/refresh', async (req, res) => {
  solPriceCache.fetchedAt = 0; // force refetch
  const price = await getSolPrice();
  res.json({ success: true, price, message: 'Price refreshed' });
});
