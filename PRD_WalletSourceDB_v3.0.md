

# PRODUCT REQUIREMENTS DOCUMENT


## WalletSourceDB

Base SQL de wallets source — Intelligence forensique on-chain

*Version 3.0  •  Mars 2026  •  Confidentiel*


# 1. Vision

Construire une base de données relationnelle de wallets « source » qui permet de tracer, profiler et scorer l’ensemble des portefeuilles impliqués dans la création de tokens on-chain. L’objectif final est de prédire le comportement futur d’un token dès sa création, en se basant sur l’historique de son créateur et du cartel auquel il appartient.


> **Principe fondateur On ne trade pas le token. On trade le wallet. Un wallet qui a rug 15 fois ne va pas soudainement devenir légitime. Un cartel avec un taux de survie de 80% mérite qu’on le suive.**


# 2. Contexte technique

Le système repose sur 5 composants qui interagissent de manière séquentielle :


| Composant | Rôle | Déclencheur |
| --- | --- | --- |
| ForensicWorker | Détecte les lancements de tokens via WSS, extrait l’adresse token + créateur, enregistre dans monitoring_queue avec check_at = now + 15min | Nouveau token détecté sur le réseau |
| MonitoringRepo | CRUD PostgreSQL sur monitoring_queue. Fournit getDueTokens() pour récupérer les tokens dont l’échéance est passée | Appelé par ForensicWorker et RugScannerWorker |
| RugScannerWorker | Toutes les 60s, interroge DexScreener pour chaque token échu (pause 300ms entre requêtes). Prononce un verdict. | Intervalle de 60 secondes |
| TaintScorer | Propage les pénalités (+50 pts pour un rug) en remontant la chaîne d’ancestry des wallets | Verdict RUG |
| CreatorRepo | Persiste les compteurs rug_count et survival_count par wallet créateur | Verdict RUG ou SUCCESS |


# 3. Logique de verdict

Après 15 minutes, le RugScannerWorker interroge DexScreener et applique la matrice de décision suivante :


| Verdict | Condition | Action SQL |
| --- | --- | --- |
| RUG (No Pair) | DexScreener ne retourne aucune paire (liquidité = 0) | rug_count += 1, taint_score += 50, propager aux ancestors |
| RUG (Metrics) | Liquidité < 2 000 $ OU prix chuté de > 75% en 5 min | rug_count += 1, taint_score += 50, propager aux ancestors |
| SUCCESS | FDV > 30 000 $ ET liquidité > 5 000 $ | survival_count += 1 |
| NEUTRAL | Aucune condition ci-dessus satisfaite (zone grise) | Aucune action de scoring |


> **Seuils DexScreener API endpoint : https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}. Rate limit respecté avec un délai de 300ms entre chaque appel.**


> **⚠️ CONTRAINTE CRITIQUE — Rate Limiting API Le nombre total de requêtes API (DexScreener et toutes sources externes confondues) ne doit PAS dépasser 1 000 requêtes/heure. Le RugScannerWorker doit implémenter un compteur global de requêtes avec fenêtre glissante de 60 minutes. Si le quota est atteint, les tokens en attente sont reportés au cycle suivant (re-enqueue avec check_at += 5 min). Un champ api_calls_this_hour doit être exposé pour monitoring. En cas de pic d’activité (>800 tokens en queue), prioriser les wallets avec le taint_score le plus élevé ou ceux appartenant à un cartel déjà référencé.**


# 4. Schéma SQL — WalletSourceDB

5 tables interconnectées forment le coeur de la base de données d’intelligence forensique.

## 4.1 wallet_profiles

Registre central de chaque wallet observé. Chaque créateur de token obtient une entrée.


| Colonne | Type | Description |
| --- | --- | --- |
| wallet_address | TEXT PRIMARY KEY | Adresse on-chain du wallet |
| first_seen_at | DATETIME | Première détection par le ForensicWorker |
| last_seen_at | DATETIME | Dernière activité détectée |
| rug_count | INTEGER DEFAULT 0 | Nombre de tokens classés RUG |
| survival_count | INTEGER DEFAULT 0 | Nombre de tokens classés SUCCESS |
| neutral_count | INTEGER DEFAULT 0 | Nombre de tokens classés NEUTRAL |
| rug_rate | REAL GENERATED | rug_count / (rug_count + survival_count + neutral_count) |
| taint_score | REAL DEFAULT 0 | Score de pénalité accumulé (propagé par TaintScorer) |
| cartel_id | TEXT FK | Référence vers cartel_groups.cartel_id |
| profile_vector | TEXT (JSON) | Vecteur matriciel du profil (voir section 6) |
| strategy | TEXT | AVOID \| SHORT \| WATCH \| LONG |


## 4.2 wallet_ancestry

Arbre généalogique des financements. Trace quel wallet a fundé quel autre wallet (ADN on-chain).


| Colonne | Type | Description |
| --- | --- | --- |
| id | INTEGER PRIMARY KEY AUTOINCREMENT | Identifiant unique |
| parent_wallet | TEXT FK | Wallet source du financement |
| child_wallet | TEXT FK | Wallet financé |
| funding_tx | TEXT | Hash de la transaction de financement |
| funding_amount_sol | REAL | Montant transféré en SOL |
| depth | INTEGER | Profondeur dans l’arbre (0 = source directe) |
| confidence | REAL | Score de confiance du lien (0.0 à 1.0) |
| detected_at | DATETIME | Date de détection du lien |


## 4.3 token_events

Historique complet de chaque token détecté avec son verdict final.


| Colonne | Type | Description |
| --- | --- | --- |
| token_address | TEXT PRIMARY KEY | Adresse du token |
| creator_wallet | TEXT FK | Wallet qui a créé le token |
| detected_at | DATETIME | Timestamp de détection (ForensicWorker) |
| checked_at | DATETIME | Timestamp du verdict (RugScannerWorker) |
| verdict | TEXT | RUG \| SUCCESS \| NEUTRAL |
| fdv_at_check | REAL | FDV au moment du check |
| liquidity_at_check | REAL | Liquidité au moment du check |
| price_change_5m | REAL | Variation de prix sur 5 min (%) |
| dexscreener_pair | TEXT | Adresse de la paire DexScreener (si existante) |


## 4.4 cartel_groups

Pools de wallets identifiés comme appartenant au même réseau (cartel). C’est le concept de « pool de wallets » : on track des groupes, pas des individus isolés.


| Colonne | Type | Description |
| --- | --- | --- |
| cartel_id | TEXT PRIMARY KEY | Identifiant unique du cartel (hash) |
| name | TEXT | Nom optionnel pour identification rapide |
| created_at | DATETIME | Date de création du groupe |
| wallet_count | INTEGER | Nombre de wallets dans le cartel |
| total_rug_count | INTEGER | Somme des rugs de tous les membres |
| total_survival_count | INTEGER | Somme des succès de tous les membres |
| avg_rug_rate | REAL | Taux de rug moyen du cartel |
| confidence_score | REAL | Confiance_cartel (utilisé dans la formule P_exit) |
| auto_strategy | TEXT | Stratégie déduite automatiquement : AVOID \| SHORT \| WATCH \| LONG |


## 4.5 taint_log

Journal d’audit de chaque propagation de pénalité. Permet de retracer comment un taint_score a évolué.


| Colonne | Type | Description |
| --- | --- | --- |
| id | INTEGER PRIMARY KEY AUTOINCREMENT | Identifiant unique |
| wallet_address | TEXT FK | Wallet pénalisé |
| source_token | TEXT FK | Token qui a déclenché la pénalité |
| points_applied | REAL | Points de taint appliqués |
| propagation_depth | INTEGER | Profondeur de propagation (0 = direct) |
| reason | TEXT | RUG_NO_PAIR \| RUG_METRICS |
| applied_at | DATETIME | Timestamp de l’application |


# 5. Propagation du Taint Score

Lorsqu’un token est classé RUG, le TaintScorer remonte l’arbre d’ancestry et pénalise chaque wallet parent avec un decay exponentiel par profondeur.


> **Formule de propagation Taint(depth) = 50 × 0.7^depth Depth 0 = +50 pts (créateur direct) \| Depth 1 = +35 pts (funder) \| Depth 2 = +24.5 pts \| Depth 3 = +17.15 pts**


| Profondeur | Points appliqués | Wallet ciblé | Cumul exemple |
| --- | --- | --- | --- |
| 0 (créateur) | +50.0 | Wallet qui a créé le token | 50.0 |
| 1 (funder) | +35.0 | Wallet qui a financé le créateur | 85.0 |
| 2 (funder du funder) | +24.5 | Wallet source N-2 | 109.5 |
| 3 (max recommandé) | +17.15 | Wallet source N-3 | 126.65 |


> **Seuil de confidence pour la propagation Seuls les liens d’ancestry avec une confidence ≥ 0.7 sont pris en compte pour la propagation. En dessous de ce seuil, le lien est ignoré.**


# 6. Profil matriciel du wallet

Chaque wallet se voit attribuer un vecteur de features stocké en JSON dans profile_vector. Ce vecteur permet de classer le wallet dans une stratégie automatique.


| Feature | Type | Source | Poids |
| --- | --- | --- | --- |
| rug_rate | float [0, 1] | Calculé depuis rug_count / total | ×3.0 |
| taint_score | float [0, +∞] | TaintScorer (accumulé) | ×2.0 |
| avg_token_lifespan | float (minutes) | Médiane du temps avant verdict | ×1.0 |
| cartel_rug_rate | float [0, 1] | avg_rug_rate du cartel_groups | ×2.5 |
| ancestry_depth | integer | Profondeur max dans wallet_ancestry | ×0.5 |
| funding_diversity | float [0, 1] | Nb sources de financement uniques / total txs | ×1.0 |
| token_frequency | float (tokens/jour) | Nombre de tokens lancés par jour en moyenne | ×1.5 |


## 6.1 Règles de stratégie automatique


| Stratégie | Condition | Action du bot |
| --- | --- | --- |
| AVOID | rug_rate > 0.8 OU taint_score > 200 | Ne jamais sniper les tokens de ce wallet |
| SHORT | rug_rate > 0.5 ET taint_score > 100 | Stratégie courte : snipe + exit rapide si profit |
| WATCH | Données insuffisantes (< 3 tokens observés) | Observer sans agir, accumuler des données |
| LONG | rug_rate < 0.3 ET survival_count ≥ 5 ET taint_score < 50 | Stratégie longue : snipe + hold avec confiance |


# 7. Fonctions Sigmoïdes — Scoring non-linéaire

Les formules linéaires (sections 5, 6, 9) produisent des seuils brutaux. L’introduction de la fonction sigmoïde σ(x) = 1 / (1 + e^(-x)) permet des transitions douces entre les zones de décision, améliorant la précision du scoring et la robustesse aux outliers.


> **Formule fondatrice : σ(x) = 1 / (1 + e^(-kx))  où k contrôle la raideur de la courbe. Plus k est grand, plus la transition est abrupte (se rapproche du seuil binaire). Plus k est petit, plus la transition est graduelle.**


## 7.1 Confidence Sigmoïde du Cartel

Remplacement de la formule linéaire de la section 9.2. La sigmoïde normalise le score de confiance en intégrant le volume d’observations, ce qui pénalise les cartels avec peu de données.


> **Confiance_cartel_v2 = σ(k × (survival_rate - 0.5)) × volume_factor**


Ancienne formule : Confiance_cartel = (total_survival / (total_survival + total_rug)) × consistency_factor
Nouvelle formule : Confiance_cartel_v2 = (1 / (1 + e^(-k × (survival_rate - 0.5)))) × min(1, total_tokens / N_min)


| Paramètre | Valeur recommandée | Description |
| --- | --- | --- |
| k (raideur) | 6.0 | Transition douce entre 0.3 et 0.7 de survival_rate |
| survival_rate | survival / (survival + rug) | Taux de survie brut du cartel |
| N_min | 10 | Nombre minimum de tokens pour confiance pleine |
| volume_factor | min(1, total_tokens / N_min) | Pénalise les cartels avec < N_min observations |
| consistency_factor | Conservé en multiplicateur [0.8 — 1.2] | Bonus/malus basé sur la cohérence interne |


Exemple : Cartel avec 15 tokens, 10 survival, 5 rug (survival_rate = 0.66)
    σ(6 × (0.66 - 0.5)) = σ(0.96) = 1 / (1 + e^(-0.96)) = 0.723
volume_factor = min(1, 15/10) = 1.0
Confiance_cartel_v2 = 0.723 × 1.0 = 0.723
Contre 0.66 avec la formule linéaire. La sigmoïde pousse la confiance vers les extrêmes, discriminant mieux les bons et mauvais cartels.


## 7.2 Taint Score Sigmoïde

Le taint_score actuel est un cumul linéaire (+50 pts par rug). Le problème : un wallet avec 500 pts de taint n’est pas 10× plus dangereux qu’un wallet à 50 pts — il est simplement toxique. La sigmoïde normalise le taint en probabilité de toxicité.


> **toxicity_score = σ((taint_score - μ) / σ_taint)  ∈ [0, 1]**


Formule : toxicity_score = 1 / (1 + e^(-(taint_score - 100) / 40))
Où 100 est le taint médian attendu (μ) et 40 est l’écart-type observé (σ_taint). Ces valeurs sont calibrées en continu par le CalibrationWorker (section 8.4).


| taint_score brut | toxicity_score (sigmoïde) | Interprétation |
| --- | --- | --- |
| 0 | 0.076 | Quasi-clean — wallet fiable |
| 50 | 0.224 | Léger — 1 rug isolé |
| 100 | 0.500 | Zone grise — à surveiller |
| 150 | 0.776 | Suspect — profil risqué |
| 200 | 0.924 | Toxique — éviter |
| 300 | 0.993 | Blacklist — cartel rug confirmé |


Impact sur wallet_profiles : Le champ toxicity_score (REAL, 0-1) est ajouté au schéma. Il est recalculé à chaque mise à jour du taint_score. Les règles de stratégie (section 6.1) peuvent utiliser toxicity_score au lieu de taint_score pour des seuils plus naturels.


## 7.3 P_exit Sigmoïde (v2)

La formule P_exit actuelle (section 8) est linéaire : P_exit = (MC_actuel / MC_profil) × Confiance_cartel. Le problème : les transitions entre HOLD / EXIT PROGRESSIF / EXIT IMMÉDIAT sont des seuils brutaux. La sigmoïde crée une courbe d’urgence de sortie continue.


> **P_exit_v2 = σ(α × (MC_ratio - 1)) × Confiance_cartel_v2**


Où : MC_ratio = MC_actuel / MC_profil, et α = 3.0 (paramètre de sensibilité)


| MC_ratio | σ(3 × (ratio-1)) | × Confiance 0.85 | Action |
| --- | --- | --- | --- |
| 0.3 | 0.119 | 0.101 | HOLD — loin du seuil |
| 0.7 | 0.289 | 0.245 | HOLD — en progression |
| 1.0 | 0.500 | 0.425 | WATCH — seuil atteint |
| 1.3 | 0.711 | 0.604 | EXIT PROGRESSIF — 50% vendu |
| 1.5 | 0.818 | 0.695 | EXIT PROGRESSIF — trailing stop |
| 2.0 | 0.953 | 0.810 | EXIT IMMÉDIAT — prendre profit |
| 3.0 | 0.998 | 0.848 | EXIT IMMÉDIAT — sur-performance |


Avantage clé : Au lieu d’un saut brutal à P_exit = 1.0, la probabilité de sortie monte progressivement. Le bot peut commencer à vendre des fractions dès MC_ratio = 0.8 et accélérer la sortie de manière continue.


## 7.4 Stratégie v2 avec Sigmoïdes

Les règles de stratégie (section 6.1) sont remplacées par un score composite continu, éliminant les seuils discrets.


> **risk_score = w1 × σ(k1 × (rug_rate - 0.5)) + w2 × toxicity_score + w3 × σ(k3 × (cartel_rug_rate - 0.5))**


| Paramètre | Poids | k (raideur) | Rôle |
| --- | --- | --- | --- |
| rug_rate | w1 = 0.40 | k1 = 6.0 | Historique individuel du wallet |
| toxicity_score | w2 = 0.35 | (déjà sigmoidé) | Score de contamination propagé |
| cartel_rug_rate | w3 = 0.25 | k3 = 5.0 | Réputation du réseau |


| risk_score | Stratégie | Action |
| --- | --- | --- |
| 0.00 — 0.25 | LONG | Snipe + hold avec confiance |
| 0.25 — 0.50 | WATCH | Observer, accumuler des données |
| 0.50 — 0.75 | SHORT | Snipe + exit rapide si profit |
| 0.75 — 1.00 | AVOID | Ne jamais sniper |


Champ SQL ajouté : risk_score REAL DEFAULT 0.5 dans wallet_profiles. Recalculé à chaque mise à jour de rug_count, taint_score, ou cartel_groups.


# 8. Collecte Live — Base de données fraîche

Le système fonctionne exclusivement en mode live. Aucune donnée historique n'est importée. La base de données se construit organiquement à partir de la détection en temps réel des tokens Pump.fun sur Solana. Cette approche garantit que toutes les données sont fraîches, vérifiées par le système lui-même, et non dépendantes de sources tierces potentiellement obsolètes.

## 8.1 Architecture de collecte

Le pipeline live suit le flux séquentiel décrit en section 2 :

| Étape | Composant | Déclencheur | Latence cible |
| --- | --- | --- | --- |
| 1. Détection | ForensicWorker (WSS) | Nouveau token Pump.fun on-chain | < 2 secondes |
| 2. File d'attente | MonitoringRepo | Token détecté → enqueue | < 500ms |
| 3. Verdict | RugScannerWorker | check_at atteint (detected_at + 15 min) | < 30 secondes |
| 4. Scoring | TaintScorer + SigmoidScorer | Verdict RUG émis | < 200ms |
| 5. Ancestry | HeliusClient | Nouveau wallet détecté | < 5 secondes par depth |
| 6. Cartels | CartelDetector | Batch toutes les 5 minutes | < 10 secondes |
| 7. P_exit | PExitCalculator | Recalcul toutes les 10 secondes | < 10ms par token |

## 8.2 Remplissage progressif de la base

La base démarre vide. Les tables se remplissent naturellement au fil de la détection :

**Jour 1-3 (phase froide — minimum 3 jours ou 1000 wallets avec ≥ 3 tokens)** — La majorité des wallets sont en strategy WATCH (< 3 tokens observés). Le système accumule des données sans agir. Les verdicts commencent à alimenter token_events et wallet_profiles. Les premiers liens d'ancestry apparaissent.

**Jour 4-14 (phase tiède — activée quand condition phase froide atteinte)** — Les wallets récidivistes commencent à avoir un historique exploitable (≥ 3 tokens). Les premiers rug_rate et taint_score deviennent significatifs. Les premiers cartels sont détectés par le CartelDetector. Transition progressive de WATCH vers SHORT/AVOID/LONG.

**Jour 15+ (phase chaude)** — La base contient suffisamment de données pour que les formules sigmoïdes soient discriminantes. Les confidence_score des cartels se stabilisent. P_exit devient fiable pour les wallets avec ≥ 5 tokens SUCCESS. Le système est opérationnel.

## 8.3 Ancestry on-the-fly

L'arbre de financement (wallet_ancestry) est construit progressivement à chaque nouveau wallet détecté :

    1. ForensicWorker détecte un token → extrait creator_wallet
    2. Si creator_wallet est nouveau (pas dans wallet_profiles) :
       a. Créer l'entrée wallet_profiles avec strategy = WATCH
       b. Appeler HeliusClient.getWalletTransactions(creator_wallet)
       c. Pour chaque SOL transfer entrant (> 0.01 SOL) :
          - Créer le lien dans wallet_ancestry (depth 0)
          - Si confidence ≥ 0.7, remonter au parent (depth 1)
          - Répéter jusqu'à depth 3 max
       d. Vérifier si le parent_wallet est déjà dans un cartel
    3. Si creator_wallet existe déjà : mettre à jour last_seen_at

**Rate limiting Helius** : chaque lookup ancestry consomme ~5 credits × (1 + depth) appels. Budget : 1M credits/mois (plan gratuit) = ~66 000 wallets analysés/mois. Si le volume dépasse ce budget, prioriser les wallets dont le taint_score est le plus élevé ou ceux liés à un cartel existant.

## 8.4 Calibration continue des sigmoïdes

Les paramètres sigmoïdes (k, α, μ, σ, poids) sont calibrés en continu sur les données live :

**Calibration initiale** — Démarrer avec les valeurs théoriques du PRD (k=6.0, α=3.0, μ=100, σ=40, w1=0.40, w2=0.35, w3=0.25).

**Recalibration hebdomadaire** — Chaque dimanche à 03:00 UTC, le CalibrationWorker :

    1. Extrait les token_events des 7 derniers jours
    2. Pour chaque token SUCCESS : calcule le PnL théorique avec les paramètres actuels
    3. Évalue les métriques : Précision AVOID, Recall LONG, ratio gains/pertes
    4. Teste des variations ±10% sur chaque paramètre (micro-grid search)
    5. Si une combinaison améliore le ratio gains/pertes de > 5% : adopter les nouveaux paramètres
    6. Logger le changement dans une table calibration_log

**Garde-fous** — Les paramètres ne peuvent pas dévier de plus de ±50% des valeurs initiales. Si la recalibration propose un k > 9.0 ou < 3.0, elle est rejetée et une alerte est émise.

## 8.5 Métriques de santé live

Le système expose des métriques de monitoring en continu :

| Métrique | Valeur attendue (phase chaude) | Alerte si |
| --- | --- | --- |
| Tokens détectés / heure | 200 — 800 | < 50 (WSS déconnecté?) ou > 2000 (spam?) |
| Taux de verdict RUG | 70 — 85% | < 50% (seuils trop permissifs) |
| Taux de verdict SUCCESS | 5 — 15% | > 30% (seuils trop laxistes) |
| Wallets uniques / jour | 500 — 3000 | < 100 (pipeline bloqué?) |
| Requêtes API DexScreener / heure | < 1000 | > 900 (proche du rate limit) |
| Requêtes API Helius / jour | < 30 000 | > 25 000 (budget mensuel menacé) |
| Latence ForensicWorker → verdict | < 16 minutes | > 20 minutes (backlog?) |
| Cartels détectés (cumul) | Croissant | Stagnant après 7 jours |

## 8.6 Schéma SQL — Ajouts v3 (live)

Nouveaux champs et table pour supporter le mode live :

| Table | Champ / Table | Type | Description |
| --- | --- | --- | --- |
| wallet_profiles | toxicity_score | REAL DEFAULT 0.5 | Taint normalisé par sigmoïde [0-1] |
| wallet_profiles | risk_score | REAL DEFAULT 0.5 | Score composite sigmoïde [0-1] |
| cartel_groups | confidence_score_v2 | REAL | Confiance sigmoïde avec volume_factor |
| token_events | p_exit_v1 | REAL | P_exit calculé avec formule linéaire |
| token_events | p_exit_v2 | REAL | P_exit calculé avec formule sigmoïde |
| (nouvelle table) | calibration_log | — | Historique des recalibrations hebdomadaires |

    -- CREATE TABLE calibration_log
    CREATE TABLE IF NOT EXISTS calibration_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calibrated_at DATETIME NOT NULL,
      param_name TEXT NOT NULL,
      old_value REAL NOT NULL,
      new_value REAL NOT NULL,
      improvement_pct REAL,
      tokens_evaluated INTEGER,
      accepted BOOLEAN DEFAULT TRUE
    );


# 9. Formule de sortie — P_exit

La formule P_exit détermine le prix de sortie optimal en combinant la performance observée du token avec le niveau de confiance du cartel. C’est la clé de voûte de la stratégie d’exit automatique.


> **Formule de prix de sortie P_exit = (MC_actuel / MC_profil) × Confiance_cartel Quand P_exit ≥ 1.0, le bot déclenche la vente. En dessous, on hold.**


## 9.1 Définition des variables


| Variable | Définition | Source |
| --- | --- | --- |
| MC_actuel | Market Cap actuel du token au moment de l’évaluation | DexScreener API (fdv) |
| MC_profil | Market Cap médian atteint par les tokens SUCCESS du même créateur | Calculé depuis token_events (médiane fdv_at_check WHERE verdict = SUCCESS) |
| Confiance_cartel | Score de confiance du cartel [0.0 — 1.0], basé sur le taux de survie et la cohérence historique du groupe | cartel_groups.confidence_score |


## 9.2 Logique d’interprétation


| P_exit | Interprétation | Action |
| --- | --- | --- |
| ≥ 1.5 | Le token a largement dépassé le potentiel estimé → zone de sur-performance | EXIT IMMÉDIAT — Prendre le profit |
| 1.0 — 1.49 | Le token a atteint le potentiel estimé du profil | EXIT PROGRESSIF — Vendre 50%, trailing stop sur le reste |
| 0.5 — 0.99 | Le token est en progression mais n’a pas encore atteint le seuil | HOLD — Maintenir la position |
| < 0.5 | Le token sous-performe par rapport au profil ou confiance cartel basse | WATCH — Préparer un stop-loss serré |


> **Impact de la Confiance_cartel Si un cartel a un confidence_score de 0.3 (cartel peu fiable), même un token qui atteint 3× son MC_profil ne déclenchera un P_exit qu’à 0.9. La confiance du cartel agit comme un modérateur de confiance global.**


## 9.3 Exemple concret

Soit un token créé par un wallet dont le MC médian des succès précédents est de 50 000 $ (MC_profil). Le token atteint actuellement 65 000 $ (MC_actuel). Le cartel a un confidence_score de 0.85.

    P_exit = (65000 / 50000) × 0.85 = 1.3 × 0.85 = 1.105

Résultat : P_exit = 1.105 → Le token est dans la zone [1.0 — 1.49] → EXIT PROGRESSIF. Le bot vend 50% de la position et place un trailing stop sur le reste.


# 10. Concept de cartel — Pool de wallets

On ne track pas des wallets isolés. On track des pools de wallets. Un cartel est un ensemble de wallets liés par des flux de financement et/ou des patterns comportementaux similaires.


## 10.1 Détection d’un cartel

Un cartel est identifié lorsque :


| Critère | Seuil | Méthode |
| --- | --- | --- |
| Funding commun | ≥ 3 wallets financés par la même source | Requête récursive sur wallet_ancestry |
| Activité temporelle | Lancements de tokens dans une fenêtre de ± 5 minutes | Corrélation timestamps dans token_events |
| Overlap de liquidité | Wallets qui ajoutent/retirent de la liquidité sur les mêmes paires | Analyse on-chain (hors scope SQL) |


## 10.2 Profil matriciel du cartel

Dès qu’on remonte au portefeuille principal du cartel, on applique un profil matriciel global. Ce profil agrège les features de tous les wallets membres pour produire le confidence_score et l’auto_strategy.

Confiance_cartel = (total_survival / (total_survival + total_rug)) × consistency_factor

Où consistency_factor est un bonus [0.8 — 1.2] basé sur l’écart-type des rug_rates individuels. Plus les membres sont cohérents, plus la confiance est élevée.

# 11. Interfaces TypeScript

Chaque table SQL est exposée via un Repository dédié.


| Repository | Table SQL | Méthodes clés |
| --- | --- | --- |
| WalletRepo | wallet_profiles | upsertWallet(), getByAddress(), updateStrategy(), getByCartel() |
| AncestryRepo | wallet_ancestry | addLink(), getAncestors(depth), getDescendants(), getChain() |
| TokenEventRepo | token_events | recordEvent(), getByCreator(), getMedianFDV(verdict) |
| CartelRepo | cartel_groups | upsertCartel(), detectCartels(), computeConfidence(), getMembers() |
| TaintLogRepo | taint_log | logTaint(), getHistory(wallet), getTotalByWallet() |
| MonitoringRepo | monitoring_queue | enqueue(), getDueTokens(), markProcessed() |


# 12. Critères d’acceptation


## 12.1 Fonctionnels

- Chaque token détecté par le ForensicWorker doit apparaître dans token_events sous 500ms
- Le verdict doit être prononcé dans les 30 secondes suivant l’échéance check_at
- La propagation du taint doit s’exécuter en cascade complète (jusqu’à depth 3) en < 200ms
- P_exit doit être recalculé toutes les 10 secondes pour les positions ouvertes
- La détection de cartels doit s’exécuter en batch toutes les 5 minutes

## 12.2 Performance

- Requête getByAddress() : < 5ms (index sur wallet_address)
- Requête getAncestors(depth=3) : < 50ms (index composite sur parent/child)
- Base capable de supporter 100 000+ wallets et 500 000+ token_events
- Calcul de P_exit : < 10ms par token (lookup médiane + cartel confidence)

## 12.3 Intégrité

- Chaque entrée taint_log doit être traçable jusqu’au token_event source
- La somme des taint_log.points_applied par wallet doit égaler wallet_profiles.taint_score
- Foreign keys enforcées : aucun orphelin dans wallet_ancestry ou token_events

# 13. Setup du projet — Étapes de création

Ce chapitre détaille les étapes concrètes pour initialiser le projet WalletSourceDB depuis zéro, de l’installation des dépendances jusqu’au premier token scanné.


## 11.1 Prérequis système


| Outil | Version minimum | Rôle |
| --- | --- | --- |
| Node.js | 18.x LTS ou supérieur | Runtime TypeScript / Workers |
| npm ou pnpm | 9.x+ / 8.x+ | Gestionnaire de paquets |
| TypeScript | 5.4+ | Langage principal (strict mode) |
| PostgreSQL | 15+ | Base de données (toutes phases) |
| Git | 2.40+ | Versioning + branches par phase |
| VS Code | 1.85+ | IDE principal + Claude Code |
| Claude Code CLI | Dernier stable | Agent de développement IA |


## 11.2 Initialisation du projet

Commandes d’initialisation dans l’ordre :

    # 1. Créer le répertoire projet
    mkdir walletsource-db && cd walletsource-db
    git init

    # 2. Initialiser Node.js + TypeScript
    npm init -y
    npm install typescript @types/node ts-node --save-dev
    npx tsc --init --strict --target ES2022 --module NodeNext
--moduleResolution NodeNext --outDir dist --rootDir src

    # 3. Installer les dépendances core
    npm install pg (node-postgres) ws dotenv
    npm install @types/pg (node-postgres) @types/ws --save-dev

    # 4. Installer les dépendances API
    npm install node-fetch csv-parse
    npm install @types/node-fetch --save-dev

    # 5. Installer les outils de qualité
    npm install eslint @typescript-eslint/eslint-plugin
@typescript-eslint/parser prettier vitest --save-dev


## 11.3 Structure de fichiers

L’arborescence cible du projet. Chaque dossier correspond à un composant du PRD (section 2).

    walletsource-db/
    ├── CLAUDE.md                  # Contexte projet pour Claude Code
    ├── .claude/
    │   ├── settings.json           # Hooks + permissions Claude Code
    │   ├── commands/               # Commandes slash custom
    │   │   ├── test-wallet.md      # /project:test-wallet
    │   │   ├── scan-token.md       # /project:scan-token
    │   │   └── seed-data.md        # /project:seed-data
    │   └── skills/                 # Skills spécifiques
    │       ├── solana-forensics/SKILL.md
    │       └── sigmoid-scoring/SKILL.md
    ├── src/
    │   ├── db/
    │   │   ├── schema.sql              # CREATE TABLE (5 tables)
    │   │   ├── migrations/             # ALTER TABLE (v2 fields)
    │   │   └── connection.ts           # Pool PostgreSQL
    │   ├── repositories/
    │   │   ├── WalletRepo.ts
    │   │   ├── AncestryRepo.ts
    │   │   ├── TokenEventRepo.ts
    │   │   ├── CartelRepo.ts
    │   │   ├── TaintLogRepo.ts
    │   │   └── MonitoringRepo.ts
    │   ├── workers/
    │   │   ├── ForensicWorker.ts       # Détection tokens WSS
    │   │   ├── RugScannerWorker.ts     # Verdicts DexScreener
    │   │   └── CalibrationWorker.ts    # Recalibration hebdomadaire sigmoïdes
    │   ├── scoring/
    │   │   ├── TaintScorer.ts          # Propagation taint
    │   │   ├── SigmoidScorer.ts        # Fonctions sigmoïdes (v2)
    │   │   └── PExitCalculator.ts      # Formule P_exit v1 + v2
    │   ├── cartels/
    │   │   └── CartelDetector.ts       # Clustering + détection
    │   ├── api/
    │   │   ├── HeliusClient.ts         # API Helius (ancestry)
    │   │   └── DexScreenerClient.ts    # API DexScreener (verdicts)
    │   ├── types/
    │   │   └── index.ts                # Interfaces TypeScript
    │   └── index.ts                    # Point d’entrée
    ├── tests/
    │   ├── repositories/
    │   ├── workers/
    │   ├── scoring/
    ├── tsconfig.json
    ├── package.json
    └── .env                            # API keys (gitignored)


## 13.4 Ordre d’implémentation par phase

Chaque phase correspond à une branche Git dédiée. On merge dans main après validation des critères d’acceptation (section 11).


| Phase | Branche Git | Fichiers à créer | Critère de validation |
| --- | --- | --- | --- |
| P1 — Schema | feat/schema | schema.sql, connection.ts, 6 Repos, types/index.ts | npm test : 100% CRUD OK |
| P2 — Verdict | feat/verdict | ForensicWorker.ts, RugScannerWorker.ts, MonitoringRepo.ts | Token détecté + verdict < 30s |
| P3 — Taint | feat/taint | TaintScorer.ts | Propagation depth 3 < 200ms |
| P4 — Profil | feat/profil | SigmoidScorer.ts, profile_vector logic | risk_score calculé [0-1] |
| P5 — Cartels | feat/cartels | CartelDetector.ts | Détection batch < 5 min |
| P6 — P_exit | feat/pexit | PExitCalculator.ts | P_exit v1 + v2 < 10ms |
| P7 — Dashboard | feat/dashboard | API REST + frontend | Visualisation opérationnelle |
| P8 — Sigmoïdes | feat/sigmoid | Migration v2, CalibrationWorker | Formules sigmoïdes actives + recalibration hebdo |


## 13.5 Variables d’environnement

    # .env — À créer à la racine (gitignored)
HELIUS_API_KEY=your_helius_key_here
DEXSCREENER_RATE_LIMIT=1000        # req/heure max
SOLANA_WSS_URL=wss://api.mainnet-beta.solana.com
DATABASE_URL=postgresql://localhost:5432/walletsource
PUMP_FUN_PROGRAM_ID=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
TAINT_DECAY_WEEKLY=0.95           # -5% par semaine
SIGMOID_K_CONFIDENCE=6.0
SIGMOID_ALPHA_PEXIT=3.0
SIGMOID_MU_TAINT=100
SIGMOID_SIGMA_TAINT=40


# 14. Claude Code Agent — Workflow de développement

Ce chapitre décrit comment utiliser Claude Code comme agent de développement dans VS Code pour accélérer la création du projet WalletSourceDB. Claude Code est un outil agentique : on lui donne un objectif haut niveau et il décompose les étapes, écrit le code, exécute les commandes, et itère jusqu’à la validation.


> **Prérequis : Claude Pro, Max, Team ou Enterprise, ou crédits API Anthropic. Installer Node.js 18+, VS Code 1.85+, et l’extension Claude Code depuis le VS Code Marketplace.**


## 11.1 Installation et configuration

Étapes d’installation de Claude Code dans l’environnement de développement :

Étape 1 — Installer le CLI : npm install -g @anthropic-ai/claude-code
Étape 2 — Authentification : Lancer claude dans le terminal et compléter l’OAuth via le navigateur, ou configurer la clé API via ANTHROPIC_API_KEY.
Étape 3 — Extension VS Code : Installer l’extension « Claude Code » par Anthropic depuis le Marketplace. Le panneau Claude apparaît dans la barre latérale.
Étape 4 — Configurer les permissions : Dans VS Code Settings > Extensions > Claude Code, définir initialPermissionMode sur « Plan » (recommandé pour le démarrage). Claude présente son plan avant d’agir.


## 11.2 Fichier CLAUDE.md — Contexte projet

Le fichier CLAUDE.md à la racine du projet est la mémoire persistante de Claude Code. Il est lu au début de chaque session et fournit le contexte complet du projet. C’est le fichier le plus important pour la productivité.

    # CLAUDE.md — WalletSourceDB

    ## Quick Facts
    - **Stack** : TypeScript strict, Node.js 18+, PostgreSQL (node-postgres)
    - **Test** : npm run test (Vitest)
    - **Lint** : npm run lint (ESLint + @typescript-eslint)
    - **Build** : npm run build (tsc)

    ## Architecture
    - src/db/ — Schéma SQL + connexion PostgreSQL
    - src/repositories/ — 6 Repositories (CRUD par table)
    - src/workers/ — ForensicWorker (WSS) + RugScannerWorker (DexScreener)
    - src/scoring/ — TaintScorer, SigmoidScorer, PExitCalculator
    - src/cartels/ — CartelDetector (clustering)
    - src/workers/CalibrationWorker.ts — Recalibration hebdomadaire des sigmoïdes
    - src/api/ — HeliusClient, DexScreenerClient
    - tests/ — Miroir de src/ avec .test.ts

    ## Règles de code
- TypeScript strict mode obligatoire, jamais de any (utiliser unknown)
- Prefer interfaces over types
- Pattern Repository pour tout accès DB
- Fonctions pures pour le scoring (testables unitairement)
- Tous les appels API avec rate limiting intégré (< 1000 req/h)
- Chaque nouveau fichier doit avoir un test associé
    - Nommage : PascalCase pour classes/interfaces, camelCase pour variables

    ## Formules clés
    - Taint : Taint(depth) = 50 × 0.7^depth (max depth 3)
    - Confidence sigmoïde : 1 / (1 + e^(-k × (survival_rate - 0.5)))
    - P_exit v2 : σ(α × (MC_ratio - 1)) × Confiance_cartel_v2
    - risk_score : w1×σ(rug_rate) + w2×toxicity + w3×σ(cartel_rug_rate)

    ## API externes
    - Pump.fun Program ID : 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
    - DexScreener : https://api.dexscreener.com/latest/dex/tokens/{addr}
    - Helius : https://api.helius.xyz/v0/addresses/{addr}/transactions


## 11.3 Hooks — Automatisations Claude Code

Les hooks exécutent des scripts automatiquement à des points précis du workflow de Claude Code. Contrairement aux instructions CLAUDE.md (qui sont consultatives), les hooks sont déterministes et garantissent l’exécution.

    // .claude/settings.json
    {
    "hooks": {
    "PreToolUse": [
    {
    "matcher": "Edit|Write",
    "hooks": [{
    "type": "command",
    "command": "[ \"$(git branch --show-current)\" != \"main\" ]
|| { echo '{\"block\": true, \"message\": \"Interdit sur main\"}'; exit 2; }",
    "timeout": 5
    }]
    }
],
    "PostToolUse": [
    {
    "matcher": "Edit|Write",
    "hooks": [{
    "type": "command",
    "command": "npx tsc --noEmit 2>&1 | head -20",
    "timeout": 30
    }]
    }
]
    }
    }

PreToolUse : Bloque toute écriture sur la branche main (force l’utilisation de branches feat/*).
PostToolUse : Vérifie automatiquement la compilation TypeScript après chaque édition. Claude voit les erreurs et les corrige immédiatement.


## 12.4 Skills — Connaissances domaine

Les Skills sont des fichiers SKILL.md dans .claude/skills/ qui fournissent à Claude Code des connaissances spécifiques au domaine. Claude les applique automatiquement quand le contexte est pertinent.

Skill 1 — Solana Forensics : .claude/skills/solana-forensics/SKILL.md. Contient la documentation du programme Pump.fun, les structures de transactions Solana, le format des réponses Helius/DexScreener, et les patterns de détection de rug pulls.
Skill 2 — Sigmoid Scoring : .claude/skills/sigmoid-scoring/SKILL.md. Contient les formules sigmoïdes (section 7), les ranges de paramètres de calibration, et les règles de conversion score → stratégie.


## 12.5 Commandes slash custom

Les commandes slash permettent de déclencher des workflows réutilisables. Elles sont définies dans .claude/commands/ et invocables via /project:nom-commande.


| Commande | Fichier | Action |
| --- | --- | --- |
| /project:test-wallet | test-wallet.md | Teste le pipeline complet pour un wallet donné : lookup DB, ancestry, taint, strategy |
| /project:scan-token | scan-token.md | Simule le scan d’un token : détection, verdict, propagation taint |


    # Exemple : .claude/commands/test-wallet.md
    ---
allowed-tools: Bash(npm test:*), Bash(npx ts-node:*)
description: Test le pipeline complet pour un wallet
    ---
Teste le wallet $ARGUMENTS dans WalletSourceDB :
1. Vérifie s’il existe dans wallet_profiles
2. Récupère son ancestry tree (depth 3)
3. Calcule son taint_score et toxicity_score
4. Détermine sa strategy (risk_score)
5. Si cartel : affiche le cartel et son confidence_score_v2
6. Simule un P_exit v1 et v2 pour son dernier token


## 14.6 Workflow agentique par phase

Pour chaque phase de développement, voici le prompt initial recommandé à donner à Claude Code. L’agent décompose le travail, crée les fichiers, écrit les tests, et itère.

Phase 1 — Prompt : « Crée le schéma SQL de WalletSourceDB (5 tables : wallet_profiles, wallet_ancestry, token_events, cartel_groups, taint_log) dans src/db/schema.sql. Puis implémente les 6 Repositories TypeScript dans src/repositories/ avec les méthodes décrites dans CLAUDE.md. Écris les tests unitaires pour chaque Repository. »

Phase 2 — Prompt : « Implémente le ForensicWorker qui se connecte au WSS Solana et détecte les tokens Pump.fun. Puis le RugScannerWorker qui interroge DexScreener toutes les 60s et applique la matrice de verdict (section 3 du PRD). Respecte le rate limit de 1000 req/h. »

Phase 3 — Prompt : « Implémente le TaintScorer avec la formule de propagation Taint(depth) = 50 × 0.7^depth. Il doit remonter l’arbre d’ancestry jusqu’à depth 3, ignorer les liens avec confidence < 0.7, et logger chaque propagation dans taint_log. Cascade complète en < 200ms. »

Phase 4-5 — Prompt : « Implémente le SigmoidScorer (section 7 du PRD) avec les formules de toxicity_score, risk_score, et confidence_cartel_v2. Puis le CartelDetector qui identifie les cartels via wallet_ancestry (funding commun, activité temporelle). »

Phase 6 — Prompt : « Implémente le PExitCalculator avec la formule v1 (linéaire) et v2 (sigmoïde). Recalcul toutes les 10s pour les positions ouvertes. Logique d’exit automatique selon les seuils PRD. »

Phase 8 — Prompt : « Implémente le CalibrationWorker (recalibration hebdomadaire des paramètres sigmoïdes). Extraction des token_events des 7 derniers jours, évaluation des métriques, micro-grid search ±10% sur chaque paramètre, garde-fous ±50% des valeurs initiales, logging dans calibration_log. Cron chaque dimanche 03:00 UTC. »


## 14.7 Sub-agents et parallélisme

Claude Code supporte les sub-agents pour déléguer des tâches spécialisées dans un contexte séparé. Cela garde la conversation principale propre et économise le contexte.


| Cas d’usage | Prompt sub-agent | Avantage |
| --- | --- | --- |
| Recherche codebase | « Utilise un sub-agent pour investiguer comment notre système de rate limiting fonctionne » | Explore sans polluer le contexte principal |
| Tests parallèles | « Lance un sub-agent pour écrire les tests de CartelDetector pendant que tu implémentes PExitCalculator » | Développement parallèle |
| Code review | « Sub-agent : review le code de TaintScorer pour les edge cases et la performance » | Review automatique |
| Documentation | « Sub-agent : génère la JSDoc pour tous les fichiers dans src/scoring/ » | Doc sans interrompre le dev |


## 14.8 Modes de permission

Claude Code offre trois modes de permission pour contrôler le niveau d’autonomie de l’agent :


| Mode | Comportement | Recommandé pour |
| --- | --- | --- |
| Plan | Claude décrit son plan complet avant d’agir. Le plan s’ouvre en Markdown éditable où on peut ajouter des commentaires inline avant validation. | Démarrage projet, phases critiques (P1, P3, P6) |
| Normal | Claude demande permission avant chaque action (édition, commande terminal). On voit un diff avant/après pour chaque fichier. | Développement quotidien, itérations |
| Auto-accept | Claude agit sans demander. Les éditions s’appliquent automatiquement. Utile avec les hooks de sécurité (branch protection, tsc check). | Tâches bien définies, refactoring, tests |


> **Conseil : Démarrer chaque nouvelle phase en mode Plan, passer en Normal une fois le plan validé, et utiliser Auto-accept pour les tâches répétitives (tests, formatting, documentation).**


## 14.9 Bonnes pratiques

1. Un objectif par session : Chaque session Claude Code doit avoir un objectif clair et limité. « Implémente TaintScorer » est bon. « Fais tout le projet » est mauvais.
2. Compacter régulièrement : Utiliser /compact pour résumer le contexte dans les sessions longues. Ajouter dans CLAUDE.md : « Lors de la compaction, toujours préserver la liste des fichiers modifiés et les commandes de test ».
3. Corriger tôt : Si Claude part dans la mauvaise direction, corriger immédiatement (Esc pour stopper, puis rediriger). Les meilleurs résultats viennent de boucles de feedback serrées.
4. Spec d’abord, code ensuite : Pour les tâches complexes, demander à Claude de rédiger un SPEC.md d’abord, puis ouvrir une nouvelle session pour l’implémentation. La session fraîche a un contexte propre.
5. Commits fréquents : Committer après chaque étape réussie. Les checkpoints de Claude Code permettent de revenir en arrière si une modification casse quelque chose.
6. Tests en continu : Configurer un hook PostToolUse qui lance npm test après chaque édition de fichier .test.ts. Claude voit les échecs et corrige automatiquement.


## 14.10 Intégration navigateur (optionnel)

Claude Code peut se connecter à Chrome via l’extension Claude in Chrome pour tester les applications web, lire les logs console, et automatiser les workflows navigateur. Utile en Phase 7 (Dashboard) pour tester l’interface de visualisation des cartels.

Activation : Installer l’extension Claude in Chrome (v1.0.36+). Dans Claude Code, taper @browser suivi de la commande : « @browser Ouvre localhost:3000 et vérifie que le dashboard affiche les 10 cartels avec le plus haut confidence_score ».

# 15. Roadmap


| Phase | Priorité | Livrable |
| --- | --- | --- |
| Phase 1 — Schema & Repos | P0 | Création des 5 tables SQL + 6 Repositories TypeScript |
| Phase 2 — Verdict Pipeline | P0 | Intégration ForensicWorker → MonitoringRepo → RugScannerWorker |
| Phase 3 — Taint Propagation | P0 | TaintScorer avec decay exponentiel et propagation récursive |
| Phase 4 — Profil Matriciel | P1 | Calcul du profile_vector + assignation auto de strategy |
| Phase 5 — Détection Cartels | P1 | Algorithme de clustering sur wallet_ancestry + batch détection |
| Phase 6 — Formule P_exit | P1 | Calcul P_exit temps réel + logique d’exit automatique |
| Phase 7 — Dashboard & Alertes | P2 | Visualisation des cartels, scores, et historique de trades |
| Phase 8 — Fonctions Sigmoïdes | P1 | Remplacement formules linéaires par sigmoïdes + calibration |


# 16. Questions résolues


| # | Question | Contexte | Suggestion |
| --- | --- | --- | --- |
| Q1 | PostgreSQL | Choix définitif : PostgreSQL 15+ avec node-postgres (pg). Permet le multi-instance, le dashboard, et les requêtes complexes sur les cartels. | DÉCIDÉ : PostgreSQL |
| Q2 | Depth max = 3 | Confirmé : au-delà de depth 3, les points sont négligeables (< 12 pts) et le coût de requête augmente. | DÉCIDÉ : depth 3 max |
| Q3 | Decay automatique du taint | Confirmé : un wallet inactif voit son taint_score diminuer de -5% par semaine. Implémenté via un cron hebdomadaire : taint_score *= 0.95 pour les wallets sans activité depuis > 7 jours. | DÉCIDÉ : -5%/semaine |
| Q4 | Seuil confidence ancestry = 0.7 | Confirmé : les liens avec confidence < 0.7 sont ignorés lors de la propagation du taint. | DÉCIDÉ : seuil 0.7 |
| Q5 | MC_profil = médiane | Confirmé : la médiane est plus robuste aux outliers. MC_profil = médiane des fdv_at_check WHERE verdict = SUCCESS. | DÉCIDÉ : médiane |
| Q6 | consistency_factor = coefficient de variation | Confirmé : CV = écart-type / moyenne des rug_rates individuels. Plus le CV est bas (membres cohérents), plus le bonus est élevé [0.8-1.2]. | DÉCIDÉ : CV normalisé |
| Q7 | Phase froide = 3 jours minimum | Le système passe en phase tiède après 3 jours OU quand 1000 wallets ont ≥ 3 tokens observés (le premier des deux). | DÉCIDÉ : 3j / 1000 wallets |
| Q8 | Recalibration hebdomadaire | Confirmé : CalibrationWorker chaque dimanche 03:00 UTC avec garde-fous ±50% des valeurs initiales. | DÉCIDÉ : hebdo dim 03:00 |


# Annexe A — Formats de réponse API

Cette annexe documente la structure JSON exacte des APIs externes utilisées par le système. Indispensable pour que l’agent puisse implémenter les clients API sans deviner.


## A.1 DexScreener API

Endpoint : GET https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}
Rate limit : 300ms entre chaque appel (respecté par le RugScannerWorker)

    // Réponse type DexScreener
    interface DexScreenerResponse {
pairs: DexScreenerPair[] | null;  // null = token sans paire (RUG_NO_PAIR)
    }

    interface DexScreenerPair {
chainId: string;                  // 'solana'
dexId: string;                    // 'raydium'
pairAddress: string;              // Adresse de la paire LP
baseToken: {
address: string;                // Token address
name: string;
symbol: string;
    };
quoteToken: {
address: string;                // SOL ou USDC
symbol: string;
    };
priceUsd: string;                 // Prix en USD (string)
fdv: number;                      // Fully Diluted Valuation → fdv_at_check
liquidity: {
usd: number;                    // Liquidité totale USD → liquidity_at_check
base: number;
quote: number;
    };
priceChange: {
m5: number;                     // Variation 5 min (%) → price_change_5m
h1: number;
h6: number;
h24: number;
    };
volume: { h24: number; h6: number; h1: number; m5: number; };
txns: { h24: { buys: number; sells: number; }; };
    }

Mapping vers token_events : pairs === null → verdict RUG_NO_PAIR. pairs[0].liquidity.usd → liquidity_at_check. pairs[0].fdv → fdv_at_check. pairs[0].priceChange.m5 → price_change_5m. pairs[0].pairAddress → dexscreener_pair.


## A.2 Helius API

Endpoint : GET https://api.helius.xyz/v0/addresses/{address}/transactions?api-key={key}&type=TRANSFER
Rate limit : ~5 credits par appel, 1M credits/mois (plan gratuit)

    // Réponse type Helius (Enhanced Transaction)
    interface HeliusTransaction {
signature: string;                // Hash de la transaction → funding_tx
timestamp: number;                // Unix timestamp (secondes)
type: string;                     // 'TRANSFER', 'SWAP', etc.
fee: number;                      // Frais en lamports
feePayer: string;                 // Wallet qui paie les frais
nativeTransfers: NativeTransfer[];
tokenTransfers: TokenTransfer[];
    }

    interface NativeTransfer {
fromUserAccount: string;          // → parent_wallet
toUserAccount: string;            // → child_wallet
amount: number;                   // Lamports (diviser par 1e9 pour SOL)
    }

    interface TokenTransfer {
fromUserAccount: string;
toUserAccount: string;
mint: string;                     // Token mint address
amount: number;                   // En unités de base du token
tokenStandard: string;            // 'Fungible' | 'NonFungible'
    }

Mapping vers wallet_ancestry : nativeTransfers[].fromUserAccount → parent_wallet. nativeTransfers[].toUserAccount → child_wallet. nativeTransfers[].amount / 1e9 → funding_amount_sol. signature → funding_tx. timestamp → detected_at.


## A.3 Solana WebSocket (WSS)

Endpoint : wss://api.mainnet-beta.solana.com (ou RPC privé via Helius: wss://mainnet.helius-rpc.com/?api-key={key})

    // Subscription pour détecter les tokens Pump.fun
    // Méthode: logsSubscribe avec mention du program ID
    {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "logsSubscribe",
    "params": [
    { "mentions": ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"] },
    { "commitment": "confirmed" }
]
    }

Réponse : Chaque notification contient signature (tx hash) et logs[]. Le ForensicWorker parse les logs pour extraire le token address et le creator wallet, puis enqueue dans monitoring_queue.


# Annexe B — Schéma monitoring_queue

La table monitoring_queue est le buffer entre le ForensicWorker (détection) et le RugScannerWorker (verdict). Non incluse dans les 5 tables principales car elle est transitoire.


| Colonne | Type | Description |
| --- | --- | --- |
| id | INTEGER PRIMARY KEY AUTOINCREMENT | Identifiant unique |
| token_address | TEXT NOT NULL | Adresse du token détecté |
| creator_wallet | TEXT NOT NULL | Wallet créateur du token |
| detected_at | DATETIME NOT NULL | Timestamp de détection WSS |
| check_at | DATETIME NOT NULL | detected_at + 15 minutes (échéance du verdict) |
| status | TEXT DEFAULT 'PENDING' | PENDING \| PROCESSING \| DONE \| RETRY |
| retry_count | INTEGER DEFAULT 0 | Nombre de tentatives (max 3) |
| processed_at | DATETIME | Timestamp du verdict (NULL si PENDING) |


-- CREATE TABLE monitoring_queue
    CREATE TABLE IF NOT EXISTS monitoring_queue (
id INTEGER PRIMARY KEY AUTOINCREMENT,
token_address TEXT NOT NULL,
creator_wallet TEXT NOT NULL,
detected_at DATETIME NOT NULL,
check_at DATETIME NOT NULL,
status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','DONE','RETRY')),
retry_count INTEGER DEFAULT 0,
processed_at DATETIME
);
    CREATE INDEX idx_mq_check_at ON monitoring_queue(check_at) WHERE status = 'PENDING';


# Annexe C — Patterns techniques transverses

Conventions techniques que l’agent doit appliquer dans tout le projet.


## C.1 Gestion d’erreurs

Chaque couche du système utilise un pattern d’erreur typé pour permettre un handling précis en amont.

    // src/types/errors.ts

    export class WalletSourceError extends Error {
constructor(
message: string,
public readonly code: ErrorCode,
public readonly context?: Record<string, unknown>
) {
super(message);
this.name = 'WalletSourceError';
    }
    }

    export enum ErrorCode {
    // API errors
DEXSCREENER_TIMEOUT = 'DEXSCREENER_TIMEOUT',
DEXSCREENER_RATE_LIMIT = 'DEXSCREENER_RATE_LIMIT',
HELIUS_TIMEOUT = 'HELIUS_TIMEOUT',
HELIUS_RATE_LIMIT = 'HELIUS_RATE_LIMIT',
WSS_DISCONNECTED = 'WSS_DISCONNECTED',
    // DB errors
DB_CONSTRAINT_VIOLATION = 'DB_CONSTRAINT_VIOLATION',
DB_NOT_FOUND = 'DB_NOT_FOUND',
    // Business logic errors
INVALID_VERDICT = 'INVALID_VERDICT',
ANCESTRY_MAX_DEPTH = 'ANCESTRY_MAX_DEPTH',
CARTEL_DETECTION_FAILED = 'CARTEL_DETECTION_FAILED',
    }

Règle pour l’agent : Chaque appel API est wrappé dans un try/catch. Les erreurs réseau déclenchent un retry (max 3, backoff exponentiel). Les erreurs business sont loggées et propagées. Jamais de catch vide.


## C.2 Logging

    // src/utils/logger.ts
    // Utiliser pino pour le logging structuré
    // npm install pino

    import pino from 'pino';

    export const logger = pino({
level: process.env.LOG_LEVEL || 'info',
transport: {
target: 'pino-pretty',
options: { colorize: true, translateTime: 'SYS:HH:MM:ss' }
    }
    });

    // Usage dans les workers :
    // logger.info({ token, wallet }, 'Token detected');
    // logger.warn({ error: err.code }, 'DexScreener rate limited');
    // logger.error({ err, context }, 'Taint propagation failed');


## C.3 Patterns de test (Vitest)

Convention : chaque fichier src/X.ts a un test tests/X.test.ts. Les tests de repos utilisent une DB in-memory.

    // tests/repositories/WalletRepo.test.ts
    import { describe, it, expect, beforeEach } from 'vitest';
    import { Pool } from 'pg';
    import { WalletRepo } from '../../src/repositories/WalletRepo';

describe('WalletRepo', () => {
let db: Database.Database;
let repo: WalletRepo;

beforeEach(() => {
db = // Utiliser pg-mem pour les tests in-memory
import { newDb } from 'pg-mem';
const db = newDb().adapters.createPg();;
    // Exécuter schema.sql pour créer les tables
    const schema = fs.readFileSync('src/db/schema.sql', 'utf-8');
db.exec(schema);
repo = new WalletRepo(db);
    });

describe('upsertWallet', () => {
it('crée un nouveau wallet', () => {
    const wallet = repo.upsertWallet({
wallet_address: 'ABC123...',
first_seen_at: new Date().toISOString(),
    });
expect(wallet).toBeDefined();
expect(wallet.rug_count).toBe(0);
expect(wallet.strategy).toBe('WATCH');
    });

it('incrémente rug_count sur un wallet existant', () => {
repo.upsertWallet({ wallet_address: 'ABC123...' });
repo.incrementRug('ABC123...');
    const w = repo.getByAddress('ABC123...');
expect(w?.rug_count).toBe(1);
expect(w?.taint_score).toBe(50);
    });
    });

describe('getByAddress', () => {
it('retourne null si wallet inexistant', () => {
expect(repo.getByAddress('UNKNOWN')).toBeNull();
    });
    });
    });

    // tests/scoring/TaintScorer.test.ts
describe('TaintScorer', () => {
it('propage 50 pts au depth 0', () => { ... });
it('propage 35 pts au depth 1 (50 × 0.7)', () => { ... });
it('ignore les liens avec confidence < 0.7', () => { ... });
it('ne dépasse pas depth 3', () => { ... });
it('log chaque propagation dans taint_log', () => { ... });
    });

    // tests/scoring/SigmoidScorer.test.ts
describe('SigmoidScorer', () => {
it('retourne 0.5 pour taint_score = 100 (mu)', () => { ... });
it('retourne ~0.924 pour taint_score = 200', () => { ... });
it('risk_score AVOID pour rug_rate = 0.9', () => { ... });
it('risk_score LONG pour rug_rate = 0.1', () => { ... });
it('confidence_v2 pénalise les cartels avec < N_min tokens', () => { ... });
    });


## C.4 Scripts package.json

    // package.json — section scripts
    {
    "scripts": {
    "build": "tsc",
    "dev": "ts-node src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src/ tests/ --ext .ts",
    "lint:fix": "eslint src/ tests/ --ext .ts --fix",
    "type-check": "tsc --noEmit",
    "start": "ts-node src/index.ts",
    "start:dev": "ts-node --watch src/index.ts"
    }
    }


## C.5 Critères de validation par phase — Checklist agent

L’agent doit exécuter ces commandes après chaque phase et vérifier que tous les tests passent avant de merger.


| Phase | Commande de validation | Critère de succès |
| --- | --- | --- |
| P1 Schema | npm test -- tests/repositories/ | 6/6 repos : CRUD insert, get, update, delete OK |
| P2 Verdict | npm test -- tests/workers/ | ForensicWorker détecte token + RugScannerWorker émet verdict < 30s |
| P3 Taint | npm test -- tests/scoring/TaintScorer | Propagation depth 0-3 correcte, liens < 0.7 ignorés, taint_log rempli |
| P4 Profil | npm test -- tests/scoring/SigmoidScorer | toxicity_score correct, risk_score dans [0-1], strategy assignée |
| P5 Cartels | npm test -- tests/cartels/ | Détection ≥ 1 cartel sur données de test, confidence_score_v2 calculé |
| P6 P_exit | npm test -- tests/scoring/PExitCalculator | P_exit v1 et v2 conformes aux tableaux section 9.2 et 7.3 |
| GLOBAL | npm run type-check && npm run lint && npm test | 0 erreurs TypeScript, 0 warnings ESLint, 100% tests pass |


---


# Annexe D — Détails techniques d'implémentation

Cette annexe comble les gaps techniques que l'agent doit connaître pour implémenter le projet sans ambiguïté.

## D.1 ForensicWorker — Parsing des logs WSS Pump.fun

Le ForensicWorker utilise **Helius Enhanced WebSockets** (transactionSubscribe) plutôt que le logsSubscribe standard de Solana, car il fournit les transactions complètes parsées en temps réel.

**Méthode recommandée — Helius Geyser WebSocket :**

    // Subscription Helius Enhanced WebSocket
    const WebSocket = require('ws');
    const ws = new WebSocket('wss://atlas-mainnet.helius-rpc.com?api-key=YOUR_API_KEY');

    function sendRequest(ws: WebSocket) {
      const request = {
        jsonrpc: "2.0",
        id: 420,
        method: "transactionSubscribe",
        params: [
          {
            failed: false,
            accountInclude: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]
          },
          {
            commitment: "confirmed",
            encoding: "jsonParsed",
            transactionDetails: "full",
            maxSupportedTransactionVersion: 0
          }
        ]
      };
      ws.send(JSON.stringify(request));
    }

**Extraction du token et du créateur depuis la réponse :**

    // Structure de la réponse Helius Enhanced WebSocket
    interface HeliusWSMessage {
      params: {
        result: {
          signature: string;                    // → funding_tx
          transaction: {
            meta: {
              logMessages: string[];            // Chercher "Program log: Instruction: Create"
            };
            transaction: {
              message: {
                accountKeys: { pubkey: string }[];
              };
            };
          };
        };
      };
    }

    // Parsing dans le handler on('message'):
    ws.on('message', (data: Buffer) => {
      const msg: HeliusWSMessage = JSON.parse(data.toString());
      const result = msg.params.result;
      const logs = result.transaction.meta.logMessages;
      const accountKeys = result.transaction.transaction.message.accountKeys.map(ak => ak.pubkey);

      // Détecter un token Pump.fun : chercher "Instruction: Create" dans les logs
      if (logs && logs.some(log => log.includes('Program log: Instruction: Create'))) {
        const creatorWallet = accountKeys[0];   // Le premier account = signer/creator
        const tokenMint = accountKeys[1];       // Le deuxième account = mint address du token

        // Enqueue dans monitoring_queue
        monitoringRepo.enqueue({
          token_address: tokenMint,
          creator_wallet: creatorWallet,
          detected_at: new Date().toISOString(),
          check_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        });

        logger.info({ token: tokenMint, wallet: creatorWallet }, 'Pump.fun token detected');
      }
    });

**Méthode alternative — PumpPortal WebSocket (plus simple, API tierce) :**

    // PumpPortal fournit un WebSocket dédié qui envoie directement les token creation events
    const ws = new WebSocket("wss://pumpportal.fun/api/data");

    ws.on("open", () => {
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

    ws.on("message", (data: Buffer) => {
      const event = JSON.parse(data.toString());
      // event.mint = token address
      // event.traderPublicKey = creator wallet
      // event.signature = transaction signature
      if (event.mint) {
        monitoringRepo.enqueue({
          token_address: event.mint,
          creator_wallet: event.traderPublicKey,
          detected_at: new Date().toISOString(),
          check_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        });
      }
    });

**Décision recommandée :** Utiliser Helius Enhanced WebSocket comme source primaire (plus fiable, contrôle total). PumpPortal comme fallback en cas de déconnexion Helius.

## D.2 PostgreSQL — Syntaxe spécifique

Le schéma SQL doit utiliser la syntaxe PostgreSQL, pas SQLite :

    -- Colonne générée (PostgreSQL syntax)
    rug_rate REAL GENERATED ALWAYS AS (
      CASE WHEN (rug_count + survival_count + neutral_count) > 0
        THEN rug_count::REAL / (rug_count + survival_count + neutral_count)
        ELSE 0
      END
    ) STORED,

    -- AUTOINCREMENT → GENERATED ALWAYS AS IDENTITY
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- DATETIME → TIMESTAMPTZ
    detected_at TIMESTAMPTZ NOT NULL,

    -- TEXT avec CHECK → utiliser un ENUM ou CHECK
    status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','DONE','RETRY')),

    -- Ou mieux, un type ENUM PostgreSQL :
    CREATE TYPE verdict_type AS ENUM ('RUG', 'SUCCESS', 'NEUTRAL');
    CREATE TYPE strategy_type AS ENUM ('AVOID', 'SHORT', 'WATCH', 'LONG');
    CREATE TYPE queue_status AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'RETRY');

## D.3 Pool PostgreSQL — Configuration connection.ts

    // src/db/connection.ts
    import { Pool } from 'pg';
    import fs from 'fs';
    import path from 'path';

    let pool: Pool | null = null;

    export function getPool(): Pool {
      if (!pool) {
        pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 20,                    // Max 20 connexions simultanées
          idleTimeoutMillis: 30000,   // Fermer les connexions idle après 30s
          connectionTimeoutMillis: 5000, // Timeout connexion 5s
        });

        // Exécuter schema.sql au premier appel
        const schema = fs.readFileSync(
          path.join(__dirname, 'schema.sql'), 'utf-8'
        );
        pool.query(schema).catch(err => {
          console.error('Schema initialization failed:', err);
          process.exit(1);
        });

        // Graceful shutdown
        process.on('SIGINT', async () => {
          await pool?.end();
          process.exit(0);
        });
      }
      return pool;
    }

## D.4 Rate Limiter partagé entre workers

    // src/utils/rateLimiter.ts
    export class RateLimiter {
      private timestamps: number[] = [];

      constructor(
        private maxRequests: number = 1000,
        private windowMs: number = 60 * 60 * 1000  // 1 heure
      ) {}

      async acquire(): Promise<boolean> {
        const now = Date.now();
        // Supprimer les timestamps hors fenêtre
        this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

        if (this.timestamps.length >= this.maxRequests) {
          return false;  // Rate limit atteint
        }

        this.timestamps.push(now);
        return true;
      }

      getRemaining(): number {
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
        return this.maxRequests - this.timestamps.length;
      }
    }

    // Singleton partagé entre tous les workers
    export const globalRateLimiter = new RateLimiter(1000, 60 * 60 * 1000);

DexScreenerClient et HeliusClient doivent tous deux appeler `globalRateLimiter.acquire()` avant chaque requête. Si false → re-enqueue le token.

## D.5 CartelDetector — Algorithme de similarité

Le critère 3 ("overlap comportemental") utilise la **similarité cosinus** entre les profile_vectors des wallets :

    // Similarité cosinus entre deux profile_vectors
    function cosineSimilarity(a: number[], b: number[]): number {
      const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
      const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
      return normA && normB ? dotProduct / (normA * normB) : 0;
    }

    // Deux wallets sont "comportementalement similaires" si cosine > 0.85

## D.6 CalibrationWorker — Calcul du PnL théorique

Le PnL théorique simule un achat au moment de la détection et une vente selon P_exit :

    // Pour chaque token SUCCESS du créateur :
    // - Prix d'achat simulé = fdv_at_check au moment du verdict (on suppose achat à ce prix)
    // - Prix de vente simulé = fdv_at_check × P_exit_v2
    // - PnL = (prix_vente - prix_achat) / prix_achat × 100 (en %)
    //
    // Pour les tokens RUG (qu'on n'aurait PAS dû acheter) :
    // - Si le wallet était classé AVOID → PnL = 0 (correct, on n'a pas acheté)
    // - Si le wallet était classé LONG/WATCH → PnL = -100% (perte totale simulée)

## D.7 Setup PostgreSQL — Docker

    # docker-compose.yml (à la racine du projet)
    version: '3.8'
    services:
      db:
        image: postgres:15
        environment:
          POSTGRES_DB: walletsource
          POSTGRES_USER: walletsource
          POSTGRES_PASSWORD: walletsource_dev
        ports:
          - "5432:5432"
        volumes:
          - pgdata:/var/lib/postgresql/data

    volumes:
      pgdata:

    # Démarrer : docker-compose up -d
    # DATABASE_URL=postgresql://walletsource:walletsource_dev@localhost:5432/walletsource

## D.8 Helius Pagination

    // Si un wallet a plus de 100 transactions, paginer avec le paramètre 'before' :
    async function getAllTransactions(address: string, apiKey: string): Promise<HeliusTransaction[]> {
      let allTxs: HeliusTransaction[] = [];
      let before: string | undefined = undefined;

      while (true) {
        const url = new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);
        url.searchParams.set('api-key', apiKey);
        url.searchParams.set('type', 'TRANSFER');
        url.searchParams.set('limit', '100');
        if (before) url.searchParams.set('before', before);

        const res = await fetch(url.toString());
        const txs: HeliusTransaction[] = await res.json();

        if (txs.length === 0) break;
        allTxs.push(...txs);
        before = txs[txs.length - 1].signature;

        // Max 500 transactions par wallet pour éviter de vider le budget Helius
        if (allTxs.length >= 500) break;
      }

      return allTxs;
    }


*— Fin du document —*