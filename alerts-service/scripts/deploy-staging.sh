#!/bin/bash
# Deploy Agent8080 Whale Alerts Service to Staging
# Usage: ./scripts/deploy-staging.sh

set -e

echo "🚀 Deploying Agent8080 Alerts Service to Staging..."

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ .env file not found. Copy from .env.example and configure."
    exit 1
fi

# Check for required env vars
if [ -z "$BASE_RPC_URL" ]; then
    echo "❌ BASE_RPC_URL not set in .env"
    exit 1
fi

if [ -z "$DISCORD_BOT_TOKEN" ]; then
    echo "❌ DISCORD_BOT_TOKEN not set in .env"
    exit 1
fi

# Create directories
mkdir -p data logs

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Run migrations
echo "🗄️ Running database migrations..."
npm run migrate

# Check health
echo "🔍 Checking service health..."
if [ -f data/health.json ]; then
    echo "Previous health status:"
    cat data/health.json
fi

# Start service
echo "🟢 Starting service..."
if command -v systemctl &> /dev/null; then
    # Copy systemd service file
    sudo cp scripts/alerts-service.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable alerts-service
    sudo systemctl restart alerts-service
    echo "✅ Service started via systemd"
    echo "📋 Check status: sudo systemctl status alerts-service"
    echo "📜 View logs: sudo journalctl -u alerts-service -f"
else
    # Start directly
    nohup npm start > logs/alerts-service.log 2>&1 &
    echo $! > data/service.pid
    echo "✅ Service started (PID: $(cat data/service.pid))"
    echo "📜 View logs: tail -f logs/alerts-service.log"
fi

echo ""
echo "🎉 Deployment complete!"
echo "🔍 Health check: npm run status"
echo "📜 Logs: npm run logs"