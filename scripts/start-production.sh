#!/bin/bash
# WalletSourceDB v4.0 — Production Startup Script
# Usage: ./scripts/start-production.sh

set -e

echo "=================================================="
echo "  WalletSourceDB v4.0 — Production Startup"
echo "=================================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
  echo -e "${RED}Error: Must be run from project root${NC}"
  exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}Error: Node.js 18+ required (current: v$NODE_VERSION)${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} Node.js version OK (v$(node -v))"

# Check if .env exists
if [ ! -f ".env" ]; then
  echo -e "${RED}Error: .env file not found${NC}"
  echo "Please create .env from .env.example and configure API keys"
  exit 1
fi

echo -e "${GREEN}✓${NC} Environment file found"

# Check PostgreSQL connection
echo -n "Checking PostgreSQL connection... "
if psql $DATABASE_URL -c "SELECT 1" > /dev/null 2>&1; then
  echo -e "${GREEN}✓${NC}"
else
  echo -e "${RED}✗${NC}"
  echo -e "${RED}Error: Cannot connect to PostgreSQL${NC}"
  echo "Check DATABASE_URL in .env"
  exit 1
fi

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
  echo -e "${YELLOW}PM2 not found. Installing...${NC}"
  npm install -g pm2
fi

echo -e "${GREEN}✓${NC} PM2 installed"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo -e "${YELLOW}Installing dependencies...${NC}"
  npm install --production
fi

# Build TypeScript
echo -e "${YELLOW}Building TypeScript...${NC}"
npm run build

if [ ! -d "dist" ]; then
  echo -e "${RED}Error: Build failed (dist/ not found)${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} Build successful"

# Create data directory
mkdir -p data

# Stop existing instance if running
if pm2 describe walletsource-db > /dev/null 2>&1; then
  echo -e "${YELLOW}Stopping existing instance...${NC}"
  pm2 stop walletsource-db
  pm2 delete walletsource-db
fi

# Start with PM2 (optimized config)
echo -e "${YELLOW}Starting WalletSourceDB with PM2...${NC}"
pm2 start dist/index.js \
  --name walletsource-db \
  --max-memory-restart 1G \
  --time \
  --no-autorestart \
  --log data/walletsource.log \
  --error data/walletsource-error.log

# Wait for startup
sleep 3

# Check status
if pm2 describe walletsource-db | grep -q "online"; then
  echo ""
  echo -e "${GREEN}=================================================="
  echo -e "  ✓ WalletSourceDB Started Successfully!"
  echo -e "==================================================${NC}"
  echo ""
  echo "Status: $(pm2 describe walletsource-db | grep 'status' | head -1)"
  echo ""
  echo "Commands:"
  echo "  pm2 logs walletsource-db      # View logs"
  echo "  pm2 monit                      # Interactive monitor"
  echo "  pm2 restart walletsource-db    # Restart"
  echo "  pm2 stop walletsource-db       # Stop"
  echo ""
  echo "Dashboard: http://your-vps-ip:3001"
  echo ""

  # Save PM2 config
  pm2 save

  # Suggest startup script
  if [ ! -f ~/.pm2/startup.sh ]; then
    echo -e "${YELLOW}Tip: Enable auto-start on reboot:${NC}"
    echo "  pm2 startup"
    echo "  (then copy/paste the command shown)"
    echo ""
  fi
else
  echo -e "${RED}Error: Failed to start${NC}"
  pm2 logs walletsource-db --lines 50 --nostream
  exit 1
fi
