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
    items: Array.isArray(data?.items) ? data.items : [],
    errors: Array.isArray(data?.errors) ? data.errors : [],
    nextCursor: resolveNextCursor(data),
    keys: data?.keys || null
  };
}

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
  getSecureMessageByCounter: fetchByCounter = apiGetSecureMessageByCounter
} = {}) {
  const { r, data } = await fetchByCounter({ conversationId, counter, senderDeviceId });
  if (!r?.ok) {
    throw new Error(resolveByCounterError(data));
  }
  const item = resolveSecureMessageItem(data);
  if (!item) {
    throw new Error('getSecureMessageByCounter missing item');
  }
  return { item };
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
