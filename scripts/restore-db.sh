#!/usr/bin/env bash
# Restore PostgreSQL from backup

if [ -z "$1" ]; then
  echo "Usage: $0 <backup_file.sql>"
  echo ""
  echo "Backups disponibles:"
  ls -lh backups/walletsource_*.sql 2>/dev/null || echo "  (aucun backup trouvé)"
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ Fichier introuvable: $BACKUP_FILE"
  exit 1
fi

echo "⚠️  ATTENTION: Cela va ÉCRASER toutes les données actuelles!"
read -p "Continuer? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
  echo "Annulé."
  exit 0
fi

echo "🔄 Restauration en cours..."
cat "$BACKUP_FILE" | docker exec -i walletsource-db psql -U walletsource walletsource

if [ $? -eq 0 ]; then
  echo "✅ Restauration réussie depuis: $BACKUP_FILE"
else
  echo "❌ Erreur lors de la restauration"
  exit 1
fi
