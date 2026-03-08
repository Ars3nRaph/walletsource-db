#!/bin/bash
set -e

echo "📄 WalletSourceDB v4.0 — Paper Trading Mode"
echo "==========================================="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
  echo "❌ .env file not found"
  echo "   Please copy .env.example to .env and configure it"
  exit 1
fi

# Check if PAPER_TRADING_MODE is enabled
if ! grep -q "PAPER_TRADING_MODE=true" .env; then
  echo "⚠️  WARNING: PAPER_TRADING_MODE is not set to 'true' in .env"
  echo "   This will execute REAL trades if enabled in the future!"
  echo ""
  read -p "Continue anyway? (y/N): " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# Check if PostgreSQL is running
if ! docker exec walletsource-db pg_isready -U walletsource > /dev/null 2>&1; then
  echo "❌ PostgreSQL is not running"
  echo "   Run: ./scripts/setup-db.sh"
  exit 1
fi

echo "✅ PostgreSQL is running"
echo "✅ Paper trading mode enabled"
echo ""

# Create data directory if it doesn't exist
mkdir -p data

# Build if needed
if [ ! -d "dist" ]; then
  echo "🔨 Building project..."
  npm run build
  echo ""
fi

echo "🚀 Starting WalletSourceDB in paper trading mode..."
echo "   Trades will be logged to: data/paper-trades.log"
echo "   Press Ctrl+C to stop"
echo ""

# Start the application
npm start
