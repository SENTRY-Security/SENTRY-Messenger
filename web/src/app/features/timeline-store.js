// Client-only append-only timeline store for user messages.
import { logCapped } from '../core/log.js';
import { MSG_SUBTYPE } from './semantic.js';

const USER_MESSAGE_TYPES = new Set([
  MSG_SUBTYPE.TEXT,
  MSG_SUBTYPE.MEDIA,
  MSG_SUBTYPE.CALL_LOG,
  MSG_SUBTYPE.PLACEHOLDER,
  MSG_SUBTYPE.SYSTEM,
  MSG_SUBTYPE.CONVERSATION_DELETED
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
    const existing = convMap.get(messageId);
    const isPlaceholder = existing?.msgType === MSG_SUBTYPE.PLACEHOLDER || existing?.isPlaceholder === true || existing?.kind === 'GAP_PLACEHOLDER';
    // [FIX] Allow overwriting if existing entry failed decryption
    const isFailedOrEncrypted = existing?.decrypted === false || existing?.error || existing?.status === 'failed';

    if (!isPlaceholder && !isFailedOrEncrypted) {
      // console.log('[timeline-store] appendUserMessage duplicate', { convId, messageId });
      return false;
    }
    // If it is a placeholder or failed, we fall through to overwrite/set
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
  try {
    console.log('[timeline-store] appendBatch entry', {
      count: entries?.length || 0,
      listeners: appendListeners.size,
      sampleId: entries?.[0]?.id || entries?.[0]?.messageId
    });
  } catch { }

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

  // console.log('[timeline-store] appendBatch START', { count: list.length });

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      skippedCount += 1;
      continue;
    }
    const convId = normalizeConversationId(entry.conversationId || entry.convId || entry.conversation_id);
    if (!batchConversationId && convId) batchConversationId = convId;
    const rawMessageId = entry.messageId || entry.id;
    const rawTs = entry.ts;

    // Schema Validation Helpers
    const idRawType = rawMessageId === null ? 'null' : typeof rawMessageId;
    const tsRawType = rawTs === null ? 'null' : typeof rawTs;
    const hasId = rawMessageId !== null && rawMessageId !== undefined
      && (typeof rawMessageId !== 'string' || rawMessageId.trim().length > 0);
    const hasTs = rawTs !== null && rawTs !== undefined;

    const idValid = typeof rawMessageId === 'string' && rawMessageId.trim().length > 0;
    const tsValid = typeof rawTs === 'number' && Number.isFinite(rawTs) && Number.isInteger(rawTs) && rawTs > 0;

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
      const existing = convMap.get(messageId);
      const isPlaceholder = existing?.msgType === MSG_SUBTYPE.PLACEHOLDER || existing?.isPlaceholder === true || existing?.kind === 'GAP_PLACEHOLDER';
      // [FIX] Allow overwriting if existing entry failed decryption or is explicitly marked as not decrypted
      const isFailedOrEncrypted = existing?.decrypted === false || existing?.error || existing?.status === 'failed';

      if (!isPlaceholder && !isFailedOrEncrypted) {
        skippedCount += 1;
        continue;
      }
      // Overwrite allowed
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

  // console.log('[timeline-store] appendBatch DONE', { appended: appendedEntries.length });

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
    timelineMap.set(convId, convMap);
  }
  const existing = convMap.get(messageId) || null;
  const stored = (entry && typeof entry === 'object') ? entry : {};
  const merged = existing ? { ...existing, ...stored } : { ...stored };
  merged.conversationId = convId;
  merged.messageId = messageId;
  merged.msgType = msgType || merged.msgType || merged.type || null;
  convMap.set(messageId, merged);
  if (merged.status === 'sent' && merged.pending === false && existing?.pending === true) {
    console.log('[timeline-store] upsertTimelineEntry: CLEARED PENDING', { msgId: messageId, counter: merged.counter });
  }
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
  let updatedCount = 0;
  for (const [key, entry] of convMap.entries()) {
    if (resolveEntryCounter(entry) !== counter) continue;
    const updated = { ...entry, status };
    if (status === 'sent' || status === 'delivered' || status === 'read') {
      updated.pending = false;
    }
    if (reason) updated.error = reason;
    convMap.set(key, updated);
    emitAppend({ conversationId: convId, entry: updated, updated: true });
    updatedCount++;
    // Do not return early, in case multiple messages share counter (unlikely but safe) (Wait, counter should be unique per sender)
    // Actually, return true after found is fine for single specific counter.
    console.log('[timeline-store] updateStatus success', { msgId: key, counter, status });
    return true;
  }
  console.warn('[timeline-store] updateStatus failed: entry not found', { conversationId: convId, counter, mapSize: convMap.size });
  return false;
}

export function updateMessageVaultCount(conversationId, messageId, count) {
  const convId = normalizeConversationId(conversationId);
  const mid = normalizeMessageId(messageId);
  if (!convId || !mid || !Number.isFinite(count)) return false;
  const convMap = timelineMap.get(convId);
  if (!(convMap instanceof Map)) return false;

  const existing = convMap.get(mid);
  if (!existing) return false;

  if (existing.vaultPutCount === count) return false;

  const updated = { ...existing, vaultPutCount: count };
  // Check if we can infer 'delivered' status
  // If count >= 2 (Sender + Receiver), it is effectively delivered
  if (count >= 2 && existing.status !== 'read' && existing.status !== 'delivered') {
    updated.status = 'delivered';
    updated.pending = false;
  }

  convMap.set(mid, updated);
  emitAppend({ conversationId: convId, entry: updated, updated: true });
  return true;
}

export function updateTimelineEntriesAsDelivered(conversationId, maxCounter) {
  const convId = normalizeConversationId(conversationId);
  const limit = Number(maxCounter);
  if (!convId || !Number.isFinite(limit)) return 0;
  const convMap = timelineMap.get(convId);
  if (!(convMap instanceof Map)) return 0;

  let count = 0;
  for (const [key, entry] of convMap.entries()) {
    const c = resolveEntryCounter(entry);
    if (c === null || c > limit) continue;
    // Update if not already delivered/read (assuming read > delivered)
    // Actually, 'read' implies delivered. So only update if status is 'sending' or 'sent' or 'pending'.
    if (entry.status === 'read' || entry.status === 'delivered') continue;

    const updated = { ...entry, status: 'delivered', pending: false };
    convMap.set(key, updated);
    emitAppend({ conversationId: convId, entry: updated, updated: true });
    count++;
  }
  return count;
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
  // [FIX] Sort by counter first (causal order) for same sender, then by timestamp
  list.sort((a, b) => {
    // 1. Primary: Counter (causal order) for same sender
    const counterA = resolveEntryCounter(a);
    const counterB = resolveEntryCounter(b);
    const senderA = resolveEntrySenderDeviceId(a);
    const senderB = resolveEntrySenderDeviceId(b);
    if (senderA && senderB && senderA === senderB && counterA !== null && counterB !== null && counterA !== counterB) {
      return counterA - counterB;
    }
    // 2. Secondary: Timestamp
    const tsA = resolveEntryTsMs(a);
    const tsB = resolveEntryTsMs(b);
    if (tsA !== tsB) return tsA - tsB;
    // 3. Fallback: Message ID
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
  try {
    console.log('[timeline-store] subscribeTimeline registered', {
      currentCount: appendListeners.size
    });
  } catch { }
  appendListeners.add(listener);
  return () => appendListeners.delete(listener);
}

export function removeMessagesMatching(conversationId, predicate) {
  const convId = normalizeConversationId(conversationId);
  if (!convId || typeof predicate !== 'function') return 0;
  const convMap = timelineMap.get(convId);
  if (!convMap) return 0;

  let count = 0;
  for (const [key, entry] of convMap.entries()) {
    if (predicate(entry)) {
      convMap.delete(key);
      count++;
    }
  }
  return count;
}

export function migrateTimelineConversation(fromId, toId) {
  const from = normalizeConversationId(fromId);
  const to = normalizeConversationId(toId);
  if (!from || !to || from === to) return false;

  const sourceMap = timelineMap.get(from);
  if (!sourceMap || sourceMap.size === 0) return false;

  let targetMap = timelineMap.get(to);
  if (!targetMap) {
    targetMap = new Map();
    timelineMap.set(to, targetMap);
  }

  console.log('[timeline-store] migrateTimelineConversation', { from, to, count: sourceMap.size });
  let movedCount = 0;

  for (const [msgId, entry] of sourceMap.entries()) {
    const movedEntry = { ...entry, conversationId: to };
    targetMap.set(msgId, movedEntry);
    movedCount++;
  }

  timelineMap.delete(from);
  console.log('[timeline-store] migration done', { movedCount });
  return true;
}
