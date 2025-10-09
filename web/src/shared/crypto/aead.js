const cryptoObj = globalThis.crypto;
if (!cryptoObj || !cryptoObj.subtle) {
  throw new Error('WebCrypto subtle API is required');
}

const subtle = cryptoObj.subtle;

if (!subtle) {
  throw new Error('WebCrypto subtle API is required');
}

import { bytesToB64, bytesToB64Url, b64ToBytes, b64UrlToBytes } from '../utils/base64.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deriveAesKey(mkRawU8, saltU8, infoTag, usages) {
  const mkKey = await subtle.importKey('raw', mkRawU8, 'HKDF', false, ['deriveKey']);
  const info = encoder.encode(infoTag || 'mk/aead');
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
  const key = await deriveAesKey(mkRawU8, salt, infoTag, ['encrypt']);
  const data = encoder.encode(JSON.stringify(obj));
  const { ciphertext } = await encryptAesGcm({ key, iv, data });
  return {
    v: 1,
    aead: 'aes-256-gcm',
    info: infoTag,
    salt_b64: bytesToB64(salt),
    iv_b64: bytesToB64(iv),
    ct_b64: bytesToB64(ciphertext)
  };
}

export async function unwrapWithMK_JSON(envelope, mkRawU8) {
  if (!envelope || envelope.aead !== 'aes-256-gcm') {
    throw new Error('Unsupported envelope (expect aead=aes-256-gcm)');
  }
  const salt = b64ToBytes(envelope.salt_b64);
  const iv = b64ToBytes(envelope.iv_b64);
  const ct = b64ToBytes(envelope.ct_b64);
  const key = await deriveAesKey(mkRawU8, salt, envelope.info || 'blob/v1', ['decrypt']);
  const plain = await decryptAesGcm({ key, iv, ciphertext: ct });
  return JSON.parse(decoder.decode(plain));
}
