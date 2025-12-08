#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_FILE="$ROOT/scripts/cleanup/d1-wipe-all.sql"
WRANGLER_BIN="${WRANGLER_BIN:-wrangler}"
DB_NAME="${DB_NAME:-message_db}"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-$ROOT/data-worker/wrangler.toml}"
REMOTE_FLAG="${REMOTE_FLAG:---remote}"

if [ ! -f "$SQL_FILE" ]; then
  echo "SQL file not found: $SQL_FILE" >&2
  exit 1
fi

cd "$ROOT"

echo "Executing wipe for DB=$DB_NAME using $WRANGLER_BIN with config $WRANGLER_CONFIG"
"$WRANGLER_BIN" d1 execute "$DB_NAME" $REMOTE_FLAG --config "$WRANGLER_CONFIG" --file "$SQL_FILE"
