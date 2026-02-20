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

## Appendix B: Forward Secrecy Enablement — Complete Work Items

**Date:** 2026-02-20
**System Constraints:**
- localStorage / sessionStorage 在登入前、登出前都會被清空
- 一個帳號同時只有一個 deviceId（跨裝置登入共用同一 deviceId，會踢除舊 session）
- 所有本地端持久化資料加密存在 server-side，登入時注水還原

---

### B.1 State Lifecycle 完整鏈路（現況）

```
登入
 │
 ├─ OPAQUE auth → 取得 MK (Master Key, 用來加解密所有 server-side 備份)
 │
 ├─ Stage1: restoreContactSecrets()
 │   └─ 從 localStorage 讀取 → 因為登入前已清空，永遠是空的
 │
 ├─ Stage2: hydrateContactSecretsFromBackup()
 │   ├─ fetchContactSecretsBackup({ limit: 1 }) → server 拉取
 │   ├─ decryptContactSecretPayload(payload, MK) → 用 MK 解密
 │   └─ importContactSecretsSnapshot(snapshot) → 填入 contactSecrets Map
 │       ╰─ 每個 contact entry 包含 drState snapshot (per deviceId)
 │
 ├─ Stage3: hydrateDrStatesFromContactSecrets()
 │   ├─ 遍歷 contactSecrets Map
 │   ├─ 取出 devices[selfDeviceId].drState
 │   └─ restoreDrStateFromSnapshot() → 寫入 drSessMap (in-memory)
 │       ╰─ 還原: rk, ckS, ckR, Ns, Nr, PN, NsTotal, NrTotal,
 │                myRatchetPriv, myRatchetPub, theirRatchetPub,
 │                pendingSendRatchet
 │       ╰─ 【缺失】skippedKeys → 始終為空 Map
 │
 ├─ Stage4: probeMaxCounter → gap detection
 │   └─ 對每個 conversation 查 server max counter vs local counter
 │
 └─ Stage5: gap-queue drain
     └─ by-counter 逐一拉取缺失訊息 → drDecryptText → vault put

使用中（每次送出訊息）
 │
 ├─ reserveTransportCounter → NsTotal + 1
 ├─ drEncryptText → 消耗 chain key, 遞增 Ns
 ├─ atomicSend { message, vault, backup }
 │   ├─ message: { counter, header_json, ciphertext_b64 }
 │   ├─ vault: { wrapped_mk, headerCounter, dr_state (encrypted) }
 │   └─ backup: contact-secrets snapshot (encrypted with MK)
 └─ *** backup 是隨每次送出訊息 piggyback 上傳的 ***

使用中（每次收到訊息）
 │
 ├─ drDecryptText → 可能觸發 ratchet, 產生 skippedKeys
 ├─ vault put (skipped keys) → 立即存入 server
 ├─ vault put (message key) → 存入 server, 附帶 drStateSnapshot
 └─ persistDrSnapshot → 寫入 localStorage (下次登出前會被清空)
     ╰─ 也寫入 contactSecrets Map (in-memory)
     ╰─ *** 不會觸發 remote backup ***

登出
 │
 ├─ flushDrSnapshotsBeforeLogout → persistDrSnapshot (寫到 localStorage)
 ├─ persistContactSecrets → 寫到 localStorage
 ├─ lockContactSecrets → 清除 in-memory Map
 ├─ *** 不推 remote backup (設計意圖: vault 已保存 keys) ***
 └─ localStorage 清空
```

**核心發現：** Server-side DR state 的最新版本依賴：
1. **送出時**：atomic-send 的 backup payload（每次送出都更新）
2. **收到時**：vault put 附帶的 drStateSnapshot（每次收到都更新）
3. **登出時**：不推 remote backup → 如果最後一個操作是「收到訊息」，DR state 只在 vault 裡

---

### B.2 單 deviceId 約束下的簡化

因為系統限制一個帳號同時只有一個 deviceId：

**可以忽略的問題：**
- 多 device 同時 ratchet 的 race condition
- 跨 device counter 碰撞
- snapshot 的 selfDeviceId 匹配拒絕（只有一個 device）

**仍然存在的問題：**
- 舊 session 被踢除時，如果正在 ratchet 中途（DH 已旋轉但 snapshot 未 persist），server-side 的 snapshot 是過期的
- 新裝置登入後注水還原的 state 可能與 server 上已送出/收到的訊息不一致

---

### B.3 完整工作細項列表

#### Phase 0: 前置準備（無功能變更，純重構）

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 0.1 | **將 NsTotal 的管理權統一到 drEncryptText** | `dr.js:309-314` | 移除 `drRatchet` 中 `NsTotal += Ns` 的累加邏輯。NsTotal 由 `drEncryptText:389` 單獨遞增，由 `dr-session.js` 的 `reserveTransportCounter` 和修正邏輯管控。drRatchet 只負責 chain-level state。 |
| 0.2 | **將 NrTotal 的管理權統一到呼叫端** | `dr.js:313-314` | 同上，移除 `drRatchet` 中 `NrTotal += Nr` 的累加。NrTotal 由 `drDecryptText:816` 遞增，或由 `dr-session.js:4525` 在 persistContactShareSequence 中更新。 |
| 0.3 | **簡化 NsTotal 修正邏輯** | `dr-session.js:1898-1901, 2198-2200, 2992-2993` | 將三處條件式修正改為無條件 `state.NsTotal = transportCounter`。消除 drEncryptText 內部遞增和外部 reserve 之間的語義衝突。 |
| 0.4 | **修正 persistContactShareSequence 的 NrTotal 語義** | `dr-session.js:4525-4526` | 改為 `NrTotal = Math.max(NrTotal, NrTotal + 1)`（單調遞增）。不能直接 `= headerCounter`，因為啟用 ratchet 後 header.n 會歸零。 |
| 0.5 | **為所有 Phase 0 變更新增單元測試** | `tests/` | 驗證 counter 語義在現有（ratchet 禁用）行為下不變。 |

#### Phase 1: DR 協定層啟用（核心密碼學變更）

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 1.1 | **啟用 drRatchet 的 sending-side 更新** | `dr.js:323-330` | 取消註解 `ckS = null`, `PN = st.Ns`, `Ns = 0`, `myRatchetPriv/Pub = myNew`。這是前向保密的核心開關。 |
| 1.2 | **在 drDecryptText 中加入舊鏈訊息解密支援** | `dr.js:665-676` | 目前只處理 `responder && headerN===1 && Nr===0` 的特殊情況。需要泛化：收到的 `ek_pub_b64` 若匹配 `skippedKeys` 中的某個 chainId，直接從 skippedKeys 取 key 解密，不觸發 ratchet。 |
| 1.3 | **硬拒絕過大的 pn gap** | `dr.js:698-704` | 將 warn 改為 throw：`if (gap > SKIPPED_KEYS_PER_CHAIN_MAX) throw new Error('pn gap exceeds limit')`。防止 DoS。 |
| 1.4 | **AAD 必須強制存在** | `dr.js:399-401` | 移除 fallback：`if (!aad) throw new Error('AAD construction failed')`。 |
| 1.5 | **drDecryptText 中 ratchet 後正確維護 working.ckS** | `dr.js:717-722` | `drRatchet` 啟用後會設 `ckS = null`，確保 `working` copy 正確反映此狀態，且 commit 回 `st` 時不遺漏。（目前 line 882-894 已完整 copy working→st，但需驗證 ckS=null 的傳播。） |
| 1.6 | **為 Phase 1 撰寫端對端密碼學測試** | `tests/` | 測試案例：(a) 基本 ratchet 旋轉 (b) 多次連續 ratchet (c) 亂序訊息 (d) pn gap 拒絕 (e) AAD 強制。 |

#### Phase 2: Snapshot 序列化擴展（持久化層）

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 2.1 | **Snapshot 格式升版至 v2，加入 skippedKeys 序列化** | `dr-session.js:878-906 snapshotDrState()` | 新增 `skippedKeys_json` 欄位。格式：`{ [chainId]: { [counter]: mkB64 } }`。Map of Map → plain object → JSON string → base64。因為登入前 localStorage 清空且 server-side backup 是唯一持久化來源，skippedKeys 必須被序列化才能跨 session 存活。 |
| 2.2 | **Snapshot 還原支援 v2 skippedKeys** | `dr-session.js:951-1114 restoreDrStateFromSnapshot()` | 讀取 `skippedKeys_json`，反序列化為 `Map<chainId, Map<counter, mkB64>>`，寫入 `holder.skippedKeys`。v1 snapshot 向後相容（skippedKeys 為空 Map）。 |
| 2.3 | **Contact-secrets entry 結構支援 v2 snapshot** | `core/contact-secrets.js` | `normalizeStructuredEntry()` 和 `buildStructuredEntry()` 需要能處理包含 `skippedKeys_json` 的 drState。驗證 JSON.stringify/parse 不會損壞 base64 值。 |
| 2.4 | **Vault 附帶的 drStateSnapshot 也包含 skippedKeys** | `messages-flow/live/state-live.js:424-426, 812-814` | `adapters.snapshotAndEncryptDrState()` 最終呼叫 `snapshotDrState()`，所以只要 2.1 修好，這裡自動包含。但需驗證加密後 payload size 不會超過 server 限制。 |
| 2.5 | **skippedKeys 大小限制** | `dr.js` | 在 `snapshotDrState` 中，如果 skippedKeys 總數超過某個上限（例如 500），truncate 最舊的 entries。防止 snapshot payload 膨脹。 |
| 2.6 | **Snapshot v2 遷移測試** | `tests/` | 驗證 v1 → v2 升級、v2 → v2 round-trip、v1 讀取（向後相容）。 |

#### Phase 3: Transport 層同步（counter-based API 適配）

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 3.1 | **CounterTooLow 修復加入 DR state rollback** | `dr-session.js:2164-2260` | 在 re-encrypt 之前，先用 `preSnapshot` 回滾 DR state（`restoreDrStateFromSnapshot(preSnapshot, { force: true })`）。防止第一次加密浪費的 chain key 造成 sender/receiver chain 不同步。 |
| 3.2 | **同上修正 media send 路徑** | `dr-session.js:3226-3260` | Media send 有獨立的 CounterTooLow 修復路徑，需要同樣的 rollback 邏輯。 |
| 3.3 | **seedTransportCounterFromServer 加入 chain-level counter 重設** | `dr-session.js:424` | 當 NsTotal 從 server seed 時，同步設 `state.Ns = 0` 和 `state.PN = 0`。因為 snapshot restore 後 chain epoch 狀態未知，使用保守值（0）讓下次 encrypt 時觸發 ratchet。 |
| 3.4 | **gap-queue 404 容錯** | `messages-flow/gap-queue.js` | 收到 404 回應時，記錄為 `counter_not_found` 而非 retry。跳過該 counter 繼續處理下一個。（sender 的 counter 跳躍是合法的，例如 CounterTooLow 修復跳過了一個值。） |

#### Phase 4: 注水還原流程強化

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 4.1 | **Stage3 注水後立即觸發 remote backup** | `restore-coordinator.js:354-394` | `hydrateDrStatesFromContactSecrets` 完成後，立即呼叫 `triggerContactSecretsBackup('post-hydrate')`。確保剛注水的 state 立即同步回 server。否則如果注水後只收訊息（不送訊息），DR state 的 server-side 備份只有 vault put 附帶的 snapshot——如果 vault put 失敗，state 就丟失。 |
| 4.2 | **Stage3 注水時設定 pendingSendRatchet = true** | `dr-session.js:1084` | 注水還原後，因為 skippedKeys 可能不完整（v1 snapshot 或 truncated），設定 `pendingSendRatchet = true` 強制下次送出時 ratchet。這確保即使舊 chain key 遺失，新的 ratchet 會建立全新的 chain。 |
| 4.3 | **登出前強制推 remote backup** | `app-mobile.js:493-501` | 取消目前的「不推 remote backup」設計。呼叫 `triggerContactSecretsBackup('secure-logout', { force: true })`。理由：啟用 ratchet 後，DR state 包含旋轉中的 DH 金鑰和 chain keys，這些不在 vault 中。如果登出時不推 backup，下次登入後 vault 裡的 drStateSnapshot 可能是數個 ratchet epoch 之前的版本。 |
| 4.4 | **force-logout (踢除) 時的 state 保護** | `ws-integration.js:481` | 收到 `force-logout` WebSocket 事件時，在斷開連線前嘗試 `triggerContactSecretsBackup('force-logout', { force: true, keepalive: true })`。使用 `keepalive: true` 確保 fetch 在頁面卸載時仍能完成（navigator.sendBeacon fallback）。 |
| 4.5 | **被踢除後的 stale state 偵測** | `restore-coordinator.js` | Stage3 注水時，比對 vault 最新 drStateSnapshot 的 `updatedAt` 和 backup 的 `updatedAt`。如果 vault 更新，用 vault 的 snapshot 覆蓋 backup 的（vault 是 per-message 更新的，比 backup 更即時）。 |

#### Phase 5: 邊界條件和錯誤處理

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 5.1 | **Ratchet 中途被踢除的恢復邏輯** | `dr-session.js` | 場景：drDecryptText 觸發了 ratchet（DH 旋轉、ckS=null），但 vault put 和 persist 還沒執行就被 force-logout 踢除。下次登入：(a) server 上的 snapshot 是 ratchet 前的版本 (b) 但 server 上已有對方用新 chain 加密的訊息。解法：gap-queue 拉取訊息 → drDecryptText 再次 ratchet（因為 ek_pub_b64 與 state 不同）→ 確保 ratchet 是冪等的（同一 DH 輸入 = 同一 chain key）。**需驗證 drRatchet 的確定性**：`scalarMult(myPriv, theirPub)` → 如果 myPriv 未旋轉（snapshot 是 ratchet 前的），結果與第一次 ratchet 相同。✓ |
| 5.2 | **送出訊息在 ratchet 後 crash 的恢復** | `dr-session.js` | 場景：drEncryptText 觸發 send-side ratchet → atomicSend → server 接受 → 但 app crash 在 persist 之前。下次登入：NsTotal 在 server 上已遞增，但 client 的 snapshot 是 ratchet 前的。解法：`seedTransportCounterFromServer` (Phase 3.3) 會修正 NsTotal。但 DH 金鑰也需要旋轉——這次 ratchet 使用的 myNew keypair 已經丟失。必須生成新的 keypair 並重新 ratchet。解法是 Phase 4.2 的 `pendingSendRatchet = true`。 |
| 5.3 | **Vault put 失敗後 skippedKeys 的自癒** | `state-live.js:448-452` | 目前 vault put 失敗只是 warn。啟用 ratchet 後，skippedKeys 丟失 = 亂序訊息無法解密。改為：vault put 失敗時，將 skippedKeys 保留在 in-memory Map，並在下一次成功的 vault put 時重試。另外在 snapshot 中序列化 skippedKeys（Phase 2.1）作為 fallback。 |
| 5.4 | **send-state API 回應增加完整性驗證** | `data-worker/worker.js:2408-2414, dr-session.js:2177` | 為 `send-state` 回應加入 HMAC 簽章（使用 DATA_API_HMAC），client 端驗證後才接受 expectedCounter。防止 MITM 注入假值導致 counter 回退。 |
| 5.5 | **Snapshot payload size 監控** | `contact-backup.js, message-key-vault.js` | 加入 skippedKeys 後 snapshot size 會增長。加入 size 監控和告警。如果 payload 超過 server 的 body size limit (2MB)，truncate skippedKeys。 |

#### Phase 6: 整合測試

| # | 工作項目 | 說明 |
|---|---------|------|
| 6.1 | **E2E: 基本 ratchet 旋轉** | Alice→Bob 5 則 → Bob→Alice 3 則 → Alice→Bob 2 則。驗證所有訊息解密成功，ek_pub_b64 在每個方向切換時變化。 |
| 6.2 | **E2E: 亂序訊息跨 ratchet 邊界** | Alice 依序送 msg1(chain1), msg2(chain1), msg3(chain2, ratcheted)。Bob 收到順序：msg3, msg1, msg2。驗證三則都能解密。 |
| 6.3 | **E2E: 登出→登入→還原** | Alice→Bob 5 則 → Bob 登出 → Bob 登入 → 驗證 DR state 正確還原 → Bob 可以繼續對話（送出和接收）。 |
| 6.4 | **E2E: 被踢除→新裝置登入** | Alice→Bob 5 則 → Bob 被 force-logout → Bob 在新裝置登入（同 deviceId）→ 還原 → Alice→Bob 再送 3 則 → 驗證 Bob 能解密後 3 則。 |
| 6.5 | **E2E: CounterTooLow 修復後 ratchet 正確性** | 模擬 409 → repair → 驗證 sender 和 receiver 的 chain state 一致。 |
| 6.6 | **E2E: gap-queue 404 容錯** | 製造一個 counter gap（跳過 counter 5）→ gap-queue 應跳過 5，成功處理 4 和 6。 |
| 6.7 | **E2E: Snapshot v1→v2 遷移** | 用 v1 格式的 backup 登入，驗證注水成功，skippedKeys 為空但功能正常（透過 pendingSendRatchet 自癒）。 |

---

### B.4 工作項目依賴關係

```
Phase 0 (前置重構)
  ├─ 0.1, 0.2, 0.3, 0.4 可並行
  └─ 0.5 等 0.1-0.4 完成

Phase 1 (DR 協定) ← 依賴 Phase 0
  ├─ 1.1 是核心開關，1.2-1.5 與 1.1 配合
  └─ 1.6 等 1.1-1.5 完成

Phase 2 (Snapshot) ← 可與 Phase 1 並行
  ├─ 2.1, 2.2 是核心
  ├─ 2.3, 2.4 依賴 2.1
  └─ 2.5, 2.6 依賴 2.1-2.2

Phase 3 (Transport) ← 依賴 Phase 0
  ├─ 3.1, 3.2 可並行
  ├─ 3.3 獨立
  └─ 3.4 獨立

Phase 4 (注水還原) ← 依賴 Phase 2
  ├─ 4.1, 4.2 可並行
  ├─ 4.3, 4.4 可並行
  └─ 4.5 依賴 4.3

Phase 5 (邊界條件) ← 依賴 Phase 1 + Phase 2
  ├─ 5.1, 5.2 依賴 Phase 1
  ├─ 5.3 依賴 Phase 2
  └─ 5.4, 5.5 獨立

Phase 6 (整合測試) ← 依賴所有 Phase
```

---

### B.5 風險矩陣

| 風險 | 發生條件 | 後果 | 緩解措施 |
|------|---------|------|---------|
| Ratchet 中途被踢除 | force-logout + 未完成 persist | 下次登入 state 過期，需重新 ratchet | Phase 4.4 (force-logout backup) + Phase 5.1 (ratchet 冪等性) |
| skippedKeys 丟失 | vault put 失敗 + 登出 + 登入 | 亂序訊息永久不可解密 | Phase 2.1 (snapshot 序列化) + Phase 5.3 (retry) |
| NsTotal 與 server counter 不同步 | drRatchet 累加 + 修正邏輯失效 | 409 CounterTooLow 循環 | Phase 0.1-0.3 (統一 NsTotal 管理權) |
| Snapshot payload 過大 | 大量 skippedKeys | server reject / 傳輸失敗 | Phase 2.5 (truncation) + Phase 5.5 (監控) |
| V1→V2 遷移中訊息丟失 | 用 v1 snapshot 登入後收到跨 epoch 亂序訊息 | 無 skippedKeys 可用 | Phase 4.2 (pendingSendRatchet 強制 ratchet) |
| send-state MITM | 攻擊者注入假 expectedCounter | counter 回退 → 密文覆蓋 | Phase 5.4 (HMAC 簽章) |

---

### B.6 最小可行變更集（MVP）

如果要以最小風險、最少程式碼啟用前向保密，最小變更集是：

1. **Phase 0.1-0.3**（統一 NsTotal 語義）— 必須
2. **Phase 1.1**（取消註解 ratchet）— 必須
3. **Phase 1.3**（硬拒絕 pn gap）— 必須
4. **Phase 0.4**（NrTotal 單調）— 必須
5. **Phase 2.1-2.2**（skippedKeys 序列化）— 必須（因為 session 不持久）
6. **Phase 4.3**（登出前推 backup）— 必須（因為 localStorage 會被清）

共 **8 個工作項目**，涉及 **3 個檔案**（`dr.js`, `dr-session.js`, `app-mobile.js`）。

其餘 Phase 是「應該做但可以分批」的加固措施。

---

*End of Appendix B*

---

*End of Security Audit Report*
