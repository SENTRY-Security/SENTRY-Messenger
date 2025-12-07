import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
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

const CreateInviteSchema = z.object({
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
  contactEnvelope: ContactEnvelopeSchema.optional(),
  guestBundle: z.any().optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
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
  accountToken: z.string().min(8).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const ShareContactSchema = z.object({
  inviteId: z.string().min(8),
  secret: z.string().min(8),
  envelope: ContactEnvelopeSchema,
  peerAccountDigest: z.string().regex(AccountDigestRegex),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  conversationId: z.string().min(8).optional(),
  conversationFingerprint: z.string().min(8).optional()
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
  const ek = clean(bundle.ek_pub || bundle.ek || bundle.ephemeral_pub || '');
  const sig = clean(bundle.spk_sig || bundle.spkSig || bundle.signature || '');
  if (!ek || !sig) return null;
  const normalized = { ek_pub: ek, spk_sig: sig };
  const ik = clean(bundle.ik_pub || bundle.ik || bundle.identity_pub || '');
  if (ik) normalized.ik_pub = ik;
  const spk = clean(bundle.spk_pub || bundle.spk || '');
  if (spk) normalized.spk_pub = spk;
  const opkIdRaw = bundle.opk_id ?? bundle.opkId ?? bundle.opk?.id;
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
  ownerContact,
  guestContact,
  inviteId,
  guestContactTs = null,
  ownerContactTs = null,
  usedAt = null,
  createdAt = null
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
    ownerContact: ownerContact || null,
    guestContact: guestContact || null,
    inviteId: inviteId || null,
    guestContactTs: Number.isFinite(guestContactTs) ? guestContactTs : null,
    ownerContactTs: Number.isFinite(ownerContactTs) ? ownerContactTs : null,
    usedAt: Number.isFinite(usedAt) ? usedAt : null,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    cachedAt: Date.now(),
    lastAccessAt: null
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
  const secret = crypto.randomBytes(24).toString('base64url');
  const ttl = Math.min(Math.max(input.ttlSeconds ?? 300, 30), 600);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;

  const path = '/d1/friends/invite';
  const bodyPayload = {
    inviteId,
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
    let payload = null;
    try {
      payload = txt ? JSON.parse(txt) : null;
    } catch {
      payload = null;
    }
    if (payload && typeof payload === 'object') {
      return res.status(upstream.status).json(payload);
    }
    return res.status(upstream.status).json({ error: 'InviteCreateFailed', details: txt || 'upstream error' });
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
    ownerAccountDigest: auth.accountDigest || payload?.owner_account_digest || null,
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
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const path = '/d1/friends/accept';
  const bodyPayload = {
    inviteId: input.inviteId,
    secret: input.secret,
    guestContact: input.contactEnvelope || undefined,
    guestBundle: input.guestBundle || undefined,
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
  const ownerAccountDigest = data?.owner_account_digest || auth.accountDigest || null;
  try {
    const manager = getWebSocketManager();
    if (manager && ownerAccountDigest && input?.contactEnvelope) {
      try {
        manager.sendContactShare(null, {
          fromAccountDigest: auth.accountDigest,
          inviteId: input.inviteId,
          envelope: input.contactEnvelope,
          targetAccountDigest: ownerAccountDigest
        });
      } catch (err) {
        logger.warn({ err: err?.message || err }, 'ws_contact_share_owner_notify_failed');
      }
    }
    if (ownerAccountDigest) {
      manager?.notifyContactsReload(null, ownerAccountDigest);
    }
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'ws_notify_failed');
  }
  try {
    setBootstrapCache({
      ownerAccountDigest,
      ownerAccountDigest: data?.owner_account_digest || null,
      guestAccountDigest: data?.guest_account_digest || auth.accountDigest || null,
      guestBundle: input.guestBundle || data?.guest_bundle || null,
      ownerContact: data?.owner_contact || null,
      guestContact: data?.guest_contact || null,
      inviteId: input.inviteId || null,
      guestContactTs: data?.guest_contact_ts ?? null,
      ownerContactTs: data?.owner_contact_ts ?? null,
      usedAt: data?.used_at ?? null,
      createdAt: data?.created_at ?? null
    });
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'bootstrap_cache_store_failed');
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
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err, 'account verification failed');
  }

  const peerAccountDigest = input.peerAccountDigest ? normalizeAccountDigest(input.peerAccountDigest) : null;
  const accountDigest = auth.accountDigest;

  const path = '/d1/friends/contact/share';
  const payload = {
    inviteId: input.inviteId,
    secret: input.secret,
    envelope: input.envelope,
    accountDigest
  };
  if (peerAccountDigest) payload.peerAccountDigest = peerAccountDigest;
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
    const targetDigest = normalizeAccountDigest(data?.targetAccountDigest || input.peerAccountDigest || null);
    if (targetDigest) {
      manager?.notifyContactsReload(null, targetDigest);
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
  if (cacheHit?.record?.guestBundle) {
    const { record, role } = cacheHit;
    const response = {
      role,
      inviteId: record.inviteId || null,
      guestBundle: record.guestBundle,
      guestContact: record.guestContact || null,
      ownerContact: record.ownerContact || null,
      guestContactTs: record.guestContactTs || null,
      ownerContactTs: record.ownerContactTs || null,
      usedAt: record.usedAt || null,
      createdAt: record.createdAt || null
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
    if (data && typeof data === 'object') {
      return res.status(upstream.status).json(data);
    }
    return res.status(upstream.status).json({
      error: 'FriendBootstrapFailed',
      details: text || 'upstream error'
    });
  }

  const record = (data && typeof data === 'object' ? (data.record || data) : {}) || {};
  const responseBase = {
    role: typeof record.role === 'string' ? record.role : null,
    inviteId: record.invite_id || record.inviteId || null,
    ownerAccountDigest: record.owner_account_digest || record.ownerAccountDigest || null,
    guestAccountDigest: record.guest_account_digest || record.guestAccountDigest || null,
    guestContact: record.guest_contact || record.guestContact || null,
    ownerContact: record.owner_contact || record.ownerContact || null,
    guestContactTs: record.guest_contact_ts || record.guestContactTs || null,
    ownerContactTs: record.owner_contact_ts || record.ownerContactTs || null,
    usedAt: record.used_at || record.usedAt || null,
    createdAt: record.created_at || record.createdAt || null
  };

  const workerGuestBundle = record.guest_bundle || record.guestBundle || null;
  const normalizedWorkerGuestBundle = normalizeGuestBundlePayload(workerGuestBundle);
  if (!normalizedWorkerGuestBundle) {
    logger.warn({
      inviteId: responseBase.inviteId || payload.inviteId || null
    }, 'guest_bundle_missing_from_worker');
    return res.status(409).json({
      error: 'GuestBundleIncomplete',
      message: '好友金鑰資料缺失，請請對方重新產生邀請並完成登入'
    });
  }

  const response = { ...responseBase, guestBundle: normalizedWorkerGuestBundle };

  try {
    setBootstrapCache({
      ownerAccountDigest: record.owner_account_digest || null,
      guestAccountDigest: record.guest_account_digest || null,
      guestBundle: normalizedWorkerGuestBundle,
      ownerContact: response.ownerContact,
      guestContact: response.guestContact,
      inviteId: response.inviteId,
      guestContactTs: response.guestContactTs,
      ownerContactTs: response.ownerContactTs,
      usedAt: response.usedAt,
      createdAt: response.createdAt
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
    if (peerTargetDigest) manager?.notifyContactsReload(null, peerTargetDigest);
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'ws_contact_delete_notify_failed');
  }

  return res.json(data);
};
