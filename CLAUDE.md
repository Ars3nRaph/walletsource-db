# WalletSourceDB — Intelligence forensique on-chain

## Quick Facts
- **Stack** : TypeScript strict, Node.js 18+, PostgreSQL (node-postgres)
- **Mode** : Collecte LIVE uniquement — pas d'import historique, la base se construit en temps réel
- **Test** : `npm test` (Vitest)
- **Lint** : `npm run lint` (ESLint + @typescript-eslint)
- **Build** : `npm run build` (tsc)
- **Type-check** : `npm run type-check` (tsc --noEmit)
- **Start** : `npm start` (lance ForensicWorker + RugScannerWorker + CalibrationWorker)
- **PRD complet** : `PRD_WalletSourceDB_v3.0.md` à la racine du projet

## Vision
On ne trade pas le token. On trade le wallet. Base de données relationnelle de wallets "source" qui trace, profile et score les portefeuilles impliqués dans la création de tokens on-chain (Solana / Pump.fun). La base démarre vide et se remplit organiquement via la détection live. Objectif : prédire le comportement d'un token dès sa création via l'historique de son créateur et de son cartel.

## Architecture

```
src/
├── db/
│   ├── schema.sql              # 7 tables (5 principales + monitoring_queue + calibration_log)
│   ├── migrations/             # ALTER TABLE pour champs v3
│   └── connection.ts           # Pool PostgreSQL (pg.Pool, exécute schema.sql au 1er appel)
├── repositories/
│   ├── WalletRepo.ts           # wallet_profiles CRUD
│   ├── AncestryRepo.ts         # wallet_ancestry CRUD + getAncestors(depth)
│   ├── TokenEventRepo.ts       # token_events CRUD + getMedianFDV(verdict)
│   ├── CartelRepo.ts           # cartel_groups CRUD + detectCartels()
│   ├── TaintLogRepo.ts         # taint_log CRUD + getTotalByWallet()
│   └── MonitoringRepo.ts       # monitoring_queue CRUD + getDueTokens()
├── workers/
│   ├── ForensicWorker.ts       # Détection tokens via WSS Solana (logsSubscribe)
│   ├── RugScannerWorker.ts     # Verdicts via DexScreener (toutes les 60s)
│   └── CalibrationWorker.ts    # Recalibration hebdomadaire sigmoïdes (dimanche 03:00 UTC)
├── scoring/
│   ├── TaintScorer.ts          # Propagation taint (50 × 0.7^depth, max depth 3)
│   ├── SigmoidScorer.ts        # toxicity_score, risk_score, confidence_cartel_v2
│   └── PExitCalculator.ts      # P_exit v1 (linéaire) + v2 (sigmoïde)
├── cartels/
│   └── CartelDetector.ts       # Clustering wallet_ancestry + batch détection
├── api/
│   ├── HeliusClient.ts         # API Helius (ancestry on-the-fly, rate limited)
│   └── DexScreenerClient.ts    # API DexScreener (verdicts, 300ms entre appels)
├── types/
│   ├── index.ts                # Interfaces pour les 7 tables + API responses
│   └── errors.ts               # WalletSourceError + ErrorCode enum
├── utils/
│   └── logger.ts               # Logger pino structuré
└── index.ts                    # Point d'entrée : lance les 3 workers
tests/                          # Miroir de src/ avec .test.ts (Vitest + pg-mem)
├── repositories/
├── workers/
├── scoring/
└── cartels/
```

## Tables SQL (7 tables)

### 1. wallet_profiles (PK: wallet_address)
| Colonne | Type | Rôle |
|---------|------|------|
| wallet_address | TEXT PK | Adresse on-chain |
| first_seen_at | DATETIME | Première détection |
| last_seen_at | DATETIME | Dernière activité |
| rug_count | INTEGER DEFAULT 0 | Tokens classés RUG |
| survival_count | INTEGER DEFAULT 0 | Tokens classés SUCCESS |
| neutral_count | INTEGER DEFAULT 0 | Tokens classés NEUTRAL |
| rug_rate | REAL GENERATED ALWAYS AS (...) STORED | rug_count / total (syntaxe PostgreSQL) |
| taint_score | REAL DEFAULT 0 | Pénalité accumulée (TaintScorer) |
| toxicity_score | REAL DEFAULT 0.5 | Taint normalisé par sigmoïde [0-1] |
| risk_score | REAL DEFAULT 0.5 | Score composite sigmoïde [0-1] |
| cartel_id | TEXT FK → cartel_groups | Référence cartel |
| profile_vector | TEXT (JSON) | 7 features pondérées |
| strategy | TEXT | AVOID \| SHORT \| WATCH \| LONG |

### 2. wallet_ancestry (PK: id)
parent_wallet → child_wallet, funding_tx, funding_amount_sol, depth (0-3), confidence (0-1), detected_at

### 3. token_events (PK: token_address)
creator_wallet (FK), detected_at, checked_at, verdict (RUG\|SUCCESS\|NEUTRAL), fdv_at_check, liquidity_at_check, price_change_5m, dexscreener_pair, p_exit_v1, p_exit_v2

### 4. cartel_groups (PK: cartel_id)
name, wallet_count, total_rug_count, total_survival_count, avg_rug_rate, confidence_score, confidence_score_v2, auto_strategy

### 5. taint_log (PK: id)
wallet_address (FK), source_token (FK), points_applied, propagation_depth, reason (RUG_NO_PAIR\|RUG_METRICS), applied_at

### 6. monitoring_queue (PK: id)
token_address, creator_wallet, detected_at, check_at (detected_at + 15min), status (PENDING\|PROCESSING\|DONE\|RETRY), retry_count, processed_at

### 7. calibration_log (PK: id)
calibrated_at, param_name, old_value, new_value, improvement_pct, tokens_evaluated, accepted

## Pipeline live (flux séquentiel)
1. **ForensicWorker** détecte un nouveau token Pump.fun via WSS → enqueue monitoring_queue (check_at = now + 15 min)
2. **RugScannerWorker** (toutes les 60s) prend les tokens PENDING dont check_at est dépassé → appelle DexScreener → émet verdict
3. Si verdict = **RUG** → TaintScorer propage la pénalité en remontant l'ancestry (depth 0-3)
4. **SigmoidScorer** recalcule toxicity_score, risk_score, strategy du wallet
5. **HeliusClient** construit l'ancestry on-the-fly pour chaque nouveau wallet
6. **CartelDetector** tourne en batch toutes les 5 min → détecte les cartels
7. **PExitCalculator** recalcule P_exit toutes les 10s pour les positions ouvertes
8. **CalibrationWorker** recalibre les sigmoïdes chaque dimanche 03:00 UTC

## Remplissage progressif
- **Jour 1-3 (phase froide — minimum 3 jours ou 1000 wallets avec ≥ 3 tokens)** : majorité en WATCH (< 3 tokens). Accumulation passive.
- **Jour 4-14 (phase tiède — activée quand condition phase froide atteinte)** : rug_rate et taint_score deviennent significatifs. Premiers cartels détectés.
- **Jour 15+ (phase chaude)** : base opérationnelle. Sigmoïdes discriminantes. P_exit fiable.

## Verdict (après 15 min)
| Verdict | Condition | Action |
|---------|-----------|--------|
| RUG_NO_PAIR | DexScreener retourne pairs === null | rug_count++, taint_score += 50, propager ancestry |
| RUG_METRICS | liquidité < 2000$ OU prix chuté > 75% en 5min | rug_count++, taint_score += 50, propager ancestry |
| SUCCESS | FDV > 30000$ ET liquidité > 5000$ | survival_count++ |
| NEUTRAL | Aucune condition ci-dessus | neutral_count++ (pas de scoring) |

## Formules

### Taint propagation
```
Taint(depth) = 50 × 0.7^depth
  depth 0 = +50.0 pts (créateur)
  depth 1 = +35.0 pts (funder)
  depth 2 = +24.5 pts (funder du funder)
  depth 3 = +17.15 pts (max)
Seuil : ignorer les liens avec confidence < 0.7
Decay : taint_score *= 0.95 chaque semaine pour les wallets inactifs > 7 jours
```

### Sigmoïdes (section 7 du PRD)
```
sigmoid(x, k) = 1 / (1 + e^(-k * x))

toxicity_score = sigmoid((taint_score - μ) / σ)
  → μ = 100, σ = 40

confidence_cartel_v2 = sigmoid(k × (survival_rate - 0.5)) × min(1, total_tokens / N_min)
  → k = 6.0, N_min = 10

consistency_factor (pour confidence_score v1) = mapping du CV (coefficient de variation = σ/μ des rug_rates membres) sur [0.8-1.2]
  → CV bas (membres cohérents) = bonus 1.2, CV haut (membres incohérents) = malus 0.8

risk_score = w1 × sigmoid(k1 × (rug_rate - 0.5))
           + w2 × toxicity_score
           + w3 × sigmoid(k3 × (cartel_rug_rate - 0.5))
  → w1 = 0.40, k1 = 6.0
  → w2 = 0.35
  → w3 = 0.25, k3 = 5.0

Strategy mapping :
  [0.00 - 0.25] → LONG
  [0.25 - 0.50] → WATCH
  [0.50 - 0.75] → SHORT
  [0.75 - 1.00] → AVOID
```

### P_exit
```
P_exit v1 (linéaire) = (MC_actuel / MC_profil) × Confiance_cartel
P_exit v2 (sigmoïde) = sigmoid(α × (MC_ratio - 1)) × Confiance_cartel_v2
  → α = 3.0
  → MC_profil = médiane fdv_at_check des tokens SUCCESS du même creator

Zones v1 : ≥1.5 EXIT IMMÉDIAT | 1.0-1.49 EXIT PROGRESSIF | 0.5-0.99 HOLD | <0.5 WATCH
Zones v2 : sortie proportionnelle continue via sigmoïde
```

### Profile vector (7 features)
| Feature | Poids | Source |
|---------|-------|--------|
| rug_rate | ×3.0 | rug_count / total |
| taint_score | ×2.0 | TaintScorer |
| avg_token_lifespan | ×1.0 | médiane temps avant verdict |
| cartel_rug_rate | ×2.5 | avg_rug_rate du cartel |
| ancestry_depth | ×0.5 | profondeur max ancestry |
| funding_diversity | ×1.0 | sources uniques / total txs |
| token_frequency | ×1.5 | tokens lancés / jour |

## Calibration continue (CalibrationWorker)
Chaque dimanche 03:00 UTC :
1. Extraire token_events des 7 derniers jours
2. Évaluer métriques (Précision AVOID, Recall LONG, ratio gains/pertes — PnL théorique : achat au fdv_at_check du verdict, vente à fdv × P_exit_v2, RUG non-AVOID = -100%)
3. Micro-grid search : variations ±10% sur chaque paramètre
4. Accepter si amélioration > 5%, sinon conserver les valeurs actuelles
5. Garde-fous : aucun paramètre ne peut dévier de ±50% des valeurs initiales
6. Logger dans calibration_log

## APIs externes

### DexScreener
- **Endpoint** : `GET https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}`
- **Rate limit** : 300ms entre appels, max 1000 req/h global
- **Réponse** : `pairs[0].fdv` → fdv_at_check, `pairs[0].liquidity.usd` → liquidity_at_check, `pairs[0].priceChange.m5` → price_change_5m, `pairs[0].pairAddress` → dexscreener_pair
- **pairs === null** → verdict RUG_NO_PAIR

### Helius
- **Endpoint** : `GET https://api.helius.xyz/v0/addresses/{addr}/transactions?api-key={key}&type=TRANSFER`
- **Rate limit** : ~5 credits/appel, 1M credits/mois (gratuit) = ~66 000 wallets/mois
- **Réponse** : `nativeTransfers[].fromUserAccount` → parent_wallet, `.toUserAccount` → child_wallet, `.amount / 1e9` → funding_amount_sol

### Solana WSS
- **Endpoint primaire** : `wss://atlas-mainnet.helius-rpc.com?api-key={key}` (Helius Enhanced WebSocket)
- **Endpoint fallback** : `wss://pumpportal.fun/api/data` (PumpPortal — subscribeNewToken)
- **Subscription** : `transactionSubscribe` avec accountInclude du program ID `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- **Reconnexion auto** si WSS déconnecté (backoff exponentiel)
- **Parsing** : chercher `"Program log: Instruction: Create"` dans les logs → `accountKeys[0]` = creator_wallet, `accountKeys[1]` = token_mint
- **PumpPortal fallback** : event.mint = token, event.traderPublicKey = creator

### Rate limit global
Max 1000 req/h (fenêtre glissante 60 min). Utiliser une classe `RateLimiter` singleton partagée entre DexScreenerClient et HeliusClient (src/utils/rateLimiter.ts). Si > 800 tokens en queue, prioriser les wallets avec le taint_score le plus élevé ou ceux appartenant à un cartel déjà référencé. Si quota atteint → re-enqueue avec check_at += 5 min.

## Détection de cartels (3 critères)
1. **Funding commun** : ≥ 3 wallets financés par la même source (requête récursive wallet_ancestry)
2. **Activité temporelle** : lancements de tokens dans une fenêtre de ± 5 minutes (corrélation token_events)
3. **Overlap comportemental** : similarité cosinus > 0.85 entre les profile_vectors des wallets

## Règles strictes de code
- TypeScript strict mode obligatoire, jamais `any` (utiliser `unknown`)
- Prefer `interface` over `type`
- Pattern Repository pour tout accès DB — jamais de SQL brut dans les workers
- Fonctions pures pour le scoring (entrée → sortie, testables unitairement)
- Chaque fichier `src/*.ts` doit avoir un `tests/*.test.ts` associé
- Nommage : PascalCase classes/interfaces, camelCase variables/fonctions
- Gestion d'erreurs : `WalletSourceError` typé avec `ErrorCode` enum, jamais de catch vide
- Logging : `pino` structuré (`logger.info({ token, wallet }, 'message')`)
- Retry API : max 3 tentatives, backoff exponentiel (1s, 2s, 4s)
- Tests DB : `pg (node-postgres)` avec `test database (pg-mem ou base de test dédiée)` dans beforeEach, schéma rechargé à chaque test

## Scripts npm
```json
{
  "scripts": {
    "build": "tsc",
    "start": "ts-node src/index.ts",
    "start:dev": "ts-node --watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src/ tests/ --ext .ts",
    "lint:fix": "eslint src/ tests/ --ext .ts --fix",
    "type-check": "tsc --noEmit"
  }
}
```

## Phases de développement
| Phase | Branche | Fichiers | Validation |
|-------|---------|----------|------------|
| P1 Schema | feat/schema | schema.sql, connection.ts, 6 Repos, types/ | `npm test -- tests/repositories/` → 6/6 CRUD OK |
| P2 Verdict | feat/verdict | ForensicWorker, RugScannerWorker, DexScreenerClient | Token détecté + verdict < 30s |
| P3 Taint | feat/taint | TaintScorer | Propagation depth 0-3 < 200ms, liens < 0.7 ignorés |
| P4 Profil | feat/profil | SigmoidScorer, profile_vector | risk_score [0-1], strategy assignée |
| P5 Cartels | feat/cartels | CartelDetector | ≥ 1 cartel détecté, confidence_score_v2 calculé |
| P6 P_exit | feat/pexit | PExitCalculator | v1 + v2 conformes, recalcul < 10ms |
| P7 Dashboard | feat/dashboard | API REST + frontend | Visualisation opérationnelle |
| P8 Sigmoïdes | feat/sigmoid | CalibrationWorker, calibration_log | Recalibration hebdo active |
| GLOBAL | — | — | `npm run type-check && npm run lint && npm test` → 0 erreurs |

## Setup PostgreSQL
```bash
# docker-compose up -d (voir docker-compose.yml dans le PRD Annexe D.7)
```

## Variables d'environnement (.env)
```
HELIUS_API_KEY=your_key
SOLANA_WSS_URL=wss://mainnet.helius-rpc.com/?api-key=your_key
DEXSCREENER_RATE_LIMIT=1000
DATABASE_URL=postgresql://walletsource:walletsource_dev@localhost:5432/walletsource
PUMP_FUN_PROGRAM_ID=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
LOG_LEVEL=info
TAINT_DECAY_WEEKLY=0.95
SIGMOID_K_CONFIDENCE=6.0
SIGMOID_ALPHA_PEXIT=3.0
SIGMOID_MU_TAINT=100
SIGMOID_SIGMA_TAINT=40
CALIBRATION_CRON=0 3 * * 0
CALIBRATION_GUARD_PCT=0.50
```

## Lors de la compaction
Toujours préserver : la liste des fichiers modifiés, les commandes de test qui ont échoué, les formules mathématiques, les critères de validation de la phase en cours, et les paramètres de calibration actuels.
