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
  npm install
  npm run build
  npx wrangler pages deploy dist --project-name message-web
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

# Remote Update
echo "   - Updating remote server..."
ssh "$REMOTE_HOST" << EOF
  set -e
  cd "$REMOTE_DIR"
  echo "     - Pulling latest code..."
  git fetch origin
  git reset --hard origin/main
  
  echo "     - Installing dependencies..."
  npm install --production
  
  echo "     - Reloading PM2 services..."
  pm2 reload all
EOF

echo "✅ Hybrid Deployment Complete!"
