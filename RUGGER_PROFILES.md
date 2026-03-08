# Profils de Ruggers — Exemples réels

## Concept: Timeline personnalisée par rugger

Chaque wallet rugger a son **propre pattern** de RUG. Le système analyse l'historique et génère des fenêtres temporelles **spécifiques** à ce wallet.

---

## Exemple 1: "Fast Rugger" (RUG rapide 3-5 min)

### Historique
```json
{
  "wallet": "FastRugger7x3zK...",
  "rug_history": [
    { "token": "RUG1", "time_to_peak": 1.8, "time_to_rug": 3.2 },
    { "token": "RUG2", "time_to_peak": 2.1, "time_to_rug": 3.5 },
    { "token": "RUG3", "time_to_peak": 1.9, "time_to_rug": 3.0 },
    { "token": "RUG4", "time_to_peak": 2.0, "time_to_rug": 3.3 },
    { "token": "RUG5", "time_to_peak": 1.7, "time_to_rug": 2.9 }
  ]
}
```

### Playbook calculé
```json
{
  "sample_size": 5,
  "avg_time_to_peak_min": 1.9,
  "std_time_to_peak_min": 0.15,
  "avg_time_to_rug_min": 3.18,
  "std_time_to_rug_min": 0.22,
  "consistency_score": 0.93,  // Très cohérent!

  "entry_window_end_min": 1.75,   // 1.9 - 0.15
  "exit_window_start_min": 2.96,  // 3.18 - 0.22
  "exit_window_end_min": 3.18,

  "recommended_strategy": "RIDE"
}
```

### Signaux générés pour nouveau token
```
00:00 - Token détecté
00:10 - Snapshot 1  → BUY 100% (dans entry_window)
00:30 - Snapshot 3  → BUY 100%
01:00 - Snapshot 6  → BUY 100%
01:45 - Snapshot 11 → HOLD (fin entry_window)
02:00 - Snapshot 12 → HOLD
02:30 - Snapshot 15 → HOLD
02:58 - Snapshot 18 → SELL 10% (début exit_window)
03:02 - Snapshot 19 → SELL 30%
03:06 - Snapshot 19 → SELL 50%
03:10 - Snapshot 20 → SELL 100% (à exit_window_end)
03:20 - Snapshot 21 → SELL 100% urgence (passé exit_window)
```

**Caractéristique**: Fenêtre de sortie TRÈS COURTE (22 secondes seulement!)

---

## Exemple 2: "Slow Rugger" (RUG lent 5-8 min)

### Historique
```json
{
  "wallet": "SlowRuggerB9mQp...",
  "rug_history": [
    { "token": "RUG1", "time_to_peak": 4.2, "time_to_rug": 7.8 },
    { "token": "RUG2", "time_to_peak": 4.5, "time_to_rug": 8.1 },
    { "token": "RUG3", "time_to_peak": 4.1, "time_to_rug": 7.5 },
    { "token": "RUG4", "time_to_peak": 4.3, "time_to_rug": 7.9 },
    { "token": "RUG5", "time_to_peak": 4.6, "time_to_rug": 8.2 },
    { "token": "RUG6", "time_to_peak": 4.0, "time_to_rug": 7.7 }
  ]
}
```

### Playbook calculé
```json
{
  "sample_size": 6,
  "avg_time_to_peak_min": 4.28,
  "std_time_to_peak_min": 0.22,
  "avg_time_to_rug_min": 7.87,
  "std_time_to_rug_min": 0.25,
  "consistency_score": 0.97,  // Extrêmement cohérent!

  "entry_window_end_min": 4.06,   // 4.28 - 0.22
  "exit_window_start_min": 7.62,  // 7.87 - 0.25
  "exit_window_end_min": 7.87,

  "recommended_strategy": "RIDE"
}
```

### Signaux générés pour nouveau token
```
00:00 - Token détecté
00:10 - Snapshot 1  → BUY 100%
01:00 - Snapshot 6  → BUY 100%
02:00 - Snapshot 12 → BUY 100%
03:00 - Snapshot 18 → BUY 100%
04:03 - Snapshot 25 → BUY 100%
04:06 - Snapshot 25 → HOLD (fin entry_window)
05:00 - Snapshot 30 → HOLD
06:00 - Snapshot 36 → HOLD
07:00 - Snapshot 42 → HOLD
07:37 - Snapshot 46 → SELL 10% (début exit_window)
07:45 - Snapshot 47 → SELL 40%
07:50 - Snapshot 48 → SELL 70%
07:52 - Snapshot 48 → SELL 100% (à exit_window_end)
08:00 - Snapshot 49 → SELL 100% urgence
```

**Caractéristique**: Fenêtre d'entrée LONGUE (4 min), fenêtre de sortie courte (25 secondes)

---

## Exemple 3: "Volatile Rugger" (inconsistant → NO TRADE)

### Historique
```json
{
  "wallet": "VolatileRugC4xWn...",
  "rug_history": [
    { "token": "RUG1", "time_to_peak": 1.5, "time_to_rug": 2.8 },
    { "token": "RUG2", "time_to_peak": 4.2, "time_to_rug": 7.1 },
    { "token": "RUG3", "time_to_peak": 2.1, "time_to_rug": 3.5 },
    { "token": "RUG4", "time_to_peak": 5.8, "time_to_rug": 9.2 },
    { "token": "RUG5", "time_to_peak": 1.9, "time_to_rug": 3.1 }
  ]
}
```

### Playbook calculé
```json
{
  "sample_size": 5,
  "avg_time_to_peak_min": 3.1,
  "std_time_to_peak_min": 1.78,  // Écart-type ÉNORME
  "avg_time_to_rug_min": 5.14,
  "std_time_to_rug_min": 2.68,   // Écart-type ÉNORME
  "consistency_score": 0.48,      // Très INCOHÉRENT

  "entry_window_end_min": 1.32,
  "exit_window_start_min": 2.46,
  "exit_window_end_min": 5.14,

  "recommended_strategy": "WATCH"  // Pas assez cohérent
}
```

### Signaux générés pour nouveau token
```
TOUS LES SNAPSHOTS → NONE

Raison: "Strategy WATCH - only trading RIDE ruggers"
```

**Caractéristique**: Pattern trop chaotique → système refuse de trader

---

## Exemple 4: "Ultra-Fast Rugger" (< 3 min → AVOID)

### Historique
```json
{
  "wallet": "UltraFastD8kLm...",
  "rug_history": [
    { "token": "RUG1", "time_to_peak": 0.8, "time_to_rug": 1.5 },
    { "token": "RUG2", "time_to_peak": 0.6, "time_to_rug": 1.2 },
    { "token": "RUG3", "time_to_peak": 0.9, "time_to_rug": 1.7 },
    { "token": "RUG4", "time_to_peak": 0.7, "time_to_rug": 1.4 },
    { "token": "RUG5", "time_to_peak": 0.8, "time_to_rug": 1.6 }
  ]
}
```

### Playbook calculé
```json
{
  "sample_size": 5,
  "avg_time_to_peak_min": 0.76,
  "std_time_to_peak_min": 0.11,
  "avg_time_to_rug_min": 1.48,  // < 3 min !
  "std_time_to_rug_min": 0.18,
  "consistency_score": 0.88,     // Cohérent mais...

  "recommended_strategy": "AVOID"  // Trop rapide!
}
```

### Signaux générés pour nouveau token
```
TOUS LES SNAPSHOTS → NONE

Raison: "Strategy AVOID - only trading RIDE ruggers"
```

**Caractéristique**: Trop rapide pour être tradé de manière fiable (risque d'exécution)

---

## Comparaison des 4 profils

| Rugger | Entry Window | Exit Window | Consistency | Strategy | Tradé? |
|--------|--------------|-------------|-------------|----------|--------|
| **Fast Rugger** | 0-1.75 min | 2.96-3.18 min (22s) | 0.93 | RIDE | ✅ OUI |
| **Slow Rugger** | 0-4.06 min | 7.62-7.87 min (25s) | 0.97 | RIDE | ✅ OUI |
| **Volatile** | 0-1.32 min | 2.46-5.14 min | 0.48 | WATCH | ❌ NON |
| **Ultra-Fast** | 0-0.65 min | 1.30-1.48 min | 0.88 | AVOID | ❌ NON |

---

## Comment le système s'adapte

### 1. Détection du token
```typescript
ForensicWorker détecte: "Token XYZ créé par FastRugger7x3zK..."
```

### 2. Chargement du playbook
```typescript
const wallet = await walletRepo.getByAddress("FastRugger7x3zK...");
const playbook = JSON.parse(wallet.rugger_playbook);

// playbook contient:
// - entry_window_end_min: 1.75
// - exit_window_start_min: 2.96
// - exit_window_end_min: 3.18
// - consistency_score: 0.93
```

### 3. Génération de signaux personnalisés
```typescript
// À 0.5 min
if (elapsedMinutes <= 1.75) {
  return { action: 'BUY', percentage: 100 };
}

// À 2.0 min
if (elapsedMinutes < 2.96) {
  return { action: 'HOLD', percentage: 0 };
}

// À 3.0 min
if (elapsedMinutes <= 3.18) {
  const progress = (3.0 - 2.96) / (3.18 - 2.96);  // 18%
  return { action: 'SELL', percentage: 18 };
}
```

---

## Visualisation: Same Time, Different Signals

**Même instant (5 min après détection), ruggers différents:**

| Rugger | Signal à t=5min | Raison |
|--------|----------------|---------|
| **Fast Rugger** (avg_rug=3.18) | SELL 100% urgence | Passé exit_window (3.18 min) |
| **Slow Rugger** (avg_rug=7.87) | HOLD | Avant exit_window (7.62 min) |
| **Volatile** | NONE | Pas tradé (WATCH) |
| **Ultra-Fast** | NONE | Pas tradé (AVOID) |

---

## Commandes pour voir les playbooks réels

```bash
# Tous les playbooks RIDE (tradables)
docker exec walletsource-db psql -U walletsource -d walletsource -c "
SELECT
  wallet_address,
  (rugger_playbook->>'sample_size')::INT as rugs,
  ROUND((rugger_playbook->>'avg_time_to_peak_min')::NUMERIC, 2) as avg_peak,
  ROUND((rugger_playbook->>'avg_time_to_rug_min')::NUMERIC, 2) as avg_rug,
  ROUND((rugger_playbook->>'consistency_score')::NUMERIC, 3) as consistency,
  ROUND((rugger_playbook->>'entry_window_end_min')::NUMERIC, 2) as entry_end,
  ROUND((rugger_playbook->>'exit_window_start_min')::NUMERIC, 2) as exit_start,
  ROUND((rugger_playbook->>'exit_window_end_min')::NUMERIC, 2) as exit_end,
  (rugger_playbook->>'recommended_strategy') as strategy
FROM wallet_profiles
WHERE rugger_playbook IS NOT NULL
  AND (rugger_playbook->>'recommended_strategy') = 'RIDE'
  AND (rugger_playbook->>'consistency_score')::REAL >= 0.7
ORDER BY consistency DESC;
"

# Playbook détaillé d'un wallet spécifique
docker exec walletsource-db psql -U walletsource -d walletsource -c "
SELECT rugger_playbook
FROM wallet_profiles
WHERE wallet_address = 'WalletAddressHere...'
" | jq
```

---

## Avantages de la personnalisation

1. **Précision maximale**: Timeline adaptée au pattern exact du rugger
2. **Réduction du risque**: Filtre automatique des ruggers incohérents
3. **Optimisation des gains**: Entry/exit parfaitement timés pour chaque pattern
4. **Évolutivité**: Chaque nouveau RUG affine le playbook du wallet
5. **Robustesse**: Système refuse de trader si pattern pas clair

---

## Mise à jour continue des playbooks

Chaque fois qu'un rugger fait un nouveau RUG:

```typescript
// 1. Nouveau RUG détecté
TokenTracker finalise: verdict = RUG_METRICS

// 2. Mise à jour du playbook
PlaybookBuilder.buildPlaybook(walletAddress)
  - Récupère TOUS les RUGs du wallet (maintenant 6 au lieu de 5)
  - Recalcule les moyennes et écart-types
  - Recalcule les fenêtres temporelles
  - Recalcule le consistency_score
  - Met à jour la stratégie (peut changer WATCH → RIDE)

// 3. Prochain token de ce wallet
TradeExecutor utilisera le nouveau playbook mis à jour
```

**Le système apprend et s'améliore en continu!**
