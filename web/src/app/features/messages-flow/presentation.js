// Presentation adapter for replay outputs. Placeholder logic is owned by UI; stub only here.

import { logCapped } from '../../core/log.js';

const GAP_PLACEHOLDER_LOG_CAP = 5;
const GAP_PLACEHOLDER_STATUS = Object.freeze({
  PENDING: 'pending',
  RESOLVED: 'resolved',
  FAILED: 'failed'
});

function slicePrefix(value, len = 8) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return null;
  return str.slice(0, len);
}

function normalizeConversationId(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str ? str : null;
}

function normalizeCounter(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (!Number.isInteger(num)) return null;
  if (num <= 0) return null;
  return num;
}

function createGapPlaceholderEntry(counter) {
  const now = Date.now();
  return {
    counter,
    status: GAP_PLACEHOLDER_STATUS.PENDING,
    reveal: false,
    createdAtMs: now,
    updatedAtMs: now
  };
}

export function createMessagePresentation(deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  const gapByConversation = new Map();

  const getConversationMap = (conversationId) => {
    let entry = gapByConversation.get(conversationId);
    if (!entry) {
      entry = new Map();
      gapByConversation.set(conversationId, entry);
    }
    return entry;
  };

  const ensureGapPlaceholders = (conversationId, fromCounter, toCounter) => {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const startCounter = normalizeCounter(fromCounter);
    const endCounter = normalizeCounter(toCounter);
    const conversationIdPrefix8 = slicePrefix(normalizedConversationId, 8);

    if (!normalizedConversationId) {
      logger('gapPlaceholderEnsureTrace', {
        conversationIdPrefix8,
        fromCounter: startCounter ?? null,
        toCounter: endCounter ?? null,
        ok: false,
        reasonCode: 'MISSING_CONVERSATION_ID',
        addedCount: 0,
        existingCount: 0
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: false, reasonCode: 'MISSING_CONVERSATION_ID', addedCount: 0, existingCount: 0 };
    }

    if (!Number.isFinite(startCounter) || !Number.isFinite(endCounter)) {
      logger('gapPlaceholderEnsureTrace', {
        conversationIdPrefix8,
        fromCounter: startCounter ?? null,
        toCounter: endCounter ?? null,
        ok: false,
        reasonCode: 'INVALID_COUNTER_RANGE',
        addedCount: 0,
        existingCount: 0
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: false, reasonCode: 'INVALID_COUNTER_RANGE', addedCount: 0, existingCount: 0 };
    }

    if (startCounter > endCounter) {
      logger('gapPlaceholderEnsureTrace', {
        conversationIdPrefix8,
        fromCounter: startCounter,
        toCounter: endCounter,
        ok: false,
        reasonCode: 'INVALID_COUNTER_ORDER',
        addedCount: 0,
        existingCount: 0
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: false, reasonCode: 'INVALID_COUNTER_ORDER', addedCount: 0, existingCount: 0 };
    }

    const entry = getConversationMap(normalizedConversationId);
    let addedCount = 0;
    let existingCount = 0;

    for (let counter = startCounter; counter <= endCounter; counter += 1) {
      if (entry.has(counter)) {
        existingCount += 1;
        continue;
      }
      entry.set(counter, createGapPlaceholderEntry(counter));
      addedCount += 1;
    }

    logger('gapPlaceholderEnsureTrace', {
      conversationIdPrefix8,
      fromCounter: startCounter,
      toCounter: endCounter,
      ok: true,
      reasonCode: addedCount > 0 ? null : 'NOOP',
      addedCount,
      existingCount
    }, GAP_PLACEHOLDER_LOG_CAP);

    return { ok: true, addedCount, existingCount };
  };

  const resolveGapPlaceholder = (conversationId, counter, commitEvent = null) => {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const normalizedCounter = normalizeCounter(counter);
    const conversationIdPrefix8 = slicePrefix(normalizedConversationId, 8);

    if (!normalizedConversationId) {
      logger('gapPlaceholderResolveTrace', {
        conversationIdPrefix8,
        counter: normalizedCounter ?? null,
        ok: false,
        reasonCode: 'MISSING_CONVERSATION_ID',
        resolved: false
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: false, resolved: false, reasonCode: 'MISSING_CONVERSATION_ID' };
    }

    if (!Number.isFinite(normalizedCounter)) {
      logger('gapPlaceholderResolveTrace', {
        conversationIdPrefix8,
        counter: normalizedCounter ?? null,
        ok: false,
        reasonCode: 'INVALID_COUNTER',
        resolved: false
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: false, resolved: false, reasonCode: 'INVALID_COUNTER' };
    }

    if (!commitEvent || typeof commitEvent !== 'object') {
      logger('gapPlaceholderResolveTrace', {
        conversationIdPrefix8,
        counter: normalizedCounter,
        ok: false,
        reasonCode: 'MISSING_COMMIT_EVENT',
        resolved: false
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: false, resolved: false, reasonCode: 'MISSING_COMMIT_EVENT' };
    }

    if (commitEvent.conversationId && commitEvent.conversationId !== normalizedConversationId) {
      logger('gapPlaceholderResolveTrace', {
        conversationIdPrefix8,
        counter: normalizedCounter,
        ok: false,
        reasonCode: 'CONVERSATION_ID_MISMATCH',
        resolved: false
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: false, resolved: false, reasonCode: 'CONVERSATION_ID_MISMATCH' };
    }

    if (Number.isFinite(commitEvent.counter) && commitEvent.counter !== normalizedCounter) {
      logger('gapPlaceholderResolveTrace', {
        conversationIdPrefix8,
        counter: normalizedCounter,
        ok: false,
        reasonCode: 'COUNTER_MISMATCH',
        resolved: false
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: false, resolved: false, reasonCode: 'COUNTER_MISMATCH' };
    }

    if (commitEvent.ok !== true) {
      logger('gapPlaceholderResolveTrace', {
        conversationIdPrefix8,
        counter: normalizedCounter,
        ok: false,
        reasonCode: commitEvent.reasonCode || 'COMMIT_NOT_OK',
        resolved: false
      }, GAP_PLACEHOLDER_LOG_CAP);
      return {
        ok: false,
        resolved: false,
        reasonCode: commitEvent.reasonCode || 'COMMIT_NOT_OK'
      };
    }

    if (commitEvent.didVaultPut === false) {
      logger('gapPlaceholderResolveTrace', {
        conversationIdPrefix8,
        counter: normalizedCounter,
        ok: false,
        reasonCode: 'VAULT_PUT_MISSING',
        resolved: false
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: false, resolved: false, reasonCode: 'VAULT_PUT_MISSING' };
    }

    const entry = gapByConversation.get(normalizedConversationId);
    const placeholder = entry ? entry.get(normalizedCounter) : null;
    if (!placeholder) {
      logger('gapPlaceholderResolveTrace', {
        conversationIdPrefix8,
        counter: normalizedCounter,
        ok: false,
        reasonCode: 'PLACEHOLDER_MISSING',
        resolved: false
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: false, resolved: false, reasonCode: 'PLACEHOLDER_MISSING' };
    }

    if (placeholder.status === GAP_PLACEHOLDER_STATUS.RESOLVED) {
      logger('gapPlaceholderResolveTrace', {
        conversationIdPrefix8,
        counter: normalizedCounter,
        ok: true,
        reasonCode: 'ALREADY_RESOLVED',
        resolved: false
      }, GAP_PLACEHOLDER_LOG_CAP);
      return { ok: true, resolved: false, reasonCode: 'ALREADY_RESOLVED' };
    }

    const now = Date.now();
    placeholder.status = GAP_PLACEHOLDER_STATUS.RESOLVED;
    placeholder.reveal = true;
    placeholder.resolvedAtMs = now;
    placeholder.updatedAtMs = now;

    logger('gapPlaceholderResolveTrace', {
      conversationIdPrefix8,
      counter: normalizedCounter,
      ok: true,
      reasonCode: null,
      resolved: true
    }, GAP_PLACEHOLDER_LOG_CAP);

    logger('gapPlaceholderRevealTrace', {
      conversationIdPrefix8,
      counter: normalizedCounter,
      ok: true,
      resolved: true,
      reasonCode: null
    }, GAP_PLACEHOLDER_LOG_CAP);

    return { ok: true, resolved: true, reasonCode: null };
  };

  const getGapPlaceholder = (conversationId, counter) => {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const normalizedCounter = normalizeCounter(counter);

    if (!normalizedConversationId || !Number.isFinite(normalizedCounter)) {
      return null;
    }

    const entry = gapByConversation.get(normalizedConversationId);
    const placeholder = entry ? entry.get(normalizedCounter) : null;
    if (!placeholder) return null;

    return {
      counter: placeholder.counter,
      status: placeholder.status,
      reveal: placeholder.reveal === true,
      createdAtMs: placeholder.createdAtMs ?? null,
      updatedAtMs: placeholder.updatedAtMs ?? null,
      resolvedAtMs: placeholder.resolvedAtMs ?? null
    };
  };

  const handleCommitEvent = (commitEvent = null) => {
    if (!commitEvent || typeof commitEvent !== 'object') {
      return { ok: false, resolved: false, reasonCode: 'INVALID_COMMIT_EVENT' };
    }

    const conversationId = normalizeConversationId(commitEvent.conversationId);
    const counter = normalizeCounter(commitEvent.counter);

    return resolveGapPlaceholder(conversationId, counter, commitEvent);
  };

  return {
    // TODO: apply decrypted message to UI state.
    applyDecryptedMessage() {
      throw new Error('messages-flow presentation not implemented');
    },

    // TODO: mark decrypt failures for UI.
    markDecryptFailed() {
      throw new Error('messages-flow presentation not implemented');
    },

    ensureGapPlaceholders,
    getGapPlaceholder,
    resolveGapPlaceholder,
    handleCommitEvent
  };
}
