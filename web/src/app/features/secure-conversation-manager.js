// /app/features/secure-conversation-manager.js
// Central hub to coordinate Double Ratchet session readiness for each conversation peer.

import { drState } from '../core/store.js';
import { getContactSecret } from '../core/contact-secrets.js';
import { ensureDrReceiverState } from './dr-session.js';

const STATUS_IDLE = 'idle';
const STATUS_PENDING = 'pending';
const STATUS_READY = 'ready';
const STATUS_FAILED = 'failed';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 400;

const listeners = new Set();
const peerStates = new Map();

function normalizePeer(value) {
  return String(value || '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase() || null;
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

function ensureEntry(peerUidHex) {
  const key = normalizePeer(peerUidHex);
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
      peerUidHex: key,
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
    peerUidHex: key,
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
    peerUidHex: key,
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
  if (!key) return null;
  const entry = ensureEntry(key);
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
  emitStatus(key, entry, { reason, source });
  return entry;
}

function hasReceiverReady(peerUidHex) {
  const key = normalizePeer(peerUidHex);
  if (!key) return false;
  const holder = drState(key);
  if (!holder?.rk || !(holder.myRatchetPriv instanceof Uint8Array) || !(holder.myRatchetPub instanceof Uint8Array)) {
    return false;
  }
  const hasReceiveChain = holder?.ckR instanceof Uint8Array && holder.ckR.length > 0;
  if (hasReceiveChain) return true;
  const hasSendChain = holder?.ckS instanceof Uint8Array && holder.ckS.length > 0;
  const secretInfo = getContactSecret(key);
  const relationshipRole = typeof secretInfo?.role === 'string' ? secretInfo.role.toLowerCase() : null;
  const holderRole = typeof holder?.baseKey?.role === 'string' ? holder.baseKey.role.toLowerCase() : null;
  const isGuestLike = relationshipRole === 'guest' || holderRole === 'initiator';
  return !!(hasSendChain && isGuestLike);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function subscribeSecureConversation(listener) {
  if (typeof listener !== 'function') throw new Error('listener 必須是函式');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSecureConversationStatus(peerUidHex) {
  const key = normalizePeer(peerUidHex);
  if (!key) return null;
  const entry = peerStates.get(key);
  return cloneStatus(key, entry);
}

export async function ensureSecureConversationReady({
  peerUidHex,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  reason = 'ensure',
  source = 'ensureSecureConversationReady'
} = {}) {
  const key = normalizePeer(peerUidHex);
  if (!key) throw new Error('peerUidHex required');
  const entry = ensureEntry(key);
  if (!entry) throw new Error('無法建立狀態容器');

  if (hasReceiverReady(key)) {
    if (entry.status !== STATUS_READY) {
      setStatus(key, STATUS_READY, { reason: 'already-ready', source, attempts: entry.attempts || 0 });
    }
    return cloneStatus(key, peerStates.get(key));
  }

  if (entry.pendingPromise) {
    return entry.pendingPromise;
  }

  entry.attempts = 0;
  const worker = (async () => {
    let lastError = null;
    const deadline = Date.now() + Math.max(timeoutMs, pollIntervalMs);
    while (Date.now() <= deadline) {
      entry.attempts += 1;
      try {
        await ensureDrReceiverState({ peerUidHex: key });
        setStatus(key, STATUS_READY, { reason: 'ensure-success', source, attempts: entry.attempts });
        return cloneStatus(key, peerStates.get(key));
      } catch (err) {
        lastError = err;
        if (hasReceiverReady(key)) {
          setStatus(key, STATUS_READY, { reason: 'ensure-late-success', source, attempts: entry.attempts });
          return cloneStatus(key, peerStates.get(key));
        }
      }
      await delay(pollIntervalMs);
    }
    const error = lastError || new Error('建立安全對話逾時');
    setStatus(key, STATUS_FAILED, { reason: 'timeout', source, attempts: entry.attempts, error });
    throw error;
  })();

  entry.pendingPromise = worker.finally(() => {
    const current = peerStates.get(key);
    if (current) current.pendingPromise = null;
  });

  setStatus(key, STATUS_PENDING, { reason, source, attempts: entry.attempts });

  return entry.pendingPromise;
}

export function handleSecureConversationControlMessage({
  peerUidHex,
  messageType,
  direction,
  source = 'control-message'
} = {}) {
  const key = normalizePeer(peerUidHex);
  if (!key || messageType !== 'session-init') return;
  const entry = ensureEntry(key);
  if (!entry) return;
  if (entry.status !== STATUS_READY) {
    setStatus(key, STATUS_PENDING, {
      reason: direction === 'outgoing' ? 'session-init-outgoing' : 'session-init-incoming',
      source,
      attempts: entry.attempts || 0
    });
  }
  ensureSecureConversationReady({ peerUidHex: key, reason: 'session-init', source }).catch((err) => {
    console.warn('[secure-conversation] ensure after session-init failed', err);
  });
}

export function resetSecureConversation(peerUidHex, { reason = 'reset', source = 'resetSecureConversation' } = {}) {
  const key = normalizePeer(peerUidHex);
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
