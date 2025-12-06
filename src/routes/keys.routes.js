

import { Router } from 'express';
import { z } from 'zod';
import { signHmac } from '../utils/hmac.js';

const r = Router();

const DATA_API = process.env.DATA_API_URL;     // e.g. https://message-data.<workers>.dev
const HMAC_SECRET = process.env.DATA_API_HMAC; // must match worker's HMAC_SECRET

if (!DATA_API || !HMAC_SECRET) {
  // We won't throw here to avoid crashing the app; requests will 500 with a clear error instead.
}

// ---- Schemas ----
const AccountDigestRegex = /^[0-9A-Fa-f]{64}$/;

const AccountSelectorSchema = z.object({
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const OpkSchema = z.object({
  id: z.number().int().nonnegative(),
  pub: z.string().min(8)
});

const BundleFullSchema = z.object({
  ik_pub: z.string().min(8),
  spk_pub: z.string().min(8),
  spk_sig: z.string().min(8),
  opks: z.array(OpkSchema).optional().default([])
});

const BundleOpksOnlySchema = z.object({
  opks: z.array(OpkSchema).min(1)
});

const PublishSchema = AccountSelectorSchema.extend({
  bundle: z.union([BundleFullSchema, BundleOpksOnlySchema])
});

const BundleSchema = z.object({
  peer_accountDigest: z.string().regex(AccountDigestRegex)
});

// ---- Helpers ----
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

function prepAccountPayload({ accountToken, accountDigest }) {
  const payload = {};
  if (accountToken) payload.accountToken = String(accountToken).trim();
  if (accountDigest) payload.accountDigest = String(accountDigest).trim().toUpperCase();
  return payload;
}

// ---- Routes ----
// POST /api/v1/keys/publish
r.post('/keys/publish', async (req, res) => {
  if (!cfgGuard(res)) return;
  try {
    const input = PublishSchema.parse(req.body || {});

    const path = '/d1/prekeys/publish';
    const accountPayload = prepAccountPayload(input);
    console.log('[keys.publish] payload', {
      uidHex: accountPayload.uidHex || null,
      hasAccountToken: !!accountPayload.accountToken,
      hasAccountDigest: !!accountPayload.accountDigest,
      inputBundleKeys: input.bundle ? Object.keys(input.bundle) : null,
      opkCount: Array.isArray(input.bundle?.opks) ? input.bundle.opks.length : null,
      hasIK: !!input.bundle?.ik_pub,
      hasSPK: !!input.bundle?.spk_pub,
      hasSPKSig: !!input.bundle?.spk_sig
    });
    const w = await callWorker(path, { ...accountPayload, bundle: input.bundle });
    if (!w.ok) {
      const data = await w.text().catch(() => '');
      return res.status(w.status).json({ error: 'PublishFailed', details: data });
    }
    return res.status(204).end();
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

// POST /api/v1/keys/bundle
r.post('/keys/bundle', async (req, res) => {
  if (!cfgGuard(res)) return;
  try {
    const input = BundleSchema.parse(req.body || {});

    const path = '/d1/prekeys/bundle';
    const payload = {
      peer_accountDigest: String(input.peer_accountDigest).trim().toUpperCase()
    };
    const w = await callWorker(path, payload);
    const data = await w.json().catch(async () => ({ text: await w.text().catch(() => '') }));
    if (!w.ok) {
      return res.status(w.status).json({ error: 'FetchBundleFailed', details: data });
    }
    return res.json(data);
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

export default r;
