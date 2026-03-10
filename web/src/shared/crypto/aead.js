/**
 * SECURITY POLICY – STRICT CRYPTO PROTOCOL, NO FALLBACK ALLOWED.
 *
 * 本檔案中的所有密碼協定（X3DH、Double Ratchet、AEAD、鍵派生、counter 驗證、header 驗證）
 * 禁止設計、加入或推論任何 fallback、retry、rollback、resync、auto-repair 等邏輯。
 *
 * 規則如下：
 * 1. 若解密失敗 → 一律直接 fail，不可嘗試第二組 key 或舊 ratchet state。
 * 2. 若 counter 不一致 → 一律直接拒絕，不可重送、補拉或自動對齊。
 * 3. 不允許任何協定降級（downgrade）。不得用舊版本、舊頭資訊、舊密鑰重試。
 * 4. 不允許模糊錯誤處理。不做 try-catch fallback，不做 silent recovery。
 * 5. 對話重置必須是顯式事件，不得隱式重建 state。
 *
 * 一切協定邏輯必須「單一路徑」且「強一致性」，任何 fallback 視為安全漏洞。
 */
const cryptoObj = globalThis.crypto;
if (!cryptoObj || !cryptoObj.subtle) {
  throw new Error('WebCrypto subtle API is required');
}

const subtle = cryptoObj.subtle;

if (!subtle) {
  throw new Error('WebCrypto subtle API is required');
}

import { bytesToB64, bytesToB64Url, b64ToBytes, b64UrlToBytes } from '../utils/base64.js';
import { toU8Strict } from '../utils/u8-strict.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ALLOWED_ENVELOPE_INFO_TAGS = new Set([
  'blob/v1',
  'media/v1',
  'profile/v1',
  'settings/v1',
  'snapshot/v1',
  'contact-secrets/backup/v1',
  'devkeys/v1',
  'contact/v1'
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

async function deriveAesKey(mkRawU8, saltU8, infoTag, usages) {
  const mkKey = await subtle.importKey(
    'raw',
    toU8Strict(mkRawU8, 'web/src/shared/crypto/aead.js:33:deriveAesKey'),
    'HKDF',
    false,
    ['deriveKey']
  );
  const normalizedInfoTag = normalizeInfoTag(infoTag, { allowInfoTags: null, required: true });
  const info = encoder.encode(normalizedInfoTag);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: saltU8, info },
    mkKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

export async function encryptAesGcm({ key, iv, data }) {
  if (!(key instanceof CryptoKey)) throw new Error('encryptAesGcm: key required');
  const buf = data instanceof Uint8Array ? data : encoder.encode(data);
  const ivBytes = iv instanceof Uint8Array ? iv : toUint8Array(iv);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: ivBytes }, key, buf));
  return { iv: ivBytes, ciphertext: ct };
}

export async function decryptAesGcm({ key, iv, ciphertext }) {
  if (!(key instanceof CryptoKey)) throw new Error('decryptAesGcm: key required');
  const ivBytes = iv instanceof Uint8Array ? iv : toUint8Array(iv);
  const ctBytes = ciphertext instanceof Uint8Array ? ciphertext : toUint8Array(ciphertext);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ctBytes);
  return new Uint8Array(pt);
}

export function randomIv(bytes = 12) {
  if (cryptoObj && cryptoObj.getRandomValues) {
    return cryptoObj.getRandomValues(new Uint8Array(bytes));
  }
  throw new Error('crypto.getRandomValues unavailable');
}

export function encodeUtf8(value) {
  return value instanceof Uint8Array ? value : encoder.encode(String(value ?? ''));
}

export function decodeUtf8(u8) {
  return decoder.decode(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
}

export function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return Uint8Array.from(Buffer.from(value, 'base64'));
  return new Uint8Array(value);
}

export { bytesToB64, bytesToB64Url, b64ToBytes, b64UrlToBytes };

export async function wrapWithMK_JSON(obj, mkRawU8, infoTag = 'blob/v1') {
  const salt = randomIv(16);
  const iv = randomIv(12);
  const normalizedInfoTag = normalizeInfoTag(infoTag, { allowInfoTags: null, required: true });
  const key = await deriveAesKey(mkRawU8, salt, normalizedInfoTag, ['encrypt']);
  const data = encoder.encode(JSON.stringify(obj));
  const { ciphertext } = await encryptAesGcm({ key, iv, data });
  return {
    v: 1,
    aead: 'aes-256-gcm',
    info: normalizedInfoTag,
    salt_b64: bytesToB64(salt),
    iv_b64: bytesToB64(iv),
    ct_b64: bytesToB64(ciphertext)
  };
}

export async function unwrapWithMK_JSON(envelope, mkRawU8) {
  const normalizedEnvelope = assertEnvelopeStrict(envelope);
  const salt = b64ToBytes(normalizedEnvelope.salt_b64);
  const iv = b64ToBytes(normalizedEnvelope.iv_b64);
  const ct = b64ToBytes(normalizedEnvelope.ct_b64);
  const key = await deriveAesKey(mkRawU8, salt, normalizedEnvelope.info, ['decrypt']);
  const plain = await decryptAesGcm({ key, iv, ciphertext: ct });
  return JSON.parse(decoder.decode(plain));
}
