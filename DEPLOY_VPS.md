# WalletSourceDB v4.0 — VPS Deployment via GitHub

## 🚀 Déploiement sur VPS (Production)

### Prérequis VPS

- Ubuntu 22.04+ ou Debian 11+
- Node.js 18+ installé
- PostgreSQL 14+ installé
- Git installé
- PM2 installé (process manager)
- Minimum 2GB RAM, 20GB disque

---

## 📋 Étape 1: Préparer le Repo Local

### 1.1 Vérifier `.gitignore`

**CRITIQUE:** Ne jamais commiter les clés API!

```bash
# Vérifier que .env est ignoré
cat .gitignore | grep .env
# Doit afficher: .env
```

### 1.2 Commit et Push vers GitHub

```bash
# Vérifier le statut
git status

# Ajouter tous les fichiers (sauf .env)
git add .

# Commit
git commit -m "feat(prod): Ready for VPS deployment v4.0"

# Push vers GitHub
git push origin feat/live

# Ou push vers main si c'est votre branche principale
git push origin main
```

---

## 🖥️ Étape 2: Configuration VPS

### 2.1 Connexion SSH

```bash
ssh user@your-vps-ip
# Ou avec clé
ssh -i ~/.ssh/your-key.pem user@your-vps-ip
```

### 2.2 Installer les Dépendances

```bash
# Update système
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+ (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Install PM2 (process manager)
sudo npm install -g pm2

# Install Git
sudo apt install -y git
```

### 2.3 Configurer PostgreSQL

```bash
# Créer utilisateur et base de données
sudo -u postgres psql << EOF
CREATE USER walletsource WITH PASSWORD 'your_secure_password_here';
CREATE DATABASE walletsource OWNER walletsource;
GRANT ALL PRIVILEGES ON DATABASE walletsource TO walletsource;
\q
EOF

# Tester la connexion
psql -U walletsource -d walletsource -h localhost -W
# Entrer le mot de passe, puis \q pour quitter
```

---

## 📦 Étape 3: Cloner le Projet

```bash
# Créer répertoire application
mkdir -p ~/apps
cd ~/apps

# Cloner depuis GitHub
git clone https://github.com/your-username/walletsource-db.git
cd walletsource-db

# Checkout la bonne branche
git checkout feat/live
# Ou: git checkout main
```

---

## ⚙️ Étape 4: Configuration Environnement

### 4.1 Créer `.env` de Production

```bash
# Copier le template
cp .env.example .env

# Éditer avec nano ou vim
nano .env
```

**Configuration `.env` pour VPS:**

```bash
# Helius API
HELIUS_API_KEY=your_actual_helius_api_key
SOLANA_WSS_URL=wss://atlas-mainnet.helius-rpc.com?api-key=your_actual_helius_api_key

# Database (utiliser localhost sur VPS)
DATABASE_URL=postgresql://walletsource:your_secure_password@localhost:5432/walletsource

# Pump.fun
PUMP_FUN_PROGRAM_ID=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P

# API Rate Limits
DEXSCREENER_RATE_LIMIT=1000

# Logging
LOG_LEVEL=info

# Paper Trading (SET TO FALSE FOR REAL TRADING)
PAPER_TRADING_MODE=true
PAPER_TRADING_LOG_FILE=/home/user/apps/walletsource-db/data/paper-trades.log

# Taint & Scoring Parameters
TAINT_DECAY_WEEKLY=0.95
SIGMOID_K_CONFIDENCE=6.0
SIGMOID_ALPHA_PEXIT=3.0
SIGMOID_MU_TAINT=100
SIGMOID_SIGMA_TAINT=40

# Calibration
CALIBRATION_CRON=0 3 * * 0
CALIBRATION_GUARD_PCT=0.50
```

**Sauvegarder:** `Ctrl+X` → `Y` → `Enter`

### 4.2 Créer Dossier Data

```bash
mkdir -p data
chmod 755 data
```

---

## 🔨 Étape 5: Build & Initialize

```bash
# Install dependencies
npm install --production

# Build TypeScript
npm run build

# Initialiser le schéma PostgreSQL (première fois seulement)
psql -U walletsource -d walletsource -h localhost -f src/db/schema.sql
```

---

## 🚦 Étape 6: Démarrer avec PM2

### 6.1 Démarrer l'Application

```bash
# Start avec PM2
pm2 start dist/index.js --name walletsource-db

# Vérifier le statut
pm2 status

# Voir les logs en temps réel
pm2 logs walletsource-db

# Voir les logs (dernières 100 lignes)
pm2 logs walletsource-db --lines 100
```

### 6.2 Configuration Auto-Restart

```bash
# Sauvegarder la config PM2
pm2 save

# Générer script de démarrage automatique
pm2 startup

# Copier/coller la commande affichée (commence par sudo)
# Exemple: sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u user --hp /home/user
```

### 6.3 Monitoring PM2

```bash
# Dashboard interactif
pm2 monit

# Infos détaillées
pm2 info walletsource-db

# Restart
pm2 restart walletsource-db

# Stop
pm2 stop walletsource-db

# Delete (remove from PM2)
pm2 delete walletsource-db
```

---

## 📊 Étape 7: Monitoring & Maintenance

### 7.1 Vérifier les Logs

```bash
# Logs système
pm2 logs walletsource-db

# Paper trades
tail -f ~/apps/walletsource-db/data/paper-trades.log

# PostgreSQL logs
sudo tail -f /var/log/postgresql/postgresql-14-main.log
```

### 7.2 Dashboard Monitoring

Créer un script de monitoring:

```bash
nano ~/apps/walletsource-db/scripts/monitor-vps.sh
```

```bash
#!/bin/bash
# Monitor script for VPS

echo "=== WalletSourceDB VPS Status ==="
echo ""

# PM2 status
pm2 status walletsource-db

# Disk usage
echo ""
echo "Disk Usage:"
df -h | grep -E '(Filesystem|/dev/)'

# Memory usage
echo ""
echo "Memory Usage:"
free -h

# PostgreSQL status
echo ""
echo "PostgreSQL:"
sudo systemctl status postgresql | grep -E '(Active|Memory)'

# Recent logs
echo ""
echo "Recent Logs (last 10 lines):"
pm2 logs walletsource-db --lines 10 --nostream
```

```bash
# Rendre exécutable
chmod +x ~/apps/walletsource-db/scripts/monitor-vps.sh

# Exécuter
~/apps/walletsource-db/scripts/monitor-vps.sh
```

### 7.3 Backup Automatique

```bash
# Créer script backup PostgreSQL
nano ~/apps/walletsource-db/scripts/backup-db.sh
```

```bash
#!/bin/bash
# Backup PostgreSQL database

BACKUP_DIR="/home/user/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/walletsource_$TIMESTAMP.sql"

mkdir -p $BACKUP_DIR

# Backup
pg_dump -U walletsource -d walletsource -h localhost > $BACKUP_FILE

# Compress
gzip $BACKUP_FILE

# Keep only last 7 days
find $BACKUP_DIR -name "walletsource_*.sql.gz" -mtime +7 -delete

echo "Backup saved: $BACKUP_FILE.gz"
```

```bash
# Rendre exécutable
chmod +x ~/apps/walletsource-db/scripts/backup-db.sh

# Ajouter au crontab (backup quotidien à 4h)
crontab -e
# Ajouter la ligne:
0 4 * * * /home/user/apps/walletsource-db/scripts/backup-db.sh
```

---

## 🔄 Mise à Jour du Code

```bash
# Sur VPS
cd ~/apps/walletsource-db

# Pull derniers changements
git pull origin feat/live

# Install nouvelles dépendances (si package.json modifié)
npm install --production

# Rebuild
npm run build

# Restart PM2
pm2 restart walletsource-db

# Vérifier les logs
pm2 logs walletsource-db --lines 50
```

---

## 🔐 Sécurité

### Firewall (UFW)

```bash
# Allow SSH
sudo ufw allow 22/tcp

# Allow PostgreSQL (seulement si accès externe nécessaire)
# sudo ufw allow 5432/tcp  # NE PAS EXPOSER EN PRODUCTION

# Enable firewall
sudo ufw enable
```

### Permissions Fichiers

```bash
# Protéger .env
chmod 600 .env

# Vérifier
ls -la .env
# Doit afficher: -rw------- (600)
```

### Rotation des Logs

```bash
# PM2 log rotation
pm2 install pm2-logrotate

# Configurer (10MB max, garder 7 jours)
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

---

## 🐛 Troubleshooting VPS

### Application ne démarre pas

```bash
# Vérifier les logs PM2
pm2 logs walletsource-db --err

# Vérifier la connexion DB
psql -U walletsource -d walletsource -h localhost -c "SELECT NOW();"

# Vérifier les ports
sudo netstat -tulpn | grep 5432
```

### Mémoire insuffisante

```bash
# Vérifier RAM disponible
free -h

# Si <500MB disponible, créer swap:
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Rendre permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Rate Limit DexScreener

```bash
# Vérifier les logs pour erreurs 429
pm2 logs walletsource-db | grep "429"

# Réduire le nombre de tokens simultanés (modifier TokenTracker.ts)
# activeCount >= 90 → activeCount >= 60
```

---

## 📈 Passage en Production (Real Trading)

**Après 7+ jours de paper trading:**

1. **Analyser les résultats:**
   ```bash
   cat data/paper-trades.log | jq -r '.action' | sort | uniq -c
   ```

2. **Vérifier les playbooks:**
   ```bash
   npx tsx scripts/check-playbooks.ts
   ```

3. **Modifier `.env`:**
   ```bash
   nano .env
   # Changer: PAPER_TRADING_MODE=false
   ```

4. **Restart:**
   ```bash
   pm2 restart walletsource-db
   ```

---

## ✅ Checklist Déploiement VPS

- [ ] VPS configuré (Node.js, PostgreSQL, PM2)
- [ ] GitHub repo pushé (sans `.env`)
- [ ] Projet cloné sur VPS
- [ ] `.env` créé avec vraies clés API
- [ ] PostgreSQL schéma initialisé
- [ ] Application démarrée avec PM2
- [ ] Auto-restart configuré (`pm2 startup`)
- [ ] Backup quotidien configuré (crontab)
- [ ] Firewall activé (UFW)
- [ ] Monitoring script créé
- [ ] Paper trading testé 7+ jours
- [ ] Logs vérifiés sans erreurs

---

## 📞 Support

- **Logs:** `pm2 logs walletsource-db`
- **Status:** `pm2 status`
- **DB:** `psql -U walletsource -d walletsource -h localhost`
- **Monitoring:** `bash scripts/monitor-vps.sh`

**RAPPEL:** Gardez `PAPER_TRADING_MODE=true` jusqu'à validation complète!
