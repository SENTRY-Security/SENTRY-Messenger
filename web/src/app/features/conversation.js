// /app/features/conversation.js
// Helpers for deriving conversation tokens/identifiers without leaking metadata.

import { toB64Url, fromB64Url } from '../ui/mobile/ui-utils.js';
import { normalizeAccountDigest, normalizePeerDeviceId } from '../core/store.js';
import {
  deriveConversationContext as deriveConversationContextFromSecret,
  encryptConversationEnvelope,
  decryptConversationEnvelope,
  conversationIdFromToken,
  computeConversationFingerprint,
  computeConversationAccessFingerprint
} from '../../shared/conversation/context.js';

export {
  deriveConversationContextFromSecret,
  conversationIdFromToken,
  computeConversationFingerprint,
  computeConversationAccessFingerprint,
  encryptConversationEnvelope,
  decryptConversationEnvelope
};

export function base64ToUrl(str) {
  return toB64Url(str);
}

export function urlToBase64(str) {
  return fromB64Url(str);
}

export function normalizePeerKey(source) {
  if (!source) return null;
  if (typeof source === 'string' && source.includes('::')) return source;
  if (typeof source === 'object') {
    const digest = normalizeAccountDigest(source.peerAccountDigest || source.accountDigest);
    const deviceId = normalizePeerDeviceId(source.peerDeviceId || source.deviceId);
    if (digest && deviceId) return `${digest}::${deviceId}`;
  }
  return null;
}

export function splitPeerKey(key) {
  if (typeof key !== 'string' || !key.includes('::')) return { digest: null, deviceId: null };
  const [digest, deviceId] = key.split('::');
  return { digest: normalizeAccountDigest(digest), deviceId: normalizePeerDeviceId(deviceId) };
}
