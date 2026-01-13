// Client-only append-only timeline store for user messages.
import { logCapped } from '../core/log.js';
import { MSG_SUBTYPE } from './semantic.js';

const USER_MESSAGE_TYPES = new Set([
  MSG_SUBTYPE.TEXT,
  MSG_SUBTYPE.MEDIA,
  MSG_SUBTYPE.CALL_LOG,
  MSG_SUBTYPE.PLACEHOLDER
]);
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

function normalizeCounterValue(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function resolveEntryTsMs(entry) {
  const tsMs = Number(entry?.tsMs);
  if (Number.isFinite(tsMs)) return tsMs;

  const ts = Number(entry?.ts);
  if (Number.isFinite(ts)) {
    // Heuristic: if < 10^11 (year 5138), assume seconds and convert
    if (ts < 100000000000) {
      // console.warn('[timeline-store] legacy ts conversion', { id: entry?.messageId });
      return ts * 1000;
    }
    return ts;
  }
  return 0;
}

function resolveEntrySeq(entry) {
  const seqRaw = Number(entry?.tsSeq);
  return Number.isFinite(seqRaw) ? seqRaw : null;
}

export function resolveEntryCounter(entry) {
  const direct = normalizeCounterValue(entry?.counter ?? entry?.headerCounter ?? entry?.header_counter);
  if (direct !== null) return direct;
  const header = entry?.header && typeof entry.header === 'object' ? entry.header : null;
  return normalizeCounterValue(header?.n ?? header?.counter);
}

function resolveEntrySenderDeviceId(entry) {
  return entry?.senderDeviceId
    || entry?.sender_device_id
    || entry?.meta?.senderDeviceId
    || entry?.meta?.sender_device_id
    || entry?.header?.device_id
    || null;
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
  if (msgType && !USER_MESSAGE_TYPES.has(msgType)) {
    console.warn('[timeline-store] appendUserMessage rejected: invalid type', { convId, messageId, msgType, allowed: Array.from(USER_MESSAGE_TYPES) });
    return false;
  }

  let convMap = timelineMap.get(convId);
  if (!convMap) {
    convMap = new Map();
    timelineMap.set(convId, convMap);
  }
  if (convMap.has(messageId)) {
    // console.log('[timeline-store] appendUserMessage duplicate', { convId, messageId });
    return false;
  }

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

export function upsertTimelineEntry(conversationId, entry = {}) {
  const convId = normalizeConversationId(conversationId);
  const messageId = normalizeMessageId(entry.messageId || entry.id);
  const msgType = normalizeMsgType(entry.msgType || entry.type || entry.subtype);
  if (!convId || !messageId) return { ok: false };
  if (msgType && !USER_MESSAGE_TYPES.has(msgType)) return { ok: false };
  let convMap = timelineMap.get(convId);
  if (!convMap) {
    convMap = new Map();
    timelineMap.set(convId, convMap);
  }
  const existing = convMap.get(messageId) || null;
  const stored = (entry && typeof entry === 'object') ? entry : {};
  const merged = existing ? { ...existing, ...stored } : { ...stored };
  merged.conversationId = convId;
  merged.messageId = messageId;
  merged.msgType = msgType || merged.msgType || merged.type || null;
  convMap.set(messageId, merged);
  emitAppend({ conversationId: convId, entry: merged, updated: !!existing });
  return { ok: true, updated: !!existing, entry: merged };
}

export function findTimelineEntryByCounter(conversationId, counter) {
  const convId = normalizeConversationId(conversationId);
  if (!convId || !Number.isFinite(counter)) return null;
  const convMap = timelineMap.get(convId);
  if (!(convMap instanceof Map)) return null;
  for (const entry of convMap.values()) {
    if (resolveEntryCounter(entry) === counter) return entry;
  }
  return null;
}

export function replaceTimelineEntryByCounter(conversationId, counter, entry = {}) {
  const convId = normalizeConversationId(conversationId);
  if (!convId || !Number.isFinite(counter)) return { ok: false };
  let convMap = timelineMap.get(convId);
  let replaced = false;
  if (convMap instanceof Map) {
    for (const [key, existing] of convMap.entries()) {
      if (resolveEntryCounter(existing) === counter) {
        convMap.delete(key);
        replaced = true;
        break;
      }
    }
  }
  const result = upsertTimelineEntry(convId, entry);
  return { ok: !!result?.ok, replaced, entry: result?.entry || null };
}

export function updateTimelineEntryStatusByCounter(conversationId, counter, status, { reason = null } = {}) {
  const convId = normalizeConversationId(conversationId);
  if (!convId || !Number.isFinite(counter)) return false;
  const convMap = timelineMap.get(convId);
  if (!(convMap instanceof Map)) return false;
  for (const [key, entry] of convMap.entries()) {
    if (resolveEntryCounter(entry) !== counter) continue;
    const updated = { ...entry, status };
    if (reason) updated.error = reason;
    convMap.set(key, updated);
    emitAppend({ conversationId: convId, entry: updated, updated: true });
    return true;
  }
  return false;
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
  if (!convMap || convMap.size === 0) {
    return [];
  }
  const list = Array.from(convMap.values()).filter(Boolean);
  list.sort((a, b) => {
    // Defensive defaults only; schema drops should prevent missing ts/id from entering the store.
    const tsA = resolveEntryTsMs(a);
    const tsB = resolveEntryTsMs(b);
    if (tsA !== tsB) return tsA - tsB;
    const counterA = resolveEntryCounter(a);
    const counterB = resolveEntryCounter(b);
    const senderA = resolveEntrySenderDeviceId(a);
    const senderB = resolveEntrySenderDeviceId(b);
    if (senderA && senderB && senderA === senderB && counterA !== null && counterB !== null && counterA !== counterB) {
      return counterA - counterB;
    }
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
  if (typeof listener !== 'function') return () => { };
  appendListeners.add(listener);
  return () => appendListeners.delete(listener);
}
