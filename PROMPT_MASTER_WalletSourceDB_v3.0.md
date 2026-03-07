# Prompt Master — WalletSourceDB v3.0

## Mode d'emploi

Ce fichier contient **tout** pour construire le projet avec Claude Code dans VS Code :

1. **Pré-requis** → ce qu'il faut installer avant de commencer
2. **Prompt d'initialisation** → Phase 1, à coller en mode Plan
3. **Prompts par phase** → un par session, dans l'ordre (P2 → P8)
4. **Prompt de validation globale** → session finale
5. **Notes d'utilisation** → bonnes pratiques

> Le fichier `CLAUDE.md` est déjà créé séparément — le copier à la racine du projet.
> Le fichier `PRD_WalletSourceDB_v3.0.md` doit aussi être à la racine.

---

## 0. Pré-requis (à faire une seule fois)

```bash
# 1. Installer Claude Code CLI
npm install -g @anthropic-ai/claude-code

# 2. S'authentifier
claude

# 3. Créer le dossier projet
mkdir walletsource-db && cd walletsource-db
git init

# 4. Copier les fichiers de contexte à la racine
# → CLAUDE.md (mémoire persistante de Claude Code)
# → PRD_WalletSourceDB_v3.0.md (spécification complète)

# 5. Lancer PostgreSQL
docker-compose up -d
# (docker-compose.yml fourni dans le PRD Annexe D.7)

# 6. Ouvrir VS Code
code .
```

---

## 1. Prompt d'initialisation — Phase 1 Schema & Repos

> **Mode Claude Code** : Plan → valider le plan → Normal

```
Lis le fichier PRD_WalletSourceDB_v3.0.md à la racine. C'est le PRD complet.

Exécute la Phase 1 — Schema & Repos sur la branche feat/schema :

1. Crée l'arborescence complète du projet (section 13.3 du PRD) :
   src/db/, src/repositories/, src/workers/, src/scoring/, src/cartels/, src/api/, src/types/, src/utils/, tests/ (miroir)

2. Initialise le projet :
   - package.json avec tous les scripts (build, start, start:dev, test, test:watch, test:coverage, lint, lint:fix, type-check)
   - tsconfig.json strict mode (target ES2022, module NodeNext, moduleResolution NodeNext, outDir dist, rootDir src)
   - .env avec les variables de la section 13.5 du PRD
   - .gitignore (node_modules, dist, data/, .env)

3. Installe les dépendances :
   Prod : pg (node-postgres), ws, dotenv, node-fetch, pino, pino-pretty
   Dev : typescript, @types/node, @types/pg (node-postgres), @types/ws, vitest, eslint, @typescript-eslint/eslint-plugin, @typescript-eslint/parser, prettier

4. Crée src/db/schema.sql — 7 CREATE TABLE :
   - wallet_profiles (section 4.1 du PRD + champs v3 : toxicity_score, risk_score)
   - wallet_ancestry (section 4.2)
   - token_events (section 4.3 + champs v3 : p_exit_v1, p_exit_v2)
   - cartel_groups (section 4.4 + champ v3 : confidence_score_v2)
   - taint_log (section 4.5)
   - monitoring_queue (Annexe B du PRD — avec l'index sur check_at)
   - calibration_log (section 8.6 du PRD)

5. Crée src/db/connection.ts — pool PostgreSQL : ouvre DATABASE_URL, exécute schema.sql au premier appel, expose getDb()

6. Crée src/types/index.ts — interfaces TypeScript pour les 7 tables + types DexScreenerResponse, HeliusTransaction (Annexe A du PRD)

7. Crée src/types/errors.ts — classe WalletSourceError + enum ErrorCode (Annexe C.1 du PRD)

8. Crée src/utils/logger.ts — logger pino avec pino-pretty (Annexe C.2 du PRD)

9. Crée src/utils/rateLimiter.ts — classe RateLimiter singleton (fenêtre glissante 1h, max 1000 req) partagée entre workers (voir Annexe D.4 du PRD)

10. Crée les 6 Repositories dans src/repositories/ avec les méthodes décrites en section 11 du PRD :
   - WalletRepo : upsertWallet(), getByAddress(), updateStrategy(), getByCartel(), incrementRug(), incrementSurvival()
   - AncestryRepo : addLink(), getAncestors(depth), getDescendants(), getChain()
   - TokenEventRepo : recordEvent(), getByCreator(), getMedianFDV(verdict)
   - CartelRepo : upsertCartel(), detectCartels(), computeConfidence(), getMembers()
   - TaintLogRepo : logTaint(), getHistory(wallet), getTotalByWallet()
   - MonitoringRepo : enqueue(), getDueTokens(), markProcessed(), reEnqueue()

10. Crée les tests unitaires dans tests/repositories/ — un fichier par repo, pattern Annexe C.3 :
    - beforeEach : // Utiliser pg-mem pour les tests in-memory
import { newDb } from 'pg-mem';
const db = newDb().adapters.createPg();, charger schema.sql, instancier le repo
    - Tester insert, get, update, delete pour chaque repo
    - Tester getMedianFDV avec 5 tokens (3 SUCCESS, 2 RUG) — vérifier que la médiane est correcte
    - Tester getDueTokens avec des tokens à différents check_at

Critère de validation : exécuter `npm run type-check && npm test` — 0 erreurs TypeScript, tous les tests passent.
Commite après chaque étape réussie avec un message descriptif.
```

---

## 2. Phase 2 — Verdict Pipeline

> **Branche** : feat/verdict | **Mode** : Normal

```
Phase 2 — Verdict Pipeline, branche feat/verdict. Lis la section 3 et l'Annexe A du PRD.

1. src/api/DexScreenerClient.ts :
   - GET https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}
   - Interface DexScreenerResponse avec pairs: DexScreenerPair[] | null (déjà dans types/index.ts)
   - Mapping : pairs[0].fdv → fdv_at_check, pairs[0].liquidity.usd → liquidity_at_check, pairs[0].priceChange.m5 → price_change_5m, pairs[0].pairAddress → dexscreener_pair
   - pairs === null → signifie RUG_NO_PAIR
   - Délai 300ms entre chaque appel (await sleep(300))
   - Retry 3x avec backoff exponentiel (1s, 2s, 4s) sur erreur réseau
   - Compteur global : max 1000 req/h avec fenêtre glissante

2. src/workers/ForensicWorker.ts :
   - Se connecte au Helius Enhanced WebSocket via l'URL de .env (SOLANA_WSS_URL = wss://atlas-mainnet.helius-rpc.com?api-key={key})
   - Subscription : transactionSubscribe avec accountInclude: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]
   - Commitment: confirmed, encoding: jsonParsed 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
   - Pour chaque notification : vérifier que les logs contiennent "Program log: Instruction: Create"
   - Si oui : accountKeys[0] = creator_wallet, accountKeys[1] = token_mint (voir Annexe D.1 du PRD pour le code complet)
   - Enqueue dans monitoring_queue via MonitoringRepo.enqueue() avec check_at = now + 15 minutes
   - Si le creator_wallet est nouveau : créer l'entrée wallet_profiles avec strategy = WATCH
   - Reconnexion automatique si WSS se déconnecte (backoff exponentiel)
   - Logger chaque détection : logger.info({ token, wallet }, 'Token detected')

3. src/workers/RugScannerWorker.ts :
   - Boucle toutes les 60 secondes (setInterval)
   - Récupère les tokens PENDING dont check_at < now via MonitoringRepo.getDueTokens()
   - Pour chaque token (avec 300ms de pause entre chaque) :
     a. Appeler DexScreenerClient.getToken(tokenAddress)
     b. Appliquer la matrice de verdict (section 3 du PRD) :
        - pairs === null → RUG_NO_PAIR
        - liquidity.usd < 2000 OU priceChange.m5 < -75 → RUG_METRICS
        - fdv > 30000 ET liquidity.usd > 5000 → SUCCESS
        - sinon → NEUTRAL
     c. Enregistrer dans token_events via TokenEventRepo.recordEvent()
     d. Mettre à jour wallet_profiles : incrementRug() ou incrementSurvival() ou incrementNeutral()
     e. Si verdict = RUG : appeler TaintScorer.propagate() (sera implémenté en P3, mettre un TODO)
     f. MonitoringRepo.markProcessed(tokenId)
   - Si rate limit atteint (> 1000 req/h) : MonitoringRepo.reEnqueue(tokenId, check_at + 5min)

4. Tests dans tests/workers/ :
   - Mock DexScreenerClient pour retourner les 4 cas de verdict
   - Test ForensicWorker : simuler une notification WSS → vérifier que monitoring_queue contient le token
   - Test RugScannerWorker : injecter 4 tokens avec 4 réponses DexScreener différentes → vérifier les 4 verdicts dans token_events + compteurs wallet_profiles mis à jour
   - Test rate limiting : simuler 1001 requêtes → vérifier le re-enqueue

Critère : `npm run type-check && npm test -- tests/workers/ tests/repositories/` → tout vert.
```

---

## 3. Phase 3 — Taint Propagation

> **Branche** : feat/taint | **Mode** : Normal

```
Phase 3 — Taint Propagation, branche feat/taint. Lis la section 5 du PRD.

Implémente src/scoring/TaintScorer.ts :

- Méthode principale : propagate(tokenAddress: string, creatorWallet: string, reason: 'RUG_NO_PAIR' | 'RUG_METRICS')
- Formule : Taint(depth) = 50 × 0.7^depth
  - depth 0 = +50.0 pts (créateur direct)
  - depth 1 = +35.0 pts (funder)
  - depth 2 = +24.5 pts (funder du funder)
  - depth 3 = +17.15 pts (max)
- Algorithme :
  1. Appliquer +50 pts au creatorWallet (depth 0)
  2. Récupérer les ancestors via AncestryRepo.getAncestors(creatorWallet, maxDepth=3)
  3. Pour chaque ancestor : si confidence >= 0.7, appliquer Taint(depth)
  4. Si confidence < 0.7, ignorer ce lien (ne pas propager plus loin)
  5. Pour chaque application : TaintLogRepo.logTaint(wallet, tokenAddress, points, depth, reason)
  6. Pour chaque wallet touché : WalletRepo.updateTaintScore(wallet, newTotal)
- La cascade complète doit s'exécuter en < 200ms
- Decay hebdomadaire : taint_score *= 0.95 pour les wallets sans activité depuis > 7 jours (intégré au CalibrationWorker ou cron séparé)
- Connecter au RugScannerWorker : remplacer le TODO de P2 par l'appel réel à TaintScorer.propagate()

Tests dans tests/scoring/TaintScorer.test.ts :
- Créer un arbre de 4 wallets : A funds B funds C funds D. C crée un token rug.
  - D (depth 0) = +50.0 pts
  - C (depth 1) = +35.0 pts (si confidence >= 0.7)
  - B (depth 2) = +24.5 pts
  - A (depth 3) = +17.15 pts
  Attendu : total taint_log = 126.65 pts
- Test avec un lien confidence = 0.5 au depth 1 → la propagation s'arrête, B et A ne reçoivent rien
- Test avec 2 rugs successifs du même creator → taint_score = 100 pts (2 × 50)
- Vérifier que la somme de taint_log.points_applied par wallet == wallet_profiles.taint_score

Critère : `npm test -- tests/scoring/TaintScorer` → tout vert. Cascade < 200ms.
```

---

## 4. Phase 4-5 — Profil Sigmoïde + Cartels

> **Branche** : feat/profil-cartels | **Mode** : Normal

```
Phase 4-5 — Profil Sigmoïde + Détection Cartels, branche feat/profil-cartels. Lis les sections 7, 6 et 10 du PRD.

PARTIE 1 — src/scoring/SigmoidScorer.ts :

Fonctions pures (pas d'état, pas de DB — prennent des valeurs et retournent un résultat) :

- sigmoid(x: number, k: number = 1): number → 1 / (1 + Math.exp(-k * x))

- computeToxicity(taintScore: number): number
  → sigmoid((taintScore - 100) / 40)
  Ex: taint=0 → 0.076, taint=100 → 0.500, taint=200 → 0.924

- computeCartelConfidenceV2(survivalRate: number, totalTokens: number): number
  → sigmoid(6.0 × (survivalRate - 0.5)) × Math.min(1, totalTokens / 10)

- computeRiskScore(rugRate: number, toxicityScore: number, cartelRugRate: number): number
  → 0.40 × sigmoid(6 × (rugRate - 0.5), 1) + 0.35 × toxicityScore + 0.25 × sigmoid(5 × (cartelRugRate - 0.5), 1)

- getStrategy(riskScore: number): 'LONG' | 'WATCH' | 'SHORT' | 'AVOID'
  → [0-0.25]=LONG, [0.25-0.50]=WATCH, [0.50-0.75]=SHORT, [0.75-1]=AVOID

- computeProfileVector(wallet: WalletProfile, cartel?: CartelGroup): ProfileVector
  → 7 features avec poids : rug_rate ×3.0, taint_score ×2.0, avg_token_lifespan ×1.0, cartel_rug_rate ×2.5, ancestry_depth ×0.5, funding_diversity ×1.0, token_frequency ×1.5

Après chaque verdict, appeler SigmoidScorer pour recalculer toxicity_score, risk_score, strategy du wallet et persister via WalletRepo.

PARTIE 2 — src/cartels/CartelDetector.ts :

- Méthode detectCartels() — exécutée en batch toutes les 5 minutes
- 3 critères de détection (section 10.1 du PRD) :
  1. Funding commun : ≥ 3 wallets financés par la même source (requête wallet_ancestry GROUP BY parent_wallet HAVING COUNT >= 3)
  2. Activité temporelle : tokens lancés dans une fenêtre de ± 5 minutes (requête token_events avec corrélation timestamps)
  3. Overlap comportemental : similarité cosinus > 0.85 entre les profile_vectors des wallets (formule dans Annexe D.5 du PRD)
- Pour chaque cartel détecté :
  - Créer/mettre à jour cartel_groups via CartelRepo.upsertCartel()
  - Calculer confidence_score = total_survival / (total_survival + total_rug) × consistency_factor (CV = écart-type / moyenne des rug_rates individuels, mappé sur [0.8-1.2] : CV bas = bonus élevé)
  - Calculer confidence_score_v2 via SigmoidScorer.computeCartelConfidenceV2()
  - Assigner auto_strategy via SigmoidScorer.getStrategy() sur le risk_score moyen du cartel
  - Mettre à jour cartel_id dans wallet_profiles pour chaque membre

Tests :
- SigmoidScorer : tester chaque fonction avec les valeurs du tableau section 7.2 du PRD (taint=0→0.076, taint=50→0.224, taint=100→0.500, taint=200→0.924)
- SigmoidScorer : risk_score AVOID pour rug_rate=0.9, LONG pour rug_rate=0.1
- CartelDetector : créer 6 wallets dont 3 financés par le même parent → détecter 1 cartel
- CartelDetector : créer 4 wallets qui lancent des tokens à ±3 min d'intervalle → détecter 1 cartel
- Vérifier que confidence_score_v2 < confidence_score pour un cartel avec peu de tokens (< N_min)

Critère : `npm test -- tests/scoring/SigmoidScorer tests/cartels/` → tout vert.
```

---

## 5. Phase 6 — P_exit

> **Branche** : feat/pexit | **Mode** : Normal

```
Phase 6 — Formule P_exit, branche feat/pexit. Lis les sections 9 et 7.3 du PRD.

Implémente src/scoring/PExitCalculator.ts :

- getMedianMC(creatorWallet: string): number
  → Via TokenEventRepo.getMedianFDV('SUCCESS', creatorWallet)
  → Retourne la médiane des fdv_at_check des tokens SUCCESS du créateur
  → Si aucun SUCCESS : retourne 0 (pas de calcul P_exit possible)

- computePExitV1(mcActuel: number, mcProfil: number, confianceCartel: number): number
  → (mcActuel / mcProfil) × confianceCartel

- computePExitV2(mcActuel: number, mcProfil: number, confianceCartelV2: number): number
  → sigmoid(3.0 × (mcActuel / mcProfil - 1)) × confianceCartelV2

- getExitAction(pExit: number): { action: string, sellPct: number }
  V1 zones : ≥1.5 → EXIT IMMÉDIAT (sell 100%), 1.0-1.49 → EXIT PROGRESSIF (sell 50% + trailing), 0.5-0.99 → HOLD (sell 0%), <0.5 → WATCH (stop-loss serré)
  V2 zones : pourcentage de vente continu = pExitV2 × 100 (capped à 100%)

- Recalcul toutes les 10 secondes pour les positions ouvertes (setInterval)
- Persister p_exit_v1 et p_exit_v2 dans token_events

Tests :
- Exemple PRD : MC_profil=50000, MC_actuel=65000, confidence=0.85 → P_exit_v1 = (65000/50000) × 0.85 = 1.105 → EXIT PROGRESSIF
- P_exit_v2 avec les mêmes valeurs : sigmoid(3 × (1.3 - 1)) × 0.85 = sigmoid(0.9) × 0.85 = 0.711 × 0.85 = 0.604
- Tester que getMedianMC retourne 0 si aucun token SUCCESS
- Tester le recalcul < 10ms (performance benchmark)

Critère : `npm test -- tests/scoring/PExitCalculator` → tout vert. Calcul < 10ms.
```

---

## 6. Phase 7 — Collecte Live & Entry Point

> **Branche** : feat/live | **Mode** : Normal

```
Phase 7 — Collecte Live & Entry Point, branche feat/live. Lis la section 8 du PRD.

1. src/index.ts — Point d'entrée principal qui orchestre tous les workers :
   - Initialiser la connexion DB (connection.ts)
   - Démarrer ForensicWorker (détection WSS)
   - Démarrer RugScannerWorker (verdict toutes les 60s)
   - Démarrer CartelDetector (batch toutes les 5 min)
   - Démarrer PExitCalculator (recalcul toutes les 10s)
   - Graceful shutdown sur SIGINT/SIGTERM : fermer WSS, arrêter les intervals, fermer la DB
   - Logger le démarrage et l'arrêt

2. src/api/HeliusClient.ts — Client pour l'API Helius (section A.2 du PRD) :
   - getWalletTransactions(address: string): Promise<HeliusTransaction[]>
   - Rate limit : ~5 credits par appel, tracker le budget mensuel
   - Retry 3x avec backoff exponentiel

3. Intégrer l'ancestry on-the-fly dans ForensicWorker (section 8.3 du PRD) :
   - Quand un nouveau wallet est détecté (pas encore dans wallet_profiles) :
     a. Appeler HeliusClient.getWalletTransactions(creatorWallet)
     b. Pour chaque nativeTransfer entrant > 0.01 SOL :
        - Créer le lien dans wallet_ancestry via AncestryRepo.addLink(parent, child, tx, amount, depth=0)
        - Si confidence >= 0.7 et depth < 3 : remonter récursivement au parent
     c. Vérifier si le parent_wallet est déjà dans un cartel → propager cartel_id

4. src/utils/healthCheck.ts — Métriques de santé (section 8.5 du PRD) :
   - getHealthMetrics(): { tokensPerHour, rugRate, successRate, uniqueWalletsToday, apiCallsPerHour, heliusCallsToday, avgLatency, cartelsTotal }
   - Exposer via un log structuré toutes les 5 minutes : logger.info({ metrics }, 'Health check')
   - Alertes si métriques hors range (section 8.5 du PRD)

Tests :
- Test index.ts : vérifier que tous les workers démarrent et s'arrêtent proprement
- Test HeliusClient : mock API, vérifier le parsing de nativeTransfers
- Test ancestry on-the-fly : créer un wallet avec 2 funders → vérifier 2 liens dans wallet_ancestry
- Test healthCheck : injecter des données → vérifier les métriques calculées

Critère : `npm run type-check && npm test` → tout vert. `npm start` démarre sans crash (tester 10 secondes puis SIGINT).
```

---

## 7. Phase 8 — CalibrationWorker

> **Branche** : feat/calibration | **Mode** : Normal

```
Phase 8 — CalibrationWorker, branche feat/calibration. Lis la section 8.4 du PRD.

Implémente src/workers/CalibrationWorker.ts :

- S'exécute chaque dimanche à 03:00 UTC (utiliser un setInterval qui vérifie l'heure, ou node-cron)
- Peut aussi être déclenché manuellement via une méthode runCalibration()

Algorithme :
1. Extraire tous les token_events des 7 derniers jours
2. Pour chaque token SUCCESS avec un creator_wallet ayant ≥ 3 tokens : calculer le PnL théorique (achat simulé au fdv_at_check du verdict, vente à fdv × P_exit_v2, RUG non-AVOID = perte -100% — voir Annexe D.6 du PRD)
3. Évaluer les métriques actuelles :
   - Précision AVOID : wallets classés AVOID qui ont effectivement rug / total AVOID
   - Recall LONG : wallets LONG qui ont survécu / total survivants
   - Ratio gains/pertes : somme PnL positifs / somme PnL négatifs
4. Pour chaque paramètre (k, α, μ, σ, w1, w2, w3) :
   - Tester valeur_actuelle × 0.9 et valeur_actuelle × 1.1 (±10%)
   - Recalculer les métriques avec la valeur modifiée
   - Si amélioration du ratio gains/pertes > 5% : retenir la nouvelle valeur
5. Garde-fous : rejeter tout paramètre qui dévie de ±50% des valeurs initiales :
   - k ∈ [3.0, 9.0], α ∈ [1.5, 4.5], μ ∈ [50, 150], σ ∈ [20, 60]
   - w1 ∈ [0.20, 0.60], w2 ∈ [0.175, 0.525], w3 ∈ [0.125, 0.375]
6. Logger chaque décision dans calibration_log (param_name, old_value, new_value, improvement_pct, accepted)
7. Mettre à jour les paramètres dans un fichier config ou en variables d'environnement

Tests :
- Injecter 50 token_events simulés (35 RUG, 10 SUCCESS, 5 NEUTRAL) sur 7 jours
- Exécuter runCalibration() → vérifier que calibration_log contient des entrées
- Vérifier que les garde-fous rejettent une valeur k=15.0 (> 9.0)
- Vérifier que les paramètres ne changent pas si l'amélioration est < 5%
- Vérifier qu'un paramètre accepté est dans les bornes ±50%

Critère : `npm test -- tests/workers/CalibrationWorker` → tout vert. La calibration complète s'exécute en < 30 secondes sur 50 tokens.
```

---

## 8. Prompt de validation globale — Session finale

> **Mode** : Normal

```
Validation globale du projet WalletSourceDB. Exécute toutes les vérifications :

1. `npm run type-check` → 0 erreurs TypeScript strict
2. `npm run lint` → 0 warnings ESLint
3. `npm test` → 100% des tests passent, affiche le nombre de tests
4. `npm test -- --coverage` → affiche le % de couverture

Vérifie la cohérence structurelle :
5. Chaque fichier src/**/*.ts a un fichier tests/**/*.test.ts correspondant
6. Les 7 CREATE TABLE dans schema.sql correspondent aux 7 interfaces dans types/index.ts
7. Les FK sont enforced : pas d'orphelins dans wallet_ancestry, token_events, taint_log
8. La somme de taint_log.points_applied par wallet == wallet_profiles.taint_score (invariant)

Vérifie les formules :
9. TaintScorer : propager un rug sur 4 wallets (depth 0-3) → total = 126.65 pts
10. SigmoidScorer : taint=100 → toxicity=0.500, taint=200 → toxicity=0.924
11. PExitCalculator : MC=65000, MC_profil=50000, conf=0.85 → P_exit_v1=1.105
12. CartelDetector : 3 wallets avec même funder → 1 cartel détecté

Vérifie le pipeline live :
13. ForensicWorker → MonitoringRepo → RugScannerWorker → TaintScorer → SigmoidScorer fonctionne en chaîne
14. index.ts démarre les 4 workers et s'arrête proprement sur SIGINT

Produis un rapport final :
- Nombre total de fichiers .ts (src + tests)
- Nombre total de tests
- Couverture de code
- Phases complétées (P1-P8)
- Statut : PRÊT POUR PRODUCTION ou liste des problèmes restants

Si des erreurs : corrige-les et relance la vérification jusqu'à 0 erreurs.
```

---

## Notes d'utilisation

### Règles d'or
- **Une session = une phase.** Ne jamais demander plusieurs phases dans la même session.
- **Mode Plan** pour P1 uniquement. **Mode Normal** pour P2-P8.
- **Committer** après chaque phase réussie avant d'ouvrir une nouvelle session.
- **Le PRD v3.0 et CLAUDE.md** doivent être à la racine du projet — Claude Code lit CLAUDE.md automatiquement à chaque session.

### Commandes utiles en session
- **`Esc`** → stopper Claude s'il part dans la mauvaise direction
- **`/compact`** → si la session dépasse 30 échanges, compacter le contexte
- **`/model`** → vérifier/changer le modèle (utiliser Claude Sonnet 4.5 ou Opus pour les phases complexes)

### Ordre d'exécution
```
P1 Schema & Repos         → fondation (DB + CRUD)
P2 Verdict Pipeline        → détection + verdicts (WSS + DexScreener)
P3 Taint Propagation       → scoring pénalités (ancestry traversal)
P4-5 Profil + Cartels      → sigmoïdes + clustering
P6 P_exit                  → formule de sortie (v1 + v2)
P7 Collecte Live           → entry point + ancestry on-the-fly + health check
P8 CalibrationWorker       → recalibration hebdomadaire
Validation globale         → audit final
```

### Si Claude dévie
Si Claude Code crée des fichiers non prévus, ajoute des dépendances inutiles, ou ne respecte pas le pattern Repository :
1. `Esc` pour stopper
2. Dire : "Stop. Relis CLAUDE.md et la section X du PRD. Le pattern attendu est [décrire]. Reprends à partir de [dernier fichier correct]."
3. Claude Code corrigera son approche

### Après la validation
Le système est prêt. Lancer `npm start` pour démarrer la collecte live. La base se remplira progressivement (phase froide terminée après 3 jours OU 1000 wallets avec ≥ 3 tokens) :
- Jour 1-3 : phase froide — terminée quand 3 jours écoulés OU 1000 wallets avec ≥ 3 tokens (WATCH partout)
- Jour 4-14 : phase tiède (premiers scores significatifs)
- Jour 15+ : phase chaude (système opérationnel)
