// Client-only append-only timeline store for user messages.
import { logCapped } from '../core/log.js';

const USER_MESSAGE_TYPES = new Set(['text', 'media', 'call-log']);
const timelineMap = new Map(); // conversationId -> Map(messageId -> entry)
const appendListeners = new Set();

function normalizeConversationId(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str || null;
}

function normalizeMessageId(value) {
  if (!value) return null;
  const str = String(value).trim();
  return str || null;
}

function normalizeMsgType(value) {
  if (!value || typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return lower || null;
}

function resolveEntryTsMs(entry) {
  const tsMsRaw = Number(entry?.tsMs);
  if (Number.isFinite(tsMsRaw)) return tsMsRaw;
  const tsRaw = Number(entry?.ts);
  if (!Number.isFinite(tsRaw)) return 0;
  if (tsRaw > 10_000_000_000) return tsRaw;
  return tsRaw * 1000;
}

function resolveEntrySeq(entry) {
  const seqRaw = Number(entry?.tsSeq);
  return Number.isFinite(seqRaw) ? seqRaw : null;
}

function emitAppend(event) {
  for (const listener of Array.from(appendListeners)) {
    try {
      listener(event);
    } catch {
      /* ignore listener errors */
    }
  }
}

export function appendUserMessage(conversationId, entry = {}) {
  const convId = normalizeConversationId(conversationId);
  const messageId = normalizeMessageId(entry.messageId || entry.id);
  const msgType = normalizeMsgType(entry.msgType || entry.type || entry.subtype);
  if (!convId || !messageId) return false;
  if (msgType && !USER_MESSAGE_TYPES.has(msgType)) return false;

  let convMap = timelineMap.get(convId);
  if (!convMap) {
    convMap = new Map();
    timelineMap.set(convId, convMap);
  }
  if (convMap.has(messageId)) return false;

  const stored = (entry && typeof entry === 'object') ? entry : {};
  stored.conversationId = convId;
  stored.messageId = messageId;
  stored.msgType = msgType || stored.msgType || stored.type || null;
  convMap.set(messageId, stored);
  emitAppend({ conversationId: convId, entry: stored });
  return true;
}

export function appendBatch(entries = [], opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    return { appendedCount: 0, skippedCount: 0, appendedEntries: [] };
  }
  const appendedEntries = [];
  const grouped = new Map();
  let skippedCount = 0;
  let schemaDroppedCount = 0;
  let batchConversationId = null;
  const directionalOrder = opts && typeof opts === 'object' ? opts.directionalOrder : null;

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      skippedCount += 1;
      continue;
    }
    const convId = normalizeConversationId(entry.conversationId || entry.convId || entry.conversation_id);
    if (!batchConversationId && convId) batchConversationId = convId;
    const rawMessageId = entry.messageId || entry.id;
    const rawTs = entry.ts;
    const idRawType = rawMessageId === null ? 'null' : typeof rawMessageId;
    const tsRawType = rawTs === null ? 'null' : typeof rawTs;
    const hasId = rawMessageId !== null && rawMessageId !== undefined
      && (typeof rawMessageId !== 'string' || rawMessageId.trim().length > 0);
    const hasTs = rawTs !== null && rawTs !== undefined;
    const idValid = typeof rawMessageId === 'string' && rawMessageId.trim().length > 0;
    const tsValid = typeof rawTs === 'number' && Number.isFinite(rawTs)
      && Number.isInteger(rawTs) && rawTs > 0;
    let reasonCode = null;
    if (!idValid) {
      reasonCode = hasId ? 'INVALID_ID' : 'MISSING_ID';
    } else if (!tsValid) {
      reasonCode = hasTs ? 'INVALID_TS' : 'MISSING_TS';
    }
    if (reasonCode) {
      schemaDroppedCount += 1;
      skippedCount += 1;
      logCapped('messageItemSchemaDropTrace', {
        conversationId: convId || null,
        reasonCode,
        hasId,
        hasTs,
        tsRawType,
        idRawType,
        sampleIdPrefix8: idValid ? rawMessageId.trim().slice(0, 8) : null,
        sampleTs: hasTs ? rawTs : null,
        stage: 'P2_TIMELINE_STORE'
      }, 5);
      continue;
    }
    const messageId = normalizeMessageId(rawMessageId);
    const msgType = normalizeMsgType(entry.msgType || entry.type || entry.subtype);
    if (!convId || !messageId) {
      skippedCount += 1;
      continue;
    }
    if (msgType && !USER_MESSAGE_TYPES.has(msgType)) {
      skippedCount += 1;
      continue;
    }

    let convMap = timelineMap.get(convId);
    if (!convMap) {
      convMap = new Map();
      timelineMap.set(convId, convMap);
    }
    if (convMap.has(messageId)) {
      skippedCount += 1;
      continue;
    }
    const stored = entry && typeof entry === 'object' ? entry : {};
    stored.conversationId = convId;
    stored.messageId = messageId;
    stored.msgType = msgType || stored.msgType || stored.type || null;
    convMap.set(messageId, stored);
    appendedEntries.push(stored);

    const group = grouped.get(convId) || [];
    group.push(stored);
    if (!grouped.has(convId)) grouped.set(convId, group);
  }

  for (const [convId, groupEntries] of grouped.entries()) {
    const lastEntry = groupEntries[groupEntries.length - 1] || null;
    emitAppend({
      conversationId: convId,
      entry: lastEntry,
      entries: groupEntries,
      directionalOrder: directionalOrder || null
    });
  }

  logCapped('timelineBatchAssertTrace', {
    conversationId: batchConversationId || null,
    batchSize: list.length,
    droppedCount: schemaDroppedCount,
    reasonCode: schemaDroppedCount > 0 ? 'SCHEMA_DROP' : 'SCHEMA_OK',
    stage: 'APPEND_BATCH'
  }, 5);

  return { appendedCount: appendedEntries.length, skippedCount, appendedEntries };
}

export function hasMessage(conversationId, messageId) {
  const convId = normalizeConversationId(conversationId);
  const mid = normalizeMessageId(messageId);
  if (!convId || !mid) return false;
  const convMap = timelineMap.get(convId);
  return convMap instanceof Map && convMap.has(mid);
}

export function getTimeline(conversationId) {
  const convId = normalizeConversationId(conversationId);
  if (!convId) return [];
  const convMap = timelineMap.get(convId);
  if (!(convMap instanceof Map) || !convMap.size) return [];
  const list = Array.from(convMap.values()).filter(Boolean);
  list.sort((a, b) => {
    // Defensive defaults only; schema drops should prevent missing ts/id from entering the store.
    const tsA = resolveEntryTsMs(a);
    const tsB = resolveEntryTsMs(b);
    if (tsA !== tsB) return tsA - tsB;
    const seqA = resolveEntrySeq(a);
    const seqB = resolveEntrySeq(b);
    if (seqA !== null && seqB !== null && seqA !== seqB) return seqA - seqB;
    const idA = normalizeMessageId(a?.messageId || a?.id) || '';
    const idB = normalizeMessageId(b?.messageId || b?.id) || '';
    return idA.localeCompare(idB);
  });
  return list;
}

export function clearConversation(conversationId) {
  const convId = normalizeConversationId(conversationId);
  if (!convId) return;
  timelineMap.delete(convId);
}

export function subscribeTimeline(listener) {
  if (typeof listener !== 'function') return () => {};
  appendListeners.add(listener);
  return () => appendListeners.delete(listener);
}
