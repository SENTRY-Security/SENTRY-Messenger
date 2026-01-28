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

export function normalizeContactShareEnvelope({ header, ciphertextB64, envelope } = {}) {
  if (isEnvelope(envelope)) return envelope;
  const ivB64 = envelope?.iv_b64 || envelope?.ivB64 || header?.iv_b64 || header?.ivB64 || null;
  const ctB64 = envelope?.ct_b64 || envelope?.ctB64 || ciphertextB64 || null;
  if (typeof ivB64 === 'string' && typeof ctB64 === 'string') {
    return { iv: ivB64, ct: ctB64 };
  }
  return null;
}

// Strict wrappers: only accept explicit sessionKey, no legacy aliases.
export async function encryptContactPayload(sessionKey, payload) {
  return encryptContactPayloadShared({ sessionKey, payload });
}

export async function decryptContactPayload(sessionKey, envelope) {
  return decryptContactPayloadShared({ sessionKey, envelope });
}
