#!/usr/bin/env bash
set -euo pipefail

# === 配置（必要時調整） ===
API_BASE="${API_BASE:-https://message.sentry.red}"   # 你的 API 網域
CLIENT_ID="${CLIENT_ID:-devtest}"                    # 送到後端的 X-Client-Id 標頭（可自訂）

# === 參數 ===
# 用法： ./r2-media-test.sh <convId> <filePath> [contentType] [ext]
if [[ $# -lt 2 ]]; then
  echo "用法：$0 <convId> <filePath> [contentType] [ext]" >&2
  exit 2
fi
CONV_ID="$1"
FILE="$2"
CONTENT_TYPE="${3:-}"
EXT="${4:-}"

# 工具檢查
command -v curl >/dev/null || { echo "缺少 curl"; exit 1; }
command -v jq   >/dev/null || { echo "缺少 jq（sudo apt install -y jq）"; exit 1; }
command -v stat >/dev/null || { echo "缺少 stat"; exit 1; }
command -v file >/dev/null || true

if [[ ! -f "$FILE" ]]; then
  echo "檔案不存在：$FILE" >&2
  exit 3
fi

# 推測 content-type / ext
if [[ -z "$CONTENT_TYPE" ]]; then
  if command -v file >/dev/null; then
    CONTENT_TYPE="$(file --mime-type -b "$FILE")"
  else
    CONTENT_TYPE="application/octet-stream"
  fi
fi
if [[ -z "$EXT" ]]; then
  bn="$(basename -- "$FILE")"
  if [[ "$bn" == *.* ]]; then
    EXT="${bn##*.}"
  else
    EXT="bin"
  fi
fi

SIZE_BYTES="$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE")"

echo "=== 1) sign-put 取得直傳授權（presigned PUT） ==="
RESP_SIGN_PUT="$(curl -sS -X POST "$API_BASE/api/v1/media/sign-put" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg conv "$CONV_ID" --arg ext "$EXT" --arg ct "$CONTENT_TYPE" \
        '{convId:$conv, ext:$ext, contentType:$ct}')")"

echo "$RESP_SIGN_PUT" | jq .

UPLOAD_URL="$(echo "$RESP_SIGN_PUT" | jq -r '.upload.url')"
UPLOAD_METHOD="$(echo "$RESP_SIGN_PUT" | jq -r '.upload.method // "PUT"')"
P_Key="$(echo "$RESP_SIGN_PUT" | jq -r '.upload.key')"
P_CT="$(echo "$RESP_SIGN_PUT" | jq -r '.upload.headers["Content-Type"] // empty')"

if [[ -z "$UPLOAD_URL" || -z "$P_Key" ]]; then
  echo "sign-put 回傳異常，缺少必要欄位" >&2
  exit 4
fi

echo
echo "=== 2) 直傳到 R2（presigned PUT） ==="
HTTP_CODE="$(
  curl -sS -o /tmp/r2-upload.out -w '%{http_code}' -X "$UPLOAD_METHOD" "$UPLOAD_URL" \
    -H "Content-Type: ${P_CT:-$CONTENT_TYPE}" \
    --upload-file "$FILE"
)"
echo "R2 回應狀態：$HTTP_CODE"
if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
  echo "上傳失敗，輸出：" >&2
  cat /tmp/r2-upload.out >&2 || true
  exit 5
fi
echo "上傳成功：key=$P_Key"

echo
echo "=== 3) 回填一則媒體訊息索引（/api/v1/messages） ==="
# 這裡 ciphertext_b64 先放 dummy；正式請放封裝後 media_key 的小訊息
RESP_MSG="$(curl -sS -X POST "$API_BASE/api/v1/messages" \
  -H 'Content-Type: application/json' \
  -H "X-Client-Id: $CLIENT_ID" \
  -d "$(jq -nc \
        --arg conv "$CONV_ID" \
        --arg obj  "$P_Key" \
        --arg aead "xchacha20poly1305" \
        --arg ct   "ZHVtbXk=" \
        --argjson size "$SIZE_BYTES" \
        '{convId:$conv, type:"media", ciphertext_b64:$ct, aead:$aead, header:{obj:$obj, size:$size}}')" )"
echo "$RESP_MSG" | jq .

MSG_ID="$(echo "$RESP_MSG" | jq -r '.msgId // empty')"
if [[ -z "$MSG_ID" ]]; then
  echo "警告：後端未回 msgId，但不影響後續 sign-get 測試。" >&2
fi

echo
echo "=== 4) 產生短效下載 URL 並抓回前 32 bytes 驗證 ==="
RESP_GET="$(curl -sS -X POST "$API_BASE/api/v1/media/sign-get" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg key "$P_Key" '{key:$key}')" )"
echo "$RESP_GET" | jq .

GET_URL="$(echo "$RESP_GET" | jq -r '.download.url')"
if [[ -z "$GET_URL" ]]; then
  echo "sign-get 回傳異常" >&2
  exit 6
fi

echo -n "下載前 32 bytes："
curl -sS "$GET_URL" | head -c 32 | hexdump -C
echo
echo "完成。Object Key: $P_Key"