// /app/features/secure-conversation-manager.js
// Central hub to coordinate Double Ratchet session readiness for each conversation peer.

import { drState, normalizePeerIdentity } from '../core/store.js';
import { getContactSecret } from '../core/contact-secrets.js';
import { ensureDrReceiverState, sendDrSessionAck, sendDrSessionInit } from './dr-session.js';
import { CONTROL_MESSAGE_TYPES, normalizeControlMessageType } from './secure-conversation-signals.js';

const STATUS_IDLE = 'idle';
const STATUS_PENDING = 'pending';
const STATUS_READY = 'ready';
const STATUS_FAILED = 'failed';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 400;
const ACK_TIMEOUT_MS = 10_000;
const SESSION_INIT_RETRY_LIMIT = 3;
const SESSION_INIT_RETRY_BACKOFF_MS = 5_000;

const listeners = new Set();
const peerStates = new Map();

function resolvePeerKey(value) {
  if (!value) return null;
  const identity = normalizePeerIdentity({
    peerAccountDigest: value?.peerAccountDigest ?? value?.accountDigest ?? value
  });
  return identity.key || null;
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
  const key = resolvePeerKey(peerAccountDigest);
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
      pendingPromise: null,
      control: null
    };
    peerStates.set(key, entry);
  }
  if (!entry.control) {
    entry.control = initControlState();
  }
  return entry;
}

function cloneStatus(key, entry) {
  if (!entry) {
    const controlSnapshot = {
      awaitingAck: false,
      pendingAck: false,
      ackDeadline: null,
      lastInitAt: null,
      lastAckAt: null,
      initSendCount: 0,
      lastRetryAt: null,
      lastAckTimeoutAt: null
    };
    return {
      peerAccountDigest: key,
      status: STATUS_IDLE,
      error: null,
      updatedAt: null,
      readyAt: null,
      attempts: 0,
      reason: null,
      source: null,
      control: controlSnapshot
    };
  }
  const ctrl = entry.control || initControlState();
  const controlSnapshot = {
    awaitingAck: !!ctrl.awaitingAck,
    pendingAck: !!ctrl.pendingAckResponse,
    ackDeadline: ctrl.ackDeadline || null,
    lastInitAt: ctrl.lastInitAt || null,
    lastAckAt: ctrl.lastAckAt || null,
    initSendCount: Number(ctrl.initSendCount) || 0,
    lastRetryAt: ctrl.lastRetryAt || null,
    lastAckTimeoutAt: ctrl.lastAckTimeoutAt || null
  };
  return {
    peerAccountDigest: key,
    status: entry.status,
    error: entry.error,
    updatedAt: entry.updatedAt || null,
    readyAt: entry.readyAt || null,
    attempts: entry.attempts || 0,
    reason: entry.reason || null,
    source: entry.source || null,
    control: controlSnapshot
  };
}

function emitStatus(key, entry, extra = {}) {
  if (!entry) return;
  const ctrl = entry.control || initControlState();
  const payload = {
    peerAccountDigest: key,
    status: entry.status,
    error: entry.error,
    updatedAt: entry.updatedAt,
    readyAt: entry.readyAt,
    attempts: entry.attempts,
    reason: extra.reason ?? entry.reason ?? null,
    source: extra.source ?? entry.source ?? null,
    control: {
      awaitingAck: !!ctrl.awaitingAck,
      pendingAck: !!ctrl.pendingAckResponse,
      ackDeadline: ctrl.ackDeadline || null,
      lastInitAt: ctrl.lastInitAt || null,
      lastAckAt: ctrl.lastAckAt || null,
      initSendCount: Number(ctrl.initSendCount) || 0,
      lastRetryAt: ctrl.lastRetryAt || null,
      lastAckTimeoutAt: ctrl.lastAckTimeoutAt || null
    }
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
  const peerKey = resolvePeerKey(key);
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

function hasReceiverReady(peerAccountDigest) {
  const key = resolvePeerKey(peerAccountDigest);
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

function initControlState() {
  return {
    awaitingAck: false,
    ackTimer: null,
    ackDeadline: null,
    lastInitAt: null,
    lastAckAt: null,
    pendingAckResponse: false,
    lastIncomingInitAt: null,
    initSendCount: 0,
    retryInFlight: false,
    lastRetryAt: null,
    lastAckTimeoutAt: null
  };
}

function clearAckTimer(entry) {
  if (entry?.control?.ackTimer) {
    try { clearTimeout(entry.control.ackTimer); } catch {}
    entry.control.ackTimer = null;
    entry.control.ackDeadline = null;
  }
}

function scheduleAckTimeout(key, entry) {
  if (!entry?.control) return;
  clearAckTimer(entry);
  entry.control.ackDeadline = Date.now() + ACK_TIMEOUT_MS;
  entry.control.ackTimer = setTimeout(() => {
    entry.control.ackTimer = null;
    entry.control.awaitingAck = false;
    entry.control.pendingAckResponse = false;
    entry.control.ackDeadline = null;
    entry.control.lastAckTimeoutAt = Date.now();
    if (hasReceiverReady(key)) {
      setStatus(key, STATUS_READY, {
        reason: 'ack-timeout-ready',
        source: 'control-message'
      });
      return;
    }
    void handleAckTimeout(key, entry);
  }, ACK_TIMEOUT_MS);
}

function markControlMessage(key, type, direction) {
  const entry = ensureEntry(key);
  if (!entry) return null;
  const ctrl = entry.control || (entry.control = initControlState());
  const now = Date.now();
  if (type === CONTROL_MESSAGE_TYPES.SESSION_INIT) {
    if (direction === 'outgoing') {
      ctrl.awaitingAck = true;
      ctrl.pendingAckResponse = false;
      ctrl.lastInitAt = now;
      ctrl.initSendCount = (Number(ctrl.initSendCount) || 0) + 1;
      ctrl.retryInFlight = false;
      ctrl.lastRetryAt = now;
      ctrl.lastAckTimeoutAt = null;
      scheduleAckTimeout(key, entry);
    } else {
      ctrl.pendingAckResponse = true;
      ctrl.awaitingAck = false;
      ctrl.lastIncomingInitAt = now;
      clearAckTimer(entry);
    }
  } else if (type === CONTROL_MESSAGE_TYPES.SESSION_ACK) {
    if (direction === 'incoming') {
      ctrl.awaitingAck = false;
      ctrl.pendingAckResponse = false;
      ctrl.lastAckAt = now;
      ctrl.initSendCount = 0;
      ctrl.retryInFlight = false;
      ctrl.lastRetryAt = null;
      ctrl.lastAckTimeoutAt = null;
      clearAckTimer(entry);
    } else {
      ctrl.awaitingAck = false;
      ctrl.lastAckAt = now;
      ctrl.initSendCount = 0;
      ctrl.retryInFlight = false;
      ctrl.lastRetryAt = null;
      ctrl.lastAckTimeoutAt = null;
      clearAckTimer(entry);
    }
  }
  return entry;
}

async function sendAckIfPending(key, { source = 'control-message' } = {}) {
  const entry = ensureEntry(key);
  if (!entry?.control?.pendingAckResponse) return;
  if (entry.control.awaitingAck) return; // already handling outgoing ack
  entry.control.pendingAckResponse = false;
  try {
    await sendDrSessionAck({ peerAccountDigest: key });
    markControlMessage(key, CONTROL_MESSAGE_TYPES.SESSION_ACK, 'outgoing');
    setStatus(key, STATUS_READY, { reason: 'session-ack-sent', source });
  } catch (err) {
    setStatus(key, STATUS_FAILED, { reason: 'session-ack-failed', source, error: err });
  }
}

function isSessionMissingError(err) {
  if (!err) return false;
  const message = typeof err === 'string' ? err : (err?.message || '');
  if (!message) return false;
  if (message.includes('缺少安全會話')) return true;
  const lowered = message.toLowerCase();
  return lowered.includes('session') && lowered.includes('missing');
}

function isLocalInitiator(key) {
  const secret = getContactSecret(key);
  const role = typeof secret?.role === 'string' ? secret.role.toLowerCase() : null;
  if (role === 'owner') return true;
  const holder = drState(key);
  const baseRole = typeof holder?.baseKey?.role === 'string' ? holder.baseKey.role.toLowerCase() : null;
  return baseRole === 'initiator';
}

async function triggerSessionInit(
  key,
  entry,
  { reason = 'session-init', source = 'control-message', force = false } = {}
) {
  if (!key) return false;
  const target = entry || ensureEntry(key);
  if (!target) return false;
  const ctrl = target.control || (target.control = initControlState());
  if (!isLocalInitiator(key)) return false;
  const sentCount = Number(ctrl.initSendCount) || 0;
  if (!force) {
    if (ctrl.awaitingAck || ctrl.retryInFlight) return false;
    if (sentCount >= SESSION_INIT_RETRY_LIMIT) return false;
    if (ctrl.lastInitAt && Date.now() - ctrl.lastInitAt < SESSION_INIT_RETRY_BACKOFF_MS) return false;
  } else if (sentCount >= SESSION_INIT_RETRY_LIMIT) {
    return false;
  }

  ctrl.retryInFlight = true;
  try {
    await sendDrSessionInit({ peerAccountDigest: key });
    markControlMessage(key, CONTROL_MESSAGE_TYPES.SESSION_INIT, 'outgoing');
    setStatus(key, STATUS_PENDING, { reason, source, attempts: target.attempts || 0 });
    return true;
  } catch (err) {
    setStatus(key, STATUS_FAILED, { reason: 'session-init-send-failed', source, error: err });
    console.warn('[secure-conversation] session-init send failed', err);
    return false;
  } finally {
    ctrl.retryInFlight = false;
    ctrl.lastRetryAt = Date.now();
  }
}

async function handleAckTimeout(key, entry) {
  if (!key) return;
  const target = entry || ensureEntry(key);
  if (!target) return;
  const ctrl = target.control || (target.control = initControlState());
  const sentCount = Number(ctrl.initSendCount) || 0;
  if (!isLocalInitiator(key) || sentCount >= SESSION_INIT_RETRY_LIMIT) {
    setStatus(key, STATUS_FAILED, {
      reason: 'ack-timeout',
      source: 'control-message',
      error: '等待 session ack 逾時'
    });
    return;
  }
  try {
    const triggered = await triggerSessionInit(key, target, {
      reason: 'session-init-retry',
      source: 'control-message',
      force: true
    });
    if (!triggered) {
      setStatus(key, STATUS_FAILED, {
        reason: 'ack-timeout',
        source: 'control-message',
        error: '等待 session ack 逾時'
      });
    }
  } catch (err) {
    setStatus(key, STATUS_FAILED, {
      reason: 'ack-timeout',
      source: 'control-message',
      error: err
    });
  }
}

export function subscribeSecureConversation(listener) {
  if (typeof listener !== 'function') throw new Error('listener 必須是函式');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSecureConversationStatus(peerAccountDigest) {
  const key = resolvePeerKey(peerAccountDigest);
  if (!key) return null;
  const entry = peerStates.get(key);
  return cloneStatus(key, entry);
}

export async function ensureSecureConversationReady({
  peerAccountDigest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  reason = 'ensure',
  source = 'ensureSecureConversationReady'
} = {}) {
  const key = resolvePeerKey(peerAccountDigest);
  if (!key) throw new Error('peerAccountDigest required');
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

  if (!hasReceiverReady(key) && isLocalInitiator(key)) {
    triggerSessionInit(key, entry, {
      reason: 'ensure-session-init',
      source
    }).catch((err) => {
      console.warn('[secure-conversation] trigger session-init failed', err);
    });
  }

  entry.attempts = 0;
  const worker = (async () => {
    let lastError = null;
    const deadline = Date.now() + Math.max(timeoutMs, pollIntervalMs);
    while (Date.now() <= deadline) {
      entry.attempts += 1;
      try {
        await ensureDrReceiverState({ peerAccountDigest: key });
        setStatus(key, STATUS_READY, { reason: 'ensure-success', source, attempts: entry.attempts });
        return cloneStatus(key, peerStates.get(key));
      } catch (err) {
        lastError = err;
        if (isSessionMissingError(err)) {
          triggerSessionInit(key, entry, {
            reason: 'ensure-session-init',
            source
          }).catch((triggerErr) => {
            console.warn('[secure-conversation] ensure trigger session-init failed', triggerErr);
          });
        }
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
  peerAccountDigest,
  messageType,
  direction,
  source = 'control-message'
} = {}) {
  const key = resolvePeerKey(peerAccountDigest);
  if (!key) return;
  const normalizedType = normalizeControlMessageType(messageType);
  if (!normalizedType) return;
  const resolvedDirection = (direction || 'incoming').toLowerCase() === 'outgoing' ? 'outgoing' : 'incoming';
  const entry = markControlMessage(key, normalizedType, resolvedDirection);
  if (!entry) return;

  if (normalizedType === CONTROL_MESSAGE_TYPES.SESSION_INIT) {
    const reason = resolvedDirection === 'outgoing' ? 'session-init-outgoing' : 'session-init-incoming';
    setStatus(key, STATUS_PENDING, {
      reason,
      source,
      attempts: entry.attempts || 0
    });
    if (resolvedDirection !== 'outgoing') {
      ensureSecureConversationReady({
        peerAccountDigest: key,
        reason: 'session-init',
        source
      })
        .then(() => sendAckIfPending(key, { source }))
        .catch((err) => {
          console.warn('[secure-conversation] ensure after session-init failed', err);
          setStatus(key, STATUS_FAILED, {
            reason: 'session-init-failed',
            source,
            error: err
          });
        });
    }
  } else if (normalizedType === CONTROL_MESSAGE_TYPES.SESSION_ACK) {
    if (resolvedDirection === 'incoming') {
      setStatus(key, STATUS_READY, {
        reason: 'session-ack',
        source,
        attempts: entry.attempts || 0
      });
    }
  }
}

export function resetSecureConversation(peerAccountDigest, { reason = 'reset', source = 'resetSecureConversation' } = {}) {
  const key = resolvePeerKey(peerAccountDigest);
  if (!key) return;
  const entry = ensureEntry(key);
  if (!entry) return;
  clearAckTimer(entry);
  entry.control = initControlState();
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
