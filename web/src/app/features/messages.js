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
  getMkRaw as storeGetMkRaw,
  ensureDeviceId as storeEnsureDeviceId
} from '../core/store.js';
import {
  persistDrSnapshot as sessionPersistDrSnapshot,
  snapshotDrState as sessionSnapshotDrState,
  cloneDrStateHolder as sessionCloneDrStateHolder
} from './dr-session.js';
import {
  sessionStore,
  restoreOfflineDecryptCursorStore,
  persistOfflineDecryptCursorStore,
  restorePendingVaultPuts,
  persistPendingVaultPuts
} from '../ui/mobile/session-store.js';
import { listReadyContacts } from '../ui/mobile/contact-core-store.js';
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
  appendBatch as timelineAppendBatch,
  clearConversation as clearTimelineConversation
} from './timeline-store.js';
import { enqueueInboxJob, processInboxForConversation } from './queue/inbox.js';
import { MessageKeyVault } from './message-key-vault.js';
import {
  OFFLINE_CATCHUP_CONVERSATION_LIMIT,
  OFFLINE_CATCHUP_MESSAGE_LIMIT,
  PENDING_VAULT_PUT_QUEUE_LIMIT,
  PENDING_VAULT_PUT_RETRY_MAX,
  PENDING_VAULT_PUT_RETRY_INTERVAL_MS,
  OFFLINE_SYNC_LOG_CAP
} from './messages-sync-policy.js';
import { toU8Strict } from '../../shared/utils/u8-strict.js';
import { logDrCore, logMsgEvent, shouldLogDrCore } from '../lib/logging.js';
import { log, logForensicsEvent, logCapped } from '../core/log.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';

const FETCH_LOG_ENABLED = DEBUG.fetchNoise === true;
const QUEUE_LOG_ENABLED = DEBUG.queueNoise === true;

const defaultDeps = {
  listSecureMessages: apiListSecureMessages,
  drDecryptText: cryptoDrDecryptText,
  buildDrAadFromHeader: cryptoBuildDrAadFromHeader,
  drState: storeDrState,
  getAccountDigest: storeGetAccountDigest,
  persistDrSnapshot: sessionPersistDrSnapshot,
  snapshotDrState: sessionSnapshotDrState,
  cloneDrStateHolder: sessionCloneDrStateHolder,
  getMkRaw: storeGetMkRaw,
  b64UrlToBytes: uiB64UrlToBytes,
  b64u8: naclB64u8,
  b64: naclB64,
  saveEnvelopeMeta: mediaSaveEnvelopeMeta,
  ensureSecureConversationReady: managerEnsureSecureConversationReady,
  ensureDrReceiverState: managerEnsureDrReceiverState,
  clearDrState: storeClearDrState,
  wsSend: null
};

const deps = { ...defaultDeps };

export function __setMessagesTestOverrides(overrides = {}) {
  Object.assign(deps, overrides);
}

export function __resetMessagesTestOverrides() {
  Object.assign(deps, defaultDeps);
}

export function setMessagesWsSender(fn) {
  deps.wsSend = typeof fn === 'function' ? fn : null;
}

const decoder = new TextDecoder();
const secureFetchBackoff = new Map();
const secureFetchLocks = new Map(); // conversationId -> lock token
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
const NON_REPLAYABLE_SIGNAL_TYPES = new Set([
  CONTROL_MESSAGE_TYPES.READ_RECEIPT,
  CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT
]);
const OFFLINE_SYNC_SOURCES = new Set([
  'login',
  'ws_reconnect',
  'pull_to_refresh',
  'enter_conversation',
  'visibility_resume',
  'pageshow_resume'
]);
const OFFLINE_SYNC_PREFIX_LEN = 8;
const OFFLINE_SYNC_SUFFIX_LEN = 4;
const OFFLINE_SYNC_ERROR_MAX = 120;

function slicePrefix(value, len = OFFLINE_SYNC_PREFIX_LEN) {
  if (value === null || typeof value === 'undefined') return null;
  const str = String(value);
  return str.length ? str.slice(0, len) : null;
}

function sliceSuffix(value, len = OFFLINE_SYNC_SUFFIX_LEN) {
  if (value === null || typeof value === 'undefined') return null;
  const str = String(value);
  return str.length ? str.slice(-len) : null;
}

function truncateErrorMessage(value, maxLen = OFFLINE_SYNC_ERROR_MAX) {
  const str = value ? String(value) : '';
  if (!str) return null;
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}...`;
}

function resolveErrorCode(err) {
  if (!err) return null;
  if (typeof err?.code === 'string' || typeof err?.code === 'number') return String(err.code);
  if (typeof err?.errorCode === 'string' || typeof err?.errorCode === 'number') return String(err.errorCode);
  if (typeof err?.status === 'number') return String(err.status);
  return null;
}

function normalizeHeaderCounter(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function vaultPutMessageKey(params = {}) {
  const mkRaw = typeof deps.getMkRaw === 'function' ? deps.getMkRaw() : null;
  return MessageKeyVault.putMessageKey({
    ...params,
    mkRaw
  });
}

async function vaultGetMessageKey(params = {}) {
  const mkRaw = typeof deps.getMkRaw === 'function' ? deps.getMkRaw() : null;
  return MessageKeyVault.getMessageKey({
    ...params,
    mkRaw
  });
}

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

function createSecureFetchLockToken(priority) {
  return {
    id: Symbol('secureFetchLock'),
    priority: priority === 'replay' ? 'replay' : 'live',
    cancelled: false,
    cancelReason: null
  };
}

function acquireSecureFetchLock(conversationId, priority = 'live') {
  const key = String(conversationId);
  const holder = secureFetchLocks.get(key);
  if (holder) {
    if (priority === 'replay' && holder.priority === 'live') {
      holder.cancelled = true;
      holder.cancelReason = 'yieldToReplay';
    } else {
      return { granted: false, holderPriority: holder.priority || 'live' };
    }
  }
  const token = createSecureFetchLockToken(priority);
  secureFetchLocks.set(key, token);
  return { granted: true, token };
}

function releaseSecureFetchLock(conversationId, token) {
  if (!conversationId || !token) return;
  const key = String(conversationId);
  const holder = secureFetchLocks.get(key);
  if (holder && holder.id === token.id) {
    secureFetchLocks.delete(key);
  }
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

function valueType(value) {
  return value === null || value === undefined ? 'null' : typeof value;
}

function sampleDigits(value, maxLen = 16) {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  return digits.slice(0, maxLen);
}

function sampleIdPrefix(value, maxLen = 8) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(0, maxLen);
}

function resolveMessageTimestampField(raw) {
  const candidates = [
    { field: 'created_at', value: raw?.created_at },
    { field: 'createdAt', value: raw?.createdAt },
    { field: 'ts', value: raw?.ts },
    { field: 'timestamp', value: raw?.timestamp },
    { field: 'meta.ts', value: raw?.meta?.ts }
  ];
  for (const candidate of candidates) {
    const n = Number(candidate.value);
    if (Number.isFinite(n) && n > 0) {
      return { field: candidate.field, value: candidate.value, result: Math.floor(n) };
    }
  }
  return { field: 'none', value: null, result: null };
}

function resolveMessageIdField(raw) {
  const candidates = [
    { field: 'id', value: raw?.id },
    { field: 'message_id', value: raw?.message_id },
    { field: 'messageId', value: raw?.messageId }
  ];
  for (const candidate of candidates) {
    if (typeof candidate.value === 'string' && candidate.value.length) {
      return { field: candidate.field, value: candidate.value, result: candidate.value };
    }
  }
  return { field: 'none', value: null, result: null };
}

function summarizeMessageIds(items = []) {
  const ids = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      const id = toMessageId(item)
        || (typeof item?.serverMessageId === 'string' && item.serverMessageId.length ? item.serverMessageId : null)
        || (typeof item?.server_message_id === 'string' && item.server_message_id.length ? item.server_message_id : null);
      if (id) ids.push(id);
    }
  }
  const idsCount = ids.length;
  const headIds = ids.slice(0, 3);
  const tailIds = idsCount > 3 ? ids.slice(-3) : ids.slice();
  return { idsCount, headIds, tailIds };
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
    prefetchedList = null,
    silent = false,
    priority = 'live'
  } = params;
  const mutateStateRaw = mutateState;
  const allowReplayRaw = mutateState === false ? true : allowReplay;
  const computedIsHistoryReplay = allowReplayRaw === true && mutateState === false;
  const sourceHint = prefetchedList
    ? 'FROM_LOCAL_OBJECT'
    : (typeof deps.listSecureMessages === 'function' ? 'FROM_D1_ITEM' : 'FROM_UNKNOWN');
  const replayCtx = {
    allowReplay: allowReplayRaw,
    mutateState: mutateStateRaw,
    computedIsHistoryReplay
  };
  const logReplayGateTrace = (where, payload = {}, ctx = replayCtx) => {
    if (!DEBUG.replay) return;
    const {
      conversationId: payloadConversationId,
      messageId,
      serverMessageId,
      ...rest
    } = payload || {};
    try {
      const ctxAllowReplay = ctx?.allowReplay;
      const ctxMutateState = ctx?.mutateState;
      const ctxComputed = ctx?.computedIsHistoryReplay;
      log({
        replayGateTrace: {
          where,
          conversationId: payloadConversationId ?? conversationId ?? null,
          messageId: messageId ?? null,
          serverMessageId: serverMessageId ?? null,
          allowReplayRaw: ctxAllowReplay,
          mutateStateRaw: ctxMutateState,
          computedIsHistoryReplay: ctxComputed,
          ...rest
        }
      });
    } catch {}
  };
  const logReplayEarlyReturn = (reason, extra = {}) => {
    try {
      log({
        replayEarlyReturn: {
          reason,
          conversationId: conversationId || null,
          allowReplay: !!allowReplay,
          mutateState: !!mutateState,
          priority: requestPriority,
          silent: !!silent,
          limit,
          ...extra
        }
      });
    } catch {}
  };
  if (DEBUG.replay) {
    log({
      probeReplay: {
        where: 'messages:listSecureAndDecrypt:enter',
        conversationId: conversationId || null,
        hasPeerDevice: !!peerDeviceId,
        allowReplay: !!allowReplay,
        mutateState: !!mutateState
      }
    });
  }
  if (!conversationId) throw new Error('conversationId required');
  const requestPriority = priority === 'replay' ? 'replay' : 'live';
  logReplayGateTrace('messages:listSecureAndDecrypt:enter', {
    silent: !!silent,
    priority: requestPriority,
    replay: requestPriority === 'replay'
  });
  const mkRawForReplay = typeof deps.getMkRaw === 'function' ? deps.getMkRaw() : null;
  if (!mkRawForReplay && (allowReplayRaw || requestPriority === 'replay' || computedIsHistoryReplay)) {
    const accountDigest = typeof deps.getAccountDigest === 'function' ? deps.getAccountDigest() : null;
    let deviceId = null;
    try {
      deviceId = typeof deps.ensureDeviceId === 'function' ? deps.ensureDeviceId() : null;
    } catch {}
    try {
      log({
        mkHardblockTrace: {
          sourceTag: 'messages:listSecureAndDecrypt',
          reason: 'mk_missing_replay_gate',
          serverHasMK: null,
          mkHash12: null,
          accountDigestSuffix4: accountDigest ? String(accountDigest).slice(-4) : null,
          deviceIdSuffix4: deviceId ? String(deviceId).slice(-4) : null,
          conversationId: conversationId || null,
          evidence: null
        }
      });
    } catch {}
    const err = new Error('MK 未解鎖/遺失，已硬阻擋（MK_MISSING_HARDBLOCK）');
    err.code = 'MK_MISSING_HARDBLOCK';
    throw err;
  }
  const buildEmptyResult = (errors = []) => ({
    items: [],
    nextCursorTs: null,
    nextCursor: null,
    hasMoreAtCursor: false,
    errors,
    deadLetters: [],
    receiptUpdates: [],
    serverItemCount: 0,
    replayStats: {
      decryptFail: 0,
      decryptOk: 0,
      messageKeyVaultMissing: 0,
      directionFilterSkips: 0,
      duplicateCounterSkips: 0,
      fetchedItems: 0,
      vaultPutIncomingOk: 0
    }
  });
  const replayCounters = {
    fetchedItems: 0,
    enqueuedJobs: 0,
    skipped_targetDeviceMissing: 0,
    skipped_directionFilter: 0,
    skipped_duplicateCounter: 0,
    skipped_processedContactShare: 0,
    skipped_nonReplayableSignal: 0,
    skipped_securePending: 0,
    decryptOk: 0,
    decryptFail: 0,
    messageKeyVaultMissing: 0,
    vaultPutIncomingOk: 0,
    timelineAppendCount: 0
  };
  const uniqueAppendedIds = new Set();
  let replaySummaryLogged = false;
  const emitReplaySummary = (extra = {}) => {
    if (replaySummaryLogged) return;
    replaySummaryLogged = true;
    try {
      log({
        replaySummary: {
          ...replayCounters,
          uniqueMessageIdsAppended: uniqueAppendedIds.size,
          ...extra
        },
        conversationId,
        stage: 'listSecureAndDecrypt'
      });
    } catch {}
  };
  if (FETCH_LOG_ENABLED) {
    logMsgEvent('fetch:start', {
      conversationId,
      direction: 'incoming',
      peerAccountDigest,
      peerDeviceId,
      hasToken: !!tokenB64,
      source: params?.__debugSource || null
    });
  }
  if (tombstonedConversations.has(String(conversationId))) {
    logReplayEarlyReturn('tombstone');
    emitReplaySummary();
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
    logReplayEarlyReturn('missingPeerIdentity', {
      peerAccountDigest,
      peerDeviceId: resolvedPeerDeviceId || peerDeviceId || null
    });
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
  const readyCoreEntries = Array.isArray(listReadyContacts()) ? listReadyContacts() : [];
  const mkReadyForPendingBypass = !!mkRawForReplay;
  const shouldBypassSecurePending = (deviceId, conversationIdOverride = null) => {
    if (!mkReadyForPendingBypass || !readyCoreEntries.length) return false;
    const convKey = conversationIdOverride != null ? String(conversationIdOverride) : (conversationId ? String(conversationId) : null);
    const keyForDevice = deviceId
      ? storeNormalizePeerIdentity({ peerAccountDigest: peerKey, peerDeviceId: deviceId }).key
      : null;
    for (const entry of readyCoreEntries) {
      const entryConvId = entry?.conversationId || entry?.conversation?.conversation_id || null;
      const entryToken = entry?.conversationToken || entry?.conversation?.token_b64 || null;
      if (!entry?.isReady || !entryConvId || !entryToken) continue;
      if (convKey && String(entryConvId) === convKey) return true;
      if (keyForDevice) {
        const entryKey = entry?.peerKey
          || storeNormalizePeerIdentity({ peerAccountDigest: entry?.peerAccountDigest, peerDeviceId: entry?.peerDeviceId }).key;
        if (entryKey && entryKey === keyForDevice) return true;
      }
    }
    return false;
  };
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
  const lockAttempt = acquireSecureFetchLock(conversationId, requestPriority);
  if (!lockAttempt?.granted || !lockAttempt.token) {
    const reason = requestPriority === 'live' ? 'yieldToReplay' : 'secureFetchLock';
    logReplayEarlyReturn(reason, { holderPriority: lockAttempt?.holderPriority || null });
    logCapped('secureFetchInFlightTrace', {
      conversationId,
      reason,
      requestPriority,
      holderPriority: lockAttempt?.holderPriority || null
    }, 5);
    emitReplaySummary();
    return buildEmptyResult(['同步進行中，請稍後再試']);
  }
  const lockToken = lockAttempt.token;
  const buildYieldResult = () => buildEmptyResult(requestPriority === 'live' ? ['同步進行中，請稍後再試'] : []);
  const shouldYieldToReplay = (stage = null) => {
    if (!lockToken?.cancelled) return false;
    logReplayEarlyReturn('yieldToReplay', {
      stage,
      cancelReason: lockToken.cancelReason || null,
      priority: requestPriority
    });
    return true;
  };
  try {
  const peerRef = {
    peerAccountDigest: identity.accountDigest || peerKey,
    peerDeviceId: peerDevice
  };
  const selfDeviceId = typeof storeEnsureDeviceId === 'function' ? storeEnsureDeviceId() : null;

  const now = Date.now();
  const backoffUntil = secureFetchBackoff.get(conversationId) || 0;
  if (now < backoffUntil) {
    logReplayEarlyReturn('backoff', { backoffUntil });
    return {
      items: [],
      nextCursorTs: null,
      errors: ['訊息服務暫時無法使用，請稍後再試。']
    };
  }
  if (shouldYieldToReplay('beforeFetch')) {
    return buildYieldResult();
  }

  const out = [];
  const errs = [];
  const receiptUpdates = new Set();
  const deadLetters = [];
  const timelineBatch = [];
  let timelineBatchCommitted = false;
  let timelineBatchResult = { appendedCount: 0, skippedCount: 0, appendedEntries: [] };
  const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
  const commitTimelineBatch = () => {
    if (timelineBatchCommitted) return timelineBatchResult;
    timelineBatchCommitted = true;
    const batchSize = timelineBatch.length;
    if (!batchSize) return timelineBatchResult;
    const appendStart = nowMs();
    const appendResult = timelineAppendBatch(timelineBatch, { directionalOrder: 'chronological' });
    const appendEnd = nowMs();
    const appendedEntries = Array.isArray(appendResult?.appendedEntries) ? appendResult.appendedEntries : [];
    const appendedCount = Number.isFinite(appendResult?.appendedCount)
      ? Number(appendResult.appendedCount)
      : appendedEntries.length;
    const skippedCount = Number.isFinite(appendResult?.skippedCount)
      ? Number(appendResult.skippedCount)
      : Math.max(0, batchSize - appendedCount);
    const tookMs = Math.max(0, Math.round(appendEnd - appendStart));

    replayCounters.timelineAppendCount += appendedCount;
    for (const entry of appendedEntries) {
      const appendedId = entry?.messageId || entry?.id || null;
      if (appendedId) uniqueAppendedIds.add(appendedId);
      try {
        console.info('[msg] ' + JSON.stringify({
          event: 'timeline:append',
          conversationId: entry?.conversationId || conversationId || null,
          messageId: entry?.messageId || entry?.id || null,
          direction: entry?.direction || null,
          msgType: entry?.msgType || null,
          ts: entry?.ts || null
        }));
      } catch {
        /* ignore */
      }
      logForensicsEvent('UI_APPEND', {
        conversationId: entry?.conversationId || conversationId || null,
        messageId: entry?.messageId || entry?.id || null,
        direction: entry?.direction || null,
        msgType: entry?.msgType || null,
        ts: entry?.ts || null
      });
    }

    logCapped('batchAppendTrace', {
      conversationId: conversationId || null,
      batchSize,
      mode: computedIsHistoryReplay ? 'replay' : 'live',
      appendedCount,
      skippedCount,
      tookMs
    }, 5);

    timelineBatchResult = { appendedCount, skippedCount, appendedEntries };
    return timelineBatchResult;
  };
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
  if (shouldYieldToReplay('afterFetch')) {
    return buildYieldResult();
  }
  try {
    log({
      replayFetchResult: {
        conversationId: conversationId || null,
        itemsLength: Array.isArray(items) ? items.length : null,
        serverItemCount: serverItemCount ?? null,
        nextCursorTs: nextCursor?.ts ?? nextCursorTs ?? null,
        nextCursorId: nextCursor?.id ?? null,
        errorsLength: errs.length
      }
    });
  } catch {}
  try {
    const summary = summarizeMessageIds(items);
    logForensicsEvent('FETCH_LIST', {
      conversationId: conversationId || null,
      serverItemCount: serverItemCount ?? null,
      ...summary,
      source: 'listSecureAndDecrypt'
    });
  } catch {}
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
  replayCounters.fetchedItems = Array.isArray(sortedItems) ? sortedItems.length : 0;
  const shouldTrackState = mutateState !== false;
  const stateByDevice = new Map();
  const secureStatusByDevice = new Map();
  const ensuredConversations = new Set();
  const replayGateTraceSampleLimit = 3;
  let replayGateTraceSampleCount = 0;
  const directionFilterSampleLimit = 3;
  let directionFilterSampleCount = 0;
  const decryptFailSampleLimit = 3;
  let decryptFailSampleCount = 0;
  const duplicateCounterSampleLimit = 3;
  let duplicateCounterSampleCount = 0;
  const historyReplayTraceLimit = 3;
  let historyReplayTraceCount = 0;
  const replayInvariantViolationLimit = 3;
  let replayInvariantViolationCount = 0;
  const replayDrPathBlockedLimit = 3;
  let replayDrPathBlockedCount = 0;
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
    if (FETCH_LOG_ENABLED) {
      logMsgEvent('fetch:batch', {
        direction: 'incoming',
        conversationId,
        serverItemCount,
        items: fetchIds
      });
    }
  } catch {}

  const getPeerRef = (deviceId) => ({
    peerAccountDigest: identity.accountDigest || peerKey,
    peerDeviceId: deviceId
  });

  const getStateForDevice = (deviceId) => {
    if (!deviceId) throw new Error('peerDeviceId required for DR state');
    const cached = stateByDevice.get(deviceId);
    if (cached) return cached;
    const base = deps.drState(getPeerRef(deviceId));
    const holder = shouldTrackState ? base : (deps.cloneDrStateHolder?.(base) || base);

    stateByDevice.set(deviceId, holder);
    return holder;
  };

  const ensureReceiverStateReady = (deviceId) => {
    const current = getStateForDevice(deviceId);
    if (!hasUsableDrState(current)) {
      const err = new Error('DR state unavailable for conversation');
      err.code = 'DR_STATE_UNAVAILABLE';
      throw err;
    }
    return current;
  };

  const ensureConversationReadyForDevice = async (deviceId, conversationIdOverride = null) => {
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
    let status = statusInfo?.status || null;
    if (status === SECURE_CONVERSATION_STATUS.PENDING) {
      const convIdForBypass = conversationIdOverride != null ? conversationIdOverride : conversationId;
      if (shouldBypassSecurePending(deviceId, convIdForBypass)) {
        status = SECURE_CONVERSATION_STATUS.READY;
      }
    }
    secureStatusByDevice.set(deviceId, status);
    if (status === SECURE_CONVERSATION_STATUS.PENDING) {
      return { status };
    }
    ensuredConversations.add(key);
    return { status };
  };

  // 預先確保初始 peerDevice 的會話就緒與 state 存在（live only）。
  if (peerDevice && !computedIsHistoryReplay) {
    const initialStatus = await ensureConversationReadyForDevice(peerDevice, conversationId);
    if (initialStatus?.status === SECURE_CONVERSATION_STATUS.PENDING) {
      replayCounters.skipped_securePending += 1;
      logReplayEarlyReturn('securePending', { peerDeviceId: peerDevice });
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

  const yieldToReplayError = new Error('yieldToReplay');
  yieldToReplayError.__yieldToReplay = true;
  const handleInboxJob = async (job, ctx) => {
    const replayCtxLocal = ctx && typeof ctx === 'object' ? ctx : null;
    const allowReplayRaw = replayCtxLocal?.allowReplay;
    const mutateStateRaw = replayCtxLocal?.mutateState;
    const computedIsHistoryReplay = replayCtxLocal?.computedIsHistoryReplay;
    if (typeof mutateStateRaw !== 'boolean' || typeof computedIsHistoryReplay !== 'boolean') {
      if (replayInvariantViolationCount < replayInvariantViolationLimit) {
        replayInvariantViolationCount += 1;
        try {
          log({
            replayInvariantViolation: {
              where: 'handleInboxJob',
              reason: 'ctx_invalid',
              conversationId: conversationId || null,
              messageId: job?.messageId || null,
              allowReplayRaw: typeof allowReplayRaw === 'boolean' ? allowReplayRaw : null,
              mutateStateRaw: typeof mutateStateRaw === 'boolean' ? mutateStateRaw : null,
              computedIsHistoryReplay: typeof computedIsHistoryReplay === 'boolean' ? computedIsHistoryReplay : null
            }
          });
        } catch {}
      }
      throw new Error('REPLAY_CTX_INVALID');
    }
    if (mutateStateRaw === false && computedIsHistoryReplay !== true) {
      if (replayInvariantViolationCount < replayInvariantViolationLimit) {
        replayInvariantViolationCount += 1;
        try {
          log({
            replayInvariantViolation: {
              where: 'handleInboxJob',
              allowReplayRaw,
              mutateStateRaw,
              computedIsHistoryReplay
            }
          });
        } catch {}
      }
      throw new Error('REPLAY_INVARIANT_VIOLATION');
    }
    const trackState = mutateStateRaw !== false;
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
    let targetDeviceId = null;
    let stateKey = null;
    let messageId = null;
    let headerCounter = null;
    let serverMessageId = null;
    let senderDigest = null;
    let direction = 'unknown';
    let peerDeviceForMessage = null;
    const logDeliverySkip = (gate, extra = {}) => {
      if (gate === 'targetDeviceMissing') replayCounters.skipped_targetDeviceMissing += 1;
      else if (gate === 'directionFilter') replayCounters.skipped_directionFilter += 1;
      else if (gate === 'duplicateCounter') replayCounters.skipped_duplicateCounter += 1;
      else if (gate === 'processedContactShare') replayCounters.skipped_processedContactShare += 1;
      else if (gate === 'securePending') replayCounters.skipped_securePending += 1;
      if (gate === 'directionFilter' && directionFilterSampleCount < directionFilterSampleLimit) {
        directionFilterSampleCount += 1;
        if (DEBUG.replay) {
          try {
            log({
              replaySkipSample: {
                skipReason: 'directionFilter',
                conversationId: convId || conversationId || null,
                serverMessageId: serverMessageId || null,
                messageId: messageId || null,
                computedIsHistoryReplay,
                selfDeviceId: selfDeviceId || null,
                senderDeviceId: senderDeviceId || null,
                targetDeviceId: targetDeviceId || null,
                directionComputed: direction || 'unknown',
                isSelfSenderByDevice: !!(senderDeviceId && selfDeviceId && senderDeviceId === selfDeviceId),
                deviceMatchesSelf: !!(targetDeviceId && selfDeviceId && targetDeviceId === selfDeviceId)
              }
            });
          } catch {}
        }
      }
      if (gate === 'duplicateCounter' && duplicateCounterSampleCount < duplicateCounterSampleLimit) {
        duplicateCounterSampleCount += 1;
        if (DEBUG.replay) {
          const sampleCounter = Number.isFinite(Number(extra?.counter)) ? Number(extra.counter) : 0;
          const sampleTransport = Number.isFinite(Number(extra?.transportCounter))
            ? Number(extra.transportCounter)
            : sampleCounter;
          const sampleNr = Number.isFinite(Number(extra?.Nr)) ? Number(extra.Nr) : 0;
          const sampleNs = Number.isFinite(Number(extra?.Ns)) ? Number(extra.Ns) : 0;
          try {
            log({
              duplicateCounterSample: {
                conversationId: convId || conversationId || null,
                serverMessageId: serverMessageId || null,
                messageId: messageId || null,
                counter: sampleCounter,
                transportCounter: sampleTransport,
                Nr: sampleNr,
                Ns: sampleNs,
                computedIsHistoryReplay,
                peerDeviceId: peerDeviceForMessage || null,
                stateKey: stateKey || null
              }
            });
            log({
              replaySkipSample: {
                skipReason: 'duplicateCounter',
                conversationId: convId || conversationId || null,
                serverMessageId: serverMessageId || null,
                messageId: messageId || null,
                counter: sampleCounter,
                transportCounter: sampleTransport,
                Nr: sampleNr,
                Ns: sampleNs,
                computedIsHistoryReplay
              }
            });
          } catch {}
        }
      }
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
    const handleDecryptedMessage = async (text, messageKeyB64) => {
      decryptFailMessageCache.delete(messageId);
      let vaultPutStatus = null;
      if (!computedIsHistoryReplay) {
        const vaultMsgType = payloadMsgType || msgTypeForDecrypt || rawMsgType || null;
        if (!messageKeyB64) {
          throw new Error('message key missing');
        }
        try {
          await vaultPutMessageKey({
            conversationId: convId || conversationId || null,
            messageId,
            senderDeviceId,
            targetDeviceId: targetDeviceId || null,
            direction,
            msgType: vaultMsgType,
            messageKeyB64,
            headerCounter
          });
          vaultPutStatus = 'ok';
        } catch (err) {
          try {
            log({
              mkHardblockTrace: {
                sourceTag: 'messages:handleDecryptedMessage',
                reason: 'vault_put_failed',
                conversationId: convId || conversationId || null,
                messageId: messageId || null,
                senderDeviceId: senderDeviceId || null,
                targetDeviceId: targetDeviceId || null,
                direction: direction || null,
                msgType: vaultMsgType,
                error: err?.message || 'messageKeyVaultPutFailed'
              }
            });
          } catch {}
          if (direction === 'incoming') {
            vaultPutStatus = 'pending';
            enqueuePendingVaultPut({
              conversationId: convId || conversationId || null,
              messageId,
              senderDeviceId,
              targetDeviceId: targetDeviceId || null,
              direction,
              msgType: vaultMsgType,
              messageKeyB64,
              headerCounter
            }, err);
          } else {
            throw err;
          }
        }
      }
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
      logForensicsEvent('DECRYPT_OK', {
        conversationId: convId || conversationId || null,
        messageId: messageId || null,
        direction: direction || null,
        msgType: payloadMsgType || msgTypeForDecrypt || null,
        senderDeviceId: senderDeviceId || null,
        targetDeviceId: targetDeviceId || null,
        headerCounter: Number.isFinite(headerCounter) ? headerCounter : null
      });
      replayCounters.decryptOk += 1;
      if (direction === 'incoming' && vaultPutStatus === 'ok') {
        replayCounters.vaultPutIncomingOk += 1;
      }

      const semantic = classifyDecryptedPayload(text, { meta, header });
      logSemanticClassification({
        conversationId: convId,
        messageId,
        kind: semantic.kind,
        subtype: semantic.subtype
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

      if (semantic.kind === SEMANTIC_KIND.IGNORABLE) {
        logSemanticIgnorableOnce({
          conversationId: convId,
          messageId,
          subtype: semantic.subtype
        });
        return;
      }

      if (semantic.kind === SEMANTIC_KIND.CONTROL_STATE) {
        if (computedIsHistoryReplay) {
          try {
            log({
              replaySkipSample: {
                skipReason: 'controlSideEffectsInReplay',
                conversationId: convId || null,
                messageId: messageId || null,
                serverMessageId: serverMessageId || null,
                subtype: semantic.subtype || null
              }
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
          logCapped('deliveryAckTrace', {
            stage: 'received',
            ackedMessageId: messageObj.targetMessageId,
            conversationId: convId || null
          });
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
          peerDeviceId: messageObj.peerDeviceId || null,
          isHistoryReplay: computedIsHistoryReplay,
          silent: !!silent
        };
        const entryMessageId = timelineEntry.messageId;
        const entryTs = timelineEntry.ts;
        const idRawType = entryMessageId === null ? 'null' : typeof entryMessageId;
        const tsRawType = entryTs === null ? 'null' : typeof entryTs;
        const hasId = entryMessageId !== null && entryMessageId !== undefined
          && (typeof entryMessageId !== 'string' || entryMessageId.trim().length > 0);
        const hasTs = entryTs !== null && entryTs !== undefined;
        const idValid = typeof entryMessageId === 'string' && entryMessageId.trim().length > 0;
        const tsValid = typeof entryTs === 'number' && Number.isFinite(entryTs)
          && Number.isInteger(entryTs) && entryTs > 0;
        let reasonCode = null;
        if (!idValid) {
          reasonCode = hasId ? 'INVALID_ID' : 'MISSING_ID';
        } else if (!tsValid) {
          reasonCode = hasTs ? 'INVALID_TS' : 'MISSING_TS';
        }
        if (reasonCode) {
          const rawCreatedAt = raw?.created_at ?? raw?.createdAt ?? null;
          const rawIdCandidate = raw?.id
            ?? raw?.message_id
            ?? raw?.messageId
            ?? raw?.serverMessageId
            ?? raw?.server_message_id
            ?? null;
          const rawMetaTs = meta?.ts ?? raw?.meta?.ts ?? null;
          const rawHeaderN = header?.n ?? raw?.n ?? null;
          logCapped('messageItemSchemaSourceTrace', {
            stage: 'P1_SOURCE',
            conversationId: convId || null,
            reasonCode,
            rawCreatedAtType: valueType(rawCreatedAt),
            rawCreatedAtValueSample: sampleDigits(rawCreatedAt),
            rawIdType: valueType(rawIdCandidate),
            rawIdValueSample: sampleIdPrefix(rawIdCandidate),
            rawMetaTsType: valueType(rawMetaTs),
            rawMetaTsValueSample: sampleDigits(rawMetaTs),
            rawHeaderNType: valueType(rawHeaderN),
            rawHeaderNValueSample: sampleDigits(rawHeaderN),
            rawDirection: direction || null,
            rawMsgType: rawMsgType || null,
            rawHasHeaderJson: !!(raw?.header_json || raw?.headerJson || raw?.header),
            sourceHint
          }, 5);
          logCapped('messageItemSchemaDropTrace', {
            conversationId: convId || null,
            reasonCode,
            hasId,
            hasTs,
            tsRawType,
            idRawType,
            sampleIdPrefix8: idValid ? entryMessageId.trim().slice(0, 8) : null,
            sampleTs: hasTs ? entryTs : null,
            stage: 'P1_MESSAGES'
          }, 5);
        } else {
          timelineBatch.push(timelineEntry);
        }
        out.push(messageObj);
        if (messageObj.direction === 'incoming' && messageObj.id) {
          const shouldSendDeliveryReceipt = !computedIsHistoryReplay && vaultPutStatus === 'ok';
          const shouldSendVaultAckWs = shouldTrackState && !computedIsHistoryReplay && vaultPutStatus === 'ok';
          const receiptGateReason = computedIsHistoryReplay
            ? 'REPLAY'
            : (vaultPutStatus === 'ok'
              ? 'VAULT_OK'
              : (vaultPutStatus === 'pending' ? 'VAULT_PENDING' : 'VAULT_UNKNOWN'));
          logCapped('receiverDeliveryReceiptGateTrace', {
            conversationId: convId || null,
            messageId: messageObj.id || null,
            peerDeviceId: peerDeviceForMessage || null,
            vaultPutStatus: vaultPutStatus || null,
            computedIsHistoryReplay: !!computedIsHistoryReplay,
            decision: shouldSendDeliveryReceipt ? 'send' : 'skip',
            reasonCode: receiptGateReason
          }, 5);
          if (shouldSendDeliveryReceipt) {
            maybeSendDeliveryReceipt({
              conversationId: convId,
              peerAccountDigest: peerKey,
              messageId: messageObj.id,
              tokenB64,
              peerDeviceId: peerDeviceForMessage,
              vaultPutStatus
            });
          }
          if (shouldSendVaultAckWs) {
            const senderAccountDigest = (senderDigest && senderDigest.length === 64)
              ? senderDigest
              : (peerAccountDigestNormalized && peerAccountDigestNormalized.length === 64 ? peerAccountDigestNormalized : null);
            const receiverAccountDigest = selfDigest && selfDigest.length === 64 ? selfDigest : null;
            const senderDevice = typeof senderDeviceId === 'string' && senderDeviceId.trim().length ? senderDeviceId.trim() : null;
            const receiverDevice = typeof selfDeviceId === 'string' && selfDeviceId.trim().length ? selfDeviceId.trim() : null;
            if (senderAccountDigest && receiverAccountDigest && senderDevice && receiverDevice) {
              maybeSendVaultAckWs({
                conversationId: convId,
                messageId: messageObj.id,
                senderAccountDigest,
                senderDeviceId: senderDevice,
                receiverAccountDigest,
                receiverDeviceId: receiverDevice
              });
            }
          }
          if (!computedIsHistoryReplay && sendReadReceipt) {
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
    };
    if (shouldYieldToReplay('inbox-handler')) {
      throw yieldToReplayError;
    }
    let preDecryptSnapshot = null;
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
      headerCounter = normalizeHeaderCounter(header?.n ?? packet?.counter ?? null);
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
      messageTs = Number.isFinite(msgTs) ? Math.floor(msgTs) : null;
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
      targetDeviceId = targetDeviceRaw ? String(targetDeviceRaw) : null;
      let targetDigest = targetDigestRaw ? String(targetDigestRaw).toUpperCase() : null;
      const deviceMatchesSelf = !!(selfDeviceId && targetDeviceId && targetDeviceId === selfDeviceId);
      const isSelfSender = !!(selfDigest && senderDigest && senderDigest === selfDigest);
      const senderMatchesSelfDevice = !!(senderDeviceId && selfDeviceId && senderDeviceId === selfDeviceId);
      const isHistoryReplay = computedIsHistoryReplay;
      const replaySelfSender = isHistoryReplay && senderMatchesSelfDevice;
      const treatAsSelfSender = isSelfSender || replaySelfSender;

      if (deviceMatchesSelf) {
        direction = 'incoming';
        if (!targetDigest && selfDigest) targetDigest = selfDigest;
      } else if (treatAsSelfSender) {
        direction = 'outgoing';
      } else {
        direction = 'incoming';
      }

      peerDeviceForMessage = senderDeviceId || peerDevice;
      if (isHistoryReplay && treatAsSelfSender && targetDeviceId) {
        peerDeviceForMessage = targetDeviceId;
      }
      if (DEBUG.replay && replayGateTraceSampleCount < replayGateTraceSampleLimit) {
        replayGateTraceSampleCount += 1;
        logReplayGateTrace('messages:handleInboxJob:enter', {
          conversationId: convId || conversationId || null,
          messageId,
          serverMessageId,
          directionComputed: direction || 'unknown'
        }, replayCtxLocal);
      }

      if (QUEUE_LOG_ENABLED) {
        logMsgEvent('device-check', {
          conversationId: packetConversationId,
          messageId,
          senderDeviceId,
          targetDeviceId,
          selfDeviceId,
          peerDeviceId: peerDeviceForMessage || null,
          directionComputed: direction
        });
      }
      if (selfDeviceId && peerDevice && selfDeviceId === peerDevice) {
        throw new Error('SELF_DEVICE_ID_CORRUPTED: selfDeviceId equals peerDeviceId');
      }
      if (QUEUE_LOG_ENABLED) {
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
      }
      if (!targetDeviceId && !computedIsHistoryReplay) {
        logDeliverySkip('targetDeviceMissing', { targetDeviceId, selfDeviceId, senderDeviceId });
        try {
          log({
            mkHardblockTrace: {
              sourceTag: 'messages:handleInboxJob',
              reason: 'target_device_missing',
              conversationId: convId || conversationId || null,
              messageId: messageId || null,
              serverMessageId: serverMessageId || null,
              senderDeviceId: senderDeviceId || null,
              targetDeviceId: targetDeviceId || null,
              selfDeviceId: selfDeviceId || null
            }
          });
        } catch {}
        const err = new Error('targetDeviceId missing for live decrypt');
        err.code = 'TARGET_DEVICE_MISSING';
        throw err;
      }
      const isReplaySelfOutgoing = computedIsHistoryReplay && senderMatchesSelfDevice && direction === 'outgoing';
      if (DEBUG.replay && historyReplayTraceCount < historyReplayTraceLimit) {
        historyReplayTraceCount += 1;
        try {
          log({
            historyReplayFlagTrace: {
              conversationId: convId || conversationId || null,
              allowReplayRaw,
              mutateStateRaw,
              computedIsHistoryReplay: isHistoryReplay,
              directionComputed: direction || 'unknown',
              senderDeviceId: senderDeviceId || null,
              targetDeviceId: targetDeviceId || null,
              selfDeviceId: selfDeviceId || null,
              messageId: messageId || null,
              serverMessageId: serverMessageId || null
            }
          });
        } catch {}
      }
      if (!isHistoryReplay && !deviceMatchesSelf) {
        logDeliverySkip('directionFilter', { senderDeviceId, targetDeviceId, selfDeviceId });
        return;
      }
      const secureStatus = computedIsHistoryReplay
        ? { status: null }
        : await ensureConversationReadyForDevice(peerDeviceForMessage, packetConversationId || conversationId);
      if (!computedIsHistoryReplay && secureStatus?.status === SECURE_CONVERSATION_STATUS.PENDING) {
        logDeliverySkip('securePending', { peerDeviceId: peerDeviceForMessage, conversationId: packetConversationId || conversationId });
        return;
      }

      stateKey = buildStateKey({ conversationId: packetConversationId, peerKey, peerDeviceId: peerDeviceForMessage });
      logDrCore('packet:key', { conversationId: packetConversationId, messageId, stateKey });
      if (convId && typeof convId === 'string' && convId.startsWith('contacts-')) {
        logDeliverySkip('contactConversation');
        return;
      }
      if (!computedIsHistoryReplay) {
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
      const normalizedMsgType = typeof msgTypeForDecrypt === 'string' ? msgTypeForDecrypt.toLowerCase() : null;
      if (isHistoryReplay && normalizedMsgType && NON_REPLAYABLE_SIGNAL_TYPES.has(normalizedMsgType)) {
        replayCounters.skipped_nonReplayableSignal += 1;
        try {
          log({
            replaySkipSample: {
              skipReason: 'nonReplayableSignal',
              conversationId: convId || conversationId || null,
              messageId: messageId || null,
              serverMessageId: serverMessageId || null,
              msgType: normalizedMsgType
            }
          });
        } catch {}
        if (convId && messageId) {
          markMessageProcessed(convId, messageId);
        }
        return;
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

      let messageKeyB64 = null;
      let text = null;
      if (isHistoryReplay) {
        const vaultKeyResult = await vaultGetMessageKey({
          conversationId: convId || conversationId || null,
          messageId,
          senderDeviceId
        });
        if (!vaultKeyResult?.ok) {
          const errorCode = vaultKeyResult?.error || null;
          if (errorCode === 'UnwrapFailed' || errorCode === 'InvalidPayload') {
            try {
              log({
                mkUnwrapHardblockTrace: {
                  sourceTag: 'messages:replay:messageKeyVault.get',
                  reason: 'vault_unwrap_failed',
                  conversationId: convId || conversationId || null,
                  serverMessageId: serverMessageId || null,
                  messageId: messageId || null,
                  senderDeviceId: senderDeviceId || null,
                  targetDeviceId: targetDeviceId || null,
                  selfDeviceId: selfDeviceId || null,
                  status: vaultKeyResult?.status ?? null,
                  error: errorCode,
                  message: vaultKeyResult?.message || null
                }
              });
            } catch {}
            throw new Error('不可回放：密鑰解封失敗');
          }
          try {
            log({
              mkHardblockTrace: {
                sourceTag: 'messages:replay:messageKeyVault.get',
                reason: 'vault_get_failed',
                conversationId: convId || conversationId || null,
                serverMessageId: serverMessageId || null,
                messageId: messageId || null,
                senderDeviceId: senderDeviceId || null,
                targetDeviceId: targetDeviceId || null,
                selfDeviceId: selfDeviceId || null,
                status: vaultKeyResult?.status ?? null,
                error: errorCode,
                message: vaultKeyResult?.message || null
              }
            });
          } catch {}
          if (errorCode === 'NotFound' || errorCode === 'MissingParams' || errorCode === 'MKMissing') {
            replayCounters.messageKeyVaultMissing += 1;
            throw new Error('不可回放：缺少訊息密鑰');
          }
          throw new Error('不可回放：vault 取回失敗');
        }
        messageKeyB64 = vaultKeyResult.messageKeyB64;
        try {
          text = await decryptWithMessageKey({
            messageKeyB64,
            ivB64: pkt.iv_b64,
            ciphertextB64: pkt.ciphertext_b64,
            header
          });
        } catch {
          throw new Error('不可回放：密鑰解封失敗');
        }
        await handleDecryptedMessage(text, messageKeyB64);
        return;
      }
      if (computedIsHistoryReplay) {
        if (replayDrPathBlockedCount < replayDrPathBlockedLimit) {
          replayDrPathBlockedCount += 1;
          try {
            log({
              replayDrPathBlocked: {
                where: 'messages:handleInboxJob',
                conversationId: convId || conversationId || null,
                messageId: messageId || null,
                serverMessageId: serverMessageId || null,
                allowReplayRaw,
                mutateStateRaw,
                computedIsHistoryReplay,
                directionComputed: direction || 'unknown',
                senderDeviceId: senderDeviceId || null,
                targetDeviceId: targetDeviceId || null,
                selfDeviceId: selfDeviceId || null,
                peerDeviceId: peerDeviceForMessage || null
              }
            });
          } catch {}
        }
        throw new Error('REPLAY_DR_PATH_BLOCKED');
      }

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
          const err = new Error('DR state bound to different conversation; please resync contact');
          err.code = 'DR_STATE_CONVERSATION_MISMATCH';
          throw err;
        }
        if (!computedIsHistoryReplay && trackState) {
          deps.clearDrState(
            { peerAccountDigest: peerKey, peerDeviceId: peerDeviceForMessage },
            { __drDebugTag: 'web/src/app/features/messages.js:1119:handleInboxJob:conv-mismatch-clear' }
          );
          if (deps.ensureDrReceiverState && peerKey && peerDeviceForMessage) {
            await deps.ensureDrReceiverState({ peerAccountDigest: peerKey, peerDeviceId: peerDeviceForMessage, conversationId: convId });
            state = getStateForDevice(peerDeviceForMessage);
          }
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
        if (!computedIsHistoryReplay && trackState) {
          deps.clearDrState(
            { peerAccountDigest: peerKey, peerDeviceId: peerDeviceForMessage },
            { __drDebugTag: 'web/src/app/features/messages.js:1131:handleInboxJob:responder-inbound-clear' }
          );
          if (deps.ensureDrReceiverState && peerKey && peerDeviceForMessage) {
            await deps.ensureDrReceiverState({ peerAccountDigest: peerKey, peerDeviceId: peerDeviceForMessage, conversationId: convId });
            state = getStateForDevice(peerDeviceForMessage);
          }
        }
      }
      // 若仍缺可用 state，直接 fail（無任何 fallback）。
      if (!hasUsableDrState(state)) {
        if (trackState && !computedIsHistoryReplay && deps.ensureDrReceiverState && peerKey && peerDeviceForMessage) {
          await deps.ensureDrReceiverState({ peerAccountDigest: peerKey, peerDeviceId: peerDeviceForMessage, conversationId: convId });
          state = getStateForDevice(peerDeviceForMessage);
        }
        if (!hasUsableDrState(state)) {
          const err = new Error('DR state unavailable for conversation');
          err.code = 'DR_STATE_UNAVAILABLE';
          throw err;
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
      const effectiveHeaderCounter = Number.isFinite(headerCounter) ? headerCounter : null;
      const transportCounter = Number.isFinite(Number(packet?.counter)) ? Number(packet.counter) : null;
      const stateNs = Number.isFinite(Number(state?.Ns)) ? Number(state.Ns) : null;
      const sameReceiveChain = state?.theirRatchetPub && typeof header?.ek_pub_b64 === 'string'
        && naclB64(state.theirRatchetPub) === header.ek_pub_b64;
      const enableDuplicateGuard = trackState; // disable duplicate drop in replay-only mode
      if (enableDuplicateGuard && sameReceiveChain && Number.isFinite(effectiveHeaderCounter) && currentNr >= effectiveHeaderCounter) {
        logDeliverySkip('duplicateCounter', {
          counter: effectiveHeaderCounter,
          transportCounter,
          Nr: currentNr,
          Ns: stateNs
        });
        return;
      }
      logDrCore('decrypt:attempt', {
        conversationId: convId,
        peerAccountDigest: peerKey,
        messageId,
        peerDeviceId: peerDeviceForMessage || null,
        targetDeviceId: targetDeviceId || null,
        senderDeviceId: senderDeviceId || null,
        selfDeviceId,
        headerCounter,
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
      preDecryptSnapshot = deps.cloneDrStateHolder ? deps.cloneDrStateHolder(state) : null;
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
      if (!text) {
        const packetKey = trackState
          ? messageId
          : `${messageId || serverMessageId || 'unknown'}::${conversationId || convId || 'unknown'}::${peerDeviceForMessage || 'unknown-device'}`;
        text = await deps.drDecryptText(state, pkt, {
          onMessageKey: (mk) => { messageKeyB64 = mk; },
          packetKey,
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
      }
      await handleDecryptedMessage(text, messageKeyB64);
      return;
    } catch (err) {
      replayCounters.decryptFail += 1;
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
      const errorName = err?.name || err?.constructor?.name || 'Error';
      const msg = err?.message || String(err);
      const errorMessage = msg;
      const semantic = classifyDecryptedPayload(null, { meta, header });
      const failedMessageId = messageId || job?.messageId || job?.raw?.id || null;
      const headerCounter = Number.isFinite(Number(header?.n))
        ? Number(header.n)
        : Number.isFinite(Number(job?.payloadEnvelope?.counter))
          ? Number(job.payloadEnvelope.counter)
          : Number.isFinite(Number(job?.raw?.counter ?? job?.raw?.n))
            ? Number(job.raw.counter ?? job.raw.n)
            : null;
      if (DEBUG.replay && decryptFailSampleCount < decryptFailSampleLimit) {
        decryptFailSampleCount += 1;
        try {
          log({
            decryptFailSample: {
              conversationId: convId || conversationId || null,
              serverMessageId: serverMessageId || null,
              messageId: failedMessageId || null,
              computedIsHistoryReplay,
              msgTypeForDecrypt,
              directionComputed: direction || 'unknown',
              selfDeviceId: selfDeviceId || null,
              senderDeviceId: senderDeviceId || null,
              targetDeviceId: targetDeviceId || null,
              peerDeviceForMessage: peerDeviceForMessage || null,
              stateKey: stateKey || null,
              headerCounter,
              errorName,
              errorMessage
            }
          });
        } catch {}
      }
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
      logForensicsEvent('DECRYPT_FAIL', {
        conversationId: convId || conversationId || null,
        messageId: failedMessageId || null,
        direction: direction || null,
        msgType: msgTypeLabel || payloadMsgType || rawMsgType || msgTypeForDecrypt || null,
        senderDeviceId: senderDeviceId || null,
        targetDeviceId: targetDeviceId || null,
        headerCounter: Number.isFinite(headerCounter) ? headerCounter : null,
        errorName,
        errorMessage,
        gate: 'decryptFail'
      });
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
      if (!computedIsHistoryReplay && failedMessageId) decryptFailDedup.add(failedMessageId);
      if (!computedIsHistoryReplay && failedMessageId) {
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
      if (trackState && !computedIsHistoryReplay) {
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

  if (shouldYieldToReplay('beforeEnqueue')) {
    return buildYieldResult();
  }
  for (const raw of sortedItems) {
    if (shouldYieldToReplay('enqueue')) {
      return buildYieldResult();
    }
    const resolvedTs = resolveMessageTimestampField(raw);
    const resolvedId = resolveMessageIdField(raw);
    const msgTs = toMessageTimestamp(raw);
    const headerJson = raw?.header_json || raw?.headerJson || (raw?.header ? JSON.stringify(raw.header) : null);
    const ciphertextB64 = raw?.ciphertext_b64 || raw?.ciphertextB64 || null;
    let headerForKey = raw?.header || null;
    if (!headerForKey && typeof headerJson === 'string') {
      try { headerForKey = JSON.parse(headerJson); } catch {}
    }
    const serverMessageId = toMessageId(raw);
    const shouldLogFieldResolver = resolvedTs.field === 'none'
      || resolvedId.field === 'none'
      || !Number.isFinite(msgTs)
      || !serverMessageId;
    if (shouldLogFieldResolver) {
      logCapped('messageItemFieldResolverTrace', {
        stage: 'RESOLVE',
        conversationId: conversationId || null,
        pickedTsField: resolvedTs.field,
        pickedIdField: resolvedId.field,
        pickedTsSample: sampleDigits(resolvedTs.value),
        pickedIdPrefix8: sampleIdPrefix(resolvedId.value),
        resultTs: Number.isFinite(msgTs) ? msgTs : null,
        resultIdPrefix8: sampleIdPrefix(serverMessageId)
      }, 5);
    }
    if (!serverMessageId) {
      throw new Error('messageId missing from fetched item');
    }
    const stateKey = buildStateKey({ conversationId, peerKey, peerDeviceId: peerDevice });
    const fetchSenderDigest = raw?.senderAccountDigest || raw?.sender_digest || null;
    const fetchSenderDeviceId = raw?.senderDeviceId || raw?.sender_device_id || (headerForKey?.meta?.senderDeviceId || headerForKey?.meta?.sender_device_id) || null;
    if (FETCH_LOG_ENABLED) {
      logMsgEvent('fetch:item', {
        conversationId,
        direction: 'incoming',
        messageId: serverMessageId,
        serverMessageId,
        stateKey,
        senderDigest: fetchSenderDigest,
        senderDeviceId: fetchSenderDeviceId
      });
    }
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
    replayCounters.enqueuedJobs += 1;
    if (QUEUE_LOG_ENABLED) {
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
  }

  if (shouldYieldToReplay('beforeProcess')) {
    return buildYieldResult();
  }
  const allowReplayForProcess = allowReplayRaw;
  logReplayGateTrace('messages:listSecureAndDecrypt:processInboxInvoke', {
    conversationId,
    silent: !!silent,
    priority: requestPriority,
    callsite: 'processInboxInvoke'
  });
  await processInboxForConversation({
    conversationId,
    allowReplay: allowReplayForProcess,
    mutateState,
    handler: async (job, ctx) => {
      try {
        if (drDebug) {
          logDrCore('inbox:process-job', {
            jobId: job?.jobId || null,
            conversationId,
            messageId: job?.messageId || null,
            createdAt: job?.createdAt || null
          }, { level: 'log', force: true });
        }
        await handleInboxJob(job, ctx);
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
        if (preSnapshot && shouldTrackState && !computedIsHistoryReplay) {
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
  commitTimelineBatch();

  if (computedIsHistoryReplay && replayCounters.messageKeyVaultMissing > 0) {
    try {
      log({
        mkHardblockTrace: {
          sourceTag: 'messages:listSecureAndDecrypt',
          reason: 'vault_missing_replay',
          conversationId: conversationId || null,
          missingCount: replayCounters.messageKeyVaultMissing,
          decryptFail: replayCounters.decryptFail
        }
      });
    } catch {}
    const err = new Error('不可回放：缺少訊息密鑰');
    err.code = 'REPLAY_VAULT_MISSING';
    throw err;
  }

  if (shouldYieldToReplay('afterProcess')) {
    return buildYieldResult();
  }
  emitReplaySummary();
  return {
    items: out,
    nextCursorTs,
    nextCursor,
    hasMoreAtCursor,
    errors: errs,
    deadLetters,
    receiptUpdates: Array.from(receiptUpdates),
    replayStats: {
      decryptFail: replayCounters.decryptFail,
      decryptOk: replayCounters.decryptOk,
      messageKeyVaultMissing: replayCounters.messageKeyVaultMissing,
      directionFilterSkips: replayCounters.skipped_directionFilter,
      duplicateCounterSkips: replayCounters.skipped_duplicateCounter,
      fetchedItems: replayCounters.fetchedItems,
      vaultPutIncomingOk: replayCounters.vaultPutIncomingOk
    }
  };
  } finally {
    releaseSecureFetchLock(conversationId, lockToken);
    emitReplaySummary();
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
  if (!conversationId || !peerAccountDigest || !peerDeviceId || !messageId) return;
  if (typeof deps.wsSend !== 'function') return;
  ensureSentReceiptsLoaded();
  const dedupeKey = `${conversationId}:${messageId}`;
  if (sentReadReceipts.has(dedupeKey)) return;
  const identity = storeNormalizePeerIdentity({ peerAccountDigest, peerDeviceId });
  const targetAccountDigest = identity?.accountDigest
    || (typeof peerAccountDigest === 'string' ? peerAccountDigest.split('::')[0] : null);
  let senderDeviceId = null;
  try {
    senderDeviceId = storeEnsureDeviceId();
  } catch {}
  if (!targetAccountDigest || !senderDeviceId) return;
  const senderAccountDigest = typeof deps.getAccountDigest === 'function' ? deps.getAccountDigest() : null;
  const payload = {
    type: CONTROL_MESSAGE_TYPES.READ_RECEIPT,
    conversationId,
    messageId,
    senderAccountDigest: senderAccountDigest || null,
    senderDeviceId,
    targetAccountDigest,
    targetDeviceId: peerDeviceId,
    ts: Math.floor(Date.now() / 1000)
  };
  sentReadReceipts.add(dedupeKey);
  try {
    const result = deps.wsSend(payload);
    if (result && typeof result.then === 'function') {
      result.then(() => persistSentReceipts())
        .catch(() => sentReadReceipts.delete(dedupeKey));
      return;
    }
    if (result === false) {
      sentReadReceipts.delete(dedupeKey);
      return;
    }
    persistSentReceipts();
  } catch {
    sentReadReceipts.delete(dedupeKey);
  }
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

function maybeSendDeliveryReceipt({ conversationId, peerAccountDigest, messageId, tokenB64, peerDeviceId, vaultPutStatus = null }) {
  if (!conversationId || !peerAccountDigest || !messageId) return;
  if (!peerDeviceId) return;
  if (typeof deps.wsSend !== 'function') return;
  const dedupeKey = `${conversationId}:${messageId}`;
  if (sentDeliveryReceipts.has(dedupeKey)) return;
  if (vaultPutStatus) {
    logCapped('receiverDeliveryReceiptTrace', {
      messageId,
      vaultPutStatus,
      receiptType: CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT
    });
  }
  try {
    const identity = storeNormalizePeerIdentity({ peerAccountDigest, peerDeviceId });
    const targetAccountDigest = identity?.accountDigest
      || (typeof peerAccountDigest === 'string' ? peerAccountDigest.split('::')[0] : null);
    let senderDeviceId = null;
    try {
      senderDeviceId = storeEnsureDeviceId();
    } catch {}
    if (!targetAccountDigest || !senderDeviceId) return;
    const senderAccountDigest = typeof deps.getAccountDigest === 'function' ? deps.getAccountDigest() : null;
    const payload = {
      type: CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT,
      conversationId,
      messageId,
      senderAccountDigest: senderAccountDigest || null,
      senderDeviceId,
      targetAccountDigest,
      targetDeviceId: peerDeviceId,
      ts: Math.floor(Date.now() / 1000)
    };
    sentDeliveryReceipts.add(dedupeKey);
    const result = deps.wsSend(payload);
    if (result && typeof result.then === 'function') {
      result.then(() => {
        logCapped('deliveryAckTrace', {
          stage: 'sent',
          ackedMessageId: messageId,
          conversationId
        });
      }).catch((err) => {
        sentDeliveryReceipts.delete(dedupeKey);
        log({ deliveryReceiptError: err?.message || err, conversationId, messageId });
      });
    } else if (result === false) {
      sentDeliveryReceipts.delete(dedupeKey);
    } else {
      logCapped('deliveryAckTrace', {
        stage: 'sent',
        ackedMessageId: messageId,
        conversationId
      });
    }
  } catch (err) {
    return;
  }
}

function maybeSendVaultAckWs({ conversationId, messageId, senderAccountDigest, senderDeviceId, receiverAccountDigest, receiverDeviceId }) {
  if (!conversationId || !messageId || !senderAccountDigest || !senderDeviceId || !receiverAccountDigest || !receiverDeviceId) return;
  if (typeof deps.wsSend !== 'function') return;
  const payload = {
    type: 'vault-ack',
    conversationId,
    messageId,
    senderAccountDigest,
    senderDeviceId,
    receiverAccountDigest,
    receiverDeviceId,
    targetAccountDigest: senderAccountDigest,
    targetDeviceId: senderDeviceId,
    ts: Math.floor(Date.now() / 1000)
  };
  try {
    deps.wsSend(payload);
    logCapped('vaultAckWsSentTrace', {
      conversationId,
      messageId,
      senderDigest: senderAccountDigest,
      receiverDigest: receiverAccountDigest
    }, 5);
  } catch {}
}

function buildPendingVaultPutKey({ conversationId, messageId, senderDeviceId } = {}) {
  return `${conversationId || 'unknown'}::${messageId || 'unknown'}::${senderDeviceId || 'unknown'}`;
}

function buildPendingTracePayload(item, action, attemptCount, errorCode = null, status = null) {
  const attempt = Number.isFinite(Number(attemptCount)) ? Number(attemptCount) : 0;
  const payload = {
    action,
    conversationId: slicePrefix(item?.conversationId),
    messageId: item?.messageId || null,
    senderDeviceId: sliceSuffix(item?.senderDeviceId),
    attemptCount: attempt
  };
  if (errorCode) payload.errorCode = errorCode;
  if (Number.isFinite(Number(status))) payload.status = Number(status);
  return payload;
}

function buildRetryTracePayload(item, attemptCount, result, errorCode = null, status = null) {
  const attempt = Number.isFinite(Number(attemptCount)) ? Number(attemptCount) : 0;
  const payload = {
    conversationId: slicePrefix(item?.conversationId),
    messageId: item?.messageId || null,
    attemptCount: attempt,
    result
  };
  if (Number.isFinite(Number(status))) payload.status = Number(status);
  if (errorCode) payload.errorCode = errorCode;
  return payload;
}

function enqueuePendingVaultPut(params = {}, err = null) {
  const conversationId = params?.conversationId || null;
  const messageId = params?.messageId || null;
  const senderDeviceId = params?.senderDeviceId || null;
  const targetDeviceId = params?.targetDeviceId || null;
  const direction = params?.direction || null;
  const msgType = params?.msgType || null;
  const messageKeyB64 = params?.messageKeyB64 || null;
  const headerCounter = normalizeHeaderCounter(params?.headerCounter);
  if (!conversationId || !messageId || !senderDeviceId || !messageKeyB64) return false;
  if (direction !== 'incoming') return false;
  const queue = restorePendingVaultPuts();
  const key = buildPendingVaultPutKey({ conversationId, messageId, senderDeviceId });
  const existing = Array.isArray(queue)
    ? queue.find((entry) => buildPendingVaultPutKey(entry) === key)
    : null;
  const errorCode = resolveErrorCode(err);
  const status = typeof err?.status === 'number' ? err.status : null;
  if (existing) {
    existing.messageKeyB64 = messageKeyB64 || existing.messageKeyB64;
    existing.targetDeviceId = targetDeviceId || existing.targetDeviceId;
    existing.direction = direction || existing.direction;
    existing.msgType = msgType || existing.msgType;
    existing.headerCounter = headerCounter ?? existing.headerCounter ?? null;
    existing.lastError = err?.message || existing.lastError || null;
    existing.lastErrorCode = errorCode || existing.lastErrorCode || null;
    existing.lastStatus = Number.isFinite(Number(status)) ? Number(status) : existing.lastStatus ?? null;
    existing.updatedAt = Date.now();
    if (!Number.isFinite(Number(existing.nextAttemptAt))) {
      existing.nextAttemptAt = Date.now() + PENDING_VAULT_PUT_RETRY_INTERVAL_MS;
    }
    persistPendingVaultPuts();
    return false;
  }
  if (queue.length >= PENDING_VAULT_PUT_QUEUE_LIMIT) {
    const dropped = queue.shift();
    if (dropped) {
      logCapped('vaultPutPendingTrace', buildPendingTracePayload(
        dropped,
        'drop_oldest',
        dropped?.attemptCount ?? 0,
        dropped?.lastErrorCode ?? null,
        dropped?.lastStatus ?? null
      ), OFFLINE_SYNC_LOG_CAP);
    }
  }
  const now = Date.now();
  const item = {
    conversationId,
    messageId,
    senderDeviceId,
    targetDeviceId: targetDeviceId || null,
    direction,
    msgType,
    messageKeyB64,
    headerCounter,
    attemptCount: 0,
    nextAttemptAt: now + PENDING_VAULT_PUT_RETRY_INTERVAL_MS,
    lastError: err?.message || (err ? String(err) : null),
    lastErrorCode: errorCode || null,
    lastStatus: Number.isFinite(Number(status)) ? Number(status) : null,
    exhausted: false,
    enqueuedAt: now,
    updatedAt: now
  };
  queue.push(item);
  logCapped('vaultPutPendingTrace', buildPendingTracePayload(
    item,
    'enqueue',
    0,
    errorCode || null,
    status
  ), OFFLINE_SYNC_LOG_CAP);
  persistPendingVaultPuts();
  return true;
}

async function flushPendingVaultPutsNow() {
  const queue = restorePendingVaultPuts();
  if (!Array.isArray(queue) || !queue.length) return { attempted: 0, success: 0, failed: 0 };
  const mkRaw = typeof deps.getMkRaw === 'function' ? deps.getMkRaw() : null;
  if (!mkRaw) return { attempted: 0, success: 0, failed: 0 };
  const now = Date.now();
  const nextQueue = [];
  let attempted = 0;
  let success = 0;
  let failed = 0;
  for (const item of queue) {
    if (!item || item.exhausted === true) {
      nextQueue.push(item);
      continue;
    }
    if (!item.conversationId || !item.messageId || !item.senderDeviceId || !item.messageKeyB64) {
      nextQueue.push(item);
      continue;
    }
    const nextAttemptAt = Number(item.nextAttemptAt) || 0;
    if (nextAttemptAt > now) {
      nextQueue.push(item);
      continue;
    }
    const baseAttemptCount = Number(item.attemptCount) || 0;
    if (baseAttemptCount >= PENDING_VAULT_PUT_RETRY_MAX) {
      if (!item.exhausted) {
        item.exhausted = true;
        logCapped('vaultPutPendingTrace', buildPendingTracePayload(
          item,
          'exhausted',
          baseAttemptCount,
          item.lastErrorCode ?? null,
          item.lastStatus ?? null
        ), OFFLINE_SYNC_LOG_CAP);
      }
      nextQueue.push(item);
      continue;
    }
    const attemptCount = baseAttemptCount + 1;
    attempted += 1;
    logCapped('vaultPutPendingTrace', buildPendingTracePayload(
      item,
      'retry',
      attemptCount,
      item.lastErrorCode ?? null,
      item.lastStatus ?? null
    ), OFFLINE_SYNC_LOG_CAP);
    try {
      await vaultPutMessageKey({
        conversationId: item.conversationId,
        messageId: item.messageId,
        senderDeviceId: item.senderDeviceId,
        targetDeviceId: item.targetDeviceId || null,
        direction: item.direction || 'incoming',
        msgType: item.msgType || null,
        messageKeyB64: item.messageKeyB64,
        headerCounter: normalizeHeaderCounter(item.headerCounter)
      });
      success += 1;
      logCapped('vaultPutRetryTrace', buildRetryTracePayload(
        item,
        attemptCount,
        'ok',
        null,
        null
      ), OFFLINE_SYNC_LOG_CAP);
      logCapped('vaultPutPendingTrace', buildPendingTracePayload(
        item,
        'success',
        attemptCount,
        null,
        null
      ), OFFLINE_SYNC_LOG_CAP);
      continue;
    } catch (err) {
      failed += 1;
      const errorCode = resolveErrorCode(err);
      const status = typeof err?.status === 'number' ? err.status : null;
      const updated = {
        ...item,
        attemptCount,
        nextAttemptAt: Date.now() + PENDING_VAULT_PUT_RETRY_INTERVAL_MS,
        lastError: err?.message || (err ? String(err) : null),
        lastErrorCode: errorCode || null,
        lastStatus: Number.isFinite(Number(status)) ? Number(status) : null,
        updatedAt: Date.now()
      };
      logCapped('vaultPutRetryTrace', buildRetryTracePayload(
        item,
        attemptCount,
        'failed',
        errorCode || null,
        status
      ), OFFLINE_SYNC_LOG_CAP);
      if (attemptCount >= PENDING_VAULT_PUT_RETRY_MAX) {
        updated.exhausted = true;
        logCapped('vaultPutPendingTrace', buildPendingTracePayload(
          updated,
          'exhausted',
          attemptCount,
          errorCode || null,
          status
        ), OFFLINE_SYNC_LOG_CAP);
      }
      nextQueue.push(updated);
    }
  }
  sessionStore.pendingVaultPuts = nextQueue;
  persistPendingVaultPuts();
  return { attempted, success, failed };
}

function collectOfflineCatchupTargets() {
  const targets = [];
  const seen = new Set();
  const maxTargets = OFFLINE_CATCHUP_CONVERSATION_LIMIT;
  const addTarget = (entry) => {
    if (!entry || targets.length >= maxTargets) return false;
    const conversationId = entry?.conversationId || null;
    const tokenB64 = entry?.tokenB64 || entry?.token_b64 || null;
    const peerAccountDigest = entry?.peerAccountDigest || entry?.peerKey || null;
    const peerDeviceId = entry?.peerDeviceId || null;
    if (!conversationId || !tokenB64 || !peerAccountDigest || !peerDeviceId) return false;
    const convKey = String(conversationId);
    if (seen.has(convKey)) return false;
    seen.add(convKey);
    targets.push({
      conversationId: convKey,
      tokenB64,
      peerAccountDigest,
      peerDeviceId
    });
    return true;
  };

  const activeState = sessionStore?.messageState || null;
  addTarget({
    conversationId: activeState?.conversationId || null,
    tokenB64: activeState?.conversationToken || null,
    peerAccountDigest: activeState?.activePeerDigest || null,
    peerDeviceId: activeState?.activePeerDeviceId || null
  });

  const candidates = [];
  let order = 0;
  const readyList = Array.isArray(listReadyContacts()) ? listReadyContacts() : [];
  for (const entry of readyList) {
    const conversationId = entry?.conversationId || entry?.conversation?.conversation_id || null;
    const tokenB64 = entry?.conversationToken || entry?.conversation?.token_b64 || null;
    const peerAccountDigest = entry?.peerAccountDigest || entry?.peerKey || null;
    const peerDeviceId = entry?.peerDeviceId || null;
    if (!conversationId || !tokenB64 || !peerAccountDigest || !peerDeviceId) continue;
    candidates.push({
      conversationId: String(conversationId),
      tokenB64,
      peerAccountDigest,
      peerDeviceId,
      order
    });
    order += 1;
  }
  const convIndexEntries = sessionStore?.conversationIndex && typeof sessionStore.conversationIndex.entries === 'function'
    ? Array.from(sessionStore.conversationIndex.entries())
    : [];
  for (const [convId, entry] of convIndexEntries) {
    const conversationId = entry?.conversationId || convId || null;
    const tokenB64 = entry?.token_b64 || entry?.conversationToken || entry?.tokenB64 || null;
    const peerAccountDigest = entry?.peerAccountDigest || entry?.peerKey || null;
    const peerDeviceId = entry?.peerDeviceId || null;
    if (!conversationId || !tokenB64 || !peerAccountDigest || !peerDeviceId) continue;
    candidates.push({
      conversationId: String(conversationId),
      tokenB64,
      peerAccountDigest,
      peerDeviceId,
      order
    });
    order += 1;
  }

  const merged = new Map();
  for (const entry of candidates) {
    const key = entry.conversationId;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, entry);
      continue;
    }
    merged.set(key, {
      ...prev,
      tokenB64: prev.tokenB64 || entry.tokenB64,
      peerAccountDigest: prev.peerAccountDigest || entry.peerAccountDigest,
      peerDeviceId: prev.peerDeviceId || entry.peerDeviceId
    });
  }

  const threads = sessionStore?.conversationThreads;
  let hasActivity = false;
  const ordered = Array.from(merged.values()).map((entry) => {
    const thread = threads?.get?.(entry.conversationId) || null;
    const lastActiveTs = entry?.lastActiveTs
      ?? thread?.lastActiveTs
      ?? thread?.lastMessageTs
      ?? thread?.lastReadTs
      ?? null;
    const lastActive = Number.isFinite(Number(lastActiveTs)) ? Number(lastActiveTs) : null;
    if (lastActive !== null) hasActivity = true;
    return { ...entry, lastActiveTs: lastActive };
  });

  ordered.sort((a, b) => {
    if (hasActivity) {
      const aTs = a.lastActiveTs || 0;
      const bTs = b.lastActiveTs || 0;
      if (bTs !== aTs) return bTs - aTs;
    }
    return a.order - b.order;
  });

  for (const entry of ordered) {
    if (targets.length >= maxTargets) break;
    addTarget(entry);
  }
  return targets;
}

function normalizeOfflineSyncSource(source) {
  const key = typeof source === 'string' ? source : '';
  return OFFLINE_SYNC_SOURCES.has(key) ? key : 'login';
}

const DECRYPT_UNABLE_REASON_CODES = new Set([
  'DR_STATE_UNAVAILABLE',
  'DR_STATE_CONVERSATION_MISMATCH',
  'TARGET_DEVICE_MISSING',
  'MK_MISSING'
]);

function resolveCatchupFailReason({ err = null, errors = null } = {}) {
  const rawCode = err?.code || err?.errorCode || err?.stage || null;
  const code = rawCode ? String(rawCode) : '';
  const message = typeof err?.message === 'string' ? err.message : '';
  if (code === 'DR_STATE_UNAVAILABLE' || message.includes('DR state unavailable')) return 'DR_STATE_UNAVAILABLE';
  if (code === 'DR_STATE_CONVERSATION_MISMATCH' || message.includes('DR state bound to different conversation')) {
    return 'DR_STATE_CONVERSATION_MISMATCH';
  }
  if (code === 'TARGET_DEVICE_MISSING' || message.includes('targetDeviceId missing')) return 'TARGET_DEVICE_MISSING';
  if (code === 'MK_MISSING_HARDBLOCK') return 'MK_MISSING';
  if (code === 'REPLAY_VAULT_MISSING' || message.includes('缺少訊息密鑰')) return 'REPLAY_VAULT_MISSING';
  if (typeof err?.status === 'number' || (code && code.startsWith('HTTP_')) || message.includes('HTTP')) return 'NETWORK';
  if (Array.isArray(errors)) {
    const sample = errors.map((entry) => (entry?.message || entry)).filter(Boolean).join(' ');
    if (sample.includes('同步進行中')) return 'LOCKED';
    if (sample.includes('安全對話建立中')) return 'LOCKED';
    if (sample.includes('HTTP')) return 'NETWORK';
  }
  return null;
}

function logDecryptUnableTrace({ conversationId, reasonCode, errorMessage, sourceTag } = {}) {
  if (!reasonCode || !DECRYPT_UNABLE_REASON_CODES.has(reasonCode)) return;
  logCapped('decryptUnableTrace', {
    conversationId: conversationId || null,
    reasonCode,
    error: errorMessage || null,
    source: sourceTag || null
  }, OFFLINE_SYNC_LOG_CAP);
}

function logCatchupTrace({
  conversationId,
  sourceTag,
  itemsFetched = null,
  decryptOkCount = null,
  vaultPutIncomingOkCount = null,
  failReason = null
} = {}) {
  logCapped('bRouteCatchupTrace', {
    conversationId: conversationId || null,
    source: sourceTag || null,
    itemsFetched: Number.isFinite(Number(itemsFetched)) ? Number(itemsFetched) : null,
    decryptOkCount: Number.isFinite(Number(decryptOkCount)) ? Number(decryptOkCount) : null,
    vaultPutIncomingOkCount: Number.isFinite(Number(vaultPutIncomingOkCount)) ? Number(vaultPutIncomingOkCount) : null,
    failReason: failReason || null
  }, OFFLINE_SYNC_LOG_CAP);
}

export async function syncOfflineDecryptNow({ source } = {}) {
  const sourceTag = normalizeOfflineSyncSource(source);
  const cursorStore = restoreOfflineDecryptCursorStore();
  const targets = collectOfflineCatchupTargets();
  const plannedCount = targets.length;
  const conversationIds = targets.map((entry) => slicePrefix(entry?.conversationId)).filter(Boolean).slice(0, OFFLINE_SYNC_LOG_CAP);
  logCapped('offlineCatchupTargetsTrace', {
    source: sourceTag,
    plannedCount,
    sampleConvPrefix8: conversationIds
  }, OFFLINE_SYNC_LOG_CAP);
  let attemptedCount = 0;
  let successCount = 0;
  let failCount = 0;
  const failures = [];
  for (const target of targets) {
    attemptedCount += 1;
    const convId = target?.conversationId || null;
    try {
      const cursorEntry = cursorStore instanceof Map ? cursorStore.get(String(convId)) : null;
      const cursorTs = cursorEntry?.cursorTs ?? null;
      const cursorId = cursorEntry?.cursorId ?? null;
      const result = await listSecureAndDecrypt({
        conversationId: convId,
        tokenB64: target?.tokenB64 || null,
        peerAccountDigest: target?.peerAccountDigest || null,
        peerDeviceId: target?.peerDeviceId || null,
        limit: OFFLINE_CATCHUP_MESSAGE_LIMIT,
        cursorTs: cursorTs ?? null,
        cursorId: cursorId ?? null,
        mutateState: true,
        allowReplay: false,
        sendReadReceipt: false,
        silent: true,
        priority: 'live'
      });
      const errors = Array.isArray(result?.errors) ? result.errors : [];
      const stats = result?.replayStats || {};
      const itemsFetched = stats?.fetchedItems ?? result?.serverItemCount ?? result?.items?.length ?? 0;
      const decryptOkCount = stats?.decryptOk ?? 0;
      const vaultPutIncomingOkCount = stats?.vaultPutIncomingOk ?? 0;
      const nextCursor = result?.nextCursor
        || (result?.nextCursorTs != null
          ? { ts: result.nextCursorTs, id: result?.nextCursorId ?? null }
          : null);
      if (result?.hasMoreAtCursor && nextCursor) {
        cursorStore.set(String(convId), {
          cursorTs: nextCursor?.ts ?? null,
          cursorId: nextCursor?.id ?? null,
          hasMoreAtCursor: true,
          updatedAt: Date.now()
        });
      } else if (cursorStore instanceof Map) {
        cursorStore.delete(String(convId));
      }
      if (errors.length) {
        failCount += 1;
        const failReason = resolveCatchupFailReason({ errors });
        logCatchupTrace({
          conversationId: convId,
          sourceTag,
          itemsFetched,
          decryptOkCount,
          vaultPutIncomingOkCount,
          failReason
        });
        logDecryptUnableTrace({
          conversationId: convId,
          reasonCode: failReason,
          errorMessage: truncateErrorMessage(errors[0]),
          sourceTag
        });
        const errorMessage = truncateErrorMessage(errors[0]);
        failures.push({
          conversationId: slicePrefix(convId),
          errorMessage: errorMessage || 'listSecureAndDecrypt failed'
        });
      } else {
        successCount += 1;
        logCatchupTrace({
          conversationId: convId,
          sourceTag,
          itemsFetched,
          decryptOkCount,
          vaultPutIncomingOkCount,
          failReason: null
        });
      }
    } catch (err) {
      failCount += 1;
      const errorCode = resolveErrorCode(err);
      const errorMessage = errorCode ? null : truncateErrorMessage(err?.message || err);
      const failReason = resolveCatchupFailReason({ err });
      logCatchupTrace({
        conversationId: convId,
        sourceTag,
        itemsFetched: 0,
        decryptOkCount: 0,
        vaultPutIncomingOkCount: 0,
        failReason
      });
      logDecryptUnableTrace({
        conversationId: convId,
        reasonCode: failReason,
        errorMessage: errorMessage || null,
        sourceTag
      });
      failures.push({
        conversationId: slicePrefix(convId),
        ...(errorCode ? { errorCode } : { errorMessage: errorMessage || 'listSecureAndDecrypt failed' })
      });
    }
  }
  persistOfflineDecryptCursorStore();
  logCapped('offlineDecryptFlushTrace', {
    source: sourceTag,
    conversationIds,
    plannedCount,
    attemptedCount,
    successCount,
    failCount,
    failures: failures.slice(0, OFFLINE_SYNC_LOG_CAP)
  }, OFFLINE_SYNC_LOG_CAP);
  await flushPendingVaultPutsNow();
  return { plannedCount, attemptedCount, successCount, failCount };
}

export async function syncNow(params = {}) {
  return syncOfflineDecryptNow(params);
}

export async function flushNow(params = {}) {
  return syncOfflineDecryptNow(params);
}
