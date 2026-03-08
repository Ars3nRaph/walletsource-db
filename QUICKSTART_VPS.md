# WalletSourceDB v4.0 — Quick Start VPS

Guide ultra-rapide pour déployer sur VPS en 10 minutes.

## 🚀 Déploiement Rapide

### 1. Push vers GitHub (Local)

```bash
# Sur votre machine locale
git add .
git commit -m "feat(prod): Production ready v4.0"
git push origin feat/live
```

### 2. Clone sur VPS

```bash
# SSH vers VPS
ssh user@your-vps-ip

# Clone repo
git clone https://github.com/your-username/walletsource-db.git
cd walletsource-db
git checkout feat/live
```

### 3. Installation Rapide

```bash
# Install Node.js 18+ si nécessaire
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs postgresql postgresql-contrib

# Install PM2
sudo npm install -g pm2

# Install dependencies
npm install --production

# Build
npm run build
```

### 4. Configuration

```bash
# Créer .env
cp .env.example .env
nano .env
```

**Éditer .env avec vos vraies clés:**
```bash
HELIUS_API_KEY=your_actual_key
SOLANA_WSS_URL=wss://atlas-mainnet.helius-rpc.com?api-key=your_actual_key
DATABASE_URL=postgresql://walletsource:password@localhost:5432/walletsource
PAPER_TRADING_MODE=true  # Important: garder true au début
```

### 5. Setup PostgreSQL

```bash
# Créer DB
sudo -u postgres psql << EOF
CREATE USER walletsource WITH PASSWORD 'your_secure_password';
CREATE DATABASE walletsource OWNER walletsource;
GRANT ALL PRIVILEGES ON DATABASE walletsource TO walletsource;
\q
EOF

# Charger schéma
psql -U walletsource -d walletsource -h localhost -f src/db/schema.sql
```

### 6. Démarrer Tout

```bash
# Rendre scripts exécutables
bash scripts/make-executable.sh

# Démarrer application principale
./scripts/start-production.sh

# Démarrer dashboard web
./scripts/start-dashboard.sh

# (Optionnel) Setup nginx
sudo ./scripts/setup-nginx.sh
```

## ✅ Vérification

### Application principale

```bash
# Voir logs en temps réel
pm2 logs walletsource-db

# Status
pm2 status

# Monitor interactif
pm2 monit
```

### Dashboard CLI

```bash
./scripts/monitor-production.sh
```

### Dashboard Web

Ouvrir dans navigateur:
- **Local:** http://localhost:3001
- **VPS:** http://your-vps-ip:3001
- **Nginx:** http://your-domain (si configuré)

## 📊 Ce Qui Doit Apparaître

Après 5-10 minutes, vous devriez voir:

```
✓ Tokens détectés: ~100+
✓ Queue PROCESSING: ~135 tokens
✓ Snapshots: Augmentation progressive
✓ Verdicts: Majorité NEUTRAL (93%), quelques RUG (5%)
✓ Playbooks: 0-5 (normal au début)
```

## 🔧 Commandes Utiles

### Logs

```bash
# App principale
pm2 logs walletsource-db

# Dashboard
pm2 logs walletsource-dashboard

# Dernières 100 lignes
pm2 logs walletsource-db --lines 100

# Erreurs seulement
pm2 logs walletsource-db --err
```

### Restart

```bash
# Restart app
pm2 restart walletsource-db

# Restart dashboard
pm2 restart walletsource-dashboard

# Restart tout
pm2 restart all
```

### Mise à Jour Code

```bash
cd ~/apps/walletsource-db
git pull origin feat/live
npm install --production
npm run build
pm2 restart all
```

### Backup DB

```bash
# Backup manuel
pg_dump -U walletsource -d walletsource -h localhost > backup.sql

# Restore
psql -U walletsource -d walletsource -h localhost < backup.sql
```

## 🐛 Troubleshooting Rapide

### App ne démarre pas

```bash
# Vérifier logs
pm2 logs walletsource-db --err

# Vérifier DB connection
psql -U walletsource -d walletsource -h localhost -c "SELECT NOW();"

# Vérifier .env
cat .env | grep -E "(HELIUS|DATABASE)"
```

### 0 tokens détectés

- Vérifier `HELIUS_API_KEY` dans .env
- Vérifier `SOLANA_WSS_URL` contient l'API key
- Attendre 5-10 minutes (activité Pump.fun varie)

### Dashboard web ne charge pas

```bash
# Vérifier status
pm2 status walletsource-dashboard

# Restart
pm2 restart walletsource-dashboard

# Tester API
curl http://localhost:3001/api/health
```

### Rate limit errors

```bash
# Réduire slots simultanés dans src/workers/TokenTracker.ts
# Ligne 141: activeCount >= 135 → activeCount >= 90

npm run build
pm2 restart walletsource-db
```

## 🔒 Sécurité Basique

```bash
# Firewall
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS (si SSL)
sudo ufw enable

# Permissions .env
chmod 600 .env

# SSL (optionnel)
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 📈 Passage en Production

**Après 7+ jours de paper trading:**

1. Analyser paper-trades.log
2. Vérifier playbooks construits
3. Modifier .env: `PAPER_TRADING_MODE=false`
4. Restart: `pm2 restart walletsource-db`

## 🎯 Structure Finale

```
VPS Setup:
├── PostgreSQL (port 5432)
├── WalletSourceDB App (PM2)
│   ├── ForensicWorker (Solana WSS)
│   ├── TokenTracker (135 slots, 30s polling)
│   └── PlaybookBuilder
├── Dashboard API (port 3001, PM2)
└── Nginx (port 80/443) → reverse proxy to 3001
```

## 📞 Support

- **Docs:** `DEPLOY_VPS.md`, `CLAUDE.md`
- **Dashboard:** `scripts/web-dashboard/README.md`
- **Logs:** `pm2 logs`
- **Status:** `./scripts/monitor-production.sh`

---

**🎉 Félicitations!** Votre système de détection de ruggers est maintenant opérationnel.
