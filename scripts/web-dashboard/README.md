# WalletSourceDB v4.0 — Web Dashboard

Beautiful, real-time monitoring dashboard for WalletSourceDB.

## 🌟 Features

- **Real-time metrics** — Auto-refresh every 2 seconds
- **Modern UI** — Dark theme, responsive design
- **API Server** — Express.js backend with PostgreSQL
- **Production-ready** — PM2 process management, Nginx reverse proxy
- **Mobile-friendly** — Works on all devices

## 📋 Quick Start (VPS)

### 1. Install Dependencies

```bash
# Navigate to dashboard directory
cd ~/apps/walletsource-db/scripts/web-dashboard

# Install npm packages
npm install
```

### 2. Start Dashboard

```bash
# Option A: Use helper script (recommended)
cd ~/apps/walletsource-db
bash scripts/start-dashboard.sh

# Option B: Start manually
cd scripts/web-dashboard
pm2 start server.js --name walletsource-dashboard
```

### 3. Access Dashboard

- **Local:** http://localhost:3001
- **VPS:** http://your-vps-ip:3001

## 🌐 Setup Nginx (Public Access)

Make dashboard accessible via your domain or VPS IP on port 80:

```bash
# Run nginx setup script
sudo bash scripts/setup-nginx.sh

# Follow prompts to enter your domain/IP
# Example: dashboard.yourdomain.com or 123.45.67.89
```

**After setup:**
- Dashboard accessible at: http://your-domain
- SSL optional: Use `certbot --nginx` for HTTPS

## 📊 Dashboard Sections

### 1. Token Detection
- Total tokens detected
- Unique wallets tracked
- Activity (last 5 minutes)

### 2. Queue Status
- Pending tokens (waiting for tracking)
- Processing tokens (active tracking - 135 slots)
- Done tokens (tracking complete)
- Total snapshots collected

### 3. Verdicts
- RUG (instant rugs + metric rugs)
- SUCCESS (survived tokens)
- NEUTRAL (neither rug nor success)
- PENDING (not yet evaluated)

### 4. Rugger Playbooks
- Total playbooks built
- Strategy distribution (RIDE/FADE/AVOID/WATCH)

### 5. Wallet Statistics
- Wallets by token count (1, 2, 3+, 5+, 10+)
- Rugger-specific stats (3+ RUGs with lifecycle data)

### 6. Performance
- Actual processing rate (tokens/hour)
- API usage (270/300 req/min target = 90%)
- Rate limit visualization

### 7. Paper Trades
- Total signals generated
- BUY/SELL/SHORT counts

### 8. Recent Activity
- Latest token detected
- Latest snapshot recorded

## 🛠️ API Endpoints

The dashboard backend exposes a REST API:

### GET /api/stats
Returns all dashboard metrics.

```bash
curl http://localhost:3001/api/stats
```

### GET /api/health
Health check endpoint.

```bash
curl http://localhost:3001/api/health
```

### GET /api/recent-tokens?limit=10
Returns recent tokens.

```bash
curl http://localhost:3001/api/recent-tokens?limit=5
```

### GET /api/top-playbooks?limit=5
Returns top playbooks by confidence.

```bash
curl http://localhost:3001/api/top-playbooks?limit=10
```

## ⚙️ Configuration

Edit `.env` in project root to configure:

```bash
# Dashboard server port (default: 3001)
DASHBOARD_PORT=3001

# PostgreSQL connection (required)
DATABASE_URL=postgresql://walletsource:password@localhost:5432/walletsource
```

## 🔧 PM2 Management

```bash
# View logs
pm2 logs walletsource-dashboard

# Restart
pm2 restart walletsource-dashboard

# Stop
pm2 stop walletsource-dashboard

# Monitor
pm2 monit

# Status
pm2 status
```

## 🐛 Troubleshooting

### Dashboard not loading

1. Check if backend is running:
   ```bash
   pm2 status walletsource-dashboard
   ```

2. Check logs:
   ```bash
   pm2 logs walletsource-dashboard --lines 50
   ```

3. Test API directly:
   ```bash
   curl http://localhost:3001/api/health
   ```

### Database connection error

1. Verify DATABASE_URL in `.env`:
   ```bash
   echo $DATABASE_URL
   ```

2. Test PostgreSQL connection:
   ```bash
   psql $DATABASE_URL -c "SELECT NOW();"
   ```

### Port already in use

Change `DASHBOARD_PORT` in `.env`:
```bash
DASHBOARD_PORT=3002
```

Then restart:
```bash
pm2 restart walletsource-dashboard
```

### Nginx 502 Bad Gateway

1. Check if dashboard is running:
   ```bash
   pm2 status walletsource-dashboard
   ```

2. Check nginx error log:
   ```bash
   sudo tail -f /var/log/nginx/walletsource-error.log
   ```

3. Restart nginx:
   ```bash
   sudo systemctl restart nginx
   ```

## 🔒 Security

### Firewall (UFW)

```bash
# Allow HTTP
sudo ufw allow 80/tcp

# Allow HTTPS (if using SSL)
sudo ufw allow 443/tcp

# Enable firewall
sudo ufw enable
```

### SSL/HTTPS (Let's Encrypt)

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal
sudo certbot renew --dry-run
```

### Authentication (Optional)

Add basic auth to nginx config:

```bash
# Install apache2-utils
sudo apt install apache2-utils

# Create password file
sudo htpasswd -c /etc/nginx/.htpasswd admin

# Add to nginx config (inside server block):
auth_basic "Restricted Access";
auth_basic_user_file /etc/nginx/.htpasswd;
```

## 📦 Tech Stack

- **Backend:** Express.js, Node.js 18+
- **Database:** PostgreSQL 14+
- **Frontend:** Vanilla JavaScript, CSS3, HTML5
- **Process Manager:** PM2
- **Web Server:** Nginx
- **Hosting:** Any VPS (Ubuntu, Debian)

## 🚀 Production Checklist

- [ ] Dashboard running with PM2
- [ ] Auto-start configured (`pm2 startup`)
- [ ] Nginx reverse proxy configured
- [ ] SSL certificate installed (HTTPS)
- [ ] Firewall configured (UFW)
- [ ] Logs rotation enabled
- [ ] Monitoring alerts configured

## 📞 Support

- **Logs:** `pm2 logs walletsource-dashboard`
- **Status:** `pm2 status`
- **API Test:** `curl http://localhost:3001/api/health`
- **Nginx Logs:** `/var/log/nginx/walletsource-*.log`
