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
// /app/features/dr-session.js
// X3DH 初始化與 DR 文字訊息發送（功能層，無 UI）。

import { prekeysBundle } from '../api/prekeys.js';
import { x3dhInitiate, drEncryptText, x3dhRespond, buildDrAadFromHeader } from '../crypto/dr.js';
import { b64, b64u8 } from '../crypto/nacl.js';
import { getAccountDigest, drState, normalizePeerIdentity, getDeviceId, ensureDeviceId, normalizeAccountDigest, clearDrStatesByAccount, clearDrState, normalizePeerDeviceId } from '../core/store.js';
import { getContactSecret, setContactSecret, restoreContactSecrets, quarantineCorruptContact, normalizePeerKeyForQuarantine, recordPendingContact, clearPendingContact } from '../core/contact-secrets.js';
import { sessionStore } from '../ui/mobile/session-store.js';
import {
  conversationIdFromToken
} from './conversation.js';
import { ensureDevicePrivAvailable } from './device-priv.js';
import { CONTROL_MESSAGE_TYPES } from './secure-conversation-signals.js';
import { encryptAndPutWithProgress } from './media.js';
import {
  enqueueOutboxJob,
  processOutboxJobNow,
  setOutboxHooks,
  startOutboxProcessor
} from './queue/outbox.js';
import { enqueueReceiptJob } from './queue/receipts.js';
import { logDrCore, logMsgEvent } from '../lib/logging.js';
import { log, logCapped } from '../core/log.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';
import { MessageKeyVault } from './message-key-vault.js';
import { listSecureMessages } from '../api/messages.js';

const sendFailureCounter = new Map(); // peerDigest::deviceId -> count
const transportCounterSeeded = new Set(); // conversationId::senderDeviceId
import { enqueueMediaMetaJob } from './queue/media.js';
const SEND_PREFLIGHT_TRACE_LIMIT = 3;
let sendPreflightTraceCount = 0;
const DR_SNAPSHOT_REJECT_LIMIT = 3;
const DR_HYDRATE_FAIL_LIMIT = 3;
let drSnapshotRejectCount = 0;
let drHydrateFailCount = 0;

function logSendPreflightTrace(payload = {}) {
  if (sendPreflightTraceCount >= SEND_PREFLIGHT_TRACE_LIMIT) return;
  sendPreflightTraceCount += 1;
  log({ sendPreflightSecretTrace: payload });
}

function logOutgoingSendTrace(stage, messageId, serverMessageId = null) {
  if (!stage) return;
  logCapped('outgoingSendTrace', {
    stage,
    localId: messageId || null,
    messageId: messageId || null,
    serverMessageId: serverMessageId || null
  });
}

function suffix(value, len) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > len ? trimmed.slice(-len) : trimmed;
}

function stateKeySuffix6(peerAccountDigest, peerDeviceId) {
  if (!peerAccountDigest && !peerDeviceId) return null;
  const key = `${peerAccountDigest || 'unknown'}::${peerDeviceId || 'unknown'}`;
  return suffix(key, 6);
}

function logDrSnapshotRestoreReject(payload = {}) {
  if (drSnapshotRejectCount >= DR_SNAPSHOT_REJECT_LIMIT) return;
  drSnapshotRejectCount += 1;
  log({ drSnapshotRestoreReject: payload });
}

function logDrHydrateFailedTrace(payload = {}) {
  if (drHydrateFailCount >= DR_HYDRATE_FAIL_LIMIT) return;
  drHydrateFailCount += 1;
  log({ drHydrateFailedTrace: payload });
}

const drConsole = DEBUG.drVerbose === true
  ? console
  : { log() {}, warn() {}, error: (...args) => console.error(...args), info() {} };

const DR_STATE_DEBUG_ENABLED = (() => {
  try {
    if (typeof window !== 'undefined' && window.__DEBUG_DR_STATE__) return true;
    if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  } catch {
    /* ignore */
  }
  return false;
})();

function logDrStateDebug(event, payload = {}) {
  if (!DR_STATE_DEBUG_ENABLED) return;
  try {
    drConsole.warn(`[dr-state:${event}]`, payload);
  } catch {
    /* ignore */
  }
}

function normHex(value) {
  const digest = normalizeAccountDigest(
    value?.peerAccountDigest ?? value?.accountDigest ?? value
  );
  return digest || null;
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

function resolvePeerDigest(input) {
  if (!input) return null;
  const extractDigest = (value) => {
    if (!value) return null;
    if (typeof value === 'string' && value.includes('::')) {
      const [dPart] = value.split('::');
      return normHex(dPart);
    }
    return normHex(value);
  };
  if (typeof input === 'string') return extractDigest(input);
  if (typeof input !== 'object') return extractDigest(input);
  const candidate = input.peerAccountDigest ?? input.accountDigest ?? input;
  return extractDigest(candidate);
}

function ensurePeerIdentity({ peerAccountDigest, peerDeviceId, conversationId = null, __debugSource = null }) {
  const digest = resolvePeerDigest(peerAccountDigest);
  let device = null;
  // 若 caller 傳入 digest::deviceId，直接拆出裝置避免丟失。
  if (typeof peerAccountDigest === 'string' && peerAccountDigest.includes('::')) {
    const [, devPart] = peerAccountDigest.split('::');
    device = normalizePeerDeviceId(devPart);
  }
  if (!device && peerDeviceId) device = normalizePeerDeviceId(peerDeviceId);
  if (!device) {
    const fromIndex = resolvePeerDeviceId(peerAccountDigest, conversationId);
    device = normalizePeerDeviceId(fromIndex);
  }
  if (!digest || !device) {
    try {
      drConsole.warn('[dr-identity:missing]', {
        peerAccountDigest,
        peerDeviceId,
        resolvedDigest: digest || null,
        resolvedDevice: device || null,
        conversationId,
        source: __debugSource || null
      });
    } catch {
      /* ignore logging errors */
    }
    throw new Error('peerAccountDigest and peerDeviceId are required');
  }
  return { digest, deviceId: device };
}

function resolvePeerDeviceId(peerAccountDigest = null, conversationId = null) {
  const peer = resolvePeerDigest(peerAccountDigest);
  if (!peer) return null;
  const convIndex = sessionStore.conversationIndex;
  if (conversationId && convIndex?.get?.(conversationId)?.peerDeviceId) {
    return convIndex.get(conversationId).peerDeviceId;
  }
  if (convIndex && typeof convIndex.values === 'function') {
    for (const info of convIndex.values()) {
      const peerMatch = normHex(info?.peerAccountDigest || null);
      if (peerMatch && peerMatch === peer && info?.peerDeviceId) {
        return info.peerDeviceId;
      }
    }
  }
  const threads = sessionStore.conversationThreads;
  if (conversationId && threads?.get?.(conversationId)?.peerDeviceId) {
    return threads.get(conversationId).peerDeviceId;
  }
  if (threads && typeof threads.values === 'function') {
    for (const info of threads.values()) {
      const peerMatch = normHex(info?.peerAccountDigest || null);
      if (peerMatch && peerMatch === peer && info?.peerDeviceId) {
        return info.peerDeviceId;
      }
    }
  }
  return null;
}

function cloneU8(src, keyName = 'unknown', callsiteTag = 'cloneU8') {
  if (src === undefined || src === null) return null;
  if (!(src instanceof Uint8Array)) {
    const reason = 'not-uint8array';
    try {
      drConsole.warn('[dr-state:invalid-key-write]', {
        keyName,
        callsiteTag,
        reason,
        type: typeof src,
        ctor: src?.constructor?.name || null,
        isView: ArrayBuffer.isView(src),
        byteLength: typeof src?.byteLength === 'number' ? src.byteLength : null,
        length: typeof src?.length === 'number' ? src.length : null
      });
    } catch {}
    throw new Error(`dr state write rejected: ${keyName} not Uint8Array`);
  }
  return new Uint8Array(src);
}

function markHolderSnapshot(holder, source, ts) {
  if (!holder) return;
  holder.snapshotTs = typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
  holder.snapshotSource = source || null;
}

function numberOrDefault(value, def = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

function requireTransportCounter(state, { peerAccountDigest = null, peerDeviceId = null, sourceTag = 'transport-counter' } = {}) {
  if (!state || typeof state !== 'object') {
    throw new Error('transport counter unavailable: state missing');
  }
  const hasNsTotal = Object.prototype.hasOwnProperty.call(state, 'NsTotal');
  const nsTotal = hasNsTotal ? Number(state.NsTotal) : NaN;
  if (!Number.isFinite(nsTotal)) {
    try {
      drConsole.warn('[dr-log:transport-counter-missing]', {
        peerAccountDigest,
        peerDeviceId,
        source: sourceTag,
        nsTotal: state?.NsTotal ?? null
      });
    } catch {}
    throw new Error('transport counter missing (NsTotal)');
  }
  return nsTotal;
}


function reserveTransportCounter(state, {
  peerAccountDigest = null,
  peerDeviceId = null,
  conversationId = null,
  messageId = null,
  msgType = null,
  sourceTag = 'reserve-transport-counter'
} = {}) {
  const before = requireTransportCounter(state, { peerAccountDigest, peerDeviceId, sourceTag });
  const reserved = before + 1;
  state.NsTotal = reserved;
  const convId = conversationId || state?.baseKey?.conversationId || null;
  const stateKey = peerAccountDigest && peerDeviceId ? `${peerAccountDigest}::${peerDeviceId}` : null;
  if (DEBUG.drCounter) {
    try {
      log({
        counterReserve: {
          messageId: messageId || null,
          msgType: msgType || null,
          conversationId: convId,
          peerAccountDigest: peerAccountDigest || null,
          peerDeviceId: peerDeviceId || null,
          stateKey,
          holderKey: stateKey,
          before,
          reserved
        }
      });
    } catch {}
  }
  return reserved;
}

async function seedTransportCounterFromServer({
  conversationId,
  peerAccountDigest = null,
  peerDeviceId = null,
  state = null,
  sourceTag = 'seed-transport-counter'
} = {}) {
  const convId = conversationId || null;
  if (!convId || !state) return false;
  let deviceId = null;
  let digest = null;
  try {
    deviceId = ensureDeviceId();
    digest = normalizeAccountDigest(getAccountDigest());
  } catch {
    return false;
  }
  if (!deviceId || !digest) return false;
  const seedKey = `${convId}::${deviceId}`;
  if (transportCounterSeeded.has(seedKey)) return false;
  transportCounterSeeded.add(seedKey);

  try {
    const { r, data } = await listSecureMessages({ conversationId: convId, limit: 50 });
    if (!r?.ok) {
      log({
        transportCounterSeedError: {
          conversationId: convId,
          peerAccountDigest,
          peerDeviceId,
          status: r?.status ?? null,
          source: sourceTag
        }
      });
      return false;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    let maxCounter = 0;
    for (const entry of items) {
      const senderAccount = normalizeAccountDigest(entry?.sender_account_digest || entry?.senderAccountDigest || null);
      if (senderAccount && senderAccount !== digest) continue;
      const senderDevice = entry?.sender_device_id || entry?.senderDeviceId || null;
      if (senderDevice && senderDevice !== deviceId) continue;
      const candidates = [];
      const directCounter = Number(entry?.counter ?? entry?.n);
      if (Number.isFinite(directCounter) && directCounter > 0) candidates.push(directCounter);
      try {
        const header = entry?.header_json ? JSON.parse(entry.header_json) : entry?.header;
        const headerDeviceId = header?.device_id || header?.deviceId || null;
        if (!headerDeviceId || headerDeviceId === deviceId) {
          const headerCounter = Number(header?.n ?? header?.counter);
          if (Number.isFinite(headerCounter) && headerCounter > 0) candidates.push(headerCounter);
        }
      } catch {}
      for (const c of candidates) {
        if (Number.isFinite(c) && c > maxCounter) maxCounter = c;
      }
      if (maxCounter && senderDevice && senderDevice === deviceId) break;
    }
    if (maxCounter > 0 && Number(state.NsTotal) < maxCounter) {
      state.NsTotal = maxCounter;
      log({
        transportCounterSeeded: {
          conversationId: convId,
          peerAccountDigest,
          peerDeviceId,
          senderDeviceId: deviceId,
          maxCounter,
          source: sourceTag
        }
      });
      return true;
    }
    return false;
  } catch (err) {
    log({
      transportCounterSeedError: {
        conversationId: convId,
        peerAccountDigest,
        peerDeviceId,
        error: err?.message || err,
        source: sourceTag
      }
    });
    return false;
  }
}

function ensureHolderId(holder) {
  if (!holder) return null;
  if (!holder.__id) {
    try {
      holder.__id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `holder-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    } catch {
      holder.__id = `holder-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }
  return holder.__id;
}

function isAutomationEnv() {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  if (typeof window !== 'undefined' && window.__DEBUG_DR_STATE__) return true;
  return false;
}

function logDrSend(event, payload) {
  if (!isAutomationEnv()) return;
  try {
    drConsole.log('[dr-send]', JSON.stringify({ event, ...payload }, null, 2));
  } catch {
    drConsole.log('[dr-send]', { event, ...payload });
  }
}

function normalizeB64Input(str) {
  const trimmed = typeof str === 'string' ? str.trim() : '';
  if (!trimmed) return trimmed;
  let normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return normalized;
}

function logDecodeInvalidKey({ keyName, raw, peerAccountDigest = null, peerDeviceId = null, sourceTag = null, reason = null, error = null }) {
  try {
    drConsole.warn('[contact-secrets:decode-invalid-key]', {
      keyName,
      peerAccountDigest,
      peerDeviceId,
      source: sourceTag,
      reason: reason || null,
      error: error || null,
      type: typeof raw,
      ctor: raw?.constructor?.name || null,
      isView: ArrayBuffer.isView(raw),
      byteLength: typeof raw?.byteLength === 'number' ? raw.byteLength : null,
      length: typeof raw?.length === 'number' ? raw.length : null
    });
  } catch {}
}

function requireSnapshotKeyString(snapshot, keyName, fallbackKey, { required = false, allowNull = false, peerAccountDigest = null, peerDeviceId = null, sourceTag = null } = {}) {
  const hasPrimary = Object.prototype.hasOwnProperty.call(snapshot, keyName);
  const hasFallback = fallbackKey ? Object.prototype.hasOwnProperty.call(snapshot, fallbackKey) : false;
  const raw = snapshot?.[keyName] ?? (fallbackKey ? snapshot?.[fallbackKey] : undefined);
  const present = hasPrimary || hasFallback || raw !== undefined;
  if (!present) {
    if (required) {
      logDecodeInvalidKey({ keyName, raw, peerAccountDigest, peerDeviceId, sourceTag, reason: 'missing' });
      throw new Error(`contact-secrets decode failed: missing ${keyName}`);
    }
    return null;
  }
  if (raw === null && allowNull) return null;
  if (typeof raw !== 'string') {
    logDecodeInvalidKey({ keyName, raw, peerAccountDigest, peerDeviceId, sourceTag, reason: 'not-string' });
    throw new Error(`contact-secrets decode failed: ${keyName} not string`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    logDecodeInvalidKey({ keyName, raw, peerAccountDigest, peerDeviceId, sourceTag, reason: 'empty-string' });
    throw new Error(`contact-secrets decode failed: ${keyName} empty`);
  }
  return trimmed;
}

function requireSnapshotCounter(snapshot, keyName, fallbackKey, { peerAccountDigest = null, peerDeviceId = null, sourceTag = null } = {}) {
  const hasPrimary = Object.prototype.hasOwnProperty.call(snapshot, keyName);
  const hasFallback = fallbackKey ? Object.prototype.hasOwnProperty.call(snapshot, fallbackKey) : false;
  const raw = snapshot?.[keyName] ?? (fallbackKey ? snapshot?.[fallbackKey] : undefined);
  if (!hasPrimary && !hasFallback) {
    logDecodeInvalidKey({ keyName, raw, peerAccountDigest, peerDeviceId, sourceTag, reason: 'missing-counter' });
    throw new Error(`contact-secrets decode failed: missing ${keyName}`);
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    logDecodeInvalidKey({ keyName, raw, peerAccountDigest, peerDeviceId, sourceTag, reason: 'invalid-counter' });
    throw new Error(`contact-secrets decode failed: invalid ${keyName}`);
  }
  return num;
}

function decodeKeyString(raw, { keyName, peerAccountDigest = null, peerDeviceId = null, sourceTag = null } = {}) {
  const normalized = normalizeB64Input(raw);
  if (!normalized) {
    logDecodeInvalidKey({ keyName, raw, peerAccountDigest, peerDeviceId, sourceTag, reason: 'empty-normalized' });
    throw new Error(`contact-secrets decode failed: ${keyName} empty`);
  }
  try {
    return b64u8(normalized);
  } catch (err) {
    const message = err?.message || err;
    logDecodeInvalidKey({ keyName, raw, peerAccountDigest, peerDeviceId, sourceTag, reason: 'decode-failed', error: message });
    throw new Error(`contact-secrets decode failed: ${keyName} invalid base64`);
  }
}

function logKeyType(tag, value) {
  try {
    const info = value ? {
      tag,
      type: typeof value,
      ctor: value?.constructor?.name || null,
      isView: ArrayBuffer.isView(value),
      byteLength: typeof value?.byteLength === 'number' ? value.byteLength : null,
      length: typeof value?.length === 'number' ? value.length : null
    } : { tag, value: null };
    drConsole.warn('[dr-log:key-type]', info);
  } catch {}
}

function assertU8(tag, value) {
  const ok = value instanceof Uint8Array;
  if (ok) return value;
  logKeyType(tag, value);
  throw new Error(`DR key not Uint8Array: ${tag}`);
}

function buildReceiptMessageId(targetMessageId) {
  const base = typeof targetMessageId === 'string' && targetMessageId.trim()
    ? targetMessageId.trim()
    : null;
  if (!base) {
    throw new Error('target messageId required for receipt');
  }
  return crypto.randomUUID();
}

function sanitizeSnapshotInput(snapshot, { sourceTag = 'snapshot', peerAccountDigest = null, peerDeviceId = null } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const keyCtx = { peerAccountDigest, peerDeviceId, sourceTag };
  const nsTotal = requireSnapshotCounter(snapshot, 'NsTotal', 'Ns_total', keyCtx);
  const nrTotal = requireSnapshotCounter(snapshot, 'NrTotal', 'Nr_total', keyCtx);
  const rk = requireSnapshotKeyString(snapshot, 'rk_b64', 'rk', { required: true, ...keyCtx });
  if (!rk) return null;
  const out = {
    v: Number.isFinite(Number(snapshot.v)) ? Number(snapshot.v) : 1,
    rk_b64: rk,
    ckS_b64: requireSnapshotKeyString(snapshot, 'ckS_b64', 'ckS', { ...keyCtx }),
    ckR_b64: requireSnapshotKeyString(snapshot, 'ckR_b64', 'ckR', { ...keyCtx }),
    Ns: numberOrDefault(snapshot.Ns, 0),
    Nr: numberOrDefault(snapshot.Nr, 0),
    PN: numberOrDefault(snapshot.PN, 0),
    NsTotal: nsTotal,
    NrTotal: nrTotal,
    myRatchetPriv_b64: requireSnapshotKeyString(snapshot, 'myRatchetPriv_b64', 'myRatchetPriv', { ...keyCtx, allowNull: true }),
    myRatchetPub_b64: requireSnapshotKeyString(snapshot, 'myRatchetPub_b64', 'myRatchetPub', { ...keyCtx, allowNull: true }),
    theirRatchetPub_b64: requireSnapshotKeyString(snapshot, 'theirRatchetPub_b64', 'theirRatchetPub', { ...keyCtx, allowNull: true }),
    pendingSendRatchet: !!snapshot.pendingSendRatchet,
    role: typeof snapshot.role === 'string' ? snapshot.role.trim() || null : null,
    selfDeviceId: typeof snapshot.selfDeviceId === 'string' ? snapshot.selfDeviceId.trim() || null : null,
    updatedAt: (() => {
      const ts = Number(snapshot.updatedAt ?? snapshot.snapshotTs ?? snapshot.ts);
      return Number.isFinite(ts) && ts > 0 ? ts : null;
    })()
  };
  return out;
}

function detectSnapshotCorruption(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { badField: 'snapshot', reason: 'not-object', type: typeof snapshot };
  }
  const checkField = (key, { required = false } = {}) => {
    const raw = snapshot[key];
    const present = Object.prototype.hasOwnProperty.call(snapshot, key) || raw !== undefined;
    if (!present) return required ? { badField: key, reason: 'missing', type: 'undefined' } : null;
    if (raw === null) return { badField: key, reason: 'null', type: 'object' };
    if (typeof raw !== 'string') return { badField: key, reason: 'not-string', type: typeof raw };
    if (!raw.trim()) return { badField: key, reason: 'empty-string', type: 'string' };
    return null;
  };
  const requiredFields = ['rk_b64', 'theirRatchetPub_b64', 'myRatchetPriv_b64', 'myRatchetPub_b64'];
  for (const field of requiredFields) {
    const invalid = checkField(field, { required: true });
    if (invalid) return invalid;
  }
  const optionalFields = ['ckR_b64', 'ckS_b64'];
  for (const field of optionalFields) {
    const invalid = checkField(field, { required: false });
    if (invalid && invalid.reason !== 'missing') return invalid;
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (!key.endsWith('_b64')) continue;
    const invalid = checkField(key, { required: false });
    if (invalid) return invalid;
  }
  return null;
}

function prevalidateSnapshotOrQuarantine(snapshot, { peerAccountDigest = null, peerDeviceId = null, peerKey = null, sourceTag = null } = {}) {
  const normalizedPeerKey = peerKey || normalizePeerKeyForQuarantine({
    peerAccountDigest,
    peerDeviceId,
    sourceTag: sourceTag || 'prevalidateSnapshotOrQuarantine'
  });
  const logSource = sourceTag || 'prevalidateSnapshotOrQuarantine';
  if (snapshot === null || snapshot === undefined) {
    if (normalizedPeerKey) {
      recordPendingContact(normalizedPeerKey, 'missing-snapshot', { source: logSource, peerDeviceId });
      logDrStateDebug('pending_missing_material', { peerKey: normalizedPeerKey, sourceTag: logSource });
    }
    return { ok: false, snapshot: null, pending: true, badField: 'snapshot', reason: 'missing', type: 'undefined' };
  }
  const invalid = detectSnapshotCorruption(snapshot);
  if (!invalid) {
    if (normalizedPeerKey) clearPendingContact(normalizedPeerKey);
    return { ok: true, snapshot };
  }
  if (normalizedPeerKey) {
    clearPendingContact(normalizedPeerKey);
    quarantineCorruptContact(normalizedPeerKey, 'invalid-dr-snapshot', {
      badField: invalid.badField,
      type: invalid.type,
      source: logSource
    });
    const missingFields = invalid.reason === 'missing' ? [invalid.badField] : [];
    const typeErrors = invalid.reason !== 'missing' ? [invalid.badField] : [];
    logDrStateDebug('corrupt_invalid_format', {
      peerKey: normalizedPeerKey,
      missingFields,
      typeErrors,
      sourceTag: logSource
    });
  }
  return { ok: false, snapshot: null, badField: invalid.badField, reason: invalid.reason, type: invalid.type };
}

const MAX_HISTORY_ENTRIES = 120;
function compareHistoryKeys(aTs, aId, bTs, bId) {
  const aHasTs = Number.isFinite(aTs);
  const bHasTs = Number.isFinite(bTs);
  if (aHasTs && bHasTs && aTs !== bTs) return aTs - bTs;
  if (aHasTs && !bHasTs) return 1;
  if (!aHasTs && bHasTs) return -1;
  if (aId && bId && aId !== bId) return aId.localeCompare(bId);
  if (aId && !bId) return 1;
  if (!aId && bId) return -1;
  return 0;
}

function appendDrHistoryEntry(params = {}) {
  const { ts, snapshot, snapshotNext, messageId, messageKeyB64 } = params;
  const peer = resolvePeerDigest(params);
  const stamp = Number(ts);
  if (!peer || !snapshot || !Number.isFinite(stamp)) return false;
  const deviceId = ensureDeviceId();
  const info = getContactSecret(peer, { deviceId });
  const history = Array.isArray(info.drHistory) ? info.drHistory.slice() : [];
  const idx = history.findIndex((entry) => {
    if (messageId && entry?.messageId) return entry.messageId === messageId;
    if (entry?.messageId || messageId) return false;
    return Number(entry?.ts) === stamp;
  });
  let preservedKey = null;
  if (idx >= 0) {
    const existing = history.splice(idx, 1)[0];
    if (existing?.messageKey_b64) preservedKey = existing.messageKey_b64;
  }
  const entry = {
    ts: stamp,
    messageId: messageId || null,
    snapshot,
    messageKey_b64: messageKeyB64 || preservedKey || null
  };
  if (snapshotNext) entry.snapshotAfter = snapshotNext;
  history.push(entry);
  history.sort((a, b) => compareHistoryKeys(Number(a?.ts), a?.messageId || null, Number(b?.ts), b?.messageId || null));
  while (history.length > MAX_HISTORY_ENTRIES) history.shift();
  setContactSecret(peer, {
    deviceId,
    dr: { history },
    meta: { source: 'dr-history-append' }
  });
  if (isAutomationEnv()) {
    drConsole.log('[dr-history-append]', JSON.stringify({
      peerAccountDigest: peer,
      ts: stamp,
      messageId: messageId || null,
      hasSnapshotAfter: !!entry.snapshotAfter,
      hasMessageKey: !!(messageKeyB64 || preservedKey),
      length: history.length
    }));
  }
  return true;
}

function restoreDrStateFromHistory(params = {}) {
  throw new Error('DR history restore disabled；請重新同步好友或重新建立邀請');
}

export function restoreDrStateToHistoryPoint(params = {}) {
  return restoreDrStateFromHistory(params);
}

function updateHistoryCursor(params = {}) {
  const { ts, messageId } = params;
  const peer = resolvePeerDigest(params);
  const peerDeviceId = params?.peerDeviceId ?? null;
  if (!peer || !peerDeviceId) return;
  const deviceId = ensureDeviceId();
  const info = getContactSecret(peer, { deviceId });
  const stamp = Number(ts);
  const currentTs = Number.isFinite(info.drHistoryCursorTs) ? Number(info.drHistoryCursorTs) : null;
  const cursorId = info.drHistoryCursorId || null;
  const hasExistingCursor = currentTs !== null || !!cursorId;
  const cursorCompare = compareHistoryKeys(Number.isFinite(stamp) ? stamp : null, messageId || null, currentTs, cursorId);
  if (hasExistingCursor && cursorCompare <= 0) {
    return;
  }
  setContactSecret(peer, {
    deviceId,
    dr: {
      cursor: {
        ts: Number.isFinite(stamp) ? stamp : null,
        id: messageId || null
      }
    },
    meta: { source: 'dr-history-cursor' }
  });
  if (isAutomationEnv()) {
    drConsole.log('[dr-history-cursor]', JSON.stringify({
      peerAccountDigest: peer,
      ts: Number.isFinite(stamp) ? stamp : null,
      messageId: messageId || null
    }));
  }
}

export function snapshotDrState(state, { setDefaultUpdatedAt = true } = {}) {
  const logPersistInvalidKey = (keyName, raw, reason) => {
    try {
      drConsole.warn('[contact-secrets:persist-invalid-key]', {
        keyName,
        source: 'snapshotDrState',
        reason: reason || null,
        type: typeof raw,
        ctor: raw?.constructor?.name || null,
        isView: ArrayBuffer.isView(raw),
        byteLength: typeof raw?.byteLength === 'number' ? raw.byteLength : null,
        length: typeof raw?.length === 'number' ? raw.length : null
      });
    } catch {}
  };
  const ensureKeyU8 = (value, keyName, required = false) => {
    if (value === undefined || value === null) {
      if (required) {
        logPersistInvalidKey(keyName, value, 'missing');
        throw new Error(`contact-secrets persist blocked: missing ${keyName}`);
      }
      return null;
    }
    if (!(value instanceof Uint8Array)) {
      logPersistInvalidKey(keyName, value, 'not-uint8array');
      throw new Error(`contact-secrets persist blocked: ${keyName} not Uint8Array`);
    }
    return value;
  };
  const rkU8 = ensureKeyU8(state?.rk, 'rk', true);
  const ckSU8 = ensureKeyU8(state?.ckS, 'ckS', false);
  const ckRU8 = ensureKeyU8(state?.ckR, 'ckR', false);
  const nsTotal = requireTransportCounter(state, { sourceTag: 'snapshotDrState' });
  const nrTotal = numberOrDefault(state.NrTotal, 0);
  const selfDeviceId = ensureDeviceId() || null;
  const snap = {
    v: 1,
    rk_b64: b64(rkU8),
    Ns: numberOrDefault(state.Ns, 0),
    Nr: numberOrDefault(state.Nr, 0),
    PN: numberOrDefault(state.PN, 0),
    NsTotal: nsTotal,
    NrTotal: nrTotal,
    myRatchetPriv_b64: state.myRatchetPriv instanceof Uint8Array ? b64(state.myRatchetPriv) : null,
    myRatchetPub_b64: state.myRatchetPub instanceof Uint8Array ? b64(state.myRatchetPub) : null,
    theirRatchetPub_b64: state.theirRatchetPub instanceof Uint8Array ? b64(state.theirRatchetPub) : null,
    pendingSendRatchet: !!state.pendingSendRatchet,
    role: state.baseKey?.role || null,
    selfDeviceId,
    updatedAt: Number.isFinite(state.snapshotTs) && state.snapshotTs > 0 ? state.snapshotTs : null
  };
  if (ckSU8) snap.ckS_b64 = b64(ckSU8);
  if (ckRU8) snap.ckR_b64 = b64(ckRU8);
  if (setDefaultUpdatedAt && !snap.updatedAt) snap.updatedAt = Date.now();
  try {
    drConsole.log('[msg] state:snapshot', JSON.stringify({
      conversationId: state?.baseKey?.conversationId || null,
      peerDigest: state?.baseKey?.peerAccountDigest || null,
      peerDeviceId: state?.baseKey?.peerDeviceId || null,
      NsTotal: snap.NsTotal,
      NrTotal: snap.NrTotal
    }));
  } catch {}
  return snap;
}

export function snapshotDrStateForPeer(params = {}) {
  const { digest, deviceId } = ensurePeerIdentity({
    peerAccountDigest: params?.peerAccountDigest ?? params,
    peerDeviceId: params?.peerDeviceId ?? null,
    conversationId: params?.conversationId ?? null
  });
  const holder = drState({ peerAccountDigest: digest, peerDeviceId: deviceId });
  if (!holder?.rk) return null;
  return snapshotDrState(holder);
}

export function restoreDrStateFromSnapshot(params = {}) {
  const { snapshot, force = false, targetState = null, sourceTag = 'snapshot' } = params;
  const peer = resolvePeerDigest(params);
  const peerDeviceId = params?.peerDeviceId ?? null;
  const selfDeviceId = ensureDeviceId();
  const snapshotSelfDeviceIdRaw = typeof snapshot?.selfDeviceId === 'string' ? snapshot.selfDeviceId : null;
  const snapshotRoleRaw = typeof snapshot?.role === 'string' ? snapshot.role.trim() || null : null;
  let data = null;
  const logReject = (reason) => {
    const snapshotSelfDeviceId = typeof data?.selfDeviceId === 'string' ? data.selfDeviceId : snapshotSelfDeviceIdRaw;
    const role = typeof data?.role === 'string' ? data.role : snapshotRoleRaw;
    logDrSnapshotRestoreReject({
      reason,
      peerAccountDigestSuffix4: suffix(peer, 4),
      peerDeviceIdSuffix4: suffix(peerDeviceId, 4),
      selfDeviceIdSuffix4: suffix(selfDeviceId, 4),
      snapshotSelfDeviceIdSuffix4: suffix(snapshotSelfDeviceId, 4),
      role: role || null,
      stateKeySuffix6: stateKeySuffix6(peer, peerDeviceId)
    });
  };
  if (!peer && !targetState) {
    logReject('SANITIZE_MISSING_FIELD');
    return false;
  }
  data = sanitizeSnapshotInput(snapshot, { sourceTag, peerAccountDigest: peer, peerDeviceId });
  if (!data) {
    logReject('SNAPSHOT_SCHEMA_INVALID');
    return false;
  }
  // 丟棄非本機裝置的 responder 快照，避免 guest 端錯用對端狀態。
  if (selfDeviceId) {
    if (data.selfDeviceId && data.selfDeviceId !== selfDeviceId) {
      logReject('SELF_DEVICE_MISMATCH');
      return false;
    }
    if (!data.selfDeviceId && data.role && data.role.toLowerCase() === 'responder' && peerDeviceId && selfDeviceId !== peerDeviceId) {
      logReject('PEER_DEVICE_MISMATCH');
      return false;
    }
  }
  const holder = targetState || drState({ peerAccountDigest: peer, peerDeviceId });
  if (!holder) {
    logReject('SANITIZE_MISSING_FIELD');
    return false;
  }
  // 若已有 send 鏈且 Ns>0，避免被缺 send 鏈或較小 Ns 的快照覆蓋。
  const hasExistingSend = holder?.ckS instanceof Uint8Array && holder.ckS.length > 0 && Number.isFinite(holder?.Ns) && Number(holder.Ns) > 0;
  const incomingHasSend = !!data.ckS_b64 && typeof data.ckS_b64 === 'string';
  const incomingNs = Number.isFinite(data.Ns) ? Number(data.Ns) : null;
  const downgrade = hasExistingSend && (!incomingHasSend || (incomingNs !== null && incomingNs < Number(holder.Ns || 0)));
  if (!force && downgrade) {
    if (isAutomationEnv()) {
      drConsole.warn('[dr-restore-skip-downgrade]', JSON.stringify({
        peerAccountDigest: peer,
        peerDeviceId,
        existingNs: Number(holder.Ns) || null,
        incomingNs,
        incomingHasSend,
        sourceTag
      }));
    }
    logReject('ROLE_GATING_REJECT');
    return false;
  }
  if (!targetState && !force && holder?.rk && holder.snapshotTs && data.updatedAt && holder.snapshotTs >= data.updatedAt) {
    logReject('ROLE_GATING_REJECT');
    return false;
  }
  holder.rk = decodeKeyString(data.rk_b64, { keyName: 'rk', peerAccountDigest: peer, peerDeviceId, sourceTag });
  holder.ckS = data.ckS_b64 ? decodeKeyString(data.ckS_b64, { keyName: 'ckS', peerAccountDigest: peer, peerDeviceId, sourceTag }) : null;
  holder.ckR = data.ckR_b64 ? decodeKeyString(data.ckR_b64, { keyName: 'ckR', peerAccountDigest: peer, peerDeviceId, sourceTag }) : null;
  ensureHolderId(holder);
  assertU8('restoreDrStateFromSnapshot:rk', holder.rk);
  if (holder.ckS) assertU8('restoreDrStateFromSnapshot:ckS', holder.ckS);
  if (holder.ckR) assertU8('restoreDrStateFromSnapshot:ckR', holder.ckR);
  const nsTotal = Number(data.NsTotal);
  if (!Number.isFinite(nsTotal)) {
    throw new Error('dr snapshot missing NsTotal');
  }
  const nrTotal = Number(data.NrTotal);
  if (!Number.isFinite(nrTotal)) {
    throw new Error('dr snapshot missing NrTotal');
  }
  holder.Ns = numberOrDefault(data.Ns, holder.Ns || 0);
  holder.Nr = numberOrDefault(data.Nr, holder.Nr || 0);
  holder.PN = numberOrDefault(data.PN, holder.PN || 0);
  holder.NsTotal = nsTotal;
  holder.NrTotal = nrTotal;
  holder.myRatchetPriv = data.myRatchetPriv_b64
    ? decodeKeyString(data.myRatchetPriv_b64, { keyName: 'myRatchetPriv', peerAccountDigest: peer, peerDeviceId, sourceTag })
    : null;
  holder.myRatchetPub = data.myRatchetPub_b64
    ? decodeKeyString(data.myRatchetPub_b64, { keyName: 'myRatchetPub', peerAccountDigest: peer, peerDeviceId, sourceTag })
    : null;
  holder.theirRatchetPub = data.theirRatchetPub_b64
    ? decodeKeyString(data.theirRatchetPub_b64, { keyName: 'theirRatchetPub', peerAccountDigest: peer, peerDeviceId, sourceTag })
    : null;
  holder.pendingSendRatchet = !!data.pendingSendRatchet;
  const snapshotTs = data.updatedAt || Date.now();
  if (targetState) {
    holder.snapshotTs = snapshotTs;
    holder.snapshotSource = sourceTag;
    holder.baseKey = holder.baseKey ? { ...holder.baseKey, snapshot: true } : { snapshot: true };
    if (data.role) holder.baseKey.role = data.role;
  } else {
    markHolderSnapshot(holder, 'snapshot', snapshotTs);
    holder.baseKey = holder.baseKey || {};
    holder.baseKey.snapshot = true;
    if (data.role) holder.baseKey.role = data.role;
  }
  holder.__lastWriteTag = sourceTag || 'restoreDrStateFromSnapshot';
  if (DEBUG.drCounter) {
    try {
      log({
        hydrateDrState: {
          conversationId: holder?.baseKey?.conversationId || null,
          peerDigest: peer || null,
          peerDeviceId: peerDeviceId || null,
          NsTotal: holder?.NsTotal ?? null,
          NrTotal: holder?.NrTotal ?? null,
          peerKey: `${peer || 'unknown'}::${peerDeviceId || 'unknown'}`,
          sourceTag: 'hydrate'
        }
      });
    } catch {}
  }
  return true;
}

export function persistDrSnapshot(params = {}) {
  const { state, snapshot } = params;
  const { digest: peer, deviceId: peerDeviceId } = ensurePeerIdentity({
    peerAccountDigest: params?.peerAccountDigest ?? params,
    peerDeviceId: params?.peerDeviceId ?? (state?.baseKey?.peerDeviceId || null),
    conversationId: params?.conversationId ?? null
  });
  const holder = state || drState({ peerAccountDigest: peer, peerDeviceId });
  if (!holder?.rk) {
    try {
      drConsole.warn('[dr] persist snapshot skipped: missing holder rk', { peerAccountDigest: peer, peerDeviceId });
    } catch {}
    return false;
  }
  assertU8('persistDrSnapshot:rk', holder.rk);
  if (holder.ckS) assertU8('persistDrSnapshot:ckS', holder.ckS);
  if (holder.ckR) assertU8('persistDrSnapshot:ckR', holder.ckR);
  const snap = snapshot || snapshotDrState(holder);
  if (!snap) {
    try {
      drConsole.warn('[dr] persist snapshot skipped: missing snapshot', { peerAccountDigest: peer, peerDeviceId });
    } catch {}
    return false;
  }
  // contact secret 以「本機裝置」為鍵，peerDeviceId 僅為對端識別；寫入使用 self deviceId。
  const selfDeviceId = ensureDeviceId();
  const info = getContactSecret(peer, { deviceId: selfDeviceId, peerDeviceId });
  try {
    const holderRoleRaw = holder?.baseKey?.role || info?.role || null;
    const holderRole = typeof holderRoleRaw === 'string' ? holderRoleRaw : null;
    if (!holderRole) {
      drConsole.error('[dr] persist snapshot failed: missing role', {
        peerAccountDigest: peer,
        peerDeviceId,
        deviceId: selfDeviceId,
        Ns: snap?.Ns ?? null,
        Nr: snap?.Nr ?? null
      });
      return false;
    }
    const update = {
      dr: { state: snap },
      meta: { source: 'persistDrSnapshot' },
      role: holderRole
    };
    const conversationUpdate = {};
    const baseConversationId = typeof holder?.baseKey?.conversationId === 'string' ? holder.baseKey.conversationId : null;
    if (info?.conversationToken) conversationUpdate.token = info.conversationToken;
    if (info?.conversationId || baseConversationId) conversationUpdate.id = info?.conversationId || baseConversationId;
    if (info?.conversationDrInit) conversationUpdate.drInit = info.conversationDrInit;
    if (Object.keys(conversationUpdate).length) update.conversation = conversationUpdate;
    // 若現存快照有 send 鏈且 Ns>0，而新快照缺 send 鏈或 Ns 更低，避免覆蓋成 0。
    const existingSnap = info?.drState || null;
    const existingNs = Number.isFinite(existingSnap?.Ns) ? Number(existingSnap.Ns) : null;
    const existingTotal = Number(existingSnap?.NsTotal || 0) + Number(existingSnap?.Ns || 0);
    const newNs = Number.isFinite(snap?.Ns) ? Number(snap.Ns) : null;
    const newTotal = Number(snap?.NsTotal || 0) + Number(snap?.Ns || 0);
    const holderTotal = Number(holder?.NsTotal || 0) + Number(holder?.Ns || 0);
    const hasExistingSend = !!(existingSnap?.ckS || existingSnap?.ckS_b64) && Number(existingNs) > 0;
    const hasExistingRecv = !!(existingSnap?.ckR || existingSnap?.ckR_b64) && Number.isFinite(existingSnap?.Nr) && Number(existingSnap.Nr) >= 0;
    const lacksNewSend = !(snap?.ckS || snap?.ckS_b64);
    const lacksNewRecv = !(snap?.ckR || snap?.ckR_b64);
    const nsDowngrade = Number.isFinite(existingNs) && Number.isFinite(newNs) && newNs < existingNs;
    const totalDowngrade = Number.isFinite(existingTotal) && Number.isFinite(newTotal) && newTotal < existingTotal;
    const holderDowngrade = Number.isFinite(holderTotal) && Number.isFinite(newTotal) && newTotal < holderTotal;
    if (
      (hasExistingSend && (lacksNewSend || nsDowngrade || totalDowngrade || holderDowngrade))
      || (hasExistingRecv && lacksNewRecv)
    ) {
      if (DEBUG.drCounter) {
        log({
          persistSnapshotSkippedDowngrade: {
            conversationId: holder?.baseKey?.conversationId || baseConversationId || null,
            convId: holder?.baseKey?.conversationId || baseConversationId || null,
            peerKey: `${peer || 'unknown'}::${peerDeviceId || 'unknown'}`,
            peerAccountDigest: peer,
            peerDeviceId,
            deviceId: selfDeviceId,
            existingNs,
            newNs,
            hasExistingSend,
            hasExistingRecv,
            lacksNewSend,
            lacksNewRecv,
            nsDowngrade,
            totalDowngrade,
            holderDowngrade,
            existingTotal,
            newTotal,
            holderTotal,
            reason: 'downgrade-check'
          }
        });
      }
      return false;
    }
    setContactSecret(peer, { ...update, deviceId: selfDeviceId, peerDeviceId });
    markHolderSnapshot(holder, 'persist', snap.updatedAt || Date.now());
    if (DEBUG.drCounter) {
      try {
        drConsole.log('[dr-log:persist-snapshot]', {
          peerAccountDigest: peer,
          peerDeviceId,
          deviceId: selfDeviceId,
          Ns: snap?.Ns ?? null,
          Nr: snap?.Nr ?? null,
          conversationId: holder?.baseKey?.conversationId || null,
          stateKey: `${peer}::${peerDeviceId || 'unknown'}`,
          secretRole: info?.role || null,
          holderRole: holderRole
        });
      } catch {}
    }
    return true;
  } catch (err) {
    drConsole.warn('[dr] persist snapshot failed', err);
    const msg = err?.message || '';
    if (msg.includes('NsTotal') || msg.toLowerCase().includes('transport counter')) {
      throw err;
    }
    return false;
  }
}

export function hydrateDrStatesFromContactSecrets() {
  return 0;
}

export function copyDrState(target, source, { callsiteTag = 'copyDrState' } = {}) {
  if (!target || !source) return;
  ensureHolderId(target);
  target.rk = cloneU8(source.rk, 'rk', callsiteTag) || null;
  target.ckS = cloneU8(source.ckS, 'ckS', callsiteTag) || null;
  target.ckR = cloneU8(source.ckR, 'ckR', callsiteTag) || null;
  target.Ns = Number(source.Ns || 0);
  target.Nr = Number(source.Nr || 0);
  target.PN = Number(source.PN || 0);
  target.NsTotal = Number.isFinite(source.NsTotal) ? Number(source.NsTotal) : numberOrDefault(target.NsTotal, 0);
  target.NrTotal = Number.isFinite(source.NrTotal) ? Number(source.NrTotal) : numberOrDefault(target.NrTotal, 0);
  if (!Number.isFinite(target.NsTotal)) target.NsTotal = 0;
  if (!Number.isFinite(target.NrTotal)) target.NrTotal = 0;
  if (!target.__bornReason && callsiteTag) target.__bornReason = callsiteTag;
  target.myRatchetPriv = cloneU8(source.myRatchetPriv, 'myRatchetPriv', callsiteTag) || null;
  target.myRatchetPub = cloneU8(source.myRatchetPub, 'myRatchetPub', callsiteTag) || null;
  target.theirRatchetPub = cloneU8(source.theirRatchetPub, 'theirRatchetPub', callsiteTag) || null;
  target.__lastWriteTag = callsiteTag || null;
  target.pendingSendRatchet = !!source.pendingSendRatchet;
  if (source.baseKey) {
    target.baseKey = target.baseKey || {};
    if (source.baseKey.conversationId && !target.baseKey.conversationId) {
      target.baseKey.conversationId = source.baseKey.conversationId;
    }
    if (source.baseKey.role) {
      target.baseKey.role = source.baseKey.role;
    }
    if (source.baseKey.peerDeviceId) {
      target.baseKey.peerDeviceId = source.baseKey.peerDeviceId;
    }
    if (source.baseKey.peerAccountDigest) {
      target.baseKey.peerAccountDigest = source.baseKey.peerAccountDigest;
    }
  }
  if (Number.isFinite(source.snapshotTs)) {
    target.snapshotTs = source.snapshotTs;
  }
  if (source.snapshotSource) {
    target.snapshotSource = source.snapshotSource;
  }
  const peerDigest = target?.baseKey?.peerAccountDigest || source?.baseKey?.peerAccountDigest || null;
  const peerDeviceId = target?.baseKey?.peerDeviceId || source?.baseKey?.peerDeviceId || null;
  const conversationId = target?.baseKey?.conversationId || source?.baseKey?.conversationId || null;
  try {
    drConsole.log('[msg] state:clone', JSON.stringify({
      peerDigest,
      peerDeviceId,
      conversationId,
      NsTotal: target.NsTotal,
      NrTotal: target.NrTotal,
      source: callsiteTag || null
    }));
  } catch {}
}

function cloneSkippedKeysStore(input) {
  if (!(input instanceof Map)) return new Map();
  const out = new Map();
  for (const [chainId, chain] of input.entries()) {
    if (chain instanceof Map) {
      out.set(chainId, new Map(chain));
    }
  }
  return out;
}

function createDrStateShell() {
  const shell = {
    rk: null,
    ckS: null,
    ckR: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    NsTotal: 0,
    NrTotal: 0,
    myRatchetPriv: null,
    myRatchetPub: null,
    theirRatchetPub: null,
    pendingSendRatchet: false,
    baseKey: null,
    snapshotTs: null,
    snapshotSource: null,
    historyCursorTs: null,
    historyCursorId: null,
    skippedKeys: new Map(),
    __bornReason: 'state-shell'
  };
  try {
    drConsole.log('[msg] state:init-transport-counter', JSON.stringify({
      conversationId: shell?.baseKey?.conversationId || null,
      peerDigest: shell?.baseKey?.peerAccountDigest || null,
      peerDeviceId: shell?.baseKey?.peerDeviceId || null,
      NsTotal: shell.NsTotal,
      NrTotal: shell.NrTotal,
      reason: shell.__bornReason
    }));
  } catch {}
  return shell;
}

export function cloneDrStateHolder(source) {
  const shell = createDrStateShell();
  if (!source) return shell;
  copyDrState(shell, source, { callsiteTag: 'snapshotDrState:copy' });
  shell.pendingSendRatchet = !!source.pendingSendRatchet;
  shell.baseKey = source.baseKey ? { ...source.baseKey } : (shell.baseKey || null);
  shell.snapshotTs = Number.isFinite(source.snapshotTs) ? source.snapshotTs : shell.snapshotTs;
  shell.snapshotSource = source.snapshotSource || shell.snapshotSource;
  shell.historyCursorTs = Number.isFinite(source.historyCursorTs) ? source.historyCursorTs : null;
  shell.historyCursorId = source.historyCursorId || null;
  shell.skippedKeys = cloneSkippedKeysStore(source.skippedKeys);
  return shell;
}

async function ensureDevicePrivLoaded() {
  return ensureDevicePrivAvailable();
}

function assertNoExtraKeys(obj, allowed, label) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} unexpected field: ${key}`);
    }
  }
}

function normalizeGuestBundleStrict(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('guest bundle missing');
  }
  const allowed = new Set(['ik_pub', 'spk_pub', 'spk_sig', 'opk_id', 'opk_pub', 'ek_pub']);
  assertNoExtraKeys(bundle, allowed, 'guest bundle');
  const ikPubB64 = typeof bundle.ik_pub === 'string' ? bundle.ik_pub.trim() : '';
  const spkPubB64 = typeof bundle.spk_pub === 'string' ? bundle.spk_pub.trim() : '';
  const signatureB64 = typeof bundle.spk_sig === 'string' ? bundle.spk_sig.trim() : '';
  const ekPubB64 = typeof bundle.ek_pub === 'string' ? bundle.ek_pub.trim() : '';
  const opkIdRaw = bundle.opk_id;
  if (!ikPubB64 || !spkPubB64 || !signatureB64 || !ekPubB64) {
    throw new Error('guest bundle missing keys');
  }
  if (opkIdRaw === null || opkIdRaw === undefined || opkIdRaw === '') {
    throw new Error('guest bundle missing opk_id');
  }
  const opkId = Number(opkIdRaw);
  if (!Number.isFinite(opkId) || opkId < 0) {
    throw new Error('guest bundle invalid opk_id');
  }
  return {
    ik_pub: ikPubB64,
    spk_pub: spkPubB64,
    spk_sig: signatureB64,
    opk_id: opkId,
    ek_pub: ekPubB64
  };
}

function normalizePeerBundleFromPrekeys(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('peer bundle missing');
  }
  const topAllowed = new Set(['ok', 'deviceId', 'signedPrekey', 'opk']);
  assertNoExtraKeys(bundle, topAllowed, 'peer bundle');
  const signedPrekey = bundle.signedPrekey;
  const opk = bundle.opk;
  if (!signedPrekey || typeof signedPrekey !== 'object' || Array.isArray(signedPrekey)) {
    throw new Error('peer bundle missing signedPrekey');
  }
  if (!opk || typeof opk !== 'object' || Array.isArray(opk)) {
    throw new Error('peer bundle missing opk');
  }
  const spkAllowed = new Set(['id', 'pub', 'sig', 'ik_pub']);
  const opkAllowed = new Set(['id', 'pub']);
  assertNoExtraKeys(signedPrekey, spkAllowed, 'signedPrekey');
  assertNoExtraKeys(opk, opkAllowed, 'opk');
  const ikPub = typeof signedPrekey.ik_pub === 'string' ? signedPrekey.ik_pub.trim() : '';
  const spkPub = typeof signedPrekey.pub === 'string' ? signedPrekey.pub.trim() : '';
  const spkSig = typeof signedPrekey.sig === 'string' ? signedPrekey.sig.trim() : '';
  const opkId = Number(opk.id);
  const opkPub = typeof opk.pub === 'string' ? opk.pub.trim() : '';
  if (!ikPub || !spkPub || !spkSig) throw new Error('signedPrekey missing keys');
  if (!Number.isFinite(opkId) || !opkPub) throw new Error('opk missing keys');
  return {
    ik_pub: ikPub,
    spk_pub: spkPub,
    spk_sig: spkSig,
    opk: { id: opkId, pub: opkPub }
  };
}

/**
 * 確保（本端→對方）的 DR 會話已初始化。
 * 會：
 *  - 若記憶體中尚無 devicePriv，等待登入 handoff（sessionStorage）或拋錯提醒重新登入
 *  - 呼叫 /keys/bundle 取得對方 bundle，執行 x3dhInitiate()，把狀態寫回 store.drState(peer)
 * @param {{ peerAccountDigest?: string }} p
 * @returns {Promise<{ initialized: boolean }>} 
 */
export async function ensureDrSession(params = {}) {
  const { digest: peer, deviceId: peerDeviceId } = ensurePeerIdentity({
    peerAccountDigest: params?.peerAccountDigest ?? params,
    peerDeviceId: params?.peerDeviceId ?? null,
    conversationId: params?.conversationId ?? null
  });

  const holder = drState({ peerAccountDigest: peer, peerDeviceId });
  if (holder?.rk && holder?.myRatchetPriv && holder?.myRatchetPub) {
    return { initialized: true, reused: true };
  }

  const priv = await ensureDevicePrivLoaded();

  const { r: rb, data: bundle } = await prekeysBundle({ peer_accountDigest: peer });
  if (!rb.ok) throw new Error('prekeys.bundle failed: ' + (typeof bundle === 'string' ? bundle : JSON.stringify(bundle)));

  const peerBundle = normalizePeerBundleFromPrekeys(bundle);
  const st = await x3dhInitiate(priv, peerBundle);
  const targetHolder = holder || drState({ peerAccountDigest: peer, peerDeviceId });
  if (!targetHolder) throw new Error('DR holder missing for peer device');
  copyDrState(targetHolder, st, { callsiteTag: 'recoverDrState' });
  targetHolder.baseKey = { role: 'initiator', initializedAt: Date.now(), peerDeviceId };
  markHolderSnapshot(targetHolder, 'initiator', Date.now());
  persistDrSnapshot({ peerAccountDigest: peer, peerDeviceId, state: targetHolder });
  return { initialized: true };
}

function conversationContextForPeer(peerAccountDigest) {
  try {
    const identity = normalizePeerIdentity(peerAccountDigest);
    const peer = identity.accountDigest || normHex(peerAccountDigest);
    const peerKey = identity.key || (peer ? `${peer}::${identity.deviceId || ''}`.replace(/::$/, '') : null);
    if (!peer) return null;
    const selfDeviceId = ensureDeviceId();
    // contact-secrets 先查，避免 contactIndex 尚未刷新時拿不到 token。
    try {
      const secret =
        getContactSecret(peerKey || peer, { deviceId: selfDeviceId })
        || getContactSecret(peer, { deviceId: selfDeviceId, peerDeviceId: null })
        || getContactSecret(peer, { deviceId: null, peerDeviceId: null });
      if (secret?.conversationToken && secret?.conversationId) {
        const secretPeerDeviceId =
          normalizePeerDeviceId(secret.peerDeviceId || null)
          || normalizePeerDeviceId(secret?.conversation?.peerDeviceId || null);
        return {
          token_b64: secret.conversationToken,
          conversation_id: secret.conversationId,
          dr_init: secret.conversationDrInit || null,
          peerDeviceId: secretPeerDeviceId || null
        };
      }
    } catch (err) {
      drConsole.warn('[conversation] contact-secret lookup failed', err);
    }
    const contactIndex = sessionStore.contactIndex;
    const directKey = typeof peerAccountDigest === 'string' ? peerAccountDigest : null;
    const entry =
      contactIndex?.get?.(directKey) // 先試原始 key（可能含 ::deviceId）
      || (peerKey ? contactIndex?.get?.(peerKey) : null) // 再試解析出的 digest::deviceId
      || contactIndex?.get?.(peer)   // 再試純 digest
      || (() => {
        // 最後掃描 contactIndex，找出 digest 相同的 entry。
        if (!contactIndex || typeof contactIndex.entries !== 'function') return null;
        for (const [, info] of contactIndex.entries()) {
          const digest = normHex(info?.peerAccountDigest || info?.accountDigest || null);
          if (digest && digest === peer) return info;
        }
        return null;
      })();
    if (entry?.conversation?.token_b64) {
      return {
        token_b64: entry.conversation.token_b64,
        conversation_id: entry.conversation.conversation_id || null,
        dr_init: entry.conversation.dr_init || null
      };
    }
    const map = sessionStore.conversationIndex;
    if (map && typeof map.get === 'function') {
      for (const [convId, info] of map.entries()) {
        const peerMatch = normHex(info?.peerAccountDigest || null);
        if (peerMatch && peerMatch === peer && info?.token_b64) {
          return {
            token_b64: info.token_b64,
            conversation_id: convId,
            dr_init: info.dr_init || null,
            peerDeviceId: info.peerDeviceId || null
          };
        }
      }
    }
  } catch (err) {
    drConsole.warn('[conversation] lookup failed', err);
  }
  return null;
}

async function sendDrPlaintext(params = {}) {
  const { text, conversation, convId, metaOverrides = {}, peerDeviceId: peerDeviceInput = null } = params;
  const peer = resolvePeerDigest(params);
  if (!peer) throw new Error('peerAccountDigest required');

  const selfDigest = (getAccountDigest() || '').toUpperCase();
  if (selfDigest && peer && selfDigest === String(peer).toUpperCase()) {
    throw new Error('peerAccountDigest resolved to self (invalid)');
  }

  const peerDeviceId = peerDeviceInput || null;
  if (!peerDeviceId) {
    throw new Error('peerDeviceId required for secure send');
  }
  const selfDeviceId = ensureDeviceId();
  if (selfDeviceId && peerDeviceId === selfDeviceId) {
    throw new Error('peerDeviceId resolved to self device (invalid)');
  }

  const convContext = conversation || conversationContextForPeer({ peerAccountDigest: peer, peerDeviceId });
  const tokenB64 = convContext?.token_b64 || convContext?.tokenB64 || null;
  if (!tokenB64) throw new Error('conversation token missing for peer, please refresh contacts');

  let conversationId = convContext?.conversation_id || convContext?.conversationId || null;
  let state = drState({ peerAccountDigest: peer, peerDeviceId });
  let hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  const hasDrInit = !!(convContext?.dr_init?.guest_bundle);
  const preflightSecret = getContactSecret(peer, { deviceId: selfDeviceId, peerDeviceId }) || null;
  const preflightHasRk = !!(preflightSecret?.drState?.rk_b64 || preflightSecret?.drState?.rk);
  logSendPreflightTrace({
    peerKey: peerDeviceId ? `${peer}::${peerDeviceId}` : peer,
    peerAccountDigest: peer || null,
    peerDeviceId: peerDeviceId || null,
    secretPeerDeviceId: preflightSecret?.peerDeviceId || null,
    deviceId: selfDeviceId || null,
    role: preflightSecret?.role || null,
    hasRk: preflightHasRk,
    hasToken: !!(preflightSecret?.conversationToken || tokenB64),
    conversationId: preflightSecret?.conversationId || conversationId || null,
    hasDrInit
  });

  if (!hasDrState) {
    // 嚴禁 fallback：若缺會話，僅允許顯式重建，直接報錯。
    if (hasDrInit) {
      try {
        await ensureDrReceiverState({ peerAccountDigest: peer, peerDeviceId, conversationId });
      } catch (err) {
        const message = err?.message || String(err);
        if (message.includes('DR hydrate failed: restore returned false')) {
          logDrHydrateFailedTrace({
            stateKeySuffix6: stateKeySuffix6(peer, peerDeviceId),
            peerAccountDigestSuffix4: suffix(peer, 4),
            peerDeviceIdSuffix4: suffix(peerDeviceId, 4),
            selfDeviceIdSuffix4: suffix(selfDeviceId, 4),
            role: preflightSecret?.role || null,
            hasSnapshot: !!preflightSecret?.drState,
            hasToken: !!(preflightSecret?.conversationToken || tokenB64)
          });
        }
        throw err;
      }
    } else {
      throw new Error('尚未建立安全對話，請重新同步好友或重新建立邀請');
    }
    state = drState({ peerAccountDigest: peer, peerDeviceId });
    hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
    if (!hasDrState) {
      const err = new Error('contact-secrets persist blocked: missing rk');
      err.code = 'MISSING_RK';
      throw err;
    }
  }

  if (!hasDrState && !hasDrInit) {
    throw new Error('尚未建立安全對話，請重新同步好友或重新建立邀請');
  }
  if (!state.baseKey) state.baseKey = {};
  if (conversationId && state.baseKey.conversationId !== conversationId) {
    state.baseKey.conversationId = conversationId;
  }

  const messageId = typeof params?.messageId === 'string' && params.messageId.trim().length
    ? params.messageId.trim()
    : null;
  if (!messageId) {
    throw new Error('messageId required for send');
  }
  const msgType = typeof metaOverrides?.msg_type === 'string' && metaOverrides.msg_type.length
    ? metaOverrides.msg_type
    : 'text';

  let finalConversationId = conversationId;
  if (!finalConversationId) finalConversationId = await conversationIdFromToken(tokenB64);

  if (state?.baseKey?.snapshot === true) {
    await seedTransportCounterFromServer({
      conversationId: finalConversationId,
      peerAccountDigest: peer,
      peerDeviceId,
      state,
      sourceTag: 'send-preflight'
    });
  }

  const transportCounter = reserveTransportCounter(state, {
    peerAccountDigest: peer,
    peerDeviceId,
    conversationId: finalConversationId,
    messageId,
    msgType
  });

  const senderDeviceId = ensureDeviceId();
  const preSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false, forceNow: true });
  logDrSend('encrypt-before', { peerAccountDigest: peer, snapshot: preSnapshot || null });
  const pkt = await drEncryptText(state, text, { deviceId: senderDeviceId, version: 1 });
  const messageKeyB64 = pkt?.message_key_b64 || null;
  const afterEncryptTotal = Number(state?.NsTotal);
  if (!Number.isFinite(afterEncryptTotal) || afterEncryptTotal === transportCounter + 1 || afterEncryptTotal < transportCounter) {
    state.NsTotal = transportCounter;
  }
  const postSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  const now = Math.floor(Date.now() / 1000);
  const headerN = Number.isFinite(pkt?.header?.n) ? Number(pkt.header.n) : null;

  const accountDigest = (getAccountDigest() || '').toUpperCase(); // self
  const receiverAccountDigest = peer; // 目標必須鎖定對端
  const receiverDeviceId = peerDeviceId; // 目標裝置為對端指定 device

  const meta = {
    ts: now,
    sender_digest: accountDigest || null,
    senderDigest: accountDigest || null,
    sender_device_id: senderDeviceId || null,
    senderDeviceId: senderDeviceId || null,
    msg_type: msgType
  };
  if (metaOverrides && typeof metaOverrides === 'object') {
    for (const [key, value] of Object.entries(metaOverrides)) {
      if (key === 'msg_type' || key === 'ts' || key === 'sender_digest' || key === 'sender_device_id') continue;
      if (value === undefined) continue;
      meta[key] = value;
    }
  }
  meta.sender_digest = accountDigest || null;
  meta.senderDigest = accountDigest || null;
  meta.sender_device_id = senderDeviceId || null;
  meta.senderDeviceId = senderDeviceId || null;
  // 強制標記訊息目標：鎖定對端 digest/device，不允許 fallback。
  meta.targetAccountDigest = receiverAccountDigest;
  meta.target_account_digest = receiverAccountDigest;
  meta.receiverAccountDigest = receiverAccountDigest;
  meta.receiver_account_digest = receiverAccountDigest;
  meta.targetDeviceId = receiverDeviceId;
  meta.target_device_id = receiverDeviceId;
  meta.receiverDeviceId = receiverDeviceId;
  meta.receiver_device_id = receiverDeviceId;

  logDrCore('send:snapshot', {
    peerAccountDigest: peer,
    peerDeviceId,
    preNs: preSnapshot?.Ns ?? null,
    preNr: preSnapshot?.Nr ?? null,
    preHasCkS: !!preSnapshot?.ckS_b64,
    postNs: postSnapshot?.Ns ?? null,
    postNr: postSnapshot?.Nr ?? null,
    postHasCkS: !!postSnapshot?.ckS_b64,
    transportCounter,
    msgType: meta?.msg_type || null
  }, { level: 'log' });

  const headerPayload = {
    ...pkt.header,
    // peerAccountDigest 定義為「對方」身份，便於接收端驗證，不做任何 fallback
    peerAccountDigest: peer || null,
    peerDeviceId: peerDeviceId || null,
    iv_b64: pkt.iv_b64,
    meta
  };
  const headerJson = JSON.stringify(headerPayload);
  const ctB64 = pkt.ciphertext_b64;

  const aad = headerPayload ? buildDrAadFromHeader(headerPayload) : null;
  const aadHash = aad ? await hashBytesHex(aad) : null;
  const packetKeyLog = pkt?.header?.ek_pub_b64
    ? `${finalConversationId || ''}::${String(pkt.header.ek_pub_b64).slice(0, 12)}::${pkt.header?.n ?? ''}`
    : null;
  try {
    drConsole.log('[msg] send:counter', JSON.stringify({
      messageId,
      msgType: meta?.msg_type || null,
      headerN,
      transportCounter
    }));
  } catch {}
  logMsgEvent('send:start', {
    direction: 'outgoing',
    conversationId: finalConversationId,
    messageId,
    serverMessageId: null,
    packetKey: packetKeyLog,
    senderDigest: accountDigest || null,
    senderDeviceId,
    peerAccountDigest: peer,
    peerDeviceId
  });
  logDrCore('encrypt:fingerprint', {
    peerAccountDigest: peer,
    peerDeviceId,
    messageId,
    aadHash,
    aadLen: aad ? aad.byteLength : null
  });

  try {
    const vaultCounter = Number.isFinite(headerN) ? headerN : transportCounter;
    try {
      await MessageKeyVault.putMessageKey({
        conversationId: finalConversationId,
        messageId,
        senderDeviceId,
        targetDeviceId: receiverDeviceId,
        direction: 'outgoing',
        msgType,
        headerCounter: vaultCounter,
        messageKeyB64
      });
      logOutgoingSendTrace('vault_put_ok', messageId, null);
    } catch (err) {
      logOutgoingSendTrace('vault_put_fail', messageId, null);
      err.stage = 'vault_put_fail';
      err.code = err.code || 'VaultPutFailed';
      throw err;
    }
    startOutboxProcessor();
    const job = await enqueueOutboxJob({
      conversationId: finalConversationId,
      messageId,
      headerJson,
      header: headerPayload,
      ciphertextB64: ctB64,
      counter: transportCounter,
      senderDeviceId,
      receiverAccountDigest: peer,
      receiverDeviceId: receiverDeviceId || null,
      createdAt: now,
      peerAccountDigest: peer,
      peerDeviceId: peerDeviceId || null,
      meta: { msg_type: meta.msg_type },
      dr: preSnapshot
        ? {
            snapshotBefore: preSnapshot,
            snapshotAfter: postSnapshot,
            messageKeyB64
          }
        : null
    });
    const result = await processOutboxJobNow(job.jobId);
    if (!result.ok) {
      logOutgoingSendTrace('send_fail', messageId, null);
      logMsgEvent('send:fail', {
        direction: 'outgoing',
        conversationId: finalConversationId,
        messageId,
        serverMessageId: null,
        packetKey: packetKeyLog,
        senderDigest: accountDigest || null,
        senderDeviceId,
        peerAccountDigest: peer,
        peerDeviceId,
        status: result?.status ?? null,
        error: result?.error || 'sendText failed'
      }, { level: 'error' });
      const status = Number.isFinite(result?.status) ? ` (status=${result.status})` : '';
      const sendErr = new Error((result.error || 'sendText failed') + status);
      sendErr.status = Number.isFinite(result?.status) ? Number(result.status) : undefined;
      sendErr.code = sendErr.code || sendErr.status || 'SendFailed';
      sendErr.stage = 'send_fail';
      sendErr.__drDeliveryLogged = true;
      throw sendErr;
    }
    if (postSnapshot && peer && peerDeviceId) {
      const persisted = persistDrSnapshot({ peerAccountDigest: peer, peerDeviceId, snapshot: postSnapshot });
      logDrCore('send:persist', {
        peerAccountDigest: peer,
        peerDeviceId,
        messageId,
        persisted,
        Ns: postSnapshot?.Ns ?? null,
        Nr: postSnapshot?.Nr ?? null,
        hasCkS: !!postSnapshot?.ckS_b64
      }, { level: 'log' });
    }
    sendFailureCounter.delete(`${peer}::${receiverDeviceId || 'unknown'}`);
    logDrSend('encrypt-after', { peerAccountDigest: peer, snapshot: postSnapshot });
    const msg = result.data && typeof result.data === 'object' ? result.data : {};
    const ackId = typeof msg?.id === 'string' && msg.id ? msg.id : null;
    if (ackId && ackId !== messageId) {
      throw new Error('messageId mismatch from server');
    }
    if (!ackId) msg.id = messageId;
    logMsgEvent('send:done', {
      direction: 'outgoing',
      conversationId: finalConversationId,
      messageId,
      serverMessageId: msg.id || null,
      packetKey: packetKeyLog,
      senderDigest: accountDigest || null,
      senderDeviceId,
      peerAccountDigest: peer,
      peerDeviceId,
      status: result?.status ?? null,
      ok: !!result?.ok
    });
    logOutgoingSendTrace('send_ok', messageId, msg.id || null);
    try {
      log({
        sendSuccessTrace: {
          conversationId: finalConversationId,
          serverMessageId: msg.id || messageId,
          messageId,
          msgType,
          headerCounter: vaultCounter,
          senderDeviceId,
          targetDeviceId: receiverDeviceId
        }
      });
    } catch {}
    return { msg, convId: finalConversationId, secure: true };
  } catch (err) {
    if (!err?.__drDeliveryLogged) {
      logMsgEvent('send:fail', {
        direction: 'outgoing',
        conversationId: finalConversationId,
        messageId,
        serverMessageId: null,
        packetKey: packetKeyLog,
        senderDigest: accountDigest || null,
        senderDeviceId,
        peerAccountDigest: peer,
        peerDeviceId,
        status: Number.isFinite(err?.status) ? Number(err.status) : null,
        error: err?.message || err
      }, { level: 'error' });
      err.__drDeliveryLogged = true;
    }
    const key = `${peer}::${receiverDeviceId || 'unknown'}`;
    const nextFail = (sendFailureCounter.get(key) || 0) + 1;
    sendFailureCounter.set(key, nextFail);
    if (nextFail >= 3) {
      throw new Error('DR 送出連續失敗，請重新同步好友或重新建立邀請');
    }
    const holder = drState({ peerAccountDigest: peer, peerDeviceId });
    const currentCounter = Number(holder?.NsTotal);
    const shouldRestore = preSnapshot && (!Number.isFinite(currentCounter) || currentCounter <= transportCounter);
    if (shouldRestore) {
      restoreDrStateFromSnapshot({ peerAccountDigest: peer, peerDeviceId, snapshot: preSnapshot, force: true, sourceTag: 'send-failed' });
      const refreshed = drState({ peerAccountDigest: peer, peerDeviceId });
      if (refreshed && (!Number.isFinite(refreshed.NsTotal) || refreshed.NsTotal < transportCounter)) {
        refreshed.NsTotal = transportCounter;
      }
    } else if (holder && (!Number.isFinite(currentCounter) || currentCounter < transportCounter)) {
      holder.NsTotal = transportCounter;
    }
    throw err;
  }
}

/**
 * 發送 DR 文字訊息（必要時會先初始化會話）。
 * @param {{ peerAccountDigest?: string, text: string, conversation?: { token_b64?:string, conversation_id?:string }, convId?: string }} p
 * @returns {Promise<{ msg: any, convId: string }>}
 */
export async function sendDrText(params = {}) {
  if (!params?.messageId || typeof params.messageId !== 'string' || !params.messageId.trim()) {
    throw new Error('messageId required for text send');
  }
  return sendDrPlaintext(params);
}

export async function sendDrDeliveryReceipt(params = {}) {
  const { messageId: targetMessageId, ...rest } = params;
  if (!targetMessageId) throw new Error('messageId required for delivery receipt');
  const now = Math.floor(Date.now() / 1000);
  const receiverDeviceId = ensureDeviceId();
  const convId = params?.conversationId || params?.convId || null;
  const payload = {
    type: CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT,
    messageId: targetMessageId,
    ackedMessageId: targetMessageId,
    conversationId: convId,
    receiverDeviceId,
    ts: now
  };
  return sendDrPlaintext({
    ...rest,
    convId,
    messageId: buildReceiptMessageId(targetMessageId),
    text: JSON.stringify(payload),
    metaOverrides: {
      msg_type: CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT,
      control: 'receipt',
      target_message_id: targetMessageId
    }
  });
}

export async function sendDrReadReceipt(params = {}) {
  const { messageId: targetMessageId, ...rest } = params;
  if (!targetMessageId) throw new Error('messageId required for read receipt');
  return sendDrPlaintext({
    ...rest,
    messageId: buildReceiptMessageId(targetMessageId),
    text: JSON.stringify({ type: CONTROL_MESSAGE_TYPES.READ_RECEIPT, messageId: targetMessageId }),
    metaOverrides: {
      msg_type: CONTROL_MESSAGE_TYPES.READ_RECEIPT,
      control: 'receipt',
      target_message_id: targetMessageId
    }
  });
}

const MEDIA_PREVIEW_MAX_DIMENSION = 480;
const MEDIA_PREVIEW_JPEG_QUALITY = 0.82;
const MEDIA_PREVIEW_CAPTURE_FRACTION = 0.05;

function scaleToPreviewSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: null, height: null };
  }
  const maxSide = Math.max(width, height);
  const ratio = maxSide > MEDIA_PREVIEW_MAX_DIMENSION ? MEDIA_PREVIEW_MAX_DIMENSION / maxSide : 1;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  };
}

function canvasToJpegBlob(canvas, quality = MEDIA_PREVIEW_JPEG_QUALITY) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('preview toBlob failed'));
      }, 'image/jpeg', quality);
    } catch (err) {
      reject(err);
    }
  });
}

async function buildImagePreviewBlob(file) {
  if (!file) return null;
  let url = null;
  try {
    url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    const loadPromise = new Promise((resolve, reject) => {
      img.onload = () => resolve(null);
      img.onerror = () => reject(new Error('image load failed'));
    });
    img.src = url;
    await loadPromise;
    const { width, height } = img;
    if (!width || !height) return null;
    const target = scaleToPreviewSize(width, height);
    if (!target.width || !target.height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, target.width, target.height);
    const blob = await canvasToJpegBlob(canvas);
    return { blob, width: target.width, height: target.height, contentType: 'image/jpeg' };
  } finally {
    if (url) {
      try { URL.revokeObjectURL(url); } catch {}
    }
  }
}

function waitForVideoEvent(video, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = typeof timeoutMs === 'number' && timeoutMs > 0
      ? setTimeout(() => {
          cleanup();
          reject(new Error('video preview timeout'));
        }, timeoutMs)
      : null;
    const onEvent = () => {
      cleanup();
      resolve(null);
    };
    const onError = () => {
      cleanup();
      reject(new Error('video preview failed'));
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
    };
    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

async function buildVideoPreviewBlob(file) {
  if (!file) return null;
  let url = null;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  try {
    url = URL.createObjectURL(file);
    video.src = url;
    await waitForVideoEvent(video, 'loadedmetadata');
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const targetTime = Math.min(
      Math.max(duration * MEDIA_PREVIEW_CAPTURE_FRACTION, 0.08),
      duration > 0 ? Math.max(0.01, duration - 0.02) : 0.08
    );
    if (Number.isFinite(targetTime)) {
      try {
        video.currentTime = targetTime;
        await waitForVideoEvent(video, 'seeked');
      } catch {
        await waitForVideoEvent(video, 'loadeddata');
      }
    } else {
      await waitForVideoEvent(video, 'loadeddata');
    }
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    if (!vw || !vh) return null;
    const target = scaleToPreviewSize(vw, vh);
    if (!target.width || !target.height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, target.width, target.height);
    const blob = await canvasToJpegBlob(canvas);
    return { blob, width: target.width, height: target.height, contentType: 'image/jpeg' };
  } finally {
    if (url) {
      try { URL.revokeObjectURL(url); } catch {}
    }
  }
}

async function buildMediaPreviewBlob(file) {
  const type = (file?.type || '').toLowerCase();
  if (type.startsWith('image/')) {
    return buildImagePreviewBlob(file);
  }
  if (type.startsWith('video/')) {
    try {
      return await buildVideoPreviewBlob(file);
    } catch (err) {
      logDrSend('video-preview-failed', { error: err?.message || err });
      return null;
    }
  }
  return null;
}

function blobToNamedFile(blob, nameHint) {
  if (!blob) return null;
  const safeName = typeof nameHint === 'string' && nameHint.trim()
    ? nameHint.trim()
    : 'preview.jpg';
  if (typeof File === 'function') {
    try {
      return new File([blob], safeName, { type: blob.type || 'image/jpeg' });
    } catch {
      // ignore and fallback
    }
  }
  try {
    blob.name = safeName;
  } catch {}
  return blob;
}

export async function sendDrMedia(params = {}) {
  const { file, conversation, convId, dir, onProgress, abortSignal, peerDeviceId: peerDeviceInput = null } = params;
  const peer = resolvePeerDigest(params);
  if (!peer) throw new Error('peerAccountDigest required');
  if (!file || typeof file !== 'object' || typeof file.arrayBuffer !== 'function') {
    throw new Error('file required');
  }
  const messageId = typeof params?.messageId === 'string' && params.messageId.trim().length
    ? params.messageId.trim()
    : null;
  if (!messageId) {
    throw new Error('messageId required for media send');
  }

  const convContext = conversation || conversationContextForPeer({ peerAccountDigest: peer, peerDeviceId: peerDeviceInput || conversation?.peerDeviceId || null });
  const tokenB64 = convContext?.token_b64 || convContext?.tokenB64 || null;
  if (!tokenB64) throw new Error('conversation token missing for peer, please refresh contacts');

  const { deviceId: peerDeviceId } = ensurePeerIdentity({
    peerAccountDigest: peer,
    peerDeviceId: peerDeviceInput || conversation?.peerDeviceId || convContext?.peerDeviceId || null,
    conversationId: convId || convContext?.conversation_id || convContext?.conversationId || null
  });

  let state = drState({ peerAccountDigest: peer, peerDeviceId });
  let hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  const hasDrInit = !!(convContext?.dr_init?.guest_bundle);

  if (!hasDrState) {
    try {
      await ensureDrSession({ peerAccountDigest: peer, peerDeviceId });
    } catch (err) {
      if (!hasDrInit) {
        throw new Error('尚未建立安全對話，請重新同步好友或重新建立邀請');
      }
      throw new Error('DR 會話初始化失敗：' + (err?.message || err));
    }
    state = drState({ peerAccountDigest: peer, peerDeviceId });
    hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  }

  if (!hasDrState && !hasDrInit) {
    throw new Error('尚未建立安全對話，請重新同步好友或重新建立邀請');
  }

  let conversationId = convContext?.conversation_id || convContext?.conversationId || convId || null;
  if (!conversationId) conversationId = await conversationIdFromToken(tokenB64);

  const msgType = 'media';
  const accountDigest = (getAccountDigest() || '').toUpperCase();

  const sharedMediaKey = crypto.getRandomValues(new Uint8Array(32));
  let previewInfo = null;
  let previewLocalUrl = null;
  try {
    const previewCandidate = await buildMediaPreviewBlob(file);
    if (previewCandidate?.blob) {
      const previewName = typeof file.name === 'string' && file.name
        ? `${file.name}.preview.jpg`
        : 'preview.jpg';
      const previewFile = blobToNamedFile(previewCandidate.blob, previewName);
      previewLocalUrl = URL.createObjectURL(previewCandidate.blob);
      const previewUpload = await encryptAndPutWithProgress({
        convId: conversationId,
        file: previewFile,
        dir,
        onProgress: null,
        skipIndex: true,
        encryptionKey: { key: sharedMediaKey, type: 'shared' },
        encryptionInfoTag: 'media/preview-v1'
      });
      previewInfo = {
        objectKey: previewUpload.objectKey,
        size: previewUpload.size ?? previewFile?.size ?? previewCandidate.blob?.size ?? null,
        contentType: previewFile?.type || previewCandidate.contentType || 'image/jpeg',
        envelope: previewUpload.envelope || null,
        width: previewCandidate.width || null,
        height: previewCandidate.height || null
      };
      if (previewLocalUrl) previewInfo.localUrl = previewLocalUrl;
    }
  } catch (err) {
    logDrSend('preview-generate-failed', { peerAccountDigest: peer, error: err?.message || err });
  }

  const uploadResult = await encryptAndPutWithProgress({
    convId: conversationId,
    file,
    dir,
    onProgress,
    abortSignal,
    skipIndex: true,
    encryptionKey: { key: sharedMediaKey, type: 'shared' },
    encryptionInfoTag: 'media/v1'
  });

  const metadata = {
    type: 'media',
    objectKey: uploadResult.objectKey,
    name: typeof file.name === 'string' && file.name ? file.name : '附件',
    size: typeof file.size === 'number' ? file.size : uploadResult.size ?? null,
    contentType: file.type || 'application/octet-stream',
    envelope: uploadResult.envelope || null,
    dir: Array.isArray(dir) && dir.length ? dir.map((seg) => String(seg || '').trim()).filter(Boolean) : null,
    preview: previewInfo || null
  };

  const payloadText = JSON.stringify({
    type: metadata.type,
    objectKey: metadata.objectKey,
    name: metadata.name,
    size: metadata.size,
    contentType: metadata.contentType,
    envelope: metadata.envelope,
    dir: metadata.dir,
    preview: metadata.preview
      ? {
          objectKey: metadata.preview.objectKey,
          size: metadata.preview.size,
          contentType: metadata.preview.contentType,
          envelope: metadata.preview.envelope,
          width: metadata.preview.width,
          height: metadata.preview.height
        }
      : undefined
  });

  const senderDeviceId = ensureDeviceId();
  const transportCounter = reserveTransportCounter(state, {
    peerAccountDigest: peer,
    peerDeviceId,
    conversationId,
    messageId,
    msgType
  });
  const preSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false, forceNow: true });
  logDrSend('encrypt-media-before', { peerAccountDigest: peer, snapshot: preSnapshot || null, objectKey: metadata.objectKey });
  const pkt = await drEncryptText(state, payloadText, { deviceId: senderDeviceId, version: 1 });
  const messageKeyB64 = pkt?.message_key_b64 || null;
  const afterEncryptTotal = Number(state?.NsTotal);
  if (!Number.isFinite(afterEncryptTotal) || afterEncryptTotal === transportCounter + 1 || afterEncryptTotal < transportCounter) {
    state.NsTotal = transportCounter;
  }
  const postSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  const now = Math.floor(Date.now() / 1000);
  const headerN = Number.isFinite(pkt?.header?.n) ? Number(pkt.header.n) : null;

  const receiverDeviceId = peerDeviceId;
  const receiverAccountDigest = peer;

  const meta = {
    ts: now,
    sender_digest: accountDigest || null,
    senderDigest: accountDigest || null,
    sender_device_id: senderDeviceId || null,
    senderDeviceId: senderDeviceId || null,
    targetAccountDigest: receiverAccountDigest || null,
    target_account_digest: receiverAccountDigest || null,
    receiverAccountDigest: receiverAccountDigest || null,
    receiver_account_digest: receiverAccountDigest || null,
    targetDeviceId: receiverDeviceId || null,
    target_device_id: receiverDeviceId || null,
    receiverDeviceId: receiverDeviceId || null,
    receiver_device_id: receiverDeviceId || null,
    msg_type: msgType,
    media: {
      object_key: metadata.objectKey,
      size: metadata.size,
      name: metadata.name,
      content_type: metadata.contentType
    }
  };
  if (metadata.preview?.objectKey) {
    meta.media.preview = {
      object_key: metadata.preview.objectKey,
      size: metadata.preview.size,
      content_type: metadata.preview.contentType,
      width: metadata.preview.width,
      height: metadata.preview.height
    };
  }
  const headerPayload = { ...pkt.header, iv_b64: pkt.iv_b64, meta };
  const headerJson = JSON.stringify(headerPayload);
  const ctB64 = pkt.ciphertext_b64;

  try {
    drConsole.log('[msg] send:counter', JSON.stringify({
      messageId,
      msgType: meta?.msg_type || null,
      headerN,
      transportCounter
    }));
  } catch {}

  const vaultCounter = Number.isFinite(headerN) ? headerN : transportCounter;
  const restoreSendFailure = (err) => {
    const holder = drState({ peerAccountDigest: peer, peerDeviceId });
    const currentCounter = Number(holder?.NsTotal);
    const shouldRestore = preSnapshot && (!Number.isFinite(currentCounter) || currentCounter <= transportCounter);
    if (shouldRestore) {
      restoreDrStateFromSnapshot({ peerAccountDigest: peer, peerDeviceId, snapshot: preSnapshot, force: true, sourceTag: 'send-failed' });
      const refreshed = drState({ peerAccountDigest: peer, peerDeviceId });
      if (refreshed && (!Number.isFinite(refreshed.NsTotal) || refreshed.NsTotal < transportCounter)) {
        refreshed.NsTotal = transportCounter;
      }
    } else if (holder && (!Number.isFinite(currentCounter) || currentCounter < transportCounter)) {
      holder.NsTotal = transportCounter;
    }
    throw err;
  };
  try {
    await MessageKeyVault.putMessageKey({
      conversationId,
      messageId,
      senderDeviceId,
      targetDeviceId: receiverDeviceId,
      direction: 'outgoing',
      msgType,
      headerCounter: vaultCounter,
      messageKeyB64
    });
    logOutgoingSendTrace('vault_put_ok', messageId, null);
  } catch (err) {
    logOutgoingSendTrace('vault_put_fail', messageId, null);
    err.stage = 'vault_put_fail';
    err.code = err.code || 'VaultPutFailed';
    restoreSendFailure(err);
  }

  startOutboxProcessor();
  const job = await enqueueMediaMetaJob({
    conversationId,
    messageId,
    headerJson,
    header: headerPayload,
    ciphertextB64: ctB64,
    counter: transportCounter,
    senderDeviceId,
    receiverAccountDigest: peer,
    receiverDeviceId: receiverDeviceId || null,
    createdAt: now,
    meta: { msg_type: msgType, media: metadata },
    peerAccountDigest: peer,
    dr: preSnapshot
      ? {
          snapshotBefore: preSnapshot,
          snapshotAfter: postSnapshot,
          messageKeyB64
        }
      : null
  });
  const result = await processOutboxJobNow(job.jobId);
  if (!result.ok) {
    logOutgoingSendTrace('send_fail', messageId, null);
    const sendErr = new Error(result.error || 'sendMedia failed');
    sendErr.status = Number.isFinite(result?.status) ? Number(result.status) : null;
    sendErr.code = sendErr.code || sendErr.status || 'SendFailed';
    sendErr.stage = 'send_fail';
    restoreSendFailure(sendErr);
  }
  logDrSend('encrypt-media-after', { peerAccountDigest: peer, snapshot: postSnapshot || null, objectKey: metadata.objectKey });

  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const ackId = typeof data?.id === 'string' && data.id ? data.id : null;
  if (ackId && ackId !== job.messageId) {
    throw new Error('messageId mismatch from server');
  }
  const finalMessageId = ackId || job.messageId;
  logOutgoingSendTrace('send_ok', messageId, finalMessageId);
  if (preSnapshot) {
    recordDrMessageHistory({
      peerAccountDigest: peer,
      messageTs: now,
      messageId: finalMessageId,
      snapshot: preSnapshot,
      snapshotNext: postSnapshot,
      messageKeyB64
    });
  }
  persistDrSnapshot({ peerAccountDigest: peer, peerDeviceId, state });
  try {
    log({
      sendSuccessTrace: {
        conversationId,
        serverMessageId: finalMessageId,
        messageId: finalMessageId,
        msgType,
        headerCounter: vaultCounter,
        senderDeviceId,
        targetDeviceId: receiverDeviceId
      }
    });
  } catch {}

  return {
    msg: {
      id: finalMessageId,
      ts: now,
      text: `[檔案] ${metadata.name}`,
      type: 'media',
      media: {
        objectKey: metadata.objectKey,
        name: metadata.name,
        size: metadata.size,
        contentType: metadata.contentType,
        envelope: metadata.envelope,
        dir: metadata.dir,
        createdAt: now,
        preview: metadata.preview || null,
        previewUrl: previewLocalUrl || null
      }
    },
    convId: conversationId,
    secure: true,
    upload: {
      objectKey: metadata.objectKey,
      envelope: metadata.envelope,
      size: uploadResult.size
    }
  };
}

export async function sendDrCallLog(params = {}) {
  const { callId, outcome, direction, reason } = params;
  const peerAccountDigest = resolvePeerDigest(params);
  const peerDeviceId = normalizePeerDeviceId(
    params.peerDeviceId
    || params.peer_device_id
    || params.receiverDeviceId
    || params.targetDeviceId
    || params.peerDeviceId // for consistency if already normalized
    || null
  );
  const messageId = typeof params?.messageId === 'string' && params.messageId.trim().length
    ? params.messageId.trim()
    : null;
  if (!messageId) {
    throw new Error('messageId required for call-log send');
  }
  if (!peerAccountDigest) {
    throw new Error('peerAccountDigest required for call-log send');
  }
  if (!peerDeviceId) {
    throw new Error('peerDeviceId required for call-log send');
  }
  const startedAtSec = Number.isFinite(params.startedAt) ? Math.max(0, Math.round(Number(params.startedAt))) : null;
  const endedAtSec = Number.isFinite(params.endedAt) ? Math.max(0, Math.round(Number(params.endedAt))) : null;
  const safeDuration = Number.isFinite(Number(params.durationSeconds))
    ? Math.max(0, Math.round(Number(params.durationSeconds)))
    : (startedAtSec != null && endedAtSec != null ? Math.max(0, endedAtSec - startedAtSec) : 0);
  const conversationContext = conversationContextForPeer({ peerAccountDigest, peerDeviceId }) || {};
  const conversationId = conversationContext?.conversation_id || conversationContext?.conversationId || null;
  const payload = {
    type: 'call-log',
    callId: callId || null,
    outcome,
    durationSeconds: safeDuration,
    durationSec: safeDuration,
    direction,
    reason,
    endReason: reason || null,
    peerAccountDigest,
    peerDeviceId,
    startedAt: startedAtSec,
    endedAt: endedAtSec
  };
  const metaOverrides = {
    msg_type: 'call-log',
    call_id: callId || null,
    call_outcome: outcome,
    call_duration: safeDuration,
    call_direction: direction,
    call_reason: reason || null,
    peer_account_digest: peerAccountDigest,
    peer_device_id: peerDeviceId,
    call_started_at: startedAtSec,
    call_ended_at: endedAtSec
  };
  const text = JSON.stringify(payload);
  const conversation = params?.conversation || conversationContext || null;
  const result = await sendDrPlaintext({
    ...params,
    peerAccountDigest,
    peerDeviceId,
    conversation,
    messageId,
    text,
    metaOverrides
  });
  return { ...result, conversationId: conversationId || result?.convId || null };
}

export async function bootstrapDrFromGuestBundle(params = {}) {
  const { guestBundle, force = false, conversationId = null } = params;
  const peer = resolvePeerDigest(params);
  if (!peer) throw new Error('peerAccountDigest required for DR bootstrap');
  if (!guestBundle || typeof guestBundle !== 'object') throw new Error('guest bundle missing for DR bootstrap');
  const peerDeviceId = params?.peerDeviceId ?? null;
  const holder = drState({ peerAccountDigest: peer, peerDeviceId });
  if (holder?.rk && !force) return false;
  const priv = await ensureDevicePrivLoaded();
  const st = await x3dhRespond(priv, guestBundle);
  const logInvalid = (keyName, raw, reason) => {
    try {
      drConsole.warn('[dr-bootstrap:invalid-key]', {
        keyName,
        source: 'bootstrapDrFromGuestBundle',
        peerAccountDigest: peer,
        peerDeviceId,
        reason: reason || null,
        type: typeof raw,
        ctor: raw?.constructor?.name || null,
        isView: ArrayBuffer.isView(raw),
        byteLength: typeof raw?.byteLength === 'number' ? raw.byteLength : null,
        length: typeof raw?.length === 'number' ? raw.length : null
      });
    } catch {}
  };
  const ensureKeyU8 = (value, keyName, { required = true } = {}) => {
    if (value === undefined || value === null) {
      if (required) {
        logInvalid(keyName, value, 'missing');
        throw new Error(`dr bootstrap missing ${keyName}`);
      }
      return null;
    }
    let next = value;
    if (typeof next === 'string') {
      next = b64u8(next);
    }
    if (!(next instanceof Uint8Array)) {
      logInvalid(keyName, next, 'not-uint8array');
      throw new Error(`dr bootstrap invalid ${keyName}`);
    }
    return next;
  };
  st.rk = ensureKeyU8(st?.rk, 'rk', { required: true });
  st.ckR = ensureKeyU8(st?.ckR, 'ckR', { required: false });
  st.ckS = ensureKeyU8(st?.ckS, 'ckS', { required: true });
  st.myRatchetPriv = ensureKeyU8(st?.myRatchetPriv, 'myRatchetPriv', { required: true });
  st.myRatchetPub = ensureKeyU8(st?.myRatchetPub, 'myRatchetPub', { required: true });
  st.theirRatchetPub = ensureKeyU8(st?.theirRatchetPub, 'theirRatchetPub', { required: false });
  drConsole.log('[dr-bootstrap:ready]', {
    peerAccountDigest: peer,
    peerDeviceId,
    rkByteLength: st.rk?.byteLength ?? null,
    ckSByteLength: st.ckS?.byteLength ?? null,
    ckRPresent: !!st.ckR
  });
  clearDrState(
    { peerAccountDigest: peer, peerDeviceId },
    { __drDebugTag: 'web/src/app/features/dr-session.js:1683:bootstrapDrFromGuestBundle:clear-before-copy' }
  );
  const freshHolder = drState({ peerAccountDigest: peer, peerDeviceId });
  copyDrState(freshHolder, st, { callsiteTag: 'bootstrapDrFromGuestBundle' });
  const holderId = ensureHolderId(freshHolder);
  drConsole.log('[dr-bootstrap:fingerprint]', {
    peerAccountDigest: peer,
    peerDeviceId,
    holderId,
    hasRk: freshHolder?.rk instanceof Uint8Array,
    hasCkS: freshHolder?.ckS instanceof Uint8Array,
    hasCkR: freshHolder?.ckR instanceof Uint8Array,
    role: freshHolder?.baseKey?.role || null,
    lastWriteTag: freshHolder?.__lastWriteTag || null
  });
  try {
    drConsole.log('[dr-debug:bootstrap-holder]', {
      stateKey: `${peer}::${peerDeviceId || 'unknown'}`,
      holderId,
      role: freshHolder?.baseKey?.role || null,
      hasRk: freshHolder?.rk instanceof Uint8Array,
      hasCkR: freshHolder?.ckR instanceof Uint8Array,
      hasCkS: freshHolder?.ckS instanceof Uint8Array
    });
  } catch {}
  if (!(freshHolder.rk instanceof Uint8Array)) {
    logInvalid('rk', freshHolder?.rk, 'post-copy-not-uint8array');
    throw new Error('dr bootstrap failed to materialize rk');
  }
  if (!(freshHolder.myRatchetPriv instanceof Uint8Array) || !(freshHolder.myRatchetPub instanceof Uint8Array)) {
    logInvalid('myRatchetKeys', freshHolder, 'post-copy-not-uint8array');
    throw new Error('dr bootstrap failed to materialize ratchet keys');
  }
  if (!(freshHolder.ckS instanceof Uint8Array)) {
    logInvalid('ckS', freshHolder?.ckS, 'post-copy-not-uint8array');
    throw new Error('dr bootstrap failed to materialize ckS');
  }
  freshHolder.baseKey = {
    role: 'responder',
    initializedAt: Date.now(),
    guestBundle,
    conversationId: conversationId || null,
    peerDeviceId: peerDeviceId || null
  };
  markHolderSnapshot(freshHolder, 'responder', Date.now());
  persistDrSnapshot({ peerAccountDigest: peer, peerDeviceId, state: freshHolder });
  return true;
}

export function primeDrStateFromInitiator(params = {}) {
  const { state } = params;
  const peer = resolvePeerDigest(params);
  const peerDeviceId = params?.peerDeviceId ?? null;
  const conversationId = params?.conversationId || null;
  if (!peer || !peerDeviceId || !state) return false;
  const holder = drState({ peerAccountDigest: peer, peerDeviceId });
  if (holder?.rk) return false;
  copyDrState(holder, state, { callsiteTag: 'primeDrStateFromInitiator' });
  holder.baseKey = { role: 'initiator', initializedAt: Date.now(), primed: true, conversationId: conversationId || null };
  markHolderSnapshot(holder, 'prime', Date.now());
  return true;
}

export async function ensureDrReceiverState(params = {}) {
  const { force = false } = params;
  const { digest: peer, deviceId: peerDeviceId } = ensurePeerIdentity({
    peerAccountDigest: params?.peerAccountDigest ?? params,
    peerDeviceId: params?.peerDeviceId ?? null,
    conversationId: params?.conversationId ?? null,
    __debugSource: params?.__debugSource || params?.source || 'ensureDrReceiverState'
  });
  const conversationId = params?.conversationId || null;
  const callsiteTag = params?.__debugSource || params?.source || 'ensureDrReceiverState';
  let selfDeviceId = getDeviceId() || null;
  logDrStateDebug('ws_self_device_not_ready', {
    targetDeviceId: peerDeviceId || null,
    selfDeviceIdReady: !!selfDeviceId,
    sourceTag: callsiteTag
  });
  selfDeviceId = ensureDeviceId();
  // contact-secrets 的 device record 以「本機 deviceId」為鍵，peerDeviceId 只作為辨識 peer 版本的 key。
  // 因此查詢時以 peerDeviceId 作為 hint，但 deviceId 一律用 selfDeviceId。
  let secretInfo =
    getContactSecret(peer, { peerDeviceId, deviceId: selfDeviceId, conversationId })
    || getContactSecret(peer, { deviceId: selfDeviceId, conversationId })
    || {};
  const secretPeerDeviceId = normalizePeerDeviceId(secretInfo?.peerDeviceId || secretInfo?.conversation?.peerDeviceId || null);
  const stateKey = `${peer}::${peerDeviceId || 'unknown'}`;
  const secretKey = `${peer}::${secretPeerDeviceId || peerDeviceId || 'unknown'}`;
  const quarantinePeerKey = normalizePeerKeyForQuarantine({
    peerAccountDigest: peer,
    peerDeviceId: secretPeerDeviceId || peerDeviceId,
    sourceTag: callsiteTag
  });
  const snapshotValidation = prevalidateSnapshotOrQuarantine(secretInfo?.drState || null, {
    peerAccountDigest: peer,
    peerDeviceId: secretPeerDeviceId || peerDeviceId,
    peerKey: quarantinePeerKey,
    sourceTag: callsiteTag
  });
  if (!snapshotValidation.ok) {
    if (snapshotValidation.pending) {
      return false;
    }
    secretInfo = { ...secretInfo, drState: null };
    throw new Error('狀態損壞，需要重新同步/重新邀請');
  }
  const snapshot = snapshotValidation.snapshot;
  secretInfo = { ...secretInfo, drState: snapshot };
  const snapshotHasRk = !!(snapshot?.rk || snapshot?.rk_b64);
  const snapshotHasCkR = !!(snapshot?.ckR || snapshot?.ckR_b64);
  const snapshotHasCkS = !!(snapshot?.ckS || snapshot?.ckS_b64);
  const snapshotRoleRaw = typeof snapshot?.role === 'string' ? snapshot.role.toLowerCase() : null;
  const relationshipRole = typeof secretInfo?.role === 'string' ? secretInfo.role.toLowerCase() : null;
  let state = drState({ peerAccountDigest: peer, peerDeviceId });
  // 若已有送出鏈且 Ns>0，避免被 responder/接收狀態覆蓋。
  const hasExistingSend = state?.ckS instanceof Uint8Array && state.ckS.length > 0 && Number.isFinite(state?.Ns) && Number(state.Ns) > 0;
  const safeKeepSendState = hasExistingSend && !force;
  // guest/initiator 端若誤用 responder 快照（peerDeviceId != self），強制丟棄。
  let stateRoleRaw = state?.baseKey?.role;
  let stateRole = typeof stateRoleRaw === 'string' ? stateRoleRaw.toLowerCase() : null;
  const guestLike = relationshipRole === 'guest';
  try {
    drConsole.log('[dr-debug:receiver-entry]', {
      stateKey,
      holderId: state ? (state.__id || null) : null,
      role: state?.baseKey?.role || null,
      hasRk: state?.rk instanceof Uint8Array,
      hasCkR: state?.ckR instanceof Uint8Array,
      hasCkS: state?.ckS instanceof Uint8Array
    });
  } catch {}
  try {
    drConsole.warn('[dr-log:receiver-keys]', {
      stateKey,
      secretKey,
      conversationId,
      secretRole: relationshipRole || null,
      holderRole: stateRole || null,
      hasSecret: !!secretInfo?.drState,
      snapshotHasRk,
      snapshotHasCkR,
      snapshotHasCkS,
      snapshotRole: snapshotRoleRaw || null,
      hasCkS: !!(state?.ckS && state.ckS.length),
      hasCkR: !!(state?.ckR && state.ckR.length),
      holderNs: Number.isFinite(state?.Ns) ? Number(state.Ns) : null,
      holderNr: Number.isFinite(state?.Nr) ? Number(state.Nr) : null,
      callsite: callsiteTag
    });
  } catch {}

  const secretHasChains =
    !!(snapshot?.ckR || snapshot?.ckR_b64 || snapshot?.ckS || snapshot?.ckS_b64 || snapshot?.rk || snapshot?.rk_b64) ||
    Number(snapshot?.Ns) > 0 ||
    Number(snapshot?.Nr) > 0;
  let stateHasRk = !!state?.rk;
  let stateHasCkR = !!(state?.ckR && state.ckR.length);
  let stateHasCkS = !!(state?.ckS && state.ckS.length);
  // 單一路徑 hydrate（必經點）：只要 snapshot 有完整鏈且 key 匹配，就必須 hydrate；失敗直接 throw。
  const shouldHydrateSnapshot = relationshipRole === 'owner' && snapshotHasRk && (snapshotHasCkR || snapshotHasCkS);
  if (shouldHydrateSnapshot) {
    const logHydrate = (event, extra = {}) => {
      try {
        drConsole.warn(`[dr-log:${event}]`, {
          stateKey,
          secretKey,
          conversationId,
          snapshotRole: snapshotRoleRaw || null,
          secretRole: relationshipRole,
          snapshotHasRk,
          snapshotHasCkR,
          snapshotHasCkS,
          callsite: callsiteTag,
          ...extra
        });
      } catch {}
    };
    logHydrate('hydrate-attempt');
    if (stateKey !== secretKey) {
      logHydrate('hydrate-fail', { reason: 'ROLE_GATING', mismatch: true });
      return false;
    }
    const snapshotSelfDeviceId = typeof snapshot?.selfDeviceId === 'string' ? snapshot.selfDeviceId : null;
    const stateSelfMismatch =
      selfDeviceId &&
      snapshotSelfDeviceId &&
      snapshotSelfDeviceId !== selfDeviceId;
    if (stateSelfMismatch) {
      logHydrate('hydrate-fail', {
        reason: 'SELF_DEVICE_GATING',
        snapshotSelfDeviceId,
        selfDeviceId,
        peerDeviceId
      });
      return false;
    }
    try {
      const hydrated = restoreDrStateFromSnapshot({
        peerAccountDigest: peer,
        peerDeviceId,
        snapshot,
        force: true,
        sourceTag: 'deterministic-hydrate',
        targetState: state
      });
      state = drState({ peerAccountDigest: peer, peerDeviceId });
      const postHasRk = !!state?.rk;
      const postHasCkR = !!(state?.ckR && state.ckR.length);
      const postHasCkS = !!(state?.ckS && state.ckS.length);
      const postRole = typeof state?.baseKey?.role === 'string' ? state.baseKey.role.toLowerCase() : null;
      if (!hydrated) {
        logHydrate('hydrate-fail', { reason: 'DECODE', hydrated });
        throw new Error(`DR hydrate failed: restore returned false (stateKey=${stateKey})`);
      }
      if (!postHasRk || (!postHasCkR && !postHasCkS) || !postRole) {
        logHydrate('hydrate-fail', {
          reason: 'MISSING_FIELDS_AFTER_RESTORE',
          postHasRk,
          postHasCkR,
          postHasCkS,
          postRole
        });
        throw new Error(`DR hydrate failed missing fields (stateKey=${stateKey}, hasRk=${postHasRk}, hasCkR=${postHasCkR}, hasCkS=${postHasCkS}, role=${postRole || 'null'})`);
      }
      logHydrate('hydrate-success', {
        postRole,
        postHasRk,
        postHasCkR,
        postHasCkS
      });
      stateRoleRaw = state?.baseKey?.role;
      stateRole = typeof stateRoleRaw === 'string' ? stateRoleRaw.toLowerCase() : null;
      stateHasRk = !!state?.rk;
      stateHasCkR = !!(state?.ckR && state.ckR.length);
      stateHasCkS = !!(state?.ckS && state.ckS.length);
    } catch (err) {
      const message = err?.message || String(err);
      const reason = /importkey/i.test(message) ? 'IMPORTKEY' : 'DECODE';
      logHydrate('hydrate-fail', {
        reason,
        error: message
      });
      throw err;
    }
  }

  if (relationshipRole === 'owner' && (!stateRole || stateRole !== 'responder') && (secretHasChains || stateHasCkR || stateHasCkS || stateHasRk)) {
    drConsole.error('[dr-log:role-mismatch-bug]', {
      stateKey,
      secretKey,
      conversationId,
      secretRole: relationshipRole,
      holderRole: stateRole || null,
      hasSecretChains: secretHasChains,
      hasStateRk: stateHasRk,
      hasStateCkR: stateHasCkR,
      hasStateCkS: stateHasCkS,
      callsite: callsiteTag
    });
    // Fail-fast: 禁止在角色缺失時重建覆蓋。
    return false;
  }
  if (relationshipRole === 'owner' && (!stateHasCkR || !stateHasRk)) {
    drConsole.error('[dr-log:owner-missing-state]', {
      stateKey,
      secretKey,
      conversationId,
      secretRole: relationshipRole,
      holderRole: stateRole || null,
      hasStateRk: stateHasRk,
      hasStateCkR: stateHasCkR,
      hasStateCkS: stateHasCkS,
      hasSecretChains: secretHasChains,
      callsite: callsiteTag,
      holderId: state ? ensureHolderId(state) : null,
      lastWriteTag: state?.__lastWriteTag || null
    });
    return false;
  }
  if (safeKeepSendState) {
    try {
      drConsole.warn('[dr-log:keep-existing-send]', {
        peerAccountDigest: peer,
        peerDeviceId,
        role: stateRole || null,
        Ns: Number(state?.Ns) || 0,
        hasCkR: !!(state?.ckR && state.ckR.length),
        force
      });
    } catch {}
  }
  if (guestLike && stateRole === 'responder') {
    try {
      drConsole.warn('[dr-log:clear-responder-guest]', {
        peerAccountDigest: peer,
        peerDeviceId,
        Ns: Number(state?.Ns) || 0,
        hasCkS: !!(state?.ckS && state.ckS.length),
        hasCkR: !!(state?.ckR && state.ckR.length),
        safeKeepSendState
      });
    } catch {}
    if (!safeKeepSendState) {
      try {
        drConsole.warn('[dr-log:clear-drState-because-guest]', {
          peerAccountDigest: peer,
          peerDeviceId,
          stateKey: `${peer}::${peerDeviceId || 'unknown'}`,
          reason: 'guest-role',
          hasSnapshot: !!secretInfo?.drState
        });
      } catch {}
      clearDrState(
        { peerAccountDigest: peer, peerDeviceId },
        { __drDebugTag: 'web/src/app/features/dr-session.js:1978:ensureDrReceiverState:guest-role-clear' }
      );
      state = drState({ peerAccountDigest: peer, peerDeviceId });
    }
  }
  // 若 contact-secrets 上存的快照屬於錯裝置或 guest 卻標示 responder，直接丟棄存檔避免再次載入。
  if (secretInfo?.drState) {
    const snapRole = typeof secretInfo.drState?.role === 'string' ? secretInfo.drState.role.toLowerCase() : null;
    const snapSelf = typeof secretInfo.drState?.selfDeviceId === 'string' ? secretInfo.drState.selfDeviceId : null;
    if ((selfDeviceId && snapSelf && snapSelf !== selfDeviceId) || (guestLike && snapRole === 'responder')) {
      setContactSecret(peer, { deviceId: selfDeviceId, dr: null, meta: { source: 'dr-state-skip-invalid-device' } });
      state = drState({ peerAccountDigest: peer, peerDeviceId });
    }
  }
  // 若缺角色但已有快照/鏈，優先沿用並還原，避免被 bootstrap 覆寫。
  const snapHasChains =
    !!(secretInfo?.drState?.ckR || secretInfo?.drState?.ckS || secretInfo?.drState?.rk) ||
    Number(secretInfo?.drState?.Ns) > 0 ||
    Number(secretInfo?.drState?.Nr) > 0;
  if (!relationshipRole && snapHasChains) {
    try {
      drConsole.warn('[dr-log:restore-missing-role]', {
        peerAccountDigest: peer,
        peerDeviceId,
        stateKey: `${peer}::${peerDeviceId || 'unknown'}`,
        reason: 'missing-role-has-snapshot'
      });
    } catch {}
    restoreDrStateFromSnapshot({ peerAccountDigest: peer, peerDeviceId, snapshot: secretInfo.drState, force: true, sourceTag: 'missing-role-use-snapshot' });
    state = drState({ peerAccountDigest: peer, peerDeviceId });
  }
  // 若記憶體缺送出鏈，但 contact-secret 有 initiator 且 Ns>0 的快照，優先還原 initiator 送出鏈。
  const secretSnap = secretInfo?.drState || null;
  const secretSnapRole = typeof secretSnap?.role === 'string' ? secretSnap.role.toLowerCase() : null;
  const secretSnapNs = Number.isFinite(secretSnap?.Ns) ? Number(secretSnap.Ns) : null;
  const secretSnapHasSend = !!(secretSnap?.ckS_b64 || secretSnap?.ckS);
  const secretSnapSelf = typeof secretSnap?.selfDeviceId === 'string' ? secretSnap.selfDeviceId : null;
  const shouldRestoreInitiatorSend =
    !hasExistingSend &&
    secretSnapRole === 'initiator' &&
    secretSnapHasSend &&
    secretSnapNs !== null &&
    secretSnapNs > 0 &&
    (!selfDeviceId || !secretSnapSelf || secretSnapSelf === selfDeviceId) &&
    (!secretPeerDeviceId || !peerDeviceId || secretPeerDeviceId === peerDeviceId);
  if (shouldRestoreInitiatorSend) {
    const restored = restoreDrStateFromSnapshot({
      peerAccountDigest: peer,
      peerDeviceId,
      snapshot: secretSnap,
      force: true,
      sourceTag: 'ensure-restore-initiator-send'
    });
    state = drState({ peerAccountDigest: peer, peerDeviceId });
    try {
      drConsole.log('[dr-log:restore-initiator-send]', {
        peerAccountDigest: peer,
        peerDeviceId,
        restored,
        Ns: Number(state?.Ns) || null,
        hasCkS: !!(state?.ckS && state.ckS.length)
      });
    } catch {}
  }
  const resolvePreferredConversationId = () => {
    const secretConv = secretInfo?.conversationId || null;
    const baseConv = typeof state?.baseKey?.conversationId === 'string' ? state.baseKey.conversationId : null;
    const incomingConv = conversationId || null;
    const isContacts = (v) => typeof v === 'string' && v.startsWith('contacts-');
    // 若 incoming 是 contacts-* 但 secret/base 有實際 conv，優先實際 conv。
    if (incomingConv && isContacts(incomingConv)) {
      if (secretConv && !isContacts(secretConv)) return secretConv;
      if (baseConv && !isContacts(baseConv)) return baseConv;
    }
    if (incomingConv && isContacts(incomingConv) && !secretConv && !baseConv) return null;
    if (secretConv && isContacts(secretConv) && baseConv && !isContacts(baseConv)) return baseConv;
    return incomingConv || secretConv || baseConv || null;
  };
  const preferredConversationId = resolvePreferredConversationId();
  const secretConversationId = secretInfo?.conversationId || null;
  const baseConversationId = typeof state?.baseKey?.conversationId === 'string' ? state.baseKey.conversationId : null;
  const conversationMismatch = (() => {
    if (preferredConversationId && baseConversationId && preferredConversationId !== baseConversationId) return true;
    if (preferredConversationId && secretConversationId && preferredConversationId !== secretConversationId) return true;
    return false;
  })();
  if (conversationMismatch) {
    const hasSendChain = state?.ckS instanceof Uint8Array && state.ckS.length > 0;
    const sendCounter = Number.isFinite(state?.Ns) ? state.Ns : 0;
    if (hasSendChain || sendCounter > 0) {
      throw new Error('DR state conversation mismatch; please resync contact');
    }
    try {
      drConsole.warn('[dr-log:conv-mismatch-clear]', {
        peerAccountDigest: peer,
        peerDeviceId,
        conversationId: preferredConversationId,
        baseConversationId,
        secretConversationId,
        hasCkS: !!(state?.ckS && state.ckS.length),
        Ns: Number.isFinite(state?.Ns) ? Number(state.Ns) : null
      });
    } catch {}
    clearDrState(
      { peerAccountDigest: peer, peerDeviceId },
      { __drDebugTag: 'web/src/app/features/dr-session.js:2083:ensureDrReceiverState:conversation-mismatch' }
    );
    try {
      setContactSecret(peer, { deviceId: selfDeviceId, dr: null, conversation: null, meta: { source: 'dr-conv-mismatch-clear' } });
    } catch {}
    state = drState({ peerAccountDigest: peer, peerDeviceId });
  }
  const snapshotRole = typeof secretInfo?.drState?.role === 'string' ? secretInfo.drState.role.toLowerCase() : null;
  const canRestoreInitiator = guestLike && snapshotRole === 'initiator' && peerDeviceId && secretPeerDeviceId && secretPeerDeviceId === peerDeviceId;
  // guest 端允許還原 initiator 自身的快照（同 peerDeviceId），避免重置 send counter。
  if (!state?.rk && secretInfo?.drState && (!guestLike || canRestoreInitiator)) {
    restoreDrStateFromSnapshot({ peerAccountDigest: peer, peerDeviceId, snapshot: secretInfo.drState });
    state = drState({ peerAccountDigest: peer, peerDeviceId });
    try {
      drConsole.log('[dr-log:restore-from-secret]', {
        peerAccountDigest: peer,
        peerDeviceId,
        conversationId,
        restored: !!state?.rk
      });
    } catch {}
  } else if (guestLike && secretInfo?.drState) {
    try {
      drConsole.warn('[dr-log:skip-restore-because-guest]', {
        peerAccountDigest: peer,
        peerDeviceId,
        snapshotRole,
        stateKey: `${peer}::${peerDeviceId || 'unknown'}`
      });
    } catch {}
    if (snapshotRole !== 'initiator') {
      setContactSecret(peer, { deviceId: selfDeviceId, dr: null, meta: { source: 'dr-guest-skip-responder-snapshot' } });
    }
  }
  if (preferredConversationId && (!state.baseKey || !state.baseKey.conversationId)) {
    state.baseKey = state.baseKey || {};
    state.baseKey.conversationId = preferredConversationId;
  }
  const stateHasRatchet = !!(state?.rk && state?.myRatchetPriv && state?.myRatchetPub);
  const stateHasReceiveChain = state?.ckR instanceof Uint8Array && state.ckR.length > 0;
  const stateHasSendChain = state?.ckS instanceof Uint8Array && state.ckS.length > 0;
  const isGuestLike = guestLike;
  if (safeKeepSendState && stateHasRatchet && !force) {
    try {
      drConsole.warn('[dr-log:keep-send-skip-responder]', {
        peerAccountDigest: peer,
        peerDeviceId,
        hasCkS: stateHasSendChain,
        hasCkR: stateHasReceiveChain,
        Ns: Number(state?.Ns) || null
      });
    } catch {}
    return true;
  }
  if (!force && stateHasRatchet && stateHasReceiveChain) {
    return true;
  }

  const context = conversationContextForPeer(peer) || {};
  const drInit = context?.dr_init || secretInfo?.conversationDrInit || null;
  const guestBundle = drInit?.guest_bundle || null;

  const allowResponderBootstrap = (() => {
    // guest/initiator 端禁止 responder bootstrap；僅 owner/既有 responder 可啟動。
    const currentRole = state?.baseKey?.role;
    if (relationshipRole === 'guest' || currentRole === 'initiator') return false;
    if (relationshipRole === 'owner') return true;
    if (currentRole === 'responder') return true;
    return false;
  })();
  if (guestBundle && allowResponderBootstrap) {
    let normalizedGuestBundle = null;
    try {
      normalizedGuestBundle = normalizeGuestBundleStrict(guestBundle);
    } catch (err) {
      drConsole.error('[dr-log:bootstrap-guest-bundle-invalid]', {
        peerAccountDigest: peer,
        peerDeviceId,
        reason: err?.message || err
      });
      throw err;
    }
    const holderNow = drState({ peerAccountDigest: peer, peerDeviceId });
    const roleNow = holderNow?.baseKey?.role;
    const hasReceiveChain = holderNow?.ckR instanceof Uint8Array && holderNow.ckR.length > 0 && roleNow === 'responder';
    if (holderNow?.rk && hasReceiveChain && roleNow === 'responder' && !force) {
      try {
        drConsole.warn('[dr-log:bootstrap-responder-skip]', {
          reason: 'existing-responder-state',
          peerAccountDigest: peer,
        peerDeviceId,
        stateKey,
        roleNow: roleNow || null,
        hasCkS: !!(holderNow?.ckS && holderNow.ckS.length),
        hasCkR: !!(holderNow?.ckR && holderNow.ckR.length),
          Ns: Number.isFinite(holderNow?.Ns) ? Number(holderNow.Ns) : null,
          Nr: Number.isFinite(holderNow?.Nr) ? Number(holderNow.Nr) : null
        });
      } catch {}
      return true;
    }
    if (!hasReceiveChain && (secretHasChains || holderNow?.Ns > 0 || holderNow?.Nr > 0)) {
      drConsole.error('[dr-log:missing-ckR-bug]', {
        peerAccountDigest: peer,
        peerDeviceId,
        stateKey,
        secretKey,
        secretRole: relationshipRole || null,
        roleNow: roleNow || null,
        hasCkR: !!(holderNow?.ckR && holderNow.ckR.length),
        hasCkS: !!(holderNow?.ckS && holderNow.ckS.length),
        Ns: Number.isFinite(holderNow?.Ns) ? Number(holderNow.Ns) : null,
        Nr: Number.isFinite(holderNow?.Nr) ? Number(holderNow.Nr) : null,
        secretHasChains,
        force,
        callsite: callsiteTag
      });
      return false;
    }
    const shouldForce = force || conversationMismatch || !hasReceiveChain || roleNow !== 'responder';
    try {
      drConsole.warn('[dr-log:bootstrap-responder-start]', {
        reason: (() => {
          if (force) return 'force';
          if (conversationMismatch) return 'conversation-mismatch';
          if (!hasReceiveChain) return 'missing-ckR';
          if (roleNow !== 'responder') return 'role-not-responder';
          return 'no-state';
        })(),
        peerAccountDigest: peer,
        peerDeviceId,
        stateKey,
        secretKey,
        secretRole: relationshipRole || null,
        roleNow: roleNow || null,
        hasCkS: !!(holderNow?.ckS && holderNow.ckS.length),
        hasCkR: !!(holderNow?.ckR && holderNow.ckR.length),
        Ns: Number.isFinite(holderNow?.Ns) ? Number(holderNow.Ns) : null,
        hasSnapshot: !!secretInfo?.drState,
        force: shouldForce,
        conversationId
      });
    } catch {}
    await bootstrapDrFromGuestBundle({
      peerAccountDigest: peer,
      guestBundle: normalizedGuestBundle,
      force: shouldForce,
      peerDeviceId,
      conversationId
    });
    const refreshed = drState({ peerAccountDigest: peer, peerDeviceId });
    if (conversationId) {
      refreshed.baseKey = refreshed.baseKey || {};
      refreshed.baseKey.conversationId = conversationId;
    }
    try {
      drConsole.log('[dr-log:bootstrap-responder]', {
        peerAccountDigest: peer,
        peerDeviceId,
        conversationId,
        role: refreshed?.baseKey?.role || null,
        hasCkR: !!(refreshed?.ckR && refreshed.ckR.length),
        hasCkS: !!(refreshed?.ckS && refreshed.ckS.length)
      });
    } catch {}
    const refreshedRole = typeof refreshed?.baseKey?.role === 'string' ? refreshed.baseKey.role.toLowerCase() : null;
    if (
      refreshed?.rk &&
      refreshed?.ckR instanceof Uint8Array &&
      refreshed.ckR.length > 0 &&
      refreshed.myRatchetPriv instanceof Uint8Array &&
      refreshedRole === 'responder'
    ) {
      return true;
    }
    throw new Error('DR responder bootstrap failed');
  }

  const holder = drState({ peerAccountDigest: peer, peerDeviceId });
  const holderRole = typeof holder?.baseKey?.role === 'string' ? holder.baseKey.role.toLowerCase() : null;
  const holderHasRatchet = !!(holder?.rk && holder?.myRatchetPriv && holder?.myRatchetPub);
  const holderHasReceiveChain = holder?.ckR instanceof Uint8Array && holder.ckR.length > 0;
  // 若已有送出鏈，且沒有客觀理由強制切換 responder，優先保留現有 send 狀態。
  if (safeKeepSendState && holderHasRatchet) {
    return true;
  }
  if (conversationId && holder) {
    holder.baseKey = holder.baseKey || {};
    holder.baseKey.conversationId = holder.baseKey.conversationId || conversationId;
  }
  const holderRoleNow = typeof holder?.baseKey?.role === 'string' ? holder.baseKey.role.toLowerCase() : null;
  // guest/未知角色若發現 responder 或缺 initiator 鏈，直接清空並要求重建 initiator（無 fallback）。
  if (isGuestLike && (!holderHasRatchet || holderRoleNow === 'responder')) {
    try {
      drConsole.warn('[dr-log:guest-clear-responder]', {
        peerAccountDigest: peer,
        peerDeviceId,
        holderRole: holderRoleNow || null,
        Ns: Number.isFinite(holder?.Ns) ? Number(holder.Ns) : null,
        hasCkS: !!(holder?.ckS && holder.ckS.length),
        hasCkR: !!(holder?.ckR && holder.ckR.length)
      });
    } catch {}
    clearDrState(
      { peerAccountDigest: peer, peerDeviceId },
      { __drDebugTag: 'web/src/app/features/dr-session.js:2271:ensureResponderState:guest-clear-responder' }
    );
    setContactSecret(peer, { deviceId: selfDeviceId, dr: null, meta: { source: 'dr-guest-clear-responder' } });
    // 嘗試使用 contact-secret 中的 initiator 快照重建（僅限 role=initiator）。
    const snapRole = typeof secretInfo?.drState?.role === 'string' ? secretInfo.drState.role.toLowerCase() : null;
    if (snapRole === 'initiator') {
      restoreDrStateFromSnapshot({ peerAccountDigest: peer, peerDeviceId, snapshot: secretInfo.drState, force: true, sourceTag: 'guest-recover-initiator' });
      state = drState({ peerAccountDigest: peer, peerDeviceId });
      if (state?.rk && state?.baseKey?.role && String(state.baseKey.role).toLowerCase() === 'initiator') {
        return true;
      }
    }
    if (!guestBundle) {
      throw new Error('guest 端缺少 initiator 重建資料，請重新同步好友');
    }
    throw new Error('guest 端不得使用 responder 快照，請重新同步好友並重建 initiator');
  }
  // guest/未知角色若發現 responder 或缺 initiator 鏈，直接 fail 或要求重建 initiator（無 fallback）。
  if (isGuestLike && (!holderHasRatchet || holderRole === 'responder')) {
    clearDrState(
      { peerAccountDigest: peer, peerDeviceId },
      { __drDebugTag: 'web/src/app/features/dr-session.js:2292:ensureResponderState:guest-clear-responder-fail' }
    );
    if (!guestBundle) {
      throw new Error('guest 端缺少 initiator 重建資料，請重新同步好友');
    }
    throw new Error('guest 端不得使用 responder 快照，請重新同步好友並重建 initiator');
  }
  if (holderHasRatchet && holderHasReceiveChain) {
    return true;
  }
  // guest/未知角色若無 usable state 或被清空 responder，需使用 initiator 路徑；若缺 dr_init 則直接 fail（無 fallback）。
  if (isGuestLike) {
    if (!guestBundle) {
      throw new Error('guest 端缺少 initiator 重建資料，請重新同步好友');
    }
    throw new Error('guest 端不得使用 responder 快照，請重新同步好友並重建 initiator');
  }
  if (holderHasRatchet && (relationshipRole === 'guest' || holderRole === 'initiator')) {
    return true;
  }

  throw new Error('缺少安全會話狀態，請重新同步好友或重新建立邀請');
}

export async function recoverDrState(params = {}) {
  throw new Error('DR recovery disabled：請重新同步好友或重新建立邀請');
}

export function prepareDrForMessage(params = {}) {
  const {
    peerAccountDigest,
    messageTs,
    messageId,
    allowCursorReplay = false,
    stateOverride = null,
    mutate = true
  } = params;
  const peer = resolvePeerDigest({ peerAccountDigest, ...params });
  const peerDeviceId = params?.peerDeviceId ?? null;
  if (!peer || !peerDeviceId) return { restored: false, duplicate: false };
  const deviceId = ensureDeviceId();
  const holder = stateOverride || drState({ peerAccountDigest: peer, peerDeviceId });
  if (!holder?.rk) {
    throw new Error('缺少安全會話狀態，請重新同步好友或重新建立邀請');
  }
  const stamp = Number(messageTs);
  const stampIsFinite = Number.isFinite(stamp);
  const cursorTs = Number.isFinite(holder?.historyCursorTs) ? holder.historyCursorTs : null;
  const cursorId = holder?.historyCursorId || null;
  if (!allowCursorReplay && cursorId && messageId && cursorId === messageId) {
    if (isAutomationEnv()) {
      drConsole.log('[dr-skip-duplicate]', JSON.stringify({ peerAccountDigest: peer, messageId, cursorTs }));
    }
    return { restored: false, duplicate: true };
  }
  if (Number.isFinite(stamp)) holder.historyCursorTs = stamp;
  if (messageId) holder.historyCursorId = messageId;
  return { restored: false, duplicate: false, historyEntry: null };
}

export function recordDrMessageHistory(params = {}) {
  const { messageTs, messageId, snapshot, snapshotNext, messageKeyB64 } = params;
  const peer = resolvePeerDigest(params);
  const peerDeviceId = params?.peerDeviceId ?? null;
  const stamp = Number(messageTs);
  if (!peer || !peerDeviceId || !snapshot || !Number.isFinite(stamp)) return false;
  appendDrHistoryEntry({
    peerAccountDigest: peer,
    ts: stamp,
    snapshot,
    snapshotNext,
    messageId,
    messageKeyB64
  });
  updateHistoryCursor({ peerAccountDigest: peer, peerDeviceId, ts: stamp, messageId });
  if (isAutomationEnv()) {
    drConsole.log('[dr-history-record]', JSON.stringify({ peerAccountDigest: peer, ts: stamp, messageId: messageId || null }));
  }
  const holder = drState({ peerAccountDigest: peer, peerDeviceId });
  if (holder) {
    holder.historyCursorTs = stamp;
    if (messageId) holder.historyCursorId = messageId;
  }
  return true;
}

// Outbox integration: persist DR snapshots/history once送出成功。
try {
  setOutboxHooks({
    onSent: async (job) => {
      const peer = job?.peerAccountDigest || null;
      const peerDeviceId = job?.peerDeviceId || null;
      const dr = job?.dr || {};
      const messageTs = Number(job?.createdAt);
      const nsBefore = Number.isFinite(dr?.snapshotBefore?.Ns) ? Number(dr.snapshotBefore.Ns) : null;
      const nsAfter = Number.isFinite(dr?.snapshotAfter?.Ns) ? Number(dr.snapshotAfter.Ns) : null;
      try {
        drConsole.log('[dr-log:outbox-sent]', JSON.stringify({
          peerAccountDigest: peer,
          peerDeviceId,
          messageId: job?.messageId || null,
          hasSnapshotBefore: !!dr?.snapshotBefore,
          hasSnapshotAfter: !!dr?.snapshotAfter,
          NsBefore: nsBefore,
          NrBefore: Number.isFinite(dr?.snapshotBefore?.Nr) ? Number(dr.snapshotBefore.Nr) : null,
          NsAfter: nsAfter,
          NrAfter: Number.isFinite(dr?.snapshotAfter?.Nr) ? Number(dr.snapshotAfter.Nr) : null,
          hasCkSBefore: !!dr?.snapshotBefore?.ckS_b64,
          hasCkSAfter: !!dr?.snapshotAfter?.ckS_b64
        }));
      } catch {}
      if (peer && peerDeviceId && dr.snapshotBefore && Number.isFinite(messageTs)) {
        recordDrMessageHistory({
          peerAccountDigest: peer,
          peerDeviceId,
          messageTs,
          messageId: job?.messageId || null,
          snapshot: dr.snapshotBefore,
          snapshotNext: dr.snapshotAfter || null,
          messageKeyB64: dr.messageKeyB64 || null
        });
      }
      if (peer && dr.snapshotAfter) {
        try {
          drConsole.log('[dr-log:outbox-before-persist]', JSON.stringify({
            peerAccountDigest: peer,
            peerDeviceId,
            messageId: job?.messageId || null,
            hasSnapshotAfter: !!dr?.snapshotAfter
          }));
        } catch {}
        const persisted = persistDrSnapshot({ peerAccountDigest: peer, peerDeviceId, snapshot: dr.snapshotAfter });
        try {
          drConsole.log('[dr-log:outbox-persist]', JSON.stringify({
            peerAccountDigest: peer,
            peerDeviceId,
            messageId: job?.messageId || null,
            NsBefore: nsBefore,
            NsAfter: nsAfter,
            persisted
          }));
        } catch {}
      }
    }
  });
  startOutboxProcessor();
} catch (err) {
  drConsole.warn('[outbox] init failed', err);
}
