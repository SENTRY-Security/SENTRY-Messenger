

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
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).strict();
const withAccountSelectorGuard = (schema) => schema.superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
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
  deviceId: z.string().min(1),
  signedPrekey: SignedPrekeySchema,
  opks: z.array(OpkSchema).optional().default([])
}).strict());

const BundleSchema = z.object({
  peer_accountDigest: z.string().regex(AccountDigestRegex),
  peer_deviceId: z.string().min(1).optional()
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

    const { accountDigest } = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });

    const path = '/d1/prekeys/publish';
    const signedPrekey = {
      id: input.signedPrekey.id,
      pub: input.signedPrekey.pub,
      sig: input.signedPrekey.sig,
      ik_pub: input.signedPrekey.ik_pub
    };
    const payload = {
      accountDigest,
      deviceId: input.deviceId,
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
    qs.set('peerAccountDigest', String(input.peer_accountDigest).trim().toUpperCase());
    if (input.peer_deviceId) qs.set('peerDeviceId', String(input.peer_deviceId).trim());
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
