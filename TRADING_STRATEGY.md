# WalletSourceDB v4.0 — Trading Strategy

## Philosophie: "Ride the Rugger"

Trade ONLY highly predictable ruggers. Ignore everything else.

## Cycle de vie typique d'un RUG

```
0:00 - Création du token
0:00-3:00 - Montée rapide (peak)
3:00-5:00 - Stabilisation au peak
5:00-7:00 - Chute brutale (rug)
7:00+ - Bottom
```

## Configuration du système

### Tracking rapide
- **Durée**: 10 minutes (au lieu de 30)
- **Fréquence**: Snapshot toutes les 10 secondes (60 snapshots total)
- **Détection temps réel**: Peak et dump détectés pendant le tracking

### Critères de trading STRICTS

**On trade SEULEMENT si:**
1. ✅ Wallet a un playbook (≥ 3 RUGs historiques)
2. ✅ Strategy = `RIDE` (consistency ≥ 0.7, sample ≥ 5)
3. ✅ Consistency score ≥ 0.70 (rugger très prédictible)

**On NE trade PAS:**
- ❌ Wallets sans playbook
- ❌ Strategy FADE (trop risqué)
- ❌ Strategy WATCH (données insuffisantes)
- ❌ Strategy AVOID (trop chaotique, avg_time_to_rug < 3 min)
- ❌ Consistency < 0.70 (pas assez prédictible)

## Signaux de trading

### BUY Signal
**Quand**: Dès détection, pendant `entry_window`
- **Timing**: 0 à `avg_time_to_peak - std_time_to_peak`
- **Exemple**: Si avg_peak = 3.0 min, std = 0.5 min → BUY entre 0-2.5 min
- **Position**: 100% de la taille prévue
- **Confiance**: = consistency_score du playbook

### HOLD Signal
**Quand**: Entre entry_window et exit_window
- **Timing**: Entre `entry_window_end` et `exit_window_start`
- **Action**: Conserver la position, surveiller
- **Exemple**: Entre 2.5 min et 4.5 min

### SELL Signal (progressif)
**Quand**: Pendant `exit_window`
- **Timing**: `avg_time_to_rug - std_time_to_rug` à `avg_time_to_rug`
- **Exemple**: Si avg_rug = 5.0 min, std = 0.5 min → SELL entre 4.5-5.0 min
- **Position**: Progressive (50% puis 100%)
  - À 50% du window: vendre 50%
  - À 75% du window: vendre 25% de plus
  - À 100% du window: vendre le reste
- **Confiance**: Augmente avec la progression

### SELL Signal (urgence)
**Quand**: Passé `exit_window_end`
- **Timing**: > `avg_time_to_rug`
- **Action**: SELL 100% immédiatement
- **Confiance**: 1.0 (certitude)

## Exemples concrets

### Exemple 1: Rugger très prédictible
```json
{
  "wallet": "HighConfidenceRugger123...",
  "playbook": {
    "sample_size": 10,
    "consistency_score": 0.85,
    "avg_time_to_peak_min": 2.8,
    "std_time_to_peak_min": 0.3,
    "avg_time_to_rug_min": 5.2,
    "std_time_to_rug_min": 0.4,
    "entry_window_end_min": 2.5,
    "exit_window_start_min": 4.8,
    "exit_window_end_min": 5.2,
    "recommended_strategy": "RIDE"
  }
}
```

**Signaux générés**:
- `0:00-2:30` → **BUY 100%** (conf: 0.85)
- `2:30-4:48` → **HOLD** (conf: 0.85)
- `4:48-5:12` → **SELL progressive** (25s window)
  - `4:48` (0%) → SELL 0%
  - `4:54` (50%) → SELL 50%
  - `5:00` (75%) → SELL 25%
  - `5:06` (100%) → SELL 25%
- `5:12+` → **SELL 100% urgence** (conf: 1.0)

### Exemple 2: Rugger incohérent (NO TRADE)
```json
{
  "wallet": "InconsistentRugger456...",
  "playbook": {
    "sample_size": 8,
    "consistency_score": 0.55,  // < 0.70
    "recommended_strategy": "FADE"  // ≠ RIDE
  }
}
```

**Signal généré**:
```json
{
  "action": "NONE",
  "confidence": 0,
  "reason": "Strategy FADE - only trading RIDE ruggers"
}
```

### Exemple 3: Wallet sans historique (NO TRADE)
```json
{
  "wallet": "NewWallet789...",
  "playbook": null  // Pas encore de RUGs
}
```

**Signal généré**:
```json
{
  "action": "NONE",
  "confidence": 0,
  "reason": "No playbook - not a predictable rugger"
}
```

## Métriques de performance attendues

### Phase froide (jours 1-7)
- Tokens détectés: ~50-100/jour
- Playbooks créés: 0-5
- Trades: 0-2/jour (peu de ruggers prédictibles)

### Phase tiède (jours 8-30)
- Tokens détectés: ~100-200/jour
- Playbooks créés: 10-30
- Trades: 5-15/jour (ruggers RIDE identifiés)
- Win rate attendu: 70-85% (si consistency ≥ 0.7)

### Phase chaude (jour 30+)
- Tokens détectés: ~200-500/jour
- Playbooks créés: 50-100
- Trades: 15-40/jour
- Win rate attendu: 75-90% (ruggers très prédictibles)

## Gestion du risque

### Taille de position
```typescript
// Basée sur la confiance du playbook
position_size = base_size * consistency_score

// Exemple
base_size = 1 SOL
consistency_score = 0.85
→ position_size = 0.85 SOL
```

### Stop loss
- **Temps**: Si elapsed > exit_window_end + 1 min → SELL tout
- **Prix**: Si MC < 50% de entry MC → SELL tout
- **Liquidité**: Si liquidity < 1000 USD → SELL tout

### Take profit partiel
Pendant exit_window, vendre progressivement:
1. **50% du window**: vendre 50% de la position
2. **75% du window**: vendre 25% de plus
3. **100% du window**: vendre le reste

## Paper Trading

Avant d'activer le trading réel:
1. Laisser tourner en paper trading pendant **7+ jours**
2. Vérifier dans `data/paper-trades.log`:
   - Win rate ≥ 70%
   - Signaux BUY/SELL bien timés
   - Pas de faux positifs (trades sur wallets non-RIDE)
3. Analyser les playbooks générés:
   - Consistency scores cohérents
   - Temporal windows réalistes
   - Sample sizes suffisants (≥ 5)

## Commandes de monitoring

```bash
# Dashboard temps réel
npm run monitor

# Voir les playbooks actifs
docker exec walletsource-db psql -U walletsource -d walletsource -c "
  SELECT
    wallet_address,
    (rugger_playbook->>'consistency_score')::REAL as consistency,
    (rugger_playbook->>'sample_size')::INT as sample,
    (rugger_playbook->>'recommended_strategy') as strategy,
    (rugger_playbook->>'avg_time_to_rug_min')::REAL as avg_rug_min
  FROM wallet_profiles
  WHERE rugger_playbook IS NOT NULL
    AND (rugger_playbook->>'recommended_strategy') = 'RIDE'
    AND (rugger_playbook->>'consistency_score')::REAL >= 0.7
  ORDER BY consistency DESC;
"

# Paper trades en temps réel
npm run watch:trades

# Stats globales
npm run paper:stats
```

## Optimisations futures

1. **Machine Learning**: Prédire le peak avec plus de précision
2. **Volume analysis**: Détecter les accumulations avant pump
3. **Wallet clustering**: Identifier les cartels en temps réel
4. **Multi-token**: Trader plusieurs tokens du même rugger simultanément
5. **Short selling**: Shorter après le peak (strategy FADE future)
