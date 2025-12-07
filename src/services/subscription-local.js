import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { signHmac } from '../utils/hmac.js';
import { logger } from '../utils/logger.js';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { normalizeAccountDigest } from '../utils/account-verify.js';

const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;
const PUBLIC_KEY = process.env.PRIVATE_KEY_PUBLIC_PEM || '';

function normalizePublicKey(keyRaw) {
  if (!keyRaw) return null;
  // allow literal \n in env
  if (keyRaw.includes('\\n')) {
    return keyRaw.replace(/\\n/g, '\n');
  }
  if (keyRaw.includes('-----BEGIN')) return keyRaw;
  const chunks = keyRaw.replace(/\\s+/g, '').match(/.{1,64}/g) || [];
  return ['-----BEGIN PUBLIC KEY-----', ...chunks, '-----END PUBLIC KEY-----'].join('\n');
}

function verifyJwt(token) {
  const pub = normalizePublicKey(PUBLIC_KEY);
  if (!pub) {
    const err = new Error('PUBLIC KEY missing');
    err.status = 500;
    throw err;
  }
  try {
    const payload = jwt.verify(token, pub, { algorithms: ['RS256'], ignoreExpiration: true });
    const decoded = jwt.decode(token, { complete: true });
    const header = decoded?.header || {};
    const signaturePart = token.split('.')[2] || '';
    return { payload, header, signatureB64: signaturePart };
  } catch (err) {
    err.status = 400;
    err.code = 'InvalidVoucher';
    throw err;
  }
}

async function callWorker({ path, body }) {
  if (!DATA_API || !HMAC_SECRET) {
    const err = new Error('DATA_API_URL or DATA_API_HMAC not configured');
    err.status = 500;
    throw err;
  }
  const url = `${DATA_API}${path}`;
  const bodyStr = JSON.stringify(body || {});
  const sig = signHmac(path, bodyStr, HMAC_SECRET);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth': sig },
    body: bodyStr
  });
  const txt = await res.text().catch(() => '');
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) {
    const err = new Error(typeof data === 'object' && data?.message ? data.message : 'worker error');
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export async function redeemVoucher(input = {}) {
  const { token, dryRun = false } = input;
  if (!token || typeof token !== 'string') {
    const err = new Error('token required');
    err.status = 400;
    throw err;
  }

  let auth = null;
  try {
    auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    if (err instanceof AccountAuthError) {
      throw err;
    }
    const e = new Error('account auth failed');
    e.status = 400;
    throw e;
  }
  const accountDigest = normalizeAccountDigest(auth?.accountDigest);
  if (!accountDigest) {
    const err = new Error('account digest missing');
    err.status = 400;
    throw err;
  }

  const { payload, header, signatureB64 } = verifyJwt(token);
  const durationDays = Number(payload?.durationDays || payload?.extendDays || 0);
  if (!Number.isFinite(durationDays) || durationDays <= 0) {
    const err = new Error('durationDays missing in voucher');
    err.status = 400;
    err.code = 'InvalidVoucher';
    throw err;
  }
  const tokenId = payload?.voucherId || payload?.sub || payload?.jti;
  if (!tokenId) {
    const err = new Error('voucherId/jti missing');
    err.status = 400;
    err.code = 'InvalidVoucher';
    throw err;
  }

  const body = {
    tokenId,
    voucherId: payload?.voucherId || null,
    jti: payload?.jti || null,
    agentId: payload?.agentId || null,
    durationDays,
    issuedAt: payload?.iat || null,
    expiresAt: payload?.exp || null,
    keyId: header?.kid || 'default',
    signatureB64: signatureB64 || null,
    digest: accountDigest,
    dryRun: !!dryRun
  };

  try {
    return await callWorker({ path: '/d1/subscription/redeem', body });
  } catch (err) {
    logger.warn({ err: err?.message || err, tokenId }, 'voucher_redeem_failed');
    throw err;
  }
}

export async function validateVoucher(input = {}) {
  return redeemVoucher({ ...input, dryRun: true });
}

export async function subscriptionStatus({ digest, limit } = {}) {
  let targetDigest = normalizeAccountDigest(digest);
  if (!targetDigest) {
    try {
      const auth = await resolveAccountAuth({});
      targetDigest = auth?.accountDigest || null;
    } catch (err) {
      const e = new Error('digest required');
      e.status = 400;
      throw e;
    }
  }
  if (!targetDigest) {
    const err = new Error('digest required');
    err.status = 400;
    throw err;
  }
  if (!DATA_API || !HMAC_SECRET) {
    const err = new Error('DATA_API_URL or DATA_API_HMAC not configured');
    err.status = 500;
    throw err;
  }
  const params = new URLSearchParams();
  params.set('digest', targetDigest);
  if (limit) params.set('limit', String(limit));
  const path = `/d1/subscription/status?${params.toString()}`;
  const sig = signHmac(path, '', HMAC_SECRET);
  const res = await fetch(`${DATA_API}${path}`, { headers: { 'x-auth': sig } });
  const txt = await res.text().catch(() => '');
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) {
    const err = new Error(typeof data === 'object' && data?.message ? data.message : 'worker error');
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}
