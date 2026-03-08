#!/bin/bash
# Run lifecycle data backfill and rebuild playbooks

set -e

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║        Lifecycle Data Backfill + Playbook Rebuild          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Backfill lifecycle data for existing RUG_NO_PAIR tokens
echo "━━━ Step 1: Backfilling lifecycle data"
echo ""
npx tsx scripts/backfill-lifecycle-data.ts

echo ""
echo "━━━ Step 2: Verifying backfill results"
echo ""

BACKFILLED=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
  "SELECT COUNT(*) FROM token_events
   WHERE verdict = 'RUG_NO_PAIR'
     AND time_to_peak_min IS NOT NULL
     AND time_to_rug_min IS NOT NULL;" 2>/dev/null | tr -d ' ')

TOTAL_RUGS=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
  "SELECT COUNT(*) FROM token_events WHERE verdict = 'RUG_NO_PAIR';" 2>/dev/null | tr -d ' ')

echo "  RUG_NO_PAIR tokens:        $TOTAL_RUGS"
echo "  With lifecycle data:       $BACKFILLED"
echo "  Coverage:                  $(( BACKFILLED * 100 / TOTAL_RUGS ))%"

echo ""
echo "━━━ Step 3: Rebuilding playbooks"
echo ""

# Count wallets eligible for playbooks
ELIGIBLE_WALLETS=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c \
  "SELECT COUNT(DISTINCT creator_wallet)
   FROM token_events
   WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')
     AND time_to_peak_min IS NOT NULL
     AND time_to_rug_min IS NOT NULL
   GROUP BY creator_wallet
   HAVING COUNT(*) >= 3;" 2>/dev/null | wc -l | tr -d ' ')

echo "  Wallets with ≥3 RUGs:      $ELIGIBLE_WALLETS"
echo ""
echo "  NOTE: Playbooks will be rebuilt automatically by TokenTracker"
echo "  as new RUGs are detected. Alternatively, restart the app to"
echo "  trigger playbook rebuild for all eligible wallets."

echo ""
echo "━━━ Backfill Complete!"
echo ""
echo "✅ Lifecycle data backfilled"
echo "✅ Ready for playbook building"
echo ""
echo "Next steps:"
echo "  1. Restart app: npm start (or keep current session)"
echo "  2. New RUGs will trigger playbook rebuilds automatically"
echo "  3. Monitor playbooks: bash scripts/monitor.sh"
echo ""
