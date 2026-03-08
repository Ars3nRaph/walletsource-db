#!/bin/bash
# Watch verdicts in real-time as tokens are tracked

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║         Real-Time Verdict Monitoring (Fresh Start)         ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Database cleared. Starting fresh...${NC}"
echo -e "${CYAN}Press Ctrl+C to stop${NC}"
echo ""

while true; do
  clear

  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║         Real-Time Verdict Monitoring (Fresh Start)         ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""

  # Total stats
  TOTAL=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT COUNT(*) FROM token_events;" 2>/dev/null | tr -d ' ')

  TRACKED=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT COUNT(*) FROM token_events WHERE verdict IS NOT NULL;" 2>/dev/null | tr -d ' ')

  PENDING=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT COUNT(*) FROM monitoring_queue WHERE status = 'PENDING';" 2>/dev/null | tr -d ' ')

  PROCESSING=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT COUNT(*) FROM monitoring_queue WHERE status = 'PROCESSING';" 2>/dev/null | tr -d ' ')

  echo -e "${GREEN}━━━ 📊 Global Stats${NC}"
  echo -e "  Total detected:        ${YELLOW}${TOTAL}${NC}"
  echo -e "  Tracking complete:     ${CYAN}${TRACKED}${NC}"
  echo -e "  Queue PENDING:         ${YELLOW}${PENDING}${NC}"
  echo -e "  Queue PROCESSING:      ${CYAN}${PROCESSING}${NC}"
  echo ""

  # Verdicts distribution
  echo -e "${GREEN}━━━ ⚖️  Verdicts Distribution${NC}"

  RUG_NO_PAIR=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT COUNT(*) FROM token_events WHERE verdict = 'RUG_NO_PAIR';" 2>/dev/null | tr -d ' ')

  RUG_METRICS=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT COUNT(*) FROM token_events WHERE verdict = 'RUG_METRICS';" 2>/dev/null | tr -d ' ')

  SUCCESS=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT COUNT(*) FROM token_events WHERE verdict = 'SUCCESS';" 2>/dev/null | tr -d ' ')

  NEUTRAL=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT COUNT(*) FROM token_events WHERE verdict = 'NEUTRAL';" 2>/dev/null | tr -d ' ')

  TOTAL_RUG=$((RUG_NO_PAIR + RUG_METRICS))

  if [ "$TRACKED" -gt 0 ]; then
    RUG_PCT=$((TOTAL_RUG * 100 / TRACKED))
    SUCCESS_PCT=$((SUCCESS * 100 / TRACKED))
    NEUTRAL_PCT=$((NEUTRAL * 100 / TRACKED))
  else
    RUG_PCT=0
    SUCCESS_PCT=0
    NEUTRAL_PCT=0
  fi

  echo -e "  ${RED}RUG_NO_PAIR:${NC}           ${RED}${RUG_NO_PAIR}${NC} (dead tokens)"
  echo -e "  ${RED}RUG_METRICS:${NC}           ${RED}${RUG_METRICS}${NC} (dump detected)"
  echo -e "  ${BOLD}${RED}Total RUG:${NC}             ${BOLD}${RED}${TOTAL_RUG}${NC} ${YELLOW}(${RUG_PCT}%)${NC}"
  echo ""
  echo -e "  ${GREEN}SUCCESS:${NC}               ${GREEN}${SUCCESS}${NC} ${YELLOW}(${SUCCESS_PCT}%)${NC}"
  echo -e "  ${YELLOW}NEUTRAL:${NC}               ${YELLOW}${NEUTRAL}${NC} ${YELLOW}(${NEUTRAL_PCT}%)${NC}"
  echo ""

  # Latest verdicts (last 5)
  echo -e "${GREEN}━━━ 🕐 Latest Verdicts (last 5)${NC}"
  docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT
       '  ' || SUBSTRING(token_address, 1, 12) || '... → ' ||
       CASE
         WHEN verdict = 'RUG_NO_PAIR' THEN 'RUG_NO_PAIR (FDV: ' || ROUND(peak_mc::numeric, 0) || '$)'
         WHEN verdict = 'RUG_METRICS' THEN 'RUG_METRICS (FDV: ' || ROUND(peak_mc::numeric, 0) || '$)'
         WHEN verdict = 'SUCCESS' THEN 'SUCCESS (FDV: ' || ROUND(peak_mc::numeric, 0) || '$)'
         WHEN verdict = 'NEUTRAL' THEN 'NEUTRAL (FDV: ' || ROUND(peak_mc::numeric, 0) || '$)'
       END
     FROM token_events
     WHERE verdict IS NOT NULL
     ORDER BY checked_at DESC
     LIMIT 5;" 2>/dev/null

  echo ""
  echo -e "${GREEN}━━━ 📈 FDV Averages by Verdict${NC}"
  docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT
       '  ' || verdict || ': ' ||
       ROUND(AVG(peak_mc)::numeric, 0) || '$ avg, ' ||
       ROUND(MIN(peak_mc)::numeric, 0) || '$ min, ' ||
       ROUND(MAX(peak_mc)::numeric, 0) || '$ max'
     FROM token_events
     WHERE verdict IS NOT NULL AND peak_mc IS NOT NULL
     GROUP BY verdict
     ORDER BY COUNT(*) DESC;" 2>/dev/null

  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}Refreshing every 5 seconds... Press Ctrl+C to stop${NC}"

  sleep 5
done
