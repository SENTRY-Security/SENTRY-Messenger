

// /app/api/messages.js
// Front-end API wrappers for conversation messages.
// ESM only; depends on core/http. No UI logic here.

import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload, ensureDeviceId, normalizeAccountDigest } from '../core/store.js';
import { logCapped, logForensicsEvent } from '../core/log.js';
export { createMessage } from './media.js'; // legacy POST /api/v1/messages wrapper

export function buildAccountHeaders() {
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

export function logAuthHeaderTrace(endpoint, headers = {}) {
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

export function toDigestOnly(value, { endpoint = '/api/v1/messages/outgoing-status', field = 'receiverAccountDigest' } = {}) {
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
  const providedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (deviceId && !providedDeviceId) throw new Error('senderDeviceId required');
  let storedDeviceId = null;
  try {
    storedDeviceId = ensureDeviceId();
  } catch (err) {
    if (!providedDeviceId) throw err;
  }
  if (providedDeviceId && storedDeviceId && providedDeviceId !== storedDeviceId) {
    throw new Error('senderDeviceId mismatch');
  }
  const senderDevice = providedDeviceId || storedDeviceId;
  if (!senderDevice) throw new Error('senderDeviceId required');
  headers['X-Device-Id'] = senderDevice;
  logAuthHeaderTrace(endpoint, headers);
  return { headers, senderDeviceId: senderDevice };
}

function buildOutgoingStatusRequest({ conversationId, senderDeviceId, receiverAccountDigest, messageIds } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const receiverDigest = toDigestOnly(receiverAccountDigest, {
    endpoint: '/api/v1/messages/outgoing-status',
    field: 'receiverAccountDigest'
  });
  if (!receiverDigest) throw new Error('receiverAccountDigest required');
  const ids = Array.isArray(messageIds) ? messageIds.filter(Boolean).map((id) => String(id).trim()).filter(Boolean) : [];
  if (!ids.length) throw new Error('messageIds required');
  const { headers, senderDeviceId: resolvedDeviceId } = buildMessageAuthHeaders({
    endpoint: '/api/v1/messages/outgoing-status',
    deviceId: senderDeviceId
  });
  const body = buildAccountPayload({
    overrides: {
      conversationId,
      senderDeviceId: resolvedDeviceId,
      receiverAccountDigest: receiverDigest,
      messageIds: ids
    }
  });
  return {
    headers,
    body
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
  const headerPayload = { ...header };
  const headerDeviceId = headerPayload?.device_id || headerPayload?.deviceId || null;
  const metaSenderDeviceId = headerPayload?.meta?.sender_device_id
    || headerPayload?.meta?.senderDeviceId
    || null;
  let selfDeviceId = null;
  try {
    selfDeviceId = ensureDeviceId();
  } catch (err) {
    if (!senderDeviceId && !headerDeviceId && !metaSenderDeviceId) throw err;
  }
  const senderDevice = headerDeviceId || metaSenderDeviceId || senderDeviceId || selfDeviceId;
  if (!senderDevice) throw new Error('senderDeviceId required');
  if (headerDeviceId && senderDevice !== headerDeviceId) {
    throw new Error('senderDeviceId/header.device_id mismatch');
  }
  if (selfDeviceId && senderDevice !== selfDeviceId) {
    throw new Error('senderDeviceId/self device mismatch');
  }
  if (!receiverDeviceId) throw new Error('receiverDeviceId required');
  if (!receiverAccountDigest) throw new Error('receiverAccountDigest required');
  if (headerPayload.deviceId && !headerPayload.device_id) {
    headerPayload.device_id = headerPayload.deviceId;
  }
  if (headerPayload.deviceId && !headerPayload.device_id) {
    headerPayload.device_id = headerPayload.deviceId;
  }
  // [CLEANUP] Enforce snake_case in meta. Actively strip camelCase aliases.
  if (headerPayload.meta && typeof headerPayload.meta === 'object') {
    headerPayload.meta = {
      ...headerPayload.meta,
      sender_device_id: senderDevice
    };
    // Strip forbidden camelCase keys
    const FORBIDDEN_META_KEYS = [
      'senderDeviceId', 'senderDigest',
      'receiverDeviceId', 'receiverAccountDigest',
      'targetDeviceId', 'targetAccountDigest',
      'target_device_id', 'target_account_digest' // Legacy aliases
    ];
    for (const key of FORBIDDEN_META_KEYS) {
      delete headerPayload.meta[key];
    }
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
  const { headers, senderDeviceId: resolvedDeviceId } = buildMessageAuthHeaders({
    endpoint: '/api/v1/messages/send-state',
    deviceId: senderDeviceId
  });
  const payload = buildAccountPayload({
    overrides: {
      conversationId,
      senderDeviceId: resolvedDeviceId
    }
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

export async function atomicSend({ conversationId, senderDeviceId, message, vault, backup } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const endpoint = '/api/v1/messages/atomic-send';
  const { headers, senderDeviceId: resolvedDeviceId } = buildMessageAuthHeaders({ endpoint, deviceId: senderDeviceId });
  const payload = buildAccountPayload({
    overrides: {
      conversationId,
      senderDeviceId: resolvedDeviceId,
      message,
      vault,
      backup
    }
  });
  const r = await fetchWithTimeout(endpoint, jsonReq(payload, headers), 20000); // Higher timeout for transaction
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

export async function listSecureMessages({ conversationId, limit = 20, cursorTs, cursorId, includeKeys } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const qs = new URLSearchParams();
  qs.set('conversationId', conversationId);
  if (limit) qs.set('limit', String(limit));
  if (cursorTs !== undefined && cursorTs !== null && cursorTs !== '') qs.set('cursorTs', String(cursorTs));
  if (cursorId !== undefined && cursorId !== null && cursorId !== '') qs.set('cursorId', String(cursorId));
  if (includeKeys) qs.set('includeKeys', 'true');
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
  } catch { }
  return { r, data };
}

export async function getSecureMessageByCounter({ conversationId, counter, senderDeviceId, senderAccountDigest, includeKeys } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  if (!Number.isFinite(Number(counter))) throw new Error('counter required');
  const qs = new URLSearchParams();
  qs.set('conversationId', conversationId);
  qs.set('counter', String(counter));
  if (senderDeviceId) qs.set('senderDeviceId', String(senderDeviceId));
  const senderDigest = senderAccountDigest ? normalizeAccountDigest(senderAccountDigest) : null;
  if (senderDigest) qs.set('senderAccountDigest', senderDigest);
  if (includeKeys) qs.set('includeKeys', 'true');
  const url = `/api/v1/messages/by-counter?${qs.toString()}`;
  const headers = buildAccountHeaders();
  const r = await fetchWithTimeout(url, { method: 'GET', headers }, 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function fetchSecureMaxCounter({ conversationId, senderDeviceId } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const deviceId = typeof senderDeviceId === 'string' ? senderDeviceId.trim() : '';
  if (!deviceId) throw new Error('senderDeviceId required');
  const qs = new URLSearchParams();
  qs.set('conversationId', conversationId);
  qs.set('senderDeviceId', deviceId);
  const endpoint = '/api/v1/messages/secure/max-counter';
  const { headers } = buildMessageAuthHeaders({ endpoint });
  const r = await fetchWithTimeout(`${endpoint}?${qs.toString()}`, { method: 'GET', headers }, 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function deleteSecureConversation({ conversationId, peerAccountDigest, targetDeviceId } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  if (!peerAccountDigest) throw new Error('peerAccountDigest required');
  if (!targetDeviceId) throw new Error('targetDeviceId required');
  if (!targetDeviceId) throw new Error('targetDeviceId required');
  const overrides = { conversationId, peerAccountDigest, targetDeviceId };
  const payload = buildAccountPayload({ overrides });
  const headers = buildAccountHeaders();
  const r = await fetchWithTimeout('/api/v1/messages/secure/delete-conversation', jsonReq(payload, headers), 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}
