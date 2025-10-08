#!/usr/bin/env bash
# wipe-all.sh
#
# 清除 Cloudflare D1（message_db）以及 R2 Bucket（message-media）中的所有資料。
# 依賴：
#   - npx + wrangler (自 repo 內 data-worker/wrangler.toml 取得設定)
#   - python3 與 python3-venv（用來建立 awscli 的虛擬環境）
#   - .env 檔案內需提供 S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY
#
# 使用方式：
#   ./scripts/cleanup/wipe-all.sh
#
# 注意：此腳本會刪除所有雲端資料，請務必確認只在測試環境執行。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_WORKER_DIR="$ROOT_DIR/data-worker"
ENV_FILE="$ROOT_DIR/.env"

if [[ ! -f "$DATA_WORKER_DIR/wrangler.toml" ]]; then
  echo "[wipe-all] 找不到 data-worker/wrangler.toml" >&2
  exit 1
fi

# 讀取 .env 中的變數（若存在）
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      CLOUDFLARE_ACCOUNT_ID) export CLOUDFLARE_ACCOUNT_ID="$value" ;;
      S3_ENDPOINT) S3_ENDPOINT="$value" ;;
      S3_BUCKET) S3_BUCKET="$value" ;;
      S3_ACCESS_KEY) S3_ACCESS_KEY="$value" ;;
      S3_SECRET_KEY) S3_SECRET_KEY="$value" ;;
    esac
  done < <(grep -E '^(CLOUDFLARE_ACCOUNT_ID|S3_ENDPOINT|S3_BUCKET|S3_ACCESS_KEY|S3_SECRET_KEY)=' "$ENV_FILE")
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "[wipe-all] 請先在環境變數或 .env 中設定 CLOUDFLARE_ACCOUNT_ID" >&2
  exit 1
fi

S3_ENDPOINT=${S3_ENDPOINT:-}
S3_BUCKET=${S3_BUCKET:-message-media}
S3_ACCESS_KEY=${S3_ACCESS_KEY:-}
S3_SECRET_KEY=${S3_SECRET_KEY:-}

if [[ -z "$S3_ENDPOINT" || -z "$S3_ACCESS_KEY" || -z "$S3_SECRET_KEY" ]]; then
  echo "[wipe-all] 請確認 .env 內存在 S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY" >&2
  exit 1
fi

export CLOUDFLARE_ACCOUNT_ID

D1_DB_NAME="message_db"
WRANGLER_CMD=(npx wrangler --config "$DATA_WORKER_DIR/wrangler.toml")

# 清除 D1 中的資料表
D1_TABLES=(
  messages
  messages_secure
  conversations
  friend_invites
  tags
  prekey_opk
  prekey_users
  device_backup
  media_objects
  accounts
  opaque_records
)

echo "[wipe-all] 開始清除 D1 ($D1_DB_NAME)"
for table in "${D1_TABLES[@]}"; do
  echo "  - DELETE FROM $table;"
  if ! "${WRANGLER_CMD[@]}" d1 execute "$D1_DB_NAME" --remote --command "DELETE FROM $table;" >/dev/null; then
    echo "    (忽略) 無法刪除 $table，可能該表不存在。"
  fi
done

echo "[wipe-all] D1 清除完成"

# 建立 awscli 虛擬環境（若不存在）
VENV_DIR="$ROOT_DIR/.tmp/awscli-venv"
if [[ ! -d "$ROOT_DIR/.tmp" ]]; then
  mkdir -p "$ROOT_DIR/.tmp"
fi

if [[ ! -d "$VENV_DIR" ]]; then
  echo "[wipe-all] 建立 awscli 虛擬環境 ($VENV_DIR)"
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --quiet awscli
fi

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY"
export AWS_DEFAULT_REGION="auto"

AWS_BIN="$VENV_DIR/bin/aws"

echo "[wipe-all] 清除 R2 bucket ($S3_BUCKET)"
"$AWS_BIN" --endpoint-url "$S3_ENDPOINT" s3 rm "s3://$S3_BUCKET" --recursive || true

echo "[wipe-all] R2 清除完成"

echo "[wipe-all] 任務完成"
