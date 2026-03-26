// ── Shared JWT HS256 utility (via jose) ───────────────────────────
//
// Single implementation for sign + verify, used by both worker.js
// and account-ws.js. Backed by panva/jose — audited, constant-time,
// Web Crypto native. Replaces hand-rolled JWT logic (H-1 → H-2 fix).

import { SignJWT, jwtVerify, errors } from 'jose';

/**
 * Import a string secret as a CryptoKey for HS256.
 * jose requires a CryptoKey or Uint8Array; we use Uint8Array for simplicity.
 */
function secretToUint8Array(secret) {
  return new TextEncoder().encode(secret);
}

/**
 * Create a signed JWT (HS256).
 * @param {string} secret - HMAC secret (string, will be encoded as UTF-8)
 * @param {{ accountDigest: string, ttlSec?: number }} opts
 * @returns {Promise<{ token: string, payload: object }>}
 */
export async function createJwt(secret, { accountDigest, ttlSec = 300 }) {
  if (!secret) throw new Error('JWT secret not configured');
  if (!accountDigest) throw new Error('accountDigest required');

  const normalizedDigest = String(accountDigest).toUpperCase();
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({ accountDigest: normalizedDigest })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSec)
    .sign(secretToUint8Array(secret));

  return {
    token,
    payload: {
      accountDigest: normalizedDigest,
      iat: now,
      exp: now + ttlSec
    }
  };
}

/**
 * Verify a JWT (HS256). Returns a result object (never throws for auth errors).
 * jose internally performs:
 *   - constant-time signature comparison via Web Crypto verify
 *   - algorithm whitelist enforcement (only HS256 accepted)
 *   - exp / nbf validation with configurable clock tolerance
 *
 * @param {string} token
 * @param {string} secret
 * @returns {Promise<{ ok: boolean, reason?: string, payload?: object }>}
 */
export async function verifyJwt(token, secret) {
  if (typeof token !== 'string' || !secret) return { ok: false, reason: 'config' };

  try {
    const { payload } = await jwtVerify(token, secretToUint8Array(secret), {
      algorithms: ['HS256'],       // Strict algorithm whitelist
      clockTolerance: 5,           // 5 seconds clock skew tolerance
      requiredClaims: ['accountDigest', 'exp']
    });

    if (!payload.accountDigest) return { ok: false, reason: 'claims' };

    return {
      ok: true,
      payload: {
        accountDigest: String(payload.accountDigest).toUpperCase(),
        exp: payload.exp,
        iat: payload.iat || null
      }
    };
  } catch (err) {
    if (err instanceof errors.JWTExpired) return { ok: false, reason: 'expired' };
    if (err instanceof errors.JWTClaimValidationFailed) return { ok: false, reason: 'claims' };
    if (err instanceof errors.JWSSignatureVerificationFailed) return { ok: false, reason: 'signature' };
    if (err instanceof errors.JWSInvalid) return { ok: false, reason: 'format' };
    return { ok: false, reason: 'invalid' };
  }
}
