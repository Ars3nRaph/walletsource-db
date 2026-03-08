#!/usr/bin/env bash
# Monitor Helius API credit consumption in real-time

LOG_FILE="${1:-walletsource.log}"

if [ ! -f "$LOG_FILE" ]; then
  echo "❌ Log file not found: $LOG_FILE"
  echo "Usage: $0 [log_file]"
  exit 1
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║        Helius API Credit Monitoring (Live)                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Fichier: $LOG_FILE"
echo "Appuyez sur Ctrl+C pour arrêter"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Suivre les appels Helius en temps réel
tail -f "$LOG_FILE" | grep --line-buffered "Helius transactions fetched" | while read -r line; do
  # Extraire les infos
  timestamp=$(echo "$line" | grep -oP '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}')
  address=$(echo "$line" | grep -oP 'address":"[^"]+' | cut -d'"' -f3 | cut -c1-8)
  txCount=$(echo "$line" | grep -oP 'txCount":\d+' | cut -d':' -f2)
  credits=$(echo "$line" | grep -oP 'estimatedCredits":\d+' | cut -d':' -f2)
  total=$(echo "$line" | grep -oP 'totalCreditsToday":\d+' | cut -d':' -f2)

  # Afficher avec couleurs
  if [ "$total" -gt 5000 ]; then
    color="\033[1;31m" # Rouge
  elif [ "$total" -gt 1000 ]; then
    color="\033[1;33m" # Jaune
  else
    color="\033[1;32m" # Vert
  fi
  reset="\033[0m"

  printf "${color}%s${reset} | Wallet: %s... | Tx: %3s | Crédits: +%3s | Total: %5s\n" \
    "$timestamp" "$address" "$txCount" "$credits" "$total"

  # Alerte si trop de crédits
  if [ "$total" -gt 10000 ]; then
    echo "⚠️  ALERTE: Consommation excessive! Arrêtez le programme et vérifiez les logs."
  fi
done
