import { Router } from 'express';
import { z } from 'zod';
import { createWsToken } from '../utils/ws-token.js';
import { verifyAccount, normalizeAccountDigest } from '../utils/account-verify.js';

const r = Router();

const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;
const latestLoginTs = new Map(); // accountDigest -> sessionTs

const AccountDigestRegex = /^[0-9A-Fa-f]{64}$/;

const TokenRequestSchema = z.object({
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional(),
  session_ts: z.number().int().optional() // client-supplied timestamp; informational only
}).superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
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

  const payload = {};
  if (input.account_token) payload.accountToken = String(input.account_token).trim();
  if (input.account_digest) {
    const normalizedDigest = normalizeAccountDigest(input.account_digest);
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

  // Use server-side time to order logins; ignore client clock to avoid false stale kicks.
  const nowSec = Math.floor(Date.now() / 1000);
  const sessionTs = nowSec;
  latestLoginTs.set(accountDigest, sessionTs);

  const { token, payload: tokenPayload } = createWsToken({ accountDigest, issuedAt: sessionTs });
  return res.json({
    token,
    expires_at: tokenPayload.exp,
    account_digest: tokenPayload.accountDigest,
    session_ts: sessionTs,
    client_session_ts: input.session_ts ?? null
  });
});

export default r;
