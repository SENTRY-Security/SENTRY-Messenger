
// /app/features/messages.js
// Feature: list conversation messages and decrypt DR packets using secure conversation tokens.

import { listSecureMessages } from '../api/messages.js';
import { drDecryptText } from '../crypto/dr.js';
import { drState, getUidHex } from '../core/store.js';
import {
  ensureDrReceiverState,
  persistDrSnapshot,
  recoverDrState,
  prepareDrForMessage,
  recordDrMessageHistory,
  snapshotDrState,
  restoreDrStateFromSnapshot
} from './dr-session.js';
import { decryptConversationEnvelope, computeConversationFingerprint } from './conversation.js';
import { b64UrlToBytes } from '../ui/mobile/ui-utils.js';

const decoder = new TextDecoder();
const secureFetchBackoff = new Map();
const processedMessageCache = new Map(); // conversationId -> Set(messageId)

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
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

function toMessageId(raw) {
  if (typeof raw?.id === 'string' && raw.id.length) return raw.id;
  if (typeof raw?.message_id === 'string' && raw.message_id.length) return raw.message_id;
  if (typeof raw?.messageId === 'string' && raw.messageId.length) return raw.messageId;
  return null;
}

function sortMessagesByTimeline(items) {
  if (!Array.isArray(items) || items.length <= 1) return items || [];
  const enriched = items.map((item) => ({
    raw: item,
    ts: toMessageTimestamp(item),
    id: toMessageId(item)
  }));
  enriched.sort((a, b) => {
    const aHasTs = Number.isFinite(a.ts);
    const bHasTs = Number.isFinite(b.ts);
    if (aHasTs && bHasTs && a.ts !== b.ts) return a.ts - b.ts;
    if (aHasTs && !bHasTs) return 1;
    if (!aHasTs && bHasTs) return -1;
    if (a.id && b.id && a.id !== b.id) return a.id.localeCompare(b.id);
    if (a.id && !b.id) return 1;
    if (!a.id && b.id) return -1;
    return 0;
  });
  return enriched.map((entry) => entry.raw);
}

function isDrDebugEnabled() {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  if (typeof window !== 'undefined' && window.__DEBUG_DR_STATE__) return true;
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('debug-dr-log') === '1') return true;
  } catch {}
  return false;
}

function snapshotForDebug(state) {
  try {
    return snapshotDrState(state, { setDefaultUpdatedAt: false });
  } catch {
    return null;
  }
}

function logDrDebug(event, payload) {
  if (!isDrDebugEnabled()) return;
  try {
    const printable = JSON.stringify({ event, ...payload }, null, 2);
    console.log('[dr-debug]', printable);
  } catch {
    console.log('[dr-debug]', { event, ...payload });
  }
}

function urlB64ToStd(b64url) {
  let s = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  return s;
}

export async function listSecureAndDecrypt({ conversationId, tokenB64, peerUidHex, limit = 20, cursorTs, mutateState = true }) {
  if (!conversationId) throw new Error('conversationId required');
  if (!tokenB64) throw new Error('conversation token required');
  if (!peerUidHex) throw new Error('peerUidHex required');

  const now = Date.now();
  const backoffUntil = secureFetchBackoff.get(conversationId) || 0;
  if (now < backoffUntil) {
    return {
      items: [],
      nextCursorTs: null,
      errors: ['訊息服務暫時無法使用，請稍後再試。']
    };
  }

  const { r, data } = await listSecureMessages({ conversationId, limit, cursorTs });
  const out = [];
  const errs = [];
  let state = drState(peerUidHex);
  let items = [];
  let nextCursorTs = null;
  if (!r.ok) {
    if (r.status === 404 || r.status >= 500) {
      errs.push(`訊息服務暫時無法使用（HTTP ${r.status}）`);
      if (r.status >= 500) {
        secureFetchBackoff.set(conversationId, now + 60_000);
      }
    } else {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      throw new Error('listSecureMessages failed: ' + msg);
    }
  } else {
    items = Array.isArray(data?.items) ? data.items : [];
    nextCursorTs = data?.nextCursorTs ?? null;
    if (items.length || nextCursorTs !== null) {
      secureFetchBackoff.delete(conversationId);
    }
  }
  const drDebug = isDrDebugEnabled();
  let fingerprintPeer = null;
  let fingerprintSelf = null;
  try { fingerprintPeer = await computeConversationFingerprint(tokenB64, peerUidHex); } catch {}
  try {
    const selfUid = getUidHex();
    if (selfUid) fingerprintSelf = await computeConversationFingerprint(tokenB64, selfUid);
  } catch {}

  await ensureDrReceiverState({ peerUidHex });

  const sortedItems = sortMessagesByTimeline(items);
  const shouldTrackState = mutateState !== false;
  let stateSnapshotBeforeBatch = null;
  let cursorBackup = null;
  if (!shouldTrackState) {
    try {
      stateSnapshotBeforeBatch = snapshotDrState(state, { setDefaultUpdatedAt: false });
      cursorBackup = {
        ts: Number.isFinite(state?.historyCursorTs) ? state.historyCursorTs : null,
        id: state?.historyCursorId || null
      };
    } catch {
      stateSnapshotBeforeBatch = null;
      cursorBackup = { ts: null, id: null };
    }
  }

  if (drDebug) {
    try {
      console.log('[dr-list]', JSON.stringify({
        peerUidHex,
        conversationId,
        mutateState: shouldTrackState,
        cursorTs: cursorTs ?? null,
        nextCursorTs,
        itemsRequested: sortedItems.length
      }));
    } catch {}
  }

  for (const raw of sortedItems) {
    try {
      let decrypted = false;
      let lastError = null;
      const payload = await decryptConversationEnvelope(tokenB64, raw?.payload_envelope || raw?.payloadEnvelope || raw?.payload);
      const headerJson = decoder.decode(b64UrlToBytes(payload.hdr_b64));
      const header = JSON.parse(headerJson);
      const ciphertextB64 = urlB64ToStd(payload.ct_b64);
      const pkt = {
        aead: 'aes-256-gcm',
        header,
        iv_b64: header?.iv_b64,
        ciphertext_b64: ciphertextB64
      };
      if (!pkt.iv_b64) {
        errs.push('缺少訊息 IV，無法進行 DR 解密');
        console.warn('[messages] secure decrypt skipped', { id: raw?.id, error: 'MissingIV' });
        continue;
      }
      if (header?.fallback) {
        errs.push('偵測到舊版 fallback 封包，已不再支援');
        console.warn('[messages] secure decrypt skipped', { id: raw?.id, error: 'FallbackNotSupported' });
        continue;
      }
      const msgTs = Number(payload?.meta?.ts || raw?.created_at || raw?.createdAt || null);
      const messageId = raw?.id || null;
      if (shouldTrackState && wasMessageProcessed(conversationId, messageId)) {
        if (drDebug) {
          console.log('[dr-skip-message]', JSON.stringify({ peerUidHex, messageId, reason: 'processed-cache' }));
        }
        continue;
      }
      let prepResult = null;
      if (Number.isFinite(msgTs)) {
        prepResult = prepareDrForMessage({ peerUidHex, messageTs: msgTs, messageId });
        if (prepResult?.duplicate) {
          if (drDebug) {
            console.log('[dr-skip-message]', JSON.stringify({ peerUidHex, messageId, reason: 'duplicate' }));
          }
          continue;
        }
        if (prepResult?.restored) {
          state = drState(peerUidHex);
        }
      }

      for (let attempt = 0; attempt < 2 && !decrypted; attempt += 1) {
        let snapshotBefore = null;
        try {
          state = drState(peerUidHex);
          snapshotBefore = Number.isFinite(msgTs) ? snapshotDrState(state, { setDefaultUpdatedAt: false }) : null;
          const text = await drDecryptText(state, pkt);
          const ts = Number(payload?.meta?.ts || raw?.created_at || null) || null;
          const senderFingerprint = payload?.meta?.sender_fingerprint || payload?.meta?.fingerprint || null;
          let direction = 'unknown';
          if (senderFingerprint && fingerprintSelf && senderFingerprint === fingerprintSelf) direction = 'outgoing';
          else if (senderFingerprint && fingerprintPeer && senderFingerprint === fingerprintPeer) direction = 'incoming';
          if (shouldTrackState && snapshotBefore && Number.isFinite(msgTs)) {
            recordDrMessageHistory({ peerUidHex, messageTs: msgTs, messageId, snapshot: snapshotBefore });
          }
          if (shouldTrackState) {
            markMessageProcessed(conversationId, messageId);
            persistDrSnapshot({ peerUidHex, state });
          }
          out.push({
            id: raw?.id || null,
            ts,
            text,
            header,
            meta: payload?.meta || null,
            direction,
            raw
          });
          decrypted = true;
        } catch (err) {
          lastError = err;
          const msg = err?.message || String(err);
          const isOpError = typeof msg === 'string' && msg.includes('OperationError');
          if (isOpError) {
            logDrDebug('decrypt-operation-error', {
              peerUidHex,
              messageId: raw?.id || null,
              ts: Number.isFinite(msgTs) ? msgTs : null,
              header,
              snapshotBefore: snapshotBefore || null,
              snapshotAfter: snapshotForDebug(drState(peerUidHex))
            });
            if (snapshotBefore) {
              try {
                restoreDrStateFromSnapshot({ peerUidHex, snapshot: snapshotBefore, force: true });
                state = drState(peerUidHex);
              } catch (restoreErr) {
                console.warn('[messages] dr snapshot rollback failed', restoreErr);
              }
            }
          }
          if (attempt === 0 && isOpError) {
            const recovered = await recoverDrState({ peerUidHex });
            if (recovered) {
              state = drState(peerUidHex);
              continue;
            }
          }
          break;
        }
      }

      if (!decrypted) {
        const msg = lastError?.message || String(lastError || 'decrypt failed');
        errs.push(msg);
        console.warn('[messages] secure decrypt skipped', { id: raw?.id, error: msg });
      }
    } catch (err) {
      const msg = err?.message || String(err);
      errs.push(msg);
      console.warn('[messages] secure decrypt skipped', { id: raw?.id, error: msg });
    }
  }

  if (!shouldTrackState && stateSnapshotBeforeBatch) {
    try {
      restoreDrStateFromSnapshot({ peerUidHex, snapshot: stateSnapshotBeforeBatch, force: true });
      const holder = drState(peerUidHex);
      if (holder) {
        holder.historyCursorTs = cursorBackup?.ts ?? null;
        holder.historyCursorId = cursorBackup?.id || null;
      }
      if (drDebug) {
        console.log('[dr-list-restore-snapshot]', JSON.stringify({
          peerUidHex,
          conversationId,
          restoredCursorTs: holder?.historyCursorTs || null,
          restoredCursorId: holder?.historyCursorId || null
        }));
      }
    } catch (err) {
      console.warn('[messages] restore batch snapshot failed', err);
    }
  }

  return {
    items: out,
    nextCursorTs,
    errors: errs
  };
}
function wasMessageProcessed(conversationId, messageId) {
  if (!conversationId || !messageId) return false;
  const set = processedMessageCache.get(conversationId);
  return !!(set && set.has(messageId));
}

function markMessageProcessed(conversationId, messageId, maxEntries = 200) {
  if (!conversationId || !messageId) return;
  let set = processedMessageCache.get(conversationId);
  if (!set) {
    set = new Set();
    processedMessageCache.set(conversationId, set);
  }
  set.add(messageId);
  if (set.size > maxEntries) {
    const first = set.values().next();
    if (!first.done) set.delete(first.value);
  }
}
