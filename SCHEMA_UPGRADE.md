# WalletSourceDB v4.0 — Schema Upgrade Guide

## ⚠️ Problème Résolu

Le schéma PostgreSQL manquait **2 éléments critiques** pour v4.0:

1. ❌ **Table `token_snapshots`** — Stocke les 20 snapshots par token (tracking 30s × 10min)
2. ❌ **Colonnes playbook** dans `wallet_profiles`:
   - `rugger_playbook` (JSONB) — Playbook prédictif avec fenêtres temporelles
   - `playbook_confidence` (REAL) — Consistency score
   - `playbook_updated_at` (TIMESTAMP) — Dernière mise à jour

## ✅ Correction Appliquée

Le fichier `src/db/schema.sql` a été **mis à jour** avec:
- ✅ Table `token_snapshots` (table #8)
- ✅ Colonnes playbook dans `wallet_profiles`
- ✅ Indexes appropriés

---

## 🚀 Installation Selon Votre Situation

### **Situation A: Base de Données Vide (Nouvelle Installation)**

Exécuter le schéma complet:

```bash
# Load full schema
psql $DATABASE_URL -f src/db/schema.sql

# Verify
bash scripts/verify-schema.sh
```

**Résultat:** 8 tables créées avec toutes les colonnes.

---

### **Situation B: Base Existante (Migration depuis v3.0)**

Utiliser le script de migration:

```bash
# 1. Rendre exécutable
chmod +x scripts/migrate-to-v4.sh
chmod +x scripts/verify-schema.sh

# 2. Vérifier état actuel
bash scripts/verify-schema.sh

# 3. Migrer (crée backup automatique)
bash scripts/migrate-to-v4.sh

# 4. Vérifier après migration
bash scripts/verify-schema.sh
```

**Résultat:** Table et colonnes ajoutées sans perdre de données.

---

## 🔍 Vérification Rapide

### Compter les Tables

```sql
SELECT COUNT(*)
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'wallet_profiles', 'wallet_ancestry', 'token_events', 'token_snapshots',
    'cartel_groups', 'taint_log', 'monitoring_queue', 'calibration_log'
  );
```

**Attendu:** `8`

### Vérifier wallet_profiles

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'wallet_profiles'
  AND column_name IN ('rugger_playbook', 'playbook_confidence', 'playbook_updated_at')
ORDER BY column_name;
```

**Attendu:**
```
     column_name      | data_type
----------------------+-----------
 playbook_confidence  | real
 playbook_updated_at  | timestamp without time zone
 rugger_playbook      | jsonb
```

### Vérifier token_snapshots

```sql
SELECT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_name = 'token_snapshots'
);
```

**Attendu:** `t` (true)

---

## 📊 Schéma Complet v4.0

### 8 Tables

| # | Table | Rôle | Colonnes Clés |
|---|-------|------|---------------|
| 1 | `wallet_profiles` | Profils wallets | rugger_playbook, playbook_confidence |
| 2 | `wallet_ancestry` | Funding chain | parent_wallet, child_wallet, depth |
| 3 | `token_events` | Tokens détectés | verdict, peak_mc, time_to_rug_min |
| 4 | `token_snapshots` | Tracking 30s | fdv, liquidity_usd, snapshot_at |
| 5 | `cartel_groups` | Clusters wallets | confidence_score_v2 |
| 6 | `taint_log` | Propagation taint | points_applied, depth |
| 7 | `monitoring_queue` | Queue tracking | status, check_at |
| 8 | `calibration_log` | Recalibration | param_name, improvement_pct |

### Nouveautés v4.0

#### Table `token_snapshots`
```sql
CREATE TABLE token_snapshots (
  id SERIAL PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES token_events(token_address),
  snapshot_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fdv REAL,
  liquidity_usd REAL,
  price_usd REAL,
  price_change_5m REAL,
  volume_5m REAL,
  buy_count_5m INTEGER,
  sell_count_5m INTEGER
);
```

**Utilisation:**
- Stocke un snapshot toutes les 30s pendant 10 minutes
- 20 snapshots par token
- Permet analyse lifecycle complète (peak, dump timing)

#### Colonnes `wallet_profiles`
```sql
ALTER TABLE wallet_profiles
  ADD COLUMN rugger_playbook JSONB,
  ADD COLUMN playbook_confidence REAL CHECK (playbook_confidence BETWEEN 0 AND 1),
  ADD COLUMN playbook_updated_at TIMESTAMP;
```

**Utilisation:**
- `rugger_playbook`: Playbook JSON avec fenêtres temporelles
- `playbook_confidence`: Consistency score (≥0.70 pour RIDE)
- `playbook_updated_at`: Timestamp dernière mise à jour

**Exemple rugger_playbook:**
```json
{
  "recommended_strategy": "RIDE",
  "consistency_score": 0.746,
  "sample_size": 5,
  "avg_time_to_peak_min": 3.5,
  "avg_time_to_rug_min": 8.2,
  "entry_window_end_min": 2.8,
  "exit_window_start_min": 7.1,
  "exit_window_end_min": 8.2,
  "avg_peak_mc": 15000
}
```

---

## 🛠️ Scripts Disponibles

### 1. `scripts/verify-schema.sh`
Vérifier que le schéma est complet (8 tables, toutes colonnes).

```bash
bash scripts/verify-schema.sh
```

### 2. `scripts/migrate-to-v4.sh`
Migrer une base existante vers v4.0 (avec backup automatique).

```bash
bash scripts/migrate-to-v4.sh
```

### 3. `src/db/schema.sql`
Schéma complet pour nouvelle installation.

```bash
psql $DATABASE_URL -f src/db/schema.sql
```

### 4. `src/db/migrations/001_add_v4_columns.sql`
Migration SQL pure (si vous ne voulez pas utiliser le script bash).

```bash
psql $DATABASE_URL -f src/db/migrations/001_add_v4_columns.sql
```

---

## 🚨 Troubleshooting

### Erreur: "token_snapshots does not exist"

**Cause:** Table manquante.

**Fix:**
```bash
bash scripts/migrate-to-v4.sh
```

### Erreur: "column rugger_playbook does not exist"

**Cause:** Colonnes playbook manquantes.

**Fix:**
```bash
psql $DATABASE_URL -f src/db/migrations/001_add_v4_columns.sql
```

### Erreur: "table already exists"

**Cause:** Migration déjà appliquée.

**Fix:** Vérifier schéma:
```bash
bash scripts/verify-schema.sh
```

### Migration échoue

**Rollback:**
```bash
# Restore from backup
psql $DATABASE_URL < backup_pre_v4_YYYYMMDD_HHMMSS.sql
```

---

## ✅ Validation Finale

Après migration, vérifier que tout fonctionne:

```bash
# 1. Vérifier schéma
bash scripts/verify-schema.sh

# 2. Rebuild app
npm run build

# 3. Restart
pm2 restart walletsource-db

# 4. Vérifier logs
pm2 logs walletsource-db --lines 50

# 5. Tester playbook
npx tsx scripts/check-playbooks.ts
```

**Attendu:**
- ✅ 8 tables présentes
- ✅ Colonnes playbook dans wallet_profiles
- ✅ App démarre sans erreur
- ✅ Playbooks se construisent correctement

---

## 📞 Support

Si problèmes persistent:

1. **Vérifier logs:**
   ```bash
   pm2 logs walletsource-db --err
   ```

2. **Vérifier connection DB:**
   ```bash
   psql $DATABASE_URL -c "SELECT NOW();"
   ```

3. **Recharger schéma complet** (fresh start):
   ```bash
   # ATTENTION: Efface toutes les données!
   psql $DATABASE_URL << EOF
   DROP SCHEMA public CASCADE;
   CREATE SCHEMA public;
   EOF
   psql $DATABASE_URL -f src/db/schema.sql
   ```

---

**Migration v3.0 → v4.0 complétée!** 🎉
