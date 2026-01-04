// Client-only append-only timeline store for user messages.

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
  const directionalOrder = opts && typeof opts === 'object' ? opts.directionalOrder : null;

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      skippedCount += 1;
      continue;
    }
    const convId = normalizeConversationId(entry.conversationId || entry.convId || entry.conversation_id);
    const messageId = normalizeMessageId(entry.messageId || entry.id);
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
    const tsA = Number(a?.ts) || 0;
    const tsB = Number(b?.ts) || 0;
    if (tsA !== tsB) return tsA - tsB;
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
