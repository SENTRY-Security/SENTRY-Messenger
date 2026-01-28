import { bytesToB64Url, b64UrlToBytes } from '../utils/base64.js';
import { toU8Strict } from '../utils/u8-strict.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INFO_CONV_TOKEN = 'sentry/conv-token';

function buildInfo(deviceId = null) {
  const dev = typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : null;
  return encoder.encode(dev ? `${INFO_CONV_TOKEN}/${dev}` : INFO_CONV_TOKEN);
}

function normalizeKey(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') {
    const bytes = b64UrlToBytes(input);
    if (bytes) return bytes;
  }
  return null;
}

export async function deriveConversationContext(secretB64UrlOrKeyBytes, opts = {}) {
  const deviceId = opts.deviceId || null;
  const info = buildInfo(deviceId);
  if (!deviceId) throw new Error('deviceId required for conversation context');
  const keyBytes = normalizeKey(secretB64UrlOrKeyBytes);
  if (!keyBytes) throw new Error('session key required for conversation context');
  const baseKey = await crypto.subtle.importKey(
    'raw',
    toU8Strict(keyBytes, 'web/src/shared/conversation/context.js:27:deriveConversationContext'),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info }, baseKey, 256);
  const tokenBytes = new Uint8Array(bits);
  const tokenB64 = bytesToB64Url(tokenBytes);
  const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
  const conversationId = bytesToB64Url(new Uint8Array(digest)).slice(0, 44);
  return { tokenB64, conversationId };
}

export const deriveConversationContextFromSecret = deriveConversationContext;

export async function encryptConversationEnvelope(tokenB64, payload) {
  const keyBytes = b64UrlToBytes(tokenB64);
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(keyBytes, 'web/src/shared/conversation/context.js:40:encryptConversationEnvelope'),
    'AES-GCM',
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return { v: 1, iv_b64: bytesToB64Url(iv), payload_b64: bytesToB64Url(ct) };
}

export async function decryptConversationEnvelope(tokenB64, envelope) {
  const keyBytes = b64UrlToBytes(tokenB64);
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(keyBytes, 'web/src/shared/conversation/context.js:49:decryptConversationEnvelope'),
    'AES-GCM',
    false,
    ['decrypt']
  );
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

export async function computeConversationFingerprint(tokenB64, accountDigest) {
  const keyBytes = b64UrlToBytes(tokenB64);
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(keyBytes, 'web/src/shared/conversation/context.js:64:computeConversationFingerprint'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = encoder.encode(String(accountDigest).toUpperCase());
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return bytesToB64Url(new Uint8Array(sig));
}

export async function computeConversationAccessFingerprint(tokenB64, accountDigest) {
  return computeConversationFingerprint(tokenB64, accountDigest);
}
