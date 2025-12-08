
// /app/features/messages.js
// Feature: list conversation messages and decrypt DR packets using secure conversation tokens.

import { listSecureMessages as apiListSecureMessages } from '../api/messages.js';
import { drDecryptText as cryptoDrDecryptText } from '../crypto/dr.js';
import {
  drState as storeDrState,
  getAccountDigest as storeGetAccountDigest,
  normalizePeerIdentity as storeNormalizePeerIdentity,
  clearDrState as storeClearDrState
} from '../core/store.js';
import {
  persistDrSnapshot as sessionPersistDrSnapshot,
  recoverDrState as sessionRecoverDrState,
  prepareDrForMessage as sessionPrepareDrForMessage,
  recordDrMessageHistory as sessionRecordDrMessageHistory,
  snapshotDrState as sessionSnapshotDrState,
  restoreDrStateFromSnapshot as sessionRestoreDrStateFromSnapshot,
  restoreDrStateToHistoryPoint as sessionRestoreDrStateToHistoryPoint,
  cloneDrStateHolder as sessionCloneDrStateHolder
} from './dr-session.js';
import {
  computeConversationFingerprint as convComputeConversationFingerprint
} from './conversation.js';
import { b64UrlToBytes as uiB64UrlToBytes } from '../ui/mobile/ui-utils.js';
import { b64u8 as naclB64u8 } from '../crypto/nacl.js';
import { saveEnvelopeMeta as mediaSaveEnvelopeMeta } from './media.js';
import { CONTROL_MESSAGE_TYPES, normalizeControlMessageType } from './secure-conversation-signals.js';
import {
  ensureSecureConversationReady as managerEnsureSecureConversationReady,
  ensureDrReceiverState as managerEnsureDrReceiverState
} from './secure-conversation-manager.js';
import {
  describeCallLogForViewer,
  normalizeCallLogPayload,
  resolveViewerRole
} from './calls/call-log.js';
import { sendDrReadReceipt as featureSendDrReadReceipt, sendDrDeliveryReceipt as featureSendDrDeliveryReceipt } from './dr-session.js';
import { enqueueInboxJob, processInboxForConversation } from './queue/inbox.js';
import { enqueueReceiptJob } from './queue/receipts.js';

const defaultDeps = {
  listSecureMessages: apiListSecureMessages,
  drDecryptText: cryptoDrDecryptText,
  drState: storeDrState,
  getAccountDigest: storeGetAccountDigest,
  persistDrSnapshot: sessionPersistDrSnapshot,
  recoverDrState: sessionRecoverDrState,
  prepareDrForMessage: sessionPrepareDrForMessage,
  recordDrMessageHistory: sessionRecordDrMessageHistory,
  snapshotDrState: sessionSnapshotDrState,
  restoreDrStateFromSnapshot: sessionRestoreDrStateFromSnapshot,
  restoreDrStateToHistoryPoint: sessionRestoreDrStateToHistoryPoint,
  cloneDrStateHolder: sessionCloneDrStateHolder,
  computeConversationFingerprint: convComputeConversationFingerprint,
  b64UrlToBytes: uiB64UrlToBytes,
  b64u8: naclB64u8,
  saveEnvelopeMeta: mediaSaveEnvelopeMeta,
  ensureSecureConversationReady: managerEnsureSecureConversationReady,
  ensureDrReceiverState: managerEnsureDrReceiverState,
  clearDrState: storeClearDrState,
  sendReadReceipt: featureSendDrReadReceipt,
  sendDeliveryReceipt: featureSendDrDeliveryReceipt
};

const deps = { ...defaultDeps };

export function __setMessagesTestOverrides(overrides = {}) {
  Object.assign(deps, overrides);
}

export function __resetMessagesTestOverrides() {
  Object.assign(deps, defaultDeps);
}

const decoder = new TextDecoder();
const secureFetchBackoff = new Map();
const processedMessageCache = new Map(); // conversationId -> Set(messageId)
const PROCESSED_CACHE_MAX_PER_CONV = 500;
const PROCESSED_CACHE_MAX_CONVS = 50;
// receiptStore: conversationId -> Map(messageId -> { read:boolean, ts:number|null })
const receiptStore = new Map();
const sentReadReceipts = new Set(); // `${conversationId}:${messageId}`
let sentReceiptsLoaded = false;
let receiptsLoaded = false;
// deliveredStore: conversationId -> Map(messageId -> { delivered:boolean, ts:number|null })
const deliveredStore = new Map();
const sentDeliveryReceipts = new Set(); // `${conversationId}:${messageId}`
let deliveredLoaded = false;
const drRecoveryCounts = new Map(); // conversationId -> retry counter for force reset

function getReceiptStorageKey() {
  try {
    const acct = deps.getAccountDigest && deps.getAccountDigest();
    if (acct) return `readReceipts:${String(acct).toUpperCase()}`;
  } catch {}
  return null;
}

function getSentReceiptStorageKey() {
  try {
    const acct = deps.getAccountDigest && deps.getAccountDigest();
    if (acct) return `sentReadReceipts:${String(acct).toUpperCase()}`;
  } catch {}
  return null;
}

function getDeliveredStorageKey() {
  try {
    const acct = deps.getAccountDigest && deps.getAccountDigest();
    if (acct) return `deliveredReceipts:${String(acct).toUpperCase()}`;
  } catch {}
  return null;
}

function ensureReceiptsLoaded() {
  if (receiptsLoaded) return;
  receiptsLoaded = true;
  const key = getReceiptStorageKey();
  if (!key) return;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [convId, ids] of Object.entries(obj)) {
        if (!convId || !Array.isArray(ids)) continue;
        const map = new Map();
        for (const id of ids) {
          if (typeof id === 'string' && id) {
            map.set(id, { read: true, ts: null });
          }
        }
        if (map.size) receiptStore.set(convId, map);
      }
    }
  } catch (err) {
    console.warn('[messages] load receipts failed', err);
  }
}

function persistReceipts(maxEntries = 500) {
  const key = getReceiptStorageKey();
  if (!key) return;
  try {
    const out = {};
    for (const [convId, map] of receiptStore.entries()) {
      if (!convId || !(map instanceof Map)) continue;
      const ids = Array.from(map.keys()).slice(-maxEntries);
      if (ids.length) out[convId] = ids;
    }
    sessionStorage.setItem(key, JSON.stringify(out));
  } catch (err) {
    console.warn('[messages] persist receipts failed', err);
  }
}

function ensureSentReceiptsLoaded() {
  if (sentReceiptsLoaded) return;
  sentReceiptsLoaded = true;
  const key = getSentReceiptStorageKey();
  if (!key) return;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const id of arr) {
        if (typeof id === 'string' && id) sentReadReceipts.add(id);
      }
    }
  } catch (err) {
    console.warn('[messages] load sent receipts failed', err);
  }
}

function persistSentReceipts(maxEntries = 500) {
  const key = getSentReceiptStorageKey();
  if (!key) return;
  try {
    const ids = Array.from(sentReadReceipts).slice(-maxEntries);
    sessionStorage.setItem(key, JSON.stringify(ids));
  } catch (err) {
    console.warn('[messages] persist sent receipts failed', err);
  }
}

function ensureDeliveredLoaded() {
  if (deliveredLoaded) return;
  deliveredLoaded = true;
  const key = getDeliveredStorageKey();
  if (!key) return;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [convId, ids] of Object.entries(obj)) {
        if (!convId || !Array.isArray(ids)) continue;
        const map = new Map();
        for (const id of ids) {
          if (typeof id === 'string' && id) {
            map.set(id, { delivered: true, ts: null });
          }
        }
        if (map.size) deliveredStore.set(convId, map);
      }
    }
  } catch (err) {
    console.warn('[messages] load delivered receipts failed', err);
  }
}

function persistDelivered(maxEntries = 500) {
  const key = getDeliveredStorageKey();
  if (!key) return;
  try {
    const out = {};
    for (const [convId, map] of deliveredStore.entries()) {
      if (!convId || !(map instanceof Map)) continue;
      const ids = Array.from(map.keys()).slice(-maxEntries);
      if (ids.length) out[convId] = ids;
    }
    sessionStorage.setItem(key, JSON.stringify(out));
  } catch (err) {
    console.warn('[messages] persist delivered receipts failed', err);
  }
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
    return deps.snapshotDrState(state, { setDefaultUpdatedAt: false });
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
  const keyU8 = deps.b64u8(messageKeyB64);
  const ivU8 = deps.b64u8(ivB64);
  const ctU8 = deps.b64u8(ciphertextB64);
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
    try { deps.saveEnvelopeMeta(objectKey, envelope); } catch {}
  }

  const previewSource = parsed?.preview || metaMedia?.preview || null;
  const previewObjectKey =
    previewSource?.objectKey ||
    previewSource?.object_key ||
    metaMedia?.preview_object_key ||
    null;
  const previewEnvelope =
    previewSource?.envelope ||
    previewSource?.env ||
    metaMedia?.preview_envelope ||
    null;
  const previewSizeRaw = previewSource?.size ?? metaMedia?.preview_size;
  const previewContentType =
    previewSource?.contentType ||
    previewSource?.content_type ||
    metaMedia?.preview_content_type ||
    null;
  const previewWidth = Number(previewSource?.width);
  const previewHeight = Number(previewSource?.height);
  if (previewObjectKey && previewEnvelope) {
    try { deps.saveEnvelopeMeta(previewObjectKey, previewEnvelope); } catch {}
  }

  const mediaInfo = {
    objectKey,
    name,
    size,
    contentType,
    envelope: envelope || null,
    preview: previewObjectKey || previewEnvelope ? {
      objectKey: previewObjectKey || null,
      envelope: previewEnvelope || null,
      size: Number.isFinite(Number(previewSizeRaw)) ? Number(previewSizeRaw) : null,
      contentType: previewContentType || null,
      width: Number.isFinite(previewWidth) ? previewWidth : null,
      height: Number.isFinite(previewHeight) ? previewHeight : null
    } : null,
    dir,
    senderFingerprint: meta?.sender_fingerprint || null
  };

  if (parsed?.sha256) mediaInfo.sha256 = parsed.sha256;
  if (parsed?.localUrl) mediaInfo.localUrl = parsed.localUrl;
  if (parsed?.previewUrl) mediaInfo.previewUrl = parsed.previewUrl;
  if (previewSource?.localUrl) mediaInfo.previewUrl = mediaInfo.previewUrl || previewSource.localUrl;

  return mediaInfo;
}

function isControlMessageObject(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (
    obj.type === CONTROL_MESSAGE_TYPES.SESSION_INIT ||
    obj.type === CONTROL_MESSAGE_TYPES.SESSION_ACK ||
    obj.type === CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT ||
    obj.type === CONTROL_MESSAGE_TYPES.READ_RECEIPT
  );
}

function toErrorMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err?.message || String(err);
}

function isRecoverableDrError(err) {
  const msg = toErrorMessage(err).toLowerCase();
  return (
    msg.includes('operationerror') ||
    msg.includes('operation failed') ||
    msg.includes('dr ') ||
    msg.includes('double ratchet') ||
    msg.includes('缺少安全會話') ||
    msg.includes('會話') ||
    msg.includes('ratchet') ||
    msg.includes('snapshot')
  );
}

function hasUsableDrState(holder, roleHint = null) {
  if (
    !holder?.rk ||
    !(holder?.myRatchetPriv instanceof Uint8Array) ||
    !(holder?.myRatchetPub instanceof Uint8Array)
  ) {
    return false;
  }
  const hasReceive = holder?.ckR instanceof Uint8Array && holder.ckR.length > 0;
  const hasSend = holder?.ckS instanceof Uint8Array && holder.ckS.length > 0;
  if (!hasReceive && !hasSend) return false;
  const role =
    typeof roleHint === 'string'
      ? roleHint.toLowerCase()
      : (typeof holder?.baseKey?.role === 'string' ? holder.baseKey.role.toLowerCase() : null);
  if (role === 'initiator') return hasSend || hasReceive;
  if (role === 'responder') return hasReceive || hasSend;
  return hasReceive || hasSend;
}

function recordDrDecryptFailurePayload({ conversationId, peerAccountDigest, tokenB64 = null, payloadEnvelope = null, raw = null, reason = 'decrypt-fail' } = {}) {
  const envelope =
    payloadEnvelope ||
    raw?.payload_envelope ||
    raw?.payloadEnvelope ||
    raw?.payload ||
    null;
  if (!envelope) return;
  const entry = {
    ts: Date.now(),
    conversationId: conversationId || null,
    peerAccountDigest: peerAccountDigest || null,
    tokenB64: tokenB64 || null,
    payloadEnvelope: envelope,
    raw: raw
      ? {
          id: raw?.id || raw?.message_id || raw?.messageId || null,
          created_at: raw?.created_at || raw?.createdAt || null
        }
      : null,
    reason
  };
  try {
    console.warn('[dr-decrypt-fail-payload]', {
      conversationId: entry.conversationId,
      peerAccountDigest: entry.peerAccountDigest,
      messageId: entry.raw?.id || null,
      reason: entry.reason
    });
  } catch {}
  try {
    if (typeof sessionStorage === 'undefined') return;
    const key = 'dr-decrypt-fail-payloads';
    let arr = [];
    try {
      const existing = sessionStorage.getItem(key);
      if (existing) {
        const parsed = JSON.parse(existing);
        if (Array.isArray(parsed)) arr = parsed;
      }
    } catch {}
    arr.push(entry);
    while (arr.length > 10) arr.shift();
    sessionStorage.setItem(key, JSON.stringify(arr));
  } catch {}
}

async function recoverAndEnsureDrState({
  conversationId,
  peerAccountDigest,
  tokenB64 = null,
  payloadEnvelope = null,
  raw = null,
  reason = 'dr-recover',
  recordPayloadOnFail = false
} = {}) {
  if (!peerAccountDigest) return false;
  const debug = isDrDebugEnabled();
  try {
    await deps.recoverDrState({ peerAccountDigest, force: true });
  } catch (err) {
    if (debug) console.warn('[messages] recoverDrState failed', err);
  }
  try {
    await deps.ensureDrReceiverState({
      peerAccountDigest,
      force: true,
      reason
    });
  } catch (err) {
    if (debug) console.warn('[messages] ensureDrReceiverState failed', err);
  }
  let ready = false;
  try {
    const holder = deps.drState(peerAccountDigest);
    ready = hasUsableDrState(holder);
  } catch {}
  if (!ready && recordPayloadOnFail) {
    recordDrDecryptFailurePayload({ conversationId, peerAccountDigest, tokenB64, payloadEnvelope, raw, reason });
  }
  return ready;
}

async function attemptDrRecovery({
  peerAccountDigest,
  conversationId = null,
  tokenB64 = null,
  payloadEnvelope = null,
  raw = null,
  reason = 'decrypt-recover',
  recordPayloadOnFail = false
} = {}) {
  if (!peerAccountDigest) return false;
  try {
    return await recoverAndEnsureDrState({
      conversationId,
      peerAccountDigest,
      tokenB64,
      payloadEnvelope,
      raw,
      reason,
      recordPayloadOnFail
    });
  } catch {
    return false;
  }
}

async function forceResetDrAndReplay({ conversationId, peerAccountDigest }) {
  if (!conversationId || !peerAccountDigest) return false;
  const count = (drRecoveryCounts.get(conversationId) || 0) + 1;
  drRecoveryCounts.set(conversationId, count);
  if (count > 2) return false; // 避免無限重置
  try { deps.clearDrState?.(peerAccountDigest); } catch {}
  try { resetProcessedMessages(conversationId); } catch {}
  try {
    await deps.ensureDrReceiverState?.({ peerAccountDigest, force: true, reason: 'dr-op-error-reset' });
  } catch (err) {
    if (isDrDebugEnabled()) console.warn('[messages] force reset ensure receiver failed', err);
  }
  return true;
}

function buildMessageObject({ plaintext, payload, header, raw, direction, ts, messageId, messageKeyB64 }) {
  const meta = payload?.meta || null;
  const baseId = messageId || toMessageId(raw) || null;
  const timestamp = Number.isFinite(ts) ? ts : null;
  const msgType = typeof meta?.msg_type === 'string' ? meta.msg_type : null;
  const targetMessageId = meta?.target_message_id || meta?.targetMessageId || (() => {
    if (typeof plaintext === 'string') {
      try {
        const parsed = JSON.parse(plaintext);
        if (parsed?.messageId) return parsed.messageId;
        if (parsed?.msgId) return parsed.msgId;
        if (parsed?.id) return parsed.id;
      } catch {}
    }
    return null;
  })();
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

  if (msgType === 'media') {
    const mediaInfo = parseMediaMessage({ plaintext, meta });
    base.type = 'media';
    base.media = mediaInfo || null;
    base.text = mediaInfo ? `[檔案] ${mediaInfo.name || '附件'}` : (typeof plaintext === 'string' ? plaintext : '[媒體]');
    if (base.media && messageKeyB64) {
      base.media.messageKey_b64 = messageKeyB64;
    }
  } else if (msgType === 'call-log') {
    let parsed = null;
    if (typeof plaintext === 'string') {
      try { parsed = JSON.parse(plaintext); } catch {}
    }
    const callLog = normalizeCallLogPayload(parsed || {}, meta || {});
    const viewerRole = resolveViewerRole(callLog.authorRole, direction);
    const { label, subLabel } = describeCallLogForViewer(callLog, viewerRole);
    base.type = 'call-log';
    base.callLog = {
      ...callLog,
      viewerRole,
      label,
      subLabel
    };
    base.text = label || '語音通話';
    base.subLabel = subLabel || null;
  } else if (msgType === CONTROL_MESSAGE_TYPES.SESSION_INIT) {
    base.type = CONTROL_MESSAGE_TYPES.SESSION_INIT;
    base.text = '';
  } else if (msgType === CONTROL_MESSAGE_TYPES.SESSION_ACK) {
    base.type = CONTROL_MESSAGE_TYPES.SESSION_ACK;
    base.text = '';
  } else if (msgType === CONTROL_MESSAGE_TYPES.READ_RECEIPT) {
    base.type = CONTROL_MESSAGE_TYPES.READ_RECEIPT;
    base.text = '';
    if (targetMessageId) base.targetMessageId = targetMessageId;
  } else if (msgType === CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT) {
    base.type = CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT;
    base.text = '';
    if (targetMessageId) base.targetMessageId = targetMessageId;
  } else {
    base.type = 'text';
    base.text = typeof base.text === 'string' ? base.text : '';
  }

  if (typeof base.text === 'string') {
    base.text = base.text.trim();
  }

  return base;
}

export async function listSecureAndDecrypt(params = {}) {
  const {
    conversationId,
    tokenB64,
    peerAccountDigest,
    limit = 20,
    cursorTs,
    cursorId,
    mutateState = true,
    allowReplay = false,
    onMessageDecrypted = null,
    sendReadReceipt = true
  } = params;
  if (!conversationId) throw new Error('conversationId required');
  const identity = storeNormalizePeerIdentity({ peerAccountDigest });
  const peerKey = identity.key;
  if (!peerKey) throw new Error('peer identity required');
  const peerRef = {
    peerAccountDigest: identity.accountDigest || peerKey
  };

  const now = Date.now();
  const backoffUntil = secureFetchBackoff.get(conversationId) || 0;
  if (now < backoffUntil) {
    return {
      items: [],
      nextCursorTs: null,
      errors: ['訊息服務暫時無法使用，請稍後再試。']
    };
  }

  const { r, data } = await deps.listSecureMessages({ conversationId, limit, cursorTs, cursorId });
  const out = [];
  const errs = [];
  const receiptUpdates = new Set();
  const deadLetters = [];
  let state = null;
  let items = [];
  let nextCursorTs = null;
  let nextCursor = null;
  let hasMoreAtCursor = false;
  let serverItemCount = 0;
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
    serverItemCount = items.length;
    nextCursorTs = data?.nextCursorTs ?? null;
    nextCursor = data?.nextCursor || (nextCursorTs != null && items.length ? { ts: nextCursorTs, id: items[items.length - 1]?.id || null } : null);
    hasMoreAtCursor = !!data?.hasMoreAtCursor;
    if (items.length || nextCursorTs !== null || nextCursor) {
      secureFetchBackoff.delete(conversationId);
    }
  }
  const drDebug = isDrDebugEnabled();

  // 若 server 表示同一時間戳仍有更多，連續補抓避免截斷（安全上限避免無窮迴圈）。
  if (hasMoreAtCursor && nextCursor) {
    const extraItems = [];
    let cursor = { ...nextCursor };
    let guard = 0;
    while (guard < 5 && cursor && hasMoreAtCursor) {
      guard += 1;
      const { r: r2, data: data2 } = await deps.listSecureMessages({
        conversationId,
        limit,
        cursorTs: cursor.ts ?? cursor.cursorTs ?? cursorTs ?? null,
        cursorId: cursor.id ?? cursor.cursorId ?? null
      });
      if (!r2.ok) break;
      const batch = Array.isArray(data2?.items) ? data2.items : [];
      if (batch.length) extraItems.push(...batch);
      const nc = data2?.nextCursor || (data2?.nextCursorTs != null && batch.length ? { ts: data2.nextCursorTs, id: batch[batch.length - 1]?.id || null } : null);
      hasMoreAtCursor = !!data2?.hasMoreAtCursor;
      cursor = nc;
      if (!hasMoreAtCursor) {
        nextCursor = nc || nextCursor;
        nextCursorTs = nc?.ts ?? data2?.nextCursorTs ?? nextCursorTs;
      }
      if (!batch.length) break;
    }
    if (extraItems.length) {
      const merged = [...items, ...extraItems];
      const deduped = [];
      const seen = new Set();
      for (const it of merged) {
        const mid = toMessageId(it) || it?.id || null;
        const key = `${mid || ''}::${toMessageTimestamp(it) || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(it);
      }
      items = deduped;
    }
  }
  const selfDigest = (deps.getAccountDigest && deps.getAccountDigest()) ? String(deps.getAccountDigest()).toUpperCase() : null;
  let fingerprintPeer = null;
  let fingerprintSelf = null;
  if (tokenB64) {
    try {
      const peerFingerprintSource = identity.accountDigest || peerKey;
      if (peerFingerprintSource) {
        fingerprintPeer = await deps.computeConversationFingerprint(tokenB64, peerFingerprintSource);
      }
    } catch {}
    try {
      const selfFingerprintSource = deps.getAccountDigest();
      if (selfFingerprintSource) fingerprintSelf = await deps.computeConversationFingerprint(tokenB64, selfFingerprintSource);
    } catch {}
  }

  const sortedItems = sortMessagesByTimeline(items);
  const shouldTrackState = mutateState !== false;
  const allowCursorReplay = !!allowReplay || !shouldTrackState;
  const baseState = deps.drState(peerRef);
  state = shouldTrackState ? baseState : deps.cloneDrStateHolder(baseState);
  const refreshLiveState = (trackState = shouldTrackState, persist = true) => {
    const latest = deps.drState(peerKey);
    const snapshot = trackState ? latest : deps.cloneDrStateHolder(latest);
    if (persist) {
      state = snapshot;
    }
    return snapshot;
  };
  const ensureReceiverStateReady = async ({
    force = false,
    source = 'decrypt-precheck',
    trackState = shouldTrackState,
    stateOverride = null,
    payloadEnvelope = null,
    raw = null,
    recordPayloadOnFail = false,
    updateSharedState = true
  } = {}) => {
    try {
      const current = stateOverride || (trackState ? state : deps.drState(peerKey));
      if (!force && hasUsableDrState(current)) {
        return current;
      }
      await recoverAndEnsureDrState({
        conversationId,
        peerAccountDigest: peerKey,
        tokenB64,
        payloadEnvelope,
        raw,
        reason: source,
        recordPayloadOnFail
      });
      return refreshLiveState(trackState, updateSharedState);
    } catch (err) {
      if (drDebug) console.warn('[messages] ensure receiver state failed', err);
      if (recordPayloadOnFail) {
        recordDrDecryptFailurePayload({
          conversationId,
          peerAccountDigest: peerKey,
          tokenB64,
          payloadEnvelope,
          raw,
          reason: source
        });
      }
      return trackState ? state : deps.cloneDrStateHolder(state);
    }
  };

  await ensureReceiverStateReady({ source: 'decrypt-precheck', trackState: shouldTrackState, force: !hasUsableDrState(state) });

  await deps.ensureSecureConversationReady({
    peerAccountDigest: peerKey,
    reason: 'list-messages',
    source: 'messages:listSecureAndDecrypt'
  });

  if (drDebug) {
    try {
      console.log('[dr-list]', JSON.stringify({
        peerAccountDigest: peerKey,
        conversationId,
        mutateState: shouldTrackState,
        mode: shouldTrackState ? 'live' : 'preview',
        cursorTs: cursorTs ?? null,
        nextCursorTs,
        itemsRequested: sortedItems.length
      }));
    } catch {}
  }

  const handleInboxJob = async (job, opts = {}) => {
    const trackState = opts.mutateState === false ? false : shouldTrackState;
    const allowReplayForJob = opts.forceAllowReplay ? true : (trackState ? allowCursorReplay : true);
    const allowAutoReplay = opts.allowAutoReplay !== false;
    const fromReplay = !!opts.fromReplay;
    const restoreStateAfter = !!opts.stateOverride && !trackState;
    const originalStateRef = state;
    if (opts.stateOverride) {
      state = opts.stateOverride;
    }
    const raw = job?.raw || {};
    let payloadMsgType = null;
      try {
        let decrypted = false;
        let lastError = null;
        let payloadEnvelope = null;
        const headerRaw = raw?.header_json || raw?.headerJson || raw?.header || null;
        let header = null;
        if (typeof headerRaw === 'string') {
          try { header = JSON.parse(headerRaw); } catch {}
        } else if (headerRaw && typeof headerRaw === 'object') {
          header = headerRaw;
        }
        const ciphertextB64 = raw?.ciphertext_b64 || raw?.ciphertextB64 || null;
        if (!header || !ciphertextB64 || !header.iv_b64) {
          throw new Error('缺少訊息標頭或密文，無法進行 DR 解密');
        }
        if (header?.fallback) throw new Error('偵測到舊版 fallback 封包，已不再支援');
        payloadEnvelope = {
          header_json: headerRaw,
          ciphertext_b64: ciphertextB64,
          counter: header?.n ?? null
        };
        const pkt = {
          aead: 'aes-256-gcm',
          header,
          iv_b64: header.iv_b64,
          ciphertext_b64: ciphertextB64
        };

        const metaFromHeader = header?.meta || null;
        const payload = { meta: metaFromHeader || null };
        const msgTs = Number(metaFromHeader?.ts || raw?.created_at || raw?.createdAt || job?.createdAt || null);
      const messageTs = Number.isFinite(msgTs) ? msgTs : null;
      const messageId = job?.messageId || toMessageId(raw);
      const meta = payload?.meta || null;
      payloadMsgType = normalizeControlMessageType(meta?.msg_type || meta?.msgType || null);
      const senderFingerprint = meta?.sender_fingerprint || meta?.fingerprint || null;
      const isMediaMessage = !!(meta?.media);
      const senderDigest = (raw?.sender_account_digest || raw?.senderAccountDigest || '').toUpperCase();
      let direction = 'unknown';
      if (senderDigest && selfDigest && senderDigest === selfDigest) direction = 'outgoing';
      else if (senderDigest && peerKey && senderDigest === peerKey.toUpperCase()) direction = 'incoming';
      else if (senderFingerprint && fingerprintSelf && senderFingerprint === fingerprintSelf) direction = 'outgoing';
      else if (senderFingerprint && fingerprintPeer && senderFingerprint === fingerprintPeer) direction = 'incoming';
      const stateCandidate = trackState ? state : (state || deps.drState(peerKey));
      if (!hasUsableDrState(stateCandidate)) {
        const ensured = await ensureReceiverStateReady({
          force: true,
          source: 'decrypt-message',
          trackState,
          stateOverride: state,
          payloadEnvelope,
          raw,
          updateSharedState: !restoreStateAfter
        });
        state = ensured;
      }
      if (trackState && !isMediaMessage && wasMessageProcessed(conversationId, messageId)) {
        if (drDebug) {
          console.log('[dr-skip-message]', JSON.stringify({ peerAccountDigest: peerKey, messageId, reason: 'processed-cache' }));
        }
        return;
      }
      let prepResult = null;
      let replayHandled = false;
      let messageKeyB64 = null;
      if (Number.isFinite(msgTs)) {
        if (trackState) {
          state = deps.drState(peerKey);
        }
        prepResult = deps.prepareDrForMessage({
          peerAccountDigest: peerKey,
          messageTs: msgTs,
          messageId,
          allowCursorReplay: allowReplayForJob,
          stateOverride: state,
          mutate: trackState
        });
        const historyEntry = prepResult?.historyEntry || null;
        if (prepResult?.duplicate) {
          if (drDebug) {
            console.log('[dr-skip-message]', JSON.stringify({ peerAccountDigest: peerKey, messageId, reason: 'duplicate' }));
          }
          return;
        }
        if (prepResult?.restored && trackState) {
          state = deps.drState(peerKey);
        }
        if (!decrypted && allowReplayForJob && prepResult?.historyEntry?.messageKey_b64) {
          try {
            const historyEntry = prepResult.historyEntry || null;
            const replayText = await decryptWithMessageKey({
              messageKeyB64: historyEntry?.messageKey_b64,
              ivB64: pkt.iv_b64,
              ciphertextB64
            });
            let stateSynced = false;
            try {
              if (historyEntry?.snapshotAfter) {
                const restored = deps.restoreDrStateFromSnapshot({
                  peerAccountDigest: peerKey,
                  snapshot: historyEntry.snapshotAfter,
                  force: true,
                  targetState: trackState ? null : state,
                  sourceTag: 'history-replay-after'
                });
                if (trackState) {
                  state = deps.drState(peerKey);
                  stateSynced = !!state;
                } else {
                  stateSynced = restored;
                }
              } else if (historyEntry?.snapshot) {
                const restored = deps.restoreDrStateFromSnapshot({
                  peerAccountDigest: peerKey,
                  snapshot: historyEntry.snapshot,
                  force: true,
                  targetState: trackState ? null : state,
                  sourceTag: 'history-replay'
                });
                if (trackState) {
                  const replayState = deps.drState(peerKey);
                  if (replayState) {
                    await deps.drDecryptText(replayState, pkt, { onMessageKey: () => {} });
                    state = replayState;
                    stateSynced = true;
                  }
                } else if (restored) {
                  await deps.drDecryptText(state, pkt, { onMessageKey: () => {} });
                  stateSynced = true;
                }
              }
            } catch (advanceErr) {
              if (drDebug) console.warn('[messages] replay state advance failed', advanceErr);
            }
            if (trackState) {
              markMessageProcessed(conversationId, messageId);
              if (stateSynced && state) {
                try {
                  deps.persistDrSnapshot({ peerAccountDigest: peerKey, state });
                } catch (persistErr) {
                  if (drDebug) console.warn('[messages] replay persist snapshot failed', persistErr);
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
            if (messageObj && !isControlMessageObject(messageObj)) {
              out.push(messageObj);
              clearDrRecoveryCounter(conversationId);
              if (messageObj.direction === 'incoming' && messageObj.id) {
                maybeSendDeliveryReceipt({
                  conversationId,
                  peerAccountDigest: peerKey,
                  messageId: messageObj.id,
                  tokenB64
                });
                if (sendReadReceipt) {
                  maybeSendReadReceipt(conversationId, peerKey, messageObj.id);
                }
              }
            }
            decrypted = true;
            replayHandled = true;
          } catch (replayErr) {
            if (drDebug) console.warn('[messages] replay decrypt failed', replayErr);
          }
        }
      }

      if (replayHandled) return;

      for (let attempt = 0; attempt < 2 && !decrypted; attempt += 1) {
        let snapshotBefore = null;
        try {
          if (trackState) {
            state = deps.drState(peerKey);
          }
          snapshotBefore = Number.isFinite(msgTs) ? deps.snapshotDrState(state, { setDefaultUpdatedAt: false }) : null;
          const text = await deps.drDecryptText(state, pkt, {
            onMessageKey: (mk) => { messageKeyB64 = mk; }
          });
          const snapshotAfter = deps.snapshotDrState(state, { setDefaultUpdatedAt: false });
          if (trackState && snapshotBefore && Number.isFinite(msgTs)) {
            deps.recordDrMessageHistory({
              peerAccountDigest: peerKey,
              messageTs: msgTs,
              messageId,
              snapshot: snapshotBefore,
              snapshotNext: snapshotAfter,
              messageKeyB64
            });
          }
          if (trackState) {
            markMessageProcessed(conversationId, messageId);
            deps.persistDrSnapshot({ peerAccountDigest: peerKey, state });
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
          if (messageObj && isControlMessageObject(messageObj)) {
            if (messageObj.type === CONTROL_MESSAGE_TYPES.READ_RECEIPT && messageObj.targetMessageId) {
              let map = receiptStore.get(conversationId);
              if (!map) {
                map = new Map();
                receiptStore.set(conversationId, map);
              }
              map.set(messageObj.targetMessageId, { read: true, ts: messageTs || null });
              persistReceipts();
              receiptUpdates.add(messageObj.targetMessageId);
              recordMessageDelivered(conversationId, messageObj.targetMessageId, messageTs || null);
            } else if (messageObj.type === CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT && messageObj.targetMessageId) {
              recordMessageDelivered(conversationId, messageObj.targetMessageId, messageTs || null);
            }
          } else if (messageObj) {
            out.push(messageObj);
            clearDrRecoveryCounter(conversationId);
            if (messageObj.direction === 'incoming' && messageObj.id) {
              maybeSendDeliveryReceipt({
                conversationId,
                peerAccountDigest: peerKey,
                messageId: messageObj.id,
                tokenB64
              });
              if (sendReadReceipt) {
                maybeSendReadReceipt(conversationId, peerKey, messageObj.id);
              }
            }
            if (onMessageDecrypted) {
              try {
                onMessageDecrypted({ message: messageObj, conversationId, peerAccountDigest: peerKey });
              } catch (cbErr) {
                console.warn('[messages] onMessageDecrypted callback failed', cbErr);
              }
            }
          }
          decrypted = true;
        } catch (err) {
          lastError = err;
          const msg = err?.message || String(err);
          const isOpError = typeof msg === 'string' && msg.includes('OperationError');
          if (isOpError) {
            logDrDebug('decrypt-operation-error', {
              peerAccountDigest: peerKey,
              messageId: raw?.id || null,
              ts: Number.isFinite(msgTs) ? msgTs : null,
              header,
              snapshotBefore: snapshotBefore || null,
              snapshotAfter: snapshotForDebug(trackState ? deps.drState(peerKey) : state)
            });
            if (snapshotBefore) {
              try {
                deps.restoreDrStateFromSnapshot({
                  peerAccountDigest: peerKey,
                  snapshot: snapshotBefore,
                  force: true,
                  targetState: trackState ? null : state,
                  sourceTag: 'decrypt-rollback'
                });
                if (trackState) {
                  state = deps.drState(peerKey);
                }
              } catch (restoreErr) {
                console.warn('[messages] dr snapshot rollback failed', restoreErr);
              }
            }
          }
          if (trackState && attempt === 0 && isOpError) {
            let restoredFromHistory = false;
            if (Number.isFinite(msgTs) || messageId) {
              try {
                restoredFromHistory = deps.restoreDrStateToHistoryPoint({
                  peerAccountDigest: peerKey,
                  ts: Number.isFinite(msgTs) ? msgTs : null,
                  messageId: messageId || null
                });
              } catch (historyErr) {
                if (drDebug) console.warn('[messages] history restore during op-error failed', historyErr);
              }
              if (!restoredFromHistory && Number.isFinite(msgTs)) {
                try {
                  restoredFromHistory = deps.restoreDrStateToHistoryPoint({
                    peerAccountDigest: peerKey,
                    ts: msgTs - 1,
                    messageId: null
                  });
                } catch (historyErr) {
                  if (drDebug) console.warn('[messages] secondary history restore failed', historyErr);
                }
              }
            }
            if (restoredFromHistory) {
              state = refreshLiveState(trackState, !restoreStateAfter);
              await ensureReceiverStateReady({ source: 'decrypt-history-restored', trackState, stateOverride: state, updateSharedState: !restoreStateAfter });
              continue;
            }
            let recovered = false;
            if (trackState) {
              recovered = await deps.recoverDrState({ peerAccountDigest: peerKey, force: true });
            }
            if (!recovered) {
              const ensured = await ensureReceiverStateReady({
                force: true,
                source: 'decrypt-op-error',
                trackState,
                stateOverride: state,
                payloadEnvelope,
                raw,
                updateSharedState: !restoreStateAfter,
                recordPayloadOnFail: true
              });
              recovered = hasUsableDrState(ensured);
            }
            if (recovered) {
              state = refreshLiveState(trackState, !restoreStateAfter);
              continue;
            }
          }
          if (attempt === 1) throw err;
        }
      }

      if (!decrypted) {
        const msg = lastError?.message || String(lastError || 'decrypt failed');
        throw new Error(msg);
      }
    } catch (err) {
      const msg = err?.message || String(err);
      let recoveryTriggered = false;
      let forceReset = false;
      let replaySuccess = false;
      if (isRecoverableDrError(err)) {
        recordDrDecryptFailurePayload({
          conversationId,
          peerAccountDigest: peerKey,
          tokenB64,
          payloadEnvelope,
          raw,
          reason: 'decrypt-fail'
        });
        try {
          recoveryTriggered = await attemptDrRecovery({
            peerAccountDigest: peerKey,
            conversationId,
            tokenB64,
            payloadEnvelope,
            raw,
            reason: 'inbox-decrypt-fail',
            recordPayloadOnFail: true
          });
        } catch (recoverErr) {
          if (drDebug) console.warn('[messages] dr recovery attempt failed', recoverErr);
        }
        if (!recoveryTriggered) {
          forceReset = await forceResetDrAndReplay({ conversationId, peerAccountDigest: peerKey });
          if (forceReset) {
            recoveryTriggered = await recoverAndEnsureDrState({
              conversationId,
              peerAccountDigest: peerKey,
              tokenB64,
              payloadEnvelope,
              raw,
              reason: 'dr-op-error-reset',
              recordPayloadOnFail: true
            });
          }
        }
        if ((recoveryTriggered || forceReset) && allowAutoReplay && !fromReplay) {
          const liveState = deps.drState(peerKey);
          const replayState = liveState ? deps.cloneDrStateHolder(liveState) : (state ? deps.cloneDrStateHolder(state) : null);
          if (replayState) {
            try {
              await handleInboxJob(job, {
                mutateState: false,
                forceAllowReplay: true,
                allowAutoReplay: false,
                stateOverride: replayState,
                fromReplay: true
              });
              clearDrRecoveryCounter(conversationId);
              replaySuccess = true;
              return;
            } catch (replayErr) {
              if (drDebug) console.warn('[messages] replay after recovery failed', replayErr);
            }
          } else if (drDebug) {
            console.warn('[messages] replay skipped: no dr state available');
          }
        }
      }
      if (!payloadMsgType || (payloadMsgType !== CONTROL_MESSAGE_TYPES.SESSION_INIT && payloadMsgType !== CONTROL_MESSAGE_TYPES.SESSION_ACK && payloadMsgType !== CONTROL_MESSAGE_TYPES.READ_RECEIPT && payloadMsgType !== CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT)) {
        errs.push(msg);
      }
      console.warn('[messages] secure decrypt skipped', { id: job?.messageId || job?.raw?.id, error: msg, msgType: payloadMsgType });
      if (replaySuccess) return;
      if (recoveryTriggered || forceReset) {
        throw new Error(`dr-recovering:${msg}`);
      }
      throw err;
    } finally {
      if (restoreStateAfter) {
        state = originalStateRef;
      }
    }
  };

  for (const raw of sortedItems) {
    const payloadEnvelope = raw?.payload_envelope || raw?.payloadEnvelope || raw?.payload;
    if (!payloadEnvelope) continue;
    const msgTs = toMessageTimestamp(raw);
    await enqueueInboxJob({
      conversationId,
      payloadEnvelope,
      raw,
      messageId: toMessageId(raw) || crypto.randomUUID(),
      createdAt: Number.isFinite(msgTs) ? msgTs : null,
      tokenB64,
      peerAccountDigest: peerKey,
      cursorTs
    });
  }

  await processInboxForConversation({
    conversationId,
    handler: async (job) => {
      try {
        await handleInboxJob(job);
      } catch (err) {
        deadLetters.push({
          jobId: job?.jobId,
          messageId: job?.messageId,
          error: err?.message || String(err)
        });
        throw err;
      }
    }
  });

  // Fallback: 若 server 有回傳訊息但未解出任何內容且無 dead-letter，嘗試強制恢復 DR 並以非 mutate 模式重播。
  if (serverItemCount > 0 && out.length === 0 && deadLetters.length === 0) {
    try {
      resetProcessedMessages(conversationId);
      await recoverAndEnsureDrState({
        conversationId,
        peerAccountDigest: peerKey,
        tokenB64,
        reason: 'fallback-replay',
        recordPayloadOnFail: true
      });
      const replayState = deps.cloneDrStateHolder(deps.drState(peerKey));
      for (const raw of sortedItems) {
        const payloadEnvelope = raw?.payload_envelope || raw?.payloadEnvelope || raw?.payload;
        if (!payloadEnvelope) continue;
        const msgTs = toMessageTimestamp(raw);
        const job = {
          conversationId,
          payloadEnvelope,
          raw,
          messageId: toMessageId(raw) || crypto.randomUUID(),
          createdAt: Number.isFinite(msgTs) ? msgTs : null,
          tokenB64,
          peerAccountDigest: peerKey,
          cursorTs
        };
        try {
          await handleInboxJob(job, {
            mutateState: false,
            forceAllowReplay: true,
            allowAutoReplay: false,
            stateOverride: replayState,
            fromReplay: true
          });
        } catch (err) {
          deadLetters.push({
            jobId: job?.jobId || null,
            messageId: job?.messageId || null,
            error: err?.message || String(err)
          });
          break;
        }
      }
    } catch (fallbackErr) {
      console.warn('[messages] fallback replay failed', fallbackErr);
    }
  }

  return {
    items: out,
    nextCursorTs,
    nextCursor,
    hasMoreAtCursor,
    errors: errs,
    deadLetters,
    receiptUpdates: Array.from(receiptUpdates)
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
    if (processedMessageCache.size > PROCESSED_CACHE_MAX_CONVS) {
      const firstKey = processedMessageCache.keys().next();
      if (!firstKey.done) processedMessageCache.delete(firstKey.value);
    }
  }
  set.add(messageId);
  const limit = Math.max(50, Math.min(PROCESSED_CACHE_MAX_PER_CONV, maxEntries));
  if (set.size > limit) {
    const first = set.values().next();
    if (!first.done) set.delete(first.value);
  }
}

export function resetProcessedMessages(conversationId) {
  if (!conversationId) return;
  processedMessageCache.delete(conversationId);
}

export function resetAllProcessedMessages() {
  processedMessageCache.clear();
}

export function resetReceiptStore() {
  receiptStore.clear();
  sentReadReceipts.clear();
  deliveredStore.clear();
  sentDeliveryReceipts.clear();
  receiptsLoaded = false;
  sentReceiptsLoaded = false;
  deliveredLoaded = false;
}

export function getMessageReceipt(conversationId, messageId) {
  if (!conversationId || !messageId) return null;
  ensureReceiptsLoaded();
  const map = receiptStore.get(conversationId);
  if (map instanceof Map) return map.get(messageId) || null;
  return null;
}

export function getMessageDelivery(conversationId, messageId) {
  return getDeliveredReceipt(conversationId, messageId);
}

function getDeliveredReceipt(conversationId, messageId) {
  if (!conversationId || !messageId) return null;
  ensureDeliveredLoaded();
  const map = deliveredStore.get(conversationId);
  if (map instanceof Map) return map.get(messageId) || null;
  return null;
}

export function recordMessageRead(conversationId, messageId, ts = null) {
  if (!conversationId || !messageId) return false;
  ensureReceiptsLoaded();
  let map = receiptStore.get(conversationId);
  if (!map) {
    map = new Map();
    receiptStore.set(conversationId, map);
  }
  map.set(messageId, { read: true, ts: ts && Number.isFinite(ts) ? ts : null });
  persistReceipts();
  recordMessageDelivered(conversationId, messageId, ts);
  return true;
}

function maybeSendReadReceipt(conversationId, peerAccountDigest, messageId) {
  ensureReceiptsLoaded();
  ensureSentReceiptsLoaded();
  const key = `${conversationId}:${messageId}`;
  if (!conversationId || !peerAccountDigest || !messageId) return;
  if (!deps.sendReadReceipt) return;
  if (sentReadReceipts.has(key)) return;
  sentReadReceipts.add(key);
  persistSentReceipts();
  deps
    .sendReadReceipt({ peerAccountDigest, messageId })
    .catch((err) => {
      console.warn('[messages] sendReadReceipt failed', err);
      sentReadReceipts.delete(key);
      persistSentReceipts();
      void recoverAndEnsureDrState({ conversationId, peerAccountDigest, reason: 'read-receipt-fail' });
    });
}

export function recordMessageDelivered(conversationId, messageId, ts = null) {
  if (!conversationId || !messageId) return false;
  ensureDeliveredLoaded();
  let map = deliveredStore.get(conversationId);
  if (!map) {
    map = new Map();
    deliveredStore.set(conversationId, map);
  }
  const existing = map.get(messageId);
  if (existing?.delivered) return true;
  map.set(messageId, { delivered: true, ts: ts && Number.isFinite(ts) ? ts : null });
  persistDelivered();
  return true;
}

function maybeSendDeliveryReceipt({ conversationId, peerAccountDigest, messageId, tokenB64 }) {
  if (!conversationId || !peerAccountDigest || !messageId) return;
  ensureDeliveredLoaded();
  const key = `${conversationId}:${messageId}`;
  if (sentDeliveryReceipts.has(key)) return;
  sentDeliveryReceipts.add(key);
  deps.sendDeliveryReceipt({
    peerAccountDigest,
    messageId,
    conversation: { token_b64: tokenB64, conversation_id: conversationId }
  }).catch((err) => {
    console.warn('[messages] sendDeliveryReceipt failed', err);
    sentDeliveryReceipts.delete(key);
    void recoverAndEnsureDrState({ conversationId, peerAccountDigest, reason: 'delivery-receipt-fail' });
  });
}

function clearDrRecoveryCounter(conversationId) {
  if (!conversationId) return;
  drRecoveryCounts.delete(conversationId);
}
