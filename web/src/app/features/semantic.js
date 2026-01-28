// /app/features/semantic.js
// Client-only semantic classification for decrypted payloads.

export const SEMANTIC_KIND = Object.freeze({
  USER_MESSAGE: 'USER_MESSAGE',
  CONTROL_STATE: 'CONTROL_STATE',
  TRANSIENT_SIGNAL: 'TRANSIENT_SIGNAL',
  IGNORABLE: 'IGNORABLE'
});

export const MSG_SUBTYPE = Object.freeze({
  // User Messages
  TEXT: 'text',
  MEDIA: 'media',
  CALL_LOG: 'call-log',
  SYSTEM: 'system',

  // Control State
  CONTACT_SHARE: 'contact-share',
  PROFILE_UPDATE: 'profile-update',
  SESSION_ERROR: 'session-error',
  SESSION_INIT: 'session-init',
  SESSION_ACK: 'session-ack',
  CONVERSATION_DELETED: 'conversation-deleted',

  // Transient Signals
  READ_RECEIPT: 'read-receipt',
  DELIVERY_RECEIPT: 'delivery-receipt',

  // Internal
  PLACEHOLDER: 'placeholder'
});

export const USER_MESSAGE_SUBTYPES = new Set([
  MSG_SUBTYPE.TEXT,
  MSG_SUBTYPE.MEDIA,
  MSG_SUBTYPE.CALL_LOG,
  MSG_SUBTYPE.SYSTEM
]);

export const CONTROL_STATE_SUBTYPES = new Set([
  MSG_SUBTYPE.CONTACT_SHARE,
  MSG_SUBTYPE.PROFILE_UPDATE,
  MSG_SUBTYPE.SESSION_ERROR,
  MSG_SUBTYPE.SESSION_INIT,
  MSG_SUBTYPE.SESSION_ACK,
  MSG_SUBTYPE.CONVERSATION_DELETED
]);

export const TRANSIENT_SIGNAL_SUBTYPES = new Set([
  MSG_SUBTYPE.READ_RECEIPT,
  MSG_SUBTYPE.DELIVERY_RECEIPT
]);

export function normalizeSemanticSubtype(value) {
  if (!value || typeof value !== 'string') return null;
  const norm = value.trim().toLowerCase();
  return norm || null;
}

export function isUserMessageSubtype(value) {
  const norm = normalizeSemanticSubtype(value);
  return !!(norm && USER_MESSAGE_SUBTYPES.has(norm));
}

function parsePlaintextType(plaintext) {
  if (!plaintext) return null;
  let parsed = null;
  if (typeof plaintext === 'string') {
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      parsed = null;
    }
  } else if (typeof plaintext === 'object') {
    parsed = plaintext;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  // Prioritize msgType; keep aliases for legacy compatibility during transition
  const raw = parsed?.msgType || parsed?.type || parsed?.msg_type || parsed?.msg_cat || null;
  return normalizeSemanticSubtype(raw);
}

function extractMetaType(meta, header) {
  // Prioritize msgType in meta and header
  const raw = meta?.msgType ||
    meta?.msg_type ||
    header?.meta?.msgType ||
    header?.meta?.msg_type ||
    null;
  return normalizeSemanticSubtype(raw);
}

export function classifyDecryptedPayload(plaintext, { meta = null, header = null } = {}) {
  const fromMeta = extractMetaType(meta, header);
  const fromPlaintext = parsePlaintextType(plaintext);
  const hasPlaintext = typeof plaintext === 'string' && plaintext.trim().length > 0;
  const subtype = fromMeta || fromPlaintext || (hasPlaintext ? MSG_SUBTYPE.TEXT : null);

  if (subtype && USER_MESSAGE_SUBTYPES.has(subtype)) {
    return { kind: SEMANTIC_KIND.USER_MESSAGE, subtype };
  }
  if (subtype && TRANSIENT_SIGNAL_SUBTYPES.has(subtype)) {
    return { kind: SEMANTIC_KIND.TRANSIENT_SIGNAL, subtype };
  }
  if (subtype && CONTROL_STATE_SUBTYPES.has(subtype)) {
    return { kind: SEMANTIC_KIND.CONTROL_STATE, subtype };
  }
  return { kind: SEMANTIC_KIND.IGNORABLE, subtype: subtype || null };
}
