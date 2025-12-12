import { fetchJSON } from '../core/http.js';
import { log } from '../core/log.js';
import { decodeFriendInvite } from '../lib/invite.js';
import { getAccountToken, getAccountDigest, ensureDeviceId } from '../core/store.js';

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

function withDeviceHeaders() {
  const deviceId = ensureDeviceId();
  return deviceId ? { 'x-device-id': deviceId } : {};
}

export async function friendsCreateInvite({ ttlSeconds, prekeyBundle, deviceId, tokenHash, inviteToken } = {}) {
  const payload = withAccount({});
  if (ttlSeconds) payload.ttlSeconds = ttlSeconds;
  if (deviceId) payload.deviceId = deviceId;
  if (prekeyBundle) payload.prekeyBundle = prekeyBundle;
  if (tokenHash) payload.tokenHash = tokenHash;
  if (inviteToken) payload.inviteToken = inviteToken;
  const res = await postInvite('/api/v1/friends/invite', payload);
  log({ inviteAPIResult: res });
  return res;
}

export async function friendsAcceptInvite({ inviteId, inviteToken, guestBundle } = {}) {
  const payload = withAccount({ inviteId, inviteToken });
  if (guestBundle) payload.guestBundle = guestBundle;
  const { r, data } = await fetchJSON('/api/v1/friends/accept', payload, withDeviceHeaders());
  if (!r.ok) {
    const msg = formatErrorMessage(data, 'accept failed', r.status);
    throw new Error(msg);
  }
  return data;
}

export async function friendsDeleteContact({ peerAccountDigest } = {}) {
  const digest = getAccountDigest();
  if (!digest) throw new Error('Not unlocked: account missing');
  const payload = withAccount({ peerAccountDigest });
  const { r, data } = await fetchJSON('/api/v1/friends/delete', payload, withDeviceHeaders());
  if (!r.ok) {
    const msg = formatErrorMessage(data, 'delete contact failed', r.status);
    throw new Error(msg);
  }
  log({ friendsDeleteResult: data, payloadPeerDigest: peerAccountDigest });
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

async function postInvite(path, payload) {
  log({ inviteFetchStart: path, payload });
  const { r, data } = await fetchJSON(path, payload, withDeviceHeaders());
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
