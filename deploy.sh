#!/bin/bash
set -e

echo "🚀 Deploying Agent App (Backend + Frontend)..."
echo ""

# ── Go to the directory where this script lives ──────────────────────────────
cd "$(dirname "$0")"

# ── Pull latest code ─────────────────────────────────────────────────────────
echo "📥 Pulling latest code..."
git pull origin main

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
# sudo -E is required to preserve env vars (plain sudo would strip them)
set -a
source deep-agents-ui-main/.env
set +a

# ── Stop existing containers ──────────────────────────────────────────────────
echo "🛑 Stopping existing containers..."
sudo -E docker compose down 2>/dev/null || true

# ── Build & start both services ───────────────────────────────────────────────
echo ""
echo "🐳 Building and starting Backend + Frontend..."
sudo -E docker compose up --build -d

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
