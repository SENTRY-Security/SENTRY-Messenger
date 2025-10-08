import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { z } from 'zod';
import { signHmac } from '../utils/hmac.js';
import { logger } from '../utils/logger.js';
import { getWebSocketManager } from '../ws/index.js';

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

const CreateInviteSchema = z.object({
  uidHex: z.string().min(14),
  ttlSeconds: z.number().int().min(30).max(600).optional(),
  prekeyBundle: z.any().optional()
});

const ContactEnvelopeSchema = z.object({
  iv: z.string().min(8),
  ct: z.string().min(16)
});

const AcceptInviteSchema = z.object({
  inviteId: z.string().min(8),
  secret: z.string().min(8),
  myUid: z.string().min(14).optional(),
  contactEnvelope: ContactEnvelopeSchema.optional(),
  guestBundle: z.any().optional(),
  ownerUid: z.string().min(14).optional()
});

const AttachInviteContactSchema = z.object({
  inviteId: z.string().min(8),
  secret: z.string().min(8),
  envelope: ContactEnvelopeSchema
});

const DeleteContactSchema = z.object({
  uidHex: z.string().min(14),
  peerUid: z.string().min(14)
});

const ShareContactSchema = z.object({
  inviteId: z.string().min(8),
  secret: z.string().min(8),
  myUid: z.string().min(14),
  envelope: ContactEnvelopeSchema,
  peerUid: z.string().min(14).optional()
});

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

  const inviteId = nanoid(16);
  const secret = crypto.randomBytes(24).toString('base64url');
  const ttl = Math.min(Math.max(input.ttlSeconds ?? 300, 30), 600);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;

  const path = '/d1/friends/invite';
  const body = JSON.stringify({
    inviteId,
    ownerUid: input.uidHex,
    secret,
    expiresAt,
    prekeyBundle: input.prekeyBundle ?? null,
    channelSeed: null
  });
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
    ownerUid: String(input.uidHex || '').toUpperCase() || payload?.owner_uid || null,
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

  const path = '/d1/friends/accept';
  const bodyPayload = {
    inviteId: input.inviteId,
    secret: input.secret,
    guestContact: input.contactEnvelope || undefined,
    guestUid: input.myUid ? String(input.myUid).toUpperCase() : undefined,
    guestBundle: input.guestBundle || undefined,
    ownerUid: input.ownerUid ? String(input.ownerUid).toUpperCase() : undefined
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
    manager?.notifyInviteAccepted(data?.owner_uid, input.inviteId, String(input.myUid || '').toUpperCase());
    if (input.myUid) manager?.notifyContactsReload(String(input.myUid).toUpperCase());
    if (data?.owner_uid) manager?.notifyContactsReload(String(data.owner_uid).toUpperCase());
    if (data?.owner_uid && input.contactEnvelope && input.myUid) {
      manager?.sendContactShare(String(data.owner_uid).toUpperCase(), {
        fromUid: String(input.myUid).toUpperCase(),
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

  const path = '/d1/friends/invite/contact';
  const body = JSON.stringify({ inviteId: input.inviteId, secret: input.secret, envelope: input.envelope });
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

  const path = '/d1/friends/contact/share';
  const body = JSON.stringify({
    inviteId: input.inviteId,
    secret: input.secret,
    myUid: input.myUid,
    envelope: input.envelope
  });
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
    const targetUid = String(data?.targetUid || input.peerUid || '').toUpperCase();
    if (targetUid) {
      manager?.sendContactShare(targetUid, {
        fromUid: String(input.myUid || '').toUpperCase(),
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

  const ownerUid = String(input.uidHex).toUpperCase();
  const peerUid = String(input.peerUid).toUpperCase();

  const path = '/d1/friends/contact-delete';
  const body = JSON.stringify({ ownerUid, peerUid });
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
