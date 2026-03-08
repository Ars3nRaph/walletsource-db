#!/bin/bash
# Make all scripts executable
# Usage: bash scripts/make-executable.sh

echo "Making all scripts executable..."

chmod +x scripts/start-production.sh
chmod +x scripts/monitor-production.sh
chmod +x scripts/start-dashboard.sh
chmod +x scripts/setup-nginx.sh
chmod +x scripts/setup-db.sh
chmod +x scripts/monitor.sh
chmod +x scripts/reset-all.sh
chmod +x scripts/watch-verdicts.sh
chmod +x scripts/watch-snapshots.sh
chmod +x scripts/watch-tokens.sh
chmod +x scripts/watch-paper-trades.sh
chmod +x scripts/show-playbook-diversity.sh
chmod +x scripts/start-paper-trading.sh
chmod +x scripts/backup-db.sh 2>/dev/null || true

echo "✓ All scripts are now executable"
echo ""
echo "Available commands:"
echo "  ./scripts/start-production.sh    # Start main app (PM2)"
echo "  ./scripts/monitor-production.sh  # Monitor CLI dashboard"
echo "  ./scripts/start-dashboard.sh     # Start web dashboard"
echo "  sudo ./scripts/setup-nginx.sh    # Setup nginx reverse proxy"
echo ""
