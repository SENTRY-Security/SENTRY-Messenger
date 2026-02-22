import { fetchJSON } from '../core/http.js';
import { log } from '../core/log.js';
import { getAccountToken, getAccountDigest, ensureDeviceId } from '../core/store.js';

const AccountDigestRegex = /^[0-9A-F]{64}$/;

function withAccountToken(payload = {}) {
  const out = { ...payload };
  if (out.account_token == null) {
    const token = getAccountToken();
    if (token) out.account_token = token;
  }
  if (!out.account_token) {
    throw new Error('Not unlocked: account token missing');
  }
  if (out.account_digest == null) {
    const digest = getAccountDigest();
    if (digest) out.account_digest = digest;
  }
  if (out.account_digest != null) {
    const cleanedDigest = String(out.account_digest).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (cleanedDigest && AccountDigestRegex.test(cleanedDigest)) out.account_digest = cleanedDigest;
    else delete out.account_digest;
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

export async function invitesCreate({ ownerPublicKeyB64, wantPairingCode } = {}) {
  const payload = withAccountToken({});
  if (ownerPublicKeyB64) payload.owner_public_key_b64 = ownerPublicKeyB64;
  if (wantPairingCode) payload.want_pairing_code = true;
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
  const payload = withAccountToken({ invite_id: inviteId, ciphertext_envelope: ciphertextEnvelope });
  const { r, data } = await fetchJSON('/api/v1/invites/deliver', payload, withDeviceHeaders());
  if (!r.ok) {
    throw buildError(r.status, data, 'invite deliver failed');
  }
  return data;
}

export async function invitesConsume({ inviteId } = {}) {
  if (!inviteId) throw new Error('inviteId required');
  const payload = withAccountToken({ invite_id: inviteId });
  const { r, data } = await fetchJSON('/api/v1/invites/consume', payload, withDeviceHeaders());
  if (!r.ok) {
    throw buildError(r.status, data, 'invite consume failed');
  }
  return data;
}

export async function invitesConfirm({ inviteId } = {}) {
  if (!inviteId) throw new Error('inviteId required');
  const payload = withAccountToken({ invite_id: inviteId });
  const { r, data } = await fetchJSON('/api/v1/invites/confirm', payload, withDeviceHeaders());
  if (!r.ok) throw buildError(r.status, data, 'invite confirm failed');
  return data;
}

export async function invitesUnconfirmed() {
  const payload = withAccountToken({});
  const { r, data } = await fetchJSON('/api/v1/invites/unconfirmed', payload, withDeviceHeaders());
  if (!r.ok) throw buildError(r.status, data, 'invite unconfirmed query failed');
  return data;
}

export async function invitesStatus({ inviteId } = {}) {
  if (!inviteId) throw new Error('inviteId required');
  const payload = withAccountToken({ invite_id: inviteId });
  const { r, data } = await fetchJSON('/api/v1/invites/status', payload, withDeviceHeaders());
  if (!r.ok) {
    throw buildError(r.status, data, 'invite status failed');
  }
  return data;
}

export async function invitesLookupCode({ pairingCode } = {}) {
  if (!pairingCode || !/^\d{6}$/.test(pairingCode)) throw new Error('pairingCode must be 6 digits');
  const payload = withAccountToken({ pairing_code: pairingCode });
  const { r, data } = await fetchJSON('/api/v1/invites/lookup-code', payload, withDeviceHeaders());
  if (!r.ok) {
    throw buildError(r.status, data, 'pairing code lookup failed');
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
