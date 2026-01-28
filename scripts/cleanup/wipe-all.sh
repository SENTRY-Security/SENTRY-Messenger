#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SQL_FILE="$ROOT/scripts/cleanup/d1-wipe-all.sql"
WRANGLER_BIN="${WRANGLER_BIN:-wrangler}"
DB_NAME="${DB_NAME:-message_db}"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-$ROOT/data-worker/wrangler.toml}"
REMOTE_FLAG="${REMOTE_FLAG:---remote}"
SKIP_R2_WIPE="${SKIP_R2_WIPE:-false}"

if [ ! -f "$SQL_FILE" ]; then
  echo "SQL file not found: $SQL_FILE" >&2
  exit 1
fi

cd "$ROOT"

echo "Executing wipe for DB=$DB_NAME using $WRANGLER_BIN with config $WRANGLER_CONFIG"
"$WRANGLER_BIN" d1 execute "$DB_NAME" $REMOTE_FLAG --yes --config "$WRANGLER_CONFIG" --file "$SQL_FILE"

if [ "$SKIP_R2_WIPE" = "true" ]; then
  echo "Skipping R2 wipe (SKIP_R2_WIPE=true)"
  exit 0
fi

if [ -z "${S3_ENDPOINT:-}" ] || [ -z "${S3_BUCKET:-}" ] || [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_SECRET_KEY:-}" ]; then
  echo "Missing S3_* env for R2 wipe (require S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY)" >&2
  exit 1
fi

echo "Wiping R2 bucket $S3_BUCKET via $S3_ENDPOINT (prefix=${S3_WIPE_PREFIX:-<none>})"
node --input-type=module - <<'EOF'
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const {
  S3_ENDPOINT,
  S3_REGION = 'auto',
  S3_BUCKET,
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  S3_WIPE_PREFIX = ''
} = process.env;

if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
  throw new Error('S3 wipe aborted: missing S3_* env');
}

const client = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY
  }
});

async function wipeBucket() {
  let token = undefined;
  let deleted = 0;
  const prefix = S3_WIPE_PREFIX || undefined;
  do {
    const listRes = await client.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: token
    }));
    const objects = Array.isArray(listRes.Contents)
      ? listRes.Contents.map((item) => ({ Key: item.Key })).filter((obj) => obj.Key)
      : [];
    if (objects.length) {
      await client.send(new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: objects }
      }));
      deleted += objects.length;
    }
    token = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (token);
  console.log(JSON.stringify({ bucket: S3_BUCKET, prefix: prefix || null, deleted }));
}

wipeBucket().catch((err) => {
  console.error('R2 wipe failed', err);
  process.exit(1);
});
EOF
