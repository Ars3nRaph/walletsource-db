# Bugs détectés lors du monitoring (2026-03-08)

## 🔴 Critique 1: Helius API - 43% d'échecs

**Symptôme:**
```
ERROR: Failed to fetch Helius transactions (13/30 appels)
error: {} (objet vide - erreur mal loggée)
```

**Cause probable:**
- Appels Helius simultanés sans limite de concurrence
- Pas de queue pour espacer les requêtes
- 12 RUGs finalisent en même temps → 12 appels buildWalletAncestry() concurrents → rate limit ou network errors

**Impact:**
- Ancestry building échoue pour ~50% des wallets RUG
- Données incomplètes pour scoring
- Crédits Helius gaspillés (retry sans succès)

**Fix:**
1. Ajouter semaphore ou queue dans buildWalletAncestry()
2. Limiter à 3-5 appels Helius concurrents max
3. Améliorer error logging (afficher message HTTP)
4. Add retry avec exponential backoff

---

## 🔴 Critique 2: Backlog massif (122 tokens PENDING)

**Symptôme:**
```
Queue PENDING: 122 tokens
Queue PROCESSING: 12 (limite atteinte)
Delay moyen: 60+ minutes avant tracking
```

**Cause:**
- Détection: ~528 tokens/heure
- Capacité: ~72 tokens/heure (12 slots × 6 cycles/h avec tracking 10 min)
- Écart: 7× trop de tokens!

**Impact:**
- Tokens trackés avec 1h+ de retard
- RUGs peuvent déjà être dump quand tracking démarre
- Mauvaise qualité de lifecycle analysis

**Solutions possibles:**

**Option A: Augmenter capacité (simple)**
```typescript
// TokenTracker.ts ligne 129
-if (activeCount >= 12 || remainingQuota < 100) {
+if (activeCount >= 24 || remainingQuota < 200) {  // Double slots

// Capacité: 24 × 6 = 144 tokens/h (toujours insuffisant!)
```

**Option B: Réduire tracking duration (recommandé)**
```typescript
// TokenTracker.ts ligne 20
-const TRACKING_DURATION_MS = 10 * 60 * 1000; // 10 minutes
+const TRACKING_DURATION_MS = 5 * 60 * 1000; // 5 minutes (RUGs happen in 3-7 min)

// Capacité: 12 × 12 = 144 tokens/h
// Avec 24 slots: 24 × 12 = 288 tokens/h (couvre 50% des tokens)
```

**Option C: Filtrage à la détection (optimal)**
```typescript
// ForensicWorker.ts - Skip tokens avec wallet déjà connu RUG
const existingWallet = await walletRepo.getByAddress(creatorWallet);
if (existingWallet && existingWallet.rug_count >= 3) {
  logger.debug({ wallet: creatorWallet }, 'Known rugger - fast verdict RUG_NO_PAIR');
  // Emit RUG immédiatement sans tracking
  return;
}
```

**Recommandation:** Combiner Option B + C
- Tracking 5 min au lieu de 10
- Skip tracking pour known ruggers (≥3 rugs précédents)
- Capacité théorique: ~500-1000 tokens/h

---

## ⚠️  Moyen 1: Error logging incomplet

**Symptôme:**
```json
{
  "address": "8vDVvwfn3uBKdp324HziY4PKedyrrYsUYB57Rw2Ugvnz",
  "error": {}  // ← Vide!
}
```

**Fix:**
```typescript
// HeliusClient.ts ligne 65
-throw new WalletSourceError(ErrorCode.API_REQUEST_FAILED, `Failed...`, { error });
+throw new WalletSourceError(
+  ErrorCode.API_REQUEST_FAILED,
+  `Failed to fetch transactions for ${address}`,
+  {
+    error: error instanceof Error ? error.message : String(error),
+    stack: error instanceof Error ? error.stack : undefined
+  }
+);
```

---

## ⚠️  Moyen 2: Faux positif "No tokens detected in last hour"

**Symptôme:**
```
WARN: ALERT: No tokens detected in the last hour - possible WSS connection issue
```
(Mais 153 tokens détectés durant la session!)

**Cause:**
- Check basé sur DB query qui regarde `detected_at` au lieu de dernière activité WSS
- Tokens re-enqueued déclenchent faux positif

**Fix:**
Améliorer la logique de détection dans ForensicWorker ou désactiver ce warning.

---

## ✅ Confirmés fonctionnels:

1. **Data persistence** - aucune perte après Ctrl+C / restart
2. **Helius limit=50** - txCount jamais > 50
3. **Ancestry deferred to RUG only** - 17 appels Helius pour 12 RUGs
4. **Verdicts corrects** - 91.7% RUG_NO_PAIR, 8.3% RUG_METRICS
5. **Paper trading** - signaux générés

---

## Prochaines étapes:

1. ✅ Fixer Helius concurrency
2. ✅ Réduire tracking à 5 min + skip known ruggers
3. ✅ Améliorer error logging
4. Test 24h avec fixes appliqués
