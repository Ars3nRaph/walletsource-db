# Implémentation v4.2 — LONG/SHORT avec Levier

## ✅ Composants créés

### 1. StagnationDetector
**Fichier**: `src/execution/StagnationDetector.ts`

**Rôle**: Détecter quand un token stagne (pas de +5% en 20s)

**Méthodes**:
```typescript
recordSnapshot(token, mc)        // Enregistre un snapshot
checkStagnation(token): boolean  // Vérifie si stagne
getLastChange(token): number     // Debug: dernier changement
clear(token)                     // Nettoie après sortie
```

**Usage**:
```typescript
// Dans TokenTracker, à chaque snapshot:
stagnationDetector.recordSnapshot(token, currentMC);

// Dans TradeExecutor:
if (hasActiveLong && stagnationDetector.checkStagnation(token)) {
  return { action: 'CLOSE_LONG', reason: 'Stagnation 20s' };
}
```

---

### 2. PeakDurationDetector
**Fichier**: `src/execution/PeakDurationDetector.ts`

**Rôle**: Mesurer la durée du peak (temps entre peak et dump)

**Méthodes**:
```typescript
recordSnapshot(token, mc)           // Enregistre et détecte peak/dump
isAtPeak(token, mc): boolean        // Vérifie si encore au peak
hasDumpStarted(token): boolean      // Vérifie si dump commencé
getPeakDuration(token): number      // Durée du peak en minutes
getPeakMC(token): number            // MC maximum atteint
getTimeSincePeak(token): number     // Temps depuis peak
```

**Usage**:
```typescript
// Détection du moment idéal pour SHORT
if (peakDetector.hasDumpStarted(token) &&
    peakDetector.getTimeSincePeak(token) >= playbook.avg_peak_duration_min) {
  return { action: 'SHORT', leverage: 3 };
}
```

---

### 3. PositionManager
**Fichier**: `src/execution/PositionManager.ts`

**Rôle**: Gérer les positions LONG/SHORT actives

**Méthodes**:
```typescript
openLong(token, entryMC, leverage): Position
openShort(token, entryMC, leverage): Position
closePosition(token): Position
hasPosition(token): boolean
calculatePnL(token, currentMC): number     // ROI en %
isTakeProfitReached(token, mc): boolean    // 2x pour LONG, 0.5x pour SHORT
isStopLossReached(token, mc): boolean      // Remontée pour SHORT
getTimeInPosition(token): number           // Minutes depuis entry
```

**Usage**:
```typescript
// Ouvrir position
positionManager.openLong(token, 12000, 3);  // LONG 3x @ 12000

// Vérifier take profit
if (positionManager.isTakeProfitReached(token, 25000)) {
  const pnl = positionManager.calculatePnL(token, 25000);
  console.log(`Take profit! ROI: ${pnl}%`);
  positionManager.closePosition(token);
}
```

---

## 🗄️ Migrations appliquées

### v4.1: Price Metrics
```sql
-- token_events
mc_at_detection
liquidity_at_detection
price_at_detection
peak_multiplier
dump_percentage
liquidity_removed_pct

-- token_snapshots
price
volume_5m
buy_pressure
```

### v4.2: Peak Duration
```sql
-- token_events
peak_duration_min  -- 🆕 Durée entre peak et dump
peak_time          -- 🆕 Timestamp du peak
```

---

## 📊 Nouvelle structure de Playbook

```typescript
interface RuggerPlaybook {
  // Timing
  avg_time_to_peak_min: number
  std_time_to_peak_min: number
  avg_time_to_rug_min: number
  std_time_to_rug_min: number

  // 🆕 Durée du peak (pour SHORT)
  avg_peak_duration_min: number      // Ex: 0.8 min
  std_peak_duration_min: number      // Ex: 0.2 min

  // Prix/MC
  avg_mc_at_start: number
  avg_mc_at_peak: number
  avg_peak_multiplier: number        // Ex: 5.6x
  avg_dump_percentage: number        // Ex: 85%

  // Liquidité
  avg_liquidity_at_start: number
  avg_liquidity_at_peak: number
  avg_liquidity_removed_pct: number

  // Windows
  entry_window_end_min: number
  exit_window_start_min: number
  exit_window_end_min: number

  // 🆕 SHORT windows (basées sur peak_duration)
  short_entry_window_start_min: number  // time_to_peak + peak_duration
  short_exit_window_min: number         // time_to_rug

  // Stratégie
  consistency_score: number
  recommended_strategy: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID'
}
```

---

## 🔄 Workflow complet LONG/SHORT

### Phase 1: LONG (montée)
```
t=0:00 - Token détecté, MC = 8000
t=0:10 - Snapshot 1, MC = 12000
         ✅ LONG 3x @ 12000 (entry_window, consistency ≥ 0.70)
         Target: 24000 (2x)

t=0:20 - Snapshot 2, MC = 18000 (+50%)
         stagnationDetector.checkStagnation() → false
         → HOLD_LONG

t=0:30 - Snapshot 3, MC = 22000 (+83%)
         stagnationDetector.checkStagnation() → false
         → HOLD_LONG

t=0:40 - Snapshot 4, MC = 26000 (+117%)
         isTakeProfitReached(26000) → true (26k > 24k)
         ✅ CLOSE_LONG
         ROI: 117% × 3x = 351%
```

### Phase 2: SHORT (chute)
```
t=0:40 - Peak détecté: 26000
         peakDetector.recordSnapshot(token, 26000)
         → Attendre confirmation

t=0:50 - MC = 25500 (-2%)
         peakDetector.isAtPeak() → true (encore à 98% du peak)
         → Attendre

t=1:00 - MC = 24700 (-5%)
         peakDetector.hasDumpStarted() → true
         peak_duration = 1.0 min (t=1:00 - t=0:40)

         Playbook: avg_peak_duration = 0.8 min
         → Dump confirmé (durée réaliste)

         ✅ SHORT 3x @ 24700
         Target: 12350 (0.5x)

t=2:00 - MC = 18000 (-27%)
         → HOLD_SHORT

t=3:00 - MC = 11000 (-55%)
         isTakeProfitReached(11000) → true (11k < 12.35k)
         ✅ CLOSE_SHORT
         ROI: 55% × 3x = 165%

Total session: 351% + 165% = 516% ROI
```

---

## 🎯 Logique de décision (TradeExecutor v4.2)

### Entry LONG
```typescript
Conditions:
✅ elapsed_min <= entry_window_end_min
✅ strategy === 'RIDE'
✅ consistency_score >= 0.70
✅ mc < avg_peak_mc * 0.8  // Pas encore au peak
✅ liquidity > 2000

→ LONG avec levier = f(consistency_score)
  - 0.90+ → 5x
  - 0.80-0.89 → 4x
  - 0.70-0.79 → 3x
```

### Exit LONG
```typescript
Le PREMIER de:

1. Take Profit
   mc >= long_entry_mc * 2.0
   → CLOSE_LONG (profit 100%+)

2. Stagnation
   stagnationDetector.checkStagnation(token) === true
   → CLOSE_LONG (sortie avant dump)

3. Stop Loss (hard)
   mc <= long_entry_mc * 0.95
   → CLOSE_LONG (protection -5%)
```

### Entry SHORT
```typescript
Conditions:
✅ peakDetector.hasDumpStarted(token) === true
✅ peak_duration >= avg_peak_duration * 0.5  // Au moins 50% de la durée typique
✅ time_since_peak <= avg_peak_duration * 2.0  // Pas trop tard
✅ mc < peak_mc * 0.95  // Confirmé (baisse 5%)

→ SHORT avec levier = f(consistency_score)
```

### Exit SHORT
```typescript
Le PREMIER de:

1. Take Profit
   mc <= short_entry_mc * 0.5
   → CLOSE_SHORT (profit 50%+)

2. Stop Loss
   mc >= short_entry_mc * 1.10
   → CLOSE_SHORT (remontée 10%)

3. Timeout
   elapsed_min >= 10 minutes
   → CLOSE_SHORT (fin de tracking)
```

---

## 📝 Prochaines étapes

### Étape 1: Intégrer dans TokenTracker
```typescript
// Dans TokenTracker
private stagnationDetector = new StagnationDetector();
private peakDetector = new PeakDurationDetector();

private async trackToken(token: string) {
  for (let i = 0; i < 60; i++) {
    const snapshot = await this.captureSnapshot(token);

    // Enregistrer pour détection
    this.stagnationDetector.recordSnapshot(token, snapshot.fdv);
    this.peakDetector.recordSnapshot(token, snapshot.fdv);

    await sleep(10000);
  }

  // Calculer peak_duration
  const peakDuration = this.peakDetector.getPeakDuration(token);
  await this.tokenRepo.updatePeakDuration(token, peakDuration);
}
```

### Étape 2: Modifier PlaybookBuilder
```typescript
// Ajouter calcul de avg_peak_duration
const rugs = await this.getRugsWithLifecycleData(wallet);
const peak_durations = rugs
  .filter(r => r.peak_duration_min !== null)
  .map(r => r.peak_duration_min!);

const avg_peak_duration_min = this.mean(peak_durations);
const std_peak_duration_min = this.stdDev(peak_durations);

// Fenêtres SHORT
const short_entry_window_start = avg_time_to_peak + avg_peak_duration;
const short_exit_window = avg_time_to_rug;
```

### Étape 3: Refactor TradeExecutor
```typescript
export class TradeExecutor {
  private stagnationDetector = new StagnationDetector();
  private peakDetector = new PeakDurationDetector();
  private positionManager = new PositionManager();

  async evaluateTrade(
    token: string,
    elapsed_min: number,
    current_mc: number
  ): Promise<TradeSignal> {

    // Enregistrer snapshot pour détections
    this.stagnationDetector.recordSnapshot(token, current_mc);
    this.peakDetector.recordSnapshot(token, current_mc);

    // 1. Vérifier positions actives
    if (this.positionManager.hasPosition(token)) {
      return this.evaluateActivePosition(token, current_mc);
    }

    // 2. Vérifier opportunités d'entrée
    const playbook = await this.getPlaybook(token);

    if (this.shouldOpenLong(playbook, elapsed_min, current_mc)) {
      return this.openLongSignal(token, current_mc, playbook);
    }

    if (this.shouldOpenShort(playbook, elapsed_min, current_mc)) {
      return this.openShortSignal(token, current_mc, playbook);
    }

    return { action: 'NONE' };
  }
}
```

### Étape 4: Paper Trading Logger
```typescript
// Adapter pour LONG/SHORT
interface PaperTrade {
  timestamp: Date;
  token: string;
  action: 'LONG' | 'CLOSE_LONG' | 'SHORT' | 'CLOSE_SHORT';
  entry_mc?: number;
  exit_mc?: number;
  leverage: number;
  roi_pct: number;  // Avec levier
  duration_sec: number;
  reason: string;
}
```

---

## 📈 Métriques attendues

| Métrique | Objectif | Comment mesurer |
|----------|----------|-----------------|
| **Win rate LONG** | 70%+ | Positions closes avec profit > 0 |
| **ROI moyen LONG** | 150%+ | Avec levier 3x |
| **Win rate SHORT** | 60%+ | Plus risqué que LONG |
| **ROI moyen SHORT** | 100%+ | Avec levier 3x |
| **Combo LONG+SHORT** | 80%+ | Au moins une des deux profitable |
| **ROI combo** | 250%+ | Somme des deux phases |

---

## 🔧 Tests critiques

1. **Backtest stagnation**: 80%+ des sorties évitent le dump
2. **Backtest peak_duration**: Short entry optimisé vs entry aléatoire
3. **Backtest take profit**: 2x atteignable 70%+ du temps
4. **Simulation liquidation**: Vérifier levier max safe
5. **Combo LONG+SHORT**: Win rate et ROI global

**Validation**: Lancer 100 tokens en paper trading, analyser les résultats.
