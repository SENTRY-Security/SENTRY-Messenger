import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { signHmac } from '../utils/hmac.js';

const r = Router();

const DATA_API = process.env.DATA_API_URL;     // e.g. https://message-data.<workers>.dev
const HMAC_SECRET = process.env.DATA_API_HMAC; // must match worker's HMAC_SECRET

function cfgGuard(res) {
  if (!DATA_API || !HMAC_SECRET) {
    res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
    return false;
  }
  return true;
}

async function callWorker(path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const sig = signHmac(path, body, HMAC_SECRET);
  const resp = await fetch(`${DATA_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth': sig },
    body
  });
  return resp;
}

// ---- Schemas ----
const AccountDigestRegex = /^[0-9A-Fa-f]{64}$/;

const AccountSelectorBase = z.object({
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
});

function ensureAccountSelector(value, ctx) {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
}

const FetchSchema = AccountSelectorBase.superRefine(ensureAccountSelector);

const AeadEnvelopeSchema = z.object({
  v: z.number(),
  aead: z.literal('aes-256-gcm'),
  salt_b64: z.string().min(8),
  iv_b64: z.string().min(8),
  ct_b64: z.string().min(8),
  info: z.string().optional()
});

const ArgonEnvelopeSchema = z.object({
  v: z.number(),
  kdf: z.literal('argon2id'),
  m: z.number(), t: z.number(), p: z.number(),
  salt_b64: z.string().min(8),
  iv_b64: z.string().min(8),
  ct_b64: z.string().min(8)
});

const StoreSchema = AccountSelectorBase.extend({
  session: z.string().min(8).optional(),          // optional: init path uses it; replenish path may omit
  wrapped_dev: z.union([AeadEnvelopeSchema, ArgonEnvelopeSchema])
}).superRefine(ensureAccountSelector);

function digestToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex').toUpperCase();
}

function prepAccountPayload({ accountToken, accountDigest }) {
  const payload = {};
  const tokenClean = accountToken ? String(accountToken).trim() : '';
  if (tokenClean) {
    payload.accountToken = tokenClean;
    payload.accountDigest = digestToken(tokenClean);
    return payload;
  }
  if (accountDigest) {
    const cleanedDigest = String(accountDigest).replace(/[^0-9A-F]/gi, '').toUpperCase();
    if (cleanedDigest) payload.accountDigest = cleanedDigest;
  }
  return payload;
}

// ---- Routes ----
// POST /api/v1/devkeys/fetch  → 轉呼 /d1/devkeys/fetch
r.post('/devkeys/fetch', async (req, res) => {
  if (!cfgGuard(res)) return;
  try {
    const input = FetchSchema.parse(req.body || {});
    const path = '/d1/devkeys/fetch';
    const workerPayload = prepAccountPayload(input);
    const w = await callWorker(path, workerPayload);
    if (w.status === 404) {
      return res.status(404).json({ error: 'NotFound' });
    }
    const data = await w.json().catch(async () => ({ text: await w.text().catch(() => '') }));
    if (!w.ok) {
      return res.status(w.status).json({ error: 'FetchFailed', details: data });
    }
    return res.json(data);
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

// POST /api/v1/devkeys/store  → 轉呼 /d1/devkeys/store
r.post('/devkeys/store', async (req, res) => {
  if (!cfgGuard(res)) return;
  try {
    const input = StoreSchema.parse(req.body || {});

    // TODO: 驗證一次性 session 是否有效且與帳號相符（目前交由 /auth/sdm/exchange 的實作頁面處理）
    const workerPayload = prepAccountPayload(input);
    
    const path = '/d1/devkeys/store';
    const w = await callWorker(path, { ...workerPayload, wrapped_dev: input.wrapped_dev, session: input.session });
    const text = await w.text().catch(() => '');
    if (w.status !== 204) {
      return res.status(w.status).json({ error: 'StoreFailed', details: text });
    }
    return res.status(204).end();
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

export default r;
