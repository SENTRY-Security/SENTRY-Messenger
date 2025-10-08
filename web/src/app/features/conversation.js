// /app/features/conversation.js
// Helpers for deriving conversation tokens/identifiers without leaking metadata.

import { bytesToB64Url, b64UrlToBytes, toB64Url, fromB64Url } from '../ui/mobile/ui-utils.js';

const HKDF_INFO_CONV_TOKEN = new TextEncoder().encode('sentry/conv-token');
const ZERO_SALT = new Uint8Array(32);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function deriveConversationContextFromSecret(inviteSecret) {
  if (!inviteSecret) throw new Error('inviteSecret required');
  const secretBytes = b64UrlToBytes(inviteSecret);
  const baseKey = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: ZERO_SALT,
    info: HKDF_INFO_CONV_TOKEN
  }, baseKey, 256);
  const tokenBytes = new Uint8Array(bits);
  const tokenB64 = bytesToB64Url(tokenBytes);
  const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
  const conversationId = bytesToB64Url(new Uint8Array(digest)).slice(0, 44);
  return { tokenB64, conversationId };
}

export async function conversationIdFromToken(tokenB64) {
  if (!tokenB64) throw new Error('conversation token required');
  const tokenBytes = b64UrlToBytes(tokenB64);
  const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
  return bytesToB64Url(new Uint8Array(digest)).slice(0, 44);
}

export async function computeConversationFingerprint(tokenB64, uid) {
  if (!tokenB64) throw new Error('conversation token required');
  if (!uid) throw new Error('uid required');
  const keyBytes = b64UrlToBytes(tokenB64);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = new TextEncoder().encode(String(uid).toUpperCase());
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return bytesToB64Url(new Uint8Array(sig));
}

async function importConversationKey(tokenB64, usages) {
  const keyBytes = b64UrlToBytes(tokenB64);
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, usages);
}

export async function encryptConversationEnvelope(tokenB64, payload) {
  if (!tokenB64) throw new Error('conversation token required');
  const key = await importConversationKey(tokenB64, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify(payload));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return {
    v: 1,
    iv_b64: bytesToB64Url(iv),
    payload_b64: bytesToB64Url(new Uint8Array(ct))
  };
}

export async function decryptConversationEnvelope(tokenB64, envelope) {
  if (!tokenB64) throw new Error('conversation token required');
  if (!envelope || typeof envelope !== 'object') throw new Error('envelope required');
  const ivStr = envelope.iv_b64 || envelope.ivB64 || envelope.iv;
  const payloadStr = envelope.payload_b64 || envelope.payloadB64 || envelope.payload;
  if (!ivStr || !payloadStr) throw new Error('invalid envelope');
  const key = await importConversationKey(tokenB64, ['decrypt']);
  const iv = b64UrlToBytes(ivStr);
  const ct = b64UrlToBytes(payloadStr);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(decoder.decode(new Uint8Array(plain)));
}

export function base64ToUrl(str) {
  return toB64Url(str);
}

export function urlToBase64(str) {
  return fromB64Url(str);
}
