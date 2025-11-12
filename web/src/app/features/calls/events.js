// Lightweight event bus for call-related state transitions.

export const CALL_EVENT = Object.freeze({
  STATE: 'call:state',
  REQUEST: 'call:request',
  ERROR: 'call:error',
  NETWORK_CONFIG: 'call:network-config'
});

const listeners = new Map();

function getBucket(event) {
  const key = String(event || '').toLowerCase();
  if (!key) return null;
  if (!listeners.has(key)) {
    listeners.set(key, new Set());
  }
  return listeners.get(key);
}

export function subscribeCallEvent(event, handler) {
  if (typeof handler !== 'function') return () => {};
  const bucket = getBucket(event);
  if (!bucket) return () => {};
  bucket.add(handler);
  return () => {
    bucket.delete(handler);
    if (!bucket.size) listeners.delete(String(event || '').toLowerCase());
  };
}

export function emitCallEvent(event, detail) {
  const bucket = getBucket(event);
  if (!bucket || !bucket.size) return;
  const payload = {
    type: String(event),
    detail,
    ts: Date.now()
  };
  for (const handler of Array.from(bucket)) {
    try {
      handler(payload);
    } catch (err) {
      console.warn('[calls:event] listener error', err);
    }
  }
}

export function onceCallEvent(event, handler) {
  if (typeof handler !== 'function') return () => {};
  const off = subscribeCallEvent(event, (payload) => {
    off();
    handler(payload);
  });
  return off;
}

export function clearCallEventListeners(event) {
  if (!event) {
    listeners.clear();
    return;
  }
  listeners.delete(String(event || '').toLowerCase());
}
