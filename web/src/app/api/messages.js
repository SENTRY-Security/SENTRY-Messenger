

// /app/api/messages.js
// Front-end API wrappers for conversation messages.
// ESM only; depends on core/http. No UI logic here.

import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload, getDeviceId } from '../core/store.js';
export { createMessage } from './media.js'; // legacy POST /api/v1/messages wrapper

function buildAccountHeaders(opts = {}) {
  const { conversationFingerprint } = opts;
  const payload = buildAccountPayload();
  const headers = {};
  if (payload.accountToken) headers['X-Account-Token'] = payload.accountToken;
  if (payload.accountDigest) headers['X-Account-Digest'] = payload.accountDigest;
  const deviceId = getDeviceId ? getDeviceId() : null;
  if (deviceId) headers['X-Device-Id'] = deviceId;
  if (conversationFingerprint) headers['X-Conversation-Fingerprint'] = conversationFingerprint;
  return headers;
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
} = {}) {
  if (!conversationId) throw new Error('conversationId required');
  if (!header) throw new Error('header required');
  if (!ciphertextB64) throw new Error('ciphertextB64 required');
  if (!Number.isFinite(counter)) throw new Error('counter required');
  const senderDevice = senderDeviceId || getDeviceId();
  if (!senderDevice) throw new Error('senderDeviceId required');
  const overrides = {
    conversation_id: conversationId,
    header_json: JSON.stringify(header),
    ciphertext_b64: ciphertextB64,
    counter,
    sender_device_id: senderDevice
  };
  if (receiverAccountDigest) overrides.receiver_account_digest = receiverAccountDigest;
  if (receiverDeviceId) overrides.receiver_device_id = receiverDeviceId;
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
 * @param {{ convId: string, limit?: number, cursorTs?: number|string, conversationFingerprint?: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data typically { items: [...], nextCursorTs }
 */
export async function listMessages({ convId, limit = 20, cursorTs, conversationFingerprint } = {}) {
  if (!convId) throw new Error('convId required');
  const qs = new URLSearchParams();
  if (limit) qs.set('limit', String(limit));
  if (cursorTs !== undefined && cursorTs !== null && cursorTs !== '') qs.set('cursorTs', String(cursorTs));
  const url = `/api/v1/conversations/${encodeURIComponent(convId)}/messages?${qs.toString()}`;

  const headers = buildAccountHeaders({ conversationFingerprint });
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
  return { r, data };
}

export async function deleteSecureConversation({ conversationId, conversationFingerprint } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const overrides = { conversationId };
  if (conversationFingerprint) overrides.conversationFingerprint = conversationFingerprint;
  const payload = buildAccountPayload({ overrides });
  const r = await fetchWithTimeout('/api/v1/messages/secure/delete-conversation', jsonReq(payload), 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}
