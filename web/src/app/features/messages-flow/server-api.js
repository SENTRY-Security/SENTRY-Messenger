// /app/features/messages-flow/server-api.js
// Server API adapter for replay-safe message flow.

import {
  listSecureMessages as apiListSecureMessages,
  fetchSecureMaxCounter as apiFetchSecureMaxCounter
} from '../api/messages.js';

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

function resolveNextCursor(data) {
  if (data?.nextCursor) return data.nextCursor;
  if (data?.nextCursorTs != null) return { ts: data.nextCursorTs, id: null };
  return null;
}

export async function listSecureMessagesForReplay({
  conversationId,
  limit = 20,
  cursorTs,
  cursorId,
  listSecureMessages = apiListSecureMessages
} = {}) {
  const { r, data } = await listSecureMessages({
    conversationId,
    limit,
    cursorTs,
    cursorId
  });
  if (!r?.ok) {
    throw new Error(resolveListSecureError(data));
  }
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    errors: Array.isArray(data?.errors) ? data.errors : [],
    nextCursor: resolveNextCursor(data)
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
