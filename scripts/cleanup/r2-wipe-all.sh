#!/usr/bin/env bash
# r2-wipe-all.sh
#
# *** 請務必確認 Bucket 內沒有要保留的資料 ***
# 這個腳本會刪除指定 bucket 內的所有物件。
#
# 使用方式：
#   ./scripts/cleanup/r2-wipe-all.sh <R2_BUCKET>
#
# 需要先執行 `npx wrangler login` 並設定 `CLOUDFLARE_ACCOUNT_ID`。

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <R2_BUCKET>" >&2
  exit 1
fi

BUCKET="$1"

echo "即將刪除 bucket '$BUCKET' 內的所有物件。"
echo "按 Ctrl+C 取消，5 秒後開始 ..."
sleep 5

TMP_LIST=$(mktemp)

npx wrangler r2 object list "$BUCKET" --json | jq -r '.[].key' > "$TMP_LIST"

while IFS= read -r KEY; do
  [[ -z "$KEY" ]] && continue
  echo "Deleting $KEY"
  npx wrangler r2 object delete "$BUCKET" "$KEY"
done < "$TMP_LIST"

rm -f "$TMP_LIST"

echo "Bucket '$BUCKET' 已清空。"
