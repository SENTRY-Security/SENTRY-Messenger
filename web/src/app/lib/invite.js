// Friend invite helpers: encode/decode single-protocol payloads only.

const INVITE_QR_VERSION = 3;
const INVITE_QR_TYPE = 'invite_dropbox';
const INVITE_ALLOWED_KEYS = new Set([
  'v',
  'type',
  'inviteId',
  'ownerAccountDigest',
  'ownerDeviceId',
  'ownerPublicKeyB64',
  'expiresAt',
  'prekeyBundle'
]);
const BUNDLE_ALLOWED_KEYS = new Set([
  'ikPubB64',
  'spkPubB64',
  'signatureB64',
  'opkId',
  'opkPubB64'
]);

function schemaError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function requireNonEmptyString(value, code, fieldName) {
  if (typeof value !== 'string') throw schemaError(code, `${fieldName} required`);
  const trimmed = value.trim();
  if (!trimmed) throw schemaError(code, `${fieldName} required`);
  return trimmed;
}

function requirePositiveNumber(value, code, fieldName) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) throw schemaError(code, `${fieldName} required`);
  return num;
}

function assertNoExtraKeys(obj, allowedKeys, code) {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw schemaError(code, `unexpected field: ${key}`);
    }
  }
}

function normalizeOwnerBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw schemaError('InviteQrBundleInvalid', 'prekeyBundle required');
  }
  assertNoExtraKeys(bundle, BUNDLE_ALLOWED_KEYS, 'InviteQrBundleInvalid');
  const ikPubB64 = requireNonEmptyString(bundle.ikPubB64, 'InviteQrBundleInvalid', 'ikPubB64');
  const spkPubB64 = requireNonEmptyString(bundle.spkPubB64, 'InviteQrBundleInvalid', 'spkPubB64');
  const signatureB64 = requireNonEmptyString(bundle.signatureB64, 'InviteQrBundleInvalid', 'signatureB64');
  const opkIdRaw = bundle.opkId;
  if (opkIdRaw === null || opkIdRaw === undefined || opkIdRaw === '') {
    throw schemaError('InviteQrBundleInvalid', 'opkId required');
  }
  const opkId = Number(opkIdRaw);
  if (!Number.isFinite(opkId) || opkId < 0) {
    throw schemaError('InviteQrBundleInvalid', 'opkId invalid');
  }
  const opkPubB64 = requireNonEmptyString(bundle.opkPubB64, 'InviteQrBundleInvalid', 'opkPubB64');
  return {
    ikPubB64,
    spkPubB64,
    signatureB64,
    opkId,
    opkPubB64
  };
}

export function encodeFriendInvite(invite = {}) {
  const inviteId = requireNonEmptyString(invite.inviteId, 'InviteQrInvalid', 'inviteId');
  const ownerAccountDigestRaw = requireNonEmptyString(invite.ownerAccountDigest, 'InviteQrInvalid', 'ownerAccountDigest');
  const ownerAccountDigest = ownerAccountDigestRaw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(ownerAccountDigest)) {
    throw schemaError('InviteQrInvalid', 'ownerAccountDigest invalid');
  }
  const ownerDeviceId = requireNonEmptyString(invite.ownerDeviceId, 'InviteQrInvalid', 'ownerDeviceId');
  const ownerPublicKeyB64 = requireNonEmptyString(invite.ownerPublicKeyB64, 'InviteQrInvalid', 'ownerPublicKeyB64');
  const expiresAt = requirePositiveNumber(invite.expiresAt, 'InviteQrInvalid', 'expiresAt');
  if (expiresAt > 1_000_000_000_000) {
    throw schemaError('InviteQrInvalid', 'expiresAt must be unix seconds');
  }
  const prekeyBundle = normalizeOwnerBundle(invite.prekeyBundle);
  const payload = {
    v: INVITE_QR_VERSION,
    type: INVITE_QR_TYPE,
    inviteId,
    ownerAccountDigest,
    ownerDeviceId,
    ownerPublicKeyB64,
    expiresAt,
    prekeyBundle
  };
  return base64UrlEncode(JSON.stringify(payload));
}

export function decodeFriendInvite(input) {
  if (!input && input !== '') throw schemaError('InviteQrMissing', 'invite payload required');

  let obj = null;
  if (typeof input === 'object') {
    obj = input;
  } else {
    const raw = String(input || '').trim();
    if (!raw) throw schemaError('InviteQrMissing', 'invite payload required');
    try {
      const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
      const json = decodeBase64(padded);
      obj = JSON.parse(json);
    } catch (err) {
      throw schemaError('InviteQrDecodeFailed', 'invite payload decode failed');
    }
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw schemaError('InviteQrInvalid', 'invite payload invalid');
  }
  assertNoExtraKeys(obj, INVITE_ALLOWED_KEYS, 'InviteQrInvalid');
  const v = Number(obj.v ?? 0);
  if (!Number.isFinite(v) || v !== INVITE_QR_VERSION) {
    throw schemaError('InviteQrVersionMismatch', 'invite version mismatch');
  }
  const type = requireNonEmptyString(obj.type, 'InviteQrInvalid', 'type');
  if (type !== INVITE_QR_TYPE) {
    throw schemaError('InviteQrTypeMismatch', 'invite type mismatch');
  }
  const inviteId = requireNonEmptyString(obj.inviteId, 'InviteQrInvalid', 'inviteId');
  const ownerAccountDigestRaw = requireNonEmptyString(obj.ownerAccountDigest, 'InviteQrInvalid', 'ownerAccountDigest');
  const ownerAccountDigest = ownerAccountDigestRaw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(ownerAccountDigest)) {
    throw schemaError('InviteQrInvalid', 'ownerAccountDigest invalid');
  }
  const ownerDeviceId = requireNonEmptyString(obj.ownerDeviceId, 'InviteQrInvalid', 'ownerDeviceId');
  const ownerPublicKeyB64 = requireNonEmptyString(obj.ownerPublicKeyB64, 'InviteQrInvalid', 'ownerPublicKeyB64');
  const expiresAt = requirePositiveNumber(obj.expiresAt, 'InviteQrInvalid', 'expiresAt');
  if (expiresAt > 1_000_000_000_000) {
    throw schemaError('InviteQrInvalid', 'expiresAt must be unix seconds');
  }
  const prekeyBundle = normalizeOwnerBundle(obj.prekeyBundle);

  return {
    v: INVITE_QR_VERSION,
    type,
    inviteId,
    ownerAccountDigest,
    ownerDeviceId,
    ownerPublicKeyB64,
    expiresAt,
    prekeyBundle
  };
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
