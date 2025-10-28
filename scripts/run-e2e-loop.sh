#!/usr/bin/env bash

# Loop Playwright E2E runs until they pass or the attempt limit is reached.
# Usage: ./scripts/run-e2e-loop.sh [max_attempts] [playwright_args...]

set -euo pipefail

MAX_ATTEMPTS="${1:-5}"
if [[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]]; then
  shift || true
else
  echo "第一個參數需為正整數（重試次數），預設 5 次" >&2
  exit 1
fi

TEST_ARGS=("$@")
if [ "${#TEST_ARGS[@]}" -eq 0 ]; then
  TEST_ARGS=("tests/e2e/full-flow.spec.mjs")
fi

attempt=0
while true; do
  attempt=$((attempt + 1))
  echo "=== Playwright E2E 第 ${attempt} 次執行：npx playwright test ${TEST_ARGS[*]} ==="
  if npx playwright test "${TEST_ARGS[@]}"; then
    echo "E2E 測試於第 ${attempt} 次嘗試通過 ✅"
    break
  fi

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "E2E 測試連續 ${MAX_ATTEMPTS} 次失敗 ❌" >&2
    exit 1
  fi

  echo "E2E 第 ${attempt} 次失敗，等待 5 秒後重試…" >&2
  sleep 5
done
