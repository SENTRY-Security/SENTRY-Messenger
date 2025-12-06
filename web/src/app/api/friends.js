import { fetchJSON } from '../core/http.js';
import { log } from '../core/log.js';
import { decodeFriendInvite } from '../lib/invite.js';
import { getAccountToken, getAccountDigest } from '../core/store.js';

function withAccount(payload = {}) {
  const out = { ...payload };
  if (out.accountToken == null) {
    const token = getAccountToken();
    if (token) out.accountToken = token;
  }
  if (out.accountDigest == null) {
    const digest = getAccountDigest();
    if (digest) out.accountDigest = digest;
  }
  if (out.accountDigest != null) {
    const cleanedDigest = String(out.accountDigest).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (cleanedDigest) out.accountDigest = cleanedDigest; else delete out.accountDigest;
  }
  return out;
}

export async function friendsCreateInvite({ ttlSeconds, prekeyBundle } = {}) {
  const payload = withAccount({});
  if (ttlSeconds) payload.ttlSeconds = ttlSeconds;
  if (prekeyBundle) payload.prekeyBundle = prekeyBundle;
  const res = await postInvite('/api/v1/friends/invite', payload);
  log({ inviteAPIResult: res });
  return res;
}

export async function friendsAcceptInvite({ inviteId, secret, contactEnvelope, guestBundle } = {}) {
  const payload = withAccount({ inviteId, secret });
  if (contactEnvelope && contactEnvelope.iv && contactEnvelope.ct) {
    payload.contactEnvelope = contactEnvelope;
  }
  if (guestBundle) payload.guestBundle = guestBundle;
  const { r, data } = await fetchJSON('/api/v1/friends/accept', payload);
  if (!r.ok) {
    const msg = formatErrorMessage(data, 'accept failed', r.status);
    throw new Error(msg);
  }
  return data;
}

export async function friendsAttachInviteContact({ inviteId, secret, envelope } = {}) {
  if (!inviteId || !secret || !envelope?.iv || !envelope?.ct) {
    throw new Error('invalid envelope payload');
  }
  const payload = withAccount({ inviteId, secret, envelope });
  const { r, data } = await fetchJSON('/api/v1/friends/invite/contact', payload);
  if (!r.ok) {
    const msg = formatErrorMessage(data, 'attach contact failed', r.status);
    throw new Error(msg);
  }
  return data;
}

export async function friendsDeleteContact({ peerAccountDigest } = {}) {
  const digest = getAccountDigest();
  if (!digest) throw new Error('Not unlocked: account missing');
  const payload = withAccount({ peerAccountDigest });
  const { r, data } = await fetchJSON('/api/v1/friends/delete', payload);
  if (!r.ok) {
    const msg = formatErrorMessage(data, 'delete contact failed', r.status);
    throw new Error(msg);
  }
  log({ friendsDeleteResult: data, payloadPeerDigest: peerAccountDigest });
  return data;
}

export async function friendsShareContactUpdate({ inviteId, secret, peerAccountDigest, envelope, conversationId, conversationFingerprint } = {}) {
  if (!getAccountDigest()) throw new Error('Not unlocked: account missing');
  if (!inviteId || !secret || !envelope?.iv || !envelope?.ct) {
    throw new Error('invalid envelope payload');
  }
  const payload = withAccount({ inviteId, secret, envelope, peerAccountDigest });
  if (conversationId) payload.conversationId = conversationId;
  if (conversationFingerprint) payload.conversationFingerprint = conversationFingerprint;
  try {
    // eslint-disable-next-line no-console
    console.log('[contact-share-request]', { inviteId });
  } catch {}
  const { r, data } = await fetchJSON('/api/v1/friends/contact/share', payload);
  if (!r.ok) {
    try {
      // eslint-disable-next-line no-console
      console.log('[contact-share-error]', r.status, data);
    } catch {}
    const msg = formatErrorMessage(data, 'contact share failed', r.status);
    throw new Error(msg);
  }
  return data;
}

export function parseFriendInvite(input) {
  const parsed = decodeFriendInvite(input);
  if (!parsed) throw new Error('無法解析好友邀請內容');
  return parsed;
}

export async function friendsAcceptInviteFromInput(input) {
  const payload = parseFriendInvite(input);
  return friendsAcceptInvite(payload);
}

export async function friendsBootstrapSession({ peerAccountDigest, roleHint, inviteId } = {}) {
  const payload = withAccount({ peerAccountDigest });
  if (roleHint && typeof roleHint === 'string') {
    const lowered = roleHint.trim().toLowerCase();
    if (lowered === 'owner' || lowered === 'guest') payload.roleHint = lowered;
  }
  if (inviteId) payload.inviteId = inviteId;
  const { r, data } = await fetchJSON('/api/v1/friends/bootstrap-session', payload);
  if (!r.ok) {
    const msg = formatErrorMessage(data, 'bootstrap session failed', r.status);
    throw new Error(msg);
  }
  const record = data && typeof data === 'object' ? data : {};
  const pick = (primary, fallback) => (primary !== undefined ? primary : fallback);
  const result = {
    role: typeof record.role === 'string' ? record.role : null,
    inviteId: pick(record.inviteId, record.invite_id) || null,
    ownerUid: pick(record.ownerUid, record.owner_uid) || null,
    guestUid: pick(record.guestUid, record.guest_uid) || null,
    ownerAccountDigest: record.ownerAccountDigest || record.owner_account_digest || null,
    guestAccountDigest: record.guestAccountDigest || record.guest_account_digest || null,
    guestBundle: pick(record.guestBundle, record.guest_bundle) || null,
    guestContact: pick(record.guestContact, record.guest_contact) || null,
    ownerContact: pick(record.ownerContact, record.owner_contact) || null,
    guestContactTs: pick(record.guestContactTs, record.guest_contact_ts) || null,
    ownerContactTs: pick(record.ownerContactTs, record.owner_contact_ts) || null,
    usedAt: pick(record.usedAt, record.used_at) || null,
    createdAt: pick(record.createdAt, record.created_at) || null
  };
  log({
    friendBootstrapSession: {
      peerAccountDigest: payload.peerAccountDigest || null,
      role: result.role,
      hasGuestBundle: !!result.guestBundle
    }
  });
  return result;
}

async function postInvite(path, payload) {
  log({ inviteFetchStart: path, payload });
  const { r, data } = await fetchJSON(path, payload);
  log({ inviteFetchDone: path, status: r.status, data });
  if (r.ok) return data;

  const msg = formatErrorMessage(data, 'invite failed', r.status);
  throw new Error(msg);
}

function formatErrorMessage(data, fallback, status) {
  const fallbackMsg = status ? `${fallback} (HTTP ${status})` : fallback;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return fallbackMsg;
    if (/^<!doctype/i.test(trimmed) || /^<html/i.test(trimmed)) return fallbackMsg;
    return trimmed;
  }
  if (data && typeof data === 'object') {
    return data.details || data.message || data.error || fallbackMsg;
  }
  return fallbackMsg;
}
