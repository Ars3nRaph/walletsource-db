# Stratégie LONG/SHORT avec Levier (v4.2)

## Concept: Trading à effet de levier

On ne trade PAS en spot (buy/sell), mais avec **LONG/SHORT** (positions à levier).

### Objectif
- **LONG**: Profiter de la montée rapide (0-3 min)
- **SHORT**: Profiter de la chute brutale (5-7 min)

---

## Règles de LONG

### Entry (ouverture position LONG)
```typescript
Conditions:
✅ Dans entry_window (0 à avg_time_to_peak - std)
✅ Strategy = RIDE (consistency ≥ 0.70)
✅ MC > mc_at_detection (déjà en mouvement)
✅ Liquidité > 2000 USD

→ LONG avec levier 3-5x
```

### Exit (fermeture position LONG)
**Le PREMIER des deux triggers:**

#### 1. Take Profit (100%+ de gain)
```typescript
current_mc >= long_entry_mc * 2.0  // 2x = +100%

→ CLOSE_LONG (profit secured)
```

#### 2. Stagnation (pas de mouvement)
```typescript
// Aucune hausse de 5%+ depuis 20 secondes
time_since_last_5pct_rise >= 20 seconds

Détection:
- Snapshot toutes les 10s
- Comparer current_mc avec mc_20s_ago
- Si (current_mc - mc_20s_ago) / mc_20s_ago < 0.05
  → MC n'a pas augmenté de 5%
  → CLOSE_LONG (sortie avant la chute)
```

### **PAS de stop loss sur liquidité**
```typescript
❌ NE PAS attendre liquidity < -40%
   → Trop tard, déjà rugué

❌ NE PAS attendre MC < -15%
   → Trop tard, LONG déjà liquidé

✅ Sortir dès STAGNATION (protection précoce)
```

---

## Règles de SHORT

### Entry (ouverture position SHORT)
```typescript
Conditions:
✅ Peak détecté (MC commence à baisser)
✅ elapsed_min >= avg_time_to_peak
✅ MC a baissé de 3-5% depuis peak (confirmation)

→ SHORT avec levier 3-5x
```

### Exit (fermeture position SHORT)

#### 1. Take Profit (50%+ de chute)
```typescript
current_mc <= short_entry_mc * 0.5  // -50%

→ CLOSE_SHORT (profit secured)
```

#### 2. Stop Loss (remontée)
```typescript
current_mc > short_entry_mc * 1.10  // Remonte de 10%

→ CLOSE_SHORT (faux signal, sortie)
```

#### 3. Timeout (fin de tracking)
```typescript
elapsed_min >= 10 minutes

→ CLOSE_SHORT (fin de la fenêtre)
```

---

## Exemples concrets

### Exemple 1: LONG réussi (take profit 100%)

```
t=0:00 - Token détecté
         MC = 8000 USD
         → Attendre confirmation

t=0:10 - Snapshot 1
         MC = 12000 USD (+50%)
         ✅ LONG 3x @ 12000 USD
         Target: 24000 USD (2x)

t=0:20 - Snapshot 2
         MC = 18000 USD (+50% depuis LONG)
         → HOLD (pas encore 2x)

t=0:30 - Snapshot 3
         MC = 22000 USD (+83%)
         → HOLD

t=0:40 - Snapshot 4
         MC = 26000 USD (+117% = 2.17x)
         ✅ CLOSE_LONG (take profit 100%+)

Gain: 117% × 3x levier = 351% de ROI
```

### Exemple 2: LONG sortie anticipée (stagnation)

```
t=0:00 - Token détecté, MC = 8000

t=0:10 - LONG 3x @ 12000 USD

t=0:20 - MC = 18000 USD
         Last rise: now

t=0:30 - MC = 19000 USD (+5.5%)
         Last rise: now

t=0:40 - MC = 19200 USD (+1%)
         Last rise: t=0:30 (10s ago)

t=0:50 - MC = 19100 USD (-0.5%)
         Last rise: t=0:30 (20s ago)
         ✅ CLOSE_LONG (stagnation détectée)

Gain: 59% × 3x levier = 177% de ROI

t=1:00 - MC = 16000 USD (dump commence)
         → Évité la perte grâce à sortie anticipée!
```

### Exemple 3: LONG + SHORT combo

```
t=0:10 - LONG 3x @ 12000
t=0:50 - CLOSE_LONG @ 19000 (+58% = 174% ROI)

t=1:00 - MC = 18500 (baisse 2.6%)
t=1:10 - MC = 17000 (baisse 8%)
         ✅ SHORT 3x @ 17000
         Target: 8500 (50% drop)

t=3:00 - MC = 7500 (-56%)
         ✅ CLOSE_SHORT (take profit 50%+)

Gain SHORT: 56% × 3x = 168% ROI
Gain total: 174% + 168% = 342% ROI sur le même token
```

---

## Détection de stagnation (critique)

### Algorithme
```typescript
class StagnationDetector {
  private snapshots: { timestamp: Date, mc: number }[] = [];

  checkStagnation(currentMC: number): boolean {
    const now = new Date();

    // Ajouter snapshot actuel
    this.snapshots.push({ timestamp: now, mc: currentMC });

    // Garder seulement les 3 derniers snapshots (30s)
    if (this.snapshots.length > 3) {
      this.snapshots = this.snapshots.slice(-3);
    }

    // Si moins de 3 snapshots, pas encore de stagnation possible
    if (this.snapshots.length < 3) {
      return false;
    }

    // Comparer current avec snapshot d'il y a 20s (2 snapshots avant)
    const snapshot20sAgo = this.snapshots[this.snapshots.length - 3];
    const mcChange = (currentMC - snapshot20sAgo.mc) / snapshot20sAgo.mc;

    // Stagnation = pas de hausse de 5%+ en 20s
    return mcChange < 0.05;
  }
}
```

### Utilisation dans TradeExecutor
```typescript
async evaluateTrade(...) {
  // Si position LONG ouverte
  if (hasActiveLong) {
    // Check take profit
    if (currentMC >= longEntryMC * 2.0) {
      return { action: 'CLOSE_LONG', reason: 'Take profit 100%+' };
    }

    // Check stagnation
    if (this.stagnationDetector.checkStagnation(currentMC)) {
      return { action: 'CLOSE_LONG', reason: 'Stagnation 20s' };
    }

    return { action: 'HOLD_LONG' };
  }
}
```

---

## Types de signaux (mis à jour)

```typescript
export type TradeAction =
  | 'LONG'         // Ouvrir position longue
  | 'CLOSE_LONG'   // Fermer position longue
  | 'HOLD_LONG'    // Maintenir position longue
  | 'SHORT'        // Ouvrir position courte
  | 'CLOSE_SHORT'  // Fermer position courte
  | 'HOLD_SHORT'   // Maintenir position courte
  | 'NONE';        // Pas de position

export interface TradeSignal {
  action: TradeAction;
  confidence: number;
  leverage?: number;        // 🆕 Levier recommandé (3-5x)
  entry_price?: number;     // 🆕 MC d'entrée
  take_profit?: number;     // 🆕 MC de sortie (2x pour LONG)
  stop_loss?: number;       // 🆕 MC de stop (stagnation)
  reason: string;
}
```

---

## Gestion de position

### Position LONG
```typescript
interface LongPosition {
  token: string;
  entry_mc: number;
  entry_time: Date;
  leverage: number;
  target_mc: number;      // entry_mc * 2.0
  stagnation_buffer: number[];  // 3 derniers MC pour détection
}
```

### Position SHORT
```typescript
interface ShortPosition {
  token: string;
  entry_mc: number;
  entry_time: Date;
  leverage: number;
  target_mc: number;      // entry_mc * 0.5
  stop_loss_mc: number;   // entry_mc * 1.1
}
```

---

## Comparaison des stratégies

### Spot (ancienne stratégie)
```
Entry: BUY @ 12000
Exit: SELL @ 19000
Gain: 58% (7000 / 12000)
```

### Long 3x (nouvelle stratégie)
```
Entry: LONG 3x @ 12000
Exit: CLOSE @ 19000
Gain: 58% × 3 = 174%
```

### Long + Short combo (optimal)
```
Phase 1: LONG 3x @ 12000 → CLOSE @ 19000
Gain: 174%

Phase 2: SHORT 3x @ 17000 → CLOSE @ 7500
Gain: 56% × 3 = 168%

Total: 342% sur le même token!
```

---

## Paramètres de levier

| Consistency | Levier recommandé | Risque |
|-------------|-------------------|--------|
| 0.90-1.00 | 5x | Faible (très prédictible) |
| 0.80-0.89 | 4x | Modéré |
| 0.70-0.79 | 3x | Modéré-élevé |
| < 0.70 | ❌ Pas de trade | Trop risqué |

---

## Liquidation et risques

### Protection contre liquidation (LONG)
```typescript
// Calcul du prix de liquidation
liquidation_mc = entry_mc * (1 - 1/leverage)

// Ex: LONG 3x @ 12000
liquidation_mc = 12000 * (1 - 1/3) = 12000 * 0.67 = 8000

// Si MC tombe à 8000 → position liquidée
// D'où l'importance de la sortie anticipée sur stagnation!
```

### Taille de position
```typescript
// Basée sur le risque et la consistency
position_size = account_balance * risk_pct * consistency_score

// Ex:
account = 1000 USD
risk = 2% par trade
consistency = 0.85

position_size = 1000 * 0.02 * 0.85 = 17 USD
avec levier 3x → exposition 51 USD
```

---

## Monitoring en temps réel

### Dashboard
```
ACTIVE POSITIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Token: 6VEAxH...
Type: LONG 3x
Entry: 12000 @ t=0:10
Current: 19200 @ t=0:50
PnL: +60% (+180% avec levier)
Last rise: 20s ago → STAGNATION WARNING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Playbook: FastRugger7x3zK...
Avg rug: 3.2 min (still 2.5 min remaining)
```

---

## Implémentation prioritaire

1. **StagnationDetector** (critique)
   - Buffer de 3 snapshots (30s)
   - Détection de hausse < 5% en 20s

2. **Position Manager**
   - Track LONG/SHORT actives
   - Calcul PnL en temps réel
   - Trigger exit automatique

3. **TradeExecutor v4.2**
   - Signaux LONG/SHORT
   - Take profit 100%
   - Exit sur stagnation

4. **Paper Trading Logger**
   - Log positions avec levier
   - Calcul ROI réaliste
   - Stats par levier

---

## Tests critiques

Avant d'activer en production:

1. **Backtest stagnation**: Vérifier que 80%+ des sorties évitent le dump
2. **Backtest take profit**: Vérifier que 2x est atteignable 70%+ du temps
3. **Simulation levier**: Vérifier les liquidations potentielles
4. **Combo LONG+SHORT**: Tester la profitabilité des deux phases

**Objectif**: Win rate 70%+ avec ROI moyen 150%+ par trade (avec levier 3x)
