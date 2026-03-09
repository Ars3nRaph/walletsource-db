#!/bin/bash
# WalletSourceDB v4.0 — Start Web Dashboard
# Usage: ./scripts/start-dashboard.sh

set -e

echo "Starting WalletSourceDB Web Dashboard..."

# Navigate to dashboard directory
cd "$(dirname "$0")/web-dashboard"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dashboard dependencies..."
  npm install
fi

# Stop existing instance if running
if pm2 describe walletsource-dashboard > /dev/null 2>&1; then
  echo "Stopping existing dashboard..."
  pm2 stop walletsource-dashboard
  pm2 delete walletsource-dashboard
fi

# Start with PM2
echo "Starting dashboard with PM2..."
pm2 start server.js \
  --name walletsource-dashboard \
  --max-memory-restart 512M \
  --time \
  --log ../data/dashboard.log \
  --error ../data/dashboard-error.log

# Save PM2 config
pm2 save

echo ""
echo "✓ Dashboard started successfully!"
echo ""
echo "Access at:"
echo "  Local:  http://localhost:3001"
echo "  VPS:    http://your-vps-ip:3001"
echo ""
echo "Commands:"
echo "  pm2 logs walletsource-dashboard   # View logs"
echo "  pm2 restart walletsource-dashboard # Restart"
echo "  pm2 stop walletsource-dashboard    # Stop"
echo ""
