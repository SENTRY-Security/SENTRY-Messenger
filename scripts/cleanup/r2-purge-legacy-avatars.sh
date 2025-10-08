#!/usr/bin/env bash
# r2-purge-legacy-avatars.sh
#
# 批次刪除 Cloudflare R2 中舊版頭像資料的範例腳本。
# 需先安裝 wrangler 並完成登入（npx wrangler login）。
#
# 使用方式：
#   ./scripts/cleanup/r2-purge-legacy-avatars.sh <R2_BUCKET> <KEY_FILE>
#
# * <R2_BUCKET>  : R2 Bucket 名稱，例如 sentry-files
# * <KEY_FILE>   : 內含要刪除的 object key，一行一個，例如 avatars/legacy-user.png
#
# 可搭配下列指令產生 KEY_FILE：
#   npx wrangler r2 object list <R2_BUCKET> --prefix avatars/legacy --json \
#     | jq -r '.[].key' > /tmp/legacy-avatars.txt

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <R2_BUCKET> <KEY_FILE>" >&2
  exit 1
fi

BUCKET="$1"
KEY_FILE="$2"

if [[ ! -f "$KEY_FILE" ]]; then
  echo "[ERROR] Key file not found: $KEY_FILE" >&2
  exit 1
fi

echo "Preparing to delete objects listed in $KEY_FILE from bucket $BUCKET"
echo "Press Ctrl+C to abort within 5 seconds..."
sleep 5

while IFS= read -r KEY; do
  [[ -z "$KEY" ]] && continue
  echo "Deleting $KEY"
  npx wrangler r2 object delete "$BUCKET" "$KEY"
done < "$KEY_FILE"

echo "Done."
