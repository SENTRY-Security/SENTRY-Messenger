# Service Worker Update Policy

## Current Strategy: Immediate (`skipWaiting` + `clients.claim`)

SENTRY Messenger uses an **immediate activation** strategy for Service Worker updates:

```javascript
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
```

### Behavior

1. Browser detects byte-level change in `sw.js` (standard 24-hour check + navigation check)
2. New SW installs in background
3. `skipWaiting()` — immediately activates (does NOT wait for all tabs to close)
4. `clients.claim()` — takes control of all open tabs
5. All tabs now use the new SW for push notifications

### Rationale

- **Security**: Ensures all users receive security patches without waiting for tab refresh
- **Consistency**: All tabs use the same SW version (no split-brain)
- **Push notifications**: Updated push decryption logic applies immediately

### What the SW Does

The SW handles **push notifications only** — no offline caching, no request interception. Its scope is limited to:

- Receiving push events
- Decrypting E2EE push previews (ECDH P-256 + HKDF + AES-256-GCM)
- Displaying notifications with localized text
- Handling notification click (open/focus app)

### Update Triggers

| Trigger | When |
|---|---|
| Navigation | Browser checks for SW update on each navigation to the app |
| 24-hour timer | Browser automatically checks every 24 hours |
| Deploy | Cloudflare Pages deploys new `sw.js` atomically |

### Rollback

SW rollback is achieved by deploying a previous version of `sw.js` via Cloudflare Pages rollback. The browser will pick up the change on next navigation or 24-hour check.

### Hash Verification

The SHA-256 hash of the active `sw.js` is published at:
```
GET /.well-known/sentry-build.json → .service_worker.hash
```

Users or auditors can verify:
```bash
curl -s https://message.sentry.red/sw.js | sha256sum
# Compare against .well-known/sentry-build.json → .hashes.files["/sw.js"]
```

### Canary Prohibition

Service Worker updates are **never** canary-deployed. Cloudflare Pages atomic deployment ensures all users receive the same `sw.js` simultaneously. See `canary-policy.md`.
