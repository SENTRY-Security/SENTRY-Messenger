import { signHmac } from './hmac.js';

const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;

export const AccountDigestRegex = /^[0-9A-F]{64}$/;

export function normalizeUidHex(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (cleaned.length < 14) return null;
  return cleaned.slice(0, 14);
}

export function normalizeAccountDigest(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9A-F]/g, '').toUpperCase();
  return AccountDigestRegex.test(cleaned) ? cleaned : null;
}

export async function verifyAccount(payload) {
  if (!DATA_API || !HMAC_SECRET) {
    throw new Error('DATA_API_URL or DATA_API_HMAC not configured');
  }
  const accountToken = typeof payload?.accountToken === 'string' ? payload.accountToken.trim() : null;
  const accountDigest = normalizeAccountDigest(payload?.accountDigest);
  if (!accountToken && !accountDigest) {
    throw new Error('accountToken or accountDigest required');
  }
  const path = '/d1/accounts/verify';
  const bodyPayload = {};
  if (accountToken) bodyPayload.accountToken = accountToken;
  if (accountDigest) bodyPayload.accountDigest = accountDigest;
  const body = JSON.stringify(bodyPayload);
  const sig = signHmac(path, body, HMAC_SECRET);
  const res = await fetch(`${DATA_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth': sig },
    body
  });
  let raw = '';
  try { raw = await res.text(); } catch { raw = ''; }
  let data = raw;
  if (raw) {
    try { data = JSON.parse(raw); } catch {/* ignore */ }
  }
  return { ok: res.ok, status: res.status, data };
}
