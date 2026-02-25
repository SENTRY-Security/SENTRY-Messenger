// /app/crypto/aead.js
// HKDF(SHA-256) + AES-GCM per-file/content encryption helpers（純前端，0-knowledge）
// 提供：
//   - encryptWithMK(plainU8, mkRawU8, infoTag='media/v1') -> { cipherBuf, iv, hkdfSalt }
//   - decryptWithMK(cipherU8, mkRawU8, saltU8, ivU8, infoTag='media/v1') -> Uint8Array
//   - wrapWithMK_JSON(obj, mkRawU8, infoTag='blob/v1') -> { v, aead:'aes-256-gcm', info, salt_b64, iv_b64, ct_b64 }
//   - unwrapWithMK_JSON(envelope, mkRawU8) -> any
//
// 注意：不匯入任何外部套件；使用瀏覽器 WebCrypto。

import { toU8Strict } from '/shared/utils/u8-strict.js';

export const ALLOWED_ENVELOPE_INFO_TAGS = new Set([
  'blob/v1',
  'media/v1',
  'media/chunk-v1',
  'media/manifest-v1',
  'profile/v1',
  'settings/v1',
  'snapshot/v1',
  'contact-secrets/backup/v1',
  'devkeys/v1',
  'contact/v1',
  'message-key/v1'
]);

function requireNonEmptyString(value, key) {
  if (typeof value !== 'string') {
    throw new Error(`Invalid envelope: ${key} must be string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Invalid envelope: ${key} empty`);
  }
  return trimmed;
}

function normalizeInfoTag(infoTag, { allowInfoTags = null, required = true } = {}) {
  if (!required && (infoTag === undefined || infoTag === null)) return null;
  const normalized = requireNonEmptyString(infoTag, 'info');
  if (allowInfoTags && allowInfoTags.size && !allowInfoTags.has(normalized)) {
    throw new Error(`Invalid envelope: info not allowed (${normalized})`);
  }
  return normalized;
}

export function assertEnvelopeStrict(envelope, { requireInfoTag = true, allowInfoTags = ALLOWED_ENVELOPE_INFO_TAGS } = {}) {
  if (!envelope || envelope.aead !== 'aes-256-gcm') {
    throw new Error('Invalid envelope: aead must be aes-256-gcm');
  }
  const info = requireInfoTag
    ? normalizeInfoTag(envelope.info, { allowInfoTags, required: true })
    : (typeof envelope.info === 'string' ? envelope.info.trim() : envelope.info);
  return {
    ...envelope,
    info,
    salt_b64: requireNonEmptyString(envelope.salt_b64, 'salt_b64'),
    iv_b64: requireNonEmptyString(envelope.iv_b64, 'iv_b64'),
    ct_b64: requireNonEmptyString(envelope.ct_b64, 'ct_b64')
  };
}

/** HKDF -> AES-GCM CryptoKey 派生 */
async function hkdfDeriveAesKey(mkRawU8, saltU8, infoStr, usages) {
  const mkKey = await crypto.subtle.importKey(
    'raw',
    toU8Strict(mkRawU8, 'web/src/app/crypto/aead.js:13:hkdfDeriveAesKey'),
    'HKDF',
    false,
    ['deriveKey']
  );
  const infoTag = normalizeInfoTag(infoStr, { allowInfoTags: null, required: true });
  const info = new TextEncoder().encode(infoTag);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: saltU8, info },
    mkKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

/** 使用 MK 衍生的 AES-GCM 金鑰加密一段資料 */
export async function encryptWithMK(plainU8, mkRawU8, infoTag = 'media/v1') {
  const normalizedInfoTag = normalizeInfoTag(infoTag, { allowInfoTags: null, required: true });
  const salt = crypto.getRandomValues(new Uint8Array(16));   // per-object salt
  const iv = crypto.getRandomValues(new Uint8Array(12));   // 96-bit IV
  const key = await hkdfDeriveAesKey(mkRawU8, salt, normalizedInfoTag, ['encrypt']);
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainU8);
  return { cipherBuf: new Uint8Array(ctBuf), iv, hkdfSalt: salt };
}

/** 使用 MK 衍生的 AES-GCM 金鑰解密一段資料 */
export async function decryptWithMK(cipherU8, mkRawU8, saltU8, ivU8, infoTag = 'media/v1') {
  const normalizedInfoTag = normalizeInfoTag(infoTag, { allowInfoTags: null, required: true });
  const key = await hkdfDeriveAesKey(mkRawU8, saltU8, normalizedInfoTag, ['decrypt']);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivU8 }, key, cipherU8);
    return new Uint8Array(pt);
  } catch (err) {
    throw new Error(`decryptWithMK failed: ${err?.message || err} (len=${cipherU8?.length})`);
  }
}

export async function wrapWithMK_JSON(obj, mkRawU8, infoTag = 'blob/v1') {
  const normalizedInfoTag = normalizeInfoTag(infoTag, { allowInfoTags: null, required: true });
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const { cipherBuf, iv, hkdfSalt } = await encryptWithMK(plain, mkRawU8, normalizedInfoTag);
  return {
    v: 1,
    aead: 'aes-256-gcm',
    info: normalizedInfoTag,
    salt_b64: b64(hkdfSalt),
    iv_b64: b64(iv),
    ct_b64: b64(cipherBuf)
  };
}

export async function unwrapWithMK_JSON(envelope, mkRawU8) {
  const normalizedEnvelope = assertEnvelopeStrict(envelope);
  const salt = b64u8(normalizedEnvelope.salt_b64);
  const iv = b64u8(normalizedEnvelope.iv_b64);
  const ct = b64u8(normalizedEnvelope.ct_b64);
  let plain;
  try {
    plain = await decryptWithMK(ct, mkRawU8, salt, iv, normalizedEnvelope.info);
  } catch (err) {
    throw new Error(`unwrapWithMK_JSON: decrypt failed - ${err.message}`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (err) {
    throw new Error(`unwrapWithMK_JSON: parse failed - ${err.message} (len=${plain?.byteLength})`);
  }
}

// --- small helpers ---
export function b64(u8) {
  let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
export function b64u8(b64s) {
  const bin = atob(String(b64s || ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
