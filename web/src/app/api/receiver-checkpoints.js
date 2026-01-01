// Receiver checkpoint API wrappers.
import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload } from '../core/store.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';

const PAYLOAD_LOG_LIMIT = 5;
let payloadShapeLogCount = 0;

function shapeOf(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length ? 'string' : 'string(empty)';
  if (typeof value === 'object') return Array.isArray(value) ? 'array' : 'object';
  return typeof value;
}

function logPayloadShape(kind, payload) {
  if (!DEBUG?.replay) return;
  if (payloadShapeLogCount >= PAYLOAD_LOG_LIMIT) return;
  payloadShapeLogCount += 1;
  try {
    console.debug(`[receiver-checkpoint:${kind}:payload-shape]`, {
      conversationId: shapeOf(payload?.conversationId),
      peerDeviceId: shapeOf(payload?.peerDeviceId),
      cursorMessageId: shapeOf(payload?.cursorMessageId),
      cursorServerMessageId: shapeOf(payload?.cursorServerMessageId),
      headerCounter: shapeOf(payload?.headerCounter),
      messageTs: shapeOf(payload?.messageTs),
      Nr: shapeOf(payload?.Nr),
      Ns: shapeOf(payload?.Ns),
      PN: shapeOf(payload?.PN),
      theirRatchetPubHash: shapeOf(payload?.theirRatchetPubHash),
      ckRHash: shapeOf(payload?.ckRHash),
      skippedHash: shapeOf(payload?.skippedHash),
      skippedCount: shapeOf(payload?.skippedCount),
      wrapInfoTag: shapeOf(payload?.wrapInfoTag),
      checkpointHash: shapeOf(payload?.checkpointHash),
      wrapped_checkpoint: shapeOf(payload?.wrapped_checkpoint),
      wrap_context: shapeOf(payload?.wrap_context),
      retentionLimit: shapeOf(payload?.retentionLimit),
      accountToken: shapeOf(payload?.accountToken),
      accountDigest: shapeOf(payload?.accountDigest)
    });
  } catch {
    /* ignore logging errors */
  }
}

function normalizeString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeInt(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n);
}

async function parseJsonResponse(r) {
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function putReceiverCheckpoint(params = {}) {
  const conversationId = normalizeString(params?.conversationId);
  const peerDeviceId = normalizeString(params?.peerDeviceId);
  const nr = normalizeInt(params?.Nr ?? params?.nr);
  const messageTs = normalizeInt(params?.messageTs ?? params?.message_ts);
  const wrappedCheckpoint = params?.wrapped_checkpoint;
  if (!conversationId) throw new Error('conversationId required');
  if (!peerDeviceId) throw new Error('peerDeviceId required');
  if (!Number.isFinite(nr)) throw new Error('Nr required');
  if (!Number.isFinite(messageTs)) throw new Error('messageTs required');
  if (wrappedCheckpoint === null || wrappedCheckpoint === undefined) throw new Error('wrapped_checkpoint required');
  const payload = buildAccountPayload({
    overrides: {
      conversationId,
      peerDeviceId,
      cursorMessageId: normalizeString(params.cursorMessageId),
      cursorServerMessageId: normalizeString(params.cursorServerMessageId),
      headerCounter: normalizeInt(params.headerCounter),
      messageTs,
      Nr: nr,
      Ns: normalizeInt(params.Ns),
      PN: normalizeInt(params.PN),
      theirRatchetPubHash: normalizeString(params.theirRatchetPubHash),
      ckRHash: normalizeString(params.ckRHash),
      skippedHash: normalizeString(params.skippedHash),
      skippedCount: normalizeInt(params.skippedCount),
      wrapInfoTag: normalizeString(params.wrapInfoTag),
      checkpointHash: normalizeString(params.checkpointHash),
      wrapped_checkpoint: wrappedCheckpoint,
      wrap_context: params.wrap_context ?? undefined,
      retentionLimit: normalizeInt(params.retentionLimit)
    }
  });
  logPayloadShape('put', payload);
  const r = await fetchWithTimeout('/api/v1/receiver-checkpoints/put', jsonReq(payload), 10000);
  return parseJsonResponse(r);
}

export async function getLatestReceiverCheckpoint(params = {}) {
  if (!params?.conversationId) throw new Error('conversationId required');
  if (!params?.peerDeviceId) throw new Error('peerDeviceId required');
  const beforeTs = normalizeInt(params?.beforeTs);
  const payload = buildAccountPayload({
    overrides: {
      conversationId: params.conversationId,
      peerDeviceId: params.peerDeviceId,
      beforeTs
    }
  });
  const r = await fetchWithTimeout('/api/v1/receiver-checkpoints/get-latest', jsonReq(payload), 10000);
  return parseJsonResponse(r);
}
