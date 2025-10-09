// /app/features/conversation.js
// Helpers for deriving conversation tokens/identifiers without leaking metadata.

import { toB64Url, fromB64Url } from '../ui/mobile/ui-utils.js';
import {
  deriveConversationContext as deriveConversationContextFromSecret,
  encryptConversationEnvelope,
  decryptConversationEnvelope,
  conversationIdFromToken,
  computeConversationFingerprint
} from '../../shared/conversation/context.js';

export {
  deriveConversationContextFromSecret,
  conversationIdFromToken,
  computeConversationFingerprint,
  encryptConversationEnvelope,
  decryptConversationEnvelope
};

export function base64ToUrl(str) {
  return toB64Url(str);
}

export function urlToBase64(str) {
  return fromB64Url(str);
}
