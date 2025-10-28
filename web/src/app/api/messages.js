

// /app/api/messages.js
// Front-end API wrappers for conversation messages.
// ESM only; depends on core/http. No UI logic here.

import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload } from '../core/store.js';
export { createMessage } from './media.js'; // legacy POST /api/v1/messages wrapper

/**
 * 送出隱匿式訊息（conversation token 模型）。
 * @param {{ conversationId:string, payloadEnvelope:any, id?:string, createdAt?:number }} p
 */
export async function createSecureMessage({ conversationId, payloadEnvelope, id, createdAt }) {
  if (!conversationId) throw new Error('conversationId required');
  if (!payloadEnvelope) throw new Error('payloadEnvelope required');
  const body = {
    conversation_id: conversationId,
    payload_envelope: payloadEnvelope
  };
  if (id) body.id = id;
  if (createdAt) body.created_at = createdAt;
  const r = await fetchWithTimeout('/api/v1/messages/secure', jsonReq(body), 15000);
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
export async function listMessages({ convId, limit = 20, cursorTs }) {
  if (!convId) throw new Error('convId required');
  const qs = new URLSearchParams();
  if (limit) qs.set('limit', String(limit));
  if (cursorTs !== undefined && cursorTs !== null && cursorTs !== '') qs.set('cursorTs', String(cursorTs));
  const url = `/api/v1/conversations/${encodeURIComponent(convId)}/messages?${qs.toString()}`;

  const r = await fetchWithTimeout(url, { method: 'GET' }, 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function listSecureMessages({ conversationId, limit = 20, cursorTs }) {
  if (!conversationId) throw new Error('conversationId required');
  const qs = new URLSearchParams();
  qs.set('conversationId', conversationId);
  if (limit) qs.set('limit', String(limit));
  if (cursorTs !== undefined && cursorTs !== null && cursorTs !== '') qs.set('cursorTs', String(cursorTs));
  const url = `/api/v1/messages/secure?${qs.toString()}`;
  const r = await fetchWithTimeout(url, { method: 'GET' }, 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function deleteSecureConversation({ conversationId }) {
  if (!conversationId) throw new Error('conversationId required');
  const payload = buildAccountPayload({ overrides: { conversationId } });
  const r = await fetchWithTimeout('/api/v1/messages/secure/delete-conversation', jsonReq(payload), 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}
