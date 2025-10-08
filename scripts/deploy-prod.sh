#!/usr/bin/env bash
set -euo pipefail

# Deploy all components (Worker + D1, Node API via PM2, Pages) to production.
# Requirements:
#  - wrangler (Cloudflare) installed and logged in
#  - node/npm installed
#  - pm2 installed if you want to run the Node API as a service
#  - .env configured at repo root for the Node API
#
# Usage:
#   scripts/deploy-prod.sh [--pages-project NAME] [--origin-api URL] [--apply-migrations]
#                          [--skip-worker] [--skip-api] [--skip-pages]
#
# Notes:
#  - --origin-api sets/updates ORIGIN_API for Cloudflare Pages (best-effort).
#  - Migrations are applied against remote D1 when --apply-migrations is set.

PAGES_PROJECT="message-web"
ORIGIN_API_URL=""
APPLY_MIGRATIONS=false
SKIP_WORKER=false
SKIP_API=false
SKIP_PAGES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pages-project)
      PAGES_PROJECT="$2"; shift 2 ;;
    --origin-api)
      ORIGIN_API_URL="$2"; shift 2 ;;
    --apply-migrations)
      APPLY_MIGRATIONS=true; shift ;;
    --skip-worker)
      SKIP_WORKER=true; shift ;;
    --skip-api)
      SKIP_API=true; shift ;;
    --skip-pages)
      SKIP_PAGES=true; shift ;;
    -h|--help)
      sed -n '1,80p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

has_cmd() { command -v "$1" >/dev/null 2>&1; }

echo "==> Checking prerequisites"
has_cmd node || { echo "node not found" >&2; exit 1; }
has_cmd npm  || { echo "npm not found"  >&2; exit 1; }
has_cmd wrangler || { echo "wrangler not found (npm i -g wrangler)" >&2; exit 1; }
if ! has_cmd pm2; then
  echo "pm2 not found (optional). Node API deploy will use pm2 if available." >&2
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Using Pages project: $PAGES_PROJECT"
if [[ -n "$ORIGIN_API_URL" ]]; then
  echo "==> Will set ORIGIN_API for Pages to: $ORIGIN_API_URL (best-effort)"
fi

if [[ "$SKIP_WORKER" != true ]]; then
  echo "\n==> Deploying Data-Worker (Cloudflare)"
  pushd data-worker >/dev/null
  wrangler deploy
  if [[ "$APPLY_MIGRATIONS" == true ]]; then
    echo "==> Applying D1 migrations (remote)"
    wrangler d1 migrations apply message_db --remote
  fi
  popd >/dev/null
else
  echo "==> Skipping Worker deploy"
fi

if [[ "$SKIP_API" != true ]]; then
  echo "\n==> Deploying Node API (pm2)"
  npm ci
  if has_cmd pm2; then
    if pm2 describe server >/dev/null 2>&1; then
      echo "==> Cleaning up legacy pm2 process: server"
      pm2 delete server || true
    fi
    if pm2 describe message-api >/dev/null 2>&1; then
      echo "==> Reloading existing pm2 process: message-api"
      pm2 reload message-api --update-env || pm2 restart message-api --update-env
    else
      echo "==> Starting pm2 process: message-api"
      NODE_ENV=production pm2 start src/server.js --name message-api
    fi
    pm2 save || true
  else
    echo "pm2 not installed; starting foreground server (Ctrl+C to stop)"
    echo "Run separately: NODE_ENV=production node src/server.js"
  fi
else
  echo "==> Skipping Node API deploy"
fi

if [[ "$SKIP_PAGES" != true ]]; then
  echo "\n==> Deploying Cloudflare Pages (production)"
  pushd web >/dev/null
  # Best-effort: set/update ORIGIN_API variable for Pages project (CLI behavior may vary across Wrangler versions)
  if [[ -n "$ORIGIN_API_URL" ]]; then
    # Try variable first (non-secret)
    if wrangler pages project variable put ORIGIN_API --project-name "$PAGES_PROJECT" --value "$ORIGIN_API_URL" 2>/dev/null; then
      echo "Set Pages variable ORIGIN_API"
    elif wrangler pages project secret put ORIGIN_API --project-name "$PAGES_PROJECT" <<<"$ORIGIN_API_URL" 2>/dev/null; then
      echo "Set Pages secret ORIGIN_API"
    else
      echo "Could not set ORIGIN_API via CLI. Ensure it is configured in Pages project settings." >&2
    fi
  fi
  wrangler pages deploy ./src --project-name="$PAGES_PROJECT" --branch=production
  popd >/dev/null
else
  echo "==> Skipping Pages deploy"
fi

echo "\n==> Done. Quick checks:"
echo "- API health:   curl -sS \"\${ORIGIN_API_URL:-https://<your-origin-domain>}\"/api/health"
echo "- Pages health: curl -sS https://<your-pages-domain>/api/health"
