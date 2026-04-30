# Emergency Revoke & Compromised Deploy Plan

## Scope

This document covers the incident response procedure when a production deployment of SENTRY Messenger is suspected or confirmed to be compromised.

## Severity Levels

| Level | Description | Example |
|---|---|---|
| **P0** | Active exploitation of client code | Malicious JS exfiltrating keys or messages |
| **P1** | Compromised build pipeline | CI secrets leaked, unauthorized commit to main |
| **P2** | Suspicious build anomaly | Hash mismatch between source and deployed artifact |

## Immediate Response (< 15 minutes)

### Step 1: Confirm

```bash
# Verify deployed hash matches expected
curl -s https://message.sentry.red/.well-known/sentry-build.json | jq .build.commit
# Compare against known-good commit
```

### Step 2: Rollback

```bash
# Cloudflare Pages: revert to previous deployment
# Dashboard → Pages → message-web-hybrid → Deployments → [previous] → "Rollback to this deploy"

# OR via Wrangler CLI:
npx wrangler pages deployment rollback --project-name=message-web-hybrid
```

### Step 3: Force Service Worker Update

If the compromised deploy included a malicious `sw.js`, users' browsers cache the SW. Rollback deploys the old `sw.js`, and browsers will pick it up on next navigation (or within 24 hours).

For immediate invalidation, push a SW with a version bump that calls `skipWaiting()`.

### Step 4: Rotate Secrets

If CI secrets are compromised:

1. Rotate Cloudflare API token
2. Rotate `HMAC_SECRET` (data-worker)
3. Rotate all `S3_*` credentials
4. Rotate `VAPID_*` keys (regenerate push subscriptions)
5. Rotate GitHub deploy keys / PATs

### Step 5: Notify

- Post incident notice on status page
- If user data was potentially exposed, notify affected users via push notification from the restored (clean) deploy

## Investigation

### Build Artifact Comparison

```bash
# Checkout the compromised commit
git checkout <compromised-commit>
cd web && npm ci && npm run build

# Compare dist/ against a known-good build
diff <(find dist -type f -exec sha256sum {} \; | sort) \
     <(find /path/to/known-good/dist -type f -exec sha256sum {} \; | sort)
```

### Audit Trail

1. Check GitHub Actions run logs for the compromised deployment
2. Review git log for unauthorized commits
3. Check Cloudflare Pages deployment history
4. Review access logs for `/.well-known/sentry-build.json` (if CDN logged)

## Prevention

| Measure | Status |
|---|---|
| Branch protection on `main` | Required |
| Required PR reviews | Required |
| Signed commits | Recommended |
| CI/CD secrets in GitHub Environments | Required |
| `npm ci` (lockfile-only installs) | Enforced in CI |
| Build hash verification in CI | Implemented (`verify-build.mjs`) |
| SLSA provenance | Planned |
| cosign signing | Planned |

## Post-Incident

1. Write post-mortem document
2. Update this plan with lessons learned
3. Conduct independent security review of the incident
4. If keys were potentially compromised, implement forced re-key for affected users
