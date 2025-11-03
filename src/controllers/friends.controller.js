import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { z } from 'zod';
import { signHmac } from '../utils/hmac.js';
import { logger } from '../utils/logger.js';
import { getWebSocketManager } from '../ws/index.js';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { normalizeAccountDigest, normalizeUidHex, AccountDigestRegex } from '../utils/account-verify.js';

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

const UidHexRegex = /^[0-9A-Fa-f]{14,}$/;

const CreateInviteSchema = z.object({
  uidHex: z.string().regex(UidHexRegex),
  ttlSeconds: z.number().int().min(30).max(600).optional(),
  prekeyBundle: z.any().optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const ContactEnvelopeSchema = z.object({
  iv: z.string().min(8),
  ct: z.string().min(16)
});

const AcceptInviteSchema = z.object({
  inviteId: z.string().min(8),
  secret: z.string().min(8),
  myUid: z.string().regex(UidHexRegex).optional(),
  uidHex: z.string().regex(UidHexRegex).optional(),
  contactEnvelope: ContactEnvelopeSchema.optional(),
  guestBundle: z.any().optional(),
  ownerUid: z.string().regex(UidHexRegex).optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
  if (!value.myUid && !value.uidHex) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'myUid or uidHex required' });
  }
});

const AttachInviteContactSchema = z.object({
  inviteId: z.string().min(8),
  secret: z.string().min(8),
  envelope: ContactEnvelopeSchema,
  uidHex: z.string().regex(UidHexRegex),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const DeleteContactSchema = z.object({
  uidHex: z.string().regex(UidHexRegex),
  peerUid: z.string().regex(UidHexRegex),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  peerAccountDigest: z.string().min(14).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const ShareContactSchema = z.object({
  inviteId: z.string().min(8),
  secret: z.string().min(8),
  myUid: z.string().regex(UidHexRegex),
  envelope: ContactEnvelopeSchema,
  peerUid: z.string().regex(UidHexRegex).optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  conversationId: z.string().min(8).optional(),
  conversationFingerprint: z.string().min(8).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

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

export const createInvite = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input;
  try {
    input = CreateInviteSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      uidHex: input.uidHex,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const inviteId = nanoid(16);
  const secret = crypto.randomBytes(24).toString('base64url');
  const ttl = Math.min(Math.max(input.ttlSeconds ?? 300, 30), 600);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;

  const path = '/d1/friends/invite';
  const bodyPayload = {
    inviteId,
    ownerUid: auth.uidHex,
    secret,
    expiresAt,
    prekeyBundle: input.prekeyBundle ?? null,
    channelSeed: null,
    accountToken: input.accountToken ? String(input.accountToken).trim() : null,
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
      error: 'InviteCreateFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }
  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    return res.status(502).json({ error: 'InviteCreateFailed', details: txt });
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    payload = {};
  }

  return res.json({
    inviteId,
    secret,
    expiresAt,
    ownerUid: auth.uidHex || payload?.owner_uid || null,
    prekeyBundle: payload?.prekey_bundle || null
  });
};

export const acceptInvite = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input;
  try {
    input = AcceptInviteSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      uidHex: input.uidHex || input.myUid,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const guestUid = auth.uidHex;
  const requestedMyUid = input.myUid ? normalizeUidHex(input.myUid) : null;
  if (requestedMyUid && requestedMyUid !== guestUid) {
    return res.status(403).json({ error: 'AccountMismatch', message: 'myUid does not match verified account' });
  }
  const ownerUid = input.ownerUid ? normalizeUidHex(input.ownerUid) : undefined;

  const path = '/d1/friends/accept';
  const bodyPayload = {
    inviteId: input.inviteId,
    secret: input.secret,
    guestContact: input.contactEnvelope || undefined,
    guestUid,
    myUid: guestUid,
    guestBundle: input.guestBundle || undefined,
    ownerUid: ownerUid || undefined,
    accountDigest: auth.accountDigest,
    accountToken: input.accountToken ? String(input.accountToken).trim() : undefined
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
      error: 'InviteAcceptFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({ error: 'InviteAcceptFailed', details: txt });
  }

  const data = await upstream.json();
  try {
    const manager = getWebSocketManager();
    manager?.notifyInviteAccepted(data?.owner_uid, input.inviteId, guestUid);
    if (guestUid) manager?.notifyContactsReload(guestUid);
    if (data?.owner_uid) manager?.notifyContactsReload(String(data.owner_uid).toUpperCase());
    if (data?.owner_uid && input.contactEnvelope && guestUid) {
      manager?.sendContactShare(String(data.owner_uid).toUpperCase(), {
        fromUid: guestUid,
        inviteId: input.inviteId,
        envelope: input.contactEnvelope
      });
    }
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'ws_notify_failed');
  }
  return res.json(data);
};

export const attachInviteContact = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input;
  try {
    input = AttachInviteContactSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      uidHex: input.uidHex,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const path = '/d1/friends/invite/contact';
  const payload = {
    inviteId: input.inviteId,
    secret: input.secret,
    envelope: input.envelope,
    ownerUid: auth.uidHex,
    accountDigest: auth.accountDigest
  };
  if (input.accountToken) payload.accountToken = String(input.accountToken).trim();
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
      error: 'InviteContactAttachFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({ error: 'InviteContactAttachFailed', details: txt });
  }

  const data = await upstream.json().catch(() => ({ ok: true }));
  return res.json(data);
};

export const shareContactUpdate = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input;
  try {
    input = ShareContactSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      uidHex: input.myUid,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const myUid = auth.uidHex;
  const peerUid = input.peerUid ? normalizeUidHex(input.peerUid) : null;
  const accountDigest = auth.accountDigest;

  const path = '/d1/friends/contact/share';
  const payload = {
    inviteId: input.inviteId,
    secret: input.secret,
    myUid,
    envelope: input.envelope
  };
  if (peerUid) payload.peerUid = peerUid;
  if (accountDigest) payload.accountDigest = accountDigest;
  if (input.conversationId) payload.conversationId = String(input.conversationId);
  if (input.conversationFingerprint) payload.conversationFingerprint = String(input.conversationFingerprint);
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
      error: 'ContactShareFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({ error: 'ContactShareFailed', details: txt });
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    data = { ok: true };
  }

  try {
    const manager = getWebSocketManager();
    const targetUid = normalizeUidHex(data?.targetUid || input.peerUid || '');
    if (targetUid) {
      manager?.sendContactShare(targetUid, {
        fromUid: myUid,
        inviteId: input.inviteId,
        envelope: input.envelope
      });
      manager?.notifyContactsReload(targetUid);
    }
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'ws_contact_share_notify_failed');
  }

  return res.json(data);
};

export const deleteContact = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
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
      uidHex: input.uidHex,
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const ownerUid = auth.uidHex;
  const peerUid = normalizeUidHex(input.peerUid);
  if (!peerUid) {
    return res.status(400).json({ error: 'BadRequest', message: 'invalid peerUid' });
  }
  const ownerAccountDigest = auth.accountDigest;
  const peerAccountDigest = input.peerAccountDigest ? normalizeAccountDigest(input.peerAccountDigest) : null;

  const path = '/d1/friends/contact-delete';
  const payload = { ownerUid, peerUid, ownerAccountDigest };
  if (peerAccountDigest) payload.peerAccountDigest = peerAccountDigest;
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
    manager?.notifyContactsReload(ownerUid);
    if (peerUid) manager?.notifyContactsReload(peerUid);
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'ws_contact_delete_notify_failed');
  }

  return res.json(data);
};
