#!/bin/bash
# Monitor Helius credit consumption in real-time

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          Helius Credit Monitor — Real-time                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Count Helius calls in logs
echo "━━━ Last 5 minutes activity"
helius_calls=$(grep "Helius transactions fetched" walletsource.log 2>/dev/null | grep "$(date -d '5 minutes ago' '+%Y-%m-%d %H:%M' 2>/dev/null || date -v-5M '+%Y-%m-%d %H:%M' 2>/dev/null)" | wc -l)

echo "  Helius API calls (5 min):  $helius_calls"
echo "  Credits consumed (5 min):  ~$helius_calls (1 credit/call)"
echo "  Hourly rate:               ~$((helius_calls * 12))/hour"
echo "  Daily projection:          ~$((helius_calls * 12 * 24))/day"
echo ""

# Database metrics
echo "━━━ Database activity (last hour)"
docker exec walletsource-db psql -U walletsource -d walletsource -t -c "
  SELECT
    'RUGs: ' || COUNT(*) FILTER (WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')) || ' | ' ||
    'Ancestry links: ' || (SELECT COUNT(*) FROM wallet_ancestry WHERE detected_at > NOW() - INTERVAL '1 hour')
  FROM token_events
  WHERE checked_at > NOW() - INTERVAL '1 hour';
" 2>/dev/null

echo ""
echo "━━━ Current tracking"
docker exec walletsource-db psql -U walletsource -d walletsource -t -c "
  SELECT
    status || ': ' || COUNT(*)
  FROM monitoring_queue
  GROUP BY status
  ORDER BY
    CASE status
      WHEN 'PROCESSING' THEN 1
      WHEN 'PENDING' THEN 2
      WHEN 'DONE' THEN 3
    END;
" 2>/dev/null

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Target: <15k credits/day | Current limit: 1M/month (33k/day)"
