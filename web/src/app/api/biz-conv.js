/**
 * Business Conversation API Wrappers
 *
 * All endpoints require account authentication via token/digest.
 */

import { fetchJSON } from '../core/http.js';
import { fetchWithTimeout } from '../core/http.js';
import { getAccountToken, getAccountDigest, ensureDeviceId } from '../core/store.js';

function withAccount(payload = {}) {
  const out = { ...payload };
  if (out.account_token == null) {
    const token = getAccountToken();
    if (token) out.account_token = token;
  }
  if (out.account_digest == null) {
    const digest = getAccountDigest();
    if (digest) out.account_digest = digest;
  }
  if (out.account_digest != null) {
    const cleanedDigest = String(out.account_digest).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (cleanedDigest) out.account_digest = cleanedDigest; else delete out.account_digest;
  }
  return out;
}

function authHeaders() {
  const h = {};
  const deviceId = ensureDeviceId();
  if (deviceId) h['x-device-id'] = deviceId;
  const token = getAccountToken();
  if (token) h['x-account-token'] = token;
  const digest = getAccountDigest();
  if (digest) h['x-account-digest'] = digest;
  return h;
}

function formatError(data, fallback, status) {
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

async function getJSON(url, timeout = 15000) {
  const r = await fetchWithTimeout(url, { method: 'GET', headers: authHeaders() }, timeout);
  let data;
  try { data = await r.json(); } catch { data = null; }
  return { r, data };
}

async function putJSON(url, bodyObj, timeout = 15000) {
  const r = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(bodyObj)
  }, timeout);
  let data;
  try { data = await r.json(); } catch { data = null; }
  return { r, data };
}

// ── CRUD ─────────────────────────────────────────────────────────

export async function bizConvCreate({ conversationId, encryptedMetaBlob, encryptedPolicyBlob, members = [] }) {
  const payload = withAccount({
    conversation_id: conversationId,
    encrypted_meta_blob: encryptedMetaBlob,
    encrypted_policy_blob: encryptedPolicyBlob,
    members
  });
  const { r, data } = await fetchJSON('/api/v1/biz-conv/create', payload);
  if (!r.ok) throw new Error(formatError(data, 'create failed', r.status));
  return data;
}

export async function bizConvGet(conversationId) {
  const { r, data } = await getJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}`);
  if (!r.ok) throw new Error(formatError(data, 'get failed', r.status));
  return data;
}

export async function bizConvUpdateMeta(conversationId, encryptedMetaBlob) {
  const payload = withAccount({
    encrypted_meta_blob: encryptedMetaBlob
  });
  const { r, data } = await putJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/meta`, payload);
  if (!r.ok) throw new Error(formatError(data, 'update meta failed', r.status));
  return data;
}

export async function bizConvUpdatePolicy(conversationId, encryptedPolicyBlob) {
  const payload = withAccount({
    encrypted_policy_blob: encryptedPolicyBlob
  });
  const { r, data } = await putJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/policy`, payload);
  if (!r.ok) throw new Error(formatError(data, 'update policy failed', r.status));
  return data;
}

export async function bizConvDissolve(conversationId) {
  const payload = withAccount({});
  const { r, data } = await fetchJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/dissolve`, payload);
  if (!r.ok) throw new Error(formatError(data, 'dissolve failed', r.status));
  return data;
}

// ── Member Management ────────────────────────────────────────────

export async function bizConvInvite(conversationId, inviteeAccountDigest) {
  const payload = withAccount({
    invitee_account_digest: inviteeAccountDigest
  });
  const { r, data } = await fetchJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/invite`, payload);
  if (!r.ok) throw new Error(formatError(data, 'invite failed', r.status));
  return data;
}

export async function bizConvRemove(conversationId, targetAccountDigest) {
  const payload = withAccount({
    target_account_digest: targetAccountDigest
  });
  const { r, data } = await fetchJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/remove`, payload);
  if (!r.ok) throw new Error(formatError(data, 'remove failed', r.status));
  return data;
}

export async function bizConvLeave(conversationId) {
  const payload = withAccount({});
  const { r, data } = await fetchJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/leave`, payload);
  if (!r.ok) throw new Error(formatError(data, 'leave failed', r.status));
  return data;
}

export async function bizConvTransfer(conversationId, newOwnerAccountDigest) {
  const payload = withAccount({
    new_owner_account_digest: newOwnerAccountDigest
  });
  const { r, data } = await fetchJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/transfer`, payload);
  if (!r.ok) throw new Error(formatError(data, 'transfer failed', r.status));
  return data;
}

export async function bizConvMembers(conversationId) {
  const { r, data } = await getJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/members`);
  if (!r.ok) throw new Error(formatError(data, 'get members failed', r.status));
  return data;
}

// ── Epoch Management ─────────────────────────────────────────────

export async function bizConvIncrementEpoch(conversationId) {
  const payload = withAccount({});
  const { r, data } = await fetchJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/epoch`, payload);
  if (!r.ok) throw new Error(formatError(data, 'epoch increment failed', r.status));
  return data;
}

export async function bizConvConfirmEpoch(conversationId, epoch) {
  const payload = withAccount({ epoch });
  const { r, data } = await fetchJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/epoch/confirm`, payload);
  if (!r.ok) throw new Error(formatError(data, 'epoch confirm failed', r.status));
  return data;
}

export async function bizConvGetEpoch(conversationId) {
  const { r, data } = await getJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/epoch`);
  if (!r.ok) throw new Error(formatError(data, 'get epoch failed', r.status));
  return data;
}

// ── Tombstones ───────────────────────────────────────────────────

export async function bizConvCreateTombstone(conversationId, tombstoneType, encryptedPayloadBlob) {
  const payload = withAccount({
    tombstone_type: tombstoneType,
    encrypted_payload_blob: encryptedPayloadBlob
  });
  const { r, data } = await fetchJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/tombstone`, payload);
  if (!r.ok) throw new Error(formatError(data, 'create tombstone failed', r.status));
  return data;
}

export async function bizConvGetTombstones(conversationId, { since = 0, limit = 50 } = {}) {
  const qs = `since=${since}&limit=${limit}`;
  const { r, data } = await getJSON(`/api/v1/biz-conv/${encodeURIComponent(conversationId)}/tombstones?${qs}`);
  if (!r.ok) throw new Error(formatError(data, 'get tombstones failed', r.status));
  return data;
}

// ── List ─────────────────────────────────────────────────────────

export async function bizConvList() {
  const { r, data } = await getJSON('/api/v1/biz-conv/list');
  if (!r.ok) throw new Error(formatError(data, 'list failed', r.status));
  return data;
}
