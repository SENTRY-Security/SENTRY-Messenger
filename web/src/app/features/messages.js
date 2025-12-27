/**
 * SECURITY POLICY – STRICT CRYPTO PROTOCOL, NO FALLBACK ALLOWED.
 *
 * 本檔案中的所有密碼協定（X3DH、Double Ratchet、AEAD、鍵派生、counter 驗證、header 驗證）
 * 禁止設計、加入或推論任何 fallback、retry、rollback、resync、auto-repair 等邏輯。
 *
 * 規則如下：
 * 1. 若解密失敗 → 一律直接 fail，不可嘗試第二組 key 或舊 ratchet state。
 * 2. 若 counter 不一致 → 一律直接拒絕，不可重送、補拉或自動對齊。
 * 3. 不允許任何協定降級（downgrade）。不得用舊版本、舊頭資訊、舊密鑰重試。
 * 4. 不允許模糊錯誤處理。不做 try-catch fallback，不做 silent recovery。
 * 5. 對話重置必須是顯式事件，不得隱式重建 state。
 *
 * 一切協定邏輯必須「單一路徑」且「強一致性」，任何 fallback 視為安全漏洞。
 */

// /app/features/messages.js
// Feature: list conversation messages and decrypt DR packets using secure conversation tokens.

import { listSecureMessages as apiListSecureMessages } from '../api/messages.js';
import { drDecryptText as cryptoDrDecryptText, buildDrAadFromHeader as cryptoBuildDrAadFromHeader } from '../crypto/dr.js';
import {
  drState as storeDrState,
  getAccountDigest as storeGetAccountDigest,
  normalizePeerIdentity as storeNormalizePeerIdentity,
  clearDrState as storeClearDrState,
  ensureDeviceId as storeEnsureDeviceId
} from '../core/store.js';
import {
  persistDrSnapshot as sessionPersistDrSnapshot,
  snapshotDrState as sessionSnapshotDrState,
  cloneDrStateHolder as sessionCloneDrStateHolder
} from './dr-session.js';
import { sessionStore } from '../ui/mobile/session-store.js';
import { b64UrlToBytes as uiB64UrlToBytes } from '../ui/mobile/ui-utils.js';
import { b64u8 as naclB64u8, b64 as naclB64 } from '../crypto/nacl.js';
import { saveEnvelopeMeta as mediaSaveEnvelopeMeta } from './media.js';
import { CONTROL_MESSAGE_TYPES, normalizeControlMessageType } from './secure-conversation-signals.js';
import {
  ensureSecureConversationReady as managerEnsureSecureConversationReady,
  ensureDrReceiverState as managerEnsureDrReceiverState,
  handleSecureConversationControlMessage,
  SECURE_CONVERSATION_STATUS
} from './secure-conversation-manager.js';
import { classifyDecryptedPayload, SEMANTIC_KIND } from './semantic.js';
import {
  describeCallLogForViewer,
  normalizeCallLogPayload,
  resolveViewerRole
} from './calls/call-log.js';
import {
  appendUserMessage as timelineAppendUserMessage,
  clearConversation as clearTimelineConversation
} from './timeline-store.js';
import { sendDrReadReceipt as featureSendDrReadReceipt, sendDrDeliveryReceipt as featureSendDrDeliveryReceipt } from './dr-session.js';
import { enqueueInboxJob, processInboxForConversation } from './queue/inbox.js';
import { enqueueReceiptJob } from './queue/receipts.js';
import { toU8Strict } from '../../shared/utils/u8-strict.js';
import { logDrCore, logMsgEvent, shouldLogDrCore } from '../lib/logging.js';

const defaultDeps = {
  listSecureMessages: apiListSecureMessages,
  drDecryptText: cryptoDrDecryptText,
  buildDrAadFromHeader: cryptoBuildDrAadFromHeader,
  drState: storeDrState,
  getAccountDigest: storeGetAccountDigest,
  persistDrSnapshot: sessionPersistDrSnapshot,
  snapshotDrState: sessionSnapshotDrState,
  cloneDrStateHolder: sessionCloneDrStateHolder,
  b64UrlToBytes: uiB64UrlToBytes,
  b64u8: naclB64u8,
  b64: naclB64,
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
  const secureFetchLocks = new Set(); // conversationId in-flight
  const tombstonedConversations = new Set(); // legacy; kept for compatibility
  const conversationClearAfter = new Map(); // conversationId -> unix ts to ignore older messages
  const processedMessageCache = new Map(); // conversationId -> Set(messageId)
  const processedContactShare = new Map(); // conversationId -> Set(stableKey)
  const PROCESSED_CACHE_MAX_PER_CONV = 500;
  const PROCESSED_CACHE_MAX_CONVS = 50;
  const drFailureCounter = new Map(); // `${conversationId}::${peerKey}` -> count
  // receiptStore: conversationId -> Map(messageId -> { read:boolean, ts:number|null })
  const receiptStore = new Map();
const sentReadReceipts = new Set(); // `${conversationId}:${messageId}`
let sentReceiptsLoaded = false;
let receiptsLoaded = false;
// deliveredStore: conversationId -> Map(messageId -> { delivered:boolean, ts:number|null })
const deliveredStore = new Map();
const sentDeliveryReceipts = new Set(); // `${conversationId}:${messageId}`
let deliveredLoaded = false;
const decryptFailDedup = new Set(); // messageId -> failed once
const decryptFailMessageCache = new Map(); // messageId -> stateKey
const decryptedMessageStore = new Map(); // conversationId -> Map(messageId -> messageObj)
const DECRYPTED_CACHE_MAX_PER_CONV = 500;
const TIMELINE_MESSAGE_TYPES = new Set(['text', 'media', 'call-log']);
const decryptFailLogDedup = new Set();
const semanticIgnoreLogDedup = new Set();

function normalizeMessageId(messageObj) {
  if (!messageObj) return null;
  return messageObj.id || messageObj.messageId || messageObj.serverMessageId || messageObj.server_message_id || null;
}

function clearDecryptedMessages(conversationId) {
  if (!conversationId) return;
  decryptedMessageStore.delete(String(conversationId));
  clearTimelineConversation(String(conversationId));
}

export function putDecryptedMessage(conversationId, messageObj, maxEntries = DECRYPTED_CACHE_MAX_PER_CONV) {
  if (!conversationId || !messageObj) return;
  const messageId = normalizeMessageId(messageObj);
  if (!messageId) return;
  const key = String(conversationId);
  let map = decryptedMessageStore.get(key);
  if (!map) {
    map = new Map();
    decryptedMessageStore.set(key, map);
  }
  map.set(messageId, messageObj);
  const limit = Math.max(50, Math.min(Number(maxEntries) || DECRYPTED_CACHE_MAX_PER_CONV, DECRYPTED_CACHE_MAX_PER_CONV));
  if (map.size > limit) {
    const overflow = map.size - limit;
    for (let i = 0; i < overflow; i += 1) {
      const first = map.keys().next();
      if (first.done) break;
      map.delete(first.value);
    }
  }
}

export function getDecryptedMessages(conversationId) {
  if (!conversationId) return [];
  const map = decryptedMessageStore.get(String(conversationId));
  if (!(map instanceof Map) || !map.size) return [];
  return Array.from(map.values())
    .filter(Boolean)
    .sort((a, b) => (Number(a?.ts) || 0) - (Number(b?.ts) || 0));
}

export function hasDecryptedMessage(conversationId, messageId) {
  if (!conversationId || !messageId) return false;
  const map = decryptedMessageStore.get(String(conversationId));
  return map instanceof Map && map.has(messageId);
}

export function markConversationTombstone(conversationId) {
  if (!conversationId) return;
  const key = String(conversationId);
  tombstonedConversations.add(key);
  secureFetchLocks.delete(key);
  secureFetchBackoff.delete(key);
  processedMessageCache.delete(key);
  receiptStore.delete(key);
  deliveredStore.delete(key);
  drFailureCounter.delete(key);
  clearDecryptedMessages(key);
}

export function isConversationTombstoned(conversationId) {
  if (!conversationId) return false;
  return tombstonedConversations.has(String(conversationId));
}

export function clearConversationTombstone(conversationId) {
  if (!conversationId) return;
  tombstonedConversations.delete(String(conversationId));
}

export function clearConversationHistory(conversationId, ts = null) {
  if (!conversationId) return;
  const key = String(conversationId);
  const nowSec = Math.floor(Date.now() / 1000);
  const stamp = Number.isFinite(Number(ts)) ? Number(ts) : nowSec;
  conversationClearAfter.set(key, stamp);
  secureFetchLocks.delete(key);
  secureFetchBackoff.delete(key);
  processedMessageCache.delete(key);
  receiptStore.delete(key);
  deliveredStore.delete(key);
  drFailureCounter.delete(key);
  clearDecryptedMessages(key);
}

export function getConversationClearAfter(conversationId) {
  if (!conversationId) return null;
  const ts = conversationClearAfter.get(String(conversationId));
  return Number.isFinite(ts) ? ts : null;
}

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

function buildStateKey({ conversationId, peerKey, peerDeviceId }) {
  return `${conversationId || 'unknown'}::${peerKey || 'unknown'}::${peerDeviceId || 'unknown-device'}`;
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
  return shouldLogDrCore();
}

function snapshotForDebug(state) {
  try {
    return deps.snapshotDrState(state, { setDefaultUpdatedAt: false });
  } catch {
    return null;
  }
}

function logDrDebug(event, payload) {
  logDrCore(event, payload, { level: 'log' });
}

function urlB64ToStd(b64url) {
  let s = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  return s;
}

async function hashBytesHex(u8) {
  if (!(u8 instanceof Uint8Array)) return null;
  if (typeof crypto === 'undefined' || !crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', u8);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function decryptWithMessageKey({ messageKeyB64, ivB64, ciphertextB64, header }) {
  if (!messageKeyB64) throw new Error('message key missing');
  const keyU8 = toU8Strict(deps.b64u8(messageKeyB64), 'web/src/app/features/messages.js:363:decryptWithMessageKey');
  const ivU8 = deps.b64u8(ivB64);
  const ctU8 = deps.b64u8(ciphertextB64);
  const key = await crypto.subtle.importKey('raw', keyU8, 'AES-GCM', false, ['decrypt']);
  const aad = header && deps.buildDrAadFromHeader ? deps.buildDrAadFromHeader(header) : null;
  const decryptParams = aad ? { name: 'AES-GCM', iv: ivU8, additionalData: aad } : { name: 'AES-GCM', iv: ivU8 };
  const ptBuf = await crypto.subtle.decrypt(decryptParams, key, ctU8);
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
    senderDigest: (typeof meta?.senderDigest === 'string' && meta.senderDigest.trim()) ? meta.senderDigest.trim() : null
  };

  if (parsed?.sha256) mediaInfo.sha256 = parsed.sha256;
  if (parsed?.localUrl) mediaInfo.localUrl = parsed.localUrl;
  if (parsed?.previewUrl) mediaInfo.previewUrl = parsed.previewUrl;
  if (previewSource?.localUrl) mediaInfo.previewUrl = mediaInfo.previewUrl || previewSource.localUrl;

  return mediaInfo;
}

function parseContactShareMessage(plaintext) {
  if (!plaintext) return null;
  let parsed = null;
  if (typeof plaintext === 'string') {
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      parsed = null;
    }
  } else if (typeof plaintext === 'object') {
    parsed = plaintext;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if ((parsed.type && String(parsed.type).toLowerCase() !== 'contact-share')) return null;
  const payload = parsed.payload || parsed.data || null;
  const envelope = parsed.envelope || null;
  return {
    envelope: envelope && envelope.iv && envelope.ct ? envelope : null,
    contactPayload: payload || null,
    conversation: parsed.conversation || null
  };
}

function normalizeMsgTypeValue(value) {
  if (!value || typeof value !== 'string') return null;
  return value.trim().toLowerCase();
}

function resolveMsgTypeForTimeline(rawMsgType, fallbackType = null) {
  const normRaw = normalizeMsgTypeValue(rawMsgType);
  if (normRaw) return normRaw;
  const normFallback = normalizeMsgTypeValue(fallbackType);
  if (normFallback) return normFallback;
  return 'text';
}

function isTimelineMessageType(msgType) {
  const norm = normalizeMsgTypeValue(msgType);
  if (!norm) return true; // default to text if not specified
  return TIMELINE_MESSAGE_TYPES.has(norm);
}

function isControlLikeMessageType(msgType) {
  const norm = normalizeMsgTypeValue(msgType);
  if (!norm) return false;
  return !TIMELINE_MESSAGE_TYPES.has(norm);
}

function logDecryptFailObservation({ conversationId = null, messageId = null, msgType = null, control = false }) {
  const dedupKey = messageId || `${conversationId || 'unknown'}::${msgType || 'unknown'}`;
  if (dedupKey && decryptFailLogDedup.has(dedupKey)) return;
  if (dedupKey) decryptFailLogDedup.add(dedupKey);
  try {
    console.info('[msg] ' + JSON.stringify({
      event: 'decrypt-fail',
      conversationId: conversationId || null,
      messageId: messageId || null,
      msgType: msgType || null,
      control: !!control
    }));
  } catch {
    /* ignore log errors */
  }
}

function logSemanticClassification({ conversationId = null, messageId = null, kind = null, subtype = null }) {
  try {
    console.info('[msg] ' + JSON.stringify({
      event: 'classify',
      conversationId: conversationId || null,
      messageId: messageId || null,
      kind: kind || null,
      subtype: subtype || null
    }));
  } catch {
    /* ignore log errors */
  }
}

function logSemanticControlHandled({ conversationId = null, messageId = null, subtype = null }) {
  try {
    console.info('[msg] ' + JSON.stringify({
      event: 'control:handled',
      conversationId: conversationId || null,
      messageId: messageId || null,
      subtype: subtype || null
    }));
  } catch {
    /* ignore log errors */
  }
}

function logSemanticIgnorableOnce({ conversationId = null, messageId = null, subtype = null }) {
  const dedupKey = messageId || `${conversationId || 'unknown'}::${subtype || 'unknown'}`;
  if (dedupKey && semanticIgnoreLogDedup.has(dedupKey)) return;
  if (dedupKey) semanticIgnoreLogDedup.add(dedupKey);
  try {
    console.info('[msg] ' + JSON.stringify({
      event: 'ignorable',
      conversationId: conversationId || null,
      messageId: messageId || null,
      subtype: subtype || null
    }));
  } catch {
    /* ignore log errors */
  }
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

function summarizeDrState(state) {
  if (!state || typeof state !== 'object') return null;
  const encode = (u8) => {
    try {
      if (!u8 || !(u8 instanceof Uint8Array)) return null;
      return deps.b64 ? deps.b64(u8) : null;
    } catch {
      return null;
    }
  };
  return {
    Ns: Number(state.Ns ?? null),
    Nr: Number(state.Nr ?? null),
    PN: Number(state.PN ?? null),
    hasCkS: state?.ckS instanceof Uint8Array && state.ckS.length > 0,
    hasCkR: state?.ckR instanceof Uint8Array && state.ckR.length > 0,
    myRatchetPub_b64: encode(state?.myRatchetPub),
    theirRatchetPub_b64: encode(state?.theirRatchetPub),
    baseRole: state?.baseKey?.role || null,
    snapshotTs: Number.isFinite(state?.snapshotTs) ? state.snapshotTs : null,
    pendingSendRatchet: !!state?.pendingSendRatchet
  };
}

function recordDrDecryptFailurePayload({
  conversationId,
  peerAccountDigest,
  tokenB64 = null,
  packet = null,
  raw = null,
  reason = 'decrypt-fail',
  state = null,
  messageId = null
} = {}) {
  const envelope =
    packet ||
    (raw
      ? {
          header_json: raw?.header_json || raw?.headerJson || null,
          ciphertext_b64: raw?.ciphertext_b64 || raw?.ciphertextB64 || null,
          counter: raw?.counter ?? raw?.n ?? null
        }
      : null);
  if (!envelope || (!envelope.header_json && !envelope.ciphertext_b64)) return;
  const entry = {
    ts: Date.now(),
    conversationId: conversationId || null,
    peerAccountDigest: peerAccountDigest || null,
    tokenB64: tokenB64 || null,
    payloadEnvelope: envelope,
    raw: raw
      ? {
          id: raw?.id || raw?.message_id || raw?.messageId || messageId || null,
          created_at: raw?.created_at || raw?.createdAt || null
        }
      : null,
    reason,
    state: summarizeDrState(state)
  };
  logDrCore('decrypt:fail:payload', {
    conversationId: entry.conversationId,
    peerAccountDigest: entry.peerAccountDigest,
    messageId: entry.raw?.id || null,
    reason: entry.reason
  });
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

function buildMessageObject({ plaintext, payload, header, raw, direction, ts, messageId, messageKeyB64 }) {
  const meta = payload?.meta || null;
  const baseId = messageId || toMessageId(raw) || null;
  if (!baseId) {
    throw new Error('messageId missing for message object');
  }
  const timestamp = Number.isFinite(ts) ? ts : null;
  const msgType = typeof meta?.msg_type === 'string' ? meta.msg_type : null;
  const targetMessageId = meta?.targetMessageId || (() => {
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
  } else if (msgType === 'contact-share') {
    base.type = 'contact-share';
    base.text = '';
    base.contactShare = parseContactShareMessage(plaintext);
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
    peerDeviceId,
    limit = 20,
    cursorTs,
    cursorId,
    mutateState = true,
    allowReplay = false,
    onMessageDecrypted = null,
    sendReadReceipt = true,
    prefetchedList = null
  } = params;
  if (!conversationId) throw new Error('conversationId required');
  logMsgEvent('fetch:start', {
    conversationId,
    direction: 'incoming',
    peerAccountDigest,
    peerDeviceId,
    hasToken: !!tokenB64,
    source: params?.__debugSource || null
  });
  if (tombstonedConversations.has(String(conversationId))) {
    return {
      items: [],
      nextCursorTs: null,
      nextCursor: null,
      hasMoreAtCursor: false,
      errors: ['此對話已被刪除，請重新建立安全對話。'],
      deadLetters: [],
      receiptUpdates: []
    };
  }
  // 盡量從各來源補齊 peerDeviceId：先拆 peerAccountDigest 的 ::device，再查對話索引。
  let resolvedPeerDeviceId = peerDeviceId || null;
  if (!resolvedPeerDeviceId && typeof peerAccountDigest === 'string' && peerAccountDigest.includes('::')) {
    const [, devPart] = peerAccountDigest.split('::');
    const ident = storeNormalizePeerIdentity({ peerAccountDigest });
    resolvedPeerDeviceId = ident?.deviceId || (devPart ? devPart.trim() : null) || null;
  }
  if (!resolvedPeerDeviceId) {
    try {
      const fromConv = sessionStore?.conversationIndex?.get?.(conversationId);
      resolvedPeerDeviceId = fromConv?.peerDeviceId || resolvedPeerDeviceId;
      if (!resolvedPeerDeviceId) {
        const fromThread = sessionStore?.conversationThreads?.get?.(conversationId);
        resolvedPeerDeviceId = fromThread?.peerDeviceId || resolvedPeerDeviceId;
      }
    } catch {
      /* ignore */
    }
  }
  const identity = storeNormalizePeerIdentity({ peerAccountDigest, peerDeviceId: resolvedPeerDeviceId });
  const peerKey = identity.key;
  const peerAccountDigestNormalized = identity.accountDigest || (peerKey && peerKey.includes('::') ? peerKey.split('::')[0] : peerKey) || null;
  const peerDevice = identity.deviceId || null;
  if (!peerKey || !peerDevice) {
    logMsgEvent('fetch:fail', {
      conversationId,
      direction: 'incoming',
      gate: 'missingPeerIdentity',
      reason: 'peer identity required (digest + deviceId)',
      peerAccountDigest,
      peerDeviceId: resolvedPeerDeviceId || peerDeviceId || null,
      resolvedAccountDigest: identity.accountDigest || null,
      resolvedDeviceId: identity.deviceId || null,
      source: params?.__debugSource || null
    }, { level: 'warn' });
    throw new Error('peer identity required (digest + deviceId)');
  }
  // 若入口補齊了 peerDeviceId，寫回 state，避免後續呼叫仍為空。
  try {
    if (resolvedPeerDeviceId && sessionStore?.messageState) {
      if (!sessionStore.messageState.activePeerDeviceId) sessionStore.messageState.activePeerDeviceId = resolvedPeerDeviceId;
      if (peerAccountDigest && !sessionStore.messageState.activePeerDigest) {
        const idObj = storeNormalizePeerIdentity({ peerAccountDigest, peerDeviceId: resolvedPeerDeviceId });
        if (idObj?.key) sessionStore.messageState.activePeerDigest = idObj.key;
      }
    }
  } catch {
    /* ignore */
  }
  const clearAfter = getConversationClearAfter(conversationId);
  if (secureFetchLocks.has(conversationId)) {
    return {
      items: [],
      nextCursorTs: null,
      errors: ['同步進行中，請稍後再試'],
      receiptUpdates: [],
      deadLetters: [],
      hasMoreAtCursor: false,
      serverItemCount: 0
    };
  }
  secureFetchLocks.add(conversationId);
  try {
  const peerRef = {
    peerAccountDigest: identity.accountDigest || peerKey,
    peerDeviceId: peerDevice
  };
  const selfDeviceId = typeof storeEnsureDeviceId === 'function' ? storeEnsureDeviceId() : null;

  const now = Date.now();
  const backoffUntil = secureFetchBackoff.get(conversationId) || 0;
  if (now < backoffUntil) {
    return {
      items: [],
      nextCursorTs: null,
      errors: ['訊息服務暫時無法使用，請稍後再試。']
    };
  }

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
  if (prefetchedList) {
    items = Array.isArray(prefetchedList.items) ? prefetchedList.items : [];
    serverItemCount = items.length;
    nextCursorTs = prefetchedList?.nextCursorTs ?? null;
    nextCursor = prefetchedList?.nextCursor || (nextCursorTs != null && items.length ? { ts: nextCursorTs, id: items[items.length - 1]?.id || null } : null);
    hasMoreAtCursor = !!prefetchedList?.hasMoreAtCursor;
  } else {
    const { r, data } = await deps.listSecureMessages({ conversationId, limit, cursorTs, cursorId });
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
  }
  const drDebug = isDrDebugEnabled();

  // 若 server 表示同一時間戳仍有更多，連續補抓避免截斷（安全上限避免無窮迴圈）。
  if (hasMoreAtCursor && nextCursor && !prefetchedList) {
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
        if (mid && seen.has(mid)) continue;
        if (mid) seen.add(mid);
        deduped.push(it);
      }
      items = deduped;
    }
  }
  const selfDigest = (deps.getAccountDigest && deps.getAccountDigest()) ? String(deps.getAccountDigest()).toUpperCase() : null;

  // 依 clearAfter 過濾舊訊息
  let filteredItems = sortMessagesByTimeline(items);
  if (Number.isFinite(clearAfter)) {
    filteredItems = filteredItems.filter((it) => {
      const ts = toMessageTimestamp(it);
      return !Number.isFinite(ts) || ts >= clearAfter;
    });
  }
  const sortedItems = filteredItems;
  const shouldTrackState = mutateState !== false;
  const stateByDevice = new Map();
  const secureStatusByDevice = new Map();
  const ensuredConversations = new Set();
  const logSkipLine = (fields = {}) => {
    logMsgEvent('skip', {
      conversationId,
      stage: 'handle',
      ...fields,
      direction: fields.direction || 'incoming',
      gate: fields.gate || fields.reason || null,
      reason: fields.reason || fields.gate || null
    });
  };
  try {
    const fetchIds = sortedItems.map((it) => ({
      serverMessageId: toMessageId(it) || it?.id || null,
      senderDigest: it?.senderAccountDigest || it?.sender_digest || null,
      senderDeviceId: it?.senderDeviceId || it?.sender_device_id || null
    }));
    logMsgEvent('fetch:batch', {
      direction: 'incoming',
      conversationId,
      serverItemCount,
      items: fetchIds
    });
  } catch {}

  const getPeerRef = (deviceId) => ({
    peerAccountDigest: identity.accountDigest || peerKey,
    peerDeviceId: deviceId
  });

  const getStateForDevice = (deviceId) => {
    if (!deviceId) throw new Error('peerDeviceId required for DR state');
    if (shouldTrackState) {
      const existing = stateByDevice.get(deviceId);
      if (existing) return existing;
      const created = deps.drState(getPeerRef(deviceId));
      stateByDevice.set(deviceId, created);
      return created;
    }
    const base = deps.drState(getPeerRef(deviceId));
    const cloned = deps.cloneDrStateHolder?.(base) || base;
    return cloned;
  };

  const ensureReceiverStateReady = (deviceId) => {
    const current = getStateForDevice(deviceId);
    if (!hasUsableDrState(current)) {
      throw new Error('DR state unavailable for conversation');
    }
    return current;
  };

  const ensureConversationReadyForDevice = async (deviceId) => {
    if (!deviceId) return { status: null };
    const key = `${peerKey}::${deviceId}`;
    if (ensuredConversations.has(key)) {
      return { status: secureStatusByDevice.get(deviceId) || null };
    }
    const statusInfo = await deps.ensureSecureConversationReady({
      peerAccountDigest: peerKey,
      peerDeviceId: deviceId,
      reason: 'list-messages',
      source: 'messages:listSecureAndDecrypt',
      conversationId
    });
    const status = statusInfo?.status || null;
    secureStatusByDevice.set(deviceId, status);
    if (status === SECURE_CONVERSATION_STATUS.PENDING) {
      return { status };
    }
    ensuredConversations.add(key);
    return { status };
  };

  // 預先確保初始 peerDevice 的會話就緒與 state 存在。
  if (peerDevice) {
    const initialStatus = await ensureConversationReadyForDevice(peerDevice);
    if (initialStatus?.status === SECURE_CONVERSATION_STATUS.PENDING) {
      return {
        items: [],
        nextCursorTs: null,
        nextCursor: null,
        hasMoreAtCursor: false,
        errors: ['安全對話建立中，請稍後再試。'],
        receiptUpdates: [],
        deadLetters: [],
        serverItemCount: 0
      };
    }
    ensureReceiverStateReady(peerDevice);
  }

  if (drDebug) {
    logDrCore('list:stats', {
      peerAccountDigest: peerKey,
      conversationId,
      mutateState: shouldTrackState,
      mode: shouldTrackState ? 'live' : 'preview',
      cursorTs: cursorTs ?? null,
      nextCursorTs,
      itemsRequested: sortedItems.length
    }, { level: 'log', force: true });
  }

  const handleInboxJob = async (job) => {
    const trackState = shouldTrackState;
    const raw = job?.raw || {};
    const jobPacket = job?.payloadEnvelope || null;
    let payloadMsgType = null;
    let rawMsgType = null;
    let msgTypeForDecrypt = 'text';
    let convId = null;
    let headerRaw = null;
    let headerJson = null;
    let header = null;
    let meta = null;
    let payload = null;
    let messageTs = null;
    let stableContactShareKey = null;
    let ciphertextB64 = null;
    let packet = null;
    let senderDeviceId = null;
    let stateKey = null;
    let messageId = null;
    let serverMessageId = null;
    let senderDigest = null;
    let direction = 'unknown';
    const logDeliverySkip = (gate, extra = {}) => {
      logSkipLine({
        gate,
        reason: extra?.reason || gate,
        conversationId: convId,
        direction: direction || 'incoming',
        messageId,
        serverMessageId,
        stateKey,
        senderDigest,
        senderDeviceId,
        ...extra
      });
    };
    const logControlHandled = (subtype = null) => {
      try {
        console.info('[msg] ' + JSON.stringify({
          event: 'control:handled',
          conversationId: convId || null,
          messageId: messageId || null,
          subtype: subtype || null
        }));
      } catch {
        /* ignore */
      }
    };
    try {
      headerRaw = jobPacket?.header_json || raw?.header_json || raw?.headerJson || raw?.header || null;
      if (typeof headerRaw === 'string') {
        try { header = JSON.parse(headerRaw); } catch {}
      } else if (headerRaw && typeof headerRaw === 'object') {
        header = headerRaw;
      }
      ciphertextB64 = jobPacket?.ciphertext_b64 || raw?.ciphertext_b64 || raw?.ciphertextB64 || null;
      // 只接受 DR 封包；其他類型（例如 contact snapshot）直接跳過。
      if (!header) {
        throw new Error('缺少訊息標頭或密文，無法進行 DR 解密');
      }
      if (!header.dr) {
        logDeliverySkip('nonDrPayload', { headerKeys: Object.keys(header || {}) });
        return;
      }
      if (!ciphertextB64 || !header.iv_b64) {
        throw new Error('缺少訊息標頭或密文，無法進行 DR 解密');
      }
        if (header?.fallback) throw new Error('偵測到舊版 fallback 封包，已不再支援');
        packet = {
          header_json: headerRaw,
          ciphertext_b64: ciphertextB64,
          counter: jobPacket?.counter ?? header?.n ?? null
        };
      const pkt = {
        aead: 'aes-256-gcm',
        header,
        iv_b64: header.iv_b64,
        ciphertext_b64: ciphertextB64
      };
      serverMessageId = toMessageId(raw) || raw?.id || null;
      messageId = job?.messageId || serverMessageId;
      if (!messageId) {
        throw new Error('messageId missing for inbound message');
      }

      meta = header?.meta || null;
      payload = { meta: meta || null };
      const msgTs = Number(meta?.ts || raw?.created_at || raw?.createdAt || job?.createdAt || null);
      messageTs = Number.isFinite(msgTs) ? msgTs : null;
      const packetConversationId = packet?.conversationId || raw?.conversationId || raw?.conversation_id || conversationId || null;
      meta = payload?.meta || null;
      payloadMsgType = normalizeControlMessageType(meta?.msg_type || meta?.msgType || null);
      rawMsgType = typeof meta?.msg_type === 'string'
        ? meta.msg_type
        : (typeof meta?.msgType === 'string' ? meta.msgType : null);
      msgTypeForDecrypt = rawMsgType || (payloadMsgType ? String(payloadMsgType) : 'text');
      const isMediaMessage = !!(meta?.media);

      // Sender/target判斷：先看 direction，再套用目標驗證（避免把自己送出的封包誤判）。
      convId = packetConversationId;
      const senderDigestRaw = raw?.senderAccountDigest || meta?.senderDigest || '';
      senderDigest = typeof senderDigestRaw === 'string' ? senderDigestRaw.toUpperCase() : '';
      direction = 'unknown';
      senderDeviceId = meta?.sender_device_id
        || meta?.senderDeviceId
        || raw?.senderDeviceId
        || raw?.sender_device_id
        || header?.device_id
        || null;
      const targetDigestRaw = raw?.targetAccountDigest
        || raw?.target_account_digest
        || meta?.targetAccountDigest
        || meta?.target_account_digest
        || meta?.receiverAccountDigest
        || meta?.receiver_account_digest
        || raw?.receiverAccountDigest
        || raw?.receiver_account_digest
        || null;
      const targetDeviceRaw = raw?.targetDeviceId
        || raw?.target_device_id
        || meta?.targetDeviceId
        || meta?.target_device_id
        || meta?.receiverDeviceId
        || meta?.receiver_device_id
        || raw?.receiverDeviceId
        || raw?.receiver_device_id
        || null;
      const targetDeviceId = targetDeviceRaw ? String(targetDeviceRaw) : null;
      let targetDigest = targetDigestRaw ? String(targetDigestRaw).toUpperCase() : null;
      const deviceMatchesSelf = !!(selfDeviceId && targetDeviceId && targetDeviceId === selfDeviceId);
      const isSelfSender = !!(selfDigest && senderDigest && senderDigest === selfDigest);
      const isHistoryReplay = allowReplay === true && trackState === false;

      if (deviceMatchesSelf) {
        direction = 'incoming';
        if (!targetDigest && selfDigest) targetDigest = selfDigest;
      } else if (isSelfSender) {
        direction = 'outgoing';
      } else {
        direction = 'incoming';
      }

      let peerDeviceForMessage = senderDeviceId || peerDevice;
      if (isHistoryReplay && isSelfSender && targetDeviceId) {
        peerDeviceForMessage = targetDeviceId;
      }

      logMsgEvent('device-check', {
        conversationId: packetConversationId,
        messageId,
        senderDeviceId,
        targetDeviceId,
        selfDeviceId,
        peerDeviceId: peerDeviceForMessage || null,
        directionComputed: direction
      });
      if (selfDeviceId && peerDevice && selfDeviceId === peerDevice) {
        throw new Error('SELF_DEVICE_ID_CORRUPTED: selfDeviceId equals peerDeviceId');
      }
      logMsgEvent('handle:start', {
        stage: 'handle',
        direction,
        conversationId: packetConversationId,
        serverMessageId,
        messageId,
        senderDigest,
        senderDeviceId,
        targetDeviceId,
        targetDigest,
        selfDeviceId
      });
      if (!targetDeviceId) {
        logDeliverySkip('targetDeviceMissing', { targetDeviceId, selfDeviceId, senderDeviceId });
        return;
      }
      if (isHistoryReplay) {
        if (!deviceMatchesSelf && !isSelfSender) {
          logDeliverySkip('directionFilter', { senderDeviceId, targetDeviceId, selfDeviceId });
          return;
        }
      } else {
        if (!deviceMatchesSelf) {
          logDeliverySkip('directionFilter', { senderDeviceId, targetDeviceId, selfDeviceId });
          return;
        }
      }
      const secureStatus = await ensureConversationReadyForDevice(peerDeviceForMessage);
      if (secureStatus?.status === SECURE_CONVERSATION_STATUS.PENDING) {
        logDeliverySkip('securePending', { peerDeviceId: peerDeviceForMessage, conversationId: packetConversationId || conversationId });
        return;
      }

      stateKey = buildStateKey({ conversationId: packetConversationId, peerKey, peerDeviceId: peerDeviceForMessage });
      logDrCore('packet:key', { conversationId: packetConversationId, messageId, stateKey });
      if (convId && typeof convId === 'string' && convId.startsWith('contacts-')) {
        logDeliverySkip('contactConversation');
        return;
      }
      if (messageId && decryptFailDedup.has(messageId)) {
        logDeliverySkip('decryptFailDedup');
        return;
      }
      const cachedState = decryptFailMessageCache.get(messageId);
      if (cachedState && cachedState === stateKey) {
        logDeliverySkip('messageFailCache', { stateKey });
        return;
      }
      if (cachedState && cachedState !== stateKey) {
        decryptFailMessageCache.delete(messageId);
      }
      if (msgTypeForDecrypt === 'contact-share') {
        stableContactShareKey = messageId;
      }

      if (msgTypeForDecrypt === 'contact-share' && !senderDeviceId) {
        const availableDevices = {
          headerDeviceId: header?.device_id || null,
          metaSenderDeviceId: meta?.sender_device_id || meta?.senderDeviceId || null,
          rawSenderDeviceId: raw?.senderDeviceId || raw?.sender_device_id || null,
          targetDeviceId: targetDeviceId || null
        };
        throw new Error(`contact-share missing senderDeviceId (available=${JSON.stringify(availableDevices)})`);
      }
      if (drDebug) {
        logDrCore('inbox:receive', {
          conversationId,
          peerAccountDigest: peerKey,
          messageId,
          msgType: meta?.msg_type || meta?.msgType || null,
          targetDigest,
          senderDigest: meta?.sender_digest || meta?.senderDigest || null
        }, { level: 'log', force: true });
      }
      // peer 身份以 senderDigest 為準；header.peerAccountDigest 只做觀察，不作為拒收條件，避免因欄位命名差異造成單一路徑被中斷。
      // direction 以 targetDeviceId 為優先，targetDigest 僅做記錄，不作為拒收條件。

      state = getStateForDevice(peerDeviceForMessage);
      state.baseKey = state.baseKey || {};
      if (peerDeviceForMessage && !state.baseKey.peerDeviceId) {
        state.baseKey.peerDeviceId = peerDeviceForMessage;
      }
      if (peerKey && !state.baseKey.peerAccountDigest) {
        state.baseKey.peerAccountDigest = peerKey;
      }
      const holderConvId = state?.baseKey?.conversationId || null;
      if (holderConvId && convId && holderConvId !== convId) {
        const hasSendChain = state?.ckS instanceof Uint8Array && state.ckS.length > 0;
        const sendCounter = Number.isFinite(state?.Ns) ? state.Ns : 0;
        if (hasSendChain || sendCounter > 0) {
          throw new Error('DR state bound to different conversation; please resync contact');
        }
        deps.clearDrState(
          { peerAccountDigest: peerKey, peerDeviceId: peerDeviceForMessage },
          { __drDebugTag: 'web/src/app/features/messages.js:1119:handleInboxJob:conv-mismatch-clear' }
        );
        if (deps.ensureDrReceiverState && peerKey && peerDeviceForMessage) {
          await deps.ensureDrReceiverState({ peerAccountDigest: peerKey, peerDeviceId: peerDeviceForMessage, conversationId: convId });
          state = getStateForDevice(peerDeviceForMessage);
        }
      }
      // guest/未知角色若拿到 responder state，強制清除並要求 initiator 重建（無 fallback）。
      const stateRole = typeof state?.baseKey?.role === 'string' ? state.baseKey.role.toLowerCase() : null;
      const hasReceiveChain = state?.ckR instanceof Uint8Array && state.ckR.length > 0;
      const hasRatchetCore = state?.rk instanceof Uint8Array && state?.myRatchetPriv instanceof Uint8Array && state?.myRatchetPub instanceof Uint8Array;
      if (
        stateRole === 'responder' &&
        (direction === 'incoming' || direction === 'unknown') &&
        (!hasRatchetCore || !hasReceiveChain)
      ) {
        deps.clearDrState(
          { peerAccountDigest: peerKey, peerDeviceId: peerDeviceForMessage },
          { __drDebugTag: 'web/src/app/features/messages.js:1131:handleInboxJob:responder-inbound-clear' }
        );
        if (deps.ensureDrReceiverState && peerKey && peerDeviceForMessage) {
          await deps.ensureDrReceiverState({ peerAccountDigest: peerKey, peerDeviceId: peerDeviceForMessage, conversationId: convId });
          state = getStateForDevice(peerDeviceForMessage);
        }
      }
      // 若仍缺可用 state，直接 fail（無任何 fallback）。
      if (!hasUsableDrState(state)) {
        if (deps.ensureDrReceiverState && peerKey && peerDeviceForMessage) {
          await deps.ensureDrReceiverState({ peerAccountDigest: peerKey, peerDeviceId: peerDeviceForMessage, conversationId: convId });
          state = getStateForDevice(peerDeviceForMessage);
        }
        if (!hasUsableDrState(state)) {
          throw new Error('DR state unavailable for conversation');
        }
      }
      if (convId && state) {
        state.baseKey = state.baseKey || {};
        if (!state.baseKey.conversationId) {
          state.baseKey.conversationId = convId;
        }
        if (peerDeviceForMessage && !state.baseKey.peerDeviceId) {
          state.baseKey.peerDeviceId = peerDeviceForMessage;
        }
        if (peerKey && !state.baseKey.peerAccountDigest) {
          state.baseKey.peerAccountDigest = peerKey;
        }
      }
      if (!ensuredConversations.has(`${peerKey}::${peerDeviceForMessage}`)) {
        await ensureConversationReadyForDevice(peerDeviceForMessage);
      }
      if (msgTypeForDecrypt === 'contact-share' && stableContactShareKey) {
        const processedSet = processedContactShare.get(convId) || new Set();
        if (processedSet.has(stableContactShareKey)) {
          logDeliverySkip('processedContactShare', { stableKey: stableContactShareKey });
          return;
        }
      }

      // 單一路徑：若收到同一 ratchet 鏈上已消耗過的 counter，直接跳過，避免重放造成錯用 ckR。
      const currentNr = Number.isFinite(Number(state?.Nr)) ? Number(state.Nr) : 0;
      state.Nr = currentNr; // normalize to numeric to avoid string comparisons
      const headerCounter = Number(header?.n);
      const sameReceiveChain = state?.theirRatchetPub && typeof header?.ek_pub_b64 === 'string'
        && naclB64(state.theirRatchetPub) === header.ek_pub_b64;
      if (sameReceiveChain && Number.isFinite(headerCounter) && currentNr >= headerCounter) {
        logDeliverySkip('duplicateCounter', {
          counter: headerCounter,
          nr: currentNr
        });
        return;
      }
      let messageKeyB64 = null;
      logDrCore('decrypt:attempt', {
        conversationId: convId,
        peerAccountDigest: peerKey,
        messageId,
        peerDeviceId: peerDeviceForMessage || null,
        targetDeviceId: targetDeviceId || null,
        senderDeviceId: senderDeviceId || null,
        selfDeviceId,
        headerCounter: Number(header?.n ?? packet.counter ?? null),
        headerEkPub: header?.ek_pub_b64 || null,
        headerDeviceId: header?.device_id || null,
        stateConvId: state?.baseKey?.conversationId || null,
        stateRole: state?.baseKey?.role || null,
        stateHasCkR: !!(state?.ckR && state.ckR.length),
        stateHasCkS: !!(state?.ckS && state.ckS.length),
        stateNs: Number.isFinite(state?.Ns) ? state.Ns : null,
        stateNr: Number.isFinite(state?.Nr) ? state.Nr : null,
        stateTheirPub: state?.theirRatchetPub ? (deps.b64 ? deps.b64(state.theirRatchetPub) : null) : null
      }, { level: 'log' });
      const aad = header && deps.buildDrAadFromHeader ? deps.buildDrAadFromHeader(header) : null;
      const aadHash = aad ? await hashBytesHex(aad) : null;
      const stateFingerprint = {
        theirRatchetPubHash: state?.theirRatchetPub ? await hashBytesHex(state.theirRatchetPub) : null,
        Nr: Number(state?.Nr ?? null),
        Ns: Number(state?.Ns ?? null),
        PN: Number(state?.PN ?? null),
        hasCkR: state?.ckR instanceof Uint8Array && state.ckR.length > 0,
        hasCkS: state?.ckS instanceof Uint8Array && state.ckS.length > 0,
        role: state?.baseKey?.role || null
      };
      const preDecryptSnapshot = deps.cloneDrStateHolder ? deps.cloneDrStateHolder(state) : null;
      const preDecryptCore = {
        ckRHash: state?.ckR instanceof Uint8Array ? await hashBytesHex(state.ckR) : null,
        Nr: Number(state?.Nr ?? null),
        PN: Number(state?.PN ?? null),
        theirRatchetPubHash: state?.theirRatchetPub ? await hashBytesHex(state.theirRatchetPub) : null,
        role: state?.baseKey?.role || null
      };
      logDrCore('decrypt:fingerprint', {
        conversationId: convId,
        messageId,
        aadHash,
        aadLen: aad ? aad.byteLength : null,
        state: stateFingerprint,
        msgType: payloadMsgType || null,
        preDecryptCore
      });
      const preDecryptState = summarizeDrState(state);
      const text = await deps.drDecryptText(state, pkt, {
        onMessageKey: (mk) => { messageKeyB64 = mk; },
        packetKey: messageId,
        msgType: msgTypeForDecrypt
      });
      const postState = summarizeDrState(state);
      logDrCore('decrypt:state', {
        conversationId: convId,
        peerAccountDigest: peerKey,
        peerDeviceId: peerDeviceForMessage || null,
        headerN: Number(header?.n ?? packet?.counter ?? null),
        headerEk: header?.ek_pub_b64 ? String(header.ek_pub_b64).slice(0, 12) : null,
        preState: preDecryptState,
        postState
      });
      decryptFailMessageCache.delete(messageId);
      logMsgEvent('decrypt:ok', {
        conversationId: convId,
        direction,
        messageId,
        serverMessageId,
        senderDigest,
        senderDeviceId,
        peerAccountDigest: peerKey,
        peerDeviceId: peerDeviceForMessage || null,
        msgType: payloadMsgType || msgTypeForDecrypt,
        targetDeviceId
      });

      if (trackState) {
        deps.persistDrSnapshot({ peerAccountDigest: peerKey, state });
        if (msgTypeForDecrypt === 'contact-share' && stableContactShareKey) {
          let set = processedContactShare.get(convId);
          if (!set) {
            set = new Set();
            processedContactShare.set(convId, set);
          }
          set.add(stableContactShareKey);
        }
      }

      const semantic = classifyDecryptedPayload(text, { meta, header });
      logSemanticClassification({
        conversationId: convId,
        messageId,
        kind: semantic.kind,
        subtype: semantic.subtype
      });

      if (semantic.kind === SEMANTIC_KIND.IGNORABLE) {
        logSemanticIgnorableOnce({
          conversationId: convId,
          messageId,
          subtype: semantic.subtype
        });
        return;
      }

      if (semantic.kind === SEMANTIC_KIND.CONTROL_STATE) {
        if (convId && messageId && wasMessageProcessed(convId, messageId)) {
          logDeliverySkip('processedControl', { msgType: semantic.subtype || null });
          return;
        }
        if (semantic.subtype === 'contact-share') {
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
          if (drDebug) {
            logDrCore('inbox:contact-share', {
              conversationId: convId,
              peerAccountDigest: peerKey,
              messageId
            }, { level: 'log', force: true });
          }
          try {
            if (typeof document !== 'undefined' && document?.dispatchEvent) {
              document.dispatchEvent(new CustomEvent('contact-share', {
                detail: { message: messageObj, conversationId: convId, peerAccountDigest: peerKey }
              }));
            }
          } catch {}
          if (convId && messageId) {
            markMessageProcessed(convId, messageId);
          }
          logControlHandled(semantic.subtype);
          logSemanticControlHandled({
            conversationId: convId,
            messageId,
            subtype: semantic.subtype
          });
          return;
        }
        if (
          semantic.subtype === 'session-error' ||
          semantic.subtype === 'session-init' ||
          semantic.subtype === 'session-ack'
        ) {
          try {
            handleSecureConversationControlMessage({
              peerAccountDigest: peerKey,
              messageType: semantic.subtype,
              source: 'messages:inbox'
            });
          } catch {}
          if (convId && messageId) {
            markMessageProcessed(convId, messageId);
          }
          logControlHandled(semantic.subtype);
          logSemanticControlHandled({
            conversationId: convId,
            messageId,
            subtype: semantic.subtype
          });
          return;
        }
        if (convId && messageId) {
          markMessageProcessed(convId, messageId);
        }
        logControlHandled(semantic.subtype);
        logSemanticControlHandled({
          conversationId: convId,
          messageId,
          subtype: semantic.subtype
        });
        return;
      }

      if (semantic.kind === SEMANTIC_KIND.TRANSIENT_SIGNAL) {
        if (convId && messageId && wasMessageProcessed(convId, messageId)) {
          logDeliverySkip('processedTransient', { msgType: semantic.subtype || null });
          return;
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
        const isReadReceipt = messageObj?.type === CONTROL_MESSAGE_TYPES.READ_RECEIPT && messageObj?.targetMessageId;
        const isDeliveryReceipt = messageObj?.type === CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT && messageObj?.targetMessageId;
        if (isReadReceipt) {
          const updated = recordMessageRead(convId, messageObj.targetMessageId, messageTs || null);
          if (updated) {
            receiptUpdates.add(messageObj.targetMessageId);
          }
        } else if (isDeliveryReceipt) {
          recordMessageDelivered(convId, messageObj.targetMessageId, messageTs || null);
        }
        if (convId && messageId) {
          markMessageProcessed(convId, messageId);
        }
        return;
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
      const resolvedMsgType = semantic.subtype || resolveMsgTypeForTimeline(rawMsgType, messageObj?.type || msgTypeForDecrypt);
      if (messageObj) {
        const cacheMessageId = normalizeMessageId(messageObj);
        if (convId && cacheMessageId) {
          putDecryptedMessage(convId, messageObj);
          logMsgEvent('ui:cache-put', {
            stage: 'ui',
            action: 'cache-put',
            conversationId: convId,
            messageId: cacheMessageId,
            serverMessageId,
            direction: messageObj.direction || direction || 'incoming',
            msgType: resolvedMsgType || messageObj.type || payloadMsgType || msgTypeForDecrypt || null
          });
        }
        const timelineEntry = {
          conversationId: convId,
          messageId: cacheMessageId || messageId || null,
          direction: messageObj.direction || direction || 'incoming',
          msgType: resolvedMsgType || messageObj.type || payloadMsgType || msgTypeForDecrypt || null,
          ts: messageObj.ts || messageTs || null,
          text: messageObj.text || null,
          media: messageObj.media || null,
          callLog: messageObj.callLog || null,
          senderDigest: senderDigest || messageObj.senderDigest || null,
          senderDeviceId: senderDeviceId || messageObj.senderDeviceId || null,
          peerDeviceId: messageObj.peerDeviceId || null
        };
        const appended = timelineAppendUserMessage(convId, timelineEntry);
        if (appended) {
          try {
            console.info('[msg] ' + JSON.stringify({
              event: 'timeline:append',
              conversationId: convId || null,
              messageId: timelineEntry.messageId || cacheMessageId || messageId || null,
              direction: timelineEntry.direction || null,
              msgType: timelineEntry.msgType || null,
              ts: timelineEntry.ts || null
            }));
          } catch {
            /* ignore */
          }
        }
        out.push(messageObj);
        if (messageObj.direction === 'incoming' && messageObj.id) {
          maybeSendDeliveryReceipt({
            conversationId: convId,
            peerAccountDigest: peerKey,
            messageId: messageObj.id,
            tokenB64,
            peerDeviceId: peerDeviceForMessage
          });
          if (sendReadReceipt) {
            maybeSendReadReceipt(convId, peerKey, peerDeviceForMessage, messageObj.id);
          }
        }
        if (onMessageDecrypted) {
          try {
            onMessageDecrypted({ message: messageObj, conversationId: convId, peerAccountDigest: peerKey });
          } catch (cbErr) {
            console.warn('[messages] onMessageDecrypted callback failed', cbErr);
          }
        }
        drFailureCounter.delete(`${convId}::${peerKey}::${peerDeviceForMessage || 'unknown-device'}`);
      }
    } catch (err) {
      // Restore the holder to the state before this decrypt attempt to align all message types (including contact-share)
      // to the same receive-chain rollback behavior.
      if (preDecryptSnapshot) {
        try {
          state.rk = preDecryptSnapshot.rk || null;
          state.ckS = preDecryptSnapshot.ckS || null;
          state.ckR = preDecryptSnapshot.ckR || null;
          state.Ns = Number.isFinite(preDecryptSnapshot.Ns) ? Number(preDecryptSnapshot.Ns) : state.Ns;
          state.Nr = Number.isFinite(preDecryptSnapshot.Nr) ? Number(preDecryptSnapshot.Nr) : state.Nr;
          state.NsTotal = Number.isFinite(preDecryptSnapshot.NsTotal) ? Number(preDecryptSnapshot.NsTotal) : state.NsTotal;
          state.NrTotal = Number.isFinite(preDecryptSnapshot.NrTotal) ? Number(preDecryptSnapshot.NrTotal) : state.NrTotal;
          state.PN = Number.isFinite(preDecryptSnapshot.PN) ? Number(preDecryptSnapshot.PN) : state.PN;
          state.myRatchetPriv = preDecryptSnapshot.myRatchetPriv || state.myRatchetPriv;
          state.myRatchetPub = preDecryptSnapshot.myRatchetPub || state.myRatchetPub;
          state.theirRatchetPub = preDecryptSnapshot.theirRatchetPub || state.theirRatchetPub;
          state.pendingSendRatchet = !!preDecryptSnapshot.pendingSendRatchet;
          state.skippedKeys = preDecryptSnapshot.skippedKeys instanceof Map
            ? new Map([...preDecryptSnapshot.skippedKeys.entries()].map(([chainId, chain]) => [chainId, chain instanceof Map ? new Map(chain) : chain]))
            : new Map();
          if (preDecryptSnapshot.baseKey) state.baseKey = { ...preDecryptSnapshot.baseKey };
        } catch {}
      }
      const msg = err?.message || String(err);
      const semantic = classifyDecryptedPayload(null, { meta, header });
      const failedMessageId = messageId || job?.messageId || job?.raw?.id || null;
      const msgTypeLabel =
        semantic.subtype ||
        normalizeMsgTypeValue(rawMsgType) ||
        normalizeMsgTypeValue(payloadMsgType) ||
        null;
      const controlLike = semantic.kind !== SEMANTIC_KIND.USER_MESSAGE;
      const shouldCountForUi = semantic.kind === SEMANTIC_KIND.USER_MESSAGE;
      logDecryptFailObservation({
        conversationId: convId,
        messageId: failedMessageId,
        msgType: msgTypeLabel,
        control: controlLike
      });
      if (shouldCountForUi) {
        errs.push({
          messageId: failedMessageId || null,
          msgType: msgTypeLabel || null,
          kind: semantic.kind,
          subtype: semantic.subtype,
          control: false,
          reason: msg
        });
      }
      logMsgEvent('decrypt:fail', {
        conversationId: convId,
        direction,
        messageId: failedMessageId,
        serverMessageId,
        gate: 'decryptFail',
        reason: msg,
        msgType: msgTypeLabel || payloadMsgType || rawMsgType || msgTypeForDecrypt,
        senderDigest,
        senderDeviceId,
        targetDeviceId,
        peerAccountDigest: peerKey,
        peerDeviceId: peerDeviceForMessage || null,
        stateKey
      }, { level: 'error' });
      if (failedMessageId) decryptFailDedup.add(failedMessageId);
      if (failedMessageId) {
        decryptFailMessageCache.set(failedMessageId, stateKey);
        logDrCore('decrypt:message-cache-set', { conversationId: convId, messageId: failedMessageId, stateKey });
      }
      const drMeta = err?.__drMeta || null;
      let packet = null;
      try {
        packet = {
          header_json: headerRaw || headerJson || null,
          ciphertext_b64: ciphertextB64,
          counter: job?.payloadEnvelope?.counter ?? job?.raw?.counter ?? job?.raw?.n ?? header?.n ?? null
        };
        if (header && header?.meta?.msg_type === 'contact-share' && Number(header?.n) === 1) {
          const ratchetPerformed = !!(state?.theirRatchetPub && header?.ek_pub_b64 && naclB64(state.theirRatchetPub) !== header.ek_pub_b64);
          logDrCore('decrypt:fail-fingerprint', {
            conversationId: convId,
            messageId: failedMessageId,
            headerEkPub: header?.ek_pub_b64 ? String(header.ek_pub_b64).slice(0, 12) : null,
            headerN: Number(header?.n ?? null),
            senderDeviceId,
            stateTheirPub: state?.theirRatchetPub ? (deps.b64 ? deps.b64(state.theirRatchetPub).slice(0, 12) : null) : null,
            Nr: state?.Nr ?? null,
            Ns: state?.Ns ?? null,
            PN: state?.PN ?? null,
            hasCkR: !!(state?.ckR && state.ckR.length),
            hasCkS: !!(state?.ckS && state.ckS.length),
            ratchetPerformed,
            nUsed: drMeta?.nUsed ?? null,
            nrAfterRatchet: drMeta?.nrAfterRatchet ?? null
          });
        }
        logDrCore('decrypt:fail-state', {
          conversationId: convId,
          peerAccountDigest: peerKey,
          peerDeviceId: peerDeviceForMessage || null,
          targetDeviceId: targetDeviceId || null,
          senderDeviceId: senderDeviceId || null,
          stateKey: `${convId || 'unknown'}::${peerKey || 'unknown'}::${peerDeviceForMessage || 'unknown'}`,
          state: summarizeDrState(state),
          headerN: Number(header?.n ?? job?.raw?.n ?? null),
          headerEk: header?.ek_pub_b64 ? String(header.ek_pub_b64).slice(0, 12) : null,
          stateTheirPub: state?.theirRatchetPub ? (deps.b64 ? deps.b64(state.theirRatchetPub).slice(0, 12) : null) : null
        });
        // Extra debug to pinpoint mismatched session/keys without touching protocol flow.
        logDrCore('decrypt:fail-debug', {
          conversationId: convId,
          peerAccountDigest: peerKey,
          messageId: messageId || job?.messageId || job?.raw?.id || null,
          peerDeviceId: peerDeviceForMessage || null,
          targetDeviceId: targetDeviceId || null,
          senderDeviceId: senderDeviceId || null,
          selfDeviceId,
          headerEkPub: header?.ek_pub_b64 || null,
          headerDeviceId: header?.device_id || null,
          stateConvId: state?.baseKey?.conversationId || null,
          stateRole: state?.baseKey?.role || null,
          stateHasCkR: !!(state?.ckR && state.ckR.length),
          stateHasCkS: !!(state?.ckS && state.ckS.length),
          stateNs: state?.Ns ?? null,
          stateNr: state?.Nr ?? null,
          stateTheirPub: state?.theirRatchetPub ? (deps.b64 ? deps.b64(state.theirRatchetPub) : null) : null
        }, { level: 'log' });
        recordDrDecryptFailurePayload({
          conversationId: convId,
          peerAccountDigest: peerKey,
          tokenB64,
          packet,
          raw: job?.raw || job,
          reason: msg,
          state,
          messageId: messageId || job?.messageId || job?.raw?.id || null
        });
      } catch (logErr) {
        logDrCore('decrypt:fail-log-error', { conversationId: convId, error: logErr?.message || String(logErr) });
      }
      deadLetters.push({
        conversationId: convId,
        messageId: messageId || job?.messageId || job?.raw?.id || null,
        counter: packet?.counter ?? header?.n ?? null,
        drState: trackState && state ? { Ns: state.Ns, Nr: state.Nr, PN: state.PN } : null,
        msgType: msgTypeLabel || null,
        kind: semantic.kind,
        subtype: semantic.subtype,
        control: controlLike,
        error: msg
      });
      const failKey = `${conversationId}::${peerKey}::${peerDeviceForMessage || 'unknown-device'}`;
      const nextFail = (drFailureCounter.get(failKey) || 0) + 1;
      drFailureCounter.set(failKey, nextFail);
      if (nextFail >= 3) {
        deps.clearDrState(
          { peerAccountDigest: peerKey, peerDeviceId },
          { __drDebugTag: 'web/src/app/features/messages.js:1381:handleInboxJob:decrypt-fail-reset' }
        );
        drFailureCounter.delete(failKey);
        throw new Error('DR 解密連續失敗已重置會話，請重新同步好友或重新建立邀請');
      }
      if (err && typeof err === 'object') {
        err.__controlMessage = controlLike;
        err.__msgType = msgTypeLabel || null;
        err.__messageId = failedMessageId || null;
        err.__semanticKind = semantic.kind;
        err.__semanticSubtype = semantic.subtype;
      }
      throw err;
    }
  };

  for (const raw of sortedItems) {
    const msgTs = toMessageTimestamp(raw);
    const headerJson = raw?.header_json || raw?.headerJson || (raw?.header ? JSON.stringify(raw.header) : null);
    const ciphertextB64 = raw?.ciphertext_b64 || raw?.ciphertextB64 || null;
    let headerForKey = raw?.header || null;
    if (!headerForKey && typeof headerJson === 'string') {
      try { headerForKey = JSON.parse(headerJson); } catch {}
    }
    const serverMessageId = toMessageId(raw);
    if (!serverMessageId) {
      throw new Error('messageId missing from fetched item');
    }
    const stateKey = buildStateKey({ conversationId, peerKey, peerDeviceId: peerDevice });
    const fetchSenderDigest = raw?.senderAccountDigest || raw?.sender_digest || null;
    const fetchSenderDeviceId = raw?.senderDeviceId || raw?.sender_device_id || (headerForKey?.meta?.senderDeviceId || headerForKey?.meta?.sender_device_id) || null;
    logMsgEvent('fetch:item', {
      conversationId,
      direction: 'incoming',
      messageId: serverMessageId,
      serverMessageId,
      stateKey,
      senderDigest: fetchSenderDigest,
      senderDeviceId: fetchSenderDeviceId
    });
    const cachedState = decryptFailMessageCache.get(serverMessageId);
    if (cachedState && cachedState === stateKey) {
      logSkipLine({
        direction: 'incoming',
        gate: 'messageFailCache',
        conversationId,
        serverMessageId,
        messageId: serverMessageId,
        stateKey,
        senderDigest: fetchSenderDigest,
        senderDeviceId: fetchSenderDeviceId
      });
      continue;
    }
    if (cachedState && cachedState !== stateKey) {
      decryptFailMessageCache.delete(serverMessageId);
    }
    const messageId = serverMessageId;
    const packet = { header_json: headerJson, ciphertext_b64: ciphertextB64, counter: raw?.counter ?? raw?.n ?? null };
    const job = await enqueueInboxJob({
      conversationId,
      payloadEnvelope: packet,
      raw,
      messageId,
      createdAt: Number.isFinite(msgTs) ? msgTs : null,
      tokenB64,
      peerAccountDigest: peerKey,
      cursorTs
    });
    logMsgEvent('enqueue', {
      direction: 'incoming',
      conversationId,
      serverMessageId,
      messageId: job?.messageId || messageId,
      stateKey,
      senderDigest: fetchSenderDigest,
      senderDeviceId: fetchSenderDeviceId,
      jobId: job?.jobId || null,
      state: job?.state || null,
      ts: Number.isFinite(msgTs) ? msgTs : null
    });
  }

  await processInboxForConversation({
      conversationId,
    handler: async (job) => {
      try {
        if (drDebug) {
          logDrCore('inbox:process-job', {
            jobId: job?.jobId || null,
            conversationId,
            messageId: job?.messageId || null,
            createdAt: job?.createdAt || null
          }, { level: 'log', force: true });
        }
        await handleInboxJob(job);
      } catch (err) {
        const semanticKind = err?.__semanticKind || null;
        const semanticSubtype = err?.__semanticSubtype || null;
        const skipDeadLetter = !!err?.__controlMessage;
        if (!skipDeadLetter) {
          const controlFlag = semanticKind ? semanticKind !== SEMANTIC_KIND.USER_MESSAGE : !!err?.__controlMessage;
          deadLetters.push({
            jobId: job?.jobId,
            conversationId,
            messageId: job?.messageId,
            msgType: err?.__msgType || null,
            kind: semanticKind,
            subtype: semanticSubtype,
            control: controlFlag,
            error: err?.message || String(err)
          });
        }
        if (preSnapshot && shouldTrackState) {
          deps.clearDrState(
            { peerAccountDigest: peerKey, peerDeviceId },
            { __drDebugTag: 'web/src/app/features/messages.js:1442:processInboxForConversation:dead-letter-reset' }
          );
          try {
            deps.restoreDrStateFromSnapshot?.({ peerAccountDigest: peerKey, peerDeviceId, snapshot: preSnapshot, force: true });
          } catch {
            /* ignore restore errors */
          }
        }
        throw err;
      }
    }
  });

  return {
    items: out,
    nextCursorTs,
    nextCursor,
    hasMoreAtCursor,
    errors: errs,
    deadLetters,
    receiptUpdates: Array.from(receiptUpdates)
  };
  } finally {
    secureFetchLocks.delete(conversationId);
  }
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

export function markMessagesProcessedForUi(conversationId, messageIds = [], maxEntries = 200) {
  if (!conversationId || !Array.isArray(messageIds)) return;
  for (const id of messageIds) {
    if (typeof id === 'string' && id.trim().length) {
      markMessageProcessed(conversationId, id.trim(), maxEntries);
    }
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
  const existing = map.get(messageId);
  if (existing?.read) return false;
  map.set(messageId, { read: true, ts: ts && Number.isFinite(ts) ? ts : null });
  persistReceipts();
  recordMessageDelivered(conversationId, messageId, ts);
  return true;
}

function maybeSendReadReceipt(conversationId, peerAccountDigest, peerDeviceId, messageId) {
  // Temporarily disabled to reduce noise while investigating core decrypt issues.
  return;
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

function maybeSendDeliveryReceipt({ conversationId, peerAccountDigest, messageId, tokenB64, peerDeviceId }) {
  // Temporarily disabled to reduce noise while investigating core decrypt issues.
  return;
}
