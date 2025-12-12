// /app/features/contact-share.js
// Shared helpers for encrypting/decrypting contact payloads using session keys (derived from invites).

import {
  isEnvelope,
  encryptContactPayload as encryptContactPayloadShared,
  decryptContactPayload as decryptContactPayloadShared
} from '../../shared/contacts/contact-share.js';

export function isContactShareEnvelope(envelope) {
  return isEnvelope(envelope);
}

// Strict wrappers: only accept explicit sessionKey, no legacy aliases.
export async function encryptContactPayload(sessionKey, payload) {
  return encryptContactPayloadShared({ sessionKey, payload });
}

export async function decryptContactPayload(sessionKey, envelope) {
  return decryptContactPayloadShared({ sessionKey, envelope });
}
