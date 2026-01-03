import { z } from 'zod';
import { signHmac } from '../utils/hmac.js';
import { logger } from '../utils/logger.js';
import { getWebSocketManager } from '../ws/index.js';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { normalizeAccountDigest, AccountDigestRegex } from '../utils/account-verify.js';

const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;
const FETCH_TIMEOUT_MS = Number(process.env.DATA_API_TIMEOUT_MS || 8000);

async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function respondAccountError(res, err, fallback = 'authorization failed') {
  if (err instanceof AccountAuthError) {
    const status = err.status || 400;
    if (err.details && typeof err.details === 'object') {
      return res.status(status).json(err.details);
    }
    return res.status(status).json({ error: 'AccountAuthFailed', message: err.message || fallback });
  }
  return res.status(500).json({ error: 'AccountAuthFailed', message: err?.message || fallback });
}

const DeleteContactSchema = z.object({
  accountDigest: z.string().regex(AccountDigestRegex),
  peerAccountDigest: z.string().regex(AccountDigestRegex),
  conversationId: z.string().min(8).optional(),
  peerDeviceId: z.string().min(1).optional(),
  accountToken: z.string().min(8).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

export const deleteContact = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }

  let input;
  try {
    input = DeleteContactSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const ownerAccountDigest = auth.accountDigest;
  const peerAccountDigest = input.peerAccountDigest ? normalizeAccountDigest(input.peerAccountDigest) : null;
  if (!peerAccountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'peerAccountDigest required' });
  }

  const path = '/d1/friends/contact-delete';
  const payload = { ownerAccountDigest, peerAccountDigest };
  const body = JSON.stringify(payload);
  const sig = signHmac(path, body, HMAC_SECRET);

  let upstream;
  try {
    upstream = await fetchWithTimeout(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
  } catch (err) {
    return res.status(504).json({
      error: 'ContactDeleteFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({ error: 'ContactDeleteFailed', details: txt });
  }

  const data = await upstream.json();
  try {
    const manager = getWebSocketManager();
    manager?.notifyContactsReload(null, ownerAccountDigest);
    const peerTargetDigest = peerAccountDigest || normalizeAccountDigest(data?.results?.[0]?.target || null);
    if (peerTargetDigest) {
      manager.notifyContactsReload(null, peerTargetDigest);
      const targetDeviceId = req.body?.targetDeviceId || null;
      const conversationId = input.conversationId || null;
      if (targetDeviceId && conversationId) {
        manager.sendContactRemoved(null, {
          fromAccountDigest: ownerAccountDigest,
          targetAccountDigest: peerTargetDigest,
          senderDeviceId,
          targetDeviceId,
          conversationId
        });
      } else {
        logger.warn({
          event: 'ws_contact_delete_missing_fields',
          targetDeviceId,
          conversationId
        }, 'skip sending contactRemoved due to missing fields');
      }
    }
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'ws_contact_delete_notify_failed');
  }

  return res.json(data);
};
