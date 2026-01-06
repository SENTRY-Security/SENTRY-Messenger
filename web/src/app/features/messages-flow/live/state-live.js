// /app/features/messages-flow/live/state-live.js
// State access for live (B-route) flow.

import { classifyDecryptedPayload, SEMANTIC_KIND } from '../../semantic.js';
import { SECURE_CONVERSATION_STATUS } from '../../secure-conversation-manager.js';

function hasUsableDrState(holder) {
  if (
    !holder?.rk
    || !(holder?.myRatchetPriv instanceof Uint8Array)
    || !(holder?.myRatchetPub instanceof Uint8Array)
  ) {
    return false;
  }
  const hasReceive = holder?.ckR instanceof Uint8Array && holder.ckR.length > 0;
  const hasSend = holder?.ckS instanceof Uint8Array && holder.ckS.length > 0;
  return hasReceive || hasSend;
}

function normalizeMessageId(raw) {
  if (typeof raw?.id === 'string' && raw.id.length) return raw.id;
  if (typeof raw?.message_id === 'string' && raw.message_id.length) return raw.message_id;
  if (typeof raw?.messageId === 'string' && raw.messageId.length) return raw.messageId;
  return null;
}

function toMessageTimestamp(raw) {
  const candidates = [
    raw?.created_at,
    raw?.createdAt,
    raw?.ts,
    raw?.timestamp,
    raw?.meta?.ts
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      if (n > 10_000_000_000) return Math.floor(n / 1000);
      return Math.floor(n);
    }
  }
  return null;
}

function resolveMessageTsMs(ts) {
  if (!Number.isFinite(ts)) return null;
  const n = Number(ts);
  if (n > 10_000_000_000) return Math.floor(n);
  return Math.floor(n) * 1000;
}

function resolveHeader(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.header && typeof raw.header === 'object') return raw.header;
  if (raw.header_json && typeof raw.header_json === 'object') return raw.header_json;
  if (raw.headerJson && typeof raw.headerJson === 'object') return raw.headerJson;
  if (typeof raw.header_json === 'string') {
    try {
      return JSON.parse(raw.header_json);
    } catch {
      return null;
    }
  }
  if (typeof raw.headerJson === 'string') {
    try {
      return JSON.parse(raw.headerJson);
    } catch {
      return null;
    }
  }
  return null;
}

function resolveCiphertextB64(raw) {
  return raw?.ciphertext_b64 || raw?.ciphertextB64 || null;
}

function resolveSenderDeviceId(raw, header) {
  return raw?.senderDeviceId
    || raw?.sender_device_id
    || header?.meta?.senderDeviceId
    || header?.meta?.sender_device_id
    || header?.device_id
    || null;
}

function resolveTargetDeviceId(raw, header) {
  return raw?.targetDeviceId
    || raw?.target_device_id
    || raw?.receiverDeviceId
    || raw?.receiver_device_id
    || header?.meta?.targetDeviceId
    || header?.meta?.target_device_id
    || header?.meta?.receiverDeviceId
    || header?.meta?.receiver_device_id
    || null;
}

function resolveSenderDigest(raw, header) {
  const digest = raw?.senderAccountDigest
    || raw?.sender_digest
    || header?.meta?.senderDigest
    || header?.meta?.sender_digest
    || null;
  if (!digest || typeof digest !== 'string') return null;
  return digest.toUpperCase();
}

function resolveCounter(raw, header) {
  const counter = raw?.counter ?? raw?.n ?? header?.n ?? header?.counter ?? null;
  const num = Number(counter);
  return Number.isFinite(num) ? num : null;
}

function resolveDirectionComputed(raw, header, {
  selfDeviceId,
  selfDigest,
  peerDeviceId,
  peerAccountDigest
} = {}) {
  const direct = raw?.directionComputed || raw?.direction_computed || raw?.direction || null;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim().toLowerCase();
  }
  const senderDeviceId = resolveSenderDeviceId(raw, header);
  const targetDeviceId = resolveTargetDeviceId(raw, header);
  const senderDigest = resolveSenderDigest(raw, header);
  const selfDevice = typeof selfDeviceId === 'string' && selfDeviceId ? selfDeviceId : null;
  const peerDevice = typeof peerDeviceId === 'string' && peerDeviceId ? peerDeviceId : null;
  const selfDigestUpper = typeof selfDigest === 'string' && selfDigest ? selfDigest.toUpperCase() : null;
  const peerDigestUpper = typeof peerAccountDigest === 'string' && peerAccountDigest
    ? peerAccountDigest.toUpperCase()
    : null;
  if (targetDeviceId && selfDevice && targetDeviceId === selfDevice) return 'incoming';
  if (senderDeviceId && selfDevice && senderDeviceId === selfDevice) return 'outgoing';
  if (senderDeviceId && peerDevice && senderDeviceId === peerDevice) return 'incoming';
  if (targetDeviceId && peerDevice && targetDeviceId === peerDevice) return 'outgoing';
  if (senderDigest && selfDigestUpper && senderDigest === selfDigestUpper) return 'outgoing';
  if (senderDigest && peerDigestUpper && senderDigest === peerDigestUpper) return 'incoming';
  return null;
}

function resolveMsgType(meta, header) {
  if (!meta && !header?.meta) return null;
  return meta?.msg_type
    || meta?.msgType
    || header?.meta?.msg_type
    || header?.meta?.msgType
    || null;
}

async function ensureLiveReady(params = {}, adapters) {
  const conversationId = params?.conversationId || null;
  const tokenB64 = params?.tokenB64 || null;
  const peerAccountDigest = params?.peerAccountDigest || null;
  const peerDeviceId = params?.peerDeviceId || null;
  if (!conversationId || !tokenB64 || !peerAccountDigest || !peerDeviceId) {
    return { ok: false, reasonCode: 'MISSING_PARAMS' };
  }
  if (!adapters?.ensureSecureConversationReady || !adapters?.ensureDrReceiverState || !adapters?.drState) {
    return { ok: false, reasonCode: 'ADAPTERS_UNAVAILABLE' };
  }
  let secureStatus = null;
  try {
    secureStatus = await adapters.ensureSecureConversationReady({
      peerAccountDigest,
      peerDeviceId,
      conversationId,
      reason: 'live_mvp',
      source: 'messages-flow/live:ensureLiveReady'
    });
  } catch (err) {
    return { ok: false, reasonCode: 'SECURE_FAILED', errorMessage: err?.message || String(err) };
  }
  const status = secureStatus?.status || null;
  if (status !== SECURE_CONVERSATION_STATUS.READY) {
    const reasonCode = status === SECURE_CONVERSATION_STATUS.FAILED
      ? 'SECURE_FAILED'
      : 'SECURE_PENDING';
    return { ok: false, reasonCode };
  }

  try {
    await adapters.ensureDrReceiverState(conversationId, peerAccountDigest, peerDeviceId);
  } catch (err) {
    return { ok: false, reasonCode: 'DR_STATE_UNAVAILABLE', errorMessage: err?.message || String(err) };
  }
  const state = adapters.drState({ peerAccountDigest, peerDeviceId });
  if (!hasUsableDrState(state)) {
    return { ok: false, reasonCode: 'DR_STATE_UNAVAILABLE' };
  }
  return { ok: true };
}

async function decryptIncomingBatch(params = {}, adapters) {
  const conversationId = params?.conversationId || null;
  const peerAccountDigest = params?.peerAccountDigest || null;
  const peerDeviceId = params?.peerDeviceId || null;
  const items = Array.isArray(params?.items) ? params.items : [];
  if (!conversationId || !peerAccountDigest || !peerDeviceId) {
    return {
      ok: false,
      reasonCode: 'MISSING_PARAMS',
      decryptedMessages: [],
      processedCount: 0,
      skippedCount: items.length,
      okCount: 0,
      failCount: 0
    };
  }
  if (!adapters?.drDecryptText || !adapters?.drState) {
    return {
      ok: false,
      reasonCode: 'ADAPTERS_UNAVAILABLE',
      decryptedMessages: [],
      processedCount: 0,
      skippedCount: items.length,
      okCount: 0,
      failCount: 0
    };
  }
  const state = adapters.drState({ peerAccountDigest, peerDeviceId });
  if (!hasUsableDrState(state)) {
    return {
      ok: false,
      reasonCode: 'DR_STATE_UNAVAILABLE',
      decryptedMessages: [],
      processedCount: 0,
      skippedCount: items.length,
      okCount: 0,
      failCount: 0
    };
  }

  state.baseKey = state.baseKey || {};
  if (!state.baseKey.conversationId) state.baseKey.conversationId = conversationId;
  if (!state.baseKey.peerDeviceId) state.baseKey.peerDeviceId = peerDeviceId;
  if (!state.baseKey.peerAccountDigest) state.baseKey.peerAccountDigest = peerAccountDigest;

  let selfDeviceId = null;
  let selfDigest = null;
  try {
    selfDeviceId = adapters.getDeviceId ? adapters.getDeviceId() : null;
  } catch {}
  try {
    selfDigest = adapters.getAccountDigest ? adapters.getAccountDigest() : null;
  } catch {}
  if (typeof selfDigest === 'string') selfDigest = selfDigest.toUpperCase();

  const decryptedMessages = [];
  let processedCount = 0;
  let skippedCount = 0;
  let decryptSuccessCount = 0;
  let okCount = 0;
  let failCount = 0;

  for (const raw of items) {
    const header = resolveHeader(raw);
    const ciphertextB64 = resolveCiphertextB64(raw);
    const directionComputed = resolveDirectionComputed(raw, header, {
      selfDeviceId,
      selfDigest,
      peerAccountDigest,
      peerDeviceId
    });
    if (directionComputed !== 'incoming') {
      skippedCount += 1;
      continue;
    }
    if (!header || !ciphertextB64 || !header.iv_b64) {
      skippedCount += 1;
      continue;
    }

    processedCount += 1;
    const counter = resolveCounter(raw, header);
    const messageId = normalizeMessageId(raw);
    const meta = raw?.meta || header?.meta || null;
    const msgTypeHint = resolveMsgType(meta, header);
    const packetKey = messageId || (Number.isFinite(counter) ? `${conversationId}:${counter}` : null);
    let messageKeyB64 = null;
    let plaintext = null;

    try {
      plaintext = await adapters.drDecryptText(state, {
        aead: 'aes-256-gcm',
        header,
        iv_b64: header.iv_b64,
        ciphertext_b64: ciphertextB64
      }, {
        onMessageKey: (mk) => { messageKeyB64 = mk; },
        packetKey,
        msgType: msgTypeHint || 'text'
      });
      decryptSuccessCount += 1;
    } catch {
      failCount += 1;
      continue;
    }
    if (!messageKeyB64) {
      failCount += 1;
      continue;
    }

    const semantic = classifyDecryptedPayload(plaintext, { meta, header });
    if (semantic.kind !== SEMANTIC_KIND.USER_MESSAGE || semantic.subtype !== 'text') {
      skippedCount += 1;
      continue;
    }

    const ts = toMessageTimestamp(raw);
    if (!messageId || !Number.isFinite(ts)) {
      skippedCount += 1;
      continue;
    }

    const senderDeviceId = resolveSenderDeviceId(raw, header) || peerDeviceId || null;
    const targetDeviceId = resolveTargetDeviceId(raw, header) || selfDeviceId || null;
    const senderDigest = resolveSenderDigest(raw, header);
    const text = typeof plaintext === 'string' ? plaintext : String(plaintext ?? '');

    decryptedMessages.push({
      id: messageId,
      messageId,
      ts,
      tsMs: resolveMessageTsMs(ts),
      direction: 'incoming',
      msgType: 'text',
      text,
      messageKeyB64,
      counter,
      headerCounter: counter,
      senderDeviceId,
      targetDeviceId,
      senderDigest
    });
    okCount += 1;
  }

  if (decryptSuccessCount > 0 && adapters?.persistDrSnapshot) {
    try {
      adapters.persistDrSnapshot({ peerAccountDigest, peerDeviceId, state });
    } catch {}
  }

  return {
    ok: true,
    decryptedMessages,
    processedCount,
    skippedCount,
    okCount,
    failCount
  };
}

async function persistAndAppendBatch(params = {}, adapters) {
  const conversationId = params?.conversationId || null;
  const decryptedMessages = Array.isArray(params?.decryptedMessages)
    ? params.decryptedMessages
    : [];
  if (!conversationId) {
    return { ok: false, appendOk: false, appendedCount: 0, vaultPutOk: 0, vaultPutFail: 0 };
  }
  if (!adapters?.vaultPutIncomingKey || !adapters?.appendTimelineBatch) {
    return { ok: false, appendOk: false, appendedCount: 0, vaultPutOk: 0, vaultPutFail: 0 };
  }

  let vaultPutOk = 0;
  let vaultPutFail = 0;
  const appendableMessages = [];
  for (const message of decryptedMessages) {
    const messageId = message?.messageId || message?.id || null;
    if (!messageId || !message?.messageKeyB64) {
      vaultPutFail += 1;
      continue;
    }
    try {
      await adapters.vaultPutIncomingKey({
        conversationId,
        messageId,
        senderDeviceId: message?.senderDeviceId || null,
        targetDeviceId: message?.targetDeviceId || null,
        direction: message?.direction || 'incoming',
        msgType: message?.msgType || 'text',
        messageKeyB64: message?.messageKeyB64 || null,
        headerCounter: Number.isFinite(message?.headerCounter)
          ? Number(message.headerCounter)
          : (Number.isFinite(message?.counter) ? Number(message.counter) : null)
      });
      vaultPutOk += 1;
      appendableMessages.push(message);
    } catch {
      vaultPutFail += 1;
    }
  }

  let appendOk = true;
  let appendedCount = 0;
  if (appendableMessages.length) {
    const entries = appendableMessages.map((message) => ({
      conversationId,
      messageId: message?.messageId || message?.id || null,
      direction: message?.direction || 'incoming',
      msgType: message?.msgType || 'text',
      ts: message?.ts ?? null,
      tsMs: message?.tsMs ?? resolveMessageTsMs(message?.ts),
      counter: Number.isFinite(message?.counter) ? Number(message.counter) : null,
      text: message?.text || null,
      senderDigest: message?.senderDigest || null,
      senderDeviceId: message?.senderDeviceId || null,
      targetDeviceId: message?.targetDeviceId || null
    }));
    try {
      const result = adapters.appendTimelineBatch(entries, { directionalOrder: 'chronological' }) || null;
      const count = Number(result?.appendedCount);
      appendedCount = Number.isFinite(count) ? count : entries.length;
    } catch {
      appendOk = false;
    }
  } else if (decryptedMessages.length) {
    appendOk = false;
  }

  return {
    ok: appendOk,
    appendOk,
    appendedCount,
    vaultPutOk,
    vaultPutFail
  };
}

export function createLiveStateAccess(deps = {}) {
  const adapters = deps?.adapters || null;

  return {
    ensureLiveReady: (params = {}) => ensureLiveReady(params, adapters),
    decryptIncomingBatch: (params = {}) => decryptIncomingBatch(params, adapters),
    persistAndAppendBatch: (params = {}) => persistAndAppendBatch(params, adapters)
  };
}
