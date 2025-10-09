import { bytesToB64Url, b64UrlToBytes } from '../utils/base64.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INFO_CONV_TOKEN = encoder.encode('sentry/conv-token');

export async function deriveConversationContext(secretB64Url) {
  const secretBytes = b64UrlToBytes(secretB64Url);
  if (!secretBytes) throw new Error('invite secret required');
  const baseKey = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: INFO_CONV_TOKEN }, baseKey, 256);
  const tokenBytes = new Uint8Array(bits);
  const tokenB64 = bytesToB64Url(tokenBytes);
  const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
  const conversationId = bytesToB64Url(new Uint8Array(digest)).slice(0, 44);
  return { tokenB64, conversationId };
}

export const deriveConversationContextFromSecret = deriveConversationContext;

export async function encryptConversationEnvelope(tokenB64, payload) {
  const keyBytes = b64UrlToBytes(tokenB64);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return { v: 1, iv_b64: bytesToB64Url(iv), payload_b64: bytesToB64Url(ct) };
}

export async function decryptConversationEnvelope(tokenB64, envelope) {
  const keyBytes = b64UrlToBytes(tokenB64);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const iv = b64UrlToBytes(envelope.iv_b64 || envelope.ivB64 || envelope.iv);
  const payloadBytes = b64UrlToBytes(envelope.payload_b64 || envelope.payloadB64 || envelope.payload);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payloadBytes);
  return JSON.parse(decoder.decode(plain));
}

export async function conversationIdFromToken(tokenB64) {
  const tokenBytes = b64UrlToBytes(tokenB64);
  const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
  return bytesToB64Url(new Uint8Array(digest)).slice(0, 44);
}

export async function computeConversationFingerprint(tokenB64, uid) {
  const keyBytes = b64UrlToBytes(tokenB64);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = encoder.encode(String(uid).toUpperCase());
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return bytesToB64Url(new Uint8Array(sig));
}
