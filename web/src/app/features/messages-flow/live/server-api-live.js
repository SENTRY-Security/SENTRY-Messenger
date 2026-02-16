// /app/features/messages-flow/live/server-api-live.js
// Server API adapter for live (B-route) flow.

import { listSecureMessages as apiListSecureMessages } from '../../../api/messages.js';

function resolveNextCursorTs(data) {
  if (data?.next_cursor_ts != null) return data.next_cursor_ts;
  if (data?.next_cursor?.ts != null) return data.next_cursor.ts;
  return null;
}

function resolveNextCursorId(data) {
  if (data?.next_cursor_id != null) return data.next_cursor_id;
  if (data?.next_cursor?.id != null) return data.next_cursor.id;
  return null;
}

function resolveNextCursor(data) {
  if (data?.next_cursor) return data.next_cursor;
  const ts = resolveNextCursorTs(data);
  const id = resolveNextCursorId(data);
  if (ts == null && id == null) return null;
  return { ts: ts ?? null, id: id ?? null };
}

function normalizeMessageIdValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function findItemByMessageId(items = [], messageId) {
  const target = normalizeMessageIdValue(messageId);
  if (!target || !Array.isArray(items) || !items.length) return null;
  for (const item of items) {
    const candidates = [
      item?.messageId,
      item?.message_id,
      item?.id,
      item?.serverMessageId,
      item?.server_message_id,
      item?.serverMsgId
    ];
    for (const candidate of candidates) {
      const normalized = normalizeMessageIdValue(candidate);
      if (normalized && normalized === target) return item;
    }
  }
  return null;
}

export async function fetchSecureMessageById({
  conversationId,
  messageId,
  getSecureMessageById = null
} = {}) {
  const base = {
    supported: false,
    item: null,
    errors: []
  };
  const targetId = normalizeMessageIdValue(messageId);
  if (!conversationId || !targetId) {
    return {
      ...base,
      errors: ['conversationId and messageId required']
    };
  }
  if (typeof getSecureMessageById !== 'function') {
    return base;
  }
  try {
    const { r, data } = await getSecureMessageById({ conversationId, messageId: targetId });
    const errors = Array.isArray(data?.errors) ? data.errors.slice() : [];
    if (!r?.ok && !errors.length) {
      const msg = data?.message || data?.error || (typeof data === 'string' ? data : null);
      if (msg) errors.push(msg);
    }
    let item = data?.item || data?.message || data?.msg || null;
    if (!item && Array.isArray(data?.items) && data.items.length === 1) {
      item = data.items[0];
    }
    if (!item && data && typeof data === 'object' && !Array.isArray(data)) {
      const hasCipher = Object.prototype.hasOwnProperty.call(data, 'ciphertext_b64')
        || Object.prototype.hasOwnProperty.call(data, 'ciphertextB64');
      if (hasCipher) item = data;
    }
    return {
      supported: true,
      item,
      errors
    };
  } catch (err) {
    const msg = err?.message || String(err);
    return {
      supported: true,
      item: null,
      errors: msg ? [msg] : []
    };
  }
}

export async function listSecureMessagesLive({
  conversationId,
  limit = 20,
  cursorTs = null,
  cursorId = null,
  listSecureMessages = apiListSecureMessages
} = {}) {
  const base = {
    items: [],
    errors: [],
    nextCursor: null
  };
  if (!conversationId) {
    return {
      ...base,
      errors: ['conversationId required']
    };
  }
  try {
    const { r, data } = await listSecureMessages({ conversationId, limit, cursorTs, cursorId });
    const items = Array.isArray(data?.items) ? data.items : [];
    const errors = Array.isArray(data?.errors) ? data.errors.slice() : [];
    if (!r?.ok && !errors.length) {
      const msg = data?.message || data?.error || (typeof data === 'string' ? data : null);
      if (msg) errors.push(msg);
    }
    return {
      items,
      errors,
      nextCursor: resolveNextCursor(data)
    };
  } catch (err) {
    const msg = err?.message || String(err);
    return {
      ...base,
      errors: msg ? [msg] : []
    };
  }
}

export function createLiveServerApi(deps = {}) {
  const listSecureMessages = deps.listSecureMessages || apiListSecureMessages;
  const getSecureMessageById = deps.getSecureMessageById || null;
  return {
    async listSecureMessagesLive(params = {}) {
      return listSecureMessagesLive({ ...params, listSecureMessages });
    },
    async fetchSecureMessageById(params = {}) {
      return fetchSecureMessageById({ ...params, getSecureMessageById });
    },
    findItemByMessageId
  };
}
