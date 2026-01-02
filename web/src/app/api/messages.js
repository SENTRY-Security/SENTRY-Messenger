

// /app/api/messages.js
// Front-end API wrappers for conversation messages.
// ESM only; depends on core/http. No UI logic here.

import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload, ensureDeviceId } from '../core/store.js';
import { logForensicsEvent } from '../core/log.js';
export { createMessage } from './media.js'; // legacy POST /api/v1/messages wrapper

function buildAccountHeaders() {
  const payload = buildAccountPayload();
  const headers = {};
  if (payload.accountToken) headers['X-Account-Token'] = payload.accountToken;
  if (payload.accountDigest) headers['X-Account-Digest'] = payload.accountDigest;
  try {
    const deviceId = ensureDeviceId();
    if (deviceId) headers['X-Device-Id'] = deviceId;
  } catch {
    /* header 留空，讓上層錯誤自行拋出 */
  }
  return headers;
}

function extractMessageId(item) {
  if (typeof item?.id === 'string' && item.id.length) return item.id;
  if (typeof item?.messageId === 'string' && item.messageId.length) return item.messageId;
  if (typeof item?.message_id === 'string' && item.message_id.length) return item.message_id;
  if (typeof item?.serverMessageId === 'string' && item.serverMessageId.length) return item.serverMessageId;
  if (typeof item?.server_message_id === 'string' && item.server_message_id.length) return item.server_message_id;
  return null;
}

function summarizeMessageIds(items = []) {
  const ids = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      const id = extractMessageId(item);
      if (id) ids.push(id);
    }
  }
  const idsCount = ids.length;
  const headIds = ids.slice(0, 3);
  const tailIds = idsCount > 3 ? ids.slice(-3) : ids.slice();
  return { idsCount, headIds, tailIds };
}

/**
 * 送出隱匿式訊息（conversation token 模型）。
 * @param {{ conversationId:string, header:any, ciphertextB64:string, counter:number, senderDeviceId?:string, receiverAccountDigest?:string, receiverDeviceId?:string, id?:string, createdAt?:number }} p
 */
export async function createSecureMessage({
  conversationId,
  header,
  ciphertextB64,
  counter,
  senderDeviceId,
  receiverAccountDigest,
  receiverDeviceId,
  id,
  createdAt
} = {}, { _retry } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  if (!header) throw new Error('header required');
  if (!ciphertextB64) throw new Error('ciphertextB64 required');
  if (!Number.isFinite(counter)) throw new Error('counter required');
  if (!id) throw new Error('id (messageId) required');
  const senderDevice = senderDeviceId || ensureDeviceId();
  if (!senderDevice) throw new Error('senderDeviceId required');
  if (!receiverDeviceId) throw new Error('receiverDeviceId required');
  if (!receiverAccountDigest) throw new Error('receiverAccountDigest required');
  const headerPayload = { ...header };
  if (headerPayload.deviceId && !headerPayload.device_id) {
    headerPayload.device_id = headerPayload.deviceId;
  }
  const overrides = {
    conversation_id: conversationId,
    header_json: JSON.stringify(headerPayload),
    ciphertext_b64: ciphertextB64,
    counter,
    sender_device_id: senderDevice
  };
  overrides.receiver_account_digest = receiverAccountDigest;
  overrides.receiver_device_id = receiverDeviceId;
  if (id) overrides.id = id;
  if (createdAt) overrides.created_at = createdAt;
  const payload = buildAccountPayload({ overrides });
  const r = await fetchWithTimeout('/api/v1/messages/secure', jsonReq(payload), 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

/**
 * List messages in a conversation (newest first by server implementation).
 * GET /api/v1/conversations/:convId/messages?limit=&cursorTs=
 * @param {{ convId: string, limit?: number, cursorTs?: number|string }} p
 * @returns {Promise<{ r: Response, data: any }>} data typically { items: [...], nextCursorTs }
 */
export async function listMessages({ convId, limit = 20, cursorTs } = {}) {
  if (!convId) throw new Error('convId required');
  const qs = new URLSearchParams();
  if (limit) qs.set('limit', String(limit));
  if (cursorTs !== undefined && cursorTs !== null && cursorTs !== '') qs.set('cursorTs', String(cursorTs));
  const url = `/api/v1/conversations/${encodeURIComponent(convId)}/messages?${qs.toString()}`;

  const headers = buildAccountHeaders();
  const r = await fetchWithTimeout(url, { method: 'GET', headers }, 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function listSecureMessages({ conversationId, limit = 20, cursorTs, cursorId } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const qs = new URLSearchParams();
  qs.set('conversationId', conversationId);
  if (limit) qs.set('limit', String(limit));
  if (cursorTs !== undefined && cursorTs !== null && cursorTs !== '') qs.set('cursorTs', String(cursorTs));
  if (cursorId !== undefined && cursorId !== null && cursorId !== '') qs.set('cursorId', String(cursorId));
  const url = `/api/v1/messages/secure?${qs.toString()}`;
  const headers = buildAccountHeaders();
  const r = await fetchWithTimeout(url, { method: 'GET', headers }, 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  try {
    const items = Array.isArray(data?.items) ? data.items : [];
    const summary = summarizeMessageIds(items);
    logForensicsEvent('FETCH_LIST', {
      conversationId,
      serverItemCount: Array.isArray(data?.items) ? items.length : null,
      ...summary,
      source: 'listSecureMessages'
    });
  } catch {}
  return { r, data };
}

export async function deleteSecureConversation({ conversationId, peerAccountDigest, targetDeviceId } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  if (!peerAccountDigest) throw new Error('peerAccountDigest required');
  if (!targetDeviceId) throw new Error('targetDeviceId required');
  const overrides = { conversationId, peerAccountDigest, targetDeviceId };
  const payload = buildAccountPayload({ overrides });
  const r = await fetchWithTimeout('/api/v1/messages/secure/delete-conversation', jsonReq(payload), 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}
