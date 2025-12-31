// Outbound Key Vault API wrappers.
import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload, ensureDeviceId } from '../core/store.js';

async function parseJsonResponse(r) {
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function putOutboundKey(params = {}) {
  if (!params?.conversationId) throw new Error('conversationId required');
  if (!params?.messageId) throw new Error('messageId required');
  const payload = buildAccountPayload({
    overrides: {
      conversationId: params.conversationId,
      messageId: params.messageId,
      serverMessageId: params.serverMessageId || null,
      senderDeviceId: params.senderDeviceId || ensureDeviceId(),
      targetDeviceId: params.targetDeviceId || null,
      headerCounter: params.headerCounter,
      msgType: params.msgType || null,
      wrapped_mk: params.wrapped_mk,
      wrap_context: params.wrap_context || null,
      retentionLimit: params.retentionLimit
    }
  });
  const r = await fetchWithTimeout('/api/v1/outbound-key-vault/put', jsonReq(payload), 10000);
  return parseJsonResponse(r);
}

export async function getOutboundKey(params = {}) {
  if (!params?.conversationId) throw new Error('conversationId required');
  const payload = buildAccountPayload({
    overrides: {
      conversationId: params.conversationId,
      serverMessageId: params.serverMessageId || null,
      messageId: params.messageId || null,
      senderDeviceId: params.senderDeviceId || ensureDeviceId(),
      targetDeviceId: params.targetDeviceId || null,
      headerCounter: params.headerCounter ?? null
    }
  });
  const r = await fetchWithTimeout('/api/v1/outbound-key-vault/get', jsonReq(payload), 10000);
  return parseJsonResponse(r);
}
