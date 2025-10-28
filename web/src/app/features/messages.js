
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
  restoreDrStateFromSnapshot,
  restoreDrStateToHistoryPoint
} from './dr-session.js';
import { decryptConversationEnvelope, computeConversationFingerprint } from './conversation.js';
import { b64UrlToBytes } from '../ui/mobile/ui-utils.js';
import { b64u8 } from '../crypto/nacl.js';
import { saveEnvelopeMeta } from './media.js';

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

async function decryptWithMessageKey({ messageKeyB64, ivB64, ciphertextB64 }) {
  if (!messageKeyB64) throw new Error('message key missing');
  const keyU8 = b64u8(messageKeyB64);
  const ivU8 = b64u8(ivB64);
  const ctU8 = b64u8(ciphertextB64);
  const key = await crypto.subtle.importKey('raw', keyU8, 'AES-GCM', false, ['decrypt']);
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivU8 }, key, ctU8);
  return decoder.decode(ptBuf);
}

function normalizeMediaDir(dir) {
  if (!dir) return null;
  if (Array.isArray(dir)) {
    const normalized = dir.map((seg) => String(seg || '').trim()).filter(Boolean);
    return normalized.length ? normalized : null;
  }
  const parts = String(dir || '')
    .split('/')
    .map((seg) => String(seg || '').trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

function parseMediaMessage({ plaintext, meta }) {
  let parsed = null;
  if (typeof plaintext === 'string') {
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object') parsed = null;
  const metaMedia = meta?.media || {};
  const objectKey = parsed?.objectKey || parsed?.object_key || metaMedia?.object_key || null;
  const envelope = parsed?.envelope || metaMedia?.envelope || null;
  const name =
    parsed?.name ||
    metaMedia?.name ||
    (objectKey ? objectKey.split('/').pop() : null) ||
    '附件';
  const sizeRaw = parsed?.size ?? metaMedia?.size;
  const size = Number.isFinite(Number(sizeRaw)) ? Number(sizeRaw) : null;
  const contentType = parsed?.contentType || parsed?.mimeType || metaMedia?.content_type || null;
  const dirSource = parsed?.dir ?? metaMedia?.dir ?? null;
  const dir = normalizeMediaDir(dirSource);

  if (objectKey && envelope) {
    try { saveEnvelopeMeta(objectKey, envelope); } catch {}
  }

  const mediaInfo = {
    objectKey,
    name,
    size,
    contentType,
    envelope: envelope || null,
    dir,
    senderFingerprint: meta?.sender_fingerprint || null
  };

  if (parsed?.sha256) mediaInfo.sha256 = parsed.sha256;
  if (parsed?.localUrl) mediaInfo.localUrl = parsed.localUrl;
  if (parsed?.previewUrl) mediaInfo.previewUrl = parsed.previewUrl;

  return mediaInfo;
}

function buildMessageObject({ plaintext, payload, header, raw, direction, ts, messageId, messageKeyB64 }) {
  const meta = payload?.meta || null;
  const baseId = messageId || toMessageId(raw) || null;
  const timestamp = Number.isFinite(ts) ? ts : null;
  const base = {
    id: baseId,
    ts: timestamp,
    header,
    meta,
    direction,
    raw,
    type: 'text',
    text: typeof plaintext === 'string' ? plaintext : '',
    messageKey_b64: messageKeyB64 || null
  };

  if (meta?.msg_type === 'media') {
    const mediaInfo = parseMediaMessage({ plaintext, meta });
    base.type = 'media';
    base.media = mediaInfo || null;
    base.text = mediaInfo ? `[檔案] ${mediaInfo.name || '附件'}` : (typeof plaintext === 'string' ? plaintext : '[媒體]');
    if (base.media && messageKeyB64) {
      base.media.messageKey_b64 = messageKeyB64;
    }
  } else {
    base.type = 'text';
    base.text = typeof base.text === 'string' ? base.text : '';
  }

  if (typeof base.text === 'string') {
    base.text = base.text.trim();
  }

  return base;
}

export async function listSecureAndDecrypt({ conversationId, tokenB64, peerUidHex, limit = 20, cursorTs, mutateState = true, allowReplay = false }) {
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
  const allowCursorReplay = !!allowReplay || !shouldTrackState;
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
      const messageTs = Number.isFinite(msgTs) ? msgTs : null;
      const messageId = toMessageId(raw);
      if (shouldTrackState && wasMessageProcessed(conversationId, messageId)) {
        if (drDebug) {
          console.log('[dr-skip-message]', JSON.stringify({ peerUidHex, messageId, reason: 'processed-cache' }));
        }
        continue;
      }
      let prepResult = null;
      let replayHandled = false;
      let messageKeyB64 = null;
      const meta = payload?.meta || null;
      const senderFingerprint = meta?.sender_fingerprint || meta?.fingerprint || null;
      let direction = 'unknown';
      if (senderFingerprint && fingerprintSelf && senderFingerprint === fingerprintSelf) direction = 'outgoing';
      else if (senderFingerprint && fingerprintPeer && senderFingerprint === fingerprintPeer) direction = 'incoming';
      if (Number.isFinite(msgTs)) {
        prepResult = prepareDrForMessage({
          peerUidHex,
          messageTs: msgTs,
          messageId,
          allowCursorReplay
        });
        const historyEntry = prepResult?.historyEntry || null;
        if (prepResult?.duplicate) {
          if (drDebug) {
            console.log('[dr-skip-message]', JSON.stringify({ peerUidHex, messageId, reason: 'duplicate' }));
          }
          continue;
        }
        if (prepResult?.restored) {
          state = drState(peerUidHex);
        }
        if (!decrypted && allowCursorReplay && prepResult?.historyEntry?.messageKey_b64) {
          try {
            const replayText = await decryptWithMessageKey({
              messageKeyB64: prepResult.historyEntry.messageKey_b64,
              ivB64: pkt.iv_b64,
              ciphertextB64
            });
            if (shouldTrackState) {
              markMessageProcessed(conversationId, messageId);
              try {
                if (historyEntry?.snapshotAfter) {
                  restoreDrStateFromSnapshot({
                    peerUidHex,
                    snapshot: historyEntry.snapshotAfter,
                    force: true
                  });
                  state = drState(peerUidHex);
                } else if (historyEntry?.snapshot) {
                  restoreDrStateFromSnapshot({
                    peerUidHex,
                    snapshot: historyEntry.snapshot,
                    force: true
                  });
                  const replayState = drState(peerUidHex);
                  if (replayState) {
                    await drDecryptText(replayState, pkt, {
                      onMessageKey: () => {}
                    });
                    state = replayState;
                  }
                }
                if (state) {
                  persistDrSnapshot({ peerUidHex, state });
                }
              } catch (advanceErr) {
                if (drDebug) {
                  console.warn('[messages] replay state advance failed', advanceErr);
                }
              }
            }
            const messageObj = buildMessageObject({
              plaintext: replayText,
              payload,
              header,
              raw,
              direction,
              ts: messageTs,
              messageId,
              messageKeyB64: prepResult.historyEntry?.messageKey_b64 || null
            });
            if (messageObj) out.push(messageObj);
            decrypted = true;
            replayHandled = true;
          } catch (replayErr) {
            if (drDebug) {
              console.warn('[messages] replay decrypt failed', replayErr);
            }
            if (drDebug) {
              console.warn('[messages] replay decrypt failed, falling back to ratchet', {
                peerUidHex,
                messageId,
                cursorTs,
                iv_b64: pkt.iv_b64
              });
            }
          }
        }
      }

      if (replayHandled) {
        continue;
      }

      for (let attempt = 0; attempt < 2 && !decrypted; attempt += 1) {
        let snapshotBefore = null;
        try {
          state = drState(peerUidHex);
          snapshotBefore = Number.isFinite(msgTs) ? snapshotDrState(state, { setDefaultUpdatedAt: false }) : null;
          const text = await drDecryptText(state, pkt, {
            onMessageKey: (mk) => {
              messageKeyB64 = mk;
            }
          });
          const snapshotAfter = snapshotDrState(state, { setDefaultUpdatedAt: false });
          if (shouldTrackState && snapshotBefore && Number.isFinite(msgTs)) {
            recordDrMessageHistory({
              peerUidHex,
              messageTs: msgTs,
              messageId,
              snapshot: snapshotBefore,
              snapshotNext: snapshotAfter,
              messageKeyB64
            });
          }
          if (shouldTrackState) {
            markMessageProcessed(conversationId, messageId);
            persistDrSnapshot({ peerUidHex, state });
          }
          const messageObj = buildMessageObject({
            plaintext: text,
            payload,
            header,
            raw,
            direction,
            ts: messageTs,
            messageId,
            messageKeyB64
          });
          if (messageObj) out.push(messageObj);
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
            let restoredFromHistory = false;
            if (Number.isFinite(msgTs) || messageId) {
              try {
                restoredFromHistory = restoreDrStateToHistoryPoint({
                  peerUidHex,
                  ts: Number.isFinite(msgTs) ? msgTs : null,
                  messageId: messageId || null
                });
              } catch (historyErr) {
                if (drDebug) {
                  console.warn('[messages] history restore during op-error failed', historyErr);
                }
              }
              if (!restoredFromHistory && Number.isFinite(msgTs)) {
                try {
                  restoredFromHistory = restoreDrStateToHistoryPoint({
                    peerUidHex,
                    ts: msgTs - 1,
                    messageId: null
                  });
                } catch (historyErr) {
                  if (drDebug) {
                    console.warn('[messages] secondary history restore failed', historyErr);
                  }
                }
              }
            }
            if (restoredFromHistory) {
              state = drState(peerUidHex);
              continue;
            }
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
