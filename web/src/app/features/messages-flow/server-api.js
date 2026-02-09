// /app/features/messages-flow/server-api.js
// Server API adapter for replay-safe message flow.

import {
  listSecureMessages as apiListSecureMessages,
  getSecureMessageByCounter as apiGetSecureMessageByCounter,
  fetchSecureMaxCounter as apiFetchSecureMaxCounter
} from '../../api/messages.js';

function resolveListSecureError(data) {
  if (data?.message) return data.message;
  if (data?.error) return data.error;
  if (typeof data === 'string') return data;
  return 'listSecureMessages failed';
}

function resolveMaxCounterError(data) {
  if (data?.message) return data.message;
  if (data?.error) return data.error;
  if (typeof data === 'string') return data;
  return 'fetchSecureMaxCounter failed';
}

function resolveByCounterError(data) {
  if (data?.message) return data.message;
  if (data?.error) return data.error;
  if (typeof data === 'string') return data;
  return 'getSecureMessageByCounter failed';
}

function resolveSecureMessageItem(data) {
  if (data?.item) return data.item;
  if (data?.message && typeof data.message === 'object') return data.message;
  if (data?.msg && typeof data.msg === 'object') return data.msg;
  if (Array.isArray(data?.items) && data.items.length === 1) return data.items[0];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const hasCipher = Object.prototype.hasOwnProperty.call(data, 'ciphertext_b64')
      || Object.prototype.hasOwnProperty.call(data, 'ciphertextB64');
    if (hasCipher) return data;
  }
  return null;
}

function resolveNextCursor(data) {
  // 1. Standard CamelCase
  if (data?.nextCursor) return data.nextCursor;

  // 2. Snake Case (Common in Python/Ruby/Go backends)
  if (data?.next_cursor) return data.next_cursor;

  // 3. Generic Cursor
  if (data?.cursor) return data.cursor;

  // 4. Nested Pagination Object
  if (data?.pagination) {
    if (data.pagination.nextCursor) return data.pagination.nextCursor;
    if (data.pagination.next_cursor) return data.pagination.next_cursor;
    if (data.pagination.cursor) return data.pagination.cursor;
  }

  // 5. Explicit TS fields
  if (data?.nextCursorTs != null) return { ts: data.nextCursorTs, id: null };
  if (data?.next_cursor_ts != null) return { ts: data.next_cursor_ts, id: null };
  if (data?.cursorTs != null) return { ts: data.cursorTs, id: null };

  return null;
}

export async function listSecureMessagesForReplay({
  conversationId,
  limit = 20,
  cursorTs,
  cursorId,
  includeKeys = true,
  listSecureMessages = apiListSecureMessages
} = {}) {
  const { r, data } = await listSecureMessages({
    conversationId,
    limit,
    cursorTs,
    cursorId,
    includeKeys
  });
  if (!r?.ok) {
    throw new Error(resolveListSecureError(data));
  }
  return {
    items: Array.isArray(data?.items) ? data.items.map(normalizeServerItem) : [],
    errors: Array.isArray(data?.errors) ? data.errors : [],
    nextCursor: resolveNextCursor(data),
    keys: normalizeServerKeys(data?.keys)
  };
}

function normalizeServerKeys(keys) {
  if (!keys || typeof keys !== 'object') return null;
  const normalized = {};
  for (const [k, v] of Object.entries(keys)) {
    // [FIX] Ensure key is UUID (if possible) for lookup consistency
    // Valid for both 'message_id' (snake) and 'messageId' (camel)
    if (k && k.length === 36) normalized[k] = v;
    else normalized[k] = v; // Keep original if not UUID-like (fallback)
  }
  return normalized;
}

function normalizeServerItem(item) {
  if (!item) return item;
  // [STRICT SERIALIZATION] Enforce canonical 'ts' field at Edge.
  // 1. D1/Server Standard: snake_case 'created_at' (seconds or ms?) usually seconds from D1.
  // 2. Legacy/Internal: 'ts' (usually seconds).
  // 3. Header Fallback: 'header.ts' (client-generated).
  let val = item.created_at ?? item.createdAt ?? item.ts ?? item.timestamp ?? item.header?.ts ?? item.header?.created_at;

  const num = Number(val);
  if (Number.isFinite(num) && num > 0) {
    item.ts = num; // Canonicalize
  }

  // [STRICT SERIALIZATION] Enforce canonical 'messageId' (camelCase).
  // Downstream consumers (Vault, UI) expect 'messageId'.
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isUuid = (val) => typeof val === 'string' && val.length === 36 && UUID_REGEX.test(val);

  if (!item.messageId) {
    // 1. server_message_id (Standard API) -> UUID
    // 2. message_id (Legacy API) -> UUID
    // 3. id (D1/Row ID, if UUID) -> UUID ONLY
    if (isUuid(item.server_message_id)) item.messageId = item.server_message_id;
    else if (isUuid(item.message_id)) item.messageId = item.message_id;
    else if (isUuid(item.id)) item.messageId = item.id;
  }

  return item;
};

export async function fetchSecureMaxCounter({
  conversationId,
  senderDeviceId,
  fetchSecureMaxCounter: fetchMaxCounter = apiFetchSecureMaxCounter
} = {}) {
  const { r, data } = await fetchMaxCounter({ conversationId, senderDeviceId });
  if (!r?.ok) {
    throw new Error(resolveMaxCounterError(data));
  }
  const maxCounterRaw = data?.maxCounter ?? data?.max_counter ?? null;
  const maxCounter = Number.isFinite(Number(maxCounterRaw)) ? Number(maxCounterRaw) : null;
  return { maxCounter };
}

export async function getSecureMessageByCounter({
  conversationId,
  counter,
  senderDeviceId,
  includeKeys = false, // [FIX] Support keys
  getSecureMessageByCounter: fetchByCounter = apiGetSecureMessageByCounter
} = {}) {
  const { r, data } = await fetchByCounter({ conversationId, counter, senderDeviceId, includeKeys });
  if (!r?.ok) {
    throw new Error(resolveByCounterError(data));
  }
  const item = resolveSecureMessageItem(data);
  if (!item) {
    throw new Error('getSecureMessageByCounter missing item');
  }
  // [FIX] Return keys if requested (critical for gap filling)
  const keys = data?.keys || null;
  return { item, keys };
}

// [GAP-COUNT] Precise Offline Unread Counting
export async function getSecureGapCount({
  conversationId,
  minCounter,
  maxCounter,
  excludeSenderAccountDigest,
  getSecureGapCount: fetchGapCount = apiGetSecureGapCount
} = {}) {
  const { r, data } = await fetchGapCount({ conversationId, minCounter, maxCounter, excludeSenderAccountDigest });
  if (!r?.ok) {
    throw new Error(data?.message || 'fetch gap count failed');
  }
  return { count: data?.count || 0 };
}

async function apiGetSecureGapCount({ conversationId, minCounter, maxCounter, excludeSenderAccountDigest }) {
  if (!conversationId) return { r: { ok: false }, data: { message: 'missing conversationId' } };
  const query = new URLSearchParams({
    conversationId,
    minCounter: String(minCounter),
    maxCounter: String(maxCounter)
  });
  if (excludeSenderAccountDigest) query.set('excludeSenderAccountDigest', excludeSenderAccountDigest);

  return apiClient.get(`/d1/messages/secure/gap-count?${query.toString()}`);
}

// [UNREAD-COUNT] Server-Side Unread Calculation
export async function getMessagesUnreadCount({
  conversationIds,
  selfAccountDigest,
  getMessagesUnreadCount: fetchUnread = apiGetMessagesUnreadCount
} = {}) {
  const { r, data } = await fetchUnread({ conversationIds, selfAccountDigest });
  if (!r?.ok) {
    throw new Error(data?.message || 'fetch unread count failed');
  }
  return { counts: data?.counts || {} };
}

async function apiGetMessagesUnreadCount({ conversationIds, selfAccountDigest }) {
  if (!selfAccountDigest) return { r: { ok: false }, data: { message: 'missing selfAccountDigest' } };
  return apiClient.post('/d1/messages/unread-count', {
    conversationIds,
    selfAccountDigest
  });
}

export function createMessageServerApi(deps = {}) {
  void deps;
  return {
    // TODO: implement using existing API wrappers.
    async getSecureMaxCounter(conversationId) {
      void conversationId;
      throw new Error('messages-flow server api not implemented');
    },

    // TODO: implement using existing API wrappers.
    async listSecure(conversationId, { limit, cursor } = {}) {
      void conversationId;
      void limit;
      void cursor;
      throw new Error('messages-flow server api not implemented');
    },

    // TODO: implement using existing API wrappers.
    async getSecureByCounter(conversationId, counter) {
      void conversationId;
      void counter;
      throw new Error('messages-flow server api not implemented');
    },

    // TODO: implement using existing API wrappers.
    async getSecureByMessageId(conversationId, messageId) {
      void conversationId;
      void messageId;
      throw new Error('messages-flow server api not implemented');
    }
  };
}
