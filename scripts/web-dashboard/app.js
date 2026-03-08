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
