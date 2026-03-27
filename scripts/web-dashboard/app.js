/**
 * WalletSourceDB v4.0 — Dashboard Frontend Logic
 */

const API_BASE = window.location.origin;
const REFRESH_INTERVAL = 2000; // 2 seconds

let isOnline = false;

// ━━━ Fetch Stats from API ━━━
async function fetchStats() {
  try {
    const response = await fetch(`${API_BASE}/api/stats`);
    if (!response.ok) throw new Error('API request failed');

    const data = await response.json();
    if (!data.success) throw new Error('API returned error');

    updateDashboard(data.stats);
    setOnlineStatus(true);

  } catch (error) {
    console.error('Failed to fetch stats:', error);
    setOnlineStatus(false);
  }
}

// ━━━ Update Dashboard UI ━━━
function updateDashboard(stats) {
  // Token Detection
  setText('total-tokens', formatNumber(stats.detection.total_tokens));
  setText('unique-wallets', formatNumber(stats.detection.unique_wallets));
  setText('last-5min', formatNumber(stats.detection.last_5min));

  // Queue
  setText('queue-pending', formatNumber(stats.queue.pending));
  setText('queue-processing', formatNumber(stats.queue.processing));
  setText('queue-done', formatNumber(stats.queue.done));
  setText('total-snapshots', formatNumber(stats.snapshots));

  // Verdicts
  const rugTotal = (stats.verdicts.rug_no_pair || 0) + (stats.verdicts.rug_metrics || 0);
  setText('verdict-rug', formatNumber(rugTotal));
  setText('verdict-success', formatNumber(stats.verdicts.success || 0));
  setText('verdict-neutral', formatNumber(stats.verdicts.neutral || 0));
  setText('verdict-pending', formatNumber(stats.verdicts.pending || 0));

  // Playbooks
  setText('playbooks-total', formatNumber(stats.playbooks.total));
  setText('strategy-ride', formatNumber(stats.playbooks.strategies.ride));
  setText('strategy-fade', formatNumber(stats.playbooks.strategies.fade));
  setText('strategy-avoid', formatNumber(stats.playbooks.strategies.avoid));
  setText('strategy-watch', formatNumber(stats.playbooks.strategies.watch));

  // Wallets
  setText('wallets-1', formatNumber(stats.wallets.wallets_1));
  setText('wallets-2', formatNumber(stats.wallets.wallets_2));
  setText('wallets-3plus', formatNumber(stats.wallets.wallets_3plus));
  setText('wallets-5plus', formatNumber(stats.wallets.wallets_5plus));
  setText('wallets-10plus', formatNumber(stats.wallets.wallets_10plus));

  // Ruggers
  setText('ruggers-3plus', formatNumber(stats.ruggers.rugs_3plus));
  setText('ruggers-5plus', formatNumber(stats.ruggers.rugs_5plus));

  // Performance
  const doneRate = stats.performance.doneLastHour;
  const expectedRate = stats.performance.expectedRate;
  const ratePercent = expectedRate > 0 ? Math.round((doneRate / expectedRate) * 100) : 0;

  setText('perf-rate', `${formatNumber(doneRate)} (${ratePercent}%)`);

  const apiUsage = stats.performance.apiUsage;
  const apiLimit = stats.performance.apiLimit;
  const apiPercent = Math.round((apiUsage / apiLimit) * 100);

  setText('perf-api', formatNumber(apiUsage));
  setText('api-percent', `${apiPercent}%`);

  const progressBar = document.getElementById('api-progress');
  progressBar.style.width = `${apiPercent}%`;
  if (apiPercent > 80) {
    progressBar.classList.add('warning');
  } else {
    progressBar.classList.remove('warning');
  }

  // Paper Trades
  setText('paper-total', formatNumber(stats.paperTrades.total));
  setText('paper-buy', formatNumber(stats.paperTrades.buy));
  setText('paper-sell', formatNumber(stats.paperTrades.sell));
  setText('paper-short', formatNumber(stats.paperTrades.short));

  // Latest Activity
  if (stats.latest.token) {
    const token = stats.latest.token.token_address.substring(0, 40) + '...';
    const wallet = stats.latest.token.creator_wallet.substring(0, 40) + '...';
    setText('latest-token', `${token} (${wallet})`);
  } else {
    setText('latest-token', 'No tokens yet');
  }

  if (stats.latest.snapshot) {
    const snapshot = stats.latest.snapshot.token_address.substring(0, 40) + '...';
    const ago = Math.round(stats.latest.snapshot.minutes_ago);
    setText('latest-snapshot', `${snapshot} @ ${ago} min ago`);
  } else {
    setText('latest-snapshot', 'No snapshots yet');
  }

  // CARTEL stats
  if (stats.cartel) {
    const c = stats.cartel;
    setText('cartel-trades', c.trades || '0');
    const wrEl = document.getElementById('cartel-wr');
    if (wrEl) {
      wrEl.textContent = c.wr ? c.wr + '%' : '-';
      wrEl.className = 'value ' + (parseFloat(c.wr) >= 50 ? 'success' : 'danger');
    }
    const pnlEl = document.getElementById('cartel-avg-pnl');
    if (pnlEl) {
      const pnl = parseFloat(c.avg_pnl) || 0;
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl + '%';
      pnlEl.className = 'value ' + (pnl >= 0 ? 'success' : 'danger');
    }
  }
  if (stats.cartelGroups) {
    setText('cartel-good-wallets', formatNumber(stats.cartelGroups.good_wallets));
    setText('cartel-good-count', formatNumber(stats.cartelGroups.good_count));
    setText('cartel-watched', formatNumber(stats.cartelGroups.good_wallets)); // WalletWatcher tracks all ELITE
  }

  // Strategy performance cards
  for (const strat of ['std', 'neo', 'cartel']) {
    const d = stats[strat + 'Stats'] || stats[strat] || {};
    setText('strat-' + strat + '-trades', d.trades || '0');
    const wrEl = document.getElementById('strat-' + strat + '-wr');
    if (wrEl) {
      wrEl.textContent = d.wr ? d.wr + '%' : '-';
      wrEl.className = 'value ' + (parseFloat(d.wr) >= 50 ? 'success' : 'danger');
    }
    const pEl = document.getElementById('strat-' + strat + '-pnl');
    if (pEl) {
      const p = parseFloat(d.avg_pnl) || 0;
      pEl.textContent = (p >= 0 ? '+' : '') + p + '%';
      pEl.className = 'value ' + (p >= 0 ? 'success' : 'danger');
    }
  }

  // Helius info
  if (stats.helius) {
    setText('helius-budget', Math.round(stats.helius.dailyLimit / 1000) + 'K');
    setText('helius-used', stats.helius.note || 'in-process');
  }

  // Update timestamp
  setText('last-update', new Date().toLocaleTimeString());
}

// ━━━ Set Online Status ━━━
function setOnlineStatus(online) {
  isOnline = online;
  const badge = document.getElementById('status-badge');
  const text = document.getElementById('status-text');

  if (online) {
    badge.classList.add('online');
    text.textContent = 'Online';
  } else {
    badge.classList.remove('online');
    text.textContent = 'Offline';
  }
}

// ━━━ Utility Functions ━━━
function setText(id, text) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = text;
  }
}

function formatNumber(num) {
  if (num === null || num === undefined) return '-';
  return parseInt(num).toLocaleString();
}

// ━━━ Initialize ━━━
function init() {
  console.log('WalletSourceDB Dashboard v10.14 initialized');
  fetchStats();
  setInterval(fetchStats, REFRESH_INTERVAL);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ── Paper Trades P&L ──────────────────────────────────────────────────────
async function loadPaperTrades() {
  try {
    const res  = await fetch('/api/paper-trades');
    const data = await res.json();
    if (!data.success) return;

    const s = data.summary;

    // Summary
    document.getElementById('pt-completed').textContent = s.completed;
    document.getElementById('pt-open').textContent      = s.open;

    const wrEl = document.getElementById('pt-winrate');
    wrEl.textContent = s.completed ? `${s.win_rate_pct}%` : '—';
    wrEl.className   = 'value ' + (s.win_rate_pct >= 50 ? 'success' : 'danger');

    const avgEl = document.getElementById('pt-avg-pnl');
    avgEl.textContent = s.completed ? `${s.avg_pnl_pct > 0 ? '+' : ''}${s.avg_pnl_pct}%` : '—';
    avgEl.className   = 'value ' + (s.avg_pnl_pct >= 0 ? 'success' : 'danger');

    const totEl = document.getElementById('pt-total-pnl');
    totEl.textContent = s.completed ? `${s.total_pnl_pct > 0 ? '+' : ''}${s.total_pnl_pct}%` : '—';
    totEl.className   = 'value ' + (s.total_pnl_pct >= 0 ? 'success' : 'danger');

    document.getElementById('pt-best').textContent    = s.best_pct  !== null ? `+${s.best_pct}%`  : '—';
    document.getElementById('pt-worst').textContent   = s.worst_pct !== null ? `${s.worst_pct}%` : '—';
    document.getElementById('pt-wins').textContent    = s.wins;
    document.getElementById('pt-losses').textContent  = s.losses;
    document.getElementById('pt-raw-buy').textContent  = s.raw_buy_signals;
    document.getElementById('pt-raw-sell').textContent = s.raw_sell_signals;

    // Per-strategy breakdown
    const stratDiv = document.getElementById('strategy-breakdown');
    if (s.strategies && stratDiv) {
      const colors = {'STD': '#ff9800', 'NEO': '#f44336', 'CARTEL': '#9c27b0', 'RUGGER': '#e040fb', 'v10-MARKET': '#4fc3f7', 'RE-ENTRY': '#ff9800', 'EARLY': '#66bb6a'};
      stratDiv.innerHTML = Object.entries(s.strategies).map(([name, st]) => {
        const color = colors[name] || '#888';
        const wrClass = st.win_rate >= 50 ? 'success' : 'danger';
        const pnlSign = st.avg_pnl >= 0 ? '+' : '';
        return `<div style="background:#1a1a2e;border:1px solid ${color}44;border-radius:8px;padding:10px 14px;min-width:180px">
          <div style="color:${color};font-weight:700;font-size:0.85rem;margin-bottom:6px">${name}</div>
          <div style="font-size:0.75rem;color:#aaa">
            <div>${st.count} trades (${st.wins}W / ${st.losses}L)</div>
            <div>WR: <span class="${wrClass}" style="font-weight:600">${st.win_rate}%</span></div>
            <div>Avg: <span style="color:${st.avg_pnl >= 0 ? '#4caf50' : '#ef5350'};font-weight:600">${pnlSign}${st.avg_pnl}%</span></div>
            <div>Total: <span style="color:${st.total_pnl >= 0 ? '#4caf50' : '#ef5350'}">${pnlSign}${st.total_pnl}%</span></div>
          </div>
        </div>`;
      }).join('');
    }

    // Table
    const tbody = document.getElementById('pt-tbody');
    if (!data.trades.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#666">Aucun trade enregistré</td></tr>';
      return;
    }

    tbody.innerHTML = data.trades.map((t, i) => {
      const pnlClass  = t.status === 'WIN' ? 'pnl-win' : t.status === 'LOSS' ? 'pnl-loss' : 'pnl-open';
      const badgeClass= t.status === 'WIN' ? 'badge-win' : t.status === 'LOSS' ? 'badge-loss' : 'badge-open';
      const pnlStr    = t.pnl_pct !== null ? `${t.pnl_pct > 0 ? '+' : ''}${t.pnl_pct}%` : '—';
      const buyTime   = t.buy_time  ? new Date(t.buy_time).toLocaleTimeString()  : '—';
      const mcEntry   = t.buy_mc    ? `$${t.buy_mc.toLocaleString('fr-FR', {maximumFractionDigits:0})}` : '—';
      const mcExit    = t.sell_mc   ? `$${t.sell_mc.toLocaleString('fr-FR', {maximumFractionDigits:0})}` : '—';
      
      // Strategy badge
      const stratColors = {'STD': '#ff9800', 'NEO': '#f44336', 'CARTEL': '#9c27b0', 'RUGGER': '#e040fb', 'v10-MARKET': '#4fc3f7', 'RE-ENTRY': '#ff9800', 'EARLY': '#66bb6a'};
      const stratColor = stratColors[t.entry_strategy] || '#888';
      const stratLabel = t.entry_strategy || 'UNKNOWN';
      
      // Exit type + detail
      const exitLabel = t.exit_type || '—';
      const exitDetail = t.exit_detail || '';
      const exitColors = {
        'RUGGER_TARGET': '#e040fb', 'RUGGER_TSTOP': '#ce93d8', 'RUGGER_HS': '#ef5350', 'RUGGER_TRAIL': '#ab47bc',
        'TIER': '#4fc3f7', 'PUMP3': '#ff9800', 'HARD_STOP': '#ef5350', 'MAX_HOLD': '#78909c',
        'LOWER_HIGH': '#ffa726', 'TRACK_END': '#78909c', 'SWEEP': '#78909c', 'EXIT': '#999'
      };
      const exitColor = exitColors[exitLabel] || '#666';

      return `<tr>
        <td>${i + 1}</td>
        <td><span style="background:${stratColor}22;color:${stratColor};padding:2px 8px;border-radius:4px;font-size:0.7rem;font-weight:600;white-space:nowrap">${stratLabel}</span></td>
        <td class="mono" title="${t.token_full}">${t.token}</td>
        <td>${buyTime}</td>
        <td>${mcEntry}</td>
        <td>${mcExit}</td>
        <td class="${pnlClass}">${pnlStr}</td>
        <td><span class="badge ${badgeClass}">${t.status}</span></td>
        <td style="max-width:180px"><span style="color:${exitColor};font-size:0.7rem;font-weight:600">${exitLabel}</span>${exitDetail ? `<br><span style="color:#777;font-size:0.65rem">${exitDetail}</span>` : ''}</td>
        <td><button onclick="showChart('${t.token_full}', '${t.token}')" style="background:#2a2a4a;border:1px solid #444;color:#4fc3f7;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.75rem;white-space:nowrap" onmouseover="this.style.background='#3a3a5a'" onmouseout="this.style.background='#2a2a4a'">📈</button></td>
      </tr>`;
    }).join('');

  } catch (err) {
    console.error('Paper trades load error:', err);
  }
}

// Charger au démarrage et toutes les 10s
loadPaperTrades();
setInterval(loadPaperTrades, 10000);

// ── Trade Chart Modal ─────────────────────────────────────────────────────
let tradeChart = null;

function closeChart() {
  document.getElementById('chart-modal').style.display = 'none';
  if (tradeChart) { tradeChart.destroy(); tradeChart = null; }
}

// Close on Escape or background click
document.getElementById('chart-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('chart-modal')) closeChart();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChart(); });

async function showChart(tokenFull, tokenShort) {
  try {
    const res = await fetch(`/api/paper-trades/${encodeURIComponent(tokenFull)}/chart`);
    const data = await res.json();
    if (!data.success || !data.ticks.length) {
      alert('Pas de données pour ce token');
      return;
    }

    const modal = document.getElementById('chart-modal');
    modal.style.display = 'flex';

    const ctx = document.getElementById('trade-chart').getContext('2d');
    if (tradeChart) tradeChart.destroy();

    const ticks = data.ticks;
    const labels = ticks.map(t => t.time.toFixed(1) + 's');
    const prices = ticks.map(t => t.mc);
    const buyTick = data.buy;
    const sellTick = data.sell;
    const baseline = data.baseline;
    const entryMC = buyTick ? buyTick.mc : prices[0];

    // Find buy/sell indices
    const buyIdx = ticks.findIndex(t => t.action === 'BUY');
    const sellIdx = ticks.findIndex(t => t.action === 'SELL');

    // Create segments with phase colors
    const segmentColors = ticks.map((t, i) => {
      if (i < buyIdx || buyIdx === -1) return 'rgba(255, 193, 7, 0.6)'; // observe = gold
      if (i >= buyIdx && (sellIdx === -1 || i <= sellIdx)) {
        return prices[i] >= entryMC ? '#00e676' : '#ff5252'; // hold = green/red
      }
      return 'rgba(100, 100, 100, 0.4)'; // post-sell = grey
    });

    // Point styles — bigger for BUY/SELL, tiny for others
    const pointRadii = ticks.map(t => 
      t.action === 'BUY' ? 8 : t.action === 'SELL' ? 8 : 1
    );
    const pointColors = ticks.map((t, i) => {
      if (t.action === 'BUY') return '#00e676';
      if (t.action === 'SELL') return t.mc >= entryMC ? '#00e676' : '#ff5252';
      return segmentColors[i];
    });
    const pointBorders = ticks.map(t => 
      (t.action === 'BUY' || t.action === 'SELL') ? '#fff' : 'transparent'
    );

    // Annotations
    const annotations = {};

    if (buyTick && buyIdx >= 0) {
      annotations.buyLabel = {
        type: 'label', xValue: buyIdx, yValue: buyTick.mc,
        content: ['🟢 BUY', '$' + Math.round(buyTick.mc).toLocaleString()],
        color: '#00e676', font: { size: 11, weight: 'bold' },
        position: 'start', yAdjust: -25,
      };
      // Vertical line at buy
      annotations.buyLine = {
        type: 'line', xMin: buyIdx, xMax: buyIdx,
        borderColor: 'rgba(0, 230, 118, 0.3)', borderWidth: 1, borderDash: [4, 4],
      };
    }

    if (sellTick && sellIdx >= 0) {
      const sellColor = sellTick.mc >= entryMC ? '#00e676' : '#ff5252';
      const pnl = ((sellTick.mc - entryMC) / entryMC * 100).toFixed(1);
      const reason = (sellTick.reason || '').replace(/\(.*?\)/g, '').replace(/P&L.*$/, '').trim().slice(0, 35);
      annotations.sellLabel = {
        type: 'label', xValue: sellIdx, yValue: sellTick.mc,
        content: ['🔴 SELL ' + (pnl > 0 ? '+' : '') + pnl + '%', '$' + Math.round(sellTick.mc).toLocaleString(), reason],
        color: sellColor, font: { size: 10, weight: 'bold' },
        position: 'end', yAdjust: 25,
      };
      annotations.sellLine = {
        type: 'line', xMin: sellIdx, xMax: sellIdx,
        borderColor: 'rgba(255, 82, 82, 0.3)', borderWidth: 1, borderDash: [4, 4],
      };
    }

    if (baseline) {
      annotations.baselineLine = {
        type: 'line', yMin: baseline, yMax: baseline,
        borderColor: 'rgba(255, 193, 7, 0.4)', borderWidth: 1, borderDash: [6, 4],
        label: { display: true, content: 'Baseline $' + Math.round(baseline).toLocaleString(),
          position: 'start', color: '#ffc107', font: { size: 10 }, backgroundColor: 'rgba(0,0,0,0.6)' }
      };
    }

    // Peak
    const peakMC = Math.max(...prices);
    annotations.peakLine = {
      type: 'line', yMin: peakMC, yMax: peakMC,
      borderColor: 'rgba(0, 230, 118, 0.25)', borderWidth: 1, borderDash: [4, 4],
      label: { display: true, content: 'Peak $' + Math.round(peakMC).toLocaleString(),
        position: 'end', color: '#00e676', font: { size: 10 }, backgroundColor: 'rgba(0,0,0,0.6)' }
    };

    // Phase backgrounds
    if (buyIdx > 0) {
      annotations.observeZone = {
        type: 'box', xMin: 0, xMax: buyIdx,
        backgroundColor: 'rgba(255, 193, 7, 0.04)', borderWidth: 0,
        label: { display: true, content: '👁 OBSERVE', position: { x: 'center', y: 'start' },
          color: 'rgba(255, 193, 7, 0.5)', font: { size: 11 } }
      };
    }
    if (buyIdx >= 0 && sellIdx > buyIdx) {
      annotations.holdZone = {
        type: 'box', xMin: buyIdx, xMax: sellIdx,
        backgroundColor: 'rgba(79, 195, 247, 0.04)', borderWidth: 0,
        label: { display: true, content: '📊 POSITION', position: { x: 'center', y: 'start' },
          color: 'rgba(79, 195, 247, 0.5)', font: { size: 11 } }
      };
    }
    if (sellIdx >= 0 && sellIdx < ticks.length - 1) {
      annotations.postZone = {
        type: 'box', xMin: sellIdx, xMax: ticks.length - 1,
        backgroundColor: 'rgba(100, 100, 100, 0.04)', borderWidth: 0,
        label: { display: true, content: '👻 POST-SELL', position: { x: 'center', y: 'start' },
          color: 'rgba(100, 100, 100, 0.5)', font: { size: 11 } }
      };
    }

    // Title
    const pnl = sellTick && buyTick ? ((sellTick.mc - buyTick.mc) / buyTick.mc * 100).toFixed(1) : '?';
    const pnlColor = pnl > 0 ? '#00e676' : '#ff5252';
    document.getElementById('chart-title').innerHTML = 
      `📈 ${tokenShort} <span style="color:${pnlColor};font-size:0.9em">${pnl > 0 ? '+' : ''}${pnl}%</span>`;

    // Info bar
    const observeTicks = ticks.filter(t => t.phase === 'observe').length;
    const holdTicks = ticks.filter(t => t.action === 'HOLD').length;
    const postTicks = ticks.filter(t => t.phase === 'post').length;
    const totalSec = ticks.length > 0 ? (ticks[ticks.length-1].time - ticks[0].time).toFixed(0) : 0;
    document.getElementById('chart-info').innerHTML = 
      `<span>⏱ ${totalSec}s total</span>` +
      `<span style="color:#ffc107">👁 ${observeTicks} observe</span>` +
      `<span style="color:#4fc3f7">📊 ${holdTicks} hold</span>` +
      `<span style="color:#666">👻 ${postTicks} post-sell</span>` +
      `<span>📍 ${ticks.length} points</span>`;

    tradeChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Market Cap (USD)',
          data: prices,
          segment: {
            borderColor: ctx2 => segmentColors[ctx2.p0DataIndex] || '#4fc3f7',
          },
          borderWidth: 2,
          pointRadius: pointRadii,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointBorders,
          pointBorderWidth: ticks.map(t => (t.action === 'BUY' || t.action === 'SELL') ? 2 : 0),
          fill: false,
          tension: 0.1,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false },
          annotation: { annotations },
          tooltip: {
            callbacks: {
              title: (items) => 'T+' + labels[items[0].dataIndex],
              label: (item) => {
                const mc = item.raw;
                const pnl = entryMC > 0 ? ((mc - entryMC) / entryMC * 100).toFixed(1) : '0';
                const tick = ticks[item.dataIndex];
                const phase = tick.phase || tick.action;
                return [`MC: $${Math.round(mc).toLocaleString()} (${pnl > 0 ? '+' : ''}${pnl}%)`, `Phase: ${phase}`];
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'Temps depuis création', color: '#888' },
            ticks: { color: '#666', maxTicksLimit: 20 },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            title: { display: true, text: 'Market Cap ($)', color: '#888' },
            ticks: { color: '#666', callback: v => '$' + Math.round(v).toLocaleString() },
            grid: { color: 'rgba(255,255,255,0.05)' },
          }
        }
      }
    });
  } catch (err) {
    console.error('Chart error:', err);
    alert('Erreur lors du chargement du chart');
  }
}
async function loadV9Stats() {
  try {
    const res = await fetch('/api/v9-stats');
    if (!res.ok) { console.error('v9 API error:', res.status); return; }
    const data = await res.json();
    if (!data.success) { console.error('v9 API not success:', data); return; }

    // RIDE stats
    const r = data.ride || {};
    setText('v9-ride-wallets', formatNumber(r.wallets || 0));
    setText('v9-ride-clean', formatNumber(r.clean_wallets || 0));
    setText('v9-ride-tokens', formatNumber(r.tokens || 0));
    setText('v9-ride-pumprate', (r.pump_rate || '0') + '%');
    setText('v9-ride-3x', formatNumber(r.pumps_3x || 0));
    const pnlEl = document.getElementById('v9-ride-pnl');
    if (pnlEl) {
      const pnl = parseFloat(r.avg_pnl_pct) || 0;
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl + '%';
      pnlEl.className = 'value ' + (pnl >= 0 ? 'success' : 'danger');
    }

    // FADE stats
    const f = data.fade || {};
    setText('v9-fade-wallets', formatNumber(f.wallets || 0));
    setText('v9-fade-tokens', formatNumber(f.tokens || 0));
    setText('v9-fade-pumprate', (f.pump_rate || '0') + '%');
    const fPnl = document.getElementById('v9-fade-pnl');
    if (fPnl) {
      const fp = parseFloat(f.avg_pnl_pct) || 0;
      fPnl.textContent = (fp >= 0 ? '+' : '') + fp + '%';
      fPnl.className = 'value ' + (fp >= 0 ? 'info' : 'danger');
    }

    // 10h activity
    const h = data.recent_10h || {};
    setText('v9-10h-tokens', formatNumber(h.tokens_10h || 0));
    setText('v9-10h-success', formatNumber(h.success_10h || 0));
    setText('v9-10h-rug', formatNumber(h.rug_10h || 0));
    setText('v9-10h-neutral', formatNumber(h.neutral_10h || 0));

    // Changes list
    const changesEl = document.getElementById('v9-changes');
    if (changesEl && data.changes && data.changes.length) {
      changesEl.innerHTML = '<ul style="margin:4px 0;padding-left:20px;list-style:none">' +
        data.changes.map(c => '<li style="margin:6px 0;padding:4px 0;border-bottom:1px solid #21262d">✅ ' + c + '</li>').join('') +
        '</ul>';
    } else if (changesEl) {
      changesEl.textContent = 'No changes data';
    }

    // Top RIDE wallets table
    const tbody = document.getElementById('v9-ride-tbody');
    if (tbody && data.top_ride && data.top_ride.length) {
      tbody.innerHTML = data.top_ride.map(function(w) {
        var isClean = parseInt(w.rug_count) === 0;
        var type = isClean
          ? '<span style="color:#00e676;font-weight:bold">🌟 CLEAN</span>'
          : '<span style="color:#ffc107">🔴 RUGGER</span>';
        var pr = parseFloat(w.pump_rate) || 0;
        var prClass = pr >= 50 ? 'success' : pr >= 30 ? 'info' : '';
        var peakMC = parseInt(w.avg_peak_mc) || 0;
        return '<tr>' +
          '<td class="mono" style="font-size:0.7rem">' + w.wallet_address.slice(0,8) + '…' + w.wallet_address.slice(-4) + '</td>' +
          '<td>' + type + '</td>' +
          '<td>' + w.rug_count + '</td>' +
          '<td style="color:#00e676">' + w.survival_count + '</td>' +
          '<td>' + w.tokens + '</td>' +
          '<td style="color:#00e676">' + w.pumps + '</td>' +
          '<td class="value ' + prClass + '">' + pr + '%</td>' +
          '<td>$' + peakMC.toLocaleString() + '</td>' +
          '</tr>';
      }).join('');
    } else if (tbody) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#666">Aucun wallet RIDE actif</td></tr>';
    }

    console.log('v9 stats loaded OK:', { ride: r.wallets, fade: f.wallets, changes: (data.changes||[]).length, top: (data.top_ride||[]).length });
  } catch (err) {
    console.error('v9 stats load error:', err);
    var changesEl = document.getElementById('v9-changes');
    if (changesEl) changesEl.textContent = 'Error: ' + err.message;
  }
}

loadV9Stats();
setInterval(loadV9Stats, 15000);

// ── System Health ─────────────────────────────────────────────────────────
async function loadSystemHealth() {
  try {
    const res = await fetch('/api/system-health?t=' + Date.now());
    if (!res.ok) return;
    const d = await res.json();

    const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };

    // Uptime
    const up = d.uptime || 0;
    el('health-uptime', Math.floor(up/3600) + 'h ' + Math.floor((up%3600)/60) + 'm');

    // Memory  
    el('health-memory', (d.memory?.heapMB || '?') + ' MB');

    // DB connections
    el('health-db', (d.db?.active || '?') + ' active / ' + (d.db?.idle || '?') + ' idle');

    // Open positions
    el('health-open-pos', d.openPositions ?? '-');

    // WS reconnects
    el('health-ws-reconnects', d.wsReconnects ?? '-');
  } catch (err) {
    console.error('Health fetch error:', err.message);
  }
}
// Ensure DOM is ready before starting health checks
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { loadSystemHealth(); setInterval(loadSystemHealth, 10000); });
} else {
  loadSystemHealth();
  setInterval(loadSystemHealth, 10000);
}
