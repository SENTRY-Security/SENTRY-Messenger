// /app/features/secure-conversation-signals.js
// Constants and helpers for secure conversation control messages.

export const CONTROL_MESSAGE_TYPES = Object.freeze({
  SESSION_ERROR: 'session-error',
  DELIVERY_RECEIPT: 'delivery-receipt',
  READ_RECEIPT: 'read-receipt',
  CONVERSATION_DELETED: 'conversation-deleted'
});

export function isControlMessageType(value) {
  if (!value || typeof value !== 'string') return false;
  const norm = value.toLowerCase();
  return Object.values(CONTROL_MESSAGE_TYPES).includes(norm);
}

export function normalizeControlMessageType(value) {
  if (!value || typeof value !== 'string') return null;
  const norm = value.toLowerCase();
  return isControlMessageType(norm) ? norm : null;
}
