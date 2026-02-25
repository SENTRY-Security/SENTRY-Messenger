// Friend invite helpers: encode/decode compact binary QR payloads.
// v4 binary-in-base64url (~360 chars, QR version ~10)

const INVITE_V4_BIN = 4;
const INVITE_QR_TYPE = 'invite_dropbox';

// Fixed crypto field sizes (bytes)
const DIGEST_LEN = 32;  // SHA-256
const KEY_LEN = 32;     // X25519 / Ed25519 public key
const SIG_LEN = 64;     // Ed25519 detached signature

// ─── validation helpers ─────────────────────────────────────────

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

function normalizeOwnerBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw schemaError('InviteQrBundleInvalid', 'prekeyBundle required');
  }
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
  return { ikPubB64, spkPubB64, signatureB64, opkId, opkPubB64 };
}

// ─── base64 / hex / binary helpers ──────────────────────────────

function decodeB64(str) {
  if (typeof globalThis?.atob === 'function') return globalThis.atob(str);
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'base64').toString('binary');
  throw new Error('base64 decode not supported in this environment');
}

function encodeB64(binStr) {
  if (typeof globalThis?.btoa === 'function') return globalThis.btoa(binStr);
  if (typeof Buffer !== 'undefined') return Buffer.from(binStr, 'binary').toString('base64');
  throw new Error('base64 encode not supported in this environment');
}

function b64ToBytes(b64) {
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  const bin = decodeB64(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return encodeB64(bin);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function bytesToB64Url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToBytes(str) {
  return b64ToBytes(str.replace(/-/g, '+').replace(/_/g, '/'));
}

// ─── v4 binary pack / unpack ────────────────────────────────────
//
// Layout (all multi-byte integers are big-endian):
//   [0]       u8   version (0x04)
//   [1]       u8   inviteId byte-length (N1)
//   [2..1+N1] raw  inviteId (UTF-8)
//   +32       raw  ownerAccountDigest (SHA-256)
//   +1        u8   ownerDeviceId byte-length (N2)
//   +N2       raw  ownerDeviceId (UTF-8)
//   +32       raw  ownerPublicKey
//   +4        u32  expiresAt (unix seconds)
//   +32       raw  ikPub
//   +32       raw  spkPub
//   +64       raw  signature
//   +4        u32  opkId
//   +32       raw  opkPub
//   ─────────────────────────────
//   Total ≈ 235 + N1 + N2 bytes

function packBinary(inviteId, ownerAccountDigest, ownerDeviceId, ownerPublicKeyB64, expiresAt, bundle) {
  const enc = new TextEncoder();
  const idBytes = enc.encode(inviteId);
  const devBytes = enc.encode(ownerDeviceId);
  if (idBytes.length > 255) throw schemaError('InviteQrInvalid', 'inviteId too long');
  if (devBytes.length > 255) throw schemaError('InviteQrInvalid', 'ownerDeviceId too long');

  const digestBytes = hexToBytes(ownerAccountDigest);
  const pubBytes = b64ToBytes(ownerPublicKeyB64);
  const ikBytes = b64ToBytes(bundle.ikPubB64);
  const spkBytes = b64ToBytes(bundle.spkPubB64);
  const sigBytes = b64ToBytes(bundle.signatureB64);
  const opkBytes = b64ToBytes(bundle.opkPubB64);

  const total = 1 + 1 + idBytes.length + DIGEST_LEN + 1 + devBytes.length
              + KEY_LEN + 4 + KEY_LEN + KEY_LEN + SIG_LEN + 4 + KEY_LEN;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let o = 0;

  buf[o++] = INVITE_V4_BIN;
  buf[o++] = idBytes.length;
  buf.set(idBytes, o); o += idBytes.length;
  buf.set(digestBytes, o); o += DIGEST_LEN;
  buf[o++] = devBytes.length;
  buf.set(devBytes, o); o += devBytes.length;
  buf.set(pubBytes, o); o += KEY_LEN;
  view.setUint32(o, expiresAt, false); o += 4;
  buf.set(ikBytes, o); o += KEY_LEN;
  buf.set(spkBytes, o); o += KEY_LEN;
  buf.set(sigBytes, o); o += SIG_LEN;
  view.setUint32(o, bundle.opkId, false); o += 4;
  buf.set(opkBytes, o);

  return bytesToB64Url(buf);
}

function unpackBinary(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let o = 0;

  const ver = bytes[o++];
  if (ver !== INVITE_V4_BIN) throw schemaError('InviteQrVersionMismatch', 'invite version mismatch');

  const idLen = bytes[o++];
  const inviteId = dec.decode(bytes.subarray(o, o + idLen)); o += idLen;
  if (!inviteId) throw schemaError('InviteQrInvalid', 'inviteId required');

  const ownerAccountDigest = bytesToHex(bytes.subarray(o, o + DIGEST_LEN)); o += DIGEST_LEN;

  const devLen = bytes[o++];
  const ownerDeviceId = dec.decode(bytes.subarray(o, o + devLen)); o += devLen;
  if (!ownerDeviceId) throw schemaError('InviteQrInvalid', 'ownerDeviceId required');

  const ownerPublicKeyB64 = bytesToB64(bytes.subarray(o, o + KEY_LEN)); o += KEY_LEN;

  const expiresAt = view.getUint32(o, false); o += 4;
  if (!expiresAt || expiresAt > 1_000_000_000_000) {
    throw schemaError('InviteQrInvalid', 'expiresAt invalid');
  }

  const ikPubB64 = bytesToB64(bytes.subarray(o, o + KEY_LEN)); o += KEY_LEN;
  const spkPubB64 = bytesToB64(bytes.subarray(o, o + KEY_LEN)); o += KEY_LEN;
  const signatureB64 = bytesToB64(bytes.subarray(o, o + SIG_LEN)); o += SIG_LEN;
  const opkId = view.getUint32(o, false); o += 4;
  const opkPubB64 = bytesToB64(bytes.subarray(o, o + KEY_LEN));

  return {
    v: INVITE_V4_BIN,
    type: INVITE_QR_TYPE,
    inviteId,
    ownerAccountDigest,
    ownerDeviceId,
    ownerPublicKeyB64,
    expiresAt,
    prekeyBundle: { ikPubB64, spkPubB64, signatureB64, opkId, opkPubB64 }
  };
}

// ─── public API ─────────────────────────────────────────────────

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
  return packBinary(inviteId, ownerAccountDigest, ownerDeviceId, ownerPublicKeyB64, expiresAt, prekeyBundle);
}

export function decodeFriendInvite(input) {
  if (!input && input !== '') throw schemaError('InviteQrMissing', 'invite payload required');

  const raw = typeof input === 'string' ? input.trim() : String(input || '').trim();
  if (!raw) throw schemaError('InviteQrMissing', 'invite payload required');

  try {
    return unpackBinary(b64UrlToBytes(raw));
  } catch (e) {
    if (e.code) throw e;
    throw schemaError('InviteQrDecodeFailed', 'invite payload decode failed');
  }
}
