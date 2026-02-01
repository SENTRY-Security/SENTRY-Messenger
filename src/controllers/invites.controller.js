import { nanoid } from 'nanoid';
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

function respondAccountError(res, err, defaultMsg = 'authorization failed') {
  if (err instanceof AccountAuthError) {
    const status = err.status || 400;
    if (err.details && typeof err.details === 'object') {
      return res.status(status).json(err.details);
    }
    return res.status(status).json({ error: 'AccountAuthFailed', message: err.message || defaultMsg });
  }
  return res.status(500).json({ error: 'AccountAuthFailed', message: err?.message || defaultMsg });
}

const InviteCreateSchema = z.object({
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  ownerPublicKeyB64: z.string().min(16).optional()
}).strict();

const InviteDeliverSchema = z.object({
  inviteId: z.string().min(8),
  ciphertextEnvelope: z.any(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).strict();

const InviteConsumeSchema = z.object({
  inviteId: z.string().min(8),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).strict();

const InviteStatusSchema = z.object({
  inviteId: z.string().min(8),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).strict();

const INVITE_DELIVER_ALIAS_FIELDS = new Set([
  'invite_id',
  'account_token',
  'account_digest',
  'ciphertext_envelope'
]);
const INVITE_CONSUME_ALIAS_FIELDS = new Set([
  'invite_id',
  'account_token',
  'account_digest'
]);
const INVITE_STATUS_ALIAS_FIELDS = new Set([
  'invite_id',
  'account_token',
  'account_digest'
]);
const INVITE_DELIVER_ALLOWED_FIELDS = new Set([
  'inviteId',
  'ciphertextEnvelope',
  'accountToken',
  'accountDigest'
]);
const INVITE_CONSUME_ALLOWED_FIELDS = new Set([
  'inviteId',
  'accountToken',
  'accountDigest'
]);
const INVITE_STATUS_ALLOWED_FIELDS = new Set([
  'inviteId',
  'accountToken',
  'accountDigest'
]);

function rejectInviteSchemaMismatch(res, body, { allowedFields, aliasFields }) {
  if (!body || typeof body !== 'object') return null;
  for (const key of Object.keys(body)) {
    if (aliasFields.has(key)) {
      return res.status(400).json({
        error: 'BadRequest',
        code: 'InviteSchemaMismatch',
        message: `alias field not allowed: ${key}`,
        field: key
      });
    }
  }
  for (const key of Object.keys(body)) {
    if (!allowedFields.has(key)) {
      return res.status(400).json({
        error: 'BadRequest',
        code: 'InviteSchemaMismatch',
        message: `unexpected field: ${key}`,
        field: key
      });
    }
  }
  return null;
}

export const createInviteDropbox = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  let input;
  try {
    input = InviteCreateSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }
  if (!input.accountToken) {
    return res.status(401).json({ error: 'Unauthorized', message: 'accountToken required' });
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

  const inviteId = nanoid(16);
  const path = '/d1/invites/create';
  const bodyPayload = {
    inviteId,
    deviceId: senderDeviceId,
    accountToken: String(input.accountToken).trim(),
    accountDigest: auth.accountDigest
  };
  if (input.ownerPublicKeyB64) bodyPayload.ownerPublicKeyB64 = input.ownerPublicKeyB64;
  const body = JSON.stringify(bodyPayload);
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
      error: 'InviteCreateFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    let payload = null;
    try {
      payload = txt ? JSON.parse(txt) : null;
    } catch {
      payload = null;
    }
    const errPayload = payload && typeof payload === 'object'
      ? payload
      : { error: 'InviteCreateFailed', details: txt || 'upstream error' };
    if (upstream.status === 409 && !errPayload.code) errPayload.code = 'PrekeyUnavailable';
    return res.status(upstream.status).json(errPayload);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    data = {};
  }

  const ownerPublicKeyB64 = data?.owner_public_key_b64 || data?.ownerPublicKeyB64 || null;
  const prekeyBundle = data?.prekey_bundle || data?.prekeyBundle || null;
  const expiresAt = data?.expires_at || data?.expiresAt || null;
  if (!ownerPublicKeyB64 || !prekeyBundle || !expiresAt) {
    return res.status(502).json({ error: 'InviteCreateFailed', message: 'worker response incomplete' });
  }

  return res.json({
    inviteId,
    expiresAt,
    ownerAccountDigest: normalizeAccountDigest(data?.owner_account_digest || data?.ownerAccountDigest || auth.accountDigest),
    ownerDeviceId: data?.owner_device_id || data?.ownerDeviceId || senderDeviceId,
    ownerPublicKeyB64,
    prekeyBundle
  });
};

export const deliverInviteDropbox = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  const schemaError = rejectInviteSchemaMismatch(res, req.body, {
    allowedFields: INVITE_DELIVER_ALLOWED_FIELDS,
    aliasFields: INVITE_DELIVER_ALIAS_FIELDS
  });
  if (schemaError) return schemaError;
  let input;
  try {
    input = InviteDeliverSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }
  if (!input.accountToken) {
    return res.status(401).json({ error: 'Unauthorized', message: 'accountToken required' });
  }
  if (!input.ciphertextEnvelope || typeof input.ciphertextEnvelope !== 'object') {
    return res.status(400).json({ error: 'BadRequest', message: 'ciphertextEnvelope required' });
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

  const path = '/d1/invites/deliver';
  const bodyPayload = {
    inviteId: input.inviteId,
    ciphertextEnvelope: input.ciphertextEnvelope,
    accountToken: String(input.accountToken).trim(),
    accountDigest: auth.accountDigest,
    deviceId: senderDeviceId
  };
  const body = JSON.stringify(bodyPayload);
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
      error: 'InviteDeliverFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    let payload = null;
    try {
      payload = txt ? JSON.parse(txt) : null;
    } catch {
      payload = null;
    }
    const errPayload = payload && typeof payload === 'object'
      ? payload
      : { error: 'InviteDeliverFailed', details: txt || 'upstream error' };
    if (upstream.status === 409 && !errPayload.code) errPayload.code = 'InviteAlreadyDelivered';
    if (upstream.status === 410 && !errPayload.code) errPayload.code = 'InviteExpired';
    return res.status(upstream.status).json(errPayload);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    data = {};
  }

  try {
    const manager = getWebSocketManager();
    const targetDigest = normalizeAccountDigest(data?.owner_account_digest || data?.ownerAccountDigest || null);
    if (manager && targetDigest) {
      manager.sendInviteDelivered(null, {
        targetAccountDigest: targetDigest,
        targetDeviceId: data?.owner_device_id || data?.ownerDeviceId || null,
        inviteId: input.inviteId
      });
    }
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'ws_invite_delivered_notify_failed');
  }

  return res.json({ ok: true });
};

export const consumeInviteDropbox = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  const schemaError = rejectInviteSchemaMismatch(res, req.body, {
    allowedFields: INVITE_CONSUME_ALLOWED_FIELDS,
    aliasFields: INVITE_CONSUME_ALIAS_FIELDS
  });
  if (schemaError) return schemaError;
  let input;
  try {
    input = InviteConsumeSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }
  if (!input.accountToken) {
    return res.status(401).json({ error: 'Unauthorized', message: 'accountToken required' });
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

  const path = '/d1/invites/consume';
  const bodyPayload = {
    inviteId: input.inviteId,
    accountToken: String(input.accountToken).trim(),
    accountDigest: auth.accountDigest,
    deviceId: senderDeviceId
  };
  const body = JSON.stringify(bodyPayload);
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
      error: 'InviteConsumeFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    let payload = null;
    try {
      payload = txt ? JSON.parse(txt) : null;
    } catch {
      payload = null;
    }
    const errPayload = payload && typeof payload === 'object'
      ? payload
      : { error: 'InviteConsumeFailed', details: txt || 'upstream error' };
    if (upstream.status === 410 && !errPayload.code) errPayload.code = 'InviteExpired';
    return res.status(upstream.status).json(errPayload);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    data = {};
  }

  const envelope = data?.ciphertext_envelope || data?.ciphertextEnvelope || null;
  if (!envelope) {
    return res.status(502).json({ error: 'InviteConsumeFailed', message: 'worker response missing ciphertext' });
  }

  return res.json({
    ok: true,
    inviteId: data?.invite_id || data?.inviteId || input.inviteId || null,
    expiresAt: data?.expires_at || data?.expiresAt || null,
    ownerDeviceId: data?.owner_device_id || data?.ownerDeviceId || null,
    ciphertextEnvelope: envelope
  });
};

export const statusInviteDropbox = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }
  const schemaError = rejectInviteSchemaMismatch(res, req.body, {
    allowedFields: INVITE_STATUS_ALLOWED_FIELDS,
    aliasFields: INVITE_STATUS_ALIAS_FIELDS
  });
  if (schemaError) return schemaError;
  let input;
  try {
    input = InviteStatusSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }
  if (!input.accountToken) {
    return res.status(401).json({ error: 'Unauthorized', message: 'accountToken required' });
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

  const path = '/d1/invites/status';
  const bodyPayload = {
    inviteId: input.inviteId,
    accountToken: String(input.accountToken).trim(),
    accountDigest: auth.accountDigest
  };
  const body = JSON.stringify(bodyPayload);
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
      error: 'InviteStatusFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    data = {};
  }

  if (!upstream.ok) {
    const errPayload = data && typeof data === 'object'
      ? data
      : { error: 'InviteStatusFailed', details: data || 'upstream error' };
    return res.status(upstream.status).json(errPayload);
  }

  return res.json(data);
};
