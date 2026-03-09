#!/bin/bash
# WalletSourceDB v4.0 — Setup Nginx Reverse Proxy
# Usage: sudo ./scripts/setup-nginx.sh

set -e

if [ "$EUID" -ne 0 ]; then
  echo "Error: This script must be run as root (use sudo)"
  exit 1
fi

echo "=================================================="
echo "  Setting up Nginx for WalletSourceDB Dashboard"
echo "=================================================="
echo ""

# Install nginx if not present
if ! command -v nginx &> /dev/null; then
  echo "Installing nginx..."
  apt update
  apt install -y nginx
fi

# Get VPS IP or domain
read -p "Enter your domain or VPS IP (e.g., dashboard.example.com or 123.45.67.89): " DOMAIN

# Create nginx config
NGINX_CONF="/etc/nginx/sites-available/walletsource-dashboard"

cat > $NGINX_CONF << EOF
# WalletSourceDB v4.0 Dashboard
server {
    listen 80;
    server_name $DOMAIN;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Logging
    access_log /var/log/nginx/walletsource-access.log;
    error_log /var/log/nginx/walletsource-error.log;

    # Proxy to Node.js dashboard
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # API endpoints
    location /api/ {
        proxy_pass http://localhost:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    # Static files cache
    location ~* \.(css|js|jpg|jpeg|png|gif|ico|svg)$ {
        proxy_pass http://localhost:3001;
        expires 1d;
        add_header Cache-Control "public, immutable";
    }
}
EOF

# Enable site
ln -sf $NGINX_CONF /etc/nginx/sites-enabled/walletsource-dashboard

# Test nginx config
echo "Testing nginx configuration..."
nginx -t

# Reload nginx
echo "Reloading nginx..."
systemctl reload nginx

# Enable nginx on boot
systemctl enable nginx

echo ""
echo "=================================================="
echo "  ✓ Nginx configured successfully!"
echo "=================================================="
echo ""
echo "Dashboard accessible at:"
echo "  http://$DOMAIN"
echo ""
echo "Next steps:"
echo "  1. Ensure dashboard is running:"
echo "     ./scripts/start-dashboard.sh"
echo ""
echo "  2. (Optional) Setup SSL with Let's Encrypt:"
echo "     apt install certbot python3-certbot-nginx"
echo "     certbot --nginx -d $DOMAIN"
echo ""
echo "  3. Configure firewall:"
echo "     ufw allow 'Nginx Full'"
echo "     ufw enable"
echo ""
