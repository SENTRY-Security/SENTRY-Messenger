import jwt from 'jsonwebtoken';
import { env } from './env.js';

const TOKEN_SECRET = env.WS_TOKEN_SECRET;
const ALGORITHM = 'HS256';

export function createWsToken({ accountDigest, ttlMs = 5 * 60 * 1000, issuedAt = null }) {
  if (!accountDigest) throw new Error('accountDigest required for ws token');
  const now = Math.floor(Date.now() / 1000);
  const iat = Number.isFinite(issuedAt) && issuedAt > 0 ? Math.floor(issuedAt) : now;
  const exp = iat + Math.floor(ttlMs / 1000);
  const claims = { accountDigest: String(accountDigest).toUpperCase(), iat, exp };
  const token = jwt.sign(claims, TOKEN_SECRET, { algorithm: ALGORITHM, noTimestamp: true });
  return { token, payload: claims };
}

export function verifyWsToken(token) {
  if (typeof token !== 'string') {
    return { ok: false, reason: 'format' };
  }
  let payload;
  try {
    payload = jwt.verify(token, TOKEN_SECRET, { algorithms: [ALGORITHM] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') return { ok: false, reason: 'expired' };
    if (err.name === 'JsonWebTokenError') return { ok: false, reason: 'signature' };
    return { ok: false, reason: 'format' };
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
