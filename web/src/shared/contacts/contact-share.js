import { bytesToB64, b64ToBytes, b64UrlToBytes } from '../utils/base64.js';

const INFO = 'contact-share';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isEnvelope(envelope) {
  return envelope && typeof envelope.iv === 'string' && typeof envelope.ct === 'string';
}

export async function encryptContactPayload({ secret, payload }) {
  if (!secret) throw new Error('contact secret required');
  const key = await deriveKey(secret, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify(payload || {}));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

export async function decryptContactPayload({ secret, envelope }) {
  if (!secret) throw new Error('contact secret required');
  if (!isEnvelope(envelope)) throw new Error('invalid contact envelope');
  const key = await deriveKey(secret, ['decrypt']);
  const iv = b64ToBytes(envelope.iv);
  const ct = b64ToBytes(envelope.ct);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(decoder.decode(new Uint8Array(plain)));
}

async function deriveKey(secret, usages) {
  const bytes = b64UrlToBytes(secret);
  if (!bytes) throw new Error('invalid secret');
  const baseKey = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array(16);
  const info = encoder.encode(INFO);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, baseKey, { name: 'AES-GCM', length: 256 }, false, usages);
}
