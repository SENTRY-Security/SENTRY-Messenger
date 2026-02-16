import { fetchJSON, fetchWithTimeout } from '../core/http.js';
import { buildAccountPayload, ensureDeviceId } from '../core/store.js';

function normalizeDigest(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned.length === 64 ? cleaned : null;
}

function buildPayload(overrides = {}) {
  const payload = buildAccountPayload({ includeUid: false, overrides });
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === null) delete payload[key];
  }
  return payload;
}

function buildHeaders() {
  const auth = buildAccountPayload({ includeUid: false });
  const headers = {};
  if (auth.account_token) headers['X-Account-Token'] = auth.account_token;
  if (auth.account_digest) headers['X-Account-Digest'] = auth.account_digest;
  try {
    const deviceId = ensureDeviceId();
    if (deviceId) headers['X-Device-Id'] = deviceId;
  } catch {
    // allow backend to reject if missing
  }
  return headers;
}

function formatErrorMessage(data, fallback, status) {
  const prefix = status ? `${fallback} (HTTP ${status})` : fallback;
  if (data == null) return prefix;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return prefix;
    if (/^<!doctype/i.test(trimmed) || /^<html/i.test(trimmed)) return prefix;
    return trimmed;
  }
  if (typeof data === 'object') {
    return data.message || data.error || data.details || prefix;
  }
  return prefix;
}

async function postJSON(path, payload, fallbackMessage) {
  const headers = buildHeaders();
  const { r, data } = await fetchJSON(path, payload, headers);
  if (!r.ok) {
    throw new Error(formatErrorMessage(data, fallbackMessage, r.status));
  }
  return data;
}

export async function createCallInvite({
  peerAccountDigest,
  mode = 'voice',
  capabilities,
  metadata,
  expiresInSeconds,
  traceId,
  preferredDeviceId
} = {}) {
  const digest = normalizeDigest(peerAccountDigest);
  if (!digest) throw new Error('peerAccountDigest required');
  const overrides = {
    peer_account_digest: digest,
    mode,
    capabilities,
    metadata,
    expires_in_seconds: expiresInSeconds,
    trace_id: traceId,
    preferred_device_id: preferredDeviceId
  };
  const payload = buildPayload(overrides);
  return postJSON('/api/v1/calls/invite', payload, 'call invite failed');
}

export async function cancelCall({ callId, reason } = {}) {
  if (!callId) throw new Error('callId required');
  const payload = buildPayload({ call_id: callId, reason });
  return postJSON('/api/v1/calls/cancel', payload, 'call cancel failed');
}

export async function acknowledgeCall({ callId, traceId } = {}) {
  if (!callId) throw new Error('callId required');
  const payload = buildPayload({ call_id: callId, trace_id: traceId });
  return postJSON('/api/v1/calls/ack', payload, 'call ack failed');
}

export async function reportCallMetrics({ callId, metrics, status, endReason, ended } = {}) {
  if (!callId) throw new Error('callId required');
  const payload = buildPayload({ call_id: callId, metrics, status, end_reason: endReason, ended });
  return postJSON('/api/v1/calls/report-metrics', payload, 'call metrics failed');
}

export async function fetchCallSession({ callId } = {}) {
  if (!callId) throw new Error('callId required');
  const url = `/api/v1/calls/${encodeURIComponent(callId)}`;
  const headers = buildHeaders();
  const r = await fetchWithTimeout(url, { method: 'GET', headers }, 15000);
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!r.ok) {
    throw new Error(formatErrorMessage(data, 'call session fetch failed', r.status));
  }
  return data;
}

export async function issueTurnCredentials({ ttlSeconds } = {}) {
  const payload = buildPayload({ ttl_seconds: ttlSeconds });
  return postJSON('/api/v1/calls/turn-credentials', payload, 'turn credentials failed');
}
