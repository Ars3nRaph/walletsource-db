# MIGRATION v3.0 → v4.0 — Pivot stratégique "Ride the Rugger"

## Contexte

Le projet WalletSourceDB v3.0 est construit et fonctionnel. La v3.0 identifie les rugeurs et les ÉVITE.
La v4.0 change la philosophie : on identifie les rugeurs et on les EXPLOITE.

Un rugeur a un pattern répétable : il crée un token, le laisse pump X minutes, atteint un peak de Y$, puis dump. Si on a observé ce pattern 5-10 fois, on peut prédire le prochain et :
1. **RIDE (long)** : acheter dès la création, vendre juste avant le peak prédit
2. **FADE (short)** : shorter au peak prédit, fermer après le dump

Ce document décrit **toutes les modifications** fichier par fichier. Chaque section est un prompt autonome pour Claude Code.

---

## Résumé des changements

| Composant | v3.0 (actuel) | v4.0 (cible) |
|-----------|---------------|--------------|
| RugScannerWorker | Check unique à +15 min | **TokenTracker** : polling toutes les 30s pendant 30 min |
| Verdict | Photo à +15 min (RUG/SUCCESS/NEUTRAL) | **Film** : courbe complète prix/liquidité + détection du peak/dump |
| token_events | 9 colonnes | +12 colonnes (peak, timing, dump speed...) |
| wallet_profiles | strategy: AVOID/SHORT/WATCH/LONG | **rugger_playbook** (JSON) + strategy: RIDE/FADE/WATCH/AVOID |
| PExitCalculator | Sortie basée sur MC_profil (prix) | **TradeExecutor** : sortie basée sur le temps (fenêtres temporelles) |
| Stratégies | Éviter les rugeurs | Exploiter leur pattern |
| DexScreener rate limit | 1000 req/h (faux) | **300 req/min** = 18 000/h (correct selon la doc officielle) |
| Nouvelle table | — | **token_snapshots** : historique prix/liquidité toutes les 30s |
| Nouveau worker | — | **PlaybookBuilder** : agrège les snapshots en profil de rugeur |

---

## Prompt 1 — Migration schema SQL

```
Lis ce document en entier avant de commencer.

MIGRATION SCHEMA — Branche feat/v4-schema

1. NOUVELLE TABLE token_snapshots :

CREATE TABLE IF NOT EXISTS token_snapshots (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES token_events(token_address),
  snapshot_at TIMESTAMPTZ NOT NULL,
  fdv REAL,
  liquidity_usd REAL,
  price_usd REAL,
  price_change_5m REAL,
  volume_5m REAL,
  buy_count_5m INTEGER,
  sell_count_5m INTEGER
);
CREATE INDEX idx_snapshots_token ON token_snapshots(token_address, snapshot_at);

Cette table stocke un point de données toutes les 30 secondes pendant les 30 premières minutes de vie d'un token. Soit ~60 lignes par token.

2. ALTER TABLE token_events — ajouter 12 colonnes :

ALTER TABLE token_events ADD COLUMN peak_mc REAL;
ALTER TABLE token_events ADD COLUMN peak_at TIMESTAMPTZ;
ALTER TABLE token_events ADD COLUMN time_to_peak_min REAL;
ALTER TABLE token_events ADD COLUMN time_to_rug_min REAL;
ALTER TABLE token_events ADD COLUMN dump_speed_pct_per_min REAL;
ALTER TABLE token_events ADD COLUMN liquidity_at_peak REAL;
ALTER TABLE token_events ADD COLUMN liquidity_removed REAL;
ALTER TABLE token_events ADD COLUMN buy_volume_before_dump REAL;
ALTER TABLE token_events ADD COLUMN peak_price REAL;
ALTER TABLE token_events ADD COLUMN rug_price REAL;
ALTER TABLE token_events ADD COLUMN tracking_complete BOOLEAN DEFAULT FALSE;
ALTER TABLE token_events ADD COLUMN snapshot_count INTEGER DEFAULT 0;

Le verdict reste inchangé (RUG/SUCCESS/NEUTRAL) mais est maintenant prononcé à la fin du tracking de 30 min au lieu de +15 min.

3. ALTER TABLE wallet_profiles — ajouter le playbook :

ALTER TABLE wallet_profiles ADD COLUMN rugger_playbook JSONB;
ALTER TABLE wallet_profiles ADD COLUMN playbook_confidence REAL DEFAULT 0;
ALTER TABLE wallet_profiles ADD COLUMN playbook_updated_at TIMESTAMPTZ;

Le rugger_playbook est un JSON avec la structure :
{
  "sample_size": 8,
  "avg_time_to_peak_min": 8.5,
  "std_time_to_peak_min": 2.1,
  "avg_peak_mc": 42000,
  "std_peak_mc": 15000,
  "avg_time_to_rug_min": 12.3,
  "std_time_to_rug_min": 3.0,
  "avg_dump_speed": -25.5,
  "avg_liquidity_at_peak": 8500,
  "consistency_score": 0.78,
  "entry_window_end_min": 2.55,
  "exit_window_start_min": 6.8,
  "exit_window_end_min": 8.075,
  "short_window_start_min": 8.075,
  "short_window_end_min": 12.3,
  "recommended_strategy": "RIDE"
}

4. Modifier la colonne strategy pour accepter les nouvelles valeurs :

Les nouvelles stratégies sont : RIDE | FADE | WATCH | AVOID
- RIDE : rugeur prédictible → acheter tôt, vendre avant le peak
- FADE : rugeur prédictible → shorter au peak, fermer après le dump
- WATCH : pas assez de données (< 5 rugs observés) ou pattern trop irrégulier
- AVOID : pattern imprévisible (consistency_score < 0.4) → trop risqué

5. Mettre à jour le DEXSCREENER_RATE_LIMIT dans .env :

Le rate limit réel de DexScreener est 300 req/min (pas 1000 req/h).
Changer DEXSCREENER_RATE_LIMIT=300 et le commenter "par minute".

6. Mettre à jour src/types/index.ts avec les nouvelles interfaces :

interface TokenSnapshot {
  id: number;
  token_address: string;
  snapshot_at: string;
  fdv: number | null;
  liquidity_usd: number | null;
  price_usd: number | null;
  price_change_5m: number | null;
  volume_5m: number | null;
  buy_count_5m: number | null;
  sell_count_5m: number | null;
}

interface RuggerPlaybook {
  sample_size: number;
  avg_time_to_peak_min: number;
  std_time_to_peak_min: number;
  avg_peak_mc: number;
  std_peak_mc: number;
  avg_time_to_rug_min: number;
  std_time_to_rug_min: number;
  avg_dump_speed: number;
  avg_liquidity_at_peak: number;
  consistency_score: number;
  entry_window_end_min: number;
  exit_window_start_min: number;
  exit_window_end_min: number;
  short_window_start_min: number;
  short_window_end_min: number;
  recommended_strategy: 'RIDE' | 'FADE' | 'WATCH' | 'AVOID';
}

Mettre à jour les interfaces existantes TokenEvent et WalletProfile pour inclure les nouveaux champs.

7. Créer src/repositories/SnapshotRepo.ts :

Méthodes :
- insertSnapshot(snapshot: Omit<TokenSnapshot, 'id'>): Promise<TokenSnapshot>
- getByToken(tokenAddress: string): Promise<TokenSnapshot[]>
- getLatestByToken(tokenAddress: string): Promise<TokenSnapshot | null>
- countByToken(tokenAddress: string): Promise<number>

8. Écrire les tests pour les nouvelles tables et le SnapshotRepo.

Critère : npm run type-check && npm test → 0 erreurs.
```

---

## Prompt 2 — TokenTracker (remplace RugScannerWorker)

```
MIGRATION WORKER — Branche feat/v4-tracker

Le RugScannerWorker actuel fait UN appel DexScreener à +15 min puis prononce un verdict. On le remplace par un TokenTracker qui fait du polling continu.

1. Renommer src/workers/RugScannerWorker.ts → src/workers/TokenTracker.ts

2. Nouvelle logique du TokenTracker :

Quand un token entre dans monitoring_queue (status = PENDING) :
  a. Le TokenTracker commence à le poller toutes les 30 secondes
  b. À chaque poll : appeler DexScreenerClient.getToken(tokenAddress)
  c. Stocker le résultat dans token_snapshots via SnapshotRepo.insertSnapshot()
  d. Continuer pendant 30 minutes (soit ~60 snapshots)
  e. À la fin des 30 minutes : analyser les snapshots et prononcer le verdict

3. Analyse des snapshots (méthode analyzeTokenLifecycle) :

Prend un tableau de TokenSnapshot[] et calcule :

  peak_mc = MAX(fdv) de tous les snapshots
  peak_at = snapshot_at du snapshot avec le fdv max
  peak_price = MAX(price_usd)
  time_to_peak_min = (peak_at - detected_at) / 60000

  Pour le dump : chercher le premier snapshot après peak_at où :
    - fdv chute de > 50% par rapport au peak, OU
    - liquidity_usd chute de > 60% par rapport à liquidity_at_peak
  Si trouvé :
    rug_price = price_usd à ce moment
    time_to_rug_min = (rug_timestamp - detected_at) / 60000
    dump_speed_pct_per_min = ((rug_price - peak_price) / peak_price * 100) / (time_to_rug_min - time_to_peak_min)
    liquidity_removed = liquidity_at_peak - liquidity_at_rug

  buy_volume_before_dump = SUM(volume_5m) des snapshots avant le peak

  Verdict :
    - Si peak_mc < 5000 ET liquidity jamais > 2000 → RUG (No Pair / pas de marché)
    - Si dump détecté (chute > 50% après peak) → RUG (Metrics)
    - Si fdv > 30000 ET liquidity > 5000 ET pas de dump → SUCCESS
    - Sinon → NEUTRAL

4. Capacité de tracking simultané :

DexScreener permet 300 req/min. Chaque token consomme 2 req/min (1 toutes les 30s).
Capacité max = 300 / 2 = 150 tokens trackés simultanément.
Si > 150 tokens en queue : prioriser les tokens dont le creator_wallet a un playbook existant (rugeur connu).

Mettre à jour le RateLimiter pour utiliser 300 req/min au lieu de 1000 req/h :
  new RateLimiter(300, 60 * 1000)  // 300 par fenêtre de 60 secondes

5. Connecter au pipeline existant :

Après le verdict :
  - Mettre à jour token_events avec toutes les nouvelles colonnes
  - Si RUG : appeler TaintScorer.propagate() (inchangé)
  - Appeler SigmoidScorer pour recalculer les scores du wallet (inchangé)
  - Appeler PlaybookBuilder.updatePlaybook(creatorWallet) (nouveau, voir Prompt 3)
  - MonitoringRepo.markProcessed()

6. Écrire les tests :

- Mock DexScreenerClient pour retourner une séquence de 60 snapshots simulant :
  a. Un pump puis dump (RUG) : prix monte pendant 8 min, peak à 45K, dump à -80% en 2 min
  b. Un token stable (SUCCESS) : prix monte et se maintient > 30K pendant 30 min
  c. Un token mort-né (RUG No Pair) : tous les snapshots avec fdv null ou < 1000
- Vérifier que peak_mc, time_to_peak_min, dump_speed sont calculés correctement
- Vérifier que les 60 snapshots sont bien dans token_snapshots

Critère : npm run type-check && npm test -- tests/workers/TokenTracker → tout vert.
```

---

## Prompt 3 — PlaybookBuilder (nouveau worker)

```
NOUVEAU WORKER — Branche feat/v4-playbook

Créer src/workers/PlaybookBuilder.ts

Ce worker agrège les données de token_events d'un wallet pour construire son rugger_playbook. Il est appelé après chaque nouveau verdict RUG d'un wallet.

1. Méthode principale : updatePlaybook(walletAddress: string)

  a. Récupérer tous les token_events du wallet WHERE verdict = 'RUG' AND tracking_complete = TRUE
  b. Si moins de 5 rugs : playbook = null, strategy = WATCH, return
  c. Calculer les moyennes et écarts-types :

     const rugs = tokenEvents.filter(t => t.verdict === 'RUG' && t.tracking_complete);

     avg_time_to_peak_min = mean(rugs.map(r => r.time_to_peak_min))
     std_time_to_peak_min = stddev(rugs.map(r => r.time_to_peak_min))

     avg_peak_mc = mean(rugs.map(r => r.peak_mc))
     std_peak_mc = stddev(rugs.map(r => r.peak_mc))

     avg_time_to_rug_min = mean(rugs.map(r => r.time_to_rug_min))
     std_time_to_rug_min = stddev(rugs.map(r => r.time_to_rug_min))

     avg_dump_speed = mean(rugs.map(r => r.dump_speed_pct_per_min))
     avg_liquidity_at_peak = mean(rugs.map(r => r.liquidity_at_peak))

  d. Calculer le consistency_score :
     Le CV (coefficient de variation) du time_to_peak :
     cv = std_time_to_peak_min / avg_time_to_peak_min
     consistency_score = 1 - Math.min(cv, 1)  // 1 = parfaitement régulier, 0 = chaotique

  e. Calculer les fenêtres temporelles :
     entry_window_end_min = avg_time_to_peak_min * 0.30
       → Acheter dans les premiers 30% du temps avant le peak
       → Ex: si peak à 8.5 min, acheter avant 2.55 min

     exit_window_start_min = avg_time_to_peak_min * 0.80
       → Commencer à vendre à 80% du temps avant le peak
       → Ex: vendre à partir de 6.8 min

     exit_window_end_min = avg_time_to_peak_min * 0.95
       → Avoir tout vendu à 95% du peak
       → Ex: tout vendu avant 8.075 min

     short_window_start_min = exit_window_end_min
       → Ouvrir le short quand on finit de vendre le long
       → Ex: shorter à partir de 8.075 min

     short_window_end_min = avg_time_to_rug_min
       → Fermer le short quand le rug est normalement terminé
       → Ex: fermer à 12.3 min

  f. Déterminer la stratégie recommandée :
     Si consistency_score >= 0.6 ET avg_peak_mc > 10000 ET sample_size >= 5 :
       → RIDE (le long est rentable et prédictible)
     Si consistency_score >= 0.5 ET avg_dump_speed < -15 :
       → FADE (le dump est assez violent pour shorter)
     Si consistency_score < 0.4 :
       → AVOID (trop imprévisible)
     Sinon :
       → WATCH (attendre plus de données)

  g. Calculer playbook_confidence :
     playbook_confidence = consistency_score * Math.min(1, sample_size / 10)
     → Confiance pleine à 10+ samples avec haute cohérence

  h. Persister via WalletRepo :
     UPDATE wallet_profiles SET
       rugger_playbook = playbook_json,
       playbook_confidence = confidence,
       playbook_updated_at = NOW(),
       strategy = recommended_strategy
     WHERE wallet_address = walletAddress

2. Méthodes utilitaires (fonctions pures) :

  mean(values: number[]): number
  stddev(values: number[]): number
  computeConsistency(values: number[]): number
  computeWindows(avgPeak: number, avgRug: number): TimeWindows

3. Tests :

Créer tests/workers/PlaybookBuilder.test.ts :

  a. Injecter 8 token_events RUG pour un même wallet avec :
     time_to_peak_min : [7, 8, 9, 8.5, 7.5, 9, 8, 8.5] (avg=8.19, std=0.69, CV=0.084)
     peak_mc : [40000, 45000, 38000, 42000, 44000, 41000, 43000, 39000]
     time_to_rug_min : [11, 13, 12, 12.5, 11.5, 13, 12, 12.5]
     Attendu : consistency_score ≈ 0.92, strategy = RIDE

  b. Injecter 6 token_events RUG avec des timings chaotiques :
     time_to_peak_min : [2, 15, 5, 20, 3, 18]
     Attendu : consistency_score < 0.4, strategy = AVOID

  c. Injecter seulement 3 token_events RUG :
     Attendu : playbook = null, strategy = WATCH

  d. Vérifier les fenêtres temporelles du test (a) :
     entry_window_end = 8.19 * 0.30 ≈ 2.46 min
     exit_window_start = 8.19 * 0.80 ≈ 6.55 min
     exit_window_end = 8.19 * 0.95 ≈ 7.78 min

Critère : npm test -- tests/workers/PlaybookBuilder → tout vert.
```

---

## Prompt 4 — TradeExecutor (remplace PExitCalculator)

```
MIGRATION SCORING — Branche feat/v4-executor

Le PExitCalculator actuel calcule un prix de sortie basé sur le market cap.
Le TradeExecutor v4 calcule des FENÊTRES TEMPORELLES basées sur le playbook du rugeur.

1. Renommer src/scoring/PExitCalculator.ts → src/scoring/TradeExecutor.ts

2. Nouvelles méthodes :

  shouldEnterLong(wallet: WalletProfile, tokenDetectedAt: Date): TradeSignal | null

    - Si wallet.strategy !== 'RIDE' → return null
    - Si wallet.rugger_playbook === null → return null
    - Si playbook_confidence < 0.5 → return null
    - Calculer le temps écoulé depuis detected_at
    - Si temps < entry_window_end_min → return { action: 'BUY', confidence: playbook_confidence, reason: 'RIDE entry window' }
    - Sinon → return null (trop tard pour entrer)

  shouldExitLong(wallet: WalletProfile, tokenDetectedAt: Date): TradeSignal | null

    - Calculer le temps écoulé depuis detected_at
    - playbook = wallet.rugger_playbook
    - Si temps >= exit_window_start_min ET temps < exit_window_end_min :
        sellPct = (temps - exit_window_start_min) / (exit_window_end_min - exit_window_start_min) * 100
        → Vente progressive : 0% au début de la fenêtre, 100% à la fin
        return { action: 'SELL', pct: sellPct, reason: 'RIDE exit window' }
    - Si temps >= exit_window_end_min :
        return { action: 'SELL', pct: 100, reason: 'RIDE exit deadline' }
    - Sinon → return null

  shouldEnterShort(wallet: WalletProfile, tokenDetectedAt: Date): TradeSignal | null

    - Si wallet.strategy !== 'FADE' ET wallet.strategy !== 'RIDE' → return null
    - Calculer le temps écoulé
    - Si temps >= short_window_start_min ET temps < short_window_end_min :
        return { action: 'SHORT', confidence: playbook_confidence, reason: 'FADE short window' }
    - Sinon → return null

  shouldExitShort(wallet: WalletProfile, tokenDetectedAt: Date, currentPrice: number, entryPrice: number): TradeSignal | null

    - Si temps >= short_window_end_min :
        return { action: 'COVER', reason: 'FADE window closed' }
    - Si (entryPrice - currentPrice) / entryPrice > 0.5 :
        return { action: 'COVER', reason: 'Target -50% reached' }
    - Sinon → return null

3. Interface TradeSignal :

interface TradeSignal {
  action: 'BUY' | 'SELL' | 'SHORT' | 'COVER';
  pct?: number;         // Pourcentage de la position (pour vente progressive)
  confidence: number;   // Confiance du playbook [0-1]
  reason: string;       // Explication lisible
}

4. Boucle principale :

Le TradeExecutor tourne toutes les 5 secondes (au lieu de 10s).
Pour chaque token en cours de tracking (monitoring_queue status = PROCESSING) :
  - Récupérer le wallet_profiles du creator
  - Si strategy = RIDE : vérifier shouldEnterLong puis shouldExitLong
  - Si strategy = FADE : vérifier shouldEnterShort puis shouldExitShort
  - Logger chaque signal émis

NOTE : le TradeExecutor n'exécute PAS les trades lui-même. Il émet des TradeSignal que le bot de trading (hors scope de ce projet) consommera. Le TradeExecutor est un moteur de signaux.

5. Conserver PExitCalculator en parallèle :

Ne PAS supprimer PExitCalculator. Le garder comme fallback pour les wallets NON-rugeurs (strategy = WATCH avec survival_count > 0). Les wallets légitimes utilisent toujours l'ancien P_exit basé sur le market cap.

6. Tests :

  a. RIDE complet : wallet avec playbook (avg_peak=8 min, avg_rug=12 min), token créé à T0
     - T0 + 1 min → shouldEnterLong = BUY ✓
     - T0 + 3 min → shouldEnterLong = null (trop tard, > entry_window_end)
     - T0 + 6.5 min → shouldExitLong = SELL ~30%
     - T0 + 7.5 min → shouldExitLong = SELL ~90%
     - T0 + 8 min → shouldExitLong = SELL 100%

  b. FADE complet : même wallet
     - T0 + 8 min → shouldEnterShort = SHORT ✓
     - T0 + 12 min → shouldExitShort = COVER (window closed)

  c. AVOID : wallet avec consistency < 0.4
     - Tous les signaux = null

  d. WATCH : wallet avec < 5 rugs
     - Tous les signaux = null

Critère : npm test -- tests/scoring/TradeExecutor → tout vert.
```

---

## Prompt 5 — Mise à jour des composants existants

```
MISE À JOUR COMPOSANTS EXISTANTS — Branche feat/v4-integration

1. ForensicWorker.ts — Aucun changement de logique.
   Juste mettre à jour le commentaire : check_at passe de +15 min à +30 min
   (le TokenTracker track pendant 30 min, pas 15)
   Changer : check_at = new Date(Date.now() + 30 * 60 * 1000)

2. src/scoring/SigmoidScorer.ts — Mettre à jour getStrategy() :

   Anciennes valeurs : 'LONG' | 'WATCH' | 'SHORT' | 'AVOID'
   Nouvelles valeurs : 'RIDE' | 'FADE' | 'WATCH' | 'AVOID'

   Mais la logique change : la strategy n'est plus déterminée par le risk_score seul.
   Le SigmoidScorer calcule toujours risk_score et toxicity_score (inchangé).
   Mais la strategy finale est déterminée par le PlaybookBuilder :
   - Si playbook existe ET consistency >= 0.6 → RIDE
   - Si playbook existe ET consistency >= 0.5 ET dump violent → FADE
   - Si playbook existe ET consistency < 0.4 → AVOID
   - Si pas de playbook → utiliser risk_score comme avant mais mapper sur WATCH/AVOID :
     risk_score < 0.75 → WATCH
     risk_score >= 0.75 → AVOID

   Renommer la méthode : getStrategy() → getLegacyStrategy() (pour les wallets sans playbook)

3. src/index.ts — Mettre à jour l'orchestration :

   Ajouter l'import et le démarrage de :
   - TokenTracker (remplace RugScannerWorker)
   - PlaybookBuilder
   - TradeExecutor

   Retirer l'import de RugScannerWorker.

4. src/utils/rateLimiter.ts — Mettre à jour les paramètres :

   Changer : new RateLimiter(300, 60 * 1000)  // 300 req par minute (DexScreener réel)

5. CLAUDE.md — Mettre à jour :

   - Stack : ajouter "token_snapshots" à la liste des tables (8 tables au total)
   - Workers : RugScannerWorker → TokenTracker, ajouter PlaybookBuilder
   - Scoring : PExitCalculator → TradeExecutor (+ PExitCalculator en fallback)
   - Strategies : LONG/SHORT → RIDE/FADE
   - Rate limit : 300 req/min (pas 1000 req/h)
   - Ajouter la section rugger_playbook dans les formules
   - Ajouter les fenêtres temporelles (entry/exit/short)

6. Mettre à jour les tests existants qui référencent les anciennes stratégies :

   Chercher tous les 'LONG' et 'SHORT' dans tests/ et les remplacer par 'RIDE' et 'FADE' là où c'est pertinent. Attention : les tests de SigmoidScorer doivent toujours tester les seuils de risk_score, mais le mapping final passe par le playbook.

7. Validation globale :

   npm run type-check → 0 erreurs
   npm run lint → 0 warnings
   npm test → 100% des tests passent

   Vérifier spécifiquement :
   - token_snapshots se remplit correctement (60 snapshots par token)
   - Le playbook se calcule après 5 rugs
   - Le TradeExecutor émet des signaux aux bons moments
   - Le pipeline complet fonctionne : ForensicWorker → TokenTracker → TaintScorer → PlaybookBuilder → TradeExecutor
```

---

## Prompt 6 — Tests d'intégration end-to-end

```
TESTS E2E — Branche feat/v4-e2e

Créer tests/e2e/pipeline.test.ts qui simule le pipeline complet :

SCÉNARIO 1 — Construction du playbook d'un rugeur

  1. Simuler le ForensicWorker : injecter 8 tokens créés par le wallet "RUGGER_A"
  2. Pour chaque token, simuler le TokenTracker avec des snapshots :
     Token 1 : peak à 7 min (42K), dump à 11 min
     Token 2 : peak à 8.5 min (45K), dump à 13 min
     Token 3 : peak à 8 min (40K), dump à 12 min
     Token 4 : peak à 9 min (44K), dump à 12.5 min
     Token 5 : peak à 7.5 min (38K), dump à 11.5 min
     Token 6 : peak à 8 min (41K), dump à 12 min
     Token 7 : peak à 8.5 min (43K), dump à 13 min
     Token 8 : peak à 9 min (39K), dump à 12.5 min
  3. Après les 5 premiers rugs, vérifier que le PlaybookBuilder a créé un playbook
  4. Vérifier que strategy = RIDE
  5. Vérifier que avg_time_to_peak ≈ 8.19 min

SCÉNARIO 2 — Exploitation du 9ème token du rugeur

  1. RUGGER_A crée un 9ème token à T0
  2. T0 + 30s : TradeExecutor.shouldEnterLong() → BUY ✓
  3. T0 + 3 min : TradeExecutor.shouldEnterLong() → null (trop tard)
  4. T0 + 6.5 min : TradeExecutor.shouldExitLong() → SELL ~30%
  5. T0 + 7.8 min : TradeExecutor.shouldExitLong() → SELL 100%
  6. T0 + 8.1 min : TradeExecutor.shouldEnterShort() → SHORT ✓
  7. T0 + 12.3 min : TradeExecutor.shouldExitShort() → COVER ✓

SCÉNARIO 3 — Wallet non-rugeur (fallback P_exit)

  1. Injecter un wallet "LEGIT_B" avec 5 tokens SUCCESS (fdv > 30K)
  2. Vérifier que strategy = WATCH (pas de playbook car pas assez de rugs)
  3. Vérifier que PExitCalculator fonctionne toujours pour ce wallet

SCÉNARIO 4 — Rugeur imprévisible

  1. Injecter un wallet "CHAOS_C" avec 6 rugs aux timings chaotiques
  2. Vérifier consistency_score < 0.4
  3. Vérifier strategy = AVOID
  4. Vérifier que TradeExecutor ne produit aucun signal

Critère : npm test -- tests/e2e/ → tout vert, les 4 scénarios passent.
```

---

## Ordre d'exécution

| Session | Prompt | Branche | Ce qui est créé/modifié |
|---------|--------|---------|------------------------|
| 1 | Prompt 1 | feat/v4-schema | token_snapshots, ALTER TABLE × 2, SnapshotRepo, types |
| 2 | Prompt 2 | feat/v4-tracker | TokenTracker (remplace RugScannerWorker) |
| 3 | Prompt 3 | feat/v4-playbook | PlaybookBuilder (nouveau) |
| 4 | Prompt 4 | feat/v4-executor | TradeExecutor (remplace PExitCalculator) |
| 5 | Prompt 5 | feat/v4-integration | Mise à jour de tous les composants existants |
| 6 | Prompt 6 | feat/v4-e2e | Tests d'intégration end-to-end |

**Une session = un prompt. Merger chaque branche dans main après validation.**
