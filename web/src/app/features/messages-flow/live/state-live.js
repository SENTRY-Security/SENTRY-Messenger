// /app/features/messages-flow/live/state-live.js
// State access for live (B-route) flow.

import { classifyDecryptedPayload, SEMANTIC_KIND } from '../../semantic.js';
import { SECURE_CONVERSATION_STATUS } from '../../secure-conversation-manager.js';
import { DEBUG } from '../../../ui/mobile/debug-flags.js';
import { applyContactShareFromCommit } from '../../contacts.js';
import { decryptContactPayload, normalizeContactShareEnvelope } from '../../contact-share.js';
import { appendUserMessage } from '../../timeline-store.js';

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

function normalizeMessageIdValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeMessageId(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return normalizeMessageIdValue(raw.id)
    || normalizeMessageIdValue(raw.message_id)
    || normalizeMessageIdValue(raw.messageId)
    || normalizeMessageIdValue(raw.serverMessageId)
    || normalizeMessageIdValue(raw.server_message_id)
    || normalizeMessageIdValue(raw.serverMsgId)
    || null;
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

function resolveMsgType(meta, header) {
  if (!meta && !header?.meta) return null;
  return meta?.msgType
    || meta?.msg_type
    || header?.meta?.msgType
    || header?.meta?.msg_type
    || null;
}

async function ensureLiveReady(params = {}, adapters) {
  const conversationId = params?.conversationId || null;
  const tokenB64 = params?.tokenB64 || null;
  const peerAccountDigest = params?.peerAccountDigest || null;
  const peerDeviceId = params?.peerDeviceId || null;
  const raw = params?.item || params?.raw || null;
  const header = resolveHeader(raw);
  const meta = raw?.meta || header?.meta || null;
  const msgTypeHint = resolveMsgType(meta, header);
  const skipDrCheck = msgTypeHint === 'contact-share';
  if (!conversationId || !tokenB64 || !peerAccountDigest || !peerDeviceId) {
    return { ok: false, reasonCode: 'MISSING_PARAMS' };
  }
  if (!adapters?.ensureSecureConversationReady || (!skipDrCheck && (!adapters?.ensureDrReceiverState || !adapters?.drState))) {
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

  const { digest: readyPeerAccountDigest, deviceId: readyPeerDeviceId } = (typeof secureStatus?.peerAccountDigest === 'string' && secureStatus.peerAccountDigest.includes('::'))
    ? {
      digest: secureStatus.peerAccountDigest.split('::')[0],
      deviceId: secureStatus.peerAccountDigest.split('::')[1]
    }
    : { digest: peerAccountDigest, deviceId: peerDeviceId };

  if (skipDrCheck) {
    const guestBundle = header?.dr_init?.guest_bundle || null;
    if (guestBundle && adapters?.ensureDrReceiverState) {
      try {
        await adapters.ensureDrReceiverState(conversationId, readyPeerAccountDigest, readyPeerDeviceId, guestBundle);
        if (DEBUG.drVerbose) {
          console.warn('[dr-live:bootstrap-ok]', { readyPeerAccountDigest, readyPeerDeviceId, conversationId });
        }
      } catch (err) {
        console.warn('[dr-live:bootstrap-failed]', {
          peerAccountDigest: readyPeerAccountDigest,
          peerDeviceId: readyPeerDeviceId,
          conversationId,
          error: err?.message || String(err)
        });
      }
    }
    return { ok: true };
  }

  try {
    const guestBundle = header?.dr_init?.guest_bundle || null;
    await adapters.ensureDrReceiverState(conversationId, readyPeerAccountDigest, readyPeerDeviceId, guestBundle);
  } catch (err) {
    const errorCode = err?.code === 'MISSING_DR_INIT_BOOTSTRAP' || err?.code === 'DR_BOOTSTRAP_UNAVAILABLE'
      ? err.code
      : null;
    return {
      ok: false,
      reasonCode: errorCode || 'DR_STATE_UNAVAILABLE',
      errorMessage: err?.message || String(err)
    };
  }
  const state = adapters.drState({
    peerAccountDigest: readyPeerAccountDigest,
    peerDeviceId: readyPeerDeviceId
  });
  if (!hasUsableDrState(state)) {
    return { ok: false, reasonCode: 'DR_STATE_UNAVAILABLE' };
  }
  return { ok: true };
}

async function decryptIncomingSingle(params = {}, adapters) {
  const conversationId = params?.conversationId || null;
  const peerAccountDigest = params?.peerAccountDigest || null;
  const peerDeviceId = params?.peerDeviceId || null;
  const tokenB64 = params?.tokenB64 || null;
  const raw = params?.item || params?.raw || null;
  const targetMessageId = normalizeMessageIdValue(
    params?.targetMessageId || params?.messageId || params?.serverMessageId || null
  );

  const base = {
    ok: false,
    reasonCode: null,
    decryptedMessage: null,
    processedCount: 0,
    skippedCount: 0,
    okCount: 0,
    failCount: 0
  };

  if (!conversationId || !peerAccountDigest || !peerDeviceId || !raw) {
    return {
      ...base,
      reasonCode: 'MISSING_PARAMS',
      skippedCount: raw ? 1 : 0
    };
  }
  const header = resolveHeader(raw);
  const ciphertextB64 = resolveCiphertextB64(raw);
  if (!header || !ciphertextB64 || !header.iv_b64) {
    return {
      ...base,
      reasonCode: 'MISSING_CIPHERTEXT',
      skippedCount: 1
    };
  }
  const rawMessageId = normalizeMessageId(raw);
  const messageId = rawMessageId || targetMessageId;
  const counter = resolveCounter(raw, header);
  const senderDigest = resolveSenderDigest(raw, header);
  const senderDeviceId = resolveSenderDeviceId(raw, header);

  const meta = raw?.meta || header?.meta || null;
  const msgTypeHint = resolveMsgType(meta, header);
  if (msgTypeHint === 'contact-share') {
    if (!tokenB64) {
      return {
        ...base,
        reasonCode: 'MISSING_SESSION_KEY',
        skippedCount: 1
      };
    }
    const envelope = normalizeContactShareEnvelope({ header, ciphertextB64 });
    let applyOk = false;
    try {
      await decryptContactPayload(tokenB64, envelope);
      const plaintext = JSON.stringify({ type: 'contact-share', envelope });
      const messageTs = Number(raw?.ts || raw?.created_at || raw?.timestamp || Date.now());
      const applyResult = await applyContactShareFromCommit({
        peerAccountDigest: senderDigest,
        peerDeviceId: senderDeviceId,
        sessionKey: tokenB64,
        plaintext,
        messageId,
        sourceTag: 'messages-flow:contact-share-commit',
        profileUpdatedAt: messageTs
      });
      applyOk = !!applyResult?.ok;
      if (applyResult?.diff && conversationId) {
        try {
          const diff = applyResult.diff;
          if (diff.nickname) {
            appendUserMessage(conversationId, {
              id: `${messageId}-sys-nick`,
              msgType: 'system',
              text: `對方的暱稱已更改為 ${diff.nickname.to}`,
              ts: Date.now() / 1000,
              direction: 'incoming',
              status: 'sent'
            });
          }
          if (diff.avatar) {
            appendUserMessage(conversationId, {
              id: `${messageId}-sys-avatar`,
              msgType: 'system',
              text: '對方已更改頭像',
              ts: Date.now() / 1000,
              direction: 'incoming',
              status: 'sent'
            });
          }
        } catch (err) {
          console.warn('[state-live] system notify failed', err);
        }
      }
      if (!applyOk) {
        console.error('[state-live] applyContactShareFromCommit failed', applyResult);
      }
    } catch (err) {
      console.error('[state-live] contact-share processing failed', err);
      return {
        ...base,
        reasonCode: 'DECRYPT_FAIL',
        processedCount: 1,
        failCount: 1
      };
    }
    return {
      ...base,
      reasonCode: 'CONTROL_SKIP',
      processedCount: 1,
      skippedCount: 1
    };
  }
  if (!adapters?.drDecryptText || !adapters?.drState) {
    return {
      ...base,
      reasonCode: 'ADAPTERS_UNAVAILABLE',
      skippedCount: 1
    };
  }

  if (!senderDigest || !senderDeviceId) {
    return {
      ...base,
      reasonCode: 'MISSING_SENDER_IDENTITY',
      skippedCount: 1
    };
  }
  const state = adapters.drState({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId });
  if (!hasUsableDrState(state)) {
    return {
      ...base,
      reasonCode: 'DR_STATE_UNAVAILABLE',
      skippedCount: 1
    };
  }

  state.baseKey = state.baseKey || {};
  if (!state.baseKey.conversationId) state.baseKey.conversationId = conversationId;
  if (state.baseKey.peerDeviceId !== senderDeviceId) state.baseKey.peerDeviceId = senderDeviceId;
  if (state.baseKey.peerAccountDigest !== senderDigest) state.baseKey.peerAccountDigest = senderDigest;

  let selfDeviceId = null;
  try {
    selfDeviceId = adapters.getDeviceId ? adapters.getDeviceId() : null;
  } catch { }

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
  } catch {
    return {
      ...base,
      reasonCode: 'DECRYPT_FAIL',
      processedCount: 1,
      failCount: 1
    };
  }

  const result = {
    ...base,
    processedCount: 1
  };

  if (!messageKeyB64) {
    result.reasonCode = 'MISSING_MESSAGE_KEY';
    result.failCount = 1;
  } else {
    const semantic = classifyDecryptedPayload(plaintext, { meta, header });
    if (semantic.kind !== SEMANTIC_KIND.USER_MESSAGE) {
      result.reasonCode = 'CONTROL_SKIP';
      result.skippedCount = 1;
    } else {
      let content = {};
      try {
        if (typeof plaintext === 'string' && (plaintext.trim().startsWith('{') || plaintext.trim().startsWith('['))) {
          content = JSON.parse(plaintext);
        }
      } catch { }
      const ts = toMessageTimestamp(raw);
      if (!messageId || !Number.isFinite(ts)) {
        result.reasonCode = 'MISSING_MESSAGE_FIELDS';
        result.skippedCount = 1;
      } else {
        const targetDeviceId = resolveTargetDeviceId(raw, header) || selfDeviceId || null;
        const text = typeof plaintext === 'string' ? plaintext : String(plaintext ?? '');

        let msgType = content.type || 'text';
        let media = content.media || null;

        // Polyfill media object if missing (backward compatibility for flattened payload)
        if (msgType === 'media' && !media && content.objectKey) {
          media = {
            objectKey: content.objectKey,
            name: content.name,
            size: content.size,
            contentType: content.contentType,
            envelope: content.envelope,
            dir: content.dir,
            preview: content.preview
          };
        }

        // Merge parsed content for media fields, but enforce secure properties
        result.decryptedMessage = {
          ...content,
          id: messageId,
          messageId,
          ts,
          tsMs: resolveMessageTsMs(ts),
          direction: 'incoming',
          msgType,
          media,
          text: content.text || text,
          messageKeyB64,
          counter,
          headerCounter: counter,
          senderDeviceId,
          targetDeviceId,
          senderDigest
        };
        result.okCount = 1;
      }
    }
  }

  if (adapters?.persistDrSnapshot) {
    try {
      adapters.persistDrSnapshot({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId, state });
    } catch { }
  }

  return result;
}

async function commitIncomingSingle(params = {}, adapters) {
  const conversationId = params?.conversationId || null;
  const peerAccountDigest = params?.peerAccountDigest || null;
  const peerDeviceId = params?.peerDeviceId || null;
  const tokenB64 = params?.tokenB64 || null;
  const raw = params?.item || params?.raw || null;
  const targetMessageId = normalizeMessageIdValue(
    params?.targetMessageId || params?.messageId || params?.serverMessageId || null
  );
  const baseCounter = Number.isFinite(params?.counter) ? Number(params.counter) : null;
  const base = {
    ok: false,
    reasonCode: null,
    counter: baseCounter,
    messageId: null,
    decryptOk: false,
    vaultPutOk: false
  };

  if (!conversationId || !peerAccountDigest || !peerDeviceId || !raw) {
    return { ...base, reasonCode: 'MISSING_PARAMS' };
  }
  const header = resolveHeader(raw);
  const ciphertextB64 = resolveCiphertextB64(raw);
  if (!header || !ciphertextB64 || !header.iv_b64) {
    return { ...base, reasonCode: 'MISSING_CIPHERTEXT' };
  }
  let senderDigest = null;
  let senderDeviceId = null;

  if (peerAccountDigest && peerDeviceId) {
    senderDigest = peerAccountDigest;
    senderDeviceId = peerDeviceId;
  } else {
    senderDigest = resolveSenderDigest(raw, header);
    senderDeviceId = resolveSenderDeviceId(raw, header);
  }

  if (!senderDigest || !senderDeviceId) {
    return { ...base, reasonCode: 'MISSING_SENDER_IDENTITY' };
  }
  const counter = resolveCounter(raw, header);
  const resolvedCounter = Number.isFinite(counter) ? counter : baseCounter;
  const meta = raw?.meta || header?.meta || null;
  const msgTypeHint = resolveMsgType(meta, header);
  const rawMessageId = normalizeMessageId(raw);
  const messageId = rawMessageId || targetMessageId;
  if (msgTypeHint === 'contact-share') {
    if (!tokenB64) {
      return { ...base, reasonCode: 'MISSING_SESSION_KEY', counter: resolvedCounter, messageId };
    }
    const envelope = normalizeContactShareEnvelope({ header, ciphertextB64 });
    try {
      await decryptContactPayload(tokenB64, envelope);
    } catch {
      return { ...base, reasonCode: 'DECRYPT_FAIL', counter: resolvedCounter, messageId };
    }
    const plaintext = JSON.stringify({ type: 'contact-share', envelope });
    const applyResult = await applyContactShareFromCommit({
      peerAccountDigest: senderDigest,
      peerDeviceId: senderDeviceId,
      sessionKey: tokenB64,
      plaintext,
      messageId,
      sourceTag: 'messages-flow:contact-share-commit'
    });
    if (!applyResult?.ok) {
      return {
        ...base,
        reasonCode: applyResult?.reasonCode || 'CONTACT_SHARE_APPLY_FAILED',
        counter: resolvedCounter,
        messageId,
        decryptOk: true,
        vaultPutOk: true
      };
    }
    const ts = toMessageTimestamp(raw);
    return {
      ok: true,
      reasonCode: null,
      counter: resolvedCounter,
      messageId,
      decryptOk: true,
      vaultPutOk: true,
      decryptedMessage: {
        id: messageId,
        ts,
        tsMs: resolveMessageTsMs(ts),
        direction: 'incoming',
        msgType: 'text',
        text: '已建立安全對話',
        senderDeviceId,
        senderDigest
      }
    };
  }
  if (!adapters?.drDecryptText || !adapters?.drState || !adapters?.vaultPutIncomingKey) {
    return { ...base, reasonCode: 'ADAPTERS_UNAVAILABLE' };
  }
  const state = adapters.drState({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId });
  if (!hasUsableDrState(state)) {
    return { ...base, reasonCode: 'DR_STATE_UNAVAILABLE' };
  }

  state.baseKey = state.baseKey || {};
  if (!state.baseKey.conversationId) state.baseKey.conversationId = conversationId;
  if (state.baseKey.peerDeviceId !== senderDeviceId) state.baseKey.peerDeviceId = senderDeviceId;
  if (state.baseKey.peerAccountDigest !== senderDigest) state.baseKey.peerAccountDigest = senderDigest;

  let selfDeviceId = null;
  try {
    selfDeviceId = adapters.getDeviceId ? adapters.getDeviceId() : null;
  } catch { }

  const packetKey = messageId || (Number.isFinite(resolvedCounter)
    ? `${conversationId}:${resolvedCounter}`
    : null);
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
  } catch {
    return { ...base, reasonCode: 'DECRYPT_FAIL', counter: resolvedCounter, messageId };
  }

  if (adapters?.persistDrSnapshot) {
    try {
      adapters.persistDrSnapshot({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId, state });
    } catch { }
  }

  if (!messageKeyB64) {
    return {
      ...base,
      reasonCode: 'MISSING_MESSAGE_KEY',
      counter: resolvedCounter,
      messageId,
      decryptOk: true
    };
  }
  if (!messageId) {
    return {
      ...base,
      reasonCode: 'MISSING_MESSAGE_FIELDS',
      counter: resolvedCounter,
      messageId,
      decryptOk: true
    };
  }

  const resolvedSenderDeviceId = senderDeviceId || peerDeviceId || null;
  const targetDeviceId = resolveTargetDeviceId(raw, header) || selfDeviceId || null;
  if (!resolvedSenderDeviceId || !targetDeviceId) {
    return {
      ...base,
      reasonCode: 'MISSING_MESSAGE_FIELDS',
      counter: resolvedCounter,
      messageId,
      decryptOk: true
    };
  }

  try {
    await adapters.vaultPutIncomingKey({
      conversationId,
      messageId,
      senderDeviceId: resolvedSenderDeviceId,
      targetDeviceId,
      direction: 'incoming',
      msgType: msgTypeHint || 'text',
      messageKeyB64,
      headerCounter: Number.isFinite(resolvedCounter) ? Number(resolvedCounter) : null
    });
  } catch {
    return {
      ...base,
      reasonCode: 'VAULT_PUT_FAILED',
      counter: resolvedCounter,
      messageId,
      decryptOk: true
    };
  }

  if (adapters?.appendTimelineBatch) {
    const semantic = classifyDecryptedPayload(plaintext, { meta, header });
    if (semantic.kind === SEMANTIC_KIND.USER_MESSAGE) {
      const ts = toMessageTimestamp(raw);
      const text = typeof plaintext === 'string' ? plaintext : String(plaintext ?? '');

      let content = {};
      try {
        if (typeof plaintext === 'string' && (plaintext.trim().startsWith('{') || plaintext.trim().startsWith('['))) {
          content = JSON.parse(plaintext);
        }
      } catch { }

      const entries = [{
        ...content,
        conversationId,
        messageId,
        direction: 'incoming',
        msgType: semantic.subtype || 'text',
        ts,
        tsMs: resolveMessageTsMs(ts),
        counter: Number.isFinite(resolvedCounter) ? Number(resolvedCounter) : null,
        text: content.text || text,
        senderDigest,
        senderDeviceId: resolvedSenderDeviceId,
        targetDeviceId
      }];
      try {
        adapters.appendTimelineBatch(entries, { directionalOrder: 'chronological' });
      } catch { }
    }
  }

  return {
    ok: true,
    reasonCode: null,
    counter: resolvedCounter,
    messageId,
    decryptOk: true,
    vaultPutOk: true
  };
}

async function persistAndAppendSingle(params = {}, adapters) {
  const conversationId = params?.conversationId || null;
  const decryptedMessage = params?.decryptedMessage || params?.message || null;
  const decryptedMessages = decryptedMessage ? [decryptedMessage] : [];
  return persistAndAppendBatch({ conversationId, decryptedMessages }, adapters);
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
      ...message,
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
    decryptIncomingSingle: (params = {}) => decryptIncomingSingle(params, adapters),
    commitIncomingSingle: (params = {}) => commitIncomingSingle(params, adapters),
    persistAndAppendSingle: (params = {}) => persistAndAppendSingle(params, adapters),
    persistAndAppendBatch: (params = {}) => persistAndAppendBatch(params, adapters)
  };
}
