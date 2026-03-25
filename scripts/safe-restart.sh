#!/bin/bash
# safe-restart.sh — Only restart if no open positions
# PM2 kill-timeout=10s allows graceful shutdown (saves positions to DB)
cd /root/walletsource-db

# Check open positions from paper-trades.log
OPEN=$(python3 -c "
import json
buys, sells = set(), set()
for line in open('data/paper-trades.log'):
    line = line.strip()
    if not line: continue
    try: d = json.loads(line)
    except: continue
    tok = d.get('token','')
    if d.get('action') == 'BUY': buys.add(tok)
    elif d.get('action') == 'SELL': sells.add(tok)
open_pos = buys - sells
print(len(open_pos))
")

if [ "$OPEN" -gt 0 ] && [ "$1" != "--force" ]; then
    echo "⚠️ BLOCKED: $OPEN open position(s). Use --force to override."
    exit 1
fi

echo "✅ Safe to restart ($OPEN open positions)"
npx tsc
pm2 restart walletsource-db
