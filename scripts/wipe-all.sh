#!/usr/bin/env bash
set -euo pipefail

# 1. Setup paths and environment
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
SQL_FILE="$ROOT/scripts/cleanup/d1-wipe-all.sql"
DB_NAME="message_db"
WRANGLER_CONFIG="$ROOT/data-worker/wrangler.toml"

# Disable Wrangler telemetry and interactive prompts
export WRANGLER_SEND_METRICS=false
export WRANGLER_SKIP_UPDATE_CHECK=1
export CI=true

# Load .env for Cloudflare + R2 credentials
if [ -f "$ROOT/.env" ]; then
  set -a
  source "$ROOT/.env"
  set +a
fi

echo "🚀 Starting Full Environment Wipe (D1 + R2)..."

# 2. Remote D1 Wipe
echo "🗑️  Wiping Remote D1 Database..."
if [ ! -f "$SQL_FILE" ]; then
  echo "❌ SQL file not found: $SQL_FILE" >&2
  exit 1
fi

npx "wrangler@4" d1 execute "$DB_NAME" --remote --yes --config "$WRANGLER_CONFIG" --file "$SQL_FILE"

# 3. R2 Wipe
if [ -z "${S3_ENDPOINT:-}" ] || [ -z "${S3_BUCKET:-}" ] || [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_SECRET_KEY:-}" ]; then
  echo "⚠️  Missing S3_* env for R2 wipe (skipping). Ensure S3_ENDPOINT, S3_BUCKET, etc. are in .env" 
else
  echo "🗑️  Wiping R2 bucket: $S3_BUCKET"
  node --input-type=module - <<'EOF'
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const {
  S3_ENDPOINT,
  S3_REGION = 'auto',
  S3_BUCKET,
  S3_ACCESS_KEY,
  S3_SECRET_KEY
} = process.env;

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
  do {
    const listRes = await client.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
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
  console.log(`✅ R2 Wipe Complete: Deleted ${deleted} objects from ${S3_BUCKET}`);
}

wipeBucket().catch((err) => {
  console.error('❌ R2 wipe failed', err);
  process.exit(1);
});
EOF
fi

echo "✨ All environment data wiped successfully!"
