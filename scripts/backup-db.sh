#!/usr/bin/env bash
# Backup PostgreSQL data

BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/walletsource_$TIMESTAMP.sql"

mkdir -p "$BACKUP_DIR"

echo "🔄 Backup PostgreSQL en cours..."
docker exec walletsource-db pg_dump -U walletsource walletsource > "$BACKUP_FILE"

if [ $? -eq 0 ]; then
  SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "✅ Backup réussi: $BACKUP_FILE ($SIZE)"

  # Garder seulement les 10 derniers backups
  ls -t "$BACKUP_DIR"/walletsource_*.sql | tail -n +11 | xargs -r rm
  echo "📁 Backups disponibles:"
  ls -lh "$BACKUP_DIR"/walletsource_*.sql 2>/dev/null || echo "   (aucun)"
else
  echo "❌ Erreur lors du backup"
  exit 1
fi
