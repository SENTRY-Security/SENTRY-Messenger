import crypto from 'node:crypto';
import { env } from './env.js';

const TOKEN_SECRET = env.WS_TOKEN_SECRET;
const HEADER_B64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
}

export function createWsToken({ accountDigest, ttlMs = 5 * 60 * 1000, issuedAt = null }) {
  if (!accountDigest) throw new Error('accountDigest required for ws token');
  const now = Math.floor(Date.now() / 1000);
  const iat = Number.isFinite(issuedAt) && issuedAt > 0 ? Math.floor(issuedAt) : now;
  const exp = iat + Math.floor(ttlMs / 1000);
  const payload = {
    accountDigest: String(accountDigest).toUpperCase(),
    iat,
    exp
  };
  const bodyB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${HEADER_B64}.${bodyB64}.${sign(`${HEADER_B64}.${bodyB64}`)}`;
  return { token, payload };
}

export function verifyWsToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'format' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  const [headerB64, bodyB64, signature] = parts;
  if (headerB64 !== HEADER_B64) return { ok: false, reason: 'header' };
  const expectedSig = sign(`${headerB64}.${bodyB64}`);
  if (signature.length !== expectedSig.length) {
    return { ok: false, reason: 'signature' };
  }
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
    return { ok: false, reason: 'signature' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'payload' };
  }
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
