#!/usr/bin/env bash
# ==============================================================================
# install-uat-ssl.sh
# 從本機執行，在 UAT Server 安裝 Cloudflare Origin Certificate + Nginx 反向代理
# 用法：bash scripts/install-uat-ssl.sh
# ==============================================================================
set -euo pipefail

# 從 .env.uat 讀取 UAT 伺服器憑證
if [ -f .env.uat ]; then
  set -a; source .env.uat; set +a
fi
UAT_HOST="${UAT_SSH_HOST:?'Missing UAT_SSH_HOST in .env.uat'}"
UAT_USER="${UAT_SSH_USERNAME:-root}"
UAT_PASS="${UAT_SSH_PASSWORD:?'Missing UAT_SSH_PASSWORD in .env.uat'}"

# 顏色輸出
GREEN='\033[0;32m'
NC='\033[0m'
step() { echo -e "\n${GREEN}══ $1 ══${NC}"; }

# SSH / SCP 封裝
remote() {
  sshpass -p "$UAT_PASS" ssh -o StrictHostKeyChecking=no "$UAT_USER@$UAT_HOST" "$@"
}
remote_script() {
  sshpass -p "$UAT_PASS" ssh -o StrictHostKeyChecking=no "$UAT_USER@$UAT_HOST" bash -s
}
upload() {
  sshpass -p "$UAT_PASS" scp -o StrictHostKeyChecking=no "$1" "$UAT_USER@$UAT_HOST:$2"
}

# 檢查 sshpass
if ! command -v sshpass &>/dev/null; then
  echo "需要 sshpass。安裝方式："
  echo "  macOS:  brew install hudochenkov/sshpass/sshpass"
  echo "  Linux:  apt install sshpass"
  exit 1
fi

# 檢查憑證檔案
CERT_FILE="origin-cert.pem"
KEY_FILE="origin-key.pem"
if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "找不到憑證檔案。請確保以下檔案在專案根目錄："
  echo "  $CERT_FILE"
  echo "  $KEY_FILE"
  exit 1
fi

# ==============================================================================
step "Step 1: 上傳 Origin Certificate 到 UAT Server"
# ==============================================================================
echo ">>> Uploading certificate..."
upload "$CERT_FILE" "/tmp/origin-cert.pem"
echo ">>> Uploading private key..."
upload "$KEY_FILE" "/tmp/origin-key.pem"
echo "✅ Files uploaded"

# ==============================================================================
step "Step 2: 安裝憑證 & Nginx"
# ==============================================================================
remote_script <<'REMOTE_SCRIPT'
set -euo pipefail

echo ">>> Creating SSL directory..."
mkdir -p /etc/ssl/cloudflare
mv /tmp/origin-cert.pem /etc/ssl/cloudflare/origin-cert.pem
mv /tmp/origin-key.pem /etc/ssl/cloudflare/origin-key.pem
chmod 644 /etc/ssl/cloudflare/origin-cert.pem
chmod 600 /etc/ssl/cloudflare/origin-key.pem

echo ">>> Verifying certificate..."
openssl x509 -in /etc/ssl/cloudflare/origin-cert.pem -noout -subject -dates
echo "✅ Certificate installed"

echo ""
echo ">>> Installing Nginx..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx

echo ""
echo ">>> Configuring Nginx as HTTPS reverse proxy..."
cat > /etc/nginx/sites-available/uat-api <<'NGINX_CONF'
# UAT API — Cloudflare Origin SSL → Node.js backend
server {
    listen 443 ssl;
    server_name uat-api.message.sentry.red;

    # Cloudflare Origin Certificate
    ssl_certificate     /etc/ssl/cloudflare/origin-cert.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin-key.pem;

    # SSL settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # WebSocket support
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

# Redirect HTTP → HTTPS (optional, Cloudflare handles this)
server {
    listen 80;
    server_name uat-api.message.sentry.red;
    return 301 https://$host$request_uri;
}
NGINX_CONF

# Enable site
ln -sf /etc/nginx/sites-available/uat-api /etc/nginx/sites-enabled/uat-api

# Remove default site if it conflicts
rm -f /etc/nginx/sites-enabled/default

# Test nginx config
echo ""
echo ">>> Testing Nginx configuration..."
nginx -t

# Restart nginx
echo ">>> Starting Nginx..."
systemctl enable nginx
systemctl restart nginx

echo ""
echo ">>> Checking Nginx status..."
systemctl status nginx --no-pager -l | head -10

echo ""
echo ">>> Testing HTTPS locally..."
sleep 1
curl -sk https://localhost/health 2>/dev/null | head -1 || echo "⚠️  /health 可能需要一點時間啟動"

echo ""
echo "✅ Nginx + SSL 設定完成"
echo "   Client → Cloudflare (edge SSL) → Nginx (origin SSL, port 443) → Node.js (port 3001)"
REMOTE_SCRIPT

# ==============================================================================
step "Step 3: 開放 443 Port"
# ==============================================================================
remote_script <<'REMOTE_SCRIPT'
set -euo pipefail

if command -v ufw &>/dev/null; then
  echo ">>> Opening port 443..."
  ufw allow 443/tcp 2>/dev/null || true
  ufw status | grep -E "443|22|3001"
else
  echo "ℹ️  No UFW — make sure port 443 is accessible"
fi
REMOTE_SCRIPT

# ==============================================================================
step "🎉 UAT SSL Setup Complete!"
# ==============================================================================
echo ""
echo "  架構："
echo "  Client → Cloudflare (edge SSL) → Nginx:443 (origin SSL) → Node.js:3001"
echo ""
echo "  測試："
echo "  curl -I https://uat-api.message.sentry.red/health"
echo ""

# 清理本地憑證檔案（已安裝到伺服器，不需要保留在 repo 裡）
echo "⚠️  記得刪除本地的 origin-cert.pem 和 origin-key.pem（不要提交到 Git）"
