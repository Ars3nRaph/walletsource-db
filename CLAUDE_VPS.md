# WalletSourceDB v4.0 — Guide Claude Code VPS

**Context pour Claude Code sur VPS Production**

Ce document aide Claude Code à comprendre le projet WalletSourceDB déployé sur un VPS.

---

## 🎯 Objectif du Projet

**WalletSourceDB v4.0** est un système d'intelligence forensique qui détecte et analyse les ruggers sur Pump.fun (Solana).

**Stratégie v4.0 "Ride the Rugger":**
- Au lieu d'éviter les ruggers, on **exploite leur prévisibilité**
- Construit des **playbooks** basés sur les patterns temporels (time_to_peak, time_to_rug)
- Génère des signaux BUY/SELL pour trader les rugs **avant** qu'ils n'arrivent

---

## 📁 Architecture VPS

```
~/apps/walletsource-db/
├── src/                    # Source TypeScript
│   ├── workers/
│   │   ├── ForensicWorker.ts        # Détecte tokens via Solana WSS
│   │   └── TokenTracker.ts          # Tracking 30s×10min (20 snapshots)
│   ├── scoring/
│   │   ├── PlaybookBuilder.ts       # Construit playbooks (RIDE/FADE/AVOID/WATCH)
│   │   └── SigmoidScorer.ts         # Calculs toxicity, risk scores
│   ├── execution/
│   │   ├── TradeExecutor.ts         # Génère signaux BUY/SELL
│   │   └── PaperTradeExecutor.ts    # Mode paper trading (logs)
│   └── repositories/                # Accès PostgreSQL
│
├── scripts/
│   ├── start-production.sh          # Démarrer app (PM2)
│   ├── monitor-production.sh        # Dashboard CLI
│   ├── start-dashboard.sh           # Démarrer web dashboard
│   └── web-dashboard/               # Dashboard web (Express)
│
├── dist/                   # Build TypeScript (généré)
├── data/                   # Logs et paper trades
│   ├── paper-trades.log
│   └── walletsource.log
│
├── .env                    # Configuration (SECRETS - ne pas commiter!)
└── package.json
```

---

## ⚙️ Configuration Actuelle (Optimisée)

### Tracking Parameters
```typescript
POLL_INTERVAL_MS = 30 * 1000;        // 30 secondes (20 snapshots par token)
TRACKING_DURATION_MS = 10 * 60 * 1000; // 10 minutes
ACTIVE_SLOTS = 135;                   // Tokens simultanés (90% rate limit)
```

### Capacité
- **135 slots** × 6 cycles/h = **810 tokens/h**
- **API usage:** 270 req/min (90% du rate limit 300 req/min)
- **Snapshots:** 20 par token (excellente précision)

### Database (PostgreSQL)
- **8 tables** principales
- **Connection:** localhost:5432
- **User:** walletsource
- **Database:** walletsource

---

## 🚀 Commandes Essentielles

### Gérer l'Application

```bash
# Voir status
pm2 status

# Logs en temps réel
pm2 logs walletsource-db

# Monitoring CLI
./scripts/monitor-production.sh

# Restart après modif code
git pull origin feat/live
npm run build
pm2 restart walletsource-db
```

### Dashboard Web

```bash
# Démarrer dashboard
./scripts/start-dashboard.sh

# Accéder
http://your-vps-ip:3001

# Logs dashboard
pm2 logs walletsource-dashboard
```

### Database

```bash
# Connection PostgreSQL
psql -U walletsource -d walletsource -h localhost

# Queries utiles
SELECT COUNT(*) FROM token_events;
SELECT COUNT(*) FROM wallet_profiles WHERE rugger_playbook IS NOT NULL;
SELECT status, COUNT(*) FROM monitoring_queue GROUP BY status;
```

---

## 📊 Fichiers Critiques à Connaître

### 1. `.env` — Configuration Secrète
**IMPORTANT:** Contient les clés API, ne JAMAIS commiter!

```bash
HELIUS_API_KEY=your_key
SOLANA_WSS_URL=wss://atlas-mainnet.helius-rpc.com?api-key=your_key
DATABASE_URL=postgresql://walletsource:password@localhost:5432/walletsource
PAPER_TRADING_MODE=true  # true pour paper trading, false pour real trading
```

### 2. `src/workers/TokenTracker.ts` — Cœur du Système
**Lignes critiques:**
- **19:** `POLL_INTERVAL_MS = 30 * 1000` (fréquence snapshots)
- **20:** `TRACKING_DURATION_MS = 10 * 60 * 1000` (durée tracking)
- **141:** `if (activeCount >= 135 || remainingQuota < 30)` (capacité max)
- **24-31:** `THRESHOLDS` (verdicts RUG/SUCCESS/NEUTRAL)

### 3. `src/scoring/PlaybookBuilder.ts` — Analyse Ruggers
**Logique:**
- Agrège tous les RUGs d'un wallet (≥3 requis)
- Calcule avg_time_to_peak, avg_time_to_rug, consistency_score
- Détermine fenêtres temporelles (entry_window, exit_window)
- Recommande stratégie: RIDE (trade), FADE (short), WATCH (attendre), AVOID (ignorer)

**Ligne 201:** `if (avgPeakMC < 500) return 'AVOID';` — Instant rugs non tradables

### 4. `src/execution/TradeExecutor.ts` — Signaux BUY/SELL
**Filtre:**
- **Ligne 91-118:** Ne trade que les wallets avec playbook RIDE et consistency ≥ 0.70
- **Ligne 158:** Bloque entry si `currentMC > avg_peak_mc * 0.7` (entry ratée)

**Timeline RIDE:**
```
0min ─── entry_window ─── hold ─── exit_window ─── past_exit
BUY 100%    HOLD 0%      HOLD     SELL progressive   SELL 100%
```

### 5. `data/paper-trades.log` — Logs Trading
Format JSON par ligne:
```json
{
  "timestamp": "2024-03-07T12:34:56.789Z",
  "token": "TokenAddress...",
  "elapsed_min": "5.50",
  "current_mc": 45000,
  "action": "BUY",
  "confidence": "0.875",
  "percentage": 100,
  "reason": "Entry window (0-4.9 min)",
  "strategy": "RIDE"
}
```

---

## 🗄️ Schema PostgreSQL (8 Tables)

### 1. `wallet_profiles`
Profils wallets avec playbooks et scores.

**Colonnes clés:**
- `wallet_address` (PK)
- `rug_count`, `survival_count`, `neutral_count`
- `rugger_playbook` (JSONB) — playbook prédictif
- `playbook_confidence` — consistency_score
- `strategy` — RIDE/FADE/WATCH/AVOID

### 2. `token_events`
Tokens détectés avec verdicts et lifecycle data.

**Colonnes clés:**
- `token_address` (PK)
- `creator_wallet` (FK)
- `verdict` — RUG_NO_PAIR, RUG_METRICS, SUCCESS, NEUTRAL
- `peak_mc`, `peak_at`, `time_to_peak_min`, `time_to_rug_min`

### 3. `token_snapshots`
Snapshots toutes les 30s pendant 10min (20 snapshots/token).

**Colonnes:**
- `token_address` (FK)
- `snapshot_at`, `fdv`, `liquidity_usd`, `price_usd`

### 4. `monitoring_queue`
Queue de tracking.

**Status:**
- `PENDING` — En attente de tracking
- `PROCESSING` — Tracking en cours (max 135)
- `DONE` — Tracking terminé

---

## 🔍 Debugging Courant

### Problème: 0 tokens détectés

**Cause:** WSS Solana déconnecté ou clé API invalide.

**Fix:**
```bash
# Vérifier logs
pm2 logs walletsource-db | grep -i "wss"

# Vérifier .env
cat .env | grep HELIUS_API_KEY
```

### Problème: Queue PROCESSING bloquée à 0

**Cause:** Aucun token en PENDING ou rate limit atteint.

**Fix:**
```bash
# Vérifier pending
psql -U walletsource -d walletsource -c "SELECT COUNT(*) FROM monitoring_queue WHERE status='PENDING';"

# Vérifier rate limit dans logs
pm2 logs walletsource-db | grep "Rate limit"
```

### Problème: 0 playbooks malgré wallets 3+ tokens

**Cause:** Aucun wallet n'a ≥3 **RUGs** (verdicts RUG_NO_PAIR ou RUG_METRICS).

**Vérifier:**
```bash
npx tsx scripts/check-playbooks.ts
npx tsx scripts/check-tradable-ruggers.ts
```

### Problème: 0 BUY/SELL orders

**Cause:** Tous les playbooks sont AVOID/WATCH (instant rugs sans marché).

**Normal!** Les instant rugs (peak_mc < $500) ne sont pas tradables.

**Attendre** des rugs avec market cap significatif (≥$1000).

---

## 📈 Métriques Normales

Après 1-2 heures de fonctionnement:

```
✓ Tokens détectés: 500-1000
✓ Queue PROCESSING: 120-135 (proche de la capacité max)
✓ Queue DONE: 200-400
✓ Snapshots: 4,000-8,000
✓ Verdicts: 93% NEUTRAL, 5% RUG, 2% SUCCESS
✓ Playbooks: 0-10 (augmente progressivement)
✓ Wallets 3+ tokens: 50-100
✓ Wallets 3+ RUGs: 0-10 (requis pour playbooks)
```

---

## 🛠️ Modifications Courantes

### Réduire utilisation API (90% → 60%)

```typescript
// src/workers/TokenTracker.ts ligne 141
if (activeCount >= 90 || remainingQuota < 90) {  // 135 → 90
```

### Augmenter durée tracking (10min → 15min)

```typescript
// src/workers/TokenTracker.ts ligne 20
const TRACKING_DURATION_MS = 15 * 60 * 1000;  // 10 → 15
```

### Changer thresholds verdicts

```typescript
// src/workers/TokenTracker.ts lignes 24-31
const THRESHOLDS = {
  RUG_NO_MARKET_FDV: 500,      // USD - token mort
  SUCCESS_FDV: 30000,           // USD - token survivant
  SUCCESS_LIQUIDITY: 5000       // USD - liquidité min
};
```

**Après toute modification:**
```bash
npm run build
pm2 restart walletsource-db
```

---

## 🚨 Sécurité IMPORTANTE

### NE JAMAIS Commiter
- `.env` (clés API)
- `data/` (logs)
- `node_modules/`

### Vérifier avant git push
```bash
git status
# Si .env apparaît → STOP!
# Vérifier .gitignore contient bien '.env'
```

### Permissions fichiers
```bash
chmod 600 .env        # Lecture seule pour owner
chmod +x scripts/*.sh # Exécutables
```

---

## 📞 Support Rapide

### Logs
```bash
pm2 logs walletsource-db --lines 100
pm2 logs walletsource-dashboard --lines 50
tail -f data/paper-trades.log
```

### Status
```bash
pm2 status
./scripts/monitor-production.sh
```

### Database
```bash
psql -U walletsource -d walletsource -h localhost
```

### Rebuild complet
```bash
rm -rf dist node_modules
npm install --production
npm run build
pm2 restart all
```

---

## 🎯 Workflow Modifications

1. **Sur VPS:**
   ```bash
   cd ~/apps/walletsource-db
   git pull origin feat/live
   ```

2. **Modifier code** (via Claude Code ou nano/vim)

3. **Rebuild et test:**
   ```bash
   npm run build
   pm2 restart walletsource-db
   pm2 logs walletsource-db
   ```

4. **Commit et push** (depuis local):
   ```bash
   git add .
   git commit -m "fix: description"
   git push origin feat/live
   ```

---

**Claude Code:** Utilise ce document comme référence pour aider avec le déploiement, debugging, et modifications du système WalletSourceDB sur VPS.
