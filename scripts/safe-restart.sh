#!/bin/bash
# safe-restart.sh — NEVER restart with open positions (paper OR live)
# Kills trades = kills money. No exceptions without --force.
cd /root/walletsource-db

# Check PAPER open positions
PAPER_OPEN=$(PGPASSWORD=walletsource_dev psql -U walletsource -d walletsource -h localhost -t -c "
  SELECT count(*) FROM paper_trades b
  WHERE b.action='BUY' AND NOT EXISTS (
    SELECT 1 FROM paper_trades s WHERE s.token_address = b.token_address AND s.action='SELL' AND s.timestamp > b.timestamp
  )
" 2>/dev/null | tr -d ' ')

# Check LIVE open positions
LIVE_OPEN=$(PGPASSWORD=walletsource_dev psql -U walletsource -d walletsource -h localhost -t -c "
  SELECT count(*) FROM live_trades_v2 b
  WHERE b.side='BUY' AND NOT EXISTS (
    SELECT 1 FROM live_trades_v2 s WHERE s.token_address = b.token_address AND s.side='SELL' AND s.executed_at > b.executed_at
  )
" 2>/dev/null | tr -d ' ')

[ -z "$PAPER_OPEN" ] && PAPER_OPEN="?"
[ -z "$LIVE_OPEN" ] && LIVE_OPEN="?"

TOTAL="?"
if [[ "$PAPER_OPEN" =~ ^[0-9]+$ ]] && [[ "$LIVE_OPEN" =~ ^[0-9]+$ ]]; then
    TOTAL=$((PAPER_OPEN + LIVE_OPEN))
fi

echo "📊 Positions: Paper=$PAPER_OPEN | Live=$LIVE_OPEN | Total=$TOTAL"

if [ "$TOTAL" = "?" ]; then
    echo "⚠️ Cannot verify positions (DB error). Use --force to override."
    [ "$1" != "--force" ] && exit 1
fi

if [ "$TOTAL" -gt 0 ] && [ "$1" != "--force" ]; then
    echo "🛑 BLOCKED: $TOTAL open position(s). Use --force to override."
    echo "   Paper: $PAPER_OPEN | Live: $LIVE_OPEN"
    echo "   ⚠️  Live positions = REAL MONEY. Restart will lose funds."
    exit 1
fi

echo "✅ Safe to restart (0 open positions)"
npx tsc 2>&1 | grep -v "TS18047"
pm2 restart walletsource-db
