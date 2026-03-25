#!/bin/bash
# safe-restart.sh — Only restart if no open positions
# v10.13: Reads from PostgreSQL instead of paper-trades.log
cd /root/walletsource-db

# Check open positions from DB
OPEN=$(PGPASSWORD=walletsource_dev psql -U walletsource -d walletsource -h localhost -t -c "
  SELECT count(*) FROM paper_trades b
  WHERE b.action='BUY' AND NOT EXISTS (
    SELECT 1 FROM paper_trades s WHERE s.token_address = b.token_address AND s.action='SELL' AND s.timestamp > b.timestamp
  )
" 2>/dev/null | tr -d ' ')

if [ -z "$OPEN" ]; then
    echo "⚠️ Cannot connect to DB — assuming positions open. Use --force to override."
    OPEN=1
fi

if [ "$OPEN" -gt 0 ] && [ "$1" != "--force" ]; then
    echo "⚠️ BLOCKED: $OPEN open position(s). Use --force to override."
    exit 1
fi

echo "✅ Safe to restart ($OPEN open positions)"
npx tsc
pm2 restart walletsource-db
