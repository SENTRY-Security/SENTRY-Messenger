// /app/features/dr-session.js
// X3DH 初始化與 DR 文字訊息發送（功能層，無 UI）。

import { prekeysBundle } from '../api/prekeys.js';
import { friendsBootstrapSession } from '../api/friends.js';
import { x3dhInitiate, drEncryptText, x3dhRespond } from '../crypto/dr.js';
import { b64, b64u8 } from '../crypto/nacl.js';
import { getAccountDigest, drState, normalizePeerIdentity, getDeviceId } from '../core/store.js';
import { getContactSecret, setContactSecret, restoreContactSecrets } from '../core/contact-secrets.js';
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
import { enqueueMediaMetaJob } from './queue/media.js';

function normHex(value) {
  const identity = normalizePeerIdentity(
    value?.peerAccountDigest ?? value?.accountDigest ?? value
  );
  return identity.key || null;
}

function resolvePeerDigest(input) {
  if (!input) return null;
  if (typeof input === 'string') return normHex(input);
  if (typeof input !== 'object') return normHex(input);
  const candidate = input.peerAccountDigest ?? input.accountDigest ?? input;
  return normHex(candidate);
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
const SESSION_BOOTSTRAP_REFRESH_INTERVAL_MS = 180_000;

const remoteBootstrapLocks = new Map();

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
  const info = getContactSecret(peer);
  if (!info?.inviteId || !info?.secret) return false;
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
  const { ts, messageId, targetState = null, reasonTag = null } = params;
  const peer = resolvePeerDigest(params);
  if (!peer && !targetState) return false;
  const info = getContactSecret(peer);
  if (!info?.drHistory?.length) return false;
  const stamp = Number(ts);
  let entry = null;
  const normalizedHistory = info.drHistory.slice().sort((a, b) => compareHistoryKeys(Number(a?.ts), a?.messageId || null, Number(b?.ts), b?.messageId || null));
  if (messageId) {
    entry = normalizedHistory.find((item) => item?.messageId === messageId) || null;
  }
  if (!entry && Number.isFinite(stamp)) {
    for (let i = normalizedHistory.length - 1; i >= 0; i -= 1) {
      const candidate = normalizedHistory[i];
      if (!candidate) continue;
      const candidateTs = Number(candidate.ts);
      if (!Number.isFinite(candidateTs)) continue;
      if (candidateTs <= stamp) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry) entry = normalizedHistory[normalizedHistory.length - 1];
  if (!entry?.snapshot) return false;
  const restored = restoreDrStateFromSnapshot({
    peerAccountDigest: peer,
    snapshot: entry.snapshot,
    force: true,
    targetState,
    sourceTag: reasonTag || 'history-restore'
  });
  if (restored && isAutomationEnv()) {
    console.log('[dr-history-apply]', JSON.stringify({
      peerAccountDigest: peer,
      appliedTs: entry.ts,
      appliedMessageId: entry.messageId || null,
      requestedTs: stamp,
      requestedMessageId: messageId || null,
      mode: targetState ? 'preview' : 'live'
    }));
  }
  return restored;
}

export function restoreDrStateToHistoryPoint(params = {}) {
  return restoreDrStateFromHistory(params);
}

function updateHistoryCursor(params = {}) {
  const { ts, messageId } = params;
  const peer = resolvePeerDigest(params);
  if (!peer) return;
  const info = getContactSecret(peer);
  if (!info?.inviteId || !info?.secret) return;
  const stamp = Number(ts);
  const currentTs = Number.isFinite(info.drHistoryCursorTs) ? Number(info.drHistoryCursorTs) : null;
  const cursorId = info.drHistoryCursorId || null;
  const hasExistingCursor = currentTs !== null || !!cursorId;
  const cursorCompare = compareHistoryKeys(Number.isFinite(stamp) ? stamp : null, messageId || null, currentTs, cursorId);
  if (hasExistingCursor && cursorCompare <= 0) {
    return;
  }
  setContactSecret(peer, {
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
    updatedAt: Number.isFinite(state.snapshotTs) && state.snapshotTs > 0 ? state.snapshotTs : null
  };
  if (setDefaultUpdatedAt && !snap.updatedAt) snap.updatedAt = Date.now();
  return snap;
}

export function snapshotDrStateForPeer(peerAccountDigest) {
  const peer = normHex(peerAccountDigest);
  if (!peer) return null;
  const holder = drState(peer);
  if (!holder?.rk) return null;
  return snapshotDrState(holder);
}

export function restoreDrStateFromSnapshot(params = {}) {
  const { snapshot, force = false, targetState = null, sourceTag = 'snapshot' } = params;
  const peer = resolvePeerDigest(params);
  if (!peer && !targetState) return false;
  const data = sanitizeSnapshotInput(snapshot);
  if (!data) return false;
  const holder = targetState || drState(peer);
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
  const peer = resolvePeerDigest(params);
  if (!peer) return false;
  const holder = state || drState(peer);
  if (!holder?.rk) return false;
  const snap = snapshot || snapshotDrState(holder);
  if (!snap) return false;
  const info = getContactSecret(peer);
  if (!info?.inviteId || !info?.secret) {
    if (isAutomationEnv()) {
      console.warn('[dr] persist snapshot skipped (missing contact secret)', { peerAccountDigest: peer, hasInfo: !!info });
    }
    return false;
  }
  try {
    const update = {
      dr: { state: snap },
      meta: { source: 'persistDrSnapshot' }
    };
    const inviteUpdate = {};
    if (info.role) inviteUpdate.role = info.role;
    if (Object.keys(inviteUpdate).length) update.invite = inviteUpdate;
    const conversationUpdate = {};
    if (info.conversationToken) conversationUpdate.token = info.conversationToken;
    if (info.conversationId) conversationUpdate.id = info.conversationId;
    if (info.conversationDrInit) conversationUpdate.drInit = info.conversationDrInit;
    if (Object.keys(conversationUpdate).length) update.conversation = conversationUpdate;
    setContactSecret(peer, update);
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
  let restoredCount = 0;
  let eligibleEntries = 0;
  let skippedInvalidRole = 0;
  let missingSnapshotEntries = 0;
  let historyFallbackCount = 0;
  for (const [peerDigest, info] of map.entries()) {
    if (!info) continue;
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
    const expectedSnapshotRole = (() => {
      if (relationshipRole === 'owner') return 'responder';
      if (relationshipRole === 'guest') return 'initiator';
      return null;
    })();
    if (expectedSnapshotRole && snapshotRole && snapshotRole !== expectedSnapshotRole) {
      skippedInvalidRole += 1;
      continue;
    }
    const applied = restoreDrStateFromSnapshot({ peerAccountDigest: peerDigest, snapshot });
    if (applied) {
      const holder = drState(peerDigest);
      if (holder) {
        holder.historyCursorTs = Number.isFinite(info?.drHistoryCursorTs) ? info.drHistoryCursorTs : null;
        holder.historyCursorId = info?.drHistoryCursorId || null;
      }
      restoredCount += 1;
      if (snapshotFromHistory) {
        historyFallbackCount += 1;
        setContactSecret(peerDigest, {
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
  const peer = resolvePeerDigest(params);
  if (!peer) throw new Error('peerAccountDigest required');

  const holder = drState(peer);
  if (holder?.rk && holder?.myRatchetPriv && holder?.myRatchetPub) {
    return { initialized: true, reused: true };
  }

  const priv = await ensureDevicePrivLoaded();

  const { r: rb, data: bundle } = await prekeysBundle({ peer_accountDigest: peer });
  if (!rb.ok) throw new Error('prekeys.bundle failed: ' + (typeof bundle === 'string' ? bundle : JSON.stringify(bundle)));

  const st = await x3dhInitiate(priv, bundle);
  copyDrState(holder, st);
  holder.baseKey = { role: 'initiator', initializedAt: Date.now() };
  markHolderSnapshot(holder, 'initiator', Date.now());
  persistDrSnapshot({ peerAccountDigest: peer, state: holder });
  return { initialized: true };
}

function conversationContextForPeer(peerAccountDigest) {
  try {
    const key = normHex(peerAccountDigest);
    if (!key) return null;
    const entry = sessionStore.contactIndex?.get?.(key);
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
        const peerMatch = String(info?.peerAccountDigest || '').toUpperCase();
        if (peerMatch === key && info?.token_b64) {
          return {
            token_b64: info.token_b64,
            conversation_id: convId,
            dr_init: info.dr_init || null
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
  const { text, conversation, convId, metaOverrides = {} } = params;
  const peer = resolvePeerDigest(params);
  if (!peer) throw new Error('peerAccountDigest required');

  const convContext = conversation || conversationContextForPeer(peer);
  const tokenB64 = convContext?.token_b64 || convContext?.tokenB64 || null;
  if (!tokenB64) throw new Error('conversation token missing for peer, please refresh contacts');

  let state = drState(peer);
  let hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  const hasDrInit = !!(convContext?.dr_init?.guest_bundle || convContext?.dr_init?.guestBundle);

  if (!hasDrState) {
    // 若已有 guest bundle / dr_init，優先以 responder 流程恢復，避免誤用 initiator 重新開新鏈。
    let restored = false;
    if (hasDrInit) {
      try {
        await ensureDrReceiverState({ peerAccountDigest: peer });
        restored = true;
      } catch (err) {
        // 僅記錄，仍可嘗試 initiator 流程作為最後手段。
        console.warn('[dr] ensure receiver state failed, fallback to initiator', err?.message || err);
      }
      state = drState(peer);
      hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
    }
    if (!hasDrState) {
      try {
        await ensureDrSession({ peerAccountDigest: peer });
      } catch (err) {
        if (!hasDrInit && !restored) {
          throw new Error('尚未建立安全對話，請重新同步好友或重新建立邀請');
        }
        throw new Error('DR 會話初始化失敗：' + (err?.message || err));
      }
    }
    state = drState(peer);
    hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  }

  if (!hasDrState && !hasDrInit) {
    throw new Error('尚未建立安全對話，請重新同步好友或重新建立邀請');
  }

  const preSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  logDrSend('encrypt-before', { peerAccountDigest: peer, snapshot: preSnapshot || null });
  const pkt = await drEncryptText(state, text);
  const messageKeyB64 = pkt?.message_key_b64 || null;
  const postSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  const now = Math.floor(Date.now() / 1000);

  let conversationId = convContext?.conversation_id || convContext?.conversationId || null;
  if (!conversationId) conversationId = await conversationIdFromToken(tokenB64);

  const accountDigest = (getAccountDigest() || '').toUpperCase();
  const senderDeviceId = getDeviceId() || 'device-default';

  const meta = {
    ts: now,
    sender_digest: accountDigest || null,
    sender_device_id: senderDeviceId || null,
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

  const headerPayload = { ...pkt.header, iv_b64: pkt.iv_b64, meta };
  const headerJson = JSON.stringify(headerPayload);
  const ctB64 = pkt.ciphertext_b64;

  const messageId = typeof params?.messageId === 'string' && params.messageId.trim().length
    ? params.messageId.trim()
    : crypto.randomUUID();

  try {
    startOutboxProcessor();
    const job = await enqueueOutboxJob({
      conversationId,
      messageId,
      headerJson,
      header: headerPayload,
      ciphertextB64: ctB64,
      counter: pkt.header?.n ?? null,
      senderDeviceId,
      receiverAccountDigest: peer,
      receiverDeviceId: null,
      createdAt: now,
      peerAccountDigest: peer,
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
    logDrSend('encrypt-after', { peerAccountDigest: peer, snapshot: postSnapshot });
    const msg = result.data && typeof result.data === 'object' ? result.data : {};
    if (!msg.id) msg.id = messageId;
    return { msg, convId: conversationId, secure: true };
  } catch (err) {
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

export async function sendDrSessionInit(params = {}) {
  return sendDrPlaintext({
    ...params,
    text: 'session-init',
    metaOverrides: {
      msg_type: CONTROL_MESSAGE_TYPES.SESSION_INIT,
      control: 'bootstrap'
    }
  });
}

export async function sendDrSessionAck(params = {}) {
  return sendDrPlaintext({
    ...params,
    text: 'session-ack',
    metaOverrides: {
      msg_type: CONTROL_MESSAGE_TYPES.SESSION_ACK,
      control: 'ack'
    }
  });
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
  const { file, conversation, convId, dir, onProgress, abortSignal } = params;
  const peer = resolvePeerDigest(params);
  if (!peer) throw new Error('peerAccountDigest required');
  if (!file || typeof file !== 'object' || typeof file.arrayBuffer !== 'function') {
    throw new Error('file required');
  }

  const convContext = conversation || conversationContextForPeer(peer);
  const tokenB64 = convContext?.token_b64 || convContext?.tokenB64 || null;
  if (!tokenB64) throw new Error('conversation token missing for peer, please refresh contacts');

  let state = drState(peer);
  let hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  const hasDrInit = !!(convContext?.dr_init?.guest_bundle || convContext?.dr_init?.guestBundle);

  if (!hasDrState) {
    try {
      await ensureDrSession({ peerAccountDigest: peer });
    } catch (err) {
      if (!hasDrInit) {
        throw new Error('尚未建立安全對話，請重新同步好友或重新建立邀請');
      }
      throw new Error('DR 會話初始化失敗：' + (err?.message || err));
    }
    state = drState(peer);
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

  const preSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  logDrSend('encrypt-media-before', { peerAccountDigest: peer, snapshot: preSnapshot || null, objectKey: metadata.objectKey });
  const pkt = await drEncryptText(state, payloadText);
  const messageKeyB64 = pkt?.message_key_b64 || null;
  const postSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  const now = Math.floor(Date.now() / 1000);

  const senderDeviceId = getDeviceId() || 'device-default';

  const meta = {
    ts: now,
    sender_digest: accountDigest || null,
    sender_device_id: senderDeviceId || null,
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
    receiverDeviceId: null,
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
  const { guestBundle, force = false } = params;
  const peer = resolvePeerDigest(params);
  if (!peer) return false;
  if (!guestBundle || typeof guestBundle !== 'object') return false;
  const holder = drState(peer);
  if (holder?.rk && !force) return false;
  try {
    const priv = await ensureDevicePrivLoaded();
    const st = await x3dhRespond(priv, guestBundle);
    copyDrState(holder, st);
    holder.baseKey = { role: 'responder', initializedAt: Date.now(), guestBundle };
    markHolderSnapshot(holder, 'responder', Date.now());
    persistDrSnapshot({ peerAccountDigest: peer, state: holder });
    return true;
  } catch (err) {
    console.warn('[dr] responder bootstrap failed', err);
    return false;
  }
}

export function primeDrStateFromInitiator(params = {}) {
  const { state } = params;
  const peer = resolvePeerDigest(params);
  if (!peer || !state) return false;
  const holder = drState(peer);
  if (holder?.rk) return false;
  copyDrState(holder, state);
  holder.baseKey = { role: 'initiator', initializedAt: Date.now(), primed: true };
  markHolderSnapshot(holder, 'prime', Date.now());
  return true;
}

async function ensureRemoteBootstrap(params = {}) {
  const { reason = 'dr-session', force = false } = params;
  const peer = resolvePeerDigest(params);
  if (!peer) return null;
  const existing = getContactSecret(peer);
  if (!existing) return null;
  const relationshipRole = typeof existing?.role === 'string' ? existing.role.toLowerCase() : null;

  const lastTs = Number(existing.sessionBootstrapTs);
  if (!force && Number.isFinite(lastTs)) {
    const elapsed = Date.now() - lastTs * 1000;
    if (elapsed < SESSION_BOOTSTRAP_REFRESH_INTERVAL_MS) {
      return null;
    }
  }

  if (remoteBootstrapLocks.has(peer)) {
    return remoteBootstrapLocks.get(peer);
  }

  const worker = (async () => {
    try {
      const roleHint =
        relationshipRole === 'owner'
          ? 'owner'
          : (relationshipRole === 'guest' ? 'guest' : undefined);
      const res = await friendsBootstrapSession({
        peerAccountDigest: peer,
        roleHint,
        inviteId: existing?.inviteId || null
      });
      const guestBundle = res?.guestBundle || res?.guest_bundle || null;
      if (!guestBundle) return null;

      const mergedDrInit = { ...(existing.conversationDrInit || {}) };
      mergedDrInit.guest_bundle = guestBundle;
      mergedDrInit.guestBundle = guestBundle;

      setContactSecret(peer, {
        conversation: { drInit: mergedDrInit },
        session: { bootstrapTs: Math.floor(Date.now() / 1000) },
        meta: { source: `remote-bootstrap:${reason}` }
      });

      const contactEntry = sessionStore.contactIndex?.get?.(peer);
      if (contactEntry) {
        if (!contactEntry.conversation) contactEntry.conversation = {};
        if (!contactEntry.conversation.dr_init) contactEntry.conversation.dr_init = {};
        contactEntry.conversation.dr_init.guest_bundle = guestBundle;
        contactEntry.conversation.dr_init.guestBundle = guestBundle;
      }

      const convIndex = sessionStore.conversationIndex;
      if (convIndex && typeof convIndex.forEach === 'function') {
        for (const info of convIndex.values()) {
          const peerMatch = String(info?.peerAccountDigest || '').toUpperCase();
          if (!peerMatch || peerMatch !== peer) continue;
          if (!info.dr_init) info.dr_init = {};
          info.dr_init.guest_bundle = guestBundle;
          info.dr_init.guestBundle = guestBundle;
        }
      }

      return { guestBundle, role: res?.role || null, peerAccountDigest: peer };
    } catch (err) {
      console.warn('[dr] remote bootstrap fetch failed', err?.message || err);
      return null;
    } finally {
      remoteBootstrapLocks.delete(peer);
    }
  })();

  remoteBootstrapLocks.set(peer, worker);
  return worker;
}

export async function ensureDrReceiverState(params = {}) {
  const { force = false } = params;
  const peer = resolvePeerDigest(params);
  if (!peer) return false;
  const secretInfo = getContactSecret(peer);
  const relationshipRole = typeof secretInfo?.role === 'string' ? secretInfo.role.toLowerCase() : null;
  let state = drState(peer);
  if (!state?.rk && secretInfo?.drState) {
    try {
      restoreDrStateFromSnapshot({ peerAccountDigest: peer, snapshot: secretInfo.drState });
    } catch (err) {
      console.warn('[dr] ensure receiver restore failed', err);
    }
    state = drState(peer);
  }
  if (!state?.rk && Array.isArray(secretInfo?.drHistory) && secretInfo.drHistory.length) {
    const candidates = secretInfo.drHistory
      .slice()
      .reverse()
      .filter((entry) => entry && (entry.snapshotAfter || entry.snapshot));
    for (const entry of candidates) {
      try {
        const snap = entry.snapshotAfter || entry.snapshot;
        const ok = restoreDrStateFromSnapshot({ peerAccountDigest: peer, snapshot: snap, force: true });
        if (ok) {
          const holder = drState(peer);
          if (holder) {
            if (Number.isFinite(entry.ts)) holder.historyCursorTs = entry.ts;
            if (entry.messageId) holder.historyCursorId = entry.messageId;
            markHolderSnapshot(holder, 'ensure-history', Date.now());
            persistDrSnapshot({ peerAccountDigest: peer, state: holder });
          }
          state = drState(peer);
          if (
            state?.rk &&
            state.myRatchetPriv instanceof Uint8Array &&
            state.myRatchetPub instanceof Uint8Array &&
            (state.ckR instanceof Uint8Array || state.ckS instanceof Uint8Array)
          ) {
            break;
          }
        }
      } catch (err) {
        console.warn('[dr] ensure receiver history restore failed', err);
      }
    }
    state = drState(peer);
  }
  const stateRole = typeof state?.baseKey?.role === 'string' ? state.baseKey.role.toLowerCase() : null;
  const stateHasRatchet = !!(state?.rk && state?.myRatchetPriv && state?.myRatchetPub);
  const stateHasReceiveChain = state?.ckR instanceof Uint8Array && state.ckR.length > 0;
  const stateHasSendChain = state?.ckS instanceof Uint8Array && state.ckS.length > 0;
  const isGuestLike = relationshipRole === 'guest' || stateRole === 'initiator';
  if (!force && stateHasRatchet && stateHasReceiveChain) {
    return true;
  }
  if (!force && stateHasRatchet && isGuestLike && (stateHasSendChain || stateHasReceiveChain)) {
    return true;
  }

  const context = conversationContextForPeer(peer) || {};
  let drInit = context?.dr_init || secretInfo?.conversationDrInit || null;
  let guestBundle = drInit?.guest_bundle || drInit?.guestBundle || null;

  if (!guestBundle && relationshipRole !== 'guest') {
    try {
      const remote = await ensureRemoteBootstrap({ peerAccountDigest: peer, reason: 'ensureDrReceiverState', force });
      if (remote?.guestBundle) {
        const refreshedSecret = getContactSecret(peer);
        const refreshedContext = conversationContextForPeer(peer) || {};
        drInit = refreshedContext?.dr_init || refreshedSecret?.conversationDrInit || drInit;
        guestBundle =
          drInit?.guest_bundle ||
          drInit?.guestBundle ||
          remote.guestBundle ||
          null;
      }
    } catch (err) {
      console.warn('[dr] ensure remote bootstrap failed', err?.message || err);
    }
  }

  const allowResponderBootstrap = (() => {
    if (relationshipRole === 'guest') return false;
    if (relationshipRole === 'owner') return true;
    const currentRole = state?.baseKey?.role;
    if (currentRole === 'initiator') return false;
    if (currentRole === 'responder') return true;
    return true;
  })();
  if (guestBundle && allowResponderBootstrap) {
    const holderNow = drState(peer);
    const roleNow = holderNow?.baseKey?.role;
    const hasReceiveChain = holderNow?.ckR instanceof Uint8Array && holderNow.ckR.length > 0 && roleNow === 'responder';
    const shouldForce = force || !hasReceiveChain || roleNow !== 'responder';
    const ok = await bootstrapDrFromGuestBundle({ peerAccountDigest: peer, guestBundle, force: shouldForce });
    if (ok || shouldForce) {
      const refreshed = drState(peer);
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
    }
  }

  const holder = drState(peer);
  const holderRole = typeof holder?.baseKey?.role === 'string' ? holder.baseKey.role.toLowerCase() : null;
  const holderHasRatchet = !!(holder?.rk && holder?.myRatchetPriv && holder?.myRatchetPub);
  const holderHasReceiveChain = holder?.ckR instanceof Uint8Array && holder.ckR.length > 0;
  if (holderHasRatchet && holderHasReceiveChain) {
    return true;
  }
  if (holderHasRatchet && (relationshipRole === 'guest' || holderRole === 'initiator')) {
    return true;
  }

  throw new Error('缺少安全會話狀態，請重新同步好友或重新建立邀請');
}

export async function recoverDrState(params = {}) {
  const { force = false } = params;
  const peer = resolvePeerDigest(params);
  if (!peer) return false;
  const secretInfo = getContactSecret(peer);
  const relationshipRole = typeof secretInfo?.role === 'string' ? secretInfo.role.toLowerCase() : null;
  const normalizeRole = (role) => (typeof role === 'string' ? role.toLowerCase() : null);
  const hasUsableState = (holder, roleHint = null) => {
    if (
      !holder?.rk ||
      !(holder.myRatchetPriv instanceof Uint8Array) ||
      !(holder.myRatchetPub instanceof Uint8Array)
    ) {
      return false;
    }
    const hasReceive = holder?.ckR instanceof Uint8Array && holder.ckR.length > 0;
    const hasSend = holder?.ckS instanceof Uint8Array && holder.ckS.length > 0;
    if (!hasReceive && !hasSend) return false;
    const role = normalizeRole(holder?.baseKey?.role) || normalizeRole(roleHint);
    if (role === 'initiator') return hasSend || hasReceive;
    if (role === 'responder') return hasReceive || hasSend;
    return hasReceive || hasSend;
  };
  if (secretInfo?.drState) {
    try {
      const ok = restoreDrStateFromSnapshot({ peerAccountDigest: peer, snapshot: secretInfo.drState, force: true });
      const holder = drState(peer);
      if (ok && hasUsableState(holder, relationshipRole)) {
        markHolderSnapshot(holder, 'recover-snapshot', Date.now());
        if (isAutomationEnv()) console.log('[dr-recover]', JSON.stringify({ peerAccountDigest: peer, source: 'snapshot' }));
        return true;
      }
    } catch (err) {
      console.warn('[dr] recover snapshot failed', err);
    }
  }

  const context = conversationContextForPeer(peer) || {};
  const drInit = context?.dr_init || secretInfo?.conversationDrInit || null;
  const guestBundle = drInit?.guest_bundle || drInit?.guestBundle || null;
  let resolvedGuestBundle = guestBundle;

  if (!resolvedGuestBundle && relationshipRole !== 'guest') {
    try {
      const remote = await ensureRemoteBootstrap({ peerAccountDigest: peer, reason: 'recoverDrState', force });
      if (remote?.guestBundle) {
        resolvedGuestBundle = remote.guestBundle;
        setContactSecret(peer, {
          conversation: { drInit: { ...(drInit || {}), guest_bundle: resolvedGuestBundle, guestBundle: resolvedGuestBundle } },
          meta: { source: 'recoverDrState-remote-bootstrap' }
        });
      }
    } catch (err) {
      console.warn('[dr] recover remote bootstrap failed', err?.message || err);
    }
  }

  if (resolvedGuestBundle && relationshipRole !== 'guest') {
    try {
      const ok = await bootstrapDrFromGuestBundle({ peerAccountDigest: peer, guestBundle: resolvedGuestBundle, force: true });
      const holder = drState(peer);
      if (ok && hasUsableState(holder, relationshipRole)) {
        markHolderSnapshot(holder, 'recover-guest', Date.now());
        if (isAutomationEnv()) console.log('[dr-recover]', JSON.stringify({ peerAccountDigest: peer, source: 'guest-bundle' }));
        return true;
      }
    } catch (err) {
      console.warn('[dr] recover via guest bundle failed', err);
    }
  }

  const holder = drState(peer);
  if (hasUsableState(holder, relationshipRole)) {
    markHolderSnapshot(holder, 'recover', Date.now());
    if (isAutomationEnv()) console.log('[dr-recover]', JSON.stringify({ peerAccountDigest: peer, source: 'in-place' }));
    return true;
  }
  return false;
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
  if (!peer) return { restored: false, duplicate: false };
  const secretInfo = getContactSecret(peer);
  const holder = stateOverride || drState(peer);
  const stamp = Number(messageTs);
  const stampIsFinite = Number.isFinite(stamp);
  const cursorTs = Number.isFinite(holder?.historyCursorTs) ? holder.historyCursorTs : null;
  const cursorId = holder?.historyCursorId || null;
  const historyList = Array.isArray(secretInfo?.drHistory) ? secretInfo.drHistory : [];
  const historyEntry = messageId ? historyList.find((entry) => entry?.messageId === messageId) : null;
  const hasMatchingHistory = !!historyEntry;
  const allowReplay = !!allowCursorReplay;

  if (!allowReplay && cursorId && messageId && cursorId === messageId) {
    if (isAutomationEnv()) {
      console.log('[dr-skip-duplicate]', JSON.stringify({ peerAccountDigest: peer, messageId, cursorTs }));
    }
    return { restored: false, duplicate: true };
  }
  if (allowReplay && hasMatchingHistory && historyEntry?.messageKey_b64) {
    return { restored: false, duplicate: false, replay: true, historyEntry };
  }
  let restored = false;
  const tryHistoryRestore = (reason) => {
    const ok = restoreDrStateFromHistory({
      peerAccountDigest: peer,
      ts: stamp,
      messageId,
      targetState: mutate ? null : holder,
      reasonTag: reason
    });
    if (ok && isAutomationEnv()) {
      console.log('[dr-history-restore]', JSON.stringify({
        peerAccountDigest: peer,
        reason,
        cursorTs,
        cursorId,
        messageId: messageId || null,
        ts: stamp
      }));
    }
    return ok;
  };
  if (!holder?.rk) {
    restored = tryHistoryRestore('missing-rk');
  } else {
    const isOlderThanCursor = stampIsFinite && cursorTs !== null && stamp < cursorTs;
    const restoreByHistoryOnly = !stampIsFinite && hasMatchingHistory;
    const replayNeedsRestore = allowReplay && hasMatchingHistory && !historyEntry?.messageKey_b64;
    if (isOlderThanCursor || restoreByHistoryOnly || replayNeedsRestore) {
      const reason = (() => {
        if (isOlderThanCursor) return 'rewind';
        if (restoreByHistoryOnly) return 'history-lookup';
        if (replayNeedsRestore) return 'replay-no-key';
        return 'history';
      })();
      restored = tryHistoryRestore(reason);
    } else if (hasMatchingHistory && !allowReplay) {
      if (isAutomationEnv()) {
        console.log('[dr-skip-duplicate]', JSON.stringify({ peerAccountDigest: peer, messageId, cursorTs }));
      }
      return { restored: false, duplicate: true };
    }
  }
  if (restored) {
    if (Number.isFinite(stamp)) holder.historyCursorTs = stamp;
    if (messageId) holder.historyCursorId = messageId;
  }
  return { restored, duplicate: false, historyEntry: hasMatchingHistory ? historyEntry : null };
}

export function recordDrMessageHistory(params = {}) {
  const { messageTs, messageId, snapshot, snapshotNext, messageKeyB64 } = params;
  const peer = resolvePeerDigest(params);
  const stamp = Number(messageTs);
  if (!peer || !snapshot || !Number.isFinite(stamp)) return false;
  appendDrHistoryEntry({
    peerAccountDigest: peer,
    ts: stamp,
    snapshot,
    snapshotNext,
    messageId,
    messageKeyB64
  });
  updateHistoryCursor({ peerAccountDigest: peer, ts: stamp, messageId });
  if (isAutomationEnv()) {
    console.log('[dr-history-record]', JSON.stringify({ peerAccountDigest: peer, ts: stamp, messageId: messageId || null }));
  }
  const holder = drState(peer);
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
      const dr = job?.dr || {};
      const messageTs = Number(job?.createdAt);
      if (peer && dr.snapshotBefore && Number.isFinite(messageTs)) {
        recordDrMessageHistory({
          peerAccountDigest: peer,
          messageTs,
          messageId: job?.messageId || null,
          snapshot: dr.snapshotBefore,
          snapshotNext: dr.snapshotAfter || null,
          messageKeyB64: dr.messageKeyB64 || null
        });
      }
      if (peer && dr.snapshotAfter) {
        persistDrSnapshot({ peerAccountDigest: peer, snapshot: dr.snapshotAfter });
      }
    }
  });
  startOutboxProcessor();
} catch (err) {
  console.warn('[outbox] init failed', err);
}
