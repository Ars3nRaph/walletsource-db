#!/bin/bash
# Daily backup of fiscal CSV logs to /root/fiscal-backups/
BACKUP_DIR="/root/fiscal-backups/$(date +%Y-%m)"
SRC="/root/walletsource-db/scripts/web-dashboard/logs-live"
mkdir -p "$BACKUP_DIR"
if ls "$SRC"/*.csv 1>/dev/null 2>&1; then
  cp -n "$SRC"/*.csv "$BACKUP_DIR/"
  echo "$(date -u +%FT%TZ) Backed up $(ls "$SRC"/*.csv | wc -l) CSV files to $BACKUP_DIR"
fi

# Also dump live_trades_v2 as safety net
PGPASSWORD=walletsource_dev pg_dump -U walletsource -h localhost -d walletsource \
  -t live_trades_v2 --data-only -f "$BACKUP_DIR/live_trades_v2_$(date +%F).sql" 2>/dev/null
