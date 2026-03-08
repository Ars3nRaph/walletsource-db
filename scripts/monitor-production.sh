#!/bin/bash
# WalletSourceDB v4.0 — Production Monitoring Dashboard
# Usage: ./scripts/monitor-production.sh

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
NC='\033[0m'

# Database connection from .env
source .env 2>/dev/null || {
  echo "Error: Cannot load .env"
  exit 1
}

# Query function
query() {
  psql $DATABASE_URL -t -c "$1" 2>/dev/null | xargs
}

# Main loop
while true; do
  clear

  echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║  ${CYAN}WalletSourceDB v4.0 — Production Monitoring Dashboard${BLUE}  ║${NC}"
  echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""

  # ━━━ System Status ━━━
  echo -e "${GREEN}━━━ 🖥️  System Status${NC}"

  # PM2 status
  if pm2 describe walletsource-db > /dev/null 2>&1; then
    PM2_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="walletsource-db") | .pm2_env.status')
    PM2_UPTIME=$(pm2 jlist | jq -r '.[] | select(.name=="walletsource-db") | .pm2_env.pm_uptime' | xargs -I {} date -d @{} +"%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "N/A")
    PM2_MEMORY=$(pm2 jlist | jq -r '.[] | select(.name=="walletsource-db") | .monit.memory' | awk '{printf "%.0f MB", $1/1024/1024}')
    PM2_CPU=$(pm2 jlist | jq -r '.[] | select(.name=="walletsource-db") | .monit.cpu')

    if [ "$PM2_STATUS" == "online" ]; then
      echo -e "  Status:                ${GREEN}ONLINE${NC}"
    else
      echo -e "  Status:                ${RED}$PM2_STATUS${NC}"
    fi
    echo -e "  Uptime:                $PM2_UPTIME"
    echo -e "  Memory:                $PM2_MEMORY"
    echo -e "  CPU:                   ${PM2_CPU}%"
  else
    echo -e "  Status:                ${RED}NOT RUNNING${NC}"
  fi

  # Disk usage
  DISK_USAGE=$(df -h . | tail -1 | awk '{print $5}')
  echo -e "  Disk usage:            $DISK_USAGE"

  # PostgreSQL status
  if systemctl is-active --quiet postgresql 2>/dev/null; then
    echo -e "  PostgreSQL:            ${GREEN}RUNNING${NC}"
  else
    echo -e "  PostgreSQL:            ${YELLOW}CHECK STATUS${NC}"
  fi

  echo ""

  # ━━━ Token Detection ━━━
  echo -e "${GREEN}━━━ 📡 Token Detection${NC}"
  TOTAL_TOKENS=$(query "SELECT COUNT(*) FROM token_events;")
  UNIQUE_WALLETS=$(query "SELECT COUNT(DISTINCT creator_wallet) FROM token_events;")
  LAST_5MIN=$(query "SELECT COUNT(*) FROM token_events WHERE detected_at > NOW() - INTERVAL '5 minutes';")

  echo -e "  Total tokens detected: ${YELLOW}$TOTAL_TOKENS${NC}"
  echo -e "  Unique wallets:        ${YELLOW}$UNIQUE_WALLETS${NC}"
  echo -e "  Last 5 minutes:        ${YELLOW}$LAST_5MIN${NC}"
  echo ""

  # ━━━ Token Tracking ━━━
  echo -e "${GREEN}━━━ 📊 Token Tracking (30s × 10min)${NC}"
  PENDING=$(query "SELECT COUNT(*) FROM monitoring_queue WHERE status = 'PENDING';")
  PROCESSING=$(query "SELECT COUNT(*) FROM monitoring_queue WHERE status = 'PROCESSING';")
  DONE=$(query "SELECT COUNT(*) FROM monitoring_queue WHERE status = 'DONE';")
  SNAPSHOTS=$(query "SELECT COUNT(*) FROM token_snapshots;")

  echo -e "  Queue PENDING:         ${YELLOW}$PENDING${NC}"
  echo -e "  Queue PROCESSING:      ${CYAN}$PROCESSING${NC} / 135"
  echo -e "  Queue DONE:            ${GREEN}$DONE${NC}"
  echo -e "  Total snapshots:       ${YELLOW}$SNAPSHOTS${NC}"
  echo ""

  # ━━━ Verdicts ━━━
  echo -e "${GREEN}━━━ ⚖️  Verdicts${NC}"
  RUGS=$(query "SELECT COUNT(*) FROM token_events WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS');")
  SUCCESS=$(query "SELECT COUNT(*) FROM token_events WHERE verdict = 'SUCCESS';")
  NEUTRAL=$(query "SELECT COUNT(*) FROM token_events WHERE verdict = 'NEUTRAL';")
  PENDING_VERDICT=$(query "SELECT COUNT(*) FROM token_events WHERE verdict IS NULL;")

  echo -e "  ${RED}RUG:${NC}                   ${RED}$RUGS${NC}"
  echo -e "  ${GREEN}SUCCESS:${NC}               ${GREEN}$SUCCESS${NC}"
  echo -e "  ${YELLOW}NEUTRAL:${NC}               ${YELLOW}$NEUTRAL${NC}"
  echo -e "  ${CYAN}PENDING:${NC}               ${CYAN}$PENDING_VERDICT${NC}"
  echo ""

  # ━━━ Rugger Playbooks ━━━
  echo -e "${GREEN}━━━ 📖 Rugger Playbooks${NC}"
  PLAYBOOKS=$(query "SELECT COUNT(*) FROM wallet_profiles WHERE rugger_playbook IS NOT NULL;")
  RIDE=$(query "SELECT COUNT(*) FROM wallet_profiles WHERE rugger_playbook->>'recommended_strategy' = 'RIDE';")
  FADE=$(query "SELECT COUNT(*) FROM wallet_profiles WHERE rugger_playbook->>'recommended_strategy' = 'FADE';")
  AVOID=$(query "SELECT COUNT(*) FROM wallet_profiles WHERE rugger_playbook->>'recommended_strategy' = 'AVOID';")
  WATCH=$(query "SELECT COUNT(*) FROM wallet_profiles WHERE rugger_playbook->>'recommended_strategy' = 'WATCH';")

  echo -e "  Playbooks built:       ${YELLOW}$PLAYBOOKS${NC}"
  echo -e "  Strategy RIDE:         ${GREEN}$RIDE${NC}"
  echo -e "  Strategy FADE:         ${CYAN}$FADE${NC}"
  echo -e "  Strategy AVOID:        ${RED}$AVOID${NC}"
  echo -e "  Strategy WATCH:        ${YELLOW}$WATCH${NC}"
  echo ""

  # ━━━ Rugger Statistics ━━━
  echo -e "${GREEN}━━━ 🎯 Rugger Statistics${NC}"
  WALLETS_1=$(query "SELECT COUNT(*) FROM (SELECT creator_wallet FROM token_events GROUP BY creator_wallet HAVING COUNT(*) = 1) sub;")
  WALLETS_2=$(query "SELECT COUNT(*) FROM (SELECT creator_wallet FROM token_events GROUP BY creator_wallet HAVING COUNT(*) = 2) sub;")
  WALLETS_3PLUS=$(query "SELECT COUNT(*) FROM (SELECT creator_wallet FROM token_events GROUP BY creator_wallet HAVING COUNT(*) >= 3) sub;")
  WALLETS_5PLUS=$(query "SELECT COUNT(*) FROM (SELECT creator_wallet FROM token_events GROUP BY creator_wallet HAVING COUNT(*) >= 5) sub;")
  WALLETS_10PLUS=$(query "SELECT COUNT(*) FROM (SELECT creator_wallet FROM token_events GROUP BY creator_wallet HAVING COUNT(*) >= 10) sub;")

  echo -e "  Wallets 1 token:       ${YELLOW}$WALLETS_1${NC}"
  echo -e "  Wallets 2 tokens:      ${YELLOW}$WALLETS_2${NC}"
  echo -e "  Wallets 3+ tokens:     ${GREEN}$WALLETS_3PLUS${NC}"
  echo -e "  Wallets 5+ tokens:     ${GREEN}$WALLETS_5PLUS${NC}"
  echo -e "  Wallets 10+ tokens:    ${GREEN}$WALLETS_10PLUS${NC}"

  echo ""
  echo -e "  ${CYAN}━━━ Rugger-Specific (3+ RUGs with lifecycle)${NC}"
  RUGS_3PLUS=$(query "SELECT COUNT(*) FROM (SELECT creator_wallet FROM token_events WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS') AND time_to_peak_min IS NOT NULL AND time_to_rug_min IS NOT NULL GROUP BY creator_wallet HAVING COUNT(*) >= 3) sub;")
  RUGS_5PLUS=$(query "SELECT COUNT(*) FROM (SELECT creator_wallet FROM token_events WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS') AND time_to_peak_min IS NOT NULL AND time_to_rug_min IS NOT NULL GROUP BY creator_wallet HAVING COUNT(*) >= 5) sub;")

  echo -e "  Wallets 3+ RUGs:       ${RED}$RUGS_3PLUS${NC} ${CYAN}(playbook eligible)${NC}"
  echo -e "  Wallets 5+ RUGs:       ${RED}$RUGS_5PLUS${NC} ${CYAN}(playbook reliable)${NC}"
  echo ""

  # ━━━ Paper Trades ━━━
  echo -e "${GREEN}━━━ 💰 Paper Trades${NC}"
  if [ -f "data/paper-trades.log" ]; then
    TOTAL_SIGNALS=$(wc -l < data/paper-trades.log)
    BUY_SIGNALS=$(grep -c '"action":"BUY"' data/paper-trades.log 2>/dev/null || echo 0)
    SELL_SIGNALS=$(grep -c '"action":"SELL"' data/paper-trades.log 2>/dev/null || echo 0)
    SHORT_SIGNALS=$(grep -c '"action":"SHORT"' data/paper-trades.log 2>/dev/null || echo 0)

    echo -e "  Total signals:         ${YELLOW}$TOTAL_SIGNALS${NC}"
    echo -e "  BUY signals:           ${GREEN}$BUY_SIGNALS${NC}"
    echo -e "  SELL signals:          ${RED}$SELL_SIGNALS${NC}"
    echo -e "  SHORT signals:         ${CYAN}$SHORT_SIGNALS${NC}"
  else
    echo -e "  ${YELLOW}No paper trades log found${NC}"
  fi
  echo ""

  # ━━━ Latest Activity ━━━
  echo -e "${GREEN}━━━ 🕐 Latest Activity${NC}"
  LATEST_TOKEN=$(query "SELECT token_address FROM token_events ORDER BY detected_at DESC LIMIT 1;" | head -c 40)
  LATEST_WALLET=$(query "SELECT creator_wallet FROM token_events ORDER BY detected_at DESC LIMIT 1;" | head -c 40)
  LATEST_SNAPSHOT=$(query "SELECT token_address FROM token_snapshots ORDER BY snapshot_at DESC LIMIT 1;" | head -c 40)
  LATEST_SNAPSHOT_AGO=$(query "SELECT EXTRACT(EPOCH FROM (NOW() - MAX(snapshot_at)))/60 FROM token_snapshots;")

  echo -e "  Latest token:          $LATEST_TOKEN ($LATEST_WALLET)"
  echo -e "  Latest snapshot:       $LATEST_SNAPSHOT @ ${LATEST_SNAPSHOT_AGO} min ago"
  echo ""

  # ━━━ Performance ━━━
  echo -e "${GREEN}━━━ ⚡ Performance (30s polling, 135 slots, 90% rate limit)${NC}"

  # Calculate processing rate
  DONE_LAST_HOUR=$(query "SELECT COUNT(*) FROM monitoring_queue WHERE status = 'DONE' AND processed_at > NOW() - INTERVAL '1 hour';")
  EXPECTED_RATE=810

  if [ "$DONE_LAST_HOUR" -gt 0 ]; then
    ACTUAL_RATE=$DONE_LAST_HOUR
    PERCENT=$((ACTUAL_RATE * 100 / EXPECTED_RATE))
    echo -e "  Actual rate:           ${YELLOW}$ACTUAL_RATE${NC} tokens/h (${PERCENT}% of target)"
  else
    echo -e "  Actual rate:           ${YELLOW}Calculating...${NC} (target: ${EXPECTED_RATE}/h)"
  fi

  # API usage estimate
  API_USAGE=$((PROCESSING * 2))
  API_LIMIT=300
  API_PERCENT=$((API_USAGE * 100 / API_LIMIT))

  echo -e "  API usage:             ${YELLOW}~$API_USAGE${NC} / $API_LIMIT req/min (${API_PERCENT}%)"

  # Queue clear time
  if [ "$PROCESSING" -gt 0 ] && [ "$DONE_LAST_HOUR" -gt 0 ]; then
    HOURS_TO_CLEAR=$(awk "BEGIN {printf \"%.1f\", $PENDING / $DONE_LAST_HOUR}")
    echo -e "  Queue clear time:      ${YELLOW}~$HOURS_TO_CLEAR${NC} hours"
  fi

  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}Refreshing every 2 seconds... Press Ctrl+C to stop${NC}"

  sleep 2
done
