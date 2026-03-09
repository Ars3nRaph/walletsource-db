#!/bin/bash
# Complete database and logs reset

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║              Complete Database Reset (Fresh Start)         ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Stop all node processes
echo -e "${YELLOW}━━━ Stopping all Node.js processes...${NC}"
taskkill //F //IM node.exe 2>&1 | grep -v "not found" || echo "No Node.js processes running"
sleep 2
echo ""

# Truncate all database tables
echo -e "${YELLOW}━━━ Truncating all database tables...${NC}"
docker exec walletsource-db psql -U walletsource -d walletsource -c "
DO \$\$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
    EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;
END \$\$;
" 2>/dev/null
echo -e "${GREEN}✓ Database tables truncated${NC}"
echo ""

# Clean paper trades log
echo -e "${YELLOW}━━━ Cleaning paper trades log...${NC}"
if [ -f "data/paper-trades.log" ]; then
  > data/paper-trades.log
  echo -e "${GREEN}✓ data/paper-trades.log cleaned${NC}"
else
  mkdir -p data
  touch data/paper-trades.log
  echo -e "${GREEN}✓ data/paper-trades.log created${NC}"
fi
echo ""

# Verify reset
echo -e "${YELLOW}━━━ Verifying reset...${NC}"
TOKEN_COUNT=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
  "SELECT COUNT(*) FROM token_events;" 2>/dev/null | tr -d ' ')
TRADE_COUNT=$(wc -l < data/paper-trades.log 2>/dev/null || echo "0")

echo -e "  Tokens in DB:          ${CYAN}${TOKEN_COUNT}${NC}"
echo -e "  Trades in log:         ${CYAN}${TRADE_COUNT}${NC}"
echo ""

if [ "$TOKEN_COUNT" -eq 0 ] && [ "$TRADE_COUNT" -eq 0 ]; then
  echo -e "${BOLD}${GREEN}✅ Reset complete! Database is clean.${NC}"
else
  echo -e "${BOLD}${RED}⚠️  Warning: Reset may be incomplete${NC}"
fi
echo ""
echo -e "${CYAN}Ready to start fresh. Run: npm start${NC}"
echo ""
