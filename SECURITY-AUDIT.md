# SENTRY-Messenger Security Audit Report

**Date:** 2026-02-20
**Scope:** Full codebase review — cryptography, authentication, server, client, key management, protocol, dependencies
**Branch:** `main` (commit at time of audit)

---

## Executive Summary

SENTRY-Messenger is an end-to-end encrypted messaging application implementing X3DH key agreement, Double Ratchet (DR) forward secrecy, OPAQUE password-authenticated key exchange, and AES-256-GCM AEAD encryption. The project demonstrates strong security design intent with explicit "no-fallback" cryptographic policy and modern library choices.

However, this audit identified **4 critical**, **8 high**, and **11 medium** severity findings across the codebase. The most urgent issues are: **disabled forward secrecy in the Double Ratchet**, **debug flags hardcoded to true in production builds**, **unauthenticated debug endpoints exposing server configuration**, and **27 dependency vulnerabilities including 1 critical CVE**.

**Overall Rating: MEDIUM** — Strong architecture undermined by implementation-level issues that must be resolved before production hardening.

---

## Table of Contents

1. [Critical Findings](#1-critical-findings)
2. [High Severity Findings](#2-high-severity-findings)
3. [Medium Severity Findings](#3-medium-severity-findings)
4. [Low Severity / Informational](#4-low-severity--informational)
5. [Positive Observations](#5-positive-observations)
6. [Dependency Vulnerability Summary](#6-dependency-vulnerability-summary)
7. [Recommendations by Priority](#7-recommendations-by-priority)

---

## 1. Critical Findings

### CRIT-01: Double Ratchet Forward Secrecy Disabled

**File:** `web/src/shared/crypto/dr.js:323-330`
**Severity:** CRITICAL
**CVSS Estimate:** 9.1

The sending-side ratchet step in `ratchetDH()` is **commented out with `[DEBUG]` annotations**:

```javascript
// [DEBUG] Disable recurring ratchet: Keep existing sending chain alive.
// st.ckS = null;
// [DEBUG] Disable sending side updates entirely
// st.PN = st.Ns;
// st.Ns = 0;
// st.myRatchetPriv = myNew.secretKey;
// st.myRatchetPub = myNew.publicKey;
```

**Impact:** The DH ratchet never advances on the sending side. A single compromised chain key reveals **all future messages** in that direction. Forward secrecy — the core security property of the Double Ratchet protocol — is effectively disabled. The private ratchet key is never rotated, so a one-time key compromise has permanent effect.

**Recommendation:** Uncomment lines 324-330 immediately. This appears to be debug instrumentation that was never reverted. Verify with integration tests that ratchet state advances correctly for both initiator and responder roles.

---

### CRIT-02: Debug Flags Hardcoded to `true` in Production

**File:** `web/src/app/ui/mobile/debug-flags.js:1-17`
**Severity:** CRITICAL
**CVSS Estimate:** 7.5

```javascript
export const DEBUG = {
  replay: true,           // ← enabled
  drVerbose: true,        // ← enabled — dumps DR state to console
  conversationReset: true // ← enabled
};
```

**Impact:** These flags are imported throughout the codebase including `dr.js` (line 25: `const drDebugLogsEnabled = DEBUG.drVerbose === true`). When `drVerbose` is true, the Double Ratchet logs DH output hashes, chain key seed hashes, ephemeral key prefixes, message key hashes, IV hashes, ciphertext hashes, AAD hashes, and counter values to `console.warn`. This metadata is sufficient for a sophisticated attacker with console access (e.g., via XSS or browser extension) to perform cryptanalysis or confirm message contents.

Additionally, `DEBUG.replay = true` enables replay diagnostic code paths, and `DEBUG.conversationReset = true` enables reset tracing — both leak protocol state.

**Recommendation:** Set all DEBUG flags to `false` for production builds. Implement a build-time flag or environment variable that strips debug logging from production bundles (e.g., esbuild `define` option).

---

### CRIT-03: Unauthenticated OPAQUE Debug Endpoint

**File:** `src/routes/auth.routes.js:606-624`
**Severity:** CRITICAL
**CVSS Estimate:** 7.8

```javascript
r.get('/auth/opaque/debug', (req, res) => {
  const out = {
    hasSeed: /^[0-9A-Fa-f]{64}$/.test(seedHex),
    hasPriv: !!privB64,
    hasPub: !!pubB64,
    seedLen: seedHex.length,
    privLen: Buffer.from(privB64 || '', 'base64').length || 0,
    pubLen: Buffer.from(pubB64 || '', 'base64').length || 0,
    serverId: OPAQUE_SERVER_ID || null
  };
  return res.json(out);
});
```

**Impact:** This endpoint is **publicly accessible with no authentication**. It reveals:
- Whether OPAQUE cryptographic material (seed, private key, public key) is configured
- Exact byte lengths of all key material
- The OPAQUE server identifier string

This information enables targeted attacks: an attacker can determine the exact key type/curve in use, confirm the server is running OPAQUE, and use the server ID for protocol-level attacks. Key length disclosure narrows brute-force search space.

**Recommendation:** Remove this endpoint entirely, or gate it behind admin HMAC authentication (`verifyIncomingHmac`). Debug introspection of cryptographic configuration should never be publicly accessible.

---

### CRIT-04: Dependency Vulnerabilities — 27 Total (1 Critical, 22 High)

**Source:** `npm audit` output
**Severity:** CRITICAL (aggregate)

| Package | Severity | Issue | Fix Available |
|---------|----------|-------|---------------|
| fast-xml-parser (via @aws-sdk) | CRITICAL | RangeError DoS, Entity expansion bypass, Regex injection in DOCTYPE | Update AWS SDK |
| elliptic | HIGH | Risky ECDLP implementation (GHSA-848j-6mx2-7j84) | Migrate to @noble/curves |
| systeminformation | HIGH | Command injection via unsanitized input | npm audit fix |
| pm2 | HIGH | Regular expression DoS | No fix available |
| qs | HIGH | arrayLimit bypass (DoS) | npm audit fix |
| lodash | MODERATE | Prototype pollution in _.unset/_.omit | npm audit fix |

**Recommendation:**
1. `npm install @aws-sdk/client-s3@latest @aws-sdk/s3-presigned-post@latest @aws-sdk/s3-request-presigner@latest`
2. `npm audit fix`
3. Migrate `elliptic` usage in `auth.routes.js` to `@noble/curves` (already a dependency)
4. Evaluate pm2 alternatives or accept risk with documentation

---

## 2. High Severity Findings

### HIGH-01: AAD Omission Fallback in AES-GCM Encryption

**File:** `web/src/shared/crypto/dr.js:399-401`
**Severity:** HIGH

```javascript
const aad = buildDrAad({ version, deviceId, counter: st.Ns });
const cipherParams = aad ? { name: 'AES-GCM', iv, additionalData: aad }
                         : { name: 'AES-GCM', iv };
```

**Impact:** If `buildDrAad()` returns a falsy value (null/undefined/empty), AES-GCM encrypts **without Additional Authenticated Data**. AAD binds the ciphertext to protocol context (version, device ID, counter). Without it, an attacker can:
- Transplant ciphertexts between conversations or devices
- Replay messages with altered headers
- Bypass counter verification

This directly contradicts the file's own security policy: "不允許任何協定降級".

**Recommendation:** Throw an error if AAD is null/empty instead of silently downgrading. AAD must always be present for protocol-bound encryption.

---

### HIGH-02: Plaintext Message Preview Sent via WebSocket

**File:** `src/controllers/messages.controller.js:288`
**Severity:** HIGH

```javascript
mgr.notifySecureMessage({
  // ...
  preview: messageInput.preview || messageInput.text || '',
});
```

**Impact:** When a new secure message is stored, the server sends a WebSocket notification that includes the plaintext `preview` or `text` field. This means the notification push contains **unencrypted message content** that:
- Transits the WebSocket in cleartext (server-side)
- Is visible to any server-side logging or monitoring
- Defeats the purpose of end-to-end encryption for notification delivery

**Recommendation:** Remove the `preview` field from WebSocket notifications entirely, or replace it with a static placeholder (e.g., "New message"). The client should decrypt the message locally to display previews.

---

### HIGH-03: Message Key Included in Encrypted Packet Output

**File:** `web/src/shared/crypto/dr.js:436`
**Severity:** HIGH

```javascript
return {
  aead: 'aes-256-gcm',
  header,
  iv_b64: b64(iv),
  ciphertext_b64: b64(new Uint8Array(ctBuf)),
  message_key_b64: mkB64   // ← message key returned alongside ciphertext
};
```

**Impact:** The `drEncryptText()` function returns the message key (`mk`) in the same object as the ciphertext. If any code path serializes or transmits the full return object (e.g., for debugging, logging, or network transport), the symmetric key used to encrypt the message is exposed alongside the ciphertext, rendering the encryption meaningless.

**Recommendation:** Audit all callers of `drEncryptText()` to ensure `message_key_b64` is stripped before transmission. Consider removing it from the return value entirely and providing it only through a separate channel if needed for key backup (vault) purposes.

---

### HIGH-04: Source Maps Enabled in Production Build

**File:** `web/build.mjs:52`
**Severity:** HIGH

```javascript
sourcemap: true,
```

**Impact:** Production source maps expose the full original source code including:
- All cryptographic implementation details
- Authentication logic
- Debug flag locations and bypass patterns
- Internal API endpoint structure

This significantly lowers the bar for targeted attacks against the application.

**Recommendation:** Set `sourcemap: false` for production builds, or use `sourcemap: 'external'` and serve source maps only from authenticated/restricted endpoints.

---

### HIGH-05: Missing Content Security Policy (CSP)

**File:** `web/src/_headers`
**Severity:** HIGH

The `_headers` file only contains cache-control directives. No CSP header is defined. While `helmet()` provides defaults on the API server, the static web frontend served via Cloudflare Pages has **no CSP**.

**Impact:** Without CSP, the application is vulnerable to:
- XSS attacks that load external scripts
- Data exfiltration via inline scripts
- Clickjacking (no frame-ancestors directive)

Given that the application handles cryptographic keys in the browser, XSS is especially dangerous — it could extract ratchet state, message keys, or identity keys.

**Recommendation:** Add comprehensive CSP headers to `web/src/_headers`:
```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.workers.dev; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
```

---

### HIGH-06: Unrestricted Media Upload Content-Type

**File:** `src/routes/v1/media.routes.js:188-191`
**Severity:** HIGH

```javascript
// 不限制 Content-Type，全部允許；若要限制可透過 env 重啟後再加入檢查。
const allowed = [];
```

**Impact:** The S3 presigned URL generation accepts any content type. An attacker can:
- Upload executable files (.exe, .html, .svg with scripts)
- Store malicious HTML that executes in the context of the S3/R2 domain
- Perform stored XSS if media URLs are ever rendered in a browser context

**Recommendation:** Implement a content-type allowlist (e.g., `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `audio/ogg`, `application/octet-stream`). Reject or sanitize unexpected types.

---

### HIGH-07: IndexedDB Key Material Stored Without OS-Level Protection

**File:** `web/src/app/features/message-key-vault.js`, `web/src/shared/crypto/db.js`
**Severity:** HIGH

All cryptographic key material (identity keys, ratchet state, prekeys, message keys) is stored in IndexedDB with AES-GCM wrapping using a key derived from `crypto.subtle`. However:
- The wrapping key itself is stored in IndexedDB
- No hardware-backed key storage (WebAuthn, platform keychain) is used
- Any script with same-origin access can read all key material

**Impact:** An XSS vulnerability (see HIGH-05) would allow full extraction of all cryptographic keys, enabling decryption of all past and future messages.

**Recommendation:** Consider using the Web Crypto API's `extractable: false` for wrapping keys where possible. Investigate WebAuthn PRF extension for hardware-bound key derivation. At minimum, ensure robust CSP prevents XSS.

---

### HIGH-08: `elliptic` Library Used Despite `@noble/curves` Available

**File:** `src/routes/auth.routes.js`
**Severity:** HIGH

The server uses the `elliptic` library for P-256 operations while `@noble/curves` (a modern, audited, constant-time implementation) is already installed as a dependency.

**Impact:** The `elliptic` library has known vulnerability advisories (GHSA-848j-6mx2-7j84) and uses non-constant-time scalar multiplication, which is vulnerable to timing side-channel attacks in server environments.

**Recommendation:** Replace all `elliptic` usage with `@noble/curves`:
```javascript
import { p256 } from '@noble/curves/p256';
```

---

## 3. Medium Severity Findings

### MED-01: CORS Allows Null Origin

**File:** `src/app.js:28`

```javascript
if (!origin) return cb(null, true); // non-browser or same-origin
```

When `origin` is `undefined` (non-browser requests), CORS allows the request. This is standard for server-to-server calls but also allows requests from `null` origins (sandboxed iframes, file:// protocol, redirects), which could be exploited for CSRF-like attacks.

---

### MED-02: Rate Limiting Disabled in Non-Production Environments

**File:** `src/app.js:50`

```javascript
const enableRateLimit = process.env.NODE_ENV === 'production' && process.env.DISABLE_RATE_LIMIT !== '1';
```

Rate limiting is only active in production. Staging or development environments accessible from the network have no protection against brute-force attacks.

---

### MED-03: WebSocket Token Custom Implementation

**File:** `src/utils/ws-token.js`

A custom JWT-like token implementation is used instead of a standard JWT library. While the implementation includes timing-safe comparison and proper HMAC-SHA256, custom crypto token implementations have a higher risk of subtle vulnerabilities compared to battle-tested libraries.

---

### MED-04: NTAG424 KDF Uses Hardcoded Default Salt

**File:** `src/lib/ntag424-kdf.js`

The KDF salt defaults to `'sentry.red'` when not configured. Hardcoded salts reduce the effectiveness of key derivation against rainbow table attacks.

---

### MED-05: Remote Console Debug Endpoint Writes Arbitrary Client Data to Disk

**File:** `src/routes/v1/debug.routes.js:88-104`

While disabled by default and requiring account authentication, when enabled the `/debug/console` endpoint writes client-supplied data directly to the filesystem via `fs.appendFile`. The `entries` array accepts arbitrary `args: z.array(z.any())`, which could be used for:
- Disk exhaustion attacks
- Log injection with crafted payloads

---

### MED-06: No Subresource Integrity for External CDN Imports

**File:** `web/build.mjs:55-58`

```javascript
external: [
  'https://esm.sh/*',
  'https://cdn.jsdelivr.net/*',
  'tweetnacl'
],
```

External CDN resources are loaded without SRI hashes. A CDN compromise could inject malicious code.

---

### MED-07: `trust proxy` Set to `loopback`

**File:** `src/app.js:15`

```javascript
app.set('trust proxy', 'loopback');
```

If the application is not behind a reverse proxy on loopback, or if an attacker can reach the application directly, they can spoof `X-Forwarded-For` headers to bypass IP-based rate limiting.

---

### MED-08: Skipped Message Keys Limit May Allow DoS

**File:** `web/src/shared/crypto/dr.js:22`

```javascript
const SKIPPED_KEYS_PER_CHAIN_MAX = 100;
```

An attacker could send messages with high counter values to force the recipient to derive and store up to 100 skipped message keys per chain, causing computational and memory overhead.

---

### MED-09: CI/CD Pipeline Disabled

**File:** `.github/workflows/e2e.yml.disabled`

The CI/CD workflow is disabled (file renamed with `.disabled` suffix). No automated security checks (npm audit, SAST, linting) run on pull requests or pushes to main.

---

### MED-10: `getStatus` Endpoint Leaks Environment Information

**File:** `src/controllers/messages.controller.js:31-36`

```javascript
export const getStatus = (req, res) => {
  res.json({
    name: process.env.SERVICE_NAME,
    version: process.env.SERVICE_VERSION,
    env: process.env.NODE_ENV
  });
};
```

Exposes service name, version, and environment to unauthenticated requests. Useful for reconnaissance.

---

### MED-11: No `.env.example` Template

No `.env.example` file exists in the repository to document required environment variables. This increases the risk of misconfiguration (missing HMAC secrets, wrong key lengths, etc.).

---

## 4. Low Severity / Informational

| ID | Finding | File |
|----|---------|------|
| LOW-01 | `package-lock.json` uses caret ranges (^) allowing minor version drift | `package.json` |
| LOW-02 | Multiple HMAC secret fallback chain may cause confusion | `src/controllers/messages.controller.js` |
| LOW-03 | `node-aes-cmac` (v0.1.1) is minimally maintained | `package.json` |
| LOW-04 | No Dependabot or Renovate configured for automated updates | `.github/` |
| LOW-05 | License (AGPL-3.0) requires source disclosure for network use — ensure compliance | `package.json` |
| LOW-06 | `packetHolderCache` (Map, max 2000) has no TTL/eviction beyond size | `dr.js:23-24` |
| LOW-07 | Server imports client debug-flags module | `messages.controller.js:25` |

---

## 5. Positive Observations

The audit identified several strong security practices:

- **Explicit "no-fallback" cryptographic policy** documented at the top of critical files (`dr.js`, `messages.controller.js`)
- **Modern cryptographic libraries**: `@noble/curves`, `@noble/ed25519`, `@noble/hashes`, `tweetnacl`, `@cloudflare/opaque-ts`
- **Timing-safe comparisons** used consistently for HMAC verification (`crypto.timingSafeEqual`)
- **WS_TOKEN_SECRET minimum length enforcement** (32 characters, validated at startup in `env.js`)
- **Zod schema validation** on all API inputs with strict typing
- **No secrets committed to git**: `.gitignore` properly excludes `.env*`, no hardcoded credentials found
- **SRI (Subresource Integrity)** computed for bundled assets in `build.mjs`
- **Build manifest includes git commit/branch/dirty state** for audit trail
- **Helmet.js** middleware applies default security headers on the API server
- **Body size limit** (2MB) prevents large payload attacks
- **OPAQUE protocol** for password authentication — significantly stronger than bcrypt/scrypt for PAKE
- **X3DH + Double Ratchet** architecture — correct protocol choice for E2E encryption (when ratchet is functioning)
- **Account digest normalization** with strict regex validation (`/^[0-9A-F]{64}$/`)

---

## 6. Dependency Vulnerability Summary

```
Total vulnerabilities: 27
  Critical: 1  (fast-xml-parser via AWS SDK)
  High:    22  (elliptic, systeminformation, pm2, qs, and transitive deps)
  Moderate: 1  (lodash prototype pollution)
  Low:      3  (minor issues in transitive dependencies)
```

Run `npm audit` for the full machine-readable report.

---

## 7. Recommendations by Priority

### Immediate (Before Next Release)

| # | Action | Effort |
|---|--------|--------|
| 1 | **Uncomment ratchet rotation** in `dr.js:324-330` and verify with tests | Low |
| 2 | **Set all DEBUG flags to `false`** in `debug-flags.js` | Low |
| 3 | **Remove or gate `/auth/opaque/debug`** endpoint behind admin auth | Low |
| 4 | **Run `npm audit fix`** and update AWS SDK packages | Low |
| 5 | **Remove `message_key_b64`** from `drEncryptText()` return (or strip before transport) | Low |
| 6 | **Remove plaintext `preview`** from WebSocket notifications | Low |
| 7 | **Make AAD mandatory** — throw on null AAD instead of omitting | Low |

### Short-Term (Within 2 Weeks)

| # | Action | Effort |
|---|--------|--------|
| 8 | Migrate `elliptic` to `@noble/curves` in `auth.routes.js` | Medium |
| 9 | Add CSP and security headers to `web/src/_headers` | Medium |
| 10 | Implement content-type allowlist for media uploads | Medium |
| 11 | Disable source maps in production build (`sourcemap: false`) | Low |
| 12 | Enable CI/CD pipeline with `npm audit` and SAST steps | Medium |
| 13 | Create `.env.example` documenting all required variables | Low |
| 14 | Remove or restrict `/api/v1/status` endpoint | Low |

### Medium-Term (Within 1 Month)

| # | Action | Effort |
|---|--------|--------|
| 15 | Add SRI hashes for external CDN imports | Medium |
| 16 | Implement build-time debug stripping (esbuild `define`) | Medium |
| 17 | Configure Dependabot or Renovate for automated dependency updates | Low |
| 18 | Add rate limiting to staging environments | Low |
| 19 | Evaluate hardware-backed key storage (WebAuthn PRF) | High |
| 20 | Review and reduce `SKIPPED_KEYS_PER_CHAIN_MAX` if feasible | Low |

---

*End of Security Audit Report*
