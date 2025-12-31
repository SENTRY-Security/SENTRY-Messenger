// Receiver checkpoint API wrappers.
import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload } from '../core/store.js';

async function parseJsonResponse(r) {
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function putReceiverCheckpoint(params = {}) {
  if (!params?.conversationId) throw new Error('conversationId required');
  if (!params?.peerDeviceId) throw new Error('peerDeviceId required');
  if (!params?.wrapped_checkpoint) throw new Error('wrapped_checkpoint required');
  const payload = buildAccountPayload({
    overrides: {
      conversationId: params.conversationId,
      peerDeviceId: params.peerDeviceId,
      cursorMessageId: params.cursorMessageId || null,
      cursorServerMessageId: params.cursorServerMessageId || null,
      headerCounter: params.headerCounter ?? null,
      Nr: params.Nr,
      Ns: params.Ns ?? null,
      PN: params.PN ?? null,
      theirRatchetPubHash: params.theirRatchetPubHash || null,
      ckRHash: params.ckRHash || null,
      skippedHash: params.skippedHash || null,
      skippedCount: params.skippedCount ?? null,
      wrapInfoTag: params.wrapInfoTag || null,
      checkpointHash: params.checkpointHash || null,
      wrapped_checkpoint: params.wrapped_checkpoint,
      wrap_context: params.wrap_context || null,
      retentionLimit: params.retentionLimit
    }
  });
  const r = await fetchWithTimeout('/api/v1/receiver-checkpoints/put', jsonReq(payload), 10000);
  return parseJsonResponse(r);
}

export async function getLatestReceiverCheckpoint(params = {}) {
  if (!params?.conversationId) throw new Error('conversationId required');
  if (!params?.peerDeviceId) throw new Error('peerDeviceId required');
  const payload = buildAccountPayload({
    overrides: {
      conversationId: params.conversationId,
      peerDeviceId: params.peerDeviceId
    }
  });
  const r = await fetchWithTimeout('/api/v1/receiver-checkpoints/get-latest', jsonReq(payload), 10000);
  return parseJsonResponse(r);
}
