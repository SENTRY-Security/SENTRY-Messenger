// /app/features/contact-share.js
// Shared helpers for encrypting/decrypting contact payloads using invite secrets.

import { bytesToB64, b64ToBytes, b64UrlToBytes } from '../ui/mobile/ui-utils.js';

const CONTACT_SHARE_INFO = 'contact-share';

export function isContactShareEnvelope(envelope) {
  return envelope && typeof envelope.iv === 'string' && typeof envelope.ct === 'string';
}

export async function encryptContactPayload(secret, obj) {
  if (!secret) throw new Error('contact secret required');
  const key = await deriveContactKey(secret, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj || {}));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

export async function decryptContactPayload(secret, envelope) {
  if (!secret) throw new Error('contact secret required');
  if (!isContactShareEnvelope(envelope)) throw new Error('invalid contact envelope');
  const key = await deriveContactKey(secret, ['decrypt']);
  const iv = b64ToBytes(envelope.iv);
  const ct = b64ToBytes(envelope.ct);
  if (!iv || !ct) throw new Error('invalid contact envelope');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
}

async function deriveContactKey(secret, usages) {
  const bytes = b64UrlToBytes(secret);
  if (!bytes) throw new Error('invalid secret');
  const baseKey = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array(16);
  const info = new TextEncoder().encode(CONTACT_SHARE_INFO);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, baseKey, { name: 'AES-GCM', length: 256 }, false, usages);
}
