#!/bin/bash

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Function to run SQL query
query() {
  docker exec walletsource-db psql -U walletsource -d walletsource -t -c "$1" 2>/dev/null | sed 's/^[ \t]*//'
}

while true; do
  # Clear screen completely
  clear

  echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║  ${CYAN}WalletSourceDB v4.0 — Real-Time Monitoring Dashboard${BLUE}     ║${NC}"
  echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""

  # =========================
  # SECTION 1: DETECTION
  # =========================
  echo -e "${GREEN}━━━ 📡 Token Detection${NC}"

  total_tokens=$(query "SELECT COUNT(*) FROM token_events;")
  total_wallets=$(query "SELECT COUNT(DISTINCT creator_wallet) FROM token_events;")
  tokens_last_5min=$(query "SELECT COUNT(*) FROM token_events WHERE detected_at > NOW() - INTERVAL '5 minutes';")

  echo -e "  Total tokens detected: ${YELLOW}${total_tokens}${NC}"
  echo -e "  Unique wallets:        ${YELLOW}${total_wallets}${NC}"
  echo -e "  Last 5 minutes:        ${YELLOW}${tokens_last_5min}${NC}"
  echo ""

  # =========================
  # SECTION 2: TRACKING
  # =========================
  echo -e "${GREEN}━━━ 📊 Token Tracking (30 min)${NC}"

  queue_pending=$(query "SELECT COUNT(*) FROM monitoring_queue WHERE status = 'PENDING';")
  queue_processing=$(query "SELECT COUNT(*) FROM monitoring_queue WHERE status = 'PROCESSING';")
  queue_done=$(query "SELECT COUNT(*) FROM monitoring_queue WHERE status = 'DONE';")
  total_snapshots=$(query "SELECT COUNT(*) FROM token_snapshots;")

  echo -e "  Queue PENDING:         ${YELLOW}${queue_pending}${NC}"
  echo -e "  Queue PROCESSING:      ${CYAN}${queue_processing}${NC}"
  echo -e "  Queue DONE:            ${GREEN}${queue_done}${NC}"
  echo -e "  Total snapshots:       ${YELLOW}${total_snapshots}${NC}"
  echo ""

  # =========================
  # SECTION 3: VERDICTS
  # =========================
  echo -e "${GREEN}━━━ ⚖️  Verdicts${NC}"

  rug_count=$(query "SELECT COUNT(*) FROM token_events WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS');")
  success_count=$(query "SELECT COUNT(*) FROM token_events WHERE verdict = 'SUCCESS';")
  neutral_count=$(query "SELECT COUNT(*) FROM token_events WHERE verdict = 'NEUTRAL';")
  pending_count=$(query "SELECT COUNT(*) FROM token_events WHERE verdict IS NULL;")

  echo -e "  ${RED}RUG:${NC}                   ${RED}${rug_count}${NC}"
  echo -e "  ${GREEN}SUCCESS:${NC}               ${GREEN}${success_count}${NC}"
  echo -e "  ${YELLOW}NEUTRAL:${NC}               ${YELLOW}${neutral_count}${NC}"
  echo -e "  ${CYAN}PENDING:${NC}               ${CYAN}${pending_count}${NC}"
  echo ""

  # =========================
  # SECTION 4: PLAYBOOKS
  # =========================
  echo -e "${GREEN}━━━ 📖 Rugger Playbooks${NC}"

  playbooks_total=$(query "SELECT COUNT(*) FROM wallet_profiles WHERE rugger_playbook IS NOT NULL;")
  ride_wallets=$(query "SELECT COUNT(*) FROM wallet_profiles WHERE strategy = 'RIDE';")
  fade_wallets=$(query "SELECT COUNT(*) FROM wallet_profiles WHERE strategy = 'FADE';")
  avoid_wallets=$(query "SELECT COUNT(*) FROM wallet_profiles WHERE strategy = 'AVOID';")
  watch_wallets=$(query "SELECT COUNT(*) FROM wallet_profiles WHERE strategy = 'WATCH';")

  echo -e "  Playbooks built:       ${YELLOW}${playbooks_total}${NC}"
  echo -e "  Strategy RIDE:         ${GREEN}${ride_wallets}${NC}"
  echo -e "  Strategy FADE:         ${CYAN}${fade_wallets}${NC}"
  echo -e "  Strategy AVOID:        ${RED}${avoid_wallets}${NC}"
  echo -e "  Strategy WATCH:        ${YELLOW}${watch_wallets}${NC}"
  echo ""

  # =========================
  # SECTION 5: RUGGER STATS
  # =========================
  echo -e "${GREEN}━━━ 🎯 Rugger Statistics${NC}"

  wallets_1=$(query "WITH wt AS (SELECT creator_wallet, COUNT(*) as c FROM token_events GROUP BY creator_wallet) SELECT COUNT(*) FROM wt WHERE c = 1;")
  wallets_2=$(query "WITH wt AS (SELECT creator_wallet, COUNT(*) as c FROM token_events GROUP BY creator_wallet) SELECT COUNT(*) FROM wt WHERE c = 2;")
  wallets_3plus=$(query "WITH wt AS (SELECT creator_wallet, COUNT(*) as c FROM token_events GROUP BY creator_wallet) SELECT COUNT(*) FROM wt WHERE c >= 3;")
  wallets_5plus=$(query "WITH wt AS (SELECT creator_wallet, COUNT(*) as c FROM token_events GROUP BY creator_wallet) SELECT COUNT(*) FROM wt WHERE c >= 5;")
  wallets_10plus=$(query "WITH wt AS (SELECT creator_wallet, COUNT(*) as c FROM token_events GROUP BY creator_wallet) SELECT COUNT(*) FROM wt WHERE c >= 10;")

  # RUG-specific stats (corrected - only count RUGs, not all tokens)
  rugs_3plus=$(query "SELECT COUNT(*) FROM (SELECT creator_wallet, COUNT(*) as c FROM token_events WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS') AND time_to_peak_min IS NOT NULL AND time_to_rug_min IS NOT NULL GROUP BY creator_wallet HAVING COUNT(*) >= 3) sub;")
  rugs_5plus=$(query "SELECT COUNT(*) FROM (SELECT creator_wallet, COUNT(*) as c FROM token_events WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS') AND time_to_peak_min IS NOT NULL AND time_to_rug_min IS NOT NULL GROUP BY creator_wallet HAVING COUNT(*) >= 5) sub;")

  echo -e "  Wallets 1 token:       ${YELLOW}${wallets_1}${NC}"
  echo -e "  Wallets 2 tokens:      ${YELLOW}${wallets_2}${NC}"
  echo -e "  Wallets 3+ tokens:     ${GREEN}${wallets_3plus}${NC}"
  echo -e "  Wallets 5+ tokens:     ${GREEN}${wallets_5plus}${NC}"
  echo -e "  Wallets 10+ tokens:    ${GREEN}${wallets_10plus}${NC}"
  echo ""
  echo -e "  ${CYAN}━━━ Rugger-Specific (3+ RUGs with lifecycle)${NC}"
  echo -e "  Wallets 3+ RUGs:       ${RED}${rugs_3plus}${NC} ${CYAN}(playbook eligible)${NC}"
  echo -e "  Wallets 5+ RUGs:       ${RED}${rugs_5plus}${NC} ${CYAN}(playbook reliable)${NC}"
  echo ""

  # =========================
  # SECTION 6: PAPER TRADES
  # =========================
  echo -e "${GREEN}━━━ 💰 Paper Trades${NC}"

  if [ -f "data/paper-trades.log" ]; then
    trade_count=$(wc -l < data/paper-trades.log 2>/dev/null || echo "0")
    buy_signals=$(grep -c '"action":"BUY"' data/paper-trades.log 2>/dev/null || echo "0")
    sell_signals=$(grep -c '"action":"SELL"' data/paper-trades.log 2>/dev/null || echo "0")
    short_signals=$(grep -c '"action":"SHORT"' data/paper-trades.log 2>/dev/null || echo "0")

    echo -e "  Total signals:         ${YELLOW}${trade_count}${NC}"
    echo -e "  BUY signals:           ${GREEN}${buy_signals}${NC}"
    echo -e "  SELL signals:          ${RED}${sell_signals}${NC}"
    echo -e "  SHORT signals:         ${CYAN}${short_signals}${NC}"
  else
    echo -e "  ${YELLOW}No trades yet (waiting for verdicts)${NC}"
  fi
  echo ""

  # =========================
  # SECTION 7: LATEST ACTIVITY
  # =========================
  echo -e "${GREEN}━━━ 🕐 Latest Activity${NC}"

  latest_token=$(query "SELECT token_address || ' (' || creator_wallet || ')' FROM token_events ORDER BY detected_at DESC LIMIT 1;")
  latest_snapshot=$(query "SELECT token_address || ' @ ' || ROUND(ABS(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - snapshot_at))/60), 1) || ' min ago' FROM token_snapshots ORDER BY snapshot_at DESC LIMIT 1;")

  echo -e "  Latest token:          ${latest_token}"
  echo -e "  Latest snapshot:       ${latest_snapshot}"
  echo ""

  # =========================
  # FOOTER
  # =========================
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}Refreshing every 2 seconds... Press Ctrl+C to stop${NC}"

  # Wait before refresh
  sleep 2
done
