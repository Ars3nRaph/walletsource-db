#!/bin/bash

# Show how different ruggers have different playbook parameters

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     RUGGER PLAYBOOK DIVERSITY — Paramètres personnalisés    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Check if we have any playbooks
count=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c "
  SELECT COUNT(*)
  FROM wallet_profiles
  WHERE rugger_playbook IS NOT NULL;
" | tr -d ' ')

if [ "$count" = "0" ]; then
  echo "❌ Aucun playbook détecté pour l'instant"
  echo ""
  echo "Les playbooks seront créés après que les wallets aient:"
  echo "  • Au moins 3 RUGs historiques"
  echo "  • Des fenêtres temporelles cohérentes"
  echo ""
  echo "Attendez que le système accumule des données (~1-3 jours)"
  exit 0
fi

echo "✅ $count playbooks trouvés"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "COMPARAISON DES PATTERNS DE RUG"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

docker exec walletsource-db psql -U walletsource -d walletsource -c "
SELECT
  SUBSTRING(wallet_address, 1, 12) || '...' as wallet,
  (rugger_playbook->>'sample_size')::INT as rugs,
  ROUND((rugger_playbook->>'avg_time_to_peak_min')::NUMERIC, 2) as avg_peak,
  ROUND((rugger_playbook->>'std_time_to_peak_min')::NUMERIC, 2) as std_peak,
  ROUND((rugger_playbook->>'avg_time_to_rug_min')::NUMERIC, 2) as avg_rug,
  ROUND((rugger_playbook->>'std_time_to_rug_min')::NUMERIC, 2) as std_rug,
  ROUND((rugger_playbook->>'consistency_score')::NUMERIC, 3) as consistency,
  (rugger_playbook->>'recommended_strategy') as strategy
FROM wallet_profiles
WHERE rugger_playbook IS NOT NULL
ORDER BY consistency DESC
LIMIT 10;
"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "FENÊTRES TEMPORELLES (personnalisées par rugger)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

docker exec walletsource-db psql -U walletsource -d walletsource -c "
SELECT
  SUBSTRING(wallet_address, 1, 12) || '...' as wallet,
  ROUND((rugger_playbook->>'entry_window_end_min')::NUMERIC, 2) as entry_end,
  ROUND((rugger_playbook->>'exit_window_start_min')::NUMERIC, 2) as exit_start,
  ROUND((rugger_playbook->>'exit_window_end_min')::NUMERIC, 2) as exit_end,
  ROUND(
    (rugger_playbook->>'exit_window_end_min')::NUMERIC -
    (rugger_playbook->>'exit_window_start_min')::NUMERIC,
    2
  ) as exit_duration,
  (rugger_playbook->>'recommended_strategy') as strategy
FROM wallet_profiles
WHERE rugger_playbook IS NOT NULL
ORDER BY (rugger_playbook->>'avg_time_to_rug_min')::NUMERIC
LIMIT 10;
"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "RUGGERS TRADABLES (RIDE avec consistency ≥ 0.70)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

tradable=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c "
  SELECT COUNT(*)
  FROM wallet_profiles
  WHERE rugger_playbook IS NOT NULL
    AND (rugger_playbook->>'recommended_strategy') = 'RIDE'
    AND (rugger_playbook->>'consistency_score')::REAL >= 0.7;
" | tr -d ' ')

echo "Nombre de ruggers TRADABLES: $tradable"
echo ""

if [ "$tradable" -gt "0" ]; then
  docker exec walletsource-db psql -U walletsource -d walletsource -c "
  SELECT
    SUBSTRING(wallet_address, 1, 12) || '...' as wallet,
    (rugger_playbook->>'sample_size')::INT as rugs,
    ROUND((rugger_playbook->>'avg_time_to_rug_min')::NUMERIC, 2) as avg_rug,
    ROUND((rugger_playbook->>'consistency_score')::NUMERIC, 3) as consistency,
    ROUND((rugger_playbook->>'entry_window_end_min')::NUMERIC, 2) as buy_until,
    ROUND((rugger_playbook->>'exit_window_start_min')::NUMERIC, 2) || '-' ||
    ROUND((rugger_playbook->>'exit_window_end_min')::NUMERIC, 2) as sell_window
  FROM wallet_profiles
  WHERE rugger_playbook IS NOT NULL
    AND (rugger_playbook->>'recommended_strategy') = 'RIDE'
    AND (rugger_playbook->>'consistency_score')::REAL >= 0.7
  ORDER BY consistency DESC;
  "
else
  echo "Aucun rugger ne remplit encore les critères:"
  echo "  • Strategy = RIDE"
  echo "  • Consistency ≥ 0.70"
  echo "  • Sample size ≥ 5"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 Chaque rugger a des paramètres UNIQUES basés sur SON historique"
echo "💡 Le système génère des signaux PERSONNALISÉS pour chaque wallet"
echo "💡 Plus de RUGs = playbook plus précis = meilleure performance"
echo ""
