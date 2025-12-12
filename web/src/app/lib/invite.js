// Friend invite helpers: encode/decode strict v2 payloads (no legacy fallback).

export function encodeFriendInvite(invite = {}) {
  const inviteId = String(invite.inviteId || '').trim();
  const secret = String(invite.secret || '').trim();
  if (!inviteId || !secret) return '';
  const payload = {
    inviteId,
    secret,
    version: 2
  };
  if (invite.ownerAccountDigest) {
    payload.ownerAccountDigest = String(invite.ownerAccountDigest || '').trim();
  }
  if (invite.ownerDeviceId) {
    payload.ownerDeviceId = String(invite.ownerDeviceId || '').trim();
  }
  if (invite.code) payload.code = String(invite.code || '').trim();
  if (invite.prekeyBundle) payload.prekeyBundle = invite.prekeyBundle;
  if (invite.expiresAt) payload.expiresAt = Number(invite.expiresAt);
  const json = JSON.stringify(payload);
  return base64UrlEncode(json);
}

export function decodeFriendInvite(input) {
  if (!input && input !== '') return null;

  const normalize = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const inviteId = String(obj.inviteId || obj.id || '').trim();
    const secret = String(obj.secret || '').trim();
    if (!inviteId || !secret) return null;
    const versionVal = Number.isFinite(Number(obj.version)) ? Number(obj.version) : 2;
    if (versionVal !== 2) return null;
    const result = { inviteId, secret, version: versionVal };
    if (obj.ownerAccountDigest) {
      const owner = String(obj.ownerAccountDigest || '').trim();
      if (owner) result.ownerAccountDigest = owner;
    }
    if (obj.ownerDeviceId) {
      const dev = String(obj.ownerDeviceId || '').trim();
      if (dev) result.ownerDeviceId = dev;
    }
    if (obj.prekeyBundle) result.prekeyBundle = obj.prekeyBundle;
    if (obj.expiresAt) {
      const ts = Number(obj.expiresAt);
      if (Number.isFinite(ts)) result.expiresAt = ts;
    }
    if (obj.code) {
      result.code = String(obj.code || '').trim();
    }
    return result;
  };

  if (typeof input === 'object') {
    return normalize(input);
  }

  const raw = String(input || '').trim();
  if (!raw) return null;

  const parseJson = (str) => {
    try {
      const obj = JSON.parse(str);
      return normalize(obj);
    } catch {
      return null;
    }
  };

  if (raw.startsWith('{')) {
    const parsed = parseJson(raw);
    if (parsed) return parsed;
  }

  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const json = decodeBase64(padded);
    const parsed = parseJson(json);
    if (parsed) return parsed;
  } catch {
    /* ignore */
  }

  return null;
}

function decodeBase64(str) {
  if (typeof globalThis?.atob === 'function') {
    return globalThis.atob(str);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'base64').toString('binary');
  }
  throw new Error('base64 decode not supported in this environment');
}

function base64UrlEncode(str) {
  let b64;
  if (typeof globalThis?.btoa === 'function') {
    b64 = globalThis.btoa(str);
  } else if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(str, 'utf8').toString('base64');
  } else {
    throw new Error('base64 encode not supported');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
