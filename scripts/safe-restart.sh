#!/usr/bin/env bash
# Safe restart script - ensures new code is used

set -e

echo "🔍 1/5 - Vérification processus existants..."
if ps aux | grep -E "node.*dist.*index|tsx.*index" | grep -v grep > /dev/null 2>&1; then
  echo "❌ ERREUR: Un processus node tourne encore!"
  echo "   Arrêtez-le d'abord avec: pkill -f 'node.*dist.*index'"
  exit 1
fi
echo "✅ Aucun processus en cours"

echo ""
echo "🔍 2/5 - Nettoyage dist/ ..."
rm -rf dist/
echo "✅ Ancien build supprimé"

echo ""
echo "🔍 3/5 - Compilation TypeScript..."
npm run build > /dev/null 2>&1
echo "✅ Build réussi"

echo ""
echo "🔍 4/5 - Vérification optimisations Helius..."
if grep -q "limit=50" dist/src/api/HeliusClient.js; then
  echo "✅ Optimization 1: limit=50 présent"
else
  echo "❌ ERREUR: limit=50 manquant!"
  exit 1
fi

if grep -q "Ancestry already exists" dist/src/workers/TokenTracker.js; then
  echo "✅ Optimization 2: Cache ancestry présent"
else
  echo "❌ ERREUR: Cache ancestry manquant!"
  exit 1
fi

if grep -q "estimatedCredits" dist/src/api/HeliusClient.js; then
  echo "✅ Optimization 3: Logging crédits présent"
else
  echo "❌ ERREUR: Logging crédits manquant!"
  exit 1
fi

echo ""
echo "🔍 5/5 - Vérification base de données..."
if docker exec walletsource-db psql -U walletsource -d walletsource -c "SELECT 1" > /dev/null 2>&1; then
  echo "✅ PostgreSQL accessible"
else
  echo "❌ ERREUR: PostgreSQL inaccessible!"
  echo "   Lancez: docker-compose up -d postgres"
  exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ TOUTES LES VÉRIFICATIONS PASSÉES!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Démarrage sécurisé avec:"
echo "  npm start"
echo ""
echo "📊 Pour monitorer la consommation Helius:"
echo "  tail -f walletsource.log | grep 'Helius transactions fetched'"
echo ""
echo "🎯 Attendez-vous à voir:"
echo "  - txCount: 50 (au lieu de 1500+)"
echo "  - estimatedCredits: ~50-100 par appel"
echo "  - totalCreditsToday devrait rester < 1000"
echo ""
