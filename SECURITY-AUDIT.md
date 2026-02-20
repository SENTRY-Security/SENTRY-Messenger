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

**Recommendation:** Uncomment lines 324-330 — but **NOT in isolation**. This change has cascading effects across the entire counter-based message delivery pipeline. See **Appendix A** for the complete impact analysis covering 14 identified problems across 6 architectural layers and 12 files requiring synchronized updates. Simply uncommenting these lines without the companion changes **will break message delivery and cause permanent message loss**.

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
| 1 | **Enable ratchet rotation** — requires synchronized changes across 12 files (see Appendix A) | High |
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

## Appendix A: Forward Secrecy Enablement — Full Impact Analysis

**Date:** 2026-02-20
**Context:** CRIT-01 recommends uncommenting the ratchet rotation in `dr.js:323-330`. This appendix analyzes the **complete blast radius** of that change across the entire codebase, identifying every module that requires synchronized updates.

> **CRITICAL WARNING:** Simply uncommenting lines 323-330 without the synchronized changes described below **will break message delivery**, cause **counter desynchronization**, and potentially result in **permanent message loss**.

---

### A.1 Architecture Overview: Two Counter Domains

The system maintains **two independent counter domains** that must remain synchronized:

```
┌──────────────────────────────────────────────────────────┐
│  DR Protocol Layer (per-chain counters)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │ Ns (send)│  │ Nr (recv)│  │ PN (prev)│  ← per epoch  │
│  │ resets=0 │  │ resets=0 │  │ = old Ns │    on ratchet  │
│  └──────────┘  └──────────┘  └──────────┘               │
└──────────┬───────────────────────────────────────────────┘
           │ mapped via NsTotal / NrTotal
┌──────────▼───────────────────────────────────────────────┐
│  Transport Layer (monotonic counters)                    │
│  ┌──────────┐  ┌──────────┐                              │
│  │ NsTotal  │  │ NrTotal  │  ← never reset,             │
│  │ (global) │  │ (global) │    strictly increasing       │
│  └──────────┘  └──────────┘                              │
└──────────┬───────────────────────────────────────────────┘
           │ used as `counter` field in API
┌──────────▼───────────────────────────────────────────────┐
│  Server DB (D1/SQLite)                                   │
│  messages_secure.counter  ← monotonic per                │
│                              (conversation_id,           │
│                               sender_account_digest,     │
│                               sender_device_id)          │
│  Constraint: new counter > MAX(counter) else 409         │
└──────────────────────────────────────────────────────────┘
```

**Current state (ratchet disabled):** Ns never resets, NsTotal ≈ Ns, so both domains stay trivially synchronized.

**After enabling ratchet:** Ns resets to 0 on each DH ratchet step. NsTotal must absorb the reset and continue incrementing. This is where the bugs emerge.

---

### A.2 Layer 1 — DR Protocol (`web/src/shared/crypto/dr.js`)

#### A.2.1 `drRatchet()` (line 308-343) — The Core Change

**What gets uncommented:**
```javascript
st.ckS = null;                          // line 324: clear old sending chain
st.PN = st.Ns;                          // line 326: save previous chain length
st.Ns = 0;                              // line 327: reset sending counter
st.myRatchetPriv = myNew.secretKey;     // line 329: rotate DH keypair
st.myRatchetPub = myNew.publicKey;      // line 330: rotate DH keypair
```

**Problem 1: NsTotal double-counting**

Lines 309-314 execute BEFORE the uncommented code:
```javascript
const nsBase = Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) : 0;
const nsPrev = Number.isFinite(st?.Ns) ? Number(st.Ns) : 0;
st.NsTotal = nsBase + nsPrev;  // line 313
```

But `drEncryptText()` at line 389 ALSO increments NsTotal:
```javascript
st.NsTotal = Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) + 1 : st.Ns;
```

**Result:** When `drRatchet` is called from `drDecryptText` (receiving side), NsTotal gets `+= Ns`. Then when the next `drEncryptText` fires, NsTotal gets `+= 1` again. If Ns was 5 before the ratchet:
- NsTotal goes from X to X+5 (in drRatchet)
- Then X+5 to X+6 (in drEncryptText)
- But it should only go from X to X+1 (the next message)
- **Net error: NsTotal is inflated by (Ns - 1) = 4**

**Fix required:** `drRatchet` should NOT accumulate `NsTotal += Ns`. NsTotal is already being maintained by `drEncryptText` per-message. The accumulation at line 313 is only correct if `drRatchet` is the *only* place that tracks total counts — but it isn't.

**Problem 2: Asymmetric ratchet behavior**

`drRatchet()` is called from `drDecryptText()` (receiving-side ratchet), but the **sending-side ratchet** happens inside `drEncryptText()` at lines 362-382. Both paths update `PN`, `Ns`, and DH keys, but they do so independently:

| Operation | `drRatchet` (recv-side) | `drEncryptText` (send-side) |
|-----------|------------------------|-----------------------------|
| PN update | `st.PN = st.Ns` ✓ | `st.PN = st.Ns` ✓ |
| Ns reset | `st.Ns = 0` ✓ | `st.Ns = 0` ✓ |
| ckS clear | `st.ckS = null` ✓ | triggers because `!st.ckS` |
| DH rotate | `myNew = genX25519Keypair()` ✓ | `myNew = genX25519Keypair()` ✓ |
| NsTotal | `+= Ns` (WRONG) | `+= 1` (correct per-msg) |

**This means recv-side and send-side ratchets have DIFFERENT NsTotal semantics.** The fix must unify them.

#### A.2.2 `drEncryptText()` (line 345-438)

**Problem 3: NsTotal is incremented twice on send-side ratchet**

When `!st.ckS` and `st.theirRatchetPub` exists (line 352, 362), a send-side ratchet occurs:
1. Line 370: `st.Ns = 0`
2. Line 388: `st.Ns += 1` → Ns becomes 1
3. Line 389: `st.NsTotal = NsTotal + 1`

This is correct for the send-side path. But if a recv-side ratchet already fired `drRatchet()` which did `NsTotal += Ns`, then the `+1` at line 389 compounds on an already-inflated NsTotal.

**Fix required:** Remove `NsTotal += Ns` from `drRatchet()`. Let `drEncryptText` be the sole owner of NsTotal increments.

#### A.2.3 `drDecryptText()` (line 440-994)

**Problem 4: Out-of-order messages from old chain are unrecoverable**

After a ratchet is performed at line 717, `working.theirRatchetPub` is updated to the new key. If a late message arrives with the OLD `ek_pub_b64`:

1. Line 645-646: `sameReceiveChain` = false (old key ≠ new key)
2. Line 649: replay check skipped (not same chain)
3. Line 683: enters ratchet branch (keys differ)
4. Line 717: `drRatchet(working, theirPub)` — performs DH with old key but current `myRatchetPriv`
5. Since `myRatchetPriv` was rotated during the earlier ratchet, the DH output is wrong
6. Derived `ckR` is wrong → derived `mk` is wrong → **AES-GCM decryption fails**

**Fix required:** Before ratcheting, check the skipped keys map for old chain IDs. If `packet.header.ek_pub_b64` matches a chain in `skippedKeys`, use the stored key instead of ratcheting. The special case at line 666-676 (responder, headerN===1, Nr===0) is insufficient — it only covers the initial handshake scenario.

**Problem 5: `pn` header value is unvalidated**

Line 698: `if (prevChainId && working.ckR && Number.isFinite(pn) && pn > working.Nr)`

The `pn` value comes from the packet header (attacker-controlled). A malicious `pn=999999` forces derivation of up to 999999 keys in the while-loop at lines 707-713. The warning at line 700-703 only logs — it doesn't abort.

**Fix required:** Hard-reject if `pn - working.Nr > SKIPPED_KEYS_PER_CHAIN_MAX`.

---

### A.3 Layer 2 — Transport Counter Bridge (`web/src/app/features/dr-session.js`)

#### A.3.1 `reserveTransportCounter()` (line 322-353)

```javascript
const before = requireTransportCounter(state, ...);  // reads state.NsTotal
const reserved = before + 1;
state.NsTotal = reserved;  // writes state.NsTotal
return reserved;
```

**Problem 6: Race between reserve and encrypt**

The flow is:
1. `reserveTransportCounter()` → NsTotal = X+1, returns X+1
2. `drEncryptText()` → internally does NsTotal += 1, making NsTotal = X+2
3. Line 1898-1901 "correction":
   ```javascript
   if (afterEncryptTotal === transportCounter + 1  // X+2 === X+2? YES
       || afterEncryptTotal < transportCounter) {
     state.NsTotal = transportCounter;  // force NsTotal back to X+1
   }
   ```

Currently this works because `drEncryptText` always increments NsTotal by exactly 1, matching the `=== transportCounter + 1` condition, so the correction fires and resets NsTotal to the reserved value.

**After enabling ratchet:** If a send-side ratchet occurs inside `drEncryptText`, NsTotal changes by more than +1 (due to Problem 3's `NsTotal += Ns` in `drRatchet`). The correction condition `afterEncryptTotal === transportCounter + 1` becomes FALSE, and `afterEncryptTotal < transportCounter` is also FALSE. **The correction doesn't fire**, leaving NsTotal inflated. Next `reserveTransportCounter` returns an inflated value. The server has a gap in counter sequence (some counter values were never sent). The receiving gap-queue tries to fetch those phantom counters and gets 404s.

**Fix required:** The correction logic needs to either:
- Always force `state.NsTotal = transportCounter` after encryption (simplest)
- Or be removed entirely if `drEncryptText` stops touching NsTotal

#### A.3.2 `seedTransportCounterFromServer()` (line 355-451)

This function queries the server for existing messages and sets NsTotal to the highest observed counter. It runs when `state.baseKey.snapshot === true` (restored from snapshot).

**Problem 7: No chain epoch awareness**

The seed logic scans up to 50 messages and picks the max counter. After enabling ratchet, the same conversation may have messages across multiple chain epochs. The max counter is correct as a transport-layer value, but the function also doesn't reset `Ns` to match the chain-epoch position.

**Impact:** After snapshot restore, `Ns` may be stale (from an old epoch), while NsTotal is correct (from server). The next `drEncryptText` uses the stale `Ns` to build the AAD counter (`buildDrAad({ counter: st.Ns })`), which won't match what the receiver expects.

**Fix required:** When seeding from server, also reset `Ns = 0` and `PN = 0` since the chain-epoch state is lost. Or store `Ns` and `PN` in the snapshot and restore them alongside NsTotal.

#### A.3.3 CounterTooLow Repair (line 2164-2260)

```javascript
if (errorCode === COUNTER_TOO_LOW_CODE) {
  const sendState = await fetchAuthoritativeSendState({...});
  state.NsTotal = expectedCounter - 1;  // line 2177: FORCE OVERWRITE
  // ... re-encrypt with new counter ...
}
```

**Problem 8: Re-encryption consumes a chain key without updating the receiver**

When CounterTooLow triggers:
1. First `drEncryptText` already consumed chain key N and incremented Ns
2. NsTotal is overwritten to server's `expectedCounter - 1`
3. Second `drEncryptText` consumes chain key N+1 and increments Ns again
4. Message is sent with the server's expected counter

But chain key N was consumed for a ciphertext that was **never delivered** (the 409 response means the server rejected it). The receiver will never see a message encrypted with chain key N, but the sender's chain has advanced past it.

**After enabling ratchet:** This is worse because:
- If the re-encryption triggers a send-side ratchet (because `ckS = null` after recv-side ratchet), the wasted chain key is from the OLD epoch, and the new message is from a NEW epoch
- The receiver expects the next message on the old epoch's chain, but gets a message on a new epoch's chain with a different `ek_pub_b64`
- The receiver's `pn` check will have gaps

**Fix required:** On CounterTooLow, the first encrypted packet must be discarded AND the DR state must be rolled back to pre-encryption state before re-encrypting. The current code does not roll back DR state — it only overwrites NsTotal.

#### A.3.4 `persistContactShareSequence()` (line 4500-4590)

```javascript
state.NrTotal = headerCounter;  // line 4525: DIRECT OVERWRITE
if ((state.Nr || 0) < headerCounter) state.Nr = headerCounter;  // line 4526
```

**Problem 9: NrTotal overwrite ignores chain epoch boundaries**

This function sets NrTotal = headerCounter (from the received message's DR header `n` field). But after enabling ratchet, `header.n` resets to 1 at each epoch. Setting `NrTotal = 1` when it was previously 50 causes NrTotal to **go backwards**, breaking the transport-layer monotonicity invariant.

**Fix required:** NrTotal should be `max(current NrTotal, NrTotal + 1)` — monotonically increasing, never decreasing. The header counter `n` should be used for chain-level tracking only.

---

### A.4 Layer 3 — Server APIs

#### A.4.1 `POST /messages/secure` — Counter Validation

**File:** `data-worker/src/worker.js:2193-2203`

```javascript
const maxCounter = Number(maxRow?.max_counter ?? -1);
if (maxCounter >= 0 && msgCounter <= maxCounter) {
  return json({ error: 'CounterTooLow', maxCounter }, { status: 409 });
}
```

**Impact of ratchet enablement:** The server enforces **strict monotonicity** (`counter > max_counter`). This is correct and requires no change. However, the client must ensure NsTotal never produces duplicates or gaps — which is exactly what Problems 6-8 above can cause.

#### A.4.2 `GET /messages/by-counter` — Gap Filling

**File:** `data-worker/src/worker.js` and `web/src/app/features/messages-flow/gap-queue.js`

```javascript
// gap-queue.js: sequential counter fetch
for (let counter = startCounter; counter <= targetCounter; counter += 1) {
  const result = await fetchByCounter(conversationId, counter, ...);
}
```

**Problem 10: Assumes no gaps in counter sequence**

The gap-queue iterates every integer from `startCounter` to `targetCounter`. If the sender's NsTotal jumped (due to inflation from Problem 6), some counter values in that range were never stored on the server. The gap-queue will:
1. Fetch counter N → 404 (doesn't exist)
2. Retry up to `GAP_QUEUE_RETRY_MAX` times
3. Eventually mark as `unable_to_decrypt`
4. Move to counter N+1

This causes unnecessary network traffic, delays, and false-positive "unable to decrypt" errors in the UI.

**Fix required:** The gap-queue should tolerate 404s gracefully — skip missing counters instead of retrying them as errors. Or better: ensure the sender never creates counter gaps.

#### A.4.3 `POST /messages/send-state` — Counter Recovery

**File:** `data-worker/src/worker.js:2383-2415`

```javascript
const expectedCounter = lastAcceptedCounter + 1;
```

**Problem 11: `send-state` response is unauthenticated**

The `expectedCounter` value is returned as a plain JSON number. There is no HMAC or signature binding it to the conversation/device. A MITM (even at the CDN layer) could return a fabricated low `expectedCounter`, causing the client to:
1. Set `NsTotal = (fake low value) - 1`
2. Re-encrypt a message with a counter that was already used
3. Server accepts it (if the MITM also blocks the original message)
4. **Counter reuse**: two different plaintexts encrypted with different chain keys but same transport counter

After enabling ratchet, this is more dangerous because counter reuse across chain epochs could cause the receiver to attempt decryption with the wrong chain key, permanently corrupting their ratchet state.

**Fix required:** Either sign the `send-state` response with the conversation's HMAC secret, or eliminate the counter recovery flow entirely and use a server-assigned counter model.

---

### A.5 Layer 4 — Receiving Pipeline

#### A.5.1 `getLocalProcessedCounter()` (local-counter.js)

**Priority order:**
1. Vault `header_counter` (from `MessageKeyVault.getLatestState()`)
2. DR state `holder.NrTotal` (from in-memory `drSessMap`)
3. Default: 0

**Problem 12: Vault `header_counter` uses DR-level counter, not transport counter**

The vault stores `headerCounter` which comes from `vaultCounter = transportCounter` (dr-session.js:1993). Currently this equals NsTotal. But the probe/gap system uses this as the "local processed counter" to compare against `max-counter` from the server.

After enabling ratchet, if NrTotal gets corrupted (Problem 9), the local processed counter becomes incorrect. The probe will either:
- Think there's a gap when there isn't (unnecessary fetches)
- Think there's no gap when there is (missed messages)

**Fix required:** Ensure vault always stores the **transport-layer counter** (NsTotal/NrTotal), not the DR-layer counter (Ns/Nr). The current code does this correctly (`vaultCounter = transportCounter`), but Problem 9's NrTotal overwrite can break the invariant.

#### A.5.2 Max Counter Probe (probe.js)

```javascript
const serverMax = await fetchMaxCounter({...});
const localMax = await getLocalProcessedCounter({...});
if (serverMax > localMax) → enqueue gap tasks
```

**No direct issues** from ratchet enablement, assuming NrTotal is correctly maintained. But if the sender creates counter gaps (Problem 10), the probe will trigger gap filling for phantom counters.

---

### A.6 Layer 5 — Outbox and Send Policy

#### A.6.1 Outbox Counter Sorting (outbox.js:273-280)

```javascript
function compareCounterOrder(a, b) {
  const aCounter = getJobCounter(a);
  const bCounter = getJobCounter(b);
  return aCounter - bCounter;  // sort ascending
}
```

**Problem 13: Counter-based ordering breaks on CounterTooLow replacement**

When a CounterTooLow replacement occurs, the original job has counter N and the replacement has counter M (where M > N, possibly non-consecutive). If both jobs are in the outbox simultaneously (e.g., the original hasn't been removed yet), the sorting is correct but the stale job will be sent first and fail again, creating a cascade of 409 errors.

**Fix required:** Ensure stale jobs are removed from the outbox before replacement jobs are inserted. The current code at `outbox.js:960` does check for CounterTooLow errors, but the timing depends on event loop ordering.

#### A.6.2 `getJobCounter()` (outbox.js:119-127)

```javascript
function getJobCounter(job) {
  const direct = normalizeCounter(job?.counter);
  if (Number.isFinite(direct)) return direct;
  const header = typeof job?.headerJson === 'string' ? JSON.parse(job.headerJson) : job?.header;
  const headerCounter = normalizeCounter(header?.counter);
  return headerCounter;
}
```

This uses the transport counter, which is correct. No change needed for ratchet enablement.

---

### A.7 Layer 6 — Persistence and State Recovery

#### A.7.1 `snapshotDrState()` (dr-session.js:843-908)

The snapshot includes:
```javascript
{
  Ns, Nr, PN,        // chain-level counters
  NsTotal, NrTotal,  // transport-level counters
  myRatchetPriv_b64, myRatchetPub_b64,  // DH keypair
  theirRatchetPub_b64,                   // peer's DH public key
  ckS_b64, ckR_b64,                     // chain keys
  rk_b64,                               // root key
  pendingSendRatchet,
  role
}
```

**Problem 14: Snapshot timing with ratchet creates split-brain**

Current flow:
```
preSnapshot  = snapshotDrState(state)     // line 1892
pkt          = drEncryptText(state, text)  // line 1896 — MAY RATCHET
state.NsTotal = transportCounter           // line 1900 — correction
postSnapshot = snapshotDrState(state)     // line 1902
persistDrSnapshot(state)                   // line 2003
```

After enabling ratchet, `drEncryptText` might trigger a send-side ratchet that rotates the DH keypair. Between `preSnapshot` and `persistDrSnapshot`, the state has fundamentally changed (new keys, reset counters). If the app crashes after `drEncryptText` but before `persistDrSnapshot`:
- The message was sent with NEW keys
- The persisted state has OLD keys
- On restart, the state is restored from OLD snapshot
- Next message uses OLD keys → receiver gets wrong DH → decryption fails

The `persistDrSnapshot` at line 2003 attempts to prevent this, but it runs AFTER the network send attempt starts. If the network call is in-flight when the crash occurs, the state may not be persisted.

**Fix required:** Persist the post-encryption snapshot BEFORE initiating the network send. The comment at line 1997-2002 acknowledges this ("MUST persist the post-encryption snapshot to local storage BEFORE attempting the network send"), and line 2003 does persist before the actual `atomicSend`. This is correct but fragile — the persist must succeed before the atomicSend call.

#### A.7.2 `copyDrState()` (dr-session.js:1310-1380)

```javascript
target.NsTotal = Number.isFinite(source.NsTotal) ? source.NsTotal : numberOrDefault(target.NsTotal, 0);
```

**No issues** — this correctly copies NsTotal as-is. However, after enabling ratchet, `ckS` may be `null` (cleared by ratchet). The copy function handles this:
```javascript
target.ckS = source.ckS instanceof Uint8Array ? cloneU8(source.ckS) : null;
```
This is correct.

#### A.7.3 Vault Key Storage (message-key-vault.js)

The vault stores `headerCounter` alongside each message key. This is the transport counter. After ratchet enablement, the vault continues to function correctly because it uses the transport counter (NsTotal), not the chain counter (Ns).

**No changes required** in the vault layer itself, provided NsTotal is correctly maintained upstream.

---

### A.8 Summary: Required Changes by File

| File | Line(s) | Change Required | Priority |
|------|---------|----------------|----------|
| `shared/crypto/dr.js` | 313-314 | Remove `NsTotal += Ns` accumulation in `drRatchet` — let `drEncryptText` own NsTotal | **CRITICAL** |
| `shared/crypto/dr.js` | 323-330 | Uncomment ckS, PN, Ns, myRatchetPriv/Pub updates | **CRITICAL** |
| `shared/crypto/dr.js` | 665-676 | Generalize old-chain message handling beyond responder/headerN===1/Nr===0 special case | **HIGH** |
| `shared/crypto/dr.js` | 698-704 | Hard-reject `pn` gaps larger than `SKIPPED_KEYS_PER_CHAIN_MAX` | **HIGH** |
| `dr-session.js` | 1898-1901 | Simplify correction: always `state.NsTotal = transportCounter` (remove conditional) | **HIGH** |
| `dr-session.js` | 2177 | Add DR state rollback before re-encryption on CounterTooLow | **HIGH** |
| `dr-session.js` | 2992-2993 | Same correction fix for media send path | **HIGH** |
| `dr-session.js` | 4525-4526 | Change `NrTotal = headerCounter` to `NrTotal = max(NrTotal, NrTotal + 1)` | **HIGH** |
| `dr-session.js` | 355-451 | `seedTransportCounterFromServer`: also reset Ns=0, PN=0 on seed | **MEDIUM** |
| `gap-queue.js` | fetch loop | Tolerate 404 (skip) instead of treating as retriable error | **MEDIUM** |
| `data-worker/worker.js` | send-state | Sign `expectedCounter` response or remove counter recovery | **MEDIUM** |
| `outbox.js` | 960 | Ensure stale CounterTooLow jobs are purged before replacement enqueue | **LOW** |

---

### A.9 Recommended Implementation Order

**Phase 1: DR Protocol Fix (must be atomic)**
1. Fix `drRatchet()`: remove NsTotal accumulation, uncomment ratchet lines
2. Fix `drEncryptText()`: ensure NsTotal is only incremented by +1 per message
3. Add old-chain message rescue via skippedKeys lookup in `drDecryptText()`
4. Hard-reject oversized `pn` gaps

**Phase 2: Transport Layer Synchronization**
5. Simplify NsTotal correction in `sendDrPlaintext` and `sendDrMedia`
6. Fix CounterTooLow repair to include DR state rollback
7. Fix `persistContactShareSequence` NrTotal handling
8. Fix `seedTransportCounterFromServer` to reset chain-level counters

**Phase 3: Server and Pipeline Hardening**
9. Make gap-queue 404-tolerant
10. Sign or remove `send-state` counter recovery
11. Add integration tests for cross-epoch message delivery
12. Add integration tests for out-of-order message delivery across ratchet boundaries

**Phase 4: Verification**
13. End-to-end test: initiator sends N messages, responder replies, ratchet occurs, verify all messages decrypt
14. End-to-end test: simulate message reordering across ratchet boundary
15. End-to-end test: simulate CounterTooLow recovery during ratchet
16. End-to-end test: simulate app crash/restore during ratchet

---

### A.10 Counter Flow Diagram (After Fix)

```
SENDER                                    RECEIVER
──────                                    ────────

1. reserveTransportCounter()
   NsTotal = NsTotal + 1
   transportCounter = NsTotal
       │
2. drEncryptText(state, text)
   ├─ if (!ckS && theirRatchetPub):
   │    SEND-SIDE RATCHET
   │    PN = Ns
   │    Ns = 0
   │    ckS = KDF(rk, DH(newKey, theirPub))
   │    rotate myRatchetPriv/Pub
   │    [NsTotal NOT touched here]
   │
   ├─ mk = KDF(ckS)
   │  ckS = next(ckS)
   │  Ns += 1
   │  NsTotal += 1                    (*)
   │
   ├─ header = { ek_pub: myPub, pn: PN, n: Ns }
   │  ciphertext = AES-GCM(mk, plaintext, AAD(Ns))
       │
3. state.NsTotal = transportCounter   // correction: undo (*)
       │
4. POST /messages/secure
   { counter: transportCounter,               GET /messages/by-counter
     header_json, ciphertext_b64 }  ────────► { counter: N }
                                                    │
                                              5. drDecryptText(state, packet)
                                                 ├─ if (ek_pub ≠ theirRatchetPub):
                                                 │    RECV-SIDE RATCHET
                                                 │    skip old chain keys up to pn
                                                 │    drRatchet(state, ek_pub)
                                                 │    ckR = KDF(rk, DH(myPriv, ek_pub))
                                                 │    ckS = null  ← triggers send ratchet on next send
                                                 │    PN = Ns     ← save for next send header
                                                 │    Ns = 0
                                                 │    Nr = 0
                                                 │    rotate myRatchetPriv/Pub
                                                 │    [NsTotal NOT touched]
                                                 │    [NrTotal NOT touched — dr.js leaves this to caller]
                                                 │
                                                 ├─ mk = KDF(ckR, skip to header.n)
                                                 │  Nr = header.n
                                                 │  NrTotal += 1
                                                 │
                                                 └─ plaintext = AES-GCM-decrypt(mk, ct, AAD)
                                                        │
                                              6. vault.put(headerCounter: transportCounter)
                                                 persistDrSnapshot(state)
```

---

*End of Appendix A*

---

*End of Security Audit Report*
