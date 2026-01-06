// /app/features/messages-flow/live/server-api-live.js
// Server API adapter for live (B-route) flow.

import { listSecureMessages as apiListSecureMessages } from '../../../api/messages.js';

function resolveNextCursorTs(data) {
  if (data?.nextCursorTs != null) return data.nextCursorTs;
  if (data?.next_cursor_ts != null) return data.next_cursor_ts;
  if (data?.nextCursor?.ts != null) return data.nextCursor.ts;
  if (data?.nextCursor?.cursorTs != null) return data.nextCursor.cursorTs;
  return null;
}

function resolveNextCursorId(data) {
  if (data?.nextCursorId != null) return data.nextCursorId;
  if (data?.next_cursor_id != null) return data.next_cursor_id;
  if (data?.nextCursor?.id != null) return data.nextCursor.id;
  if (data?.nextCursor?.cursorId != null) return data.nextCursor.cursorId;
  return null;
}

export async function listSecureMessagesLive({
  conversationId,
  limit = 20,
  cursorTs,
  cursorId,
  listSecureMessages = apiListSecureMessages
} = {}) {
  const base = {
    ok: false,
    status: null,
    items: [],
    errors: [],
    errorsLength: 0,
    nextCursorTs: null,
    nextCursorId: null
  };
  if (!conversationId) {
    return {
      ...base,
      errors: ['conversationId required'],
      errorsLength: 1
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
      ok: !!r?.ok,
      status: r?.status ?? null,
      items,
      errors,
      errorsLength: errors.length,
      nextCursorTs: resolveNextCursorTs(data),
      nextCursorId: resolveNextCursorId(data)
    };
  } catch (err) {
    const msg = err?.message || String(err);
    return {
      ...base,
      errors: msg ? [msg] : [],
      errorsLength: msg ? 1 : 0
    };
  }
}

export function createLiveServerApi(deps = {}) {
  const listSecureMessages = deps.listSecureMessages || apiListSecureMessages;
  return {
    async listSecureMessagesLive(params = {}) {
      return listSecureMessagesLive({ ...params, listSecureMessages });
    }
  };
}
