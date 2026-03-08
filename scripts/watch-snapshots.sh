#!/bin/bash

# Watch snapshots being created in real-time
TOKEN=$1

if [ -z "$TOKEN" ]; then
  echo "Usage: ./scripts/watch-snapshots.sh <token_address>"
  echo ""
  echo "Available tokens:"
  docker exec walletsource-db psql -U walletsource -d walletsource -t -c "
    SELECT token_address FROM token_events
    WHERE detected_at > NOW() - INTERVAL '35 minutes'
    ORDER BY detected_at DESC LIMIT 10;
  "
  exit 1
fi

echo "=== Tracking snapshots for token: $TOKEN ==="
echo ""

docker exec walletsource-db psql -U walletsource -d walletsource -c "
SELECT
  snapshot_at,
  ROUND(EXTRACT(EPOCH FROM (snapshot_at - detected_at))/60, 2) as elapsed_min,
  fdv,
  liquidity,
  price_change_5m,
  peak_detected,
  dump_detected
FROM token_snapshots ts
JOIN token_events te ON te.token_address = ts.token_address
WHERE ts.token_address = '$TOKEN'
ORDER BY snapshot_at;
"
