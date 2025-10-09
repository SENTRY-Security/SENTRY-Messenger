// /app/features/contact-share.js
// Shared helpers for encrypting/decrypting contact payloads using invite secrets.

import {
  isEnvelope,
  encryptContactPayload as encryptContactPayloadShared,
  decryptContactPayload as decryptContactPayloadShared
} from '../../shared/contacts/contact-share.js';

export function isContactShareEnvelope(envelope) {
  return isEnvelope(envelope);
}

export async function encryptContactPayload(secret, obj) {
  return encryptContactPayloadShared({ secret, payload: obj });
}

export async function decryptContactPayload(secret, envelope) {
  return decryptContactPayloadShared({ secret, envelope });
}
