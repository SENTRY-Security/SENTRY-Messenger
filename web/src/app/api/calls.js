import { fetchJSON, fetchWithTimeout } from '../core/http.js';
import { buildAccountPayload } from '../core/store.js';

function normalizeUid(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned.length >= 14 ? cleaned : null;
}

function normalizeDigest(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned.length === 64 ? cleaned : null;
}

function buildPayload(overrides = {}, { includeUid = true } = {}) {
  const payload = buildAccountPayload({ includeUid, overrides });
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === null) delete payload[key];
  }
  return payload;
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
  const { r, data } = await fetchJSON(path, payload);
  if (!r.ok) {
    throw new Error(formatErrorMessage(data, fallbackMessage, r.status));
  }
  return data;
}

export async function createCallInvite({
  peerUid,
  peerAccountDigest,
  mode = 'voice',
  capabilities,
  metadata,
  expiresInSeconds,
  traceId
} = {}) {
  const normalizedPeer = normalizeUid(peerUid);
  if (!normalizedPeer) throw new Error('peerUid required');
  const overrides = {
    peerUid: normalizedPeer,
    mode,
    capabilities,
    metadata,
    expiresInSeconds,
    traceId
  };
  const digest = normalizeDigest(peerAccountDigest);
  if (digest) overrides.peerAccountDigest = digest;
  const payload = buildPayload(overrides);
  return postJSON('/api/v1/calls/invite', payload, 'call invite failed');
}

export async function cancelCall({ callId, reason } = {}) {
  if (!callId) throw new Error('callId required');
  const payload = buildPayload({ callId, reason });
  return postJSON('/api/v1/calls/cancel', payload, 'call cancel failed');
}

export async function acknowledgeCall({ callId, traceId } = {}) {
  if (!callId) throw new Error('callId required');
  const payload = buildPayload({ callId, traceId });
  return postJSON('/api/v1/calls/ack', payload, 'call ack failed');
}

export async function reportCallMetrics({ callId, metrics, status, endReason, ended } = {}) {
  if (!callId) throw new Error('callId required');
  const payload = buildPayload({ callId, metrics, status, endReason, ended });
  return postJSON('/api/v1/calls/report-metrics', payload, 'call metrics failed');
}

export async function fetchCallSession({ callId } = {}) {
  if (!callId) throw new Error('callId required');
  const auth = buildPayload({}, { includeUid: true });
  const params = new URLSearchParams();
  if (auth.uidHex) params.set('uidHex', auth.uidHex);
  if (auth.accountToken) params.set('accountToken', auth.accountToken);
  if (auth.accountDigest) params.set('accountDigest', auth.accountDigest);
  const qs = params.toString();
  const url = `/api/v1/calls/${encodeURIComponent(callId)}${qs ? `?${qs}` : ''}`;
  const r = await fetchWithTimeout(url, { method: 'GET' }, 15000);
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
  const payload = buildPayload({ ttlSeconds });
  return postJSON('/api/v1/calls/turn-credentials', payload, 'turn credentials failed');
}
