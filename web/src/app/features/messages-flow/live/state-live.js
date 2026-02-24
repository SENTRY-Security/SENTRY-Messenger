// /app/features/messages-flow/live/state-live.js
// State access for live (B-route) flow.

import { classifyDecryptedPayload, SEMANTIC_KIND } from '../../semantic.js';
import { SECURE_CONVERSATION_STATUS } from '../../secure-conversation-manager.js';
import { DEBUG } from '../../../ui/mobile/debug-flags.js';
import { applyContactShareFromCommit } from '../../contacts.js';
// import { normalizeTimelineEntry } from '../normalize.js';
import { enqueueDrSessionOp, enqueueDrIncomingOp } from '../../dr-session.js';
import { normalizeCallLogPayload, resolveViewerRole, describeCallLogForViewer } from '../../calls/call-log.js';
import { removePendingLivePlaceholder } from '../../messages/placeholder-store.js';

/**
 * Deep-clone the critical DR ratchet fields so we can restore them
 * if a downstream operation (vault put) fails after drDecryptText
 * has already advanced the shared in-memory state.
 */
function snapshotDrStateFields(st) {
  if (!st) return null;
  try {
    // structuredClone correctly handles Uint8Array, Map, nested structures
    return structuredClone({
      ckR: st.ckR,
      ckS: st.ckS,
      rk: st.rk,
      Nr: st.Nr,
      Ns: st.Ns,
      NrTotal: st.NrTotal,
      NsTotal: st.NsTotal,
      myRatchetPriv: st.myRatchetPriv,
      myRatchetPub: st.myRatchetPub,
      peerRatchetPub: st.peerRatchetPub,
      MKSkipped: st.MKSkipped || null
    });
  } catch {
    return null;
  }
}

/**
 * Restore DR state fields from a snapshot, rolling back drDecryptText's
 * in-place mutations.  This lets the same message be retried (e.g. via
 * gap queue) without losing the chain key.
 */
function restoreDrStateFields(st, snapshot) {
  if (!st || !snapshot) return false;
  // Receive-side fields: restore unconditionally (that's the point of rollback)
  st.ckR = snapshot.ckR;
  st.rk = snapshot.rk;
  st.Nr = snapshot.Nr;
  st.NrTotal = snapshot.NrTotal;
  st.peerRatchetPub = snapshot.peerRatchetPub;
  if (snapshot.MKSkipped !== undefined) st.MKSkipped = snapshot.MKSkipped;
  // [FIX] Send-side fields: use Math.max to avoid rolling back concurrent
  // drEncryptText advances that occurred during our async decrypt window.
  const snapNs = Number.isFinite(snapshot.Ns) ? Number(snapshot.Ns) : 0;
  const snapNsTotal = Number.isFinite(snapshot.NsTotal) ? Number(snapshot.NsTotal) : 0;
  st.Ns = Math.max(snapNs, Number.isFinite(st.Ns) ? Number(st.Ns) : 0);
  st.NsTotal = Math.max(snapNsTotal, Number.isFinite(st.NsTotal) ? Number(st.NsTotal) : 0);
  // Preserve live ckS / keypair if they've advanced beyond the snapshot
  st.ckS = st.ckS || snapshot.ckS;
  st.myRatchetPriv = st.myRatchetPriv || snapshot.myRatchetPriv;
  st.myRatchetPub = st.myRatchetPub || snapshot.myRatchetPub;
  return true;
}

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

  if (!conversationId || !tokenB64) {
    return { ok: false, reasonCode: 'MISSING_PARAMS' };
  }

  const resolvedPeerDigest = resolveSenderDigest(raw, header) || peerAccountDigest;
  const resolvedPeerDeviceId = resolveSenderDeviceId(raw, header) || peerDeviceId;

  if (!resolvedPeerDigest || !resolvedPeerDeviceId) {
    return { ok: false, reasonCode: 'MISSING_PARAMS' };
  }

  if (!adapters?.ensureSecureConversationReady || (!skipDrCheck && (!adapters?.ensureDrReceiverState || !adapters?.drState))) {
    return { ok: false, reasonCode: 'ADAPTERS_UNAVAILABLE' };
  }
  let secureStatus = null;
  try {
    secureStatus = await adapters.ensureSecureConversationReady({
      peerAccountDigest: resolvedPeerDigest,
      peerDeviceId: resolvedPeerDeviceId,
      conversationId,
      reason: 'live_mvp',
      source: 'messages-flow/live:ensureLiveReady'
    });
  } catch (err) {
    return { ok: false, reasonCode: 'SECURE_FAILED', errorMessage: err?.message || String(err) };
  }
  const status = secureStatus?.status || null;
  if (status !== SECURE_CONVERSATION_STATUS.READY) {
    // [FIX] Allow contact-share to proceed even if status is PENDING/FAILED.
    // This message is what transitions the state to READY.
    if (!skipDrCheck) {
      const reasonCode = status === SECURE_CONVERSATION_STATUS.FAILED
        ? 'SECURE_FAILED'
        : 'SECURE_PENDING';
      return { ok: false, reasonCode };
    }
  }

  const { digest: readyPeerAccountDigest, deviceId: readyPeerDeviceId } = (typeof secureStatus?.peerAccountDigest === 'string' && secureStatus.peerAccountDigest.includes('::'))
    ? {
      digest: secureStatus.peerAccountDigest.split('::')[0],
      deviceId: secureStatus.peerAccountDigest.split('::')[1]
    }
    : { digest: resolvedPeerDigest, deviceId: resolvedPeerDeviceId };

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
  // [Fix] Prioritize raw/header sender identity over context params.
  // This ensures that "Gap Fill" (Offline) messages are processed using their ORIGINAL Sender Device ID,
  // not the current conversational context (which might be a newer device ID).
  const senderDigest = resolveSenderDigest(raw, header) || peerAccountDigest;
  const senderDeviceId = resolveSenderDeviceId(raw, header) || peerDeviceId;

  const meta = raw?.meta || header?.meta || null;
  const msgTypeHint = resolveMsgType(meta, header);
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

  // [MUTEX] Wrap in Session Lock
  // We use the same lock key as Sending (peer::deviceId) to serialize critical DR operations.
  // This prevents race conditions where Send/Recv interleave and corrupt shared state.
  // [MUTEX] Two-Level Locking
  // 1. Incoming Sequence Lock (enqueueDrIncomingOp): Serializes Live vs Offline Batch.
  // 2. State Access Lock (enqueueDrSessionOp): Serializes DB/Memory access (vs Sending).
  // Live Messages must wait for Incoming Lock (unless skipped by Batch).
  // EVERYONE must wait for State Lock (to ensure DB consistency).
  const lockKey = senderDeviceId ? `${senderDigest}::${senderDeviceId}` : senderDigest;

  const stateOp = () => enqueueDrSessionOp(lockKey, async () => {
    let rawState = adapters.drState({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId });

    // [DEBUG-TRACE]
    if (DEBUG.drVerbose) {
      console.log('[state-live] live-text check state', {
        peer: senderDigest ? senderDigest.slice(0, 8) : null,
        hasState: !!rawState,
        hasRk: !!rawState?.rk,
        ns: rawState?.Ns,
        nr: rawState?.Nr
      });
    }

    // [FIX] X3DH PreKey Bootstrap — BEFORE hasUsableDrState guard.
    // When a PreKey message (Type 3) arrives, the header carries ik/ek/spk fields
    // sufficient to bootstrap a new DR session (Responder role).
    // Previously this code lived AFTER the hasUsableDrState check, making it
    // unreachable when the QR displayer received the scanner's first message
    // before handleContactInitEvent had completed (no DR state yet).
    // This caused a brief "無法解密" flash followed by tombstone after retry.
    // Moving it here ensures both:
    //   1. New sessions: bootstrap creates DR state from the PreKey header.
    //   2. Existing sessions: bootstrap resets (force:true) to accept a peer session reset.
    const headerIk = header?.ik || header?.ik_pub || header?.ik_pub_b64 || null;
    if (headerIk) {
      if (adapters.bootstrapDrFromGuestBundle) {
        try {
          await adapters.bootstrapDrFromGuestBundle({
            guestBundle: {
              ik_pub: headerIk,
              ek_pub: header?.ek || header?.ek_pub || header?.ek_pub_b64 || null,
              spk_pub: header?.spk || header?.spk_pub || header?.spk_pub_b64 || null,
              spk_sig: header?.spk_sig || header?.spk_sig_b64 || null,
              opk_id: header?.opk_id || header?.opkId || null
            },
            peerAccountDigest: senderDigest,
            peerDeviceId: senderDeviceId,
            conversationId,
            force: true // Accept the reset
          });
          // Refresh state after bootstrap
          const bootstrappedState = adapters.drState({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId });
          if (hasUsableDrState(bootstrappedState)) {
            rawState = bootstrappedState;
          }
        } catch (err) {
          console.warn('[state-live] PreKey bootstrap failed', err);
          // Fallthrough to hasUsableDrState check (likely fails, but consistent)
        }
      } else {
        console.warn('[state-live] bootstrapDrFromGuestBundle adapter missing');
      }
    }

    if (!hasUsableDrState(rawState)) {
      console.warn('[state-live] DR state missing for text message', { senderDigest, senderDeviceId, hadPreKeyHeader: !!headerIk });
      return {
        ...base,
        reasonCode: 'DR_STATE_UNAVAILABLE',
        skippedCount: 1
      };
    }

    // [FIX] Use Direct Store Reference (No Clone)
    // We MUST operate on the shared memory object to ensure that even if disk persistence fails (or lags),
    // the in-memory session state is correctly advanced for subsequent messages.
    // Previous use of `structuredClone` caused "Ghost State" where memory stayed at Counter 0 if persist failed.
    const state = rawState;

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

    // [FIX] Snapshot DR state BEFORE drDecryptText so we can rollback
    // if vault put fails after decrypt succeeds (same pattern as commitIncomingSingle).
    const drStateBeforeDecrypt = snapshotDrStateFields(state);

    const skippedKeysBuffer = [];
    try {
      plaintext = await adapters.drDecryptText(state, {
        aead: 'aes-256-gcm',
        header,
        iv_b64: header.iv_b64,
        ciphertext_b64: ciphertextB64
      }, {
        onMessageKey: (mk) => { messageKeyB64 = mk; },
        onSkippedKeys: (keys) => {
          if (Array.isArray(keys)) keys.forEach(k => skippedKeysBuffer.push(k));
        },
        packetKey,
        msgType: msgTypeHint || 'text'
      });

      // 1. Vault Skipped Keys (best-effort, re-derivable on retry)
      if (skippedKeysBuffer.length && adapters.vaultPutIncomingKey) {
        let skippedDrStateSnapshot = null;
        if (adapters.snapshotAndEncryptDrState) {
          try {
            skippedDrStateSnapshot = await adapters.snapshotAndEncryptDrState(senderDigest, senderDeviceId);
          } catch { }
        }
        try {
          await Promise.all(skippedKeysBuffer.map(k => {
            const gapCounter = k.headerCounter;
            const gapMessageId = `gap:v1:${gapCounter}`;
            return adapters.vaultPutIncomingKey({
              conversationId,
              messageId: gapMessageId,
              senderDeviceId,
              targetDeviceId: selfDeviceId,
              direction: 'incoming',
              msgType: 'gap-fill',
              messageKeyB64: k.messageKeyB64,
              headerCounter: gapCounter,
              drStateSnapshot: skippedDrStateSnapshot
            });
          }));
          if (skippedKeysBuffer.length > 0) console.log('[state-live] vaulted skipped keys', skippedKeysBuffer.length);
        } catch (e) {
          console.warn('[state-live] skipped-key vault failed', e);
        }
      }

      // 2. [FIX] Vault put for the MAIN message key — inside DR lock for atomicity.
      //    If vault put fails we rollback DR state so the chain key is preserved
      //    for retry, enforcing the invariant: state only advances when key is
      //    safely committed to vault.
      if (messageKeyB64 && messageId && adapters.vaultPutIncomingKey) {
        const vaultTargetDeviceId = resolveTargetDeviceId(raw, header) || selfDeviceId || null;
        try {
          let encryptedDrSnapshot = null;
          if (adapters.snapshotAndEncryptDrState) {
            try { encryptedDrSnapshot = await adapters.snapshotAndEncryptDrState(senderDigest, senderDeviceId); } catch { }
          }
          await adapters.vaultPutIncomingKey({
            conversationId,
            messageId,
            senderDeviceId,
            targetDeviceId: vaultTargetDeviceId,
            direction: 'incoming',
            msgType: msgTypeHint || 'text',
            messageKeyB64,
            headerCounter: Number.isFinite(counter) ? counter : null,
            drStateSnapshot: encryptedDrSnapshot
          });
        } catch (vaultErr) {
          // Vault put failed — rollback DR state to preserve chain key for retry
          console.warn('[state-live] live vault put failed, rolling back DR state', vaultErr);
          restoreDrStateFields(state, drStateBeforeDecrypt);
          return {
            ...base,
            reasonCode: 'VAULT_PUT_FAILED',
            processedCount: 1,
            failCount: 1
          };
        }
      }

      // 3. Persist DR state to disk only AFTER vault success
      if (adapters.persistDrSnapshot) {
        try {
          await adapters.persistDrSnapshot({
            state,
            peerAccountDigest: senderDigest,
            peerDeviceId: senderDeviceId
          });
        } catch (e) {
          console.error('[state-live] persistDrSnapshot failed - State Regression Risk!', e);
        }
      }
    } catch (err) {
      // Enhanced logging for OperationError (often subtle Key/AAD mismatch)
      if (err.name === 'OperationError' || err.message === 'OperationError') {
        try {
          console.warn('[state-live] decryption fail details', {
            reason: 'OperationError',
            conv: conversationIdPrefix8,
            hKeys: header ? Object.keys(header).sort() : [],
            ik: !!headerIk,
            hasState: !!state,
            rs: state?.baseKey?.role || 'unknown'
          });
        } catch { }
      }
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
      // Allow conversation-deleted and contact-share to pass through Live Route B.
      const isAllowedControl = semantic.subtype === 'conversation-deleted' || semantic.subtype === 'contact-share';

      if (semantic.kind !== SEMANTIC_KIND.USER_MESSAGE && !isAllowedControl) {
        result.reasonCode = 'CONTROL_SKIP';
        result.skippedCount = 1;
      } else {
        const targetDeviceId = resolveTargetDeviceId(raw, header) || selfDeviceId || null;
        const text = typeof plaintext === 'string' ? plaintext : String(plaintext ?? '');
        const ts = Number(raw.ts || raw.created_at || raw.createdAt || (meta?.ts) || Date.now() / 1000);

        let content = {};
        try {
          if (text.trim().startsWith('{')) {
            content = JSON.parse(text);
          } else {
            content = { text };
          }
        } catch {
          content = { text };
        }

        let msgType = content.type;
        if (!msgType && semantic.subtype === 'conversation-deleted') {
          msgType = 'conversation-deleted';
        }
        if (!msgType && semantic.subtype === 'contact-share') {
          msgType = 'contact-share';
        }
        if (!msgType && semantic.subtype === 'call-log') {
          msgType = 'call-log';
        }
        if (!msgType && semantic.subtype === 'system') {
          msgType = 'system';
        }
        if (!msgType) msgType = 'text';

        // [contact-share] Process contact payload from DR-decrypted plaintext
        // The contact-share tombstone itself now displays reason-aware text
        // (e.g., "已更新暱稱", "已更新頭像") via the renderer, so separate
        // system tombstones are no longer needed.
        if (msgType === 'contact-share') {
          try {
            const messageTs = Number(raw?.ts || raw?.created_at || raw?.timestamp || Date.now());
            const applyResult = await applyContactShareFromCommit({
              peerAccountDigest: senderDigest,
              peerDeviceId: senderDeviceId,
              sessionKey: tokenB64,
              plaintext: text,
              messageId,
              sourceTag: 'messages-flow:contact-share-commit',
              profileUpdatedAt: messageTs
            });
            console.log('[state-live] contact-share applyResult', applyResult);
          } catch (err) {
            console.warn('[state-live] contact-share apply failed', err);
          }
        }

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

        // Build callLog nested object for call-log messages (renderer requires msg.callLog)
        let callLog = null;
        if (msgType === 'call-log') {
          callLog = normalizeCallLogPayload(content, meta || {});
          const viewerRole = resolveViewerRole(callLog.authorRole, 'incoming');
          const { label, subLabel } = describeCallLogForViewer(callLog, viewerRole);
          callLog = { ...callLog, viewerRole, label, subLabel };
        }

        // Merge parsed content for media fields, but enforce secure properties
        result.decryptedMessage = {
          ...content,
          id: messageId,
          messageId,
          serverMessageId: messageId || raw.serverMessageId || null,
          ts,
          tsMs: resolveMessageTsMs(ts),
          direction: 'incoming',
          msgType,
          media,
          callLog,
          text: (msgType === 'call-log' && callLog) ? (callLog.label || 'Call') : (content.text || text),
          messageKeyB64,
          counter,
          headerCounter: counter,
          senderDeviceId,
          targetDeviceId,
          senderDigest,
          header: header || null,
          // [FIX] Signal that vault put was done atomically inside the DR lock.
          // persistAndAppendBatch should skip vault put for this message.
          _vaultPutDone: true
        };
        result.okCount = 1;

        // Debug Log for Tombstone Verification
        if (msgType === 'conversation-deleted' || msgType === 'contact-share' || msgType === 'call-log' || msgType === 'system') {
          console.log('[Decrypted Tombstone Payload] (Live Route B)', result.decryptedMessage);
        }
      }
    }

    // Return mutated state so caller can persist it explicitly
    // Return mutated state so caller can persist it explicitly
    result.mutatedState = state;
    return result;
  }); // End enqueueDrSessionOp (State Mutex)

  if (params?.skipIncomingLock) {
    return stateOp();
  }
  return enqueueDrIncomingOp(lockKey, stateOp);
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


  // [Fix] Prioritize raw/header sender identity over context params.
  // This ensures that "Gap Fill" (Offline) messages are processed using their ORIGINAL Sender Device ID,
  // not the current conversational context (which might be a newer device ID).
  senderDigest = resolveSenderDigest(raw, header) || peerAccountDigest;
  senderDeviceId = resolveSenderDeviceId(raw, header) || peerDeviceId;

  if (!senderDigest || !senderDeviceId) {
    return { ...base, reasonCode: 'MISSING_SENDER_IDENTITY' };
  }
  const counter = resolveCounter(raw, header);
  const resolvedCounter = Number.isFinite(counter) ? counter : baseCounter;
  const meta = raw?.meta || header?.meta || null;
  const msgTypeHint = resolveMsgType(meta, header);
  const rawMessageId = normalizeMessageId(raw);
  const messageId = rawMessageId || targetMessageId;
  if (!adapters?.drDecryptText || !adapters?.drState || !adapters?.vaultPutIncomingKey) {
    return { ...base, reasonCode: 'ADAPTERS_UNAVAILABLE' };
  }
  let state = adapters.drState({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId });

  // [FIX] X3DH PreKey Bootstrap — BEFORE hasUsableDrState guard.
  // Same fix as decryptIncomingSingle: when a PreKey message (Type 3) arrives
  // for a new contact, bootstrap the DR session from the header before checking state.
  const headerIk = header?.ik || header?.ik_pub || header?.ik_pub_b64 || null;
  if (headerIk && !hasUsableDrState(state) && adapters.bootstrapDrFromGuestBundle) {
    try {
      await adapters.bootstrapDrFromGuestBundle({
        guestBundle: {
          ik_pub: headerIk,
          ek_pub: header?.ek || header?.ek_pub || header?.ek_pub_b64 || null,
          spk_pub: header?.spk || header?.spk_pub || header?.spk_pub_b64 || null,
          spk_sig: header?.spk_sig || header?.spk_sig_b64 || null,
          opk_id: header?.opk_id || header?.opkId || null
        },
        peerAccountDigest: senderDigest,
        peerDeviceId: senderDeviceId,
        conversationId,
        force: true
      });
      const bootstrappedState = adapters.drState({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId });
      if (hasUsableDrState(bootstrappedState)) {
        state = bootstrappedState;
      }
    } catch (err) {
      console.warn('[state-live] commitIncomingSingle PreKey bootstrap failed', err);
    }
  }

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
    ? `${conversationId}:${resolvedCounter} `
    : null);
  let messageKeyB64 = null;
  let plaintext = null;

  // [FIX] Snapshot DR state BEFORE drDecryptText so we can rollback
  // if vault put fails after decrypt succeeds.  This preserves the
  // chain key for retry and enforces the DR monotonic invariant:
  // state only advances when the message key is safely committed to vault.
  const drStateBeforeDecrypt = snapshotDrStateFields(state);

  const skippedKeysBuffer = [];
  try {
    plaintext = await adapters.drDecryptText(state, {
      aead: 'aes-256-gcm',
      header,
      iv_b64: header.iv_b64,
      ciphertext_b64: ciphertextB64
    }, {
      onMessageKey: (mk) => { messageKeyB64 = mk; },
      onSkippedKeys: (keys) => {
        if (Array.isArray(keys)) keys.forEach(k => skippedKeysBuffer.push(k));
      },
      packetKey,
      msgType: msgTypeHint || 'text'
    });

    if (skippedKeysBuffer.length && adapters.vaultPutIncomingKey) {
      // Get DR state snapshot for skipped keys (important for recovery)
      let skippedDrStateSnapshot = null;
      if (adapters.snapshotAndEncryptDrState) {
        try {
          skippedDrStateSnapshot = await adapters.snapshotAndEncryptDrState(senderDigest, senderDeviceId);
        } catch { }
      }

      // Await vault put for skipped keys to ensure they are persisted
      try {
        await Promise.all(skippedKeysBuffer.map(k => {
          const gapCounter = k.headerCounter;
          const gapMessageId = `gap:v1:${gapCounter}`;
          return adapters.vaultPutIncomingKey({
            conversationId,
            messageId: gapMessageId,
            senderDeviceId,
            targetDeviceId: selfDeviceId,
            direction: 'incoming',
            msgType: 'gap-fill',
            messageKeyB64: k.messageKeyB64,
            headerCounter: gapCounter,
            drStateSnapshot: skippedDrStateSnapshot
          });
        }));
        if (skippedKeysBuffer.length > 0) console.log('[state-live] vaulted skipped keys (commit)', skippedKeysBuffer.length);
      } catch (e) {
        console.warn('[state-live] skipped-key vault failed (commit)', e);
      }
    }
  } catch {
    return { ...base, reasonCode: 'DECRYPT_FAIL', counter: resolvedCounter, messageId };
  }

  // [FIX] Removed premature persistDrSnapshot. Validated Vault Put first.

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

  let drStateSnapshot = null;
  if (adapters.snapshotAndEncryptDrState) {
    try {
      drStateSnapshot = await adapters.snapshotAndEncryptDrState(senderDigest, senderDeviceId);
    } catch { }
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
      headerCounter: Number.isFinite(resolvedCounter) ? Number(resolvedCounter) : null,
      drStateSnapshot
    });
  } catch {
    // [FIX] Vault put failed — rollback DR state so the chain key is preserved
    // for retry.  Without rollback, NrTotal stays advanced in memory and the
    // message key is permanently lost (can never be re-derived).
    restoreDrStateFields(state, drStateBeforeDecrypt);
    return {
      ...base,
      reasonCode: 'VAULT_PUT_FAILED',
      counter: resolvedCounter,
      messageId,
      decryptOk: true
    };
  }

  // [FIX] Persist Local Only After Vault Success
  if (adapters?.persistDrSnapshot) {
    try {
      // We need to re-fetch the state (it's the same in-memory object)
      const stateAfter = adapters.drState({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId });
      adapters.persistDrSnapshot({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId, snapshot: stateAfter });
    } catch { }
  }

  if (adapters?.appendTimelineBatch) {
    const semantic = classifyDecryptedPayload(plaintext, { meta, header });
    const isAllowedControl = semantic.subtype === 'conversation-deleted' || semantic.subtype === 'contact-share';
    if (semantic.kind === SEMANTIC_KIND.USER_MESSAGE || isAllowedControl) {
      const ts = toMessageTimestamp(raw);
      const text = typeof plaintext === 'string' ? plaintext : String(plaintext ?? '');

      let content = {};
      try {
        if (typeof plaintext === 'string' && (plaintext.trim().startsWith('{') || plaintext.trim().startsWith('['))) {
          content = JSON.parse(plaintext);
        }
      } catch { }

      // Process contact-share payload (apply contact data)
      if (semantic.subtype === 'contact-share') {
        try {
          const batchMessageTs = Number(raw?.ts || raw?.created_at || raw?.timestamp || Date.now());
          await applyContactShareFromCommit({
            peerAccountDigest: senderDigest,
            peerDeviceId: senderDeviceId,
            sessionKey: tokenB64,
            plaintext: text,
            messageId,
            sourceTag: 'messages-flow:contact-share-commit-batch',
            profileUpdatedAt: batchMessageTs
          });
        } catch (err) {
          console.warn('[state-live] contact-share apply failed (batch)', err);
        }
      }

      let msgType = content.type || semantic.subtype || 'text';
      if (!msgType || msgType === 'text') {
        if (semantic.subtype === 'conversation-deleted') msgType = 'conversation-deleted';
        if (semantic.subtype === 'contact-share') msgType = 'contact-share';
      }

      // Build callLog nested object for call-log messages (renderer requires msg.callLog)
      let batchCallLog = null;
      if (msgType === 'call-log') {
        batchCallLog = normalizeCallLogPayload(content, meta || {});
        const batchViewerRole = resolveViewerRole(batchCallLog.authorRole, 'incoming');
        const batchDesc = describeCallLogForViewer(batchCallLog, batchViewerRole);
        batchCallLog = { ...batchCallLog, viewerRole: batchViewerRole, label: batchDesc.label, subLabel: batchDesc.subLabel };
      }

      const entries = [{
        ...content,
        conversationId,
        messageId,
        direction: 'incoming',
        msgType,
        ts,
        tsMs: resolveMessageTsMs(ts),
        counter: Number.isFinite(resolvedCounter) ? Number(resolvedCounter) : null,
        text: (msgType === 'call-log' && batchCallLog) ? (batchCallLog.label || 'Call') : (content.text || text),
        callLog: batchCallLog,
        senderDigest,
        senderDeviceId: resolvedSenderDeviceId,
        targetDeviceId
      }];
      try {
        adapters.appendTimelineBatch(entries, { directionalOrder: 'chronological' });
        // [FIX] Clean up stale live placeholder for this message.
        // After gap-queue successfully decrypts & appends to timeline via
        // commitIncomingSingle, the pendingLivePlaceholder must be removed.
        // Otherwise the render merge keeps showing "解密中" alongside the
        // real message.
        if (messageId && conversationId) {
          try { removePendingLivePlaceholder(conversationId, messageId); } catch { }
        }
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
    // [FIX] Relax Key Check for Vault-Exempt Types (Contact Share / System / Call-Log)
    const isVaultExempt = message?.msgType === 'contact-share' || message?.msgType === 'system' || message?.msgType === 'call-log';
    if (!messageId || (!message?.messageKeyB64 && !isVaultExempt)) {
      vaultPutFail += 1;
      continue;
    }

    // [FIX] If vault put was already done atomically inside the DR lock
    // (decryptIncomingSingle), skip vault put here — just append to timeline.
    if (message._vaultPutDone) {
      vaultPutOk += 1;
      appendableMessages.push(message);
      continue;
    }

    try {
      let drStateSnapshot = null;
      if (adapters.snapshotAndEncryptDrState && message.senderDigest && message.senderDeviceId) {
        try {
          drStateSnapshot = await adapters.snapshotAndEncryptDrState(message.senderDigest, message.senderDeviceId);
        } catch { } // Best effort
      }

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
          : (Number.isFinite(message?.counter) ? Number(message.counter) : null),
        drStateSnapshot
      });
      vaultPutOk += 1;

      // [FIX] Persist Local Snapshot AFTER Vault Success
      // Use mutatedState if available (from Clone), otherwise re-read (unsafe if mutated in-place but we fixed that).
      const stateToPersist = message.mutatedState || (
        adapters.drState && adapters.drState({ peerAccountDigest: message.senderDigest, peerDeviceId: message.senderDeviceId })
      );

      if (adapters.persistDrSnapshot && stateToPersist && message.senderDigest && message.senderDeviceId) {
        try {
          // [FIX] State Regression Check
          // If concurrent Live processing advanced the global state BEYOND this batch message,
          // we MUST NOT overwrite it with our older state.
          // The Live Message processing (advanced state) would have generated "Skipped Keys" for us.
          const currentGlobalState = adapters.drState({ peerAccountDigest: message.senderDigest, peerDeviceId: message.senderDeviceId });

          const currentNr = Number.isFinite(Number(currentGlobalState?.NrTotal)) ? Number(currentGlobalState.NrTotal) : -1;
          const proposedNr = Number.isFinite(Number(stateToPersist?.NrTotal)) ? Number(stateToPersist.NrTotal) : -1;

          if (currentNr > proposedNr) {
            if (DEBUG.drVerbose) console.log('[state-live] skipping stale state persist', { current: currentNr, proposed: proposedNr });
            // Do NOT persist. We are stale.
          } else {
            adapters.persistDrSnapshot({ peerAccountDigest: message.senderDigest, peerDeviceId: message.senderDeviceId, snapshot: stateToPersist });
          }
        } catch (e) {
          console.warn('[state-live] failed to persist snapshot after vault put', e);
        }
      }

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
      // [FIX] Clean up stale live placeholders after successful batch append.
      for (const entry of entries) {
        const eid = entry?.messageId || entry?.id;
        if (eid && conversationId) {
          try { removePendingLivePlaceholder(conversationId, eid); } catch { }
        }
      }
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
