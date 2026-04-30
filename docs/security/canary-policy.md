# Canary Deployment Policy

## Policy Statement

**Canary deployments are prohibited for the SENTRY Messenger encryption client.**

All users MUST receive identical JavaScript bundles at all times. Serving different code to different users — whether by percentage rollout, geographic region, user segment, or A/B testing — is forbidden.

## Rationale

In an E2EE messenger, the client-side code IS the security boundary. If different users run different code:

1. **Targeted attacks**: A compromised deploy could serve malicious code to a specific user while all others see the legitimate version
2. **Audit impossibility**: Auditors cannot verify what code a specific user received
3. **Reproducibility failure**: The `/.well-known/sentry-build.json` hash would not match what some users actually execute

## Enforcement

### Cloudflare Pages

- Cloudflare Pages uses **atomic deployments**: all files are uploaded as a single unit and switch over atomically
- There is no built-in canary/percentage rollout feature in Cloudflare Pages
- Preview deployments (per-branch URLs) exist but are NOT used for production traffic

### CI/CD

- The `deploy.yml` workflow deploys to production only from the `main` branch
- No gradual rollout steps exist in the workflow
- No feature flags gate client-side encryption code

### Verification

Any user can verify they received the canonical build:

```bash
# Get the declared build hash
curl -s https://message.sentry.red/.well-known/sentry-build.json | jq .hashes.aggregate

# Rebuild from source and compare
git checkout <commit> && cd web && npm ci && npm run build
cat dist/build-manifest.json | jq '.files | map(.path + ":" + .sha256) | join("\n")' | sha256sum
```

## Exceptions

None. This policy applies to all production deployments without exception.

If a deployment must be tested before full rollout, use the UAT environment (`deploy-uat.yml`) which is a completely separate Cloudflare Pages project with separate domain.
