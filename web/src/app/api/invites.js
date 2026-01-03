import { fetchJSON } from '../core/http.js';
import { log } from '../core/log.js';
import { getAccountToken, getAccountDigest, ensureDeviceId } from '../core/store.js';

const AccountDigestRegex = /^[0-9A-F]{64}$/;

function withAccountToken(payload = {}) {
  const out = { ...payload };
  if (out.accountToken == null) {
    const token = getAccountToken();
    if (token) out.accountToken = token;
  }
  if (!out.accountToken) {
    throw new Error('Not unlocked: account token missing');
  }
  if (out.accountDigest == null) {
    const digest = getAccountDigest();
    if (digest) out.accountDigest = digest;
  }
  if (out.accountDigest != null) {
    const cleanedDigest = String(out.accountDigest).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (cleanedDigest && AccountDigestRegex.test(cleanedDigest)) out.accountDigest = cleanedDigest;
    else delete out.accountDigest;
  }
  return out;
}

function withDeviceHeaders() {
  const deviceId = ensureDeviceId();
  return deviceId ? { 'x-device-id': deviceId } : {};
}

function buildError(status, data, defaultMsg) {
  const msg = formatErrorMessage(data, defaultMsg, status);
  const err = new Error(msg);
  err.status = status;
  err.data = data;
  return err;
}

export async function invitesCreate({ ownerPublicKeyB64 } = {}) {
  const payload = withAccountToken({});
  if (ownerPublicKeyB64) payload.ownerPublicKeyB64 = ownerPublicKeyB64;
  const { r, data } = await fetchJSON('/api/v1/invites/create', payload, withDeviceHeaders());
  log({ inviteCreateResult: data });
  if (!r.ok) {
    throw buildError(r.status, data, 'invite create failed');
  }
  return data;
}

export async function invitesDeliver({ inviteId, ciphertextEnvelope } = {}) {
  if (!inviteId) throw new Error('inviteId required');
  if (!ciphertextEnvelope || typeof ciphertextEnvelope !== 'object') {
    throw new Error('ciphertextEnvelope required');
  }
  const payload = withAccountToken({ inviteId, ciphertextEnvelope });
  const { r, data } = await fetchJSON('/api/v1/invites/deliver', payload, withDeviceHeaders());
  if (!r.ok) {
    throw buildError(r.status, data, 'invite deliver failed');
  }
  return data;
}

export async function invitesConsume({ inviteId } = {}) {
  if (!inviteId) throw new Error('inviteId required');
  const payload = withAccountToken({ inviteId });
  const { r, data } = await fetchJSON('/api/v1/invites/consume', payload, withDeviceHeaders());
  if (!r.ok) {
    throw buildError(r.status, data, 'invite consume failed');
  }
  return data;
}

export async function invitesStatus({ inviteId } = {}) {
  if (!inviteId) throw new Error('inviteId required');
  const payload = withAccountToken({ inviteId });
  const { r, data } = await fetchJSON('/api/v1/invites/status', payload, withDeviceHeaders());
  if (!r.ok) {
    throw buildError(r.status, data, 'invite status failed');
  }
  return data;
}

function formatErrorMessage(data, defaultMsg, status) {
  const defaultText = status ? `${defaultMsg} (HTTP ${status})` : defaultMsg;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return defaultText;
    if (/^<!doctype/i.test(trimmed) || /^<html/i.test(trimmed)) return defaultText;
    return trimmed;
  }
  if (data && typeof data === 'object') {
    return data.details || data.message || data.error || defaultText;
  }
  return defaultText;
}
