import { fetchJSON } from '../core/http.js';
import { log } from '../core/log.js';
import { decodeFriendInvite } from '../lib/invite.js';
import { getUidHex, getAccountToken, getAccountDigest } from '../core/store.js';

function withAccount(payload = {}, { includeUid = true } = {}) {
  const out = { ...payload };
  if (includeUid && out.uidHex == null) {
    const uid = getUidHex();
    if (uid) out.uidHex = uid;
  }
  if (out.uidHex != null) {
    const cleanedUid = String(out.uidHex).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (cleanedUid) out.uidHex = cleanedUid; else delete out.uidHex;
  }
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

export async function friendsCreateInvite({ uidHex, ttlSeconds, prekeyBundle } = {}) {
  const payload = withAccount({ uidHex });
  if (ttlSeconds) payload.ttlSeconds = ttlSeconds;
  if (prekeyBundle) payload.prekeyBundle = prekeyBundle;
  const res = await postInvite('/api/v1/friends/invite', payload, true);
  log({ inviteAPIResult: res });
  return res;
}

export async function friendsAcceptInvite({ inviteId, secret, contactEnvelope, guestBundle, ownerUid } = {}) {
  const myUid = getUidHex();
  const payload = withAccount({ inviteId, secret });
  if (myUid) payload.myUid = myUid;
  if (contactEnvelope && contactEnvelope.iv && contactEnvelope.ct) {
    payload.contactEnvelope = contactEnvelope;
  }
  if (guestBundle) payload.guestBundle = guestBundle;
  if (ownerUid) payload.ownerUid = ownerUid;
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

export async function friendsDeleteContact({ peerUid } = {}) {
  const uidHex = getUidHex();
  if (!uidHex) throw new Error('Not unlocked: UID missing');
  const payload = withAccount({ uidHex, peerUid });
  const { r, data } = await fetchJSON('/api/v1/friends/delete', payload);
  if (!r.ok) {
    const msg = formatErrorMessage(data, 'delete contact failed', r.status);
    throw new Error(msg);
  }
  log({ friendsDeleteResult: data, payloadPeer: peerUid });
  return data;
}

export async function friendsShareContactUpdate({ inviteId, secret, peerUid, envelope, conversationId, conversationFingerprint } = {}) {
  const myUid = getUidHex();
  if (!myUid) throw new Error('Not unlocked: UID missing');
  if (!inviteId || !secret || !envelope?.iv || !envelope?.ct) {
    throw new Error('invalid envelope payload');
  }
  const payload = withAccount({ inviteId, secret, myUid, envelope });
  if (peerUid) payload.peerUid = peerUid;
  if (conversationId) payload.conversationId = conversationId;
  if (conversationFingerprint) payload.conversationFingerprint = conversationFingerprint;
  try {
    // eslint-disable-next-line no-console
    console.log('[contact-share-request]', { inviteId, myUid, peerUid: peerUid || null });
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

async function postInvite(path, payload, allowFallback) {
  log({ inviteFetchStart: path, payload });
  const { r, data } = await fetchJSON(path, payload);
  log({ inviteFetchDone: path, status: r.status, data });
  if (r.ok) return data;

  if (allowFallback && r.status === 404 && path !== '/api/friends/invite') {
    return postInvite('/api/friends/invite', payload, false);
  }

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
