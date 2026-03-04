#!/usr/bin/env bash
# ==============================================================================
# setup-environments.sh
# 一鍵設定 Production + UAT 環境
# 包含：Cloudflare UAT 資源建立、GitHub Secrets 設定、Worker Secrets 設定
#
# 前置條件：
#   1. npm install -g wrangler   (已登入或有 CLOUDFLARE_API_TOKEN)
#   2. gh auth login             (已登入 GitHub)
#   3. 本腳本在專案根目錄執行
# ==============================================================================
set -euo pipefail

REPO="SENTRY-Security/SENTRY-Messenger"
WRANGLER_TOML="data-worker/wrangler.toml"

# 載入 .env（Production 設定）
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  echo "✅ Loaded .env"
else
  echo "❌ .env not found. Please run from project root."
  exit 1
fi

# 載入 .env.uat（UAT SSH 憑證等）
if [ -f .env.uat ]; then
  set -a; source .env.uat; set +a
  echo "✅ Loaded .env.uat"
else
  echo "⚠️  .env.uat not found — UAT SSH secrets will be skipped"
fi

# 確認關鍵變數已載入
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "❌ CLOUDFLARE_ACCOUNT_ID not found in .env"
  exit 1
fi
echo "✅ Cloudflare Account: $CLOUDFLARE_ACCOUNT_ID"

# ==============================================================================
# Step 1: 建立 UAT D1 Database
# ==============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Step 1: Create UAT D1 Database"
echo "═══════════════════════════════════════════════════════════════"

# 先檢查是否已存在
echo "Listing D1 databases..."
D1_LIST=$(npx -y wrangler@4 d1 list 2>&1) || true
echo "$D1_LIST" | head -20

EXISTING_DB=$(echo "$D1_LIST" | grep "message_db_uat" || true)
if [ -n "$EXISTING_DB" ]; then
  echo "⚠️  message_db_uat already exists, skipping creation."
  # 用 awk 抓 UUID 格式的 ID（macOS 相容）
  UAT_D1_ID=$(echo "$EXISTING_DB" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
else
  echo "Creating D1 database: message_db_uat ..."
  CREATE_OUTPUT=$(npx -y wrangler@4 d1 create message_db_uat 2>&1)
  echo "$CREATE_OUTPUT"
  # macOS 相容：用 -oE (extended regex) 而非 -oP (perl regex)
  UAT_D1_ID=$(echo "$CREATE_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
fi

if [ -z "$UAT_D1_ID" ]; then
  echo "❌ Failed to get UAT D1 database ID. Please create manually:"
  echo "   npx -y wrangler@4 d1 create message_db_uat"
  echo "   Then update $WRANGLER_TOML with the database_id"
  echo ""
  echo "   取得 ID 後，手動更新 $WRANGLER_TOML 的 PLACEHOLDER_UAT_D1_DATABASE_ID"
  echo "   然後重新執行此腳本（會跳過已建立的 DB）"
  exit 1
fi

echo "✅ UAT D1 Database ID: $UAT_D1_ID"

# 更新 wrangler.toml 中的 placeholder（macOS + Linux 相容寫法）
if grep -q "PLACEHOLDER_UAT_D1_DATABASE_ID" "$WRANGLER_TOML"; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/PLACEHOLDER_UAT_D1_DATABASE_ID/$UAT_D1_ID/" "$WRANGLER_TOML"
  else
    sed -i "s/PLACEHOLDER_UAT_D1_DATABASE_ID/$UAT_D1_ID/" "$WRANGLER_TOML"
  fi
  echo "✅ Updated $WRANGLER_TOML with UAT D1 database ID"
fi

# 套用 migrations 到 UAT database
echo "Applying D1 migrations to UAT database..."
cd data-worker
npx -y wrangler@4 d1 migrations apply message_db_uat --remote --env uat || echo "⚠️  Migration apply had issues (may be OK if no pending)"
cd ..

# ==============================================================================
# Step 2: 建立 UAT Pages Project (如果需要獨立專案)
# ==============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Step 2: Verify Cloudflare Pages Project"
echo "═══════════════════════════════════════════════════════════════"
echo "ℹ️  UAT Pages 使用 preview deployment (同一個 message-web-hybrid 專案)"
echo "   非 main 分支會自動獲得 <branch>.message-web-hybrid.pages.dev URL"
echo "✅ No additional Pages project needed"

# ==============================================================================
# Step 3: 設定 GitHub Secrets — Production
# ==============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Step 3: Set GitHub Secrets — Production"
echo "═══════════════════════════════════════════════════════════════"

set_secret() {
  local name="$1"
  local value="$2"
  if [ -n "$value" ]; then
    echo "$value" | gh secret set "$name" --repo "$REPO" 2>/dev/null
    echo "  ✅ $name"
  else
    echo "  ⚠️  $name is empty, skipping"
  fi
}

echo "Setting production secrets..."

# Cloudflare credentials (shared)
set_secret "CLOUDFLARE_ACCOUNT_ID"      "$CLOUDFLARE_ACCOUNT_ID"
set_secret "CLOUDFLARE_EMAIL"           "$CLOUDFLARE_EMAIL"
set_secret "CLOUDFLARE_API_KEY"         "$CLOUDFLARE_API_KEY"
set_secret "CLOUDFLARE_API_TOKEN"       "$CLOUDFLARE_API_TOKEN"

# SSH (VPS) — Production（從 .env 讀取）
set_secret "SSH_HOST"                   "${SSH_HOST:-}"
set_secret "SSH_USERNAME"               "${SSH_USERNAME:-}"
set_secret "SSH_PASSWORD"               "${SSH_PASSWORD:-}"

# Backend config
set_secret "PORT"                       "$PORT"
set_secret "ADMIN_IP_ALLOW"             "$ADMIN_IP_ALLOW"
set_secret "CORS_ORIGIN"                "$CORS_ORIGIN"

# Data API
set_secret "DATA_API_URL"               "$DATA_API_URL"
set_secret "DATA_API_HMAC"              "$DATA_API_HMAC"
set_secret "ACCOUNT_HMAC_KEY"           "$ACCOUNT_HMAC_KEY"
set_secret "INVITE_TOKEN_KEY"           "$INVITE_TOKEN_KEY"

# OPAQUE
set_secret "OPAQUE_OPRF_SEED"           "$OPAQUE_OPRF_SEED"
set_secret "OPAQUE_AKE_PRIV_B64"        "$OPAQUE_AKE_PRIV_B64"
set_secret "OPAQUE_AKE_PUB_B64"         "$OPAQUE_AKE_PUB_B64"
set_secret "OPAQUE_SERVER_ID"           "$OPAQUE_SERVER_ID"

# NTAG424
set_secret "NTAG424_KM"                "$NTAG424_KM"
set_secret "NTAG424_KDF"               "$NTAG424_KDF"
set_secret "NTAG424_SALT"              "$NTAG424_SALT"
set_secret "NTAG424_INFO"              "$NTAG424_INFO"
set_secret "NTAG424_KVER"              "$NTAG424_KVER"

# Portal
set_secret "PORTAL_HMAC_SECRET"         "$PORTAL_HMAC_SECRET"
set_secret "PORTAL_API_ORIGIN"          "$PORTAL_API_ORIGIN"

# WebSocket
set_secret "WS_TOKEN_SECRET"            "$WS_TOKEN_SECRET"

# S3 / R2
set_secret "S3_ENDPOINT"               "$S3_ENDPOINT"
set_secret "S3_REGION"                  "$S3_REGION"
set_secret "S3_BUCKET"                  "$S3_BUCKET"
set_secret "S3_ACCESS_KEY"             "$S3_ACCESS_KEY"
set_secret "S3_SECRET_KEY"             "$S3_SECRET_KEY"
set_secret "SIGNED_PUT_TTL"            "$SIGNED_PUT_TTL"
set_secret "SIGNED_GET_TTL"            "$SIGNED_GET_TTL"

# Upload
set_secret "UPLOAD_MAX_BYTES"           "$UPLOAD_MAX_BYTES"
set_secret "UPLOAD_ALLOWED_TYPES"       "$UPLOAD_ALLOWED_TYPES"

# TURN / SFU
set_secret "TURN_TTL_SECONDS"           "$TURN_TTL_SECONDS"
set_secret "CLOUDFLARE_TURN_TOKEN_ID"   "$CLOUDFLARE_TURN_TOKEN_ID"
set_secret "CLOUDFLARE_TURN_TOKEN_KEY"  "$CLOUDFLARE_TURN_TOKEN_KEY"
set_secret "CLOUDFLARE_SFU_TOKEN_ID"    "$CLOUDFLARE_SFU_TOKEN_ID"
set_secret "CLOUDFLARE_SFU_TOKEN_KEY"   "$CLOUDFLARE_SFU_TOKEN_KEY"

# Auth Keys (multiline)
set_secret "PRIVATE_KEY_PUBLIC_PEM"     "$PRIVATE_KEY_PUBLIC_PEM"

echo ""
echo "✅ Production secrets complete"

# ==============================================================================
# Step 4: 設定 GitHub Secrets — UAT
# ==============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Step 4: Set GitHub Secrets — UAT"
echo "═══════════════════════════════════════════════════════════════"

echo "Setting UAT secrets..."
echo "ℹ️  UAT 使用相同 Cloudflare 帳號，共用基礎認證"
echo "   你可以之後手動修改 UAT-specific 的值"

# UAT Cloudflare credentials (同一帳號，先用相同值)
set_secret "UAT_CLOUDFLARE_ACCOUNT_ID"      "$CLOUDFLARE_ACCOUNT_ID"
set_secret "UAT_CLOUDFLARE_EMAIL"           "$CLOUDFLARE_EMAIL"
set_secret "UAT_CLOUDFLARE_API_KEY"         "$CLOUDFLARE_API_KEY"
set_secret "UAT_CLOUDFLARE_API_TOKEN"       "$CLOUDFLARE_API_TOKEN"

# UAT SSH (VPS) — 從 .env.uat 讀取
set_secret "UAT_SSH_HOST"                   "${UAT_SSH_HOST:?'Missing UAT_SSH_HOST in .env.uat'}"
set_secret "UAT_SSH_USERNAME"               "${UAT_SSH_USERNAME:-root}"
set_secret "UAT_SSH_PASSWORD"               "${UAT_SSH_PASSWORD:?'Missing UAT_SSH_PASSWORD in .env.uat'}"

# UAT D1 Database ID
set_secret "UAT_D1_DATABASE_ID"             "$UAT_D1_ID"

# UAT Backend config (不同 port 避免衝突)
UAT_PORT="${UAT_PORT:-3001}"
set_secret "UAT_PORT"                       "$UAT_PORT"
set_secret "UAT_ADMIN_IP_ALLOW"             "$ADMIN_IP_ALLOW"
set_secret "UAT_CORS_ORIGIN"                "https://*.message-web-hybrid.pages.dev,http://localhost:8788"

# UAT Data API (指向 UAT worker)
set_secret "UAT_DATA_API_URL"               "https://message-data-uat.${CLOUDFLARE_EMAIL%%@*}.workers.dev"
set_secret "UAT_DATA_API_HMAC"              "$DATA_API_HMAC"
set_secret "UAT_ACCOUNT_HMAC_KEY"           "$ACCOUNT_HMAC_KEY"
set_secret "UAT_INVITE_TOKEN_KEY"           "$INVITE_TOKEN_KEY"

# UAT OPAQUE (共用，因為是獨立的 UAT DB)
set_secret "UAT_OPAQUE_OPRF_SEED"           "$OPAQUE_OPRF_SEED"
set_secret "UAT_OPAQUE_AKE_PRIV_B64"        "$OPAQUE_AKE_PRIV_B64"
set_secret "UAT_OPAQUE_AKE_PUB_B64"         "$OPAQUE_AKE_PUB_B64"
set_secret "UAT_OPAQUE_SERVER_ID"           "uat-api.message.sentry.red"

# UAT NTAG424
set_secret "UAT_NTAG424_KM"                "$NTAG424_KM"
set_secret "UAT_NTAG424_KDF"               "$NTAG424_KDF"
set_secret "UAT_NTAG424_SALT"              "$NTAG424_SALT"
set_secret "UAT_NTAG424_INFO"              "$NTAG424_INFO"
set_secret "UAT_NTAG424_KVER"              "$NTAG424_KVER"

# UAT Portal
set_secret "UAT_PORTAL_HMAC_SECRET"         "$PORTAL_HMAC_SECRET"
set_secret "UAT_PORTAL_API_ORIGIN"          "https://uat.portal.messenger.sentry.red"

# UAT WebSocket
set_secret "UAT_WS_TOKEN_SECRET"            "$WS_TOKEN_SECRET"

# UAT S3 / R2 (同一帳號 R2，但可用不同 bucket)
set_secret "UAT_S3_ENDPOINT"               "$S3_ENDPOINT"
set_secret "UAT_S3_REGION"                  "$S3_REGION"
set_secret "UAT_S3_BUCKET"                  "message-media-uat"
set_secret "UAT_S3_ACCESS_KEY"             "$S3_ACCESS_KEY"
set_secret "UAT_S3_SECRET_KEY"             "$S3_SECRET_KEY"
set_secret "UAT_SIGNED_PUT_TTL"            "$SIGNED_PUT_TTL"
set_secret "UAT_SIGNED_GET_TTL"            "$SIGNED_GET_TTL"

# UAT Upload
set_secret "UAT_UPLOAD_MAX_BYTES"           "$UPLOAD_MAX_BYTES"
set_secret "UAT_UPLOAD_ALLOWED_TYPES"       "$UPLOAD_ALLOWED_TYPES"

# UAT TURN / SFU (共用)
set_secret "UAT_TURN_TTL_SECONDS"           "$TURN_TTL_SECONDS"
set_secret "UAT_CLOUDFLARE_TURN_TOKEN_ID"   "$CLOUDFLARE_TURN_TOKEN_ID"
set_secret "UAT_CLOUDFLARE_TURN_TOKEN_KEY"  "$CLOUDFLARE_TURN_TOKEN_KEY"
set_secret "UAT_CLOUDFLARE_SFU_TOKEN_ID"    "$CLOUDFLARE_SFU_TOKEN_ID"
set_secret "UAT_CLOUDFLARE_SFU_TOKEN_KEY"   "$CLOUDFLARE_SFU_TOKEN_KEY"

# UAT Auth Keys
set_secret "UAT_PRIVATE_KEY_PUBLIC_PEM"     "$PRIVATE_KEY_PUBLIC_PEM"

echo ""
echo "✅ UAT secrets complete"

# ==============================================================================
# Step 5: 設定 Cloudflare Worker Secrets (UAT 環境)
# ==============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Step 5: Set Cloudflare Worker Secrets (UAT)"
echo "═══════════════════════════════════════════════════════════════"

echo "Setting Worker secrets for message-data-uat..."

set_worker_secret() {
  local name="$1"
  local value="$2"
  if [ -n "$value" ]; then
    echo "$value" | npx -y wrangler@4 secret put "$name" --env uat 2>/dev/null && \
      echo "  ✅ $name" || echo "  ⚠️  $name failed (try: echo 'VALUE' | npx -y wrangler@4 secret put $name --env uat)"
  fi
}

# Worker 需要的 secrets（與 data-worker/src/worker.js 中的 env bindings 對應）
# worker.js 使用 env.HMAC_SECRET 和 env.ACCOUNT_HMAC_KEY
set_worker_secret "HMAC_SECRET"       "$DATA_API_HMAC"
set_worker_secret "ACCOUNT_HMAC_KEY"  "$ACCOUNT_HMAC_KEY"

echo ""
echo "✅ Worker secrets complete"

# ==============================================================================
# Step 6: 設定 Production Worker Secrets (如果還沒設)
# ==============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Step 6: Set Cloudflare Worker Secrets (Production)"
echo "═══════════════════════════════════════════════════════════════"

echo "Setting Worker secrets for message-data (production)..."

set_prod_worker_secret() {
  local name="$1"
  local value="$2"
  if [ -n "$value" ]; then
    echo "$value" | npx -y wrangler@4 secret put "$name" 2>/dev/null && \
      echo "  ✅ $name" || echo "  ⚠️  $name failed (try: echo 'VALUE' | npx -y wrangler@4 secret put $name)"
  fi
}

set_prod_worker_secret "HMAC_SECRET"       "$DATA_API_HMAC"
set_prod_worker_secret "ACCOUNT_HMAC_KEY"  "$ACCOUNT_HMAC_KEY"

echo ""
echo "✅ Production Worker secrets complete"

# ==============================================================================
# Summary
# ==============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " 🎉 Setup Complete!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo " Production (main branch):"
echo "   Worker:  message-data"
echo "   D1:      message_db (99728586-d8a9-4525-a1af-e68e84594047)"
echo "   Pages:   message-web-hybrid (production deployment)"
echo "   Backend: message-api on port $PORT"
echo ""
echo " UAT (non-main branches):"
echo "   Worker:  message-data-uat"
echo "   D1:      message_db_uat ($UAT_D1_ID)"
echo "   Pages:   message-web-hybrid (preview deployment → <branch>.message-web-hybrid.pages.dev)"
echo "   Backend: message-api-uat on port $UAT_PORT"
echo ""
echo " ⚠️  記得手動確認/調整以下項目："
echo "   1. SSH_HOST / SSH_USERNAME / SSH_PASSWORD — 如果 .env 中沒有定義"
echo "   2. UAT R2 bucket 'message-media-uat' — 需要在 Cloudflare Dashboard 建立"
echo "   3. UAT_DATA_API_URL — 確認 Worker URL 是否正確"
echo "   4. 如果 Worker 還有其他 secret bindings，請手動補設"
echo ""
echo " 測試方式："
echo "   git checkout -b feat/test-uat"
echo "   git push origin feat/test-uat"
echo "   → 觸發 deploy-uat.yml → 部署到 UAT 環境"
echo ""
