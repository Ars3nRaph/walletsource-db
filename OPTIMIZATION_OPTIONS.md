# Optimisation Options — Vitesse de Traitement

## État Actuel (après première optimisation)

```
Slots simultanés:  36 → 90 ✅
Poll interval:     60 secondes
Tracking durée:    10 minutes
Capacité:          540 tokens/h
Queue actuelle:    1,657 tokens
Temps vidage:      3.1 heures
```

## Options Supplémentaires

### Option A: POLL_INTERVAL 60s → 30s (Recommandé)

```typescript
const POLL_INTERVAL_MS = 30 * 1000; // 30s au lieu de 60s
```

**Avantages:**
- Snapshots plus fréquents (20 au lieu de 10)
- Détection RUG plus rapide
- Lifecycle data plus précise
- Capacité: **1,080 tokens/h** (2× plus rapide)
- Temps vidage: **1.5 heures** au lieu de 3.1h

**Inconvénients:**
- Consommation rate limit: 60% (180/300) — toujours safe
- Charge DB légèrement plus élevée

**Impact rate limit:**
```
90 tokens × 2 req/min = 180 req/min
Rate limit: 300 req/min
→ Marge: 40% restante ✅
```

---

### Option B: TRACKING_DURATION 10min → 5min (Agressif)

```typescript
const TRACKING_DURATION_MS = 5 * 60 * 1000; // 5 minutes
```

**Avantages:**
- Libère slots 2× plus vite
- Capacité: **1,080 tokens/h** (90 slots × 12 cycles/h)
- Temps vidage: **1.5 heures**

**Inconvénients:**
- Lifecycle data moins complète (5 snapshots vs 10)
- Peut manquer certains rugs lents (>5min)
- **NON RECOMMANDÉ** — sacrifie qualité des données

---

### Option C: Combinaison A+B (Très Agressif)

```typescript
const POLL_INTERVAL_MS = 30 * 1000;  // 30s
const TRACKING_DURATION_MS = 5 * 60 * 1000; // 5min
```

**Capacité:**
```
90 slots × 12 cycles/h = 1,080 tokens/h
10 snapshots par token (5min / 30s)
180 req/min (60% rate limit)
```

**Temps vidage: 1.5 heures**

**Risques:**
- Données moins complètes
- Peut manquer patterns lents
- **NON RECOMMANDÉ** pour playbook building

---

## Recommandation

### ✅ Configuration Optimale Balance Vitesse/Qualité

```typescript
// CURRENT (Applied)
activeCount >= 90 ✅

// RECOMMEND ADDING
const POLL_INTERVAL_MS = 30 * 1000; // 30s instead of 60s
```

**Résultat:**
- Capacité: **1,080 tokens/h**
- Temps vidage: **1.5 heures**
- Rate limit: 60% (safe)
- Qualité données: **Excellente** (20 snapshots × 10min)

**Cette config maximise la vitesse tout en préservant la qualité des lifecycle data pour playbooks fiables.**

---

## Action Requise

Pour appliquer Option A (recommandée):

1. Modifier `src/workers/TokenTracker.ts` ligne 19:
   ```typescript
   const POLL_INTERVAL_MS = 30 * 1000; // Change from 60
   ```

2. Compiler: `npm run build`

3. Redémarrer le programme: `Ctrl+C` puis `npm start`

**Résultat attendu:**
- Dashboard montrera ~90 tokens en PROCESSING
- Queue PENDING vidée en ~1.5h au lieu de 3.1h
- 20 snapshots par token (meilleure précision)
