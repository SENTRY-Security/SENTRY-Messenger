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
import { x3dhInitiate, drEncryptText, x3dhRespond } from '../crypto/dr.js';
import { b64, b64u8 } from '../crypto/nacl.js';
import { getAccountDigest, drState, normalizePeerIdentity, getDeviceId, ensureDeviceId, normalizeAccountDigest, clearDrStatesByAccount, clearDrState, normalizePeerDeviceId } from '../core/store.js';
import { getContactSecret, setContactSecret, restoreContactSecrets } from '../core/contact-secrets.js';
import { sessionStore } from '../ui/mobile/session-store.js';
import {
  conversationIdFromToken
} from './conversation.js';
import { ensureDevicePrivAvailable } from './device-priv.js';
import { encryptAndPutWithProgress } from './media.js';
import {
  enqueueOutboxJob,
  processOutboxJobNow,
  setOutboxHooks,
  startOutboxProcessor
} from './queue/outbox.js';
import { enqueueReceiptJob } from './queue/receipts.js';

const sendFailureCounter = new Map(); // peerDigest::deviceId -> count
import { enqueueMediaMetaJob } from './queue/media.js';

function normHex(value) {
  const digest = normalizeAccountDigest(
    value?.peerAccountDigest ?? value?.accountDigest ?? value
  );
  return digest || null;
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

function ensurePeerIdentity({ peerAccountDigest, peerDeviceId, conversationId = null }) {
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
  if (!digest || !device) throw new Error('peerAccountDigest and peerDeviceId are required');
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

function cloneU8(src) {
  if (!(src instanceof Uint8Array)) return src;
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

function isAutomationEnv() {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  if (typeof window !== 'undefined' && window.__DEBUG_DR_STATE__) return true;
  return false;
}

function logDrSend(event, payload) {
  if (!isAutomationEnv()) return;
  try {
    console.log('[dr-send]', JSON.stringify({ event, ...payload }, null, 2));
  } catch {
    console.log('[dr-send]', { event, ...payload });
  }
}

function decodeB64(str) {
  if (!str || typeof str !== 'string') return null;
  try {
    return b64u8(str);
  } catch {
    return null;
  }
}

function buildReceiptMessageId(targetMessageId) {
  const base = typeof targetMessageId === 'string' && targetMessageId.trim()
    ? targetMessageId.trim()
    : 'receipt';
  return `receipt-${base}-${crypto.randomUUID()}`;
}

function sanitizeSnapshotInput(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const pick = (primary, fallback) => {
    if (primary && typeof primary === 'string') return primary.trim() || null;
    if (fallback && typeof fallback === 'string') return fallback.trim() || null;
    return null;
  };
  const rk = pick(snapshot.rk_b64, snapshot.rk);
  if (!rk) return null;
  const out = {
    v: Number.isFinite(Number(snapshot.v)) ? Number(snapshot.v) : 1,
    rk_b64: rk,
    ckS_b64: pick(snapshot.ckS_b64, snapshot.ckS),
    ckR_b64: pick(snapshot.ckR_b64, snapshot.ckR),
    Ns: numberOrDefault(snapshot.Ns, 0),
    Nr: numberOrDefault(snapshot.Nr, 0),
    PN: numberOrDefault(snapshot.PN, 0),
    myRatchetPriv_b64: pick(snapshot.myRatchetPriv_b64, snapshot.myRatchetPriv),
    myRatchetPub_b64: pick(snapshot.myRatchetPub_b64, snapshot.myRatchetPub),
    theirRatchetPub_b64: pick(snapshot.theirRatchetPub_b64, snapshot.theirRatchetPub),
    pendingSendRatchet: !!snapshot.pendingSendRatchet,
    role: typeof snapshot.role === 'string' ? snapshot.role.trim() || null : null,
    updatedAt: (() => {
      const ts = Number(snapshot.updatedAt ?? snapshot.snapshotTs ?? snapshot.ts);
      return Number.isFinite(ts) && ts > 0 ? ts : null;
    })()
  };
  return out;
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
    console.log('[dr-history-append]', JSON.stringify({
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
    console.log('[dr-history-cursor]', JSON.stringify({
      peerAccountDigest: peer,
      ts: Number.isFinite(stamp) ? stamp : null,
      messageId: messageId || null
    }));
  }
}

export function snapshotDrState(state, { setDefaultUpdatedAt = true } = {}) {
  if (!state || !(state.rk instanceof Uint8Array)) return null;
  const selfDeviceId = ensureDeviceId() || null;
  const snap = {
    v: 1,
    rk_b64: b64(state.rk),
    ckS_b64: state.ckS instanceof Uint8Array ? b64(state.ckS) : null,
    ckR_b64: state.ckR instanceof Uint8Array ? b64(state.ckR) : null,
    Ns: numberOrDefault(state.Ns, 0),
    Nr: numberOrDefault(state.Nr, 0),
    PN: numberOrDefault(state.PN, 0),
    myRatchetPriv_b64: state.myRatchetPriv instanceof Uint8Array ? b64(state.myRatchetPriv) : null,
    myRatchetPub_b64: state.myRatchetPub instanceof Uint8Array ? b64(state.myRatchetPub) : null,
    theirRatchetPub_b64: state.theirRatchetPub instanceof Uint8Array ? b64(state.theirRatchetPub) : null,
    pendingSendRatchet: !!state.pendingSendRatchet,
    role: state.baseKey?.role || null,
    selfDeviceId,
    updatedAt: Number.isFinite(state.snapshotTs) && state.snapshotTs > 0 ? state.snapshotTs : null
  };
  if (setDefaultUpdatedAt && !snap.updatedAt) snap.updatedAt = Date.now();
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
  if (!peer && !targetState) return false;
  const data = sanitizeSnapshotInput(snapshot);
  if (!data) return false;
  // 丟棄非本機裝置的 responder 快照，避免 guest 端錯用對端狀態。
  if (selfDeviceId) {
    if (data.selfDeviceId && data.selfDeviceId !== selfDeviceId) return false;
    if (data.role && data.role.toLowerCase() === 'responder' && peerDeviceId && selfDeviceId !== peerDeviceId) return false;
  }
  const holder = targetState || drState({ peerAccountDigest: peer, peerDeviceId });
  if (!holder) return false;
  if (!targetState && !force && holder?.rk && holder.snapshotTs && data.updatedAt && holder.snapshotTs >= data.updatedAt) {
    return false;
  }
  const assign = (prop, valueB64) => {
    if (valueB64) {
      const decoded = decodeB64(valueB64);
      holder[prop] = decoded ? new Uint8Array(decoded) : null;
    } else {
      holder[prop] = null;
    }
  };
  assign('rk', data.rk_b64);
  assign('ckS', data.ckS_b64);
  assign('ckR', data.ckR_b64);
  holder.Ns = numberOrDefault(data.Ns, holder.Ns || 0);
  holder.Nr = numberOrDefault(data.Nr, holder.Nr || 0);
  holder.PN = numberOrDefault(data.PN, holder.PN || 0);
  assign('myRatchetPriv', data.myRatchetPriv_b64);
  assign('myRatchetPub', data.myRatchetPub_b64);
  assign('theirRatchetPub', data.theirRatchetPub_b64);
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
  if (!holder?.rk) return false;
  const snap = snapshot || snapshotDrState(holder);
  if (!snap) return false;
  // contact secret 以「本機裝置」為鍵，peerDeviceId 僅為對端識別；寫入使用 self deviceId。
  const selfDeviceId = ensureDeviceId();
  const deviceId = selfDeviceId || peerDeviceId;
  const info = getContactSecret(peer, { deviceId, peerDeviceId });
  if (!info) {
    console.warn('[dr] persist snapshot skipped: missing contact secret', { peerAccountDigest: peer, deviceId: peerDeviceId });
    return false;
  }
  try {
    const update = {
      dr: { state: snap },
      meta: { source: 'persistDrSnapshot' }
    };
    const conversationUpdate = {};
    if (info.conversationToken) conversationUpdate.token = info.conversationToken;
    if (info.conversationId) conversationUpdate.id = info.conversationId;
    if (info.conversationDrInit) conversationUpdate.drInit = info.conversationDrInit;
    if (Object.keys(conversationUpdate).length) update.conversation = conversationUpdate;
    setContactSecret(peer, { ...update, deviceId });
    markHolderSnapshot(holder, 'persist', snap.updatedAt || Date.now());
    return true;
  } catch (err) {
    console.warn('[dr] persist snapshot failed', err);
    return false;
  }
}

export function hydrateDrStatesFromContactSecrets() {
  const map = restoreContactSecrets();
  if (!(map instanceof Map)) return 0;
  const deviceId = ensureDeviceId();
  const resolvePeerDeviceIdStrict = (peerDigest) => {
    const conv = sessionStore.contactIndex?.get?.(peerDigest)?.conversation;
    const convDev = conv?.peerDeviceId || null;
    if (convDev) return convDev;
    return resolvePeerDeviceId(peerDigest, null);
  };
  let restoredCount = 0;
  let eligibleEntries = 0;
  let skippedInvalidRole = 0;
  let skippedDeviceMismatch = 0;
  let skippedResponderPeerMismatch = 0;
  let missingSnapshotEntries = 0;
  let historyFallbackCount = 0;
  for (const [peerDigest] of map.entries()) {
    let peerDeviceIdResolved = resolvePeerDeviceIdStrict(peerDigest);
    const info = getContactSecret(peerDigest, { deviceId });
    // conversationId 正規化：若存在 contacts-* 假 ID 與實際 ID，保留實際 ID。
    if (info?.conversationId && typeof info.conversationId === 'string' && info.conversationId.startsWith('contacts-') && info?.conversation?.id && !String(info.conversation.id).startsWith('contacts-')) {
      setContactSecret(peerDigest, { deviceId, conversation: { id: info.conversation.id, token: info.conversationToken || null }, meta: { source: 'hydrate-conversation-normalize' } });
      info.conversationId = info.conversation.id;
    }
    if (info?.conversationId && typeof info.conversationId === 'string' && info.conversationId.startsWith('contacts-') && !info?.conversation?.id) {
      // contacts-* 但沒有實際 conv，直接清除，避免假 conv 污染。
      setContactSecret(peerDigest, { deviceId, conversation: null, dr: null, meta: { source: 'hydrate-drop-contacts-conv' } });
      clearDrStatesByAccount(peerDigest);
      continue;
    }
    // 若缺角色且 peerDeviceId != self，預設為 guest，避免還原 responder 快照。
    if (!info.role && peerDeviceIdResolved && deviceId && peerDeviceIdResolved !== deviceId) {
      setContactSecret(peerDigest, { deviceId, role: 'guest', meta: { source: 'hydrate-set-guest-role' } });
      info.role = 'guest';
    }
    if (!peerDeviceIdResolved && info?.conversation?.peerDeviceId) {
      peerDeviceIdResolved = info.conversation.peerDeviceId;
    }
    if (!peerDeviceIdResolved) {
      // 無法解析對端裝置時，清除記憶體中同 digest 的 state 避免沿用舊 responder。
      clearDrStatesByAccount(peerDigest);
      continue;
    }
    if (!info) {
      clearDrStatesByAccount(peerDigest);
      continue;
    }
    let snapshot = info.drState || null;
    let snapshotFromHistory = false;
    if (!snapshot && Array.isArray(info.drHistory) && info.drHistory.length) {
      const fallback = info.drHistory[info.drHistory.length - 1];
      if (fallback?.snapshot) {
        snapshot = fallback.snapshot;
        snapshotFromHistory = true;
      }
    }
    if (!snapshot) {
      missingSnapshotEntries += 1;
      if (isAutomationEnv()) {
        console.log('[dr] hydrate skip (no-snapshot)', JSON.stringify({
          peerAccountDigest: peerDigest,
          hasHistory: Array.isArray(info?.drHistory) && info.drHistory.length > 0,
          historyLen: Array.isArray(info?.drHistory) ? info.drHistory.length : 0
        }));
      }
      continue;
    }
    eligibleEntries += 1;
    const relationshipRole = typeof info.role === 'string' ? info.role.toLowerCase() : null;
    const snapshotRole = typeof snapshot?.role === 'string' ? snapshot.role.toLowerCase() : null;
    const snapshotSelfDeviceId = typeof snapshot?.selfDeviceId === 'string' ? snapshot.selfDeviceId : null;
    const expectedSnapshotRole = (() => {
      if (relationshipRole === 'owner') return 'responder';
      if (relationshipRole === 'guest') return 'initiator';
      return null;
    })();
    const isGuestLike = relationshipRole === 'guest'
      || expectedSnapshotRole === 'initiator'
      // 沒有明確角色但 peerDeviceId 與 self 不同，也視為 guest 端以避免錯用 responder
      || (!relationshipRole && deviceId && peerDeviceIdResolved && deviceId !== peerDeviceIdResolved);
    if (deviceId && snapshotSelfDeviceId && snapshotSelfDeviceId !== deviceId) {
      skippedDeviceMismatch += 1;
      if (isAutomationEnv()) {
        console.log('[dr] hydrate skip (self-device-mismatch)', JSON.stringify({
          peerAccountDigest: peerDigest,
          peerDeviceId: peerDeviceIdResolved,
          snapshotSelfDeviceId
        }));
      }
      continue;
    }
    if (isGuestLike && snapshotRole === 'responder') {
      skippedResponderPeerMismatch += 1;
      if (isAutomationEnv()) {
        console.log('[dr] hydrate skip (responder-peer-mismatch)', JSON.stringify({
          peerAccountDigest: peerDigest,
          peerDeviceId: peerDeviceIdResolved,
          selfDeviceId: deviceId
        }));
      }
      continue;
    }
    if (expectedSnapshotRole && snapshotRole && snapshotRole !== expectedSnapshotRole) {
      skippedInvalidRole += 1;
      continue;
    }
    const applied = restoreDrStateFromSnapshot({ peerAccountDigest: peerDigest, peerDeviceId: peerDeviceIdResolved, snapshot });
    if (applied) {
      const holder = drState({ peerAccountDigest: peerDigest, peerDeviceId: peerDeviceIdResolved });
      if (holder) {
        holder.historyCursorTs = Number.isFinite(info?.drHistoryCursorTs) ? info.drHistoryCursorTs : null;
        holder.historyCursorId = info?.drHistoryCursorId || null;
      }
      restoredCount += 1;
      if (snapshotFromHistory) {
        historyFallbackCount += 1;
        setContactSecret(peerDigest, {
          deviceId,
          dr: { state: snapshot },
          meta: { source: 'hydrateDrStateFallback' }
        });
      }
    }
  }
  if (isAutomationEnv()) {
    console.log('[dr] hydrate snapshot summary', {
      total: map.size,
      eligibleEntries,
      restored: restoredCount,
      skippedInvalidRole,
      skippedDeviceMismatch,
      skippedResponderPeerMismatch,
      missingSnapshotEntries,
      historyFallbackCount
    });
  }
  return restoredCount;
}

export function copyDrState(target, source) {
  if (!target || !source) return;
  target.rk = cloneU8(source.rk) || null;
  target.ckS = cloneU8(source.ckS) || null;
  target.ckR = cloneU8(source.ckR) || null;
  target.Ns = Number(source.Ns || 0);
  target.Nr = Number(source.Nr || 0);
  target.PN = Number(source.PN || 0);
  target.myRatchetPriv = cloneU8(source.myRatchetPriv) || null;
  target.myRatchetPub = cloneU8(source.myRatchetPub) || null;
  target.theirRatchetPub = cloneU8(source.theirRatchetPub) || null;
  target.pendingSendRatchet = !!source.pendingSendRatchet;
  if (source.baseKey?.conversationId && (!target.baseKey || !target.baseKey.conversationId)) {
    target.baseKey = target.baseKey || {};
    target.baseKey.conversationId = source.baseKey.conversationId;
  }
  if (Number.isFinite(source.snapshotTs)) {
    target.snapshotTs = source.snapshotTs;
  }
  if (source.snapshotSource) {
    target.snapshotSource = source.snapshotSource;
  }
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
  return {
    rk: null,
    ckS: null,
    ckR: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    myRatchetPriv: null,
    myRatchetPub: null,
    theirRatchetPub: null,
    pendingSendRatchet: false,
    baseKey: null,
    snapshotTs: null,
    snapshotSource: null,
    historyCursorTs: null,
    historyCursorId: null,
    skippedKeys: new Map()
  };
}

export function cloneDrStateHolder(source) {
  const shell = createDrStateShell();
  if (!source) return shell;
  copyDrState(shell, source);
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

  const st = await x3dhInitiate(priv, bundle);
  const targetHolder = holder || drState({ peerAccountDigest: peer, peerDeviceId });
  if (!targetHolder) throw new Error('DR holder missing for peer device');
  copyDrState(targetHolder, st);
  targetHolder.baseKey = { role: 'initiator', initializedAt: Date.now(), peerDeviceId };
  markHolderSnapshot(targetHolder, 'initiator', Date.now());
  persistDrSnapshot({ peerAccountDigest: peer, peerDeviceId, state: targetHolder });
  return { initialized: true };
}

function conversationContextForPeer(peerAccountDigest) {
  try {
    const key = normHex(peerAccountDigest);
    if (!key) return null;
    const selfDeviceId = ensureDeviceId();
    // contact-secrets 先查，避免 contactIndex 尚未刷新時拿不到 token。
    try {
      const secret =
        getContactSecret(key, { deviceId: selfDeviceId })
        || getContactSecret(key, { deviceId: selfDeviceId, peerDeviceId: null })
        || getContactSecret(key, { deviceId: null, peerDeviceId: null });
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
      console.warn('[conversation] contact-secret lookup failed', err);
    }
    const contactIndex = sessionStore.contactIndex;
    const directKey = typeof peerAccountDigest === 'string' ? peerAccountDigest : null;
    const entry =
      contactIndex?.get?.(directKey) // 先試原始 key（可能含 ::deviceId）
      || contactIndex?.get?.(key)    // 再試純 digest
      || (() => {
        // 最後掃描 contactIndex，找出 digest 相同的 entry。
        if (!contactIndex || typeof contactIndex.entries !== 'function') return null;
        for (const [, info] of contactIndex.entries()) {
          const digest = normHex(info?.peerAccountDigest || info?.accountDigest || null);
          if (digest && digest === key) return info;
        }
        return null;
      })();
    if (entry?.conversation?.token_b64) {
      return {
        token_b64: entry.conversation.token_b64,
        conversation_id: entry.conversation.conversation_id || null,
        dr_init: entry.conversation.dr_init || null,
        peerDeviceId: entry.conversation.peerDeviceId || entry?.peerDeviceId || null
      };
    }
    const map = sessionStore.conversationIndex;
    if (map && typeof map.get === 'function') {
      for (const [convId, info] of map.entries()) {
        const peerMatch = normHex(info?.peerAccountDigest || null);
        if (peerMatch && peerMatch === key && info?.token_b64) {
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
    console.warn('[conversation] lookup failed', err);
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

  const convContext = conversation || conversationContextForPeer(peer);
  const tokenB64 = convContext?.token_b64 || convContext?.tokenB64 || null;
  if (!tokenB64) throw new Error('conversation token missing for peer, please refresh contacts');

  const peerDeviceId = peerDeviceInput || null;
  if (!peerDeviceId) {
    throw new Error('peerDeviceId required for secure send');
  }
  const selfDeviceId = ensureDeviceId();
  if (selfDeviceId && peerDeviceId === selfDeviceId) {
    throw new Error('peerDeviceId resolved to self device (invalid)');
  }

  const conversationId = convContext?.conversation_id || convContext?.conversationId || null;
  let state = drState({ peerAccountDigest: peer, peerDeviceId });
  let hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  const hasDrInit = !!(convContext?.dr_init?.guest_bundle || convContext?.dr_init?.guestBundle);

  if (!hasDrState) {
    // 嚴禁 fallback：若缺會話，僅允許顯式重建，直接報錯。
    if (hasDrInit) {
      await ensureDrReceiverState({ peerAccountDigest: peer, peerDeviceId, conversationId });
    } else {
      throw new Error('尚未建立安全對話，請重新同步好友或重新建立邀請');
    }
    state = drState({ peerAccountDigest: peer, peerDeviceId });
    hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  }

  if (!hasDrState && !hasDrInit) {
    throw new Error('尚未建立安全對話，請重新同步好友或重新建立邀請');
  }
  if (!state.baseKey) state.baseKey = {};
  if (conversationId && state.baseKey.conversationId !== conversationId) {
    state.baseKey.conversationId = conversationId;
  }

  const senderDeviceId = ensureDeviceId();
  const preSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false, forceNow: true });
  logDrSend('encrypt-before', { peerAccountDigest: peer, snapshot: preSnapshot || null });
  const pkt = await drEncryptText(state, text, { deviceId: senderDeviceId, version: 1 });
  const messageKeyB64 = pkt?.message_key_b64 || null;
  const postSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  const now = Math.floor(Date.now() / 1000);

  let finalConversationId = conversationId;
  if (!finalConversationId) finalConversationId = await conversationIdFromToken(tokenB64);

  const accountDigest = (getAccountDigest() || '').toUpperCase(); // self
  const receiverAccountDigest = peer; // 目標必須鎖定對端
  const receiverDeviceId = peerDeviceId; // 目標裝置為對端指定 device

  const meta = {
    ts: now,
    sender_digest: accountDigest || null,
    senderDigest: accountDigest || null,
    sender_device_id: senderDeviceId || null,
    senderDeviceId: senderDeviceId || null,
    msg_type: typeof metaOverrides?.msg_type === 'string' && metaOverrides.msg_type.length
      ? metaOverrides.msg_type
      : 'text'
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

  const messageId = typeof params?.messageId === 'string' && params.messageId.trim().length
    ? params.messageId.trim()
    : crypto.randomUUID();

  try {
    startOutboxProcessor();
    const job = await enqueueOutboxJob({
      conversationId: finalConversationId,
      messageId,
      headerJson,
    header: headerPayload,
    ciphertextB64: ctB64,
    counter: pkt.header?.n ?? null,
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
      const status = Number.isFinite(result?.status) ? ` (status=${result.status})` : '';
      throw new Error((result.error || 'sendText failed') + status);
    }
    sendFailureCounter.delete(`${peer}::${receiverDeviceId || 'unknown'}`);
    logDrSend('encrypt-after', { peerAccountDigest: peer, snapshot: postSnapshot });
    const msg = result.data && typeof result.data === 'object' ? result.data : {};
    if (!msg.id) msg.id = messageId;
    return { msg, convId: finalConversationId, secure: true };
  } catch (err) {
    const key = `${peer}::${receiverDeviceId || 'unknown'}`;
    const nextFail = (sendFailureCounter.get(key) || 0) + 1;
    sendFailureCounter.set(key, nextFail);
    if (nextFail >= 3) {
      throw new Error('DR 送出連續失敗，請重新同步好友或重新建立邀請');
    }
    if (preSnapshot) restoreDrStateFromSnapshot({ peerAccountDigest: peer, snapshot: preSnapshot, force: true, sourceTag: 'send-failed' });
    throw err;
  }
}

/**
 * 發送 DR 文字訊息（必要時會先初始化會話）。
 * @param {{ peerAccountDigest?: string, text: string, conversation?: { token_b64?:string, conversation_id?:string }, convId?: string }} p
 * @returns {Promise<{ msg: any, convId: string }>}
 */
export async function sendDrText(params = {}) {
  return sendDrPlaintext(params);
}

export async function sendDrDeliveryReceipt(params = {}) {
  const { messageId: targetMessageId, ...rest } = params;
  if (!targetMessageId) throw new Error('messageId required for delivery receipt');
  return sendDrPlaintext({
    ...rest,
    messageId: buildReceiptMessageId(targetMessageId),
    text: JSON.stringify({ type: CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT, messageId: targetMessageId }),
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

  const convContext = conversation || conversationContextForPeer(peer);
  const tokenB64 = convContext?.token_b64 || convContext?.tokenB64 || null;
  if (!tokenB64) throw new Error('conversation token missing for peer, please refresh contacts');

  const { deviceId: peerDeviceId } = ensurePeerIdentity({
    peerAccountDigest: peer,
    peerDeviceId: peerDeviceInput || conversation?.peerDeviceId || convContext?.peerDeviceId || null,
    conversationId: convId || convContext?.conversation_id || convContext?.conversationId || null
  });

  let state = drState({ peerAccountDigest: peer, peerDeviceId });
  let hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  const hasDrInit = !!(convContext?.dr_init?.guest_bundle || convContext?.dr_init?.guestBundle);

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
  const preSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false, forceNow: true });
  logDrSend('encrypt-media-before', { peerAccountDigest: peer, snapshot: preSnapshot || null, objectKey: metadata.objectKey });
  const pkt = await drEncryptText(state, payloadText, { deviceId: senderDeviceId, version: 1 });
  const messageKeyB64 = pkt?.message_key_b64 || null;
  const postSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  const now = Math.floor(Date.now() / 1000);

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
    msg_type: 'media',
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

  startOutboxProcessor();
  const job = await enqueueMediaMetaJob({
    conversationId,
    messageId: crypto.randomUUID(),
    headerJson,
    header: headerPayload,
    ciphertextB64: ctB64,
    counter: pkt.header?.n ?? null,
    senderDeviceId,
    receiverAccountDigest: peer,
    receiverDeviceId: receiverDeviceId || null,
    createdAt: now,
    meta: { msg_type: 'media', media: metadata },
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
    if (preSnapshot) restoreDrStateFromSnapshot({ peerAccountDigest: peer, snapshot: preSnapshot, force: true, sourceTag: 'send-failed' });
    throw new Error(result.error || 'sendMedia failed');
  }
  logDrSend('encrypt-media-after', { peerAccountDigest: peer, snapshot: postSnapshot || null, objectKey: metadata.objectKey });

  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const messageId = data?.id || job.messageId;
  if (preSnapshot) {
    recordDrMessageHistory({
      peerAccountDigest: peer,
      messageTs: now,
      messageId,
      snapshot: preSnapshot,
      snapshotNext: postSnapshot,
      messageKeyB64
    });
  }
  persistDrSnapshot({ peerAccountDigest: peer, state });

  return {
    msg: {
      id: messageId,
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
  const { callId, outcome, durationSeconds, direction, reason } = params;
  const payload = {
    type: 'call-log',
    callId: callId || null,
    outcome,
    durationSeconds,
    direction,
    reason
  };
  const metaOverrides = {
    msg_type: 'call-log',
    call_id: callId || null,
    call_outcome: outcome,
    call_duration: durationSeconds,
    call_direction: direction,
    call_reason: reason || null
  };
  const text = JSON.stringify(payload);
  return sendDrPlaintext({ ...params, text, metaOverrides });
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
  if (!st?.rk || !(st?.ckR instanceof Uint8Array) || !(st?.myRatchetPriv instanceof Uint8Array)) {
    throw new Error('guest bundle did not produce valid DR state');
  }
  copyDrState(holder, st);
  holder.baseKey = { role: 'responder', initializedAt: Date.now(), guestBundle, conversationId: conversationId || null };
  markHolderSnapshot(holder, 'responder', Date.now());
  persistDrSnapshot({ peerAccountDigest: peer, state: holder });
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
  copyDrState(holder, state);
  holder.baseKey = { role: 'initiator', initializedAt: Date.now(), primed: true, conversationId: conversationId || null };
  markHolderSnapshot(holder, 'prime', Date.now());
  return true;
}

export async function ensureDrReceiverState(params = {}) {
  const { force = false } = params;
  const { digest: peer, deviceId: peerDeviceId } = ensurePeerIdentity({
    peerAccountDigest: params?.peerAccountDigest ?? params,
    peerDeviceId: params?.peerDeviceId ?? null,
    conversationId: params?.conversationId ?? null
  });
  const conversationId = params?.conversationId || null;
  const selfDeviceId = ensureDeviceId();
  // contact-secrets 的 device record 以「本機 deviceId」為鍵，peerDeviceId 只作為辨識 peer 版本的 key。
  // 因此查詢時以 peerDeviceId 作為 hint，但 deviceId 一律用 selfDeviceId。
  let secretInfo =
    getContactSecret(peer, { peerDeviceId, deviceId: selfDeviceId, conversationId })
    || getContactSecret(peer, { deviceId: selfDeviceId, conversationId })
    || {};
  // 若缺角色且 peerDeviceId != self，預設為 guest，避免還原 responder 快照。
  if (!secretInfo?.role && selfDeviceId && peerDeviceId && selfDeviceId !== peerDeviceId) {
    setContactSecret(peer, { deviceId: selfDeviceId, role: 'guest', meta: { source: 'ensure-set-guest-role' } });
    secretInfo = { ...(secretInfo || {}), role: 'guest' };
  }
  const relationshipRole = typeof secretInfo?.role === 'string' ? secretInfo.role.toLowerCase() : null;
  let state = drState({ peerAccountDigest: peer, peerDeviceId });
  // guest/initiator 端若誤用 responder 快照（peerDeviceId != self），強制丟棄。
  const stateRoleRaw = state?.baseKey?.role;
  const stateRole = typeof stateRoleRaw === 'string' ? stateRoleRaw.toLowerCase() : null;
  const guestLike = relationshipRole === 'guest'
    || stateRole === 'initiator'
    // 無角色但 peerDeviceId 與 self 不同，也視為 guest 端避免錯用 responder。
    || (!relationshipRole && selfDeviceId && peerDeviceId && selfDeviceId !== peerDeviceId);
  if (guestLike && stateRole === 'responder') {
    clearDrState({ peerAccountDigest: peer, peerDeviceId });
    state = drState({ peerAccountDigest: peer, peerDeviceId });
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
    try {
      console.warn('[dr-log:conv-mismatch-clear]', {
        peerAccountDigest: peer,
        peerDeviceId,
        conversationId: preferredConversationId,
        baseConversationId,
        secretConversationId
      });
    } catch {}
    clearDrState({ peerAccountDigest: peer, peerDeviceId });
    try {
      setContactSecret(peer, { deviceId: selfDeviceId, dr: null, conversation: null, meta: { source: 'dr-conv-mismatch-clear' } });
    } catch {}
    state = drState({ peerAccountDigest: peer, peerDeviceId });
  }
  // guest 端不從快照還原 responder/未知角色；僅非 guest 端才嘗試還原。
  const snapshotRole = typeof secretInfo?.drState?.role === 'string' ? secretInfo.drState.role.toLowerCase() : null;
  if (!state?.rk && secretInfo?.drState && !guestLike) {
    restoreDrStateFromSnapshot({ peerAccountDigest: peer, peerDeviceId, snapshot: secretInfo.drState });
    state = drState({ peerAccountDigest: peer, peerDeviceId });
    try {
      console.log('[dr-log:restore-from-secret]', {
        peerAccountDigest: peer,
        peerDeviceId,
        conversationId,
        restored: !!state?.rk
      });
    } catch {}
  } else if (guestLike && secretInfo?.drState) {
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
  if (!force && stateHasRatchet && stateHasReceiveChain) {
    return true;
  }

  const context = conversationContextForPeer(peer) || {};
  const drInit = context?.dr_init || secretInfo?.conversationDrInit || null;
  const guestBundle = drInit?.guest_bundle || drInit?.guestBundle || null;

  const allowResponderBootstrap = (() => {
    // guest/initiator 端禁止 responder bootstrap；僅 owner/既有 responder 可啟動。
    const currentRole = state?.baseKey?.role;
    if (relationshipRole === 'guest' || currentRole === 'initiator') return false;
    if (relationshipRole === 'owner') return true;
    if (currentRole === 'responder') return true;
    return false;
  })();
  if (guestBundle && allowResponderBootstrap) {
    const holderNow = drState({ peerAccountDigest: peer, peerDeviceId });
    const roleNow = holderNow?.baseKey?.role;
    const hasReceiveChain = holderNow?.ckR instanceof Uint8Array && holderNow.ckR.length > 0 && roleNow === 'responder';
    const shouldForce = force || conversationMismatch || !hasReceiveChain || roleNow !== 'responder';
    await bootstrapDrFromGuestBundle({ peerAccountDigest: peer, guestBundle, force: shouldForce, peerDeviceId, conversationId });
    const refreshed = drState({ peerAccountDigest: peer, peerDeviceId });
    if (conversationId) {
      refreshed.baseKey = refreshed.baseKey || {};
      refreshed.baseKey.conversationId = conversationId;
    }
    try {
      console.log('[dr-log:bootstrap-responder]', {
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
  if (conversationId && holder) {
    holder.baseKey = holder.baseKey || {};
    holder.baseKey.conversationId = holder.baseKey.conversationId || conversationId;
  }
  const holderRoleNow = typeof holder?.baseKey?.role === 'string' ? holder.baseKey.role.toLowerCase() : null;
  // guest/未知角色若發現 responder 或缺 initiator 鏈，直接清空並要求重建 initiator（無 fallback）。
  if (isGuestLike && (!holderHasRatchet || holderRoleNow === 'responder')) {
    clearDrState({ peerAccountDigest: peer, peerDeviceId });
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
    clearDrState({ peerAccountDigest: peer, peerDeviceId });
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
      console.log('[dr-skip-duplicate]', JSON.stringify({ peerAccountDigest: peer, messageId, cursorTs }));
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
    console.log('[dr-history-record]', JSON.stringify({ peerAccountDigest: peer, ts: stamp, messageId: messageId || null }));
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
        persistDrSnapshot({ peerAccountDigest: peer, peerDeviceId, snapshot: dr.snapshotAfter });
      }
    }
  });
  startOutboxProcessor();
} catch (err) {
  console.warn('[outbox] init failed', err);
}
