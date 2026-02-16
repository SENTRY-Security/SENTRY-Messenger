

import { Router } from 'express';
import { z } from 'zod';
import { signHmac } from '../utils/hmac.js';
import { resolveAccountAuth } from '../utils/account-context.js';

const r = Router();

const DATA_API = process.env.DATA_API_URL;     // e.g. https://message-data.<workers>.dev
const HMAC_SECRET = process.env.DATA_API_HMAC; // must match worker's HMAC_SECRET

if (!DATA_API || !HMAC_SECRET) {
  // We won't throw here to avoid crashing the app; requests will 500 with a clear error instead.
}

// ---- Schemas ----
const AccountDigestRegex = /^[0-9A-Fa-f]{64}$/;

const AccountSelectorSchema = z.object({
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional()
}).strict();
const withAccountSelectorGuard = (schema) => schema.superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
  }
});

const OpkSchema = z.object({
  id: z.number().int().nonnegative(),
  pub: z.string().min(8)
}).strict();

const SignedPrekeySchema = z.object({
  id: z.number().int().nonnegative(),
  pub: z.string().min(8),
  sig: z.string().min(8),
  ik_pub: z.string().min(8)
}).strict();

const PublishSchema = withAccountSelectorGuard(AccountSelectorSchema.extend({
  device_id: z.string().min(1),
  signed_prekey: SignedPrekeySchema,
  opks: z.array(OpkSchema).optional().default([])
}).strict());

const BundleSchema = z.object({
  peer_account_digest: z.string().regex(AccountDigestRegex),
  peer_device_id: z.string().min(1).optional()
}).strict();

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

async function callWorkerGet(pathWithQuery) {
  const sig = signHmac(pathWithQuery, '', HMAC_SECRET);
  return fetch(`${DATA_API}${pathWithQuery}`, {
    method: 'GET',
    headers: { 'x-auth': sig }
  });
}

function prepAccountPayload({ account_token, account_digest }) {
  const payload = {};
  if (account_token) payload.accountToken = String(account_token).trim();
  if (account_digest) payload.accountDigest = String(account_digest).trim().toUpperCase();
  return payload;
}

// ---- Routes ----
// POST /api/v1/keys/publish
r.post('/keys/publish', async (req, res) => {
  if (!cfgGuard(res)) return;
  try {
    const input = PublishSchema.parse(req.body || {});

    const { accountDigest } = await resolveAccountAuth({
      accountToken: input.account_token,
      accountDigest: input.account_digest
    });

    const path = '/d1/prekeys/publish';
    const signedPrekey = {
      id: input.signed_prekey.id,
      pub: input.signed_prekey.pub,
      sig: input.signed_prekey.sig,
      ik_pub: input.signed_prekey.ik_pub
    };
    const payload = {
      accountDigest,
      deviceId: input.device_id,
      signedPrekey,
      opks: input.opks || []
    };
    const w = await callWorker(path, payload);
    if (!w.ok) {
      const data = await w.text().catch(() => '');
      return res.status(w.status).json({ error: 'PublishFailed', details: data });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

// POST /api/v1/keys/bundle
r.post('/keys/bundle', async (req, res) => {
  if (!cfgGuard(res)) return;
  try {
    const input = BundleSchema.parse(req.body || {});

    const qs = new URLSearchParams();
    qs.set('peerAccountDigest', String(input.peer_account_digest).trim().toUpperCase());
    if (input.peer_device_id) qs.set('peerDeviceId', String(input.peer_device_id).trim());
    const path = `/d1/prekeys/bundle?${qs.toString()}`;
    const w = await callWorkerGet(path);
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
