#!/bin/bash
# Alert when RUG detected and show Helius consumption

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Track last RUG count
LAST_RUG_COUNT=0

echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║     RUG Detection Alert + Helius Credit Monitor            ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Monitoring for new RUGs... Press Ctrl+C to stop${NC}"
echo ""

while true; do
  # Get current RUG count
  CURRENT_RUG_COUNT=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
    "SELECT COUNT(*) FROM token_events WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS');" 2>/dev/null | tr -d ' ')

  # Initialize on first run
  if [ "$LAST_RUG_COUNT" -eq 0 ]; then
    LAST_RUG_COUNT=$CURRENT_RUG_COUNT
  fi

  # Check if new RUG detected
  if [ "$CURRENT_RUG_COUNT" -gt "$LAST_RUG_COUNT" ]; then
    NEW_RUGS=$((CURRENT_RUG_COUNT - LAST_RUG_COUNT))

    echo ""
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}${RED}🚨 NEW RUG DETECTED! ($NEW_RUGS new RUG(s))${NC}"
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    # Get latest RUG details
    echo -e "${CYAN}━━━ Latest RUG Details${NC}"
    docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
      "SELECT
         '  Token: ' || SUBSTRING(token_address, 1, 12) || '...' || CHR(10) ||
         '  Creator: ' || SUBSTRING(creator_wallet, 1, 12) || '...' || CHR(10) ||
         '  Verdict: ' || verdict || CHR(10) ||
         '  Detected: ' || TO_CHAR(checked_at, 'HH24:MI:SS')
       FROM token_events
       WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
       ORDER BY checked_at DESC
       LIMIT 1;" 2>/dev/null

    echo ""
    echo -e "${CYAN}━━━ Helius Activity (last 2 minutes)${NC}"

    # Count recent Helius calls from logs
    HELIUS_CALLS=$(grep "Helius transactions fetched" walletsource.log 2>/dev/null | tail -20 | wc -l)

    # Get latest credit counter from logs
    LATEST_CREDITS=$(grep "totalCreditsToday" walletsource.log 2>/dev/null | tail -1 | grep -o '"totalCreditsToday":[0-9]*' | cut -d':' -f2)

    if [ -z "$LATEST_CREDITS" ]; then
      LATEST_CREDITS="N/A"
    fi

    echo -e "  Recent Helius calls:      ${YELLOW}${HELIUS_CALLS}${NC}"
    echo -e "  Credits consumed today:   ${YELLOW}${LATEST_CREDITS}${NC}"

    # Calculate rate
    if [ "$HELIUS_CALLS" -gt 0 ]; then
      HOURLY_RATE=$((HELIUS_CALLS * 30))
      DAILY_PROJECTION=$((HOURLY_RATE * 24))

      echo -e "  Projected hourly rate:    ${YELLOW}${HOURLY_RATE} credits/hour${NC}"
      echo -e "  Projected daily rate:     ${YELLOW}${DAILY_PROJECTION} credits/day${NC}"

      # Alert if exceeding target
      if [ "$DAILY_PROJECTION" -gt 15000 ]; then
        echo -e "  ${RED}⚠️  WARNING: Exceeding 15k/day target!${NC}"
      else
        echo -e "  ${GREEN}✅ Under 15k/day target${NC}"
      fi
    fi

    echo ""
    echo -e "${CYAN}━━━ Ancestry Links Created${NC}"
    RECENT_ANCESTRY=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
      "SELECT COUNT(*) FROM wallet_ancestry WHERE detected_at > NOW() - INTERVAL '2 minutes';" 2>/dev/null | tr -d ' ')
    echo -e "  Links (last 2 min):       ${YELLOW}${RECENT_ANCESTRY}${NC}"

    echo ""
    echo -e "${CYAN}━━━ Optimization Check${NC}"

    # Check if using optimized code (limit=20, 1 credit)
    RECENT_TX_COUNTS=$(grep "txCount" walletsource.log 2>/dev/null | tail -5 | grep -o '"txCount":[0-9]*' | cut -d':' -f2)
    if echo "$RECENT_TX_COUNTS" | grep -q "[3-9][0-9]"; then
      echo -e "  ${RED}❌ High txCount detected (>30) - old code still running?${NC}"
    elif [ -n "$RECENT_TX_COUNTS" ]; then
      MAX_TX=$(echo "$RECENT_TX_COUNTS" | sort -n | tail -1)
      echo -e "  ${GREEN}✅ txCount ≤ 20 (max: ${MAX_TX}) - optimized!${NC}"
    fi

    RECENT_CREDITS_PER_CALL=$(grep "creditsUsed" walletsource.log 2>/dev/null | tail -5 | grep -o '"creditsUsed":[0-9]*' | cut -d':' -f2)
    if echo "$RECENT_CREDITS_PER_CALL" | grep -q "[5-9][0-9]"; then
      echo -e "  ${RED}❌ High creditsUsed (>5) - old code still running?${NC}"
    elif [ -n "$RECENT_CREDITS_PER_CALL" ]; then
      echo -e "  ${GREEN}✅ creditsUsed = 1 per call - optimized!${NC}"
    fi

    echo ""
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    # Update last count
    LAST_RUG_COUNT=$CURRENT_RUG_COUNT
  fi

  # Sleep for 10 seconds
  sleep 10
done
