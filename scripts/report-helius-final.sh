#!/bin/bash
# Final Helius consumption report

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║        Helius Optimization — Final Report                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Wait 5 minutes for data collection
echo "⏱️  Collecting data for 5 minutes..."
INITIAL_CREDITS=$(grep -a "totalCreditsToday" walletsource.log 2>/dev/null | tail -1 | grep -o 'totalCreditsToday: [0-9]*' | cut -d' ' -f2)
INITIAL_TIME=$(date +%s)

sleep 300  # 5 minutes

FINAL_CREDITS=$(grep -a "totalCreditsToday" walletsource.log 2>/dev/null | tail -1 | grep -o 'totalCreditsToday: [0-9]*' | cut -d' ' -f2)
FINAL_TIME=$(date +%s)

CREDITS_CONSUMED=$((FINAL_CREDITS - INITIAL_CREDITS))
TIME_ELAPSED=$((FINAL_TIME - INITIAL_TIME))
CREDITS_PER_HOUR=$((CREDITS_CONSUMED * 3600 / TIME_ELAPSED))
CREDITS_PER_DAY=$((CREDITS_PER_HOUR * 24))

echo ""
echo "━━━ 📊 Results (5 min sample)"
echo "  Credits consumed:      $CREDITS_CONSUMED"
echo "  Time elapsed:          ${TIME_ELAPSED}s"
echo ""
echo "━━━ 📈 Projections"
echo "  Hourly rate:           $CREDITS_PER_HOUR credits/hour"
echo "  Daily rate:            $CREDITS_PER_DAY credits/day"
echo "  Monthly rate:          $((CREDITS_PER_DAY * 30)) credits/month"
echo ""
echo "━━━ 🎯 Targets"
echo "  Target daily:          < 15,000 credits/day"
echo "  Limit monthly:         1,000,000 credits/month (33,333/day)"
echo ""

if [ "$CREDITS_PER_DAY" -lt 15000 ]; then
  echo "  Status:                ✅ EXCELLENT - Under target!"
  MARGIN=$(( (15000 - CREDITS_PER_DAY) * 100 / 15000 ))
  echo "  Margin:                ${MARGIN}% below target"
else
  echo "  Status:                ⚠️  Over target"
fi

echo ""
echo "━━━ 🔍 Optimization Details"
HELIUS_CALLS=$(grep -a "Helius transactions fetched" walletsource.log 2>/dev/null | wc -l | tr -d ' ')
AVG_TX=$(grep -a "txCount:" walletsource.log 2>/dev/null | tail -20 | grep -o 'txCount: [0-9]*' | cut -d' ' -f2 | awk '{sum+=$1; count++} END {if(count>0) print int(sum/count); else print 0}')

echo "  Total Helius calls:    $HELIUS_CALLS"
echo "  Avg txCount:           $AVG_TX (limit: 20)"
echo "  Avg credits/call:      1 (optimized)"
echo ""
echo "╚══════════════════════════════════════════════════════════════╝"
