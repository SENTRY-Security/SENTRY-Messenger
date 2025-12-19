// /app/features/semantic.js
// Client-only semantic classification for decrypted payloads.

export const SEMANTIC_KIND = Object.freeze({
  USER_MESSAGE: 'USER_MESSAGE',
  CONTROL_STATE: 'CONTROL_STATE',
  TRANSIENT_SIGNAL: 'TRANSIENT_SIGNAL',
  IGNORABLE: 'IGNORABLE'
});

export const USER_MESSAGE_SUBTYPES = new Set(['text', 'media', 'call-log']);
export const CONTROL_STATE_SUBTYPES = new Set([
  'contact-share',
  'profile-update',
  'session-error',
  'session-init',
  'session-ack'
]);
export const TRANSIENT_SIGNAL_SUBTYPES = new Set(['read-receipt', 'delivery-receipt']);

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
  return normalizeSemanticSubtype(parsed?.type || parsed?.msg_type || parsed?.msgType || null);
}

function extractMetaType(meta, header) {
  return normalizeSemanticSubtype(
    meta?.msg_type ||
      meta?.msgType ||
      header?.meta?.msg_type ||
      header?.meta?.msgType ||
      null
  );
}

export function classifyDecryptedPayload(plaintext, { meta = null, header = null } = {}) {
  const fromMeta = extractMetaType(meta, header);
  const fromPlaintext = parsePlaintextType(plaintext);
  const hasPlaintext = typeof plaintext === 'string' && plaintext.trim().length > 0;
  const subtype = fromMeta || fromPlaintext || (hasPlaintext ? 'text' : null);

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
