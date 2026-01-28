import { fetchJSON } from '../core/http.js';
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

export async function friendsDeleteContact({ peerAccountDigest } = {}) {
  const digest = getAccountDigest();
  if (!digest) throw new Error('Not unlocked: account missing');
  const payload = withAccount({ peerAccountDigest });
  const { r, data } = await fetchJSON('/api/v1/friends/delete', payload, withDeviceHeaders());
  if (!r.ok) {
    const msg = formatErrorMessage(data, 'delete contact failed', r.status);
    throw new Error(msg);
  }
  return data;
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
