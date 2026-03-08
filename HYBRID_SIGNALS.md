# Signaux Hybrides — Temps + Prix (v4.1)

## Concept: Double confirmation

Au lieu de se fier **uniquement** au temps, le système combine:
1. **Fenêtres temporelles** (basées sur l'historique du rugger)
2. **Seuils de prix/MC** (détection en temps réel)

→ Signal émis SEULEMENT si **les deux conditions** sont remplies.

---

## Métriques ajoutées

### Au niveau du token (token_events)

| Métrique | Description | Usage |
|----------|-------------|-------|
| `mc_at_detection` | Market cap au moment de la détection | Point de référence (baseline) |
| `liquidity_at_detection` | Liquidité initiale | Détection du rug si chute brutale |
| `price_at_detection` | Prix initial | Calcul des multipliers |
| `peak_multiplier` | `peak_mc / mc_at_detection` | Performance du pump |
| `dump_percentage` | `(peak_mc - current_mc) / peak_mc` | Amplitude du dump |
| `liquidity_removed_pct` | % de liquidité retirée | Confirmation du rug |

### Au niveau des snapshots (token_snapshots)

| Métrique | Description | Usage |
|----------|-------------|-------|
| `price` | Prix du token à cet instant | Détection de cassure |
| `volume_5m` | Volume sur 5 minutes | Détection d'accumulation |
| `buy_pressure` | `buy_volume / total_volume` | Sentiment du marché |

### Au niveau du playbook (rugger_playbook)

```typescript
interface RuggerPlaybook {
  // Timing historique
  avg_time_to_peak_min: number
  avg_time_to_rug_min: number

  // 🆕 Prix historique
  avg_mc_at_start: number          // ex: 8000 USD
  avg_mc_at_peak: number            // ex: 45000 USD
  avg_peak_multiplier: number       // ex: 5.6x (45k / 8k)
  avg_dump_percentage: number       // ex: 85% (chute brutale)

  // 🆕 Liquidité historique
  avg_liquidity_at_start: number   // ex: 3000 USD
  avg_liquidity_at_peak: number    // ex: 8000 USD
  avg_liquidity_removed_pct: number // ex: 70%

  // 🆕 Seuils de détection
  peak_detection_threshold: number   // ex: 0.90 (90% du peak historique)
  dump_detection_threshold: number   // ex: 0.15 (15% de chute depuis peak)
}
```

---

## Exemples de signaux hybrides

### 1. BUY Signal (temps + prix)

**Conditions cumulatives:**
```typescript
// Condition 1: Fenêtre temporelle
elapsed_min <= entry_window_end_min

// Condition 2: Prix n'a pas encore atteint le peak
current_mc < (playbook.avg_mc_at_peak * 0.8)  // Pas encore à 80% du peak

// Condition 3: Liquidité suffisante
current_liquidity > 2000 USD  // Minimum pour l'exécution

// → BUY seulement si les 3 conditions sont vraies
```

**Exemple concret:**
```
Rugger: FastRugger7x3zK...
Playbook: avg_peak = 45000 USD à 1.9 min

Token nouveau détecté:
t = 0.5 min, MC = 12000 USD, liquidity = 3500 USD

✅ 0.5 < 1.75 min (dans entry_window)
✅ 12000 < 36000 (80% de 45000)
✅ 3500 > 2000 (liquidity OK)

→ BUY 100%
```

### 2. HOLD Signal (temps + prix)

**Conditions:**
```typescript
// Condition 1: Entre entry et exit
entry_window_end < elapsed_min < exit_window_start

// Condition 2: Peak pas encore atteint OU pas encore de dump
current_mc >= (mc_at_detection * 1.5)  // Au moins 50% de hausse
&& dump_detected === false             // Pas de dump détecté

// → HOLD position
```

**Exemple:**
```
t = 2.5 min, MC = 42000 USD (peak), liquidity = 7500 USD
mc_at_detection = 8000 USD

✅ 1.75 < 2.5 < 2.96 (dans hold period)
✅ 42000 >= 12000 (8000 × 1.5)
✅ Pas de dump détecté (MC stable)

→ HOLD (attendre exit_window)
```

### 3. SELL Signal (temps + prix avec détection de dump)

**Conditions:**
```typescript
// Condition 1: Dans exit_window OU dump détecté
(exit_window_start <= elapsed_min <= exit_window_end)
|| dump_detected === true

// Condition 2: Peak déjà atteint
peak_detected === true

// Condition 3: Dump confirmé (au moins une de ces conditions)
(current_mc < peak_mc * 0.85)  // Chute de 15%+
|| (liquidity < liquidity_at_peak * 0.6)  // Liquidité retirée à 40%+

// → SELL progressif ou urgence
```

**Exemple 1: Dump détecté avant exit_window (sortie anticipée)**
```
t = 2.2 min, MC = 46000 USD → 35000 USD (chute brutale)
peak_mc = 46000 USD

❌ 2.2 < 2.96 (PAS encore dans exit_window)
✅ Dump détecté: 35000 < 39100 (46000 × 0.85)

→ SELL 100% URGENCE (sortie anticipée)
```

**Exemple 2: Sortie normale dans exit_window**
```
t = 3.0 min, MC = 40000 USD (baisse modérée)
peak_mc = 46000 USD

✅ 2.96 <= 3.0 <= 3.18 (dans exit_window)
✅ 40000 < 39100 (confirmation du dump)

→ SELL 18% (progressif selon position dans le window)
```

### 4. SELL URGENCE (détection de rug)

**Conditions de rug confirmé:**
```typescript
// Au moins 2 de ces 3 conditions:
1. liquidity < liquidity_at_peak * 0.3  // Liquidité retirée à 70%+
2. current_mc < peak_mc * 0.5           // Chute de 50%+
3. price_change_5m < -40%               // Dump rapide

// → SELL 100% immédiatement (peu importe le timing)
```

**Exemple:**
```
t = 3.5 min, MC = 8000 USD, liquidity = 1200 USD
peak_mc = 46000 USD, liquidity_at_peak = 7500 USD

✅ 1200 < 2250 (7500 × 0.3) → liquidité retirée 84%
✅ 8000 < 23000 (46000 × 0.5) → chute 83%
✅ price_change_5m = -65%

→ SELL 100% URGENCE (rug confirmé)
```

---

## Détection en temps réel

### Peak Detection

Le système détecte le peak quand:
```typescript
// Peak = snapshot avec MC maximum
current_mc > all_previous_snapshots.max(fdv)
&&
(
  next_snapshot.fdv < current_mc * 0.95  // Commence à baisser
  || elapsed_min > (avg_time_to_peak + std_time_to_peak)  // Temps dépassé
)

// Flag peak_detected = true
```

### Dump Detection

Le système détecte le dump quand:
```typescript
// Depuis le peak:
dump_percentage = (peak_mc - current_mc) / peak_mc

dump_detected = (
  dump_percentage > playbook.avg_dump_percentage * 0.5  // Au moins 50% du dump typique
  || current_mc < peak_mc * 0.85  // Chute de 15%+
  || liquidity_removed_pct > 40%   // Liquidité retirée
)
```

---

## Comparaison: Temps seul vs Hybride

### Scénario: Dump précoce (avant exit_window)

**Temps seul (v4.0):**
```
t = 2.5 min, MC = 46000 → 12000 (dump brutal)

❌ 2.5 < 2.96 (pas encore dans exit_window)
→ HOLD (perte de 74%!)
```

**Hybride (v4.1):**
```
t = 2.5 min, MC = 46000 → 12000 (dump brutal)

✅ Dump détecté: 12000 < 39100
✅ Liquidité retirée: 85%
→ SELL 100% URGENCE (sauvegarde de la position)
```

### Scénario: Faux peak (montée continue)

**Temps seul (v4.0):**
```
t = 3.0 min, MC = 40000 (monte encore vers 50000)

✅ 2.96 <= 3.0 <= 3.18 (dans exit_window)
→ SELL 18% (sortie prématurée, manque le vrai peak)
```

**Hybride (v4.1):**
```
t = 3.0 min, MC = 40000 (monte encore)

✅ 2.96 <= 3.0 <= 3.18 (dans exit_window)
❌ Peak pas détecté: MC monte encore
❌ Dump pas détecté: pas de chute
→ HOLD (attend le vrai peak)
```

---

## Calcul des métriques dans le playbook

```typescript
// PlaybookBuilder recalcule pour chaque nouveau RUG:
const rugs = getRugsWithLifecycleData(wallet);

// Prix/MC
const avg_mc_at_start = mean(rugs.map(r => r.mc_at_detection));
const avg_mc_at_peak = mean(rugs.map(r => r.peak_mc));
const avg_peak_multiplier = mean(rugs.map(r => r.peak_multiplier));
const avg_dump_percentage = mean(rugs.map(r => r.dump_percentage));

// Liquidité
const avg_liquidity_at_start = mean(rugs.map(r => r.liquidity_at_detection));
const avg_liquidity_at_peak = mean(rugs.map(r => r.liquidity_at_peak));
const avg_liquidity_removed = mean(rugs.map(r => r.liquidity_removed_pct));

// Seuils de détection
const peak_detection_threshold = avg_mc_at_peak * 0.90;  // 90% du peak moyen
const dump_detection_threshold = 0.15;  // 15% de chute
```

---

## Priorité des signaux

```
1. RUG DÉTECTÉ (liquidité/prix) → SELL 100% immédiat
2. DUMP DÉTECTÉ (chute 15%+) → SELL selon fenêtre
3. EXIT WINDOW + peak détecté → SELL progressif
4. ENTRY WINDOW + pas de peak → BUY
5. Sinon → HOLD
```

---

## Implémentation

```typescript
// TradeExecutor avec signaux hybrides
async evaluateTrade(
  tokenAddress: string,
  elapsedMinutes: number,
  currentMC: number,
  currentLiquidity: number  // 🆕
): Promise<TradeSignal> {

  // Charger le playbook
  const playbook = await this.getPlaybook(tokenAddress);

  // Charger l'état actuel
  const peakDetected = await this.isPeakDetected(tokenAddress);
  const dumpDetected = await this.isDumpDetected(tokenAddress, playbook);

  // 1. RUG confirmé → SELL urgence
  if (this.isRugConfirmed(currentMC, currentLiquidity, playbook)) {
    return { action: 'SELL', percentage: 100, reason: 'RUG confirmed' };
  }

  // 2. Dump détecté → SELL immédiat
  if (dumpDetected) {
    return { action: 'SELL', percentage: 100, reason: 'Dump detected' };
  }

  // 3. Entry window + pas de peak → BUY
  if (elapsedMinutes <= playbook.entry_window_end_min && !peakDetected) {
    if (currentMC < playbook.avg_mc_at_peak * 0.8) {
      return { action: 'BUY', percentage: 100 };
    }
  }

  // 4. Exit window + peak détecté → SELL progressif
  if (elapsedMinutes >= playbook.exit_window_start_min && peakDetected) {
    const progress = calculateProgress(...);
    return { action: 'SELL', percentage: progress * 100 };
  }

  // 5. Sinon → HOLD
  return { action: 'HOLD', percentage: 0 };
}
```

---

## Avantages des signaux hybrides

1. **Protection contre dumps précoces**: Sortie avant la fenêtre si rug détecté
2. **Évite les faux peaks**: Attend confirmation du peak avant de vendre
3. **Meilleure précision**: Double validation (temps + prix)
4. **Adaptation en temps réel**: Réagit aux conditions du marché
5. **Stop loss automatique**: Détection de rug et sortie d'urgence

---

## Tests recommandés

Avant d'activer cette logique en production:

1. **Backtesting**: Rejouer les RUGs historiques avec les 2 méthodes
2. **Comparaison**: Temps seul vs Hybride sur 100+ RUGs
3. **Edge cases**: Tester les scénarios extrêmes
4. **Performance**: Vérifier que la détection est assez rapide (< 5s)

**Objectif**: Win rate > 80% avec signaux hybrides (vs ~70% temps seul)
