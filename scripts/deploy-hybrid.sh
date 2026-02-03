#!/bin/bash
set -e

# Load environment variables from .env (Only CLOUDFLARE_*)
if [ -f ".env" ]; then
  echo "📄 Loading Cloudflare credentials from .env"
  export $(grep '^CLOUDFLARE_' .env | xargs)
else
  echo "⚠️  .env file not found"
fi

# Configuration
REMOTE_HOST="Message"
REMOTE_DIR="service"
WORKER_DIR="data-worker"
WEB_DIR="web"
PM2_APP_NAME="message-api"
PM2_ENTRY="src/server.js"

echo "🚀 Starting Hybrid Deployment..."

# 1. Cloudflare Workers (Data API) - Local Deploy
echo "⚡️ Deploying Data Worker..."
if [ -d "$WORKER_DIR" ]; then
  cd "$WORKER_DIR"
  npx wrangler deploy
  cd ..
else
  echo "⚠️  Worker directory not found: $WORKER_DIR"
fi

# 2. Cloudflare Pages (Frontend) - Local Build & Deploy
echo "🎨 Building and Deploying Frontend..."
if [ -d "$WEB_DIR" ]; then
  cd "$WEB_DIR"
  echo "   - Installing dependencies (optional)..."
  npm install || true
  
  echo "   - Deploying ./src directly to Cloudflare Pages (Production)..."
  npx wrangler pages deploy ./src --project-name message-web --branch=main --commit-dirty=true
  cd ..
else
  echo "⚠️  Web directory not found: $WEB_DIR"
fi

# 3. Node.js Backend - Git Push & Remote Reload
echo "🔄 Deploying Node.js Backend..."

# Git Push
echo "   - Pushing changes to git..."
git add .
git commit -m "Deploy: $(date)" || echo "   (No changes to commit)"
git push origin main

# Helper function to reload or start PM2
reload_pm2() {
  echo "     - Managing PM2 services..."
  if pm2 list | grep -q "$PM2_APP_NAME"; then
    echo "     - Reloading existing PM2 process..."
    pm2 reload "$PM2_APP_NAME"
  else
    echo "     - No existing process found, starting new..."
    pm2 start "$PM2_ENTRY" --name "$PM2_APP_NAME"
    pm2 save
  fi
}

# Check if running on the remote server itself (skip SSH)
if [ "$SKIP_SSH" = "1" ] || [ "$(hostname)" = "localhost" ] || [ -f "/root/service/.is-server" ]; then
  echo "   - Running locally on server, updating directly..."
  echo "     - Pulling latest code..."
  git fetch origin
  git reset --hard origin/main
  
  echo "     - Installing dependencies..."
  npm install --production
  
  reload_pm2
else
  # Remote Update via SSH
  echo "   - Updating remote server..."
  ssh "$REMOTE_HOST" << EOF
    set -e
    cd "$REMOTE_DIR"
    echo "     - Pulling latest code..."
    git fetch origin
    git reset --hard origin/main
    
    echo "     - Installing dependencies..."
    npm install --production
    
    echo "     - Managing PM2 services..."
    if pm2 list | grep -q "$PM2_APP_NAME"; then
      echo "     - Reloading existing PM2 process..."
      pm2 reload "$PM2_APP_NAME"
    else
      echo "     - No existing process found, starting new..."
      pm2 start "$PM2_ENTRY" --name "$PM2_APP_NAME"
      pm2 save
    fi
EOF
fi

echo "✅ Hybrid Deployment Complete!"
