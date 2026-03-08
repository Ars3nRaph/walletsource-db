#!/bin/bash

# Watch tokens being tracked in real-time
echo "=== Tokens Currently Being Tracked ==="
echo ""

docker exec walletsource-db psql -U walletsource -d walletsource -c "
SELECT
  te.token_address,
  te.creator_wallet,
  COUNT(ts.id) as snapshots,
  ROUND(EXTRACT(EPOCH FROM (NOW() - te.detected_at))/60, 1) as elapsed_min,
  mq.status,
  te.verdict
FROM token_events te
LEFT JOIN token_snapshots ts ON ts.token_address = te.token_address
LEFT JOIN monitoring_queue mq ON mq.token_address = te.token_address
WHERE te.detected_at > NOW() - INTERVAL '35 minutes'
GROUP BY te.token_address, te.creator_wallet, te.detected_at, mq.status, te.verdict
ORDER BY te.detected_at DESC;
"
