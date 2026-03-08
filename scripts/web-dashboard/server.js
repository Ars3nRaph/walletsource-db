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
