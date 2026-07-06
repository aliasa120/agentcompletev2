#!/bin/bash
set -e

echo "🚀 Deploying Agent App (Backend + Frontend)..."
echo ""

# ── Go to the directory where this script lives ──────────────────────────────
cd "$(dirname "$0")"

# ── Pull latest code ─────────────────────────────────────────────────────────
echo "📥 Pulling latest code..."
git fetch origin main
git reset --hard origin/main

# ── Check backend .env ────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    echo ""
    echo "❌ Backend .env not found!"
    echo "   Run: cp .env.example .env && nano .env"
    exit 1
fi

# ── Check frontend .env ───────────────────────────────────────────────────────
if [ ! -f deep-agents-ui-main/.env ]; then
    echo ""
    echo "❌ Frontend .env not found!"
    echo "   Run: cp deep-agents-ui-main/.env.example deep-agents-ui-main/.env && nano deep-agents-ui-main/.env"
    exit 1
fi

# ── Export frontend .env vars so docker compose can use them as build args ────
ENV_ARGS=""
if [ -f deep-agents-ui-main/.env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        # Ignore comments and empty lines
        if [[ ! "$line" =~ ^# ]] && [[ "$line" =~ = ]]; then
            # Clean carriage returns if any
            clean_line=$(echo "$line" | tr -d '\r')
            key=$(echo "$clean_line" | cut -d= -f1)
            val=$(echo "$clean_line" | cut -d= -f2-)
            if [[ "$key" =~ ^NEXT_PUBLIC_ ]]; then
                ENV_ARGS="$ENV_ARGS $key='$val'"
            fi
        fi
    done < deep-agents-ui-main/.env
fi

# ── Stop existing containers ──────────────────────────────────────────────────
echo "🛑 Stopping existing containers..."
sudo docker compose down 2>/dev/null || true

# ── Build & start both services ───────────────────────────────────────────────
echo ""
echo "🐳 Building and starting Backend + Frontend..."
eval sudo $ENV_ARGS docker compose up --build -d

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Done! Both containers are running:"
echo ""
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_SERVER_IP")
echo "   🔧 Backend:  http://${SERVER_IP}:2024"
echo "   🌐 Frontend: http://${SERVER_IP}:3000"
echo ""
echo "📋 Commands:"
echo "   sudo docker compose ps                 # status"
echo "   sudo docker compose logs -f backend    # backend logs"
echo "   sudo docker compose logs -f frontend   # frontend logs"
echo "   sudo docker compose down               # stop all"
