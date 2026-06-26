#!/bin/bash
set -e

CONFIG_FILE="$(dirname "$0")/deploy.config"
if [ -f "$CONFIG_FILE" ]; then
  source "$CONFIG_FILE"
fi

UNRAID_IP="${UNRAID_IP:-192.168.8.208}"
UNRAID_PORT="${UNRAID_PORT:-8811}"
UNRAID_PATH="${UNRAID_PATH:-/mnt/user/appdata/Nodeflow/nodeflow-server}"
UNRAID_USER="${UNRAID_USER:-root}"

echo "=== NODEFLOW Deploy ==="
echo "→ $UNRAID_USER@$UNRAID_IP:$UNRAID_PATH (port $UNRAID_PORT)"
echo ""

if [ ! -f "server.js" ] || [ ! -f "package.json" ]; then
  echo "❌ Run this from the nodeflow-server directory"
  exit 1
fi

# commit and push to GitHub if repo is set up
if git remote get-url origin &>/dev/null; then
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "📝 Committing local changes..."
    git add .
    git commit -m "deploy $(date '+%Y-%m-%d %H:%M')"
  fi
  echo "⬆️  Pushing to GitHub..."
  git push
  echo "   ✓ Pushed"
  echo ""
fi

# package and deploy to Unraid
echo "📦 Packaging..."
tar --exclude='node_modules' \
    --exclude='data' \
    --exclude='*.db*' \
    --exclude='.git*' \
    --exclude='deploy.sh' \
    --exclude='deploy.config' \
    -czf /tmp/nodeflow-deploy.tar.gz .
echo "   ✓ $(du -sh /tmp/nodeflow-deploy.tar.gz | cut -f1)"

echo "🚀 Deploying to Unraid..."
cat /tmp/nodeflow-deploy.tar.gz | ssh $UNRAID_USER@$UNRAID_IP "
  set -e
  mkdir -p $UNRAID_PATH
  cd $UNRAID_PATH
  docker compose down 2>/dev/null || true
  sleep 1
  cat > /tmp/nodeflow-deploy.tar.gz
  tar -xzf /tmp/nodeflow-deploy.tar.gz -C $UNRAID_PATH
  rm -f /tmp/nodeflow-deploy.tar.gz
  docker compose up -d --build
  sleep 3
  curl -s http://localhost:$UNRAID_PORT/api/health > /dev/null && echo '   ✓ Running' || echo '   ⚠ Check logs'
"

echo ""
echo "✅ Done — http://$UNRAID_IP:$UNRAID_PORT"
rm -f /tmp/nodeflow-deploy.tar.gz
