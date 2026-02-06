// /app/features/secure-conversation-manager.js
// Simplified: no session-init/ack control messages. DR 準備只靠 per-device bundle/bootstrap。

import { drState, normalizePeerIdentity, ensureDeviceId } from '../core/store.js';
import { getContactSecret, getCorruptContact } from '../core/contact-secrets.js';
import { CONTROL_MESSAGE_TYPES, normalizeControlMessageType } from './secure-conversation-signals.js';

// Re-export for consumers that already depend on manager namespace (e.g., messages.js)
export { ensureDrReceiverState } from './dr-session.js';

const STATUS_IDLE = 'idle';
const STATUS_PENDING = 'pending';
const STATUS_READY = 'ready';
const STATUS_FAILED = 'failed';

const listeners = new Set();
const peerStates = new Map();
const sessionLocks = new Map();

function resolvePeerIdentity(value) {
  if (!value) return { key: null, deviceId: null };
  const identity = normalizePeerIdentity({
    peerAccountDigest: value?.peerAccountDigest ?? value?.accountDigest ?? value,
    peerDeviceId: value?.peerDeviceId ?? null
  });
  return { key: identity.key || null, deviceId: identity.deviceId || null };
}

function toPeerKey(value) {
  const { key } = resolvePeerIdentity(value);
  return key || null;
}

function toErrorMessage(error) {
  if (!error) return null;
  if (typeof error === 'string') return error;
  if (error?.message) return error.message;
  try {
    const str = String(error);
    return str === '[object Object]' ? '發生未知錯誤' : str;
  } catch {
    return '發生未知錯誤';
  }
}

function ensureEntry(peerAccountDigest) {
  const key = toPeerKey({ peerAccountDigest });
  if (!key) return null;
  let entry = peerStates.get(key);
  if (!entry) {
    entry = {
      status: STATUS_IDLE,
      error: null,
      updatedAt: 0,
      readyAt: null,
      attempts: 0,
      reason: null,
      source: null,
      pendingPromise: null
    };
    peerStates.set(key, entry);
  }
  return entry;
}

function cloneStatus(key, entry) {
  if (!entry) {
    return {
      peerAccountDigest: key,
      status: STATUS_IDLE,
      error: null,
      updatedAt: null,
      readyAt: null,
      attempts: 0,
      reason: null,
      source: null
    };
  }
  return {
    peerAccountDigest: key,
    status: entry.status,
    error: entry.error,
    updatedAt: entry.updatedAt || null,
    readyAt: entry.readyAt || null,
    attempts: entry.attempts || 0,
    reason: entry.reason || null,
    source: entry.source || null
  };
}

function emitStatus(key, entry, extra = {}) {
  if (!entry) return;
  const payload = {
    peerAccountDigest: key,
    status: entry.status,
    error: entry.error,
    updatedAt: entry.updatedAt,
    readyAt: entry.readyAt,
    attempts: entry.attempts,
    reason: extra.reason ?? entry.reason ?? null,
    source: extra.source ?? entry.source ?? null
  };
  for (const listener of listeners) {
    try {
      listener({ ...payload });
    } catch (err) {
      console.warn('[secure-conversation] listener error', err);
    }
  }
}

function setStatus(key, nextStatus, { reason = null, source = null, attempts = null, error = null } = {}) {
  const peerKey = toPeerKey({ peerAccountDigest: key });
  if (!peerKey) return null;
  const entry = ensureEntry(peerKey);
  if (!entry) return null;
  entry.status = nextStatus;
  entry.updatedAt = Date.now();
  if (typeof attempts === 'number') entry.attempts = attempts;
  if (reason !== undefined) entry.reason = reason;
  if (source !== undefined) entry.source = source;
  if (nextStatus === STATUS_READY) {
    entry.readyAt = entry.updatedAt;
    entry.error = null;
  } else if (nextStatus === STATUS_FAILED) {
    entry.error = toErrorMessage(error);
  } else {
    entry.error = null;
  }
  emitStatus(peerKey, entry, { reason, source });
  return entry;
}

function hasReceiverReady({ peerAccountDigest, peerDeviceId }) {
  const { key } = resolvePeerIdentity({ peerAccountDigest, peerDeviceId });
  if (!key) return false;
  const holder = drState({ peerAccountDigest, peerDeviceId });
  if (!holder?.rk || !(holder.myRatchetPriv instanceof Uint8Array) || !(holder.myRatchetPub instanceof Uint8Array)) {
    return false;
  }
  const hasReceiveChain = holder?.ckR instanceof Uint8Array && holder.ckR.length > 0;
  if (hasReceiveChain) return true;
  const hasSendChain = holder?.ckS instanceof Uint8Array && holder.ckS.length > 0;
  const deviceId = ensureDeviceId();
  const secretInfo = getContactSecret(key, { deviceId });
  const relationshipRole = typeof secretInfo?.role === 'string' ? secretInfo.role.toLowerCase() : null;
  const holderRole = typeof holder?.baseKey?.role === 'string' ? holder.baseKey.role.toLowerCase() : null;
  const isGuestLike = relationshipRole === 'guest' || holderRole === 'guest';
  const isInitiator = relationshipRole === 'initiator' || holderRole === 'initiator';

  // [DEBUG] Trace Ready Check
  if (!hasSendChain || (!isGuestLike && !isInitiator && !hasReceiveChain)) {
    console.log('[secure-manager] hasReceiverReady FAIL', {
      peer: peerAccountDigest?.slice(0, 8),
      hasState: !!state,
      hasSendChain,
      hasReceiveChain,
      role: relationshipRole || holderRole,
      isInitiator,
      isGuestLike
    });
  }

  // [FIX] Initiators have send chain (ckS) but no receive chain (ckR) until first reply. 
  // They are valid "ready" states for receiving the first response.
  return !!(hasSendChain && (isGuestLike || isInitiator)) || (hasSendChain && hasReceiveChain);
}

export function subscribeSecureConversation(listener) {
  if (typeof listener !== 'function') throw new Error('listener 必須是函式');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSecureConversationStatus(peer) {
  const { key } = resolvePeerIdentity(peer);
  if (!key) return null;
  const entry = peerStates.get(key);
  return cloneStatus(key, entry);
}

export async function ensureSecureConversationReady({
  peerAccountDigest,
  peerDeviceId = null,
  timeoutMs,
  pollIntervalMs,
  reason = 'ensure',
  source = 'ensureSecureConversationReady',
  conversationId = null
} = {}) {
  const { key, deviceId } = resolvePeerIdentity({ peerAccountDigest, peerDeviceId });
  if (!key || !deviceId) throw new Error('peerAccountDigest and peerDeviceId required');
  const entry = ensureEntry(key);
  if (!entry) throw new Error('無法建立狀態容器');

  const corrupt = getCorruptContact({ peerAccountDigest: key, peerDeviceId: deviceId });
  if (corrupt) {
    const error = new Error('此好友狀態損壞，需要重新同步/重新邀請');
    setStatus(key, STATUS_FAILED, { reason: 'contact-secrets-corrupt', source, attempts: entry.attempts || 0, error });
    throw error;
  }

  if (hasReceiverReady({ peerAccountDigest, peerDeviceId: deviceId })) {
    if (entry.status !== STATUS_READY) {
      setStatus(key, STATUS_READY, { reason: 'already-ready', source, attempts: entry.attempts || 0 });
    }
    return cloneStatus(key, peerStates.get(key));
  }

  entry.attempts = (entry.attempts || 0) + 1;
  setStatus(key, STATUS_PENDING, { reason: 'missing-live-state', source, attempts: entry.attempts });
  return cloneStatus(key, peerStates.get(key));
}

export function handleSecureConversationControlMessage({
  peerAccountDigest,
  messageType,
  source = 'control-message'
} = {}) {
  const key = toPeerKey({ peerAccountDigest });
  if (!key) return;
  const normalizedType = normalizeControlMessageType(messageType);
  if (!normalizedType) return;
  if (normalizedType === CONTROL_MESSAGE_TYPES.SESSION_ERROR) {
    setStatus(key, STATUS_FAILED, { reason: 'session-error', source });
  }
  // session-init/ack 已移除，不再處理。
}

export function resetSecureConversation(peerAccountDigest, { reason = 'reset', source = 'resetSecureConversation' } = {}) {
  const key = toPeerKey({ peerAccountDigest });
  if (!key) return;
  const entry = ensureEntry(key);
  if (!entry) return;
  entry.pendingPromise = null;
  entry.attempts = 0;
  setStatus(key, STATUS_IDLE, { reason, source });
}

export function resetAllSecureConversations({ reason = 'reset-all', source = 'resetAllSecureConversations' } = {}) {
  for (const key of Array.from(peerStates.keys())) {
    resetSecureConversation(key, { reason, source });
  }
}

export const SECURE_CONVERSATION_STATUS = {
  IDLE: STATUS_IDLE,
  PENDING: STATUS_PENDING,
  READY: STATUS_READY,
  FAILED: STATUS_FAILED
};

export function listSecureConversationStatuses() {
  const out = [];
  for (const [key, entry] of peerStates.entries()) {
    out.push(cloneStatus(key, entry));
  }
  return out;
}

export function updateSecureConversationStatus(peerAccountDigest, status, { reason = 'manual', source = 'manual' } = {}) {
  const key = toPeerKey({ peerAccountDigest });
  if (!key) return null;
  const entry = ensureEntry(key);
  if (!entry) return null;

  if (Object.values(SECURE_CONVERSATION_STATUS).includes(status)) {
    return setStatus(key, status, { reason, source });
  }
  return null;
}
