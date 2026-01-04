

// /app/api/messages.js
// Front-end API wrappers for conversation messages.
// ESM only; depends on core/http. No UI logic here.

import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload, ensureDeviceId, normalizeAccountDigest } from '../core/store.js';
import { logCapped, logForensicsEvent } from '../core/log.js';
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

function suffix(value, size) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(-size);
}

function logAuthHeaderTrace(endpoint, headers = {}) {
  if (!endpoint) return;
  const accountToken = headers['X-Account-Token'] || headers['x-account-token'] || null;
  const accountDigest = headers['X-Account-Digest'] || headers['x-account-digest'] || null;
  const deviceId = headers['X-Device-Id'] || headers['x-device-id'] || null;
  logCapped('apiAuthHeaderTrace', {
    endpoint,
    hasXAccountToken: !!accountToken,
    hasXAccountDigest: !!accountDigest,
    hasXDeviceId: !!deviceId,
    accountDigestSuffix4: suffix(accountDigest, 4),
    deviceIdSuffix4: suffix(deviceId, 4)
  }, 5);
}

function normalizeOutgoingReceiverDigest(value, { endpoint = '/api/v1/messages/outgoing-status', field = 'receiverAccountDigest' } = {}) {
  if (!value) return null;
  const raw = typeof value === 'string'
    ? value
    : (value?.peerAccountDigest ?? value?.peerDigest ?? value?.accountDigest ?? value);
  const rawString = typeof raw === 'string' ? raw : null;
  const beforeHasDoubleColon = !!(rawString && rawString.includes('::'));
  const digestOnly = rawString ? rawString.split('::')[0] : raw;
  const normalized = normalizeAccountDigest(digestOnly);
  if (beforeHasDoubleColon) {
    logCapped('apiDigestNormalizeTrace', {
      endpoint,
      field,
      beforeHasDoubleColon,
      afterIs64Hex: !!normalized,
      beforeSuffix8: suffix(rawString, 8),
      afterSuffix8: suffix(normalized, 8)
    }, 5);
  }
  return normalized;
}

function buildMessageAuthHeaders({ endpoint, deviceId } = {}) {
  const payload = buildAccountPayload();
  const headers = {};
  if (payload.accountToken) headers['X-Account-Token'] = payload.accountToken;
  if (payload.accountDigest) headers['X-Account-Digest'] = payload.accountDigest;
  if (!headers['X-Account-Token'] && !headers['X-Account-Digest']) {
    throw new Error('accountToken or accountDigest required');
  }
  const senderDevice = typeof deviceId === 'string' && deviceId.trim()
    ? deviceId.trim()
    : ensureDeviceId();
  if (!senderDevice) throw new Error('senderDeviceId required');
  headers['X-Device-Id'] = senderDevice;
  logAuthHeaderTrace(endpoint, headers);
  return { headers, senderDeviceId: senderDevice };
}

function buildOutgoingStatusRequest({ conversationId, senderDeviceId, receiverAccountDigest, messageIds } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const receiverDigest = normalizeOutgoingReceiverDigest(receiverAccountDigest, {
    endpoint: '/api/v1/messages/outgoing-status',
    field: 'receiverAccountDigest'
  });
  if (!receiverDigest) throw new Error('receiverAccountDigest required');
  const ids = Array.isArray(messageIds) ? messageIds.filter(Boolean).map((id) => String(id).trim()).filter(Boolean) : [];
  if (!ids.length) throw new Error('messageIds required');
  const senderDevice = senderDeviceId || ensureDeviceId();
  if (!senderDevice) throw new Error('senderDeviceId required');
  const { headers } = buildMessageAuthHeaders({
    endpoint: '/api/v1/messages/outgoing-status',
    deviceId: senderDevice
  });
  return {
    headers,
    body: {
      conversationId,
      senderDeviceId: senderDevice,
      receiverAccountDigest: receiverDigest,
      messageIds: ids
    }
  };
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

export async function fetchSendState({ conversationId, senderDeviceId } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const senderDevice = senderDeviceId || ensureDeviceId();
  if (!senderDevice) throw new Error('senderDeviceId required');
  const overrides = {
    conversationId,
    senderDeviceId: senderDevice
  };
  const payload = buildAccountPayload({ overrides });
  const { headers } = buildMessageAuthHeaders({
    endpoint: '/api/v1/messages/send-state',
    deviceId: senderDevice
  });
  const r = await fetchWithTimeout('/api/v1/messages/send-state', jsonReq(payload, headers), 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function fetchOutgoingStatus({ conversationId, senderDeviceId, receiverAccountDigest, messageIds } = {}) {
  const { body, headers } = buildOutgoingStatusRequest({
    conversationId,
    senderDeviceId,
    receiverAccountDigest,
    messageIds
  });
  const r = await fetchWithTimeout('/api/v1/messages/outgoing-status', jsonReq(body, headers), 15000);
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
