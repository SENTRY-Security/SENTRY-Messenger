import { Router } from 'express';
import { z } from 'zod';
import { signHmac } from '../utils/hmac.js';
import { createWsToken } from '../utils/ws-token.js';

const r = Router();

const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;

const AccountDigestRegex = /^[0-9A-Fa-f]{64}$/;

const TokenRequestSchema = z.object({
  uidHex: z.string().min(14),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

function normalizeUidHex(value) {
  const cleaned = String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (cleaned.length < 14) return null;
  return cleaned.slice(0, 14);
}

async function verifyAccount(payload) {
  const path = '/d1/accounts/verify';
  const body = JSON.stringify(payload);
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

r.post('/ws/token', async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  let input;
  try {
    input = TokenRequestSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }
  const uidHex = normalizeUidHex(input.uidHex);
  if (!uidHex) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid uidHex' });
  }

  const payload = { uidHex };
  if (input.accountToken) payload.accountToken = String(input.accountToken).trim();
  if (input.accountDigest) payload.accountDigest = String(input.accountDigest).trim().toUpperCase();

  let verified;
  try {
    verified = await verifyAccount(payload);
  } catch (err) {
    return res.status(502).json({ error: 'VerifyFailed', message: err?.message || 'verify request failed' });
  }

  if (!verified.ok) {
    const status = verified.status || 502;
    return res.status(status).json(verified.data || { error: 'VerifyFailed' });
  }
  const accountDigest = String(verified.data?.account_digest || verified.data?.accountDigest || '').toUpperCase();
  if (!accountDigest) {
    return res.status(500).json({ error: 'VerifyFailed', message: 'account digest missing' });
  }

  const { token, payload: tokenPayload } = createWsToken({ uid: uidHex, accountDigest });
  return res.json({
    token,
    expiresAt: tokenPayload.exp,
    accountDigest: tokenPayload.accountDigest
  });
});

export default r;
