// /app/api/ephemeral.js
// API wrappers for ephemeral chat link endpoints.

import { fetchJSON } from '../core/http.js';
import { getAccountToken, getAccountDigest, ensureDeviceId } from '../core/store.js';

function withAuth(payload = {}) {
  const token = getAccountToken();
  const digest = getAccountDigest();
  if (token) payload.account_token = token;
  if (digest) payload.account_digest = String(digest).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return payload;
}

function deviceHeaders() {
  const deviceId = ensureDeviceId();
  return deviceId ? { 'x-device-id': deviceId } : {};
}

/** Owner creates a one-time ephemeral chat link. */
export async function ephemeralCreateLink({ prekeyBundle } = {}) {
  const payload = withAuth({});
  if (prekeyBundle) payload.prekey_bundle = prekeyBundle;
  const { r, data } = await fetchJSON('/api/v1/ephemeral/create-link', payload, deviceHeaders());
  if (!r.ok) throw Object.assign(new Error(data?.message || 'create-link failed'), { status: r.status, data });
  return data;
}

/** Guest consumes a one-time link token. No auth needed. */
export async function ephemeralConsume({ token } = {}) {
  if (!token) throw new Error('token required');
  const { r, data } = await fetchJSON('/api/v1/ephemeral/consume', { token });
  if (!r.ok) throw Object.assign(new Error(data?.message || 'consume failed'), { status: r.status, data });
  return data;
}

/** Either party extends the session timer. */
export async function ephemeralExtend({ sessionId, guestDigest } = {}) {
  if (!sessionId) throw new Error('sessionId required');
  const payload = { session_id: sessionId };
  // If calling from owner side, add auth
  try {
    const token = getAccountToken();
    const digest = getAccountDigest();
    if (token) payload.account_token = token;
    if (digest) payload.account_digest = String(digest).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  } catch { /* guest has no account token */ }
  if (guestDigest) payload.guest_digest = guestDigest;
  const { r, data } = await fetchJSON('/api/v1/ephemeral/extend', payload);
  if (!r.ok) throw Object.assign(new Error(data?.message || 'extend failed'), { status: r.status, data });
  return data;
}

/** Owner deletes an ephemeral session. */
export async function ephemeralDelete({ sessionId } = {}) {
  if (!sessionId) throw new Error('sessionId required');
  const payload = withAuth({ session_id: sessionId });
  const { r, data } = await fetchJSON('/api/v1/ephemeral/delete', payload, deviceHeaders());
  if (!r.ok) throw Object.assign(new Error(data?.message || 'delete failed'), { status: r.status, data });
  return data;
}

/** Owner revokes an unconsumed invite link. */
export async function ephemeralRevokeInvite({ token } = {}) {
  if (!token) throw new Error('token required');
  const payload = withAuth({ token });
  const { r, data } = await fetchJSON('/api/v1/ephemeral/revoke-invite', payload, deviceHeaders());
  if (!r.ok) throw Object.assign(new Error(data?.message || 'revoke-invite failed'), { status: r.status, data });
  return data;
}

/** Owner lists active ephemeral sessions. */
export async function ephemeralList() {
  const payload = withAuth({});
  const { r, data } = await fetchJSON('/api/v1/ephemeral/list', payload, deviceHeaders());
  if (!r.ok) throw Object.assign(new Error(data?.message || 'list failed'), { status: r.status, data });
  return data;
}

/** Get session info (for guest reconnect). */
export async function ephemeralSessionInfo({ sessionId } = {}) {
  if (!sessionId) throw new Error('sessionId required');
  const { r, data } = await fetchJSON('/api/v1/ephemeral/session-info', { session_id: sessionId });
  if (!r.ok) throw Object.assign(new Error(data?.message || 'session-info failed'), { status: r.status, data });
  return data;
}

/** Guest requests a fresh WS token. */
export async function ephemeralWsToken({ sessionId, guestDigest } = {}) {
  if (!sessionId || !guestDigest) throw new Error('sessionId and guestDigest required');
  const { r, data } = await fetchJSON('/api/v1/ephemeral/ws-token', { session_id: sessionId, guest_digest: guestDigest });
  if (!r.ok) throw Object.assign(new Error(data?.message || 'ws-token failed'), { status: r.status, data });
  return data;
}
