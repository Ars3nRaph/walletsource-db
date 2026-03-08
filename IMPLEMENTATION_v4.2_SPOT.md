# Implémentation v4.2 — Spot Trading avec Détection Intelligente

## ✅ Composants créés (adaptés pour spot)

### 1. StagnationDetector
**Fichier**: `src/execution/StagnationDetector.ts`

**Rôle**: Détecter quand un token stagne (pas de +5% en 20s) → signal de vente précoce

**Méthodes**:
```typescript
recordSnapshot(token, mc)        // Enregistre un snapshot
checkStagnation(token): boolean  // Vérifie si stagne
getLastChange(token): number     // Debug: dernier changement
clear(token)                     // Nettoie après sortie
```

**Usage dans TradeExecutor (SPOT)**:
```typescript
// Durant la phase de HOLD
if (this.stagnationDetector.checkStagnation(token)) {
  return { action: 'SELL', percentage: 100, reason: 'Stagnation 20s - early exit' };
}
```

---

### 2. PeakDurationDetector
**Fichier**: `src/execution/PeakDurationDetector.ts`

**Rôle**: Mesurer la durée du peak (temps entre peak et dump) pour optimiser le timing de vente

**Méthodes**:
```typescript
recordSnapshot(token, mc)           // Enregistre et détecte peak/dump
isAtPeak(token, mc): boolean        // Vérifie si encore au peak
hasDumpStarted(token): boolean      // Vérifie si dump commencé
getPeakDuration(token): number      // Durée du peak en minutes
getPeakMC(token): number            // MC maximum atteint
getTimeSincePeak(token): number     // Temps depuis peak
```

**Usage dans TokenTracker**:
```typescript
// À chaque snapshot durant le tracking
this.peakDetector.recordSnapshot(token, currentMC);

// Après finalisation
const peakDuration = this.peakDetector.getPeakDuration(token);
await this.tokenRepo.updatePeakDuration(token, peakDuration);
```

---

## 🗄️ Migrations appliquées

### v4.2: Peak Duration
```sql
-- token_events
peak_duration_min  -- Durée entre peak et dump
peak_time          -- Timestamp du peak
```

---

## 📊 Nouvelle structure de Playbook (v4.2)

```typescript
interface RuggerPlaybook {
  // Timing
  avg_time_to_peak_min: number
  std_time_to_peak_min: number
  avg_time_to_rug_min: number
  std_time_to_rug_min: number

  // 🆕 Durée du peak
  avg_peak_duration_min: number      // Ex: 0.8 min
  std_peak_duration_min: number      // Ex: 0.2 min

  // Prix/MC
  avg_peak_mc: number
  std_peak_mc: number
  avg_dump_speed: number
  avg_liquidity_at_peak: number

  // Windows
  entry_window_end_min: number
  exit_window_start_min: number
  exit_window_end_min: number

  // Stratégie
  consistency_score: number
  recommended_strategy: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID'
}
```

---

## 🔄 Workflow complet (Spot Trading)

### Exemple: BUY → SELL avec détection de stagnation

```
t=0:00 - Token détecté, MC = 8000
t=0:10 - Snapshot 1, MC = 12000
         ✅ BUY @ 12000 (entry_window, consistency ≥ 0.70)

t=0:20 - Snapshot 2, MC = 18000 (+50%)
         stagnationDetector.checkStagnation() → false
         → HOLD

t=0:30 - Snapshot 3, MC = 22000 (+83%)
         stagnationDetector.checkStagnation() → false
         → HOLD

t=0:40 - Snapshot 4, MC = 23000 (+92%)
         Last rise: 10s ago

t=0:50 - Snapshot 5, MC = 23100 (+0.4%)
         Last rise: 20s ago (pas de +5% depuis 20s)
         ✅ SELL 100% (stagnation détectée)
         ROI: 92% (23100/12000 - 1)

t=1:00 - MC = 19000 (dump commence)
         → Évité la chute grâce à la détection de stagnation!
```

---

## 🎯 Logique de décision (TradeExecutor v4.2 Spot)

### Entry BUY
```typescript
Conditions:
✅ elapsed_min <= entry_window_end_min
✅ strategy === 'RIDE'
✅ consistency_score >= 0.70

→ BUY 100%
```

### Exit SELL (PRIORITÉ)

**Le PREMIER de**:

1. **Stagnation (haute priorité)**
   ```typescript
   stagnationDetector.checkStagnation(token) === true
   → SELL 100% (sortie immédiate avant dump)
   ```

2. **Exit window (progressive)**
   ```typescript
   elapsed_min >= exit_window_start_min
   → SELL progressif (0-100% selon progression dans la fenêtre)
   ```

3. **Past exit window**
   ```typescript
   elapsed_min > exit_window_end_min
   → SELL 100% (urgence)
   ```

---

## 📝 Intégration complète

### TokenTracker (✅ Fait)
```typescript
// Ajouté dans constructor
private stagnationDetector = new StagnationDetector();
private peakDetector = new PeakDurationDetector();

// Ajouté dans startTracking
this.stagnationDetector.recordSnapshot(tokenAddress, currentFdv);
this.peakDetector.recordSnapshot(tokenAddress, currentFdv);

// Ajouté dans finalizeTracking
const peakDuration = this.peakDetector.getPeakDuration(tokenAddress);
await this.tokenRepo.updatePeakDuration(tokenAddress, peakDuration);

// Cleanup
this.stagnationDetector.clear(tokenAddress);
this.peakDetector.clear(tokenAddress);
```

### PlaybookBuilder (✅ Fait)
```typescript
// Ajouté: calcul de avg_peak_duration_min et std_peak_duration_min
const peakDurations = rugs
  .filter(r => r.peak_duration_min !== null)
  .map(r => r.peak_duration_min!);

const avgPeakDuration = this.mean(peakDurations);
const stdPeakDuration = this.stdDev(peakDurations);

// Inclus dans playbook
avg_peak_duration_min: avgPeakDuration,
std_peak_duration_min: stdPeakDuration
```

### TradeExecutor (✅ Fait - SPOT)
```typescript
// Détection de stagnation dans la phase HOLD
if (elapsedMinutes < exit_window_start_min) {
  if (this.stagnationDetector.checkStagnation(tokenAddress)) {
    return {
      action: 'SELL',
      percentage: 100,
      reason: 'Stagnation detected (no 5% MC rise in 20s) - early exit'
    };
  }
  return { action: 'HOLD', ... };
}

// Priorité stagnation dans exit_window
if (elapsedMinutes <= exit_window_end_min) {
  if (this.stagnationDetector.checkStagnation(tokenAddress)) {
    return {
      action: 'SELL',
      percentage: 100,
      reason: 'Stagnation detected in exit window - immediate full exit'
    };
  }
  // Sinon vente progressive basée sur le temps
}
```

---

## 📈 Métriques attendues (Spot Trading)

| Métrique | Objectif | Comment mesurer |
|----------|----------|-----------------|
| **Win rate** | 70%+ | Positions closes avec profit > 0 |
| **ROI moyen** | 50%+ | Gain moyen par trade profitable |
| **Stagnation detection accuracy** | 80%+ | % de sorties avant dump grâce à stagnation |
| **False positive stagnation** | <20% | % de sorties stagnation qui étaient prématurées |

---

## 🔧 Tests critiques

1. **Stagnation detection**: Vérifier que 80%+ des exits stagnation évitent le dump
2. **Peak duration tracking**: Vérifier que avg_peak_duration est correctement calculé
3. **Integration TokenTracker**: Vérifier que les détecteurs sont appelés à chaque snapshot
4. **Integration TradeExecutor**: Vérifier que la stagnation est priorisée sur la vente progressive

**Validation**: Lancer paper trading sur 50-100 tokens, analyser les résultats.

---

## 🔑 Différence clé vs v4.0

**v4.0**: Vente basée uniquement sur les fenêtres temporelles (exit_window)

**v4.2**: Vente intelligente avec **détection de stagnation** (sortie précoce avant dump) + fenêtres temporelles en fallback

**Avantage**: Sortie anticipée quand le MC stagne, évite d'attendre la fenêtre de sortie et de subir le dump.

---

## ⚠️ Pourquoi pas LONG/SHORT ?

**Pump.fun tokens = SPOT uniquement**:
- Pas de marchés perpétuels disponibles
- Pas de leverage/margin trading sur DEXs (Raydium, Jupiter)
- LONG/SHORT nécessite des marchés dérivés (Drift, Mango) qui n'existent que pour tokens majeurs

**Solution**: Spot BUY/SELL avec détection intelligente de sortie.
