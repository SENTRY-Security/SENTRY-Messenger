import { Router } from 'express';
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
  uidHex: z.string().min(14).optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
});

function ensureAccountSelector(value, ctx) {
  if (!value.uidHex && !(value.accountToken && value.accountDigest)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'uidHex or accountToken+accountDigest required' });
  }
}

const AccountSelectorSchema = AccountSelectorBase.superRefine(ensureAccountSelector);

const FetchSchema = AccountSelectorSchema;

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

function sanitizeUidHex(value) {
  if (!value) return undefined;
  const cleaned = String(value).replace(/[^0-9a-f]/gi, '').toUpperCase();
  return cleaned.length >= 14 ? cleaned.slice(0, 14) : undefined;
}

function prepAccountPayload({ uidHex, accountToken, accountDigest }) {
  const payload = {};
  const normalizedUid = sanitizeUidHex(uidHex);
  if (normalizedUid) payload.uidHex = normalizedUid;
  if (accountToken) payload.accountToken = String(accountToken).trim();
  if (accountDigest) payload.accountDigest = String(accountDigest).trim().toUpperCase();
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
