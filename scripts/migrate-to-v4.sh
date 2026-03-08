#!/bin/bash
# Migrate existing database to v4.0 schema
# Adds token_snapshots table and playbook columns

set -e

echo "=================================================="
echo "  WalletSourceDB — Migrate to v4.0 Schema"
echo "=================================================="
echo ""

# Check if .env exists
if [ ! -f ".env" ]; then
  echo "Error: .env file not found"
  exit 1
fi

# Load DATABASE_URL
source .env

# Check PostgreSQL connection
echo "Checking database connection..."
if ! psql $DATABASE_URL -c "SELECT 1" > /dev/null 2>&1; then
  echo "Error: Cannot connect to PostgreSQL"
  echo "Check DATABASE_URL in .env"
  exit 1
fi

echo "✓ Connected to database"
echo ""

# Show current tables
echo "Current tables:"
psql $DATABASE_URL -c "\dt" | grep -E '(wallet_|token_|cartel_|taint_|monitoring_|calibration_)'
echo ""

# Backup database
BACKUP_FILE="backup_pre_v4_$(date +%Y%m%d_%H%M%S).sql"
echo "Creating backup: $BACKUP_FILE"
pg_dump $DATABASE_URL > $BACKUP_FILE
echo "✓ Backup created"
echo ""

# Ask for confirmation
read -p "Ready to migrate? This will add token_snapshots table and playbook columns. Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Migration cancelled"
  exit 0
fi

# Run migration
echo ""
echo "Running migration..."
psql $DATABASE_URL -f src/db/migrations/001_add_v4_columns.sql

echo ""
echo "=================================================="
echo "  ✓ Migration Complete!"
echo "=================================================="
echo ""

# Show summary
echo "Database summary:"
psql $DATABASE_URL -c "
  SELECT
    table_name,
    (SELECT COUNT(*) FROM information_schema.columns WHERE columns.table_name = tables.table_name) as column_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'wallet_profiles', 'wallet_ancestry', 'token_events', 'token_snapshots',
      'cartel_groups', 'taint_log', 'monitoring_queue', 'calibration_log'
    )
  ORDER BY table_name;
"

echo ""
echo "Backup saved: $BACKUP_FILE"
echo ""
echo "Next steps:"
echo "  1. Restart application: pm2 restart walletsource-db"
echo "  2. Monitor logs: pm2 logs walletsource-db"
echo ""
