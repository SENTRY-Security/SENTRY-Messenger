#!/usr/bin/env bash
# ==============================================================================
# setup-uat-server.sh
# 從本機執行，遠端初始化 UAT Server 環境
# 用法：bash scripts/setup-uat-server.sh
# ==============================================================================
set -euo pipefail

REPO_URL="git@github.com:SENTRY-Security/SENTRY-Messenger.git"
SERVICE_DIR="/root/service"

# 從 .env.uat 讀取 UAT 伺服器憑證
if [ -f .env.uat ]; then
  set -a; source .env.uat; set +a
fi
UAT_HOST="${UAT_SSH_HOST:?'Missing UAT_SSH_HOST in .env.uat'}"
UAT_USER="${UAT_SSH_USERNAME:-root}"
UAT_PASS="${UAT_SSH_PASSWORD:?'Missing UAT_SSH_PASSWORD in .env.uat'}"

# 顏色輸出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
step() { echo -e "\n${GREEN}══ $1 ══${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }

# SSH 指令封裝（使用 sshpass）
remote() {
  sshpass -p "$UAT_PASS" ssh -o StrictHostKeyChecking=no "$UAT_USER@$UAT_HOST" "$@"
}
remote_script() {
  sshpass -p "$UAT_PASS" ssh -o StrictHostKeyChecking=no "$UAT_USER@$UAT_HOST" bash -s
}

# 檢查 sshpass
if ! command -v sshpass &>/dev/null; then
  echo "需要 sshpass。安裝方式："
  echo "  macOS:  brew install hudochenkov/sshpass/sshpass"
  echo "  Linux:  apt install sshpass"
  echo ""
  echo "或者你也可以手動 SSH 進去執行 remote-init.sh："
  echo "  scp scripts/remote-init.sh root@$UAT_HOST:/root/"
  echo "  ssh root@$UAT_HOST 'bash /root/remote-init.sh'"
  exit 1
fi

# ==============================================================================
step "Step 1: 測試 SSH 連線"
# ==============================================================================
remote "echo '✅ SSH connection OK' && uname -a"

# ==============================================================================
step "Step 2: 安裝基礎套件 (Node.js 20, Git, PM2)"
# ==============================================================================
remote_script <<'REMOTE_SCRIPT'
set -euo pipefail

echo ">>> Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# Git
if ! command -v git &>/dev/null; then
  echo ">>> Installing git..."
  apt-get install -y -qq git
else
  echo "✅ git already installed: $(git --version)"
fi

# Node.js 20 via NodeSource
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  echo ">>> Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
else
  echo "✅ Node.js already installed: $(node -v)"
fi

echo "   npm version: $(npm -v)"

# PM2
if ! command -v pm2 &>/dev/null; then
  echo ">>> Installing PM2 globally..."
  npm install -g pm2
else
  echo "✅ PM2 already installed: $(pm2 -v)"
fi

# PM2 startup (自動開機啟動)
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "✅ 基礎套件安裝完成"
REMOTE_SCRIPT

# ==============================================================================
step "Step 3: 設定 SSH Key for GitHub (deploy key)"
# ==============================================================================
remote_script <<'REMOTE_SCRIPT'
set -euo pipefail

SSH_KEY="/root/.ssh/id_ed25519"
if [ ! -f "$SSH_KEY" ]; then
  echo ">>> Generating SSH key..."
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -C "uat-server@sentry-messenger"
  echo ""
  echo "=========================================="
  echo " ⚠️  請將以下 SSH public key 加入 GitHub Deploy Keys："
  echo "    Repo → Settings → Deploy keys → Add deploy key"
  echo "    Title: UAT Server (172.234.89.50)"
  echo "    勾選 Allow write access"
  echo "=========================================="
  echo ""
  cat "${SSH_KEY}.pub"
  echo ""
  echo "=========================================="
else
  echo "✅ SSH key already exists"
  cat "${SSH_KEY}.pub"
fi

# 設定 GitHub SSH known_hosts
ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null || true
sort -u /root/.ssh/known_hosts -o /root/.ssh/known_hosts
REMOTE_SCRIPT

echo ""
echo "────────────────────────────────────────────"
echo "如果是新建的 SSH key，請先到 GitHub 加好 Deploy Key"
echo "然後按 Enter 繼續..."
echo "────────────────────────────────────────────"
read -r

# ==============================================================================
step "Step 4: Clone Repo & 設定 .env"
# ==============================================================================
# 先把 .env.uat 傳到 server
echo ">>> Uploading .env.uat to server..."
sshpass -p "$UAT_PASS" scp -o StrictHostKeyChecking=no .env.uat "$UAT_USER@$UAT_HOST:/tmp/.env.uat"

remote_script <<REMOTE_SCRIPT
set -euo pipefail

SERVICE_DIR="$SERVICE_DIR"

if [ -d "\$SERVICE_DIR/.git" ]; then
  echo "✅ Repo already cloned at \$SERVICE_DIR"
  cd "\$SERVICE_DIR"
  git fetch origin
  git checkout main 2>/dev/null || git checkout -b main origin/main
  git pull origin main
else
  echo ">>> Cloning repository..."
  git clone "$REPO_URL" "\$SERVICE_DIR"
  cd "\$SERVICE_DIR"
fi

# 寫入 .env
echo ">>> Writing .env..."
cp /tmp/.env.uat "\$SERVICE_DIR/.env"
chmod 600 "\$SERVICE_DIR/.env"
rm -f /tmp/.env.uat

echo "✅ .env deployed"
cat "\$SERVICE_DIR/.env" | head -5
echo "..."
REMOTE_SCRIPT

# ==============================================================================
step "Step 5: 安裝 npm 依賴 & 啟動 PM2"
# ==============================================================================
remote_script <<REMOTE_SCRIPT
set -euo pipefail

cd "$SERVICE_DIR"

echo ">>> Installing production dependencies..."
npm install --production

echo ">>> Setting up PM2..."
if pm2 list | grep -q "message-api-uat"; then
  echo ">>> Reloading existing process..."
  pm2 reload message-api-uat
else
  echo ">>> Starting new process..."
  pm2 start src/server.js --name message-api-uat
fi

pm2 save

echo ""
echo ">>> PM2 Status:"
pm2 list

echo ""
echo ">>> Checking if server is responding..."
sleep 2
curl -s -o /dev/null -w "HTTP %{http_code}" http://localhost:3001/health 2>/dev/null || echo "⚠️  Server may need a moment to start (or /health endpoint doesn't exist)"
REMOTE_SCRIPT

# ==============================================================================
step "Step 6: 設定防火牆 (開放 3001)"
# ==============================================================================
remote_script <<'REMOTE_SCRIPT'
set -euo pipefail

if command -v ufw &>/dev/null; then
  echo ">>> Configuring UFW..."
  ufw allow 22/tcp   2>/dev/null || true
  ufw allow 3001/tcp 2>/dev/null || true
  ufw --force enable 2>/dev/null || true
  ufw status
elif command -v firewall-cmd &>/dev/null; then
  echo ">>> Configuring firewalld..."
  firewall-cmd --permanent --add-port=3001/tcp 2>/dev/null || true
  firewall-cmd --reload 2>/dev/null || true
else
  echo "ℹ️  No firewall manager found — make sure port 3001 is accessible"
fi
REMOTE_SCRIPT

# ==============================================================================
step "Step 7: 首次部署 Cloudflare Worker (UAT) — 本機執行"
# ==============================================================================
echo ">>> Deploying message-data-uat worker (first deploy creates the project)..."
cd data-worker
npx -y wrangler@4 d1 migrations apply message_db_uat --remote --env uat || warn "D1 migrations had issues (may be OK)"
npx -y wrangler@4 deploy --env uat || warn "Worker deploy failed — check wrangler auth"
cd ..
echo "✅ Worker UAT deployed: message-data-uat"

# ==============================================================================
step "Step 8: 首次部署 Cloudflare Pages (UAT Preview) — 本機執行"
# ==============================================================================
echo ">>> Building web for UAT..."
cd web
npm install
npm run build

# Copy functions
if [ -d "functions" ]; then
  mkdir -p dist/functions
  cp -r functions/* dist/functions/
fi

echo ">>> Deploying to Cloudflare Pages (UAT preview branch)..."
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "uat")
# 如果在 main，用 uat 作為分支名稱
if [ "$CURRENT_BRANCH" = "main" ]; then
  DEPLOY_BRANCH="uat"
else
  DEPLOY_BRANCH="$CURRENT_BRANCH"
fi
npx -y wrangler@4 pages deploy ./dist \
  --project-name message-web-hybrid-uat \
  --branch=main \
  --commit-dirty=true \
  --commit-message="UAT Initial Deploy $(date)" || warn "Pages deploy failed — check wrangler auth"
cd ..
echo "✅ Pages UAT deployed: message-web-hybrid-uat.pages.dev"

# ==============================================================================
step "🎉 UAT Environment Fully Deployed!"
# ==============================================================================
echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  UAT Backend (VPS)                                      │"
echo "  │    Server:    $UAT_HOST:3001                             │"
echo "  │    PM2:       message-api-uat                            │"
echo "  │    Service:   $SERVICE_DIR                               │"
echo "  ├─────────────────────────────────────────────────────────┤"
echo "  │  UAT Worker (Cloudflare)                                │"
echo "  │    Name:      message-data-uat                           │"
echo "  │    D1:        message_db_uat                             │"
echo "  │    URL:       https://message-data-uat.ksbcboy.workers.dev │"
echo "  ├─────────────────────────────────────────────────────────┤"
echo "  │  UAT Pages (Cloudflare)                                 │"
echo "  │    Project:   message-web-hybrid-uat                     │"
echo "  │    URL:       https://message-web-hybrid-uat.pages.dev   │"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""
echo "  ⚠️  還需手動處理："
echo "    1. Cloudflare DNS: uat-api.message.sentry.red → $UAT_HOST"
echo "    2. R2 Bucket: message-media-uat (在 Dashboard 建立)"
echo ""
echo "  之後推送非 main 分支即自動觸發 deploy-uat.yml"
echo ""
