// Message Key Vault API wrappers.
import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload } from '../core/store.js';

async function parseJsonResponse(r) {
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function putMessageKeyVault(params = {}) {
  if (!params?.conversationId) throw new Error('conversationId required');
  if (!params?.messageId) throw new Error('messageId required');
  if (!params?.senderDeviceId) throw new Error('senderDeviceId required');
  if (!params?.targetDeviceId) throw new Error('targetDeviceId required');
  if (!params?.direction) throw new Error('direction required');
  if (!params?.wrapped_mk) throw new Error('wrapped_mk required');
  if (!params?.wrap_context) throw new Error('wrap_context required');
  const headerCounterRaw = params?.headerCounter;
  const headerCounter = (headerCounterRaw === null || headerCounterRaw === undefined || headerCounterRaw === '')
    ? null
    : (Number.isFinite(Number(headerCounterRaw)) ? Number(headerCounterRaw) : null);
  const payload = buildAccountPayload({
    overrides: {
      accountDigest: params.accountDigest,
      conversationId: params.conversationId,
      messageId: params.messageId,
      senderDeviceId: params.senderDeviceId,
      targetDeviceId: params.targetDeviceId,
      direction: params.direction,
      msgType: params.msgType || null,
      headerCounter,
      wrapped_mk: params.wrapped_mk,
      wrap_context: params.wrap_context,
      dr_state: params.dr_state || null
    }
  });
  const r = await fetchWithTimeout('/d1/message-key-vault/put', jsonReq(payload), 10000);
  return parseJsonResponse(r);
}

export async function getMessageKeyVault(params = {}) {
  if (!params?.conversationId) throw new Error('conversationId required');
  if (!params?.senderDeviceId) throw new Error('senderDeviceId required');
  if (!params?.messageId && (params?.headerCounter === undefined || params?.headerCounter === null)) {
    throw new Error('messageId or headerCounter required');
  }
  const payload = buildAccountPayload({
    overrides: {
      conversationId: params.conversationId,
      messageId: params.messageId || null,
      headerCounter: params.headerCounter ?? null,
      senderDeviceId: params.senderDeviceId
    }
  });
  const r = await fetchWithTimeout('/d1/message-key-vault/get', jsonReq(payload), 10000);
  return parseJsonResponse(r);
}
export async function getVaultPutCount(params = {}) {
  if (!params?.conversationId) throw new Error('conversationId required');
  if (!params?.messageId) throw new Error('messageId required');
  const payload = buildAccountPayload({
    overrides: {
      conversationId: params.conversationId,
      messageId: params.messageId
    }
  });
  const r = await fetchWithTimeout('/d1/message-key-vault/count', jsonReq(payload), 5000);
  return parseJsonResponse(r);
}

export async function deleteMessageKeyVault(params = {}) {
  if (!params?.conversationId) throw new Error('conversationId required');
  if (!params?.messageId) throw new Error('messageId required');
  if (!params?.senderDeviceId) throw new Error('senderDeviceId required');
  const payload = buildAccountPayload({
    overrides: {
      conversationId: params.conversationId,
      messageId: params.messageId,
      senderDeviceId: params.senderDeviceId
    }
  });
  const r = await fetchWithTimeout('/d1/message-key-vault/delete', jsonReq(payload), 5000);
  return parseJsonResponse(r);
}

export async function getLatestStateVault(params = {}) {
  if (!params?.conversationId) throw new Error('conversationId required');
  const payload = buildAccountPayload({
    overrides: {
      conversationId: params.conversationId,
      senderDeviceId: params.senderDeviceId // Optional optimization
    }
  });
  const r = await fetchWithTimeout('/d1/message-key-vault/latest-state', jsonReq(payload), 8000); // Higher timeout for SQL query
  return parseJsonResponse(r);

}
