// ── Shared JWT HS256 utility (Web Crypto API) ────────────────────
//
// Single implementation for sign + verify, used by both worker.js
// and account-ws.js. Eliminates duplicated JWT logic (H-1 fix).

const WS_JWT_HEADER_B64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}

async function hmacSha256Sign(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Create a signed JWT (HS256).
 * @param {string} secret - HMAC secret
 * @param {{ accountDigest: string, ttlSec?: number }} opts
 * @returns {{ token: string, payload: object }}
 */
export async function createJwt(secret, { accountDigest, ttlSec = 300 }) {
  if (!secret) throw new Error('JWT secret not configured');
  if (!accountDigest) throw new Error('accountDigest required');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    accountDigest: String(accountDigest).toUpperCase(),
    iat: now,
    exp: now + ttlSec
  };
  const bodyB64 = base64url(JSON.stringify(payload));
  const signature = await hmacSha256Sign(secret, `${WS_JWT_HEADER_B64}.${bodyB64}`);
  return {
    token: `${WS_JWT_HEADER_B64}.${bodyB64}.${signature}`,
    payload
  };
}

/**
 * Verify a JWT (HS256). Returns a result object.
 * @param {string} token
 * @param {string} secret
 * @returns {{ ok: boolean, reason?: string, payload?: object }}
 */
export async function verifyJwt(token, secret) {
  if (typeof token !== 'string' || !secret) return { ok: false, reason: 'config' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  const [headerB64, bodyB64, signature] = parts;

  // Verify header matches expected HS256 JWT header
  if (headerB64 !== WS_JWT_HEADER_B64) return { ok: false, reason: 'header' };

  // Verify signature using constant-time comparison via Web Crypto verify
  const expectedSig = await hmacSha256Sign(secret, `${headerB64}.${bodyB64}`);
  if (signature !== expectedSig) return { ok: false, reason: 'signature' };

  // Decode payload
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(bodyB64));
  } catch { return { ok: false, reason: 'payload' }; }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now >= payload.exp) {
    return { ok: false, reason: 'expired' };
  }

  if (!payload.accountDigest) return { ok: false, reason: 'claims' };

  return {
    ok: true,
    payload: {
      accountDigest: String(payload.accountDigest).toUpperCase(),
      exp: payload.exp,
      iat: payload.iat || null
    }
  };
}
