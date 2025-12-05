import { Router } from 'express';
import { z } from 'zod';
import { createWsToken } from '../utils/ws-token.js';
import { verifyAccount, normalizeUidHex, normalizeAccountDigest } from '../utils/account-verify.js';

const r = Router();

const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;
const latestLoginTs = new Map(); // accountDigest -> sessionTs

const AccountDigestRegex = /^[0-9A-Fa-f]{64}$/;

const TokenRequestSchema = z.object({
  uidHex: z.string().min(14),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  sessionTs: z.number().int().optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

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
  if (input.accountDigest) {
    const normalizedDigest = normalizeAccountDigest(input.accountDigest);
    if (normalizedDigest) payload.accountDigest = normalizedDigest;
  }

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

  const sessionTs = Number.isFinite(input.sessionTs) ? Math.floor(input.sessionTs) : Math.floor(Date.now() / 1000);
  const latest = latestLoginTs.get(accountDigest) || 0;
  if (latest && sessionTs < latest) {
    return res.status(409).json({ error: 'StaleSession', message: 'session superseded by newer login' });
  }
  latestLoginTs.set(accountDigest, sessionTs);

  const { token, payload: tokenPayload } = createWsToken({ uid: uidHex, accountDigest, issuedAt: sessionTs });
  return res.json({
    token,
    expiresAt: tokenPayload.exp,
    accountDigest: tokenPayload.accountDigest,
    sessionTs
  });
});

export default r;
