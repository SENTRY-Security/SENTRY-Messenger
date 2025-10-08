// Friend invite helpers: encode to URI string and decode from string/object.

/**
 * Encode invite information into a `sentry://invite` URI.
 * @param {{ inviteId: string, secret: string }} invite
 * @returns {string}
 */
export function encodeFriendInvite(invite = {}) {
  const id = String(invite.inviteId || '').trim();
  const secret = String(invite.secret || '').trim();
  if (!id || !secret) return '';
  const payload = { inviteId: id, secret };
  if (invite.ownerUid) payload.ownerUid = String(invite.ownerUid || '').trim();
  if (invite.prekeyBundle) payload.prekeyBundle = invite.prekeyBundle;
  if (invite.expiresAt) payload.expiresAt = Number(invite.expiresAt);
  try {
    const json = JSON.stringify(payload);
    return base64UrlEncode(json);
  } catch {
    return `sentry://invite?id=${encodeURIComponent(id)}&secret=${encodeURIComponent(secret)}`;
  }
}

/**
 * Try to decode an invite string/URI/JSON blob back into invite fields.
 * Returns null if parsing fails or required fields missing.
 * @param {string | URL | { inviteId?: string, secret?: string }} input
 * @returns {{ inviteId: string, secret: string } | null}
 */
export function decodeFriendInvite(input) {
  if (!input && input !== '') return null;

  if (typeof input === 'object' && !(input instanceof URL)) {
    const inviteId = String(input.inviteId || input.id || '').trim();
    const secret = String(input.secret || input.sig || '').trim();
    if (!inviteId || !secret) return null;
    const result = { inviteId, secret };
    if (input.ownerUid || input.owner_uid) {
      result.ownerUid = String(input.ownerUid || input.owner_uid || '').trim();
    }
    if (input.prekeyBundle || input.prekey_bundle) {
      result.prekeyBundle = input.prekeyBundle || input.prekey_bundle;
    }
    if (input.expiresAt || input.expires_at) {
      const ts = Number(input.expiresAt ?? input.expires_at);
      if (Number.isFinite(ts)) result.expiresAt = ts;
    }
    return result;
  }

  let raw = '';
  if (input instanceof URL) {
    raw = input.toString();
  } else {
    raw = String(input || '').trim();
  }
  if (!raw) return null;

  const compact = decodeCompact(raw);
  if (compact) return compact;

  // Attempt JSON first.
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const obj = JSON.parse(raw);
      return decodeFriendInvite(obj);
    } catch {/* ignore */}
  }

  // Try base64-encoded JSON (URL-safe allowed)
  try {
    const normalized = raw.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/'));
    if (/^[A-Za-z0-9+/=]+$/.test(normalized)) {
      const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
      if (!padded || padded.length % 4 !== 0) throw new Error('invalid b64 padding');
      const json = decodeBase64(padded);
      const parsed = JSON.parse(json);
      const res = decodeFriendInvite(parsed);
      if (res) return res;
    }
  } catch {/* ignore */}

  // Finally, parse as URI / URL-like string.
  const parsedUrl = tryParseUrl(raw);
  if (!parsedUrl) return null;

  const inviteId = parsedUrl.searchParams.get('inviteId') || parsedUrl.searchParams.get('id') || '';
  const secret = parsedUrl.searchParams.get('secret') || parsedUrl.searchParams.get('sig') || '';
  if (inviteId && secret) {
    const result = { inviteId, secret };
    const ownerUid = parsedUrl.searchParams.get('ownerUid') || parsedUrl.searchParams.get('owner_uid') || '';
    if (ownerUid) result.ownerUid = ownerUid.trim();
    return result;
  }

  return null;
}

function tryParseUrl(raw) {
  try {
    if (/^[a-z][a-z0-9+.-]*:/.test(raw)) return new URL(raw);
    return new URL(raw, 'https://dummy.invalid');
  } catch {
    return null;
  }
}

function decodeCompact(str) {
  if (!str || str.length < 2) return null;
  if (str[0] !== 'F') return null;
  const payload = str.slice(1);
  if (payload.length < 48) return null;
  const inviteId = payload.slice(0, 16);
  const secret = payload.slice(16, 16 + 32);
  if (inviteId.length !== 16 || secret.length !== 32) return null;
  return { inviteId, secret };
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
