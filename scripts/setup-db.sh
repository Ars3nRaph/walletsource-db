#!/bin/bash
set -e

echo "🚀 WalletSourceDB v4.0 — Database Setup"
echo "========================================"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
  echo "❌ Docker is not running. Please start Docker and try again."
  exit 1
fi

echo "✅ Docker is running"
echo ""

# Stop existing containers
echo "🛑 Stopping existing containers..."
docker-compose down -v 2>/dev/null || true

# Start PostgreSQL
echo "🐘 Starting PostgreSQL container..."
docker-compose up -d postgres

# Wait for PostgreSQL to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
max_attempts=30
attempt=0

until docker exec walletsource-db pg_isready -U walletsource > /dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ $attempt -eq $max_attempts ]; then
    echo "❌ PostgreSQL failed to start after $max_attempts attempts"
    docker-compose logs postgres
    exit 1
  fi
  echo "   Attempt $attempt/$max_attempts..."
  sleep 2
done

echo "✅ PostgreSQL is ready!"
echo ""

# Verify schema
echo "📋 Verifying database schema..."
table_count=$(docker exec walletsource-db psql -U walletsource -d walletsource -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" | tr -d ' ')

if [ "$table_count" -ge 8 ]; then
  echo "✅ Schema loaded: $table_count tables found"
else
  echo "⚠️  Warning: Only $table_count tables found (expected 8)"
  echo "   The schema may not be fully loaded. Check logs if issues occur."
fi

echo ""
echo "🎉 Database setup complete!"
echo ""
echo "📊 Connection details:"
echo "   Host: localhost"
echo "   Port: 5432"
echo "   Database: walletsource"
echo "   User: walletsource"
echo "   Password: walletsource_dev"
echo ""
echo "🔧 Optional: Start pgAdmin for database management:"
echo "   docker-compose up -d pgadmin"
echo "   Access at: http://localhost:5050"
echo "   Email: admin@walletsource.local"
echo "   Password: admin"
echo ""
echo "▶️  Next steps:"
echo "   1. Review .env configuration"
echo "   2. Run: npm run build"
echo "   3. Run: npm start (paper trading mode)"
echo ""
