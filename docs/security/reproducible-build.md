# Reproducible Build

## Overview

SENTRY Messenger frontend bundles are designed to be **reproducible**: given the same source commit and locked dependencies, any party can rebuild and obtain byte-identical output.

## Prerequisites

- Node.js 20.x (match CI version)
- npm (ships with Node)
- Git

## Steps to Reproduce

```bash
# 1. Clone at the exact commit shown in /.well-known/sentry-build.json
git clone https://github.com/SENTRY-Security/SENTRY-Messenger.git
cd SENTRY-Messenger
git checkout <commit-sha>

# 2. Install exact dependency tree from lockfile
cd web
npm ci

# 3. Build
npm run build

# 4. Verify against production
npm run verify
# — OR compare manually:
# diff <(cat dist/build-manifest.json | jq '.files') <(curl -s https://message.sentry.red/build-manifest.json | jq '.files')
```

## What Makes It Reproducible

| Factor | How We Handle It |
|---|---|
| Dependency versions | `package-lock.json` committed; `npm ci` installs exact tree |
| esbuild version | Pinned in `package.json` (`^0.24.0` → lockfile resolves exact) |
| Build script | `web/build.mjs` — deterministic, no random/timestamp in output |
| Source maps | Generated but excluded from hash comparison |
| HTML injection | SRI hashes + commit SHA injected deterministically |
| Environment | `SENTRY_ENV` derived from git branch (main=production) |

## Known Factors That May Affect Reproducibility

- **Timestamps in HTML**: `APP_BUILD_AT` is injected at build time. Two builds at different times produce different HTML. The `build-manifest.json` records the final hashes.
- **esbuild chunk hashes**: esbuild uses content hashing for chunk filenames. These are deterministic for identical input.

## Verification Endpoint

Production: `https://message.sentry.red/.well-known/sentry-build.json`

This JSON contains:
- Git commit SHA
- SHA-256 hash for every file in the deploy
- Aggregate hash (single hash over all file hashes)
- SRI values for entry-point scripts and CSS
- Service worker hash

## SLSA Provenance (Level 2)

Every production deploy automatically generates a [SLSA](https://slsa.dev/) provenance attestation via `slsa-github-generator`. This cryptographically binds the build artifact to:

- The source repository and commit
- The GitHub Actions workflow that built it
- The build parameters and environment

Provenance is stored as a GitHub attestation and can be verified with:

```bash
gh attestation verify web-dist.tar.gz --repo SENTRY-Security/SENTRY-Messenger
```

The CI also calls `actions/attest-build-provenance@v2` which creates a Sigstore-backed attestation viewable at the repository's Attestations tab.

## Independent Verification

Any third party can:
1. Read `/.well-known/sentry-build.json` to get the commit
2. Checkout that commit
3. Run `npm ci && npm run build`
4. Compare `dist/build-manifest.json` hashes against the live endpoint
5. Verify SLSA provenance via `gh attestation verify`
6. Report match/mismatch
