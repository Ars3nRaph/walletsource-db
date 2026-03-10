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
  console.log('WalletSourceDB Dashboard v4.0 initialized');
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
      const sellReason= (t.sell_reason || '—').replace(/\(.*\)/, '').trim().slice(0, 40);

      return `<tr>
        <td>${i + 1}</td>
        <td class="mono" title="${t.token_full}">${t.token}</td>
        <td>${buyTime}</td>
        <td>${mcEntry}</td>
        <td>${mcExit}</td>
        <td class="${pnlClass}">${pnlStr}</td>
        <td><span class="badge ${badgeClass}">${t.status}</span></td>
        <td style="color:#888;font-size:0.75rem">${sellReason}</td>
        <td><button onclick="showChart('${t.token_full}', '${t.token}')" style="background:#2a2a4a;border:1px solid #444;color:#4fc3f7;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.75rem;white-space:nowrap" onmouseover="this.style.background='#3a3a5a'" onmouseout="this.style.background='#2a2a4a'">📈 Chart</button></td>
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

    // Colors based on relative position to entry
    const entryMC = buyTick ? buyTick.mc : prices[0];
    const pointColors = prices.map(p => p >= entryMC ? '#00e676' : '#ff5252');

    // Annotations
    const annotations = {};

    if (buyTick) {
      const buyIdx = ticks.findIndex(t => t.action === 'BUY');
      annotations.buyPoint = {
        type: 'point',
        xValue: buyIdx,
        yValue: buyTick.mc,
        backgroundColor: '#00e676',
        borderColor: '#fff',
        borderWidth: 2,
        radius: 8,
      };
      annotations.buyLabel = {
        type: 'label',
        xValue: buyIdx,
        yValue: buyTick.mc,
        content: ['🟢 BUY', '$' + Math.round(buyTick.mc).toLocaleString()],
        color: '#00e676',
        font: { size: 11, weight: 'bold' },
        position: 'start',
        yAdjust: -25,
      };
    }

    if (sellTick) {
      const sellIdx = ticks.findIndex(t => t.action === 'SELL');
      const sellColor = sellTick.mc >= entryMC ? '#00e676' : '#ff5252';
      annotations.sellPoint = {
        type: 'point',
        xValue: sellIdx,
        yValue: sellTick.mc,
        backgroundColor: sellColor,
        borderColor: '#fff',
        borderWidth: 2,
        radius: 8,
      };
      // Clean sell reason for display
      const reason = sellTick.reason
        .replace(/\(.*?\)/g, '')
        .replace(/P&L.*$/, '')
        .trim()
        .slice(0, 35);
      annotations.sellLabel = {
        type: 'label',
        xValue: sellIdx,
        yValue: sellTick.mc,
        content: ['🔴 SELL', '$' + Math.round(sellTick.mc).toLocaleString(), reason],
        color: sellColor,
        font: { size: 10, weight: 'bold' },
        position: 'end',
        yAdjust: 25,
      };
    }

    if (baseline) {
      annotations.baselineLine = {
        type: 'line',
        yMin: baseline,
        yMax: baseline,
        borderColor: 'rgba(255, 193, 7, 0.4)',
        borderWidth: 1,
        borderDash: [6, 4],
        label: {
          display: true,
          content: 'Baseline $' + Math.round(baseline).toLocaleString(),
          position: 'start',
          color: '#ffc107',
          font: { size: 10 },
          backgroundColor: 'rgba(0,0,0,0.6)',
        }
      };
    }

    // Peak line
    const peakMC = Math.max(...prices);
    const peakIdx = prices.indexOf(peakMC);
    annotations.peakLine = {
      type: 'line',
      yMin: peakMC,
      yMax: peakMC,
      borderColor: 'rgba(0, 230, 118, 0.25)',
      borderWidth: 1,
      borderDash: [4, 4],
      label: {
        display: true,
        content: 'Peak $' + Math.round(peakMC).toLocaleString(),
        position: 'end',
        color: '#00e676',
        font: { size: 10 },
        backgroundColor: 'rgba(0,0,0,0.6)',
      }
    };

    tradeChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Market Cap (USD)',
          data: prices,
          borderColor: '#4fc3f7',
          backgroundColor: 'rgba(79, 195, 247, 0.08)',
          borderWidth: 2,
          pointRadius: 2,
          pointBackgroundColor: pointColors,
          fill: true,
          tension: 0.2,
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
                return `MC: $${Math.round(mc).toLocaleString()} (${pnl > 0 ? '+' : ''}${pnl}%)`;
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'Temps depuis création', color: '#888' },
            ticks: { color: '#666', maxTicksLimit: 15 },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            title: { display: true, text: 'Market Cap (USD)', color: '#888' },
            ticks: {
              color: '#666',
              callback: (v) => '$' + (v >= 1000 ? (v/1000).toFixed(1) + 'k' : v)
            },
            grid: { color: 'rgba(255,255,255,0.05)' },
          }
        }
      }
    });

    // Title & info
    document.getElementById('chart-title').textContent = `📈 ${tokenShort}`;
    const pnl = buyTick && sellTick ? ((sellTick.mc - buyTick.mc) / buyTick.mc * 100).toFixed(1) : null;
    const peakPnl = buyTick ? ((peakMC - buyTick.mc) / buyTick.mc * 100).toFixed(1) : null;
    const captured = pnl && peakPnl && parseFloat(peakPnl) > 0 ? (parseFloat(pnl) / parseFloat(peakPnl) * 100).toFixed(0) : null;
    const duration = sellTick ? (sellTick.time - (buyTick?.time || 0)).toFixed(1) : null;

    let infoHtml = '';
    if (buyTick) infoHtml += `<span>🟢 Entrée: <b>$${Math.round(buyTick.mc).toLocaleString()}</b> (T+${buyTick.time.toFixed(1)}s)</span>`;
    if (sellTick) infoHtml += `<span>🔴 Sortie: <b>$${Math.round(sellTick.mc).toLocaleString()}</b> (T+${sellTick.time.toFixed(1)}s)</span>`;
    if (pnl) infoHtml += `<span style="color:${parseFloat(pnl) >= 0 ? '#00e676' : '#ff5252'}">P&L: <b>${pnl > 0 ? '+' : ''}${pnl}%</b></span>`;
    if (peakPnl) infoHtml += `<span>Peak: <b>+${peakPnl}%</b></span>`;
    if (captured) infoHtml += `<span>Capturé: <b>${captured}%</b> du peak</span>`;
    if (duration) infoHtml += `<span>Durée: <b>${duration}s</b></span>`;
    if (sellTick) infoHtml += `<span style="color:#ffc107">Raison: ${sellTick.reason.slice(0, 60)}</span>`;
    document.getElementById('chart-info').innerHTML = infoHtml;

  } catch (err) {
    console.error('Chart error:', err);
    alert('Erreur chargement chart: ' + err.message);
  }
}
