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
  account_digest: z.string().regex(AccountDigestRegex),
  peer_account_digest: z.string().regex(AccountDigestRegex),
  conversation_id: z.string().min(8).optional(),
  peer_device_id: z.string().min(1).optional(),
  account_token: z.string().min(8).optional()
}).superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
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
      accountToken: input.account_token,
      accountDigest: input.account_digest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const ownerAccountDigest = auth.accountDigest;
  const peerAccountDigest = input.peer_account_digest ? normalizeAccountDigest(input.peer_account_digest) : null;
  if (!peerAccountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'peer_account_digest required' });
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
      const targetDeviceId = req.body?.target_device_id || req.body?.targetDeviceId || null;
      const conversationId = input.conversation_id || null;
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
