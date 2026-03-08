#!/bin/bash
# Verify database schema is complete (8 tables, all columns)

set -e

echo "=================================================="
echo "  WalletSourceDB v4.0 — Schema Verification"
echo "=================================================="
echo ""

# Load DATABASE_URL
if [ -f ".env" ]; then
  source .env
else
  echo "Error: .env file not found"
  exit 1
fi

# Check connection
if ! psql $DATABASE_URL -c "SELECT 1" > /dev/null 2>&1; then
  echo "Error: Cannot connect to PostgreSQL"
  exit 1
fi

echo "✓ Database connection OK"
echo ""

# Check tables
echo "━━━ Checking Tables (8 required) ━━━"
EXPECTED_TABLES=(
  "wallet_profiles"
  "wallet_ancestry"
  "token_events"
  "token_snapshots"
  "cartel_groups"
  "taint_log"
  "monitoring_queue"
  "calibration_log"
)

MISSING_TABLES=()
for table in "${EXPECTED_TABLES[@]}"; do
  if psql $DATABASE_URL -t -c "SELECT 1 FROM information_schema.tables WHERE table_name='$table'" | grep -q 1; then
    echo "  ✓ $table"
  else
    echo "  ✗ $table (MISSING)"
    MISSING_TABLES+=("$table")
  fi
done

echo ""

# Check wallet_profiles columns
echo "━━━ Checking wallet_profiles Columns ━━━"
PROFILE_COLUMNS=(
  "wallet_address"
  "rugger_playbook"
  "playbook_confidence"
  "playbook_updated_at"
)

MISSING_COLUMNS=()
for col in "${PROFILE_COLUMNS[@]}"; do
  if psql $DATABASE_URL -t -c "SELECT 1 FROM information_schema.columns WHERE table_name='wallet_profiles' AND column_name='$col'" | grep -q 1; then
    echo "  ✓ $col"
  else
    echo "  ✗ $col (MISSING)"
    MISSING_COLUMNS+=("$col")
  fi
done

echo ""

# Check token_snapshots columns
echo "━━━ Checking token_snapshots Columns ━━━"
SNAPSHOT_COLUMNS=(
  "id"
  "token_address"
  "snapshot_at"
  "fdv"
  "liquidity_usd"
  "price_usd"
)

MISSING_SNAP_COLS=()
for col in "${SNAPSHOT_COLUMNS[@]}"; do
  if psql $DATABASE_URL -t -c "SELECT 1 FROM information_schema.columns WHERE table_name='token_snapshots' AND column_name='$col'" | grep -q 1; then
    echo "  ✓ $col"
  else
    echo "  ✗ $col (MISSING)"
    MISSING_SNAP_COLS+=("$col")
  fi
done

echo ""

# Summary
echo "=================================================="
if [ ${#MISSING_TABLES[@]} -eq 0 ] && [ ${#MISSING_COLUMNS[@]} -eq 0 ] && [ ${#MISSING_SNAP_COLS[@]} -eq 0 ]; then
  echo "  ✓✓✓ SCHEMA IS COMPLETE! ✓✓✓"
  echo "=================================================="
  echo ""
  echo "Database is ready for WalletSourceDB v4.0"
  exit 0
else
  echo "  ✗✗✗ SCHEMA INCOMPLETE ✗✗✗"
  echo "=================================================="
  echo ""

  if [ ${#MISSING_TABLES[@]} -gt 0 ]; then
    echo "Missing tables:"
    for table in "${MISSING_TABLES[@]}"; do
      echo "  - $table"
    done
    echo ""
  fi

  if [ ${#MISSING_COLUMNS[@]} -gt 0 ]; then
    echo "Missing columns in wallet_profiles:"
    for col in "${MISSING_COLUMNS[@]}"; do
      echo "  - $col"
    done
    echo ""
  fi

  if [ ${#MISSING_SNAP_COLS[@]} -gt 0 ]; then
    echo "Missing columns in token_snapshots:"
    for col in "${MISSING_SNAP_COLS[@]}"; do
      echo "  - $col"
    done
    echo ""
  fi

  echo "Solutions:"
  echo ""
  echo "  Option 1 (Fresh install):"
  echo "    psql \$DATABASE_URL -f src/db/schema.sql"
  echo ""
  echo "  Option 2 (Existing DB - migrate):"
  echo "    bash scripts/migrate-to-v4.sh"
  echo ""

  exit 1
fi
