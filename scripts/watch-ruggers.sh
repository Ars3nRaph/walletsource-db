#!/usr/bin/env bash
# Monitor rugger statistics in real-time

while true; do
  clear
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║          Rugger Statistics - WalletSourceDB v4.0           ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  # Distribution
  echo "━━━ 📊 Distribution des Wallets par Nombre de Tokens"
  docker exec walletsource-db psql -U walletsource -d walletsource -t -c "
  WITH wallet_token_counts AS (
    SELECT creator_wallet, COUNT(*) as token_count
    FROM token_events
    GROUP BY creator_wallet
  )
  SELECT
    '  ' || category || ': ' || LPAD(count::text, 4, ' ')
  FROM (
    SELECT 'Wallets 1 token   ' as category, COUNT(*) as count, 1 as ord FROM wallet_token_counts WHERE token_count = 1
    UNION ALL
    SELECT 'Wallets 2 tokens  ', COUNT(*), 2 FROM wallet_token_counts WHERE token_count = 2
    UNION ALL
    SELECT 'Wallets 3+ tokens ', COUNT(*), 3 FROM wallet_token_counts WHERE token_count >= 3
    UNION ALL
    SELECT 'Wallets 5+ tokens ', COUNT(*), 4 FROM wallet_token_counts WHERE token_count >= 5
    UNION ALL
    SELECT 'Wallets 10+ tokens', COUNT(*), 5 FROM wallet_token_counts WHERE token_count >= 10
  ) t
  ORDER BY ord;
  " 2>/dev/null

  echo ""
  echo "━━━ 🎯 Top 10 Ruggers (par nombre de tokens)"
  docker exec walletsource-db psql -U walletsource -d walletsource -t -c "
  SELECT
    '  ' || SUBSTRING(creator_wallet, 1, 8) || '... | ' ||
    LPAD(COUNT(*)::text, 3, ' ') || ' tokens | ' ||
    LPAD(COUNT(*) FILTER (WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS'))::text, 2, ' ') || ' RUGs | ' ||
    LPAD(COUNT(*) FILTER (WHERE verdict IS NULL)::text, 3, ' ') || ' pending'
  FROM token_events
  GROUP BY creator_wallet
  HAVING COUNT(*) >= 3
  ORDER BY COUNT(*) DESC
  LIMIT 10;
  " 2>/dev/null

  echo ""
  echo "━━━ 📈 Progression Playbooks"
  docker exec walletsource-db psql -U walletsource -d walletsource -t -c "
  WITH wallet_stats AS (
    SELECT
      creator_wallet,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE verdict IN ('RUG_NO_PAIR', 'RUG_METRICS')) as rugs
    FROM token_events
    GROUP BY creator_wallet
  )
  SELECT
    '  Wallets ≥3 tokens (playbook possible): ' || LPAD(COUNT(*)::text, 3, ' ')
  FROM wallet_stats WHERE total >= 3
  UNION ALL
  SELECT
    '  Wallets ≥5 tokens (playbook fiable):  ' || LPAD(COUNT(*)::text, 3, ' ')
  FROM wallet_stats WHERE total >= 5
  UNION ALL
  SELECT
    '  Wallets ≥3 RUGs (stratégie RIDE/FADE): ' || LPAD(COUNT(*)::text, 3, ' ')
  FROM wallet_stats WHERE rugs >= 3;
  " 2>/dev/null

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Refresh: 10s | Ctrl+C pour arrêter"
  sleep 10
done
