import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { z } from 'zod';
import { signHmac } from '../utils/hmac.js';
import { logger } from '../utils/logger.js';
import { getWebSocketManager } from '../ws/index.js';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { normalizeAccountDigest, AccountDigestRegex } from '../utils/account-verify.js';
import { authorizeConversationAccess, normalizeConversationId } from '../utils/conversation-auth.js';

const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;
const INVITE_TOKEN_KEY = process.env.INVITE_TOKEN_KEY || '';
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
  ttlSeconds: z.number().int().min(30).max(600).optional(),
  deviceId: z.string().min(1).optional(),
  prekeyBundle: z.any().optional(),
  tokenHash: z.string().min(32).optional(),
  inviteToken: z.string().min(16).optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
  if (!value.tokenHash && !value.inviteToken) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tokenHash or inviteToken required' });
  }
});

function getInviteTokenKey() {
  if (INVITE_TOKEN_KEY && INVITE_TOKEN_KEY.length >= 8) return INVITE_TOKEN_KEY;
  throw new Error('INVITE_TOKEN_KEY missing or too short (>=8 chars required)');
}

function hashInviteToken(inviteToken) {
  if (!inviteToken) return null;
  const key = getInviteTokenKey();
  return crypto.createHmac('sha256', key).update(inviteToken).digest('hex');
}

const ContactEnvelopeSchema = z.object({
  iv: z.string().min(8),
  ct: z.string().min(16)
});

const AcceptInviteSchema = z.object({
  inviteId: z.string().min(8),
  inviteToken: z.string().min(16),
  guestBundle: z.any().optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  deviceId: z.string().min(1).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const AttachInviteContactSchema = z.object({
  inviteId: z.string().min(8),
  secret: z.string().min(8),
  envelope: ContactEnvelopeSchema,
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

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

const ShareContactSchema = z.object({
  conversationId: z.string().min(8),
  envelope: ContactEnvelopeSchema,
  peerAccountDigest: z.string().regex(AccountDigestRegex),
  inviteId: z.string().min(8).optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  peerDeviceId: z.string().min(1).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const BootstrapSessionSchema = z.object({
  accountDigest: z.string().regex(AccountDigestRegex),
  peerAccountDigest: z.string().regex(AccountDigestRegex),
  accountToken: z.string().min(8).optional(),
  roleHint: z.enum(['owner', 'guest']).optional(),
  inviteId: z.string().min(8).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const SESSION_BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const sessionBootstrapCache = new Map();

function normalizeGuestBundlePayload(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  const clean = (value) => (typeof value === 'string' ? value.trim() : '');
  const ek = clean(bundle.ek_pub || '');
  const sig = clean(bundle.spk_sig || '');
  if (!ek || !sig) return null;
  const normalized = { ek_pub: ek, spk_sig: sig };
  const ik = clean(bundle.ik_pub || '');
  if (ik) normalized.ik_pub = ik;
  const spk = clean(bundle.spk_pub || '');
  if (spk) normalized.spk_pub = spk;
  const opkIdRaw = bundle.opk_id;
  if (opkIdRaw !== undefined && opkIdRaw !== null && opkIdRaw !== '') {
    const parsed = Number(opkIdRaw);
    if (Number.isFinite(parsed)) normalized.opk_id = parsed;
  }
  return normalized;
}

function makeBootstrapKey(owner, guest) {
  return `${owner}::${guest}`;
}

function normalizeBootstrapId({ digest }) {
  const normDigest = digest ? normalizeAccountDigest(digest) : null;
  return normDigest || null;
}

function pruneBootstrapCache(now = Date.now()) {
  for (const [key, entry] of sessionBootstrapCache.entries()) {
    if (!entry || !Number.isFinite(entry.cachedAt)) continue;
    if (now - entry.cachedAt > SESSION_BOOTSTRAP_TTL_MS) {
      sessionBootstrapCache.delete(key);
    }
  }
}

function setBootstrapCache({
  ownerAccountDigest,
  guestAccountDigest,
  guestBundle,
  ownerDeviceId = null,
  guestDeviceId = null,
  ownerContact,
  guestContact,
  inviteId,
  guestContactTs = null,
  ownerContactTs = null,
  usedAt = null,
  createdAt = null,
  prekeyMeta = null,
  ownerPrekeyMeta = null,
  peerPrekeyMeta = null,
  requesterPrekeyMeta = null
} = {}) {
  const ownerDigestNorm = ownerAccountDigest ? normalizeAccountDigest(ownerAccountDigest) : null;
  const guestDigestNorm = guestAccountDigest ? normalizeAccountDigest(guestAccountDigest) : null;
  const keyOwner = normalizeBootstrapId({ digest: ownerDigestNorm });
  const keyGuest = normalizeBootstrapId({ digest: guestDigestNorm });
  if (!keyOwner || !keyGuest) return;
  const normalizedGuestBundle = normalizeGuestBundlePayload(guestBundle);
  if (!normalizedGuestBundle) {
    logger.warn({ ownerDigest: ownerDigestNorm, guestDigest: guestDigestNorm }, 'guest_bundle_cache_rejected');
    return;
  }
  pruneBootstrapCache();
  const key = makeBootstrapKey(keyOwner, keyGuest);
  sessionBootstrapCache.set(key, {
    ownerAccountDigest: ownerDigestNorm,
    guestAccountDigest: guestDigestNorm,
    guestBundle: normalizedGuestBundle,
    ownerDeviceId: ownerDeviceId || null,
    guestDeviceId: guestDeviceId || null,
    ownerContact: ownerContact || null,
    guestContact: guestContact || null,
    inviteId: inviteId || null,
    guestContactTs: Number.isFinite(guestContactTs) ? guestContactTs : null,
    ownerContactTs: Number.isFinite(ownerContactTs) ? ownerContactTs : null,
    usedAt: Number.isFinite(usedAt) ? usedAt : null,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    cachedAt: Date.now(),
    lastAccessAt: null,
    prekeyMeta: prekeyMeta || null,
    ownerPrekeyMeta: ownerPrekeyMeta || null,
    peerPrekeyMeta: peerPrekeyMeta || null,
    requesterPrekeyMeta: requesterPrekeyMeta || null
  });
}

function getBootstrapCache({ requesterDigest, peerAccountDigest }) {
  pruneBootstrapCache();
  const requester = normalizeBootstrapId({ digest: requesterDigest });
  const peer = normalizeBootstrapId({ digest: peerAccountDigest });
  if (!requester || !peer) return null;

  const forwardKey = makeBootstrapKey(requester, peer);
  let entry = sessionBootstrapCache.get(forwardKey);
  let role = 'owner';
  let cacheKey = entry ? forwardKey : null;
  if (entry) {
    if (entry.ownerAccountDigest && requesterDigest && normalizeAccountDigest(requesterDigest) !== entry.ownerAccountDigest) {
      entry = null;
      cacheKey = null;
    }
  }
  if (!entry) {
    const reverseKey = makeBootstrapKey(peer, requester);
    const reverse = sessionBootstrapCache.get(reverseKey);
    if (reverse) {
      if (!reverse.guestAccountDigest || !requesterDigest || normalizeAccountDigest(requesterDigest) === reverse.guestAccountDigest) {
        entry = reverse;
        role = 'guest';
        cacheKey = reverseKey;
      }
    }
  }
  if (!entry) return null;
  const normalized = normalizeGuestBundlePayload(entry.guestBundle);
  if (!normalized) {
    if (cacheKey) sessionBootstrapCache.delete(cacheKey);
    return null;
  }
  entry.guestBundle = normalized;
  entry.lastAccessAt = Date.now();
  return { role, record: entry };
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

export const createInvite = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
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
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const inviteId = nanoid(16);
  let tokenHash = null;
  if (input.inviteToken) {
    try {
      tokenHash = hashInviteToken(input.inviteToken);
    } catch (err) {
      return res.status(500).json({ error: 'ConfigError', message: err?.message || 'invite token key missing' });
    }
  } else {
    tokenHash = input.tokenHash || null;
  }
  if (!tokenHash) {
    return res.status(400).json({ error: 'BadRequest', message: 'tokenHash or inviteToken required' });
  }
  const ttl = Math.min(Math.max(input.ttlSeconds ?? 300, 30), 600);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;

  const path = '/d1/friends/invite';
  const bodyPayload = {
    inviteId,
    tokenHash,
    expiresAt,
    deviceId: senderDeviceId,
    prekeyBundle: input.prekeyBundle ?? null,
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
    let payload = null;
    try {
      payload = txt ? JSON.parse(txt) : null;
    } catch {
      payload = null;
    }
    const errPayload = payload && typeof payload === 'object'
      ? payload
      : { error: 'InviteCreateFailed', details: txt || 'upstream error' };
    if (upstream.status === 409) errPayload.code = 'PrekeyUnavailable';
    return res.status(upstream.status).json(errPayload);
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    payload = {};
  }

  return res.json({
    inviteId,
    expiresAt,
    ownerAccountDigest: auth.accountDigest || payload?.owner_account_digest || null,
    ownerDeviceId: senderDeviceId,
    prekeyBundle: payload?.prekey_bundle || null
  });
};

export const acceptInvite = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
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
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const path = '/d1/friends/accept';
  const bodyPayload = {
    inviteId: input.inviteId,
    inviteToken: input.inviteToken,
    guestBundle: input.guestBundle || undefined,
    accountDigest: auth.accountDigest || undefined,
    deviceId: senderDeviceId,
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
    let payload = null;
    try { payload = txt ? JSON.parse(txt) : null; } catch { payload = null; }
    const errPayload = payload && typeof payload === 'object'
      ? payload
      : { error: 'InviteAcceptFailed', details: txt };
    if (upstream.status === 403) errPayload.code = errPayload.code || 'InviteTokenMismatch';
    if (upstream.status === 410) errPayload.code = errPayload.code || 'InviteExpired';
    if (upstream.status === 409 && !errPayload.code) {
      errPayload.code = errPayload.error === 'PrekeyUnavailable'
        ? 'PrekeyUnavailable'
        : 'InviteAlreadyUsed';
    }
    return res.status(upstream.status).json(errPayload);
  }

  const data = await upstream.json();
  const ownerAccountDigest = normalizeAccountDigest(data?.owner_account_digest || null);
  const ownerDeviceId = data?.owner_device_id || null;
  const ownerPrekeyBundle = data?.owner_prekey_bundle || null;
  if (!ownerAccountDigest || !ownerPrekeyBundle) {
    return res.status(502).json({
      error: 'BootstrapIncomplete',
      message: 'worker response missing owner digest or prekey bundle'
    });
  }

  return res.json({
    ok: true,
    inviteId: data?.invite_id || input.inviteId || null,
    inviteVersion: data?.invite_version || null,
    expiresAt: data?.expires_at || null,
    ownerAccountDigest,
    ownerDeviceId,
    guestDeviceId: senderDeviceId,
    ownerPrekeyBundle
  });
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
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const peerAccountDigest = input.peerAccountDigest ? normalizeAccountDigest(input.peerAccountDigest) : null;
  const accountDigest = auth.accountDigest;
  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
  }
  const peerDeviceId = input.peerDeviceId ? String(input.peerDeviceId).trim() : null;
  if (!peerDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'peerDeviceId required' });
  }
  const conversationId = normalizeConversationId(input.conversationId);
  if (!conversationId) {
    return res.status(400).json({ error: 'BadRequest', message: 'conversationId required' });
  }

  try {
    await authorizeConversationAccess({
      convId: conversationId,
      accountDigest,
      deviceId: senderDeviceId
    });
  } catch (err) {
    const status = err?.status || 502;
    const details = err?.details || { error: 'ConversationAuthFailed', message: err?.message || 'conversation authorization failed' };
    return res.status(status).json(details);
  }

  const path = '/d1/friends/contact/share';
  const payload = {
    conversationId,
    envelope: input.envelope,
    accountDigest,
    peerDeviceId,
    senderDeviceId
  };
  if (input.inviteId) payload.inviteId = input.inviteId;
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
      error: 'ContactShareFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    const errPayload = { error: 'ContactShareFailed', details: txt };
    if (upstream.status === 403) errPayload.code = 'ConversationDeviceMismatch';
    return res.status(upstream.status).json(errPayload);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    data = { ok: true };
  }

  try {
    const manager = getWebSocketManager();
    const targetDigest = normalizeAccountDigest(data?.targetAccountDigest || input.peerAccountDigest || null);
    if (manager && targetDigest) {
      manager.sendContactShare(null, {
        fromAccountDigest: auth.accountDigest,
        inviteId: input.inviteId || null,
        envelope: input.envelope,
        targetAccountDigest: targetDigest,
        senderDeviceId,
        targetDeviceId: peerDeviceId,
        conversationId
      });
      manager.notifyContactsReload(null, targetDigest);
    }
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'ws_contact_share_notify_failed');
  }

  return res.json(data);
};

export const bootstrapFriendSession = async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
  }

  let input;
  try {
    input = BootstrapSessionSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err?.message || 'invalid input' });
  }

  const senderDeviceId = req.get('x-device-id') || null;
  if (!senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'deviceId header required' });
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

  const peerAccountDigest = normalizeAccountDigest(input.peerAccountDigest);
  if (!peerAccountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'peer account digest required' });
  }

  const cacheHit = getBootstrapCache({
    requesterDigest: auth.accountDigest,
    peerAccountDigest
  });
  if (cacheHit?.record) {
    const { record, role } = cacheHit;
    const prekeyMeta = record.prekeyMeta || null;
    const ownerPrekeyMeta = record.ownerPrekeyMeta || (prekeyMeta && prekeyMeta.owner) || null;
    const peerPrekeyMeta = record.peerPrekeyMeta || (prekeyMeta && prekeyMeta.peer) || null;
    const requesterPrekeyMeta = record.requesterPrekeyMeta || (prekeyMeta && prekeyMeta.requester) || null;
    const response = {
      role,
      inviteId: record.inviteId || null,
      guestBundle: record.guestBundle || null,
      ownerDeviceId: record.ownerDeviceId || null,
      guestDeviceId: record.guestDeviceId || null,
      guestContact: record.guestContact || null,
      ownerContact: record.ownerContact || null,
      guestContactTs: record.guestContactTs || null,
      ownerContactTs: record.ownerContactTs || null,
      usedAt: record.usedAt || null,
      createdAt: record.createdAt || null,
      prekeyMeta,
      ownerPrekeyMeta,
      peerPrekeyMeta,
      requesterPrekeyMeta
    };
    return res.json({ ok: true, ...response });
  }

  const path = '/d1/friends/bootstrap';
  const payload = {
    accountDigest: auth.accountDigest,
    peerAccountDigest
  };
  if (input.roleHint) payload.roleHint = input.roleHint;
  if (input.inviteId) payload.inviteId = input.inviteId;
  payload.deviceId = senderDeviceId;
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
      error: 'FriendBootstrapFailed',
      message: 'Upstream timeout',
      details: err?.message || 'fetch aborted'
    });
  }

  const text = await upstream.text().catch(() => '');
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!upstream.ok) {
    const errPayload = data && typeof data === 'object'
      ? data
      : { error: 'FriendBootstrapFailed', details: text || 'upstream error' };
    if (upstream.status === 403) errPayload.code = 'InviteTokenMismatch';
    if (upstream.status === 410) errPayload.code = 'InviteExpired';
    if (upstream.status === 404) errPayload.code = 'FriendshipNotFound';
    if (upstream.status === 410 && errPayload.code !== 'InviteExpired') {
      errPayload.code = 'BootstrapRemoved';
      errPayload.message = errPayload.message || 'bootstrap-session deprecated';
    }
    return res.status(upstream.status).json(errPayload);
  }

  const record = (data && typeof data === 'object' ? (data.record || data) : {}) || {};
  const ownerAccountDigestNorm = normalizeAccountDigest(record.owner_account_digest || record.ownerAccountDigest || null);
  const guestAccountDigestNorm = normalizeAccountDigest(record.guest_account_digest || record.guestAccountDigest || null);
  const ownerDeviceId = record.owner_device_id || record.ownerDeviceId || null;
  const guestDeviceId = record.guest_device_id || record.guestDeviceId || null;
  const workerGuestBundle = record.guest_bundle || record.guestBundle || null;
  const normalizedWorkerGuestBundle = normalizeGuestBundlePayload(workerGuestBundle);
  if (input.inviteId && !normalizedWorkerGuestBundle) {
    return res.status(502).json({
      error: 'GuestBundleUnavailable',
      message: 'bootstrap response missing guest_bundle for invite'
    });
  }
  const prekeyMeta = record.prekey_meta || record.prekeyMeta || null;
  const ownerPrekeyMeta = record.owner_prekey_meta || record.ownerPrekeyMeta || (prekeyMeta && prekeyMeta.owner) || null;
  const peerPrekeyMeta = record.peer_prekey_meta || record.peerPrekeyMeta || (prekeyMeta && prekeyMeta.peer) || null;
  const requesterPrekeyMeta = record.requester_prekey_meta || record.requesterPrekeyMeta || (prekeyMeta && prekeyMeta.requester) || null;
  const response = {
    role: typeof record.role === 'string' ? record.role : null,
    inviteId: record.invite_id || record.inviteId || null,
    ownerAccountDigest: ownerAccountDigestNorm,
    guestAccountDigest: guestAccountDigestNorm,
    ownerDeviceId,
    guestDeviceId,
    guestContact: record.guest_contact || record.guestContact || null,
    ownerContact: record.owner_contact || record.ownerContact || null,
    guestContactTs: record.guest_contact_ts || record.guestContactTs || null,
    ownerContactTs: record.owner_contact_ts || record.ownerContactTs || null,
    usedAt: record.used_at || record.usedAt || null,
    createdAt: record.created_at || record.createdAt || null,
    guestBundle: normalizedWorkerGuestBundle || null,
    prekeyMeta,
    ownerPrekeyMeta,
    peerPrekeyMeta,
    requesterPrekeyMeta
  };

  try {
    setBootstrapCache({
      ownerAccountDigest: ownerAccountDigestNorm || null,
      guestAccountDigest: guestAccountDigestNorm || null,
      guestBundle: normalizedWorkerGuestBundle,
      ownerDeviceId,
      guestDeviceId,
      ownerContact: response.ownerContact,
      guestContact: response.guestContact,
      inviteId: response.inviteId,
      guestContactTs: response.guestContactTs,
      ownerContactTs: response.ownerContactTs,
      usedAt: response.usedAt,
      createdAt: response.createdAt,
      prekeyMeta: response.prekeyMeta,
      ownerPrekeyMeta: response.ownerPrekeyMeta,
      peerPrekeyMeta: response.peerPrekeyMeta,
      requesterPrekeyMeta: response.requesterPrekeyMeta
    });
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'bootstrap_cache_store_failed');
  }

  return res.json({ ok: true, ...response });
};

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
