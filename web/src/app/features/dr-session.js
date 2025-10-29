// /app/features/dr-session.js
// X3DH 初始化與 DR 文字訊息發送（功能層，無 UI）。

import { prekeysBundle } from '../api/prekeys.js';
import { createSecureMessage } from '../api/messages.js';
import { x3dhInitiate, drEncryptText, x3dhRespond } from '../crypto/dr.js';
import { b64, b64u8 } from '../crypto/nacl.js';
import {
  getUidHex,
  drState
} from '../core/store.js';
import { getContactSecret, setContactSecret, restoreContactSecrets } from '../core/contact-secrets.js';
import { sessionStore } from '../ui/mobile/session-store.js';
import {
  computeConversationFingerprint,
  encryptConversationEnvelope,
  conversationIdFromToken,
  base64ToUrl
} from './conversation.js';
import { bytesToB64Url } from '../ui/mobile/ui-utils.js';
import { ensureDevicePrivAvailable } from './device-priv.js';
import { encryptAndPutWithProgress } from './media.js';

function normHex(s) { return String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase(); }

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

function appendDrHistoryEntry({ peerUidHex, ts, snapshot, snapshotNext, messageId, messageKeyB64 }) {
  const peer = normHex(peerUidHex);
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
    inviteId: info.inviteId,
    secret: info.secret,
    drHistory: history
  });
  if (isAutomationEnv()) {
    console.log('[dr-history-append]', JSON.stringify({
      peerUidHex: peer,
      ts: stamp,
      messageId: messageId || null,
      hasSnapshotAfter: !!entry.snapshotAfter,
      hasMessageKey: !!(messageKeyB64 || preservedKey),
      length: history.length
    }));
  }
  return true;
}

function restoreDrStateFromHistory({ peerUidHex, ts, messageId }) {
  const peer = normHex(peerUidHex);
  if (!peer) return false;
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
  const restored = restoreDrStateFromSnapshot({ peerUidHex: peer, snapshot: entry.snapshot, force: true });
  if (restored && isAutomationEnv()) {
    console.log('[dr-history-apply]', JSON.stringify({
      peerUidHex: peer,
      appliedTs: entry.ts,
      appliedMessageId: entry.messageId || null,
      requestedTs: stamp,
      requestedMessageId: messageId || null
    }));
  }
  return restored;
}

export function restoreDrStateToHistoryPoint({ peerUidHex, ts, messageId }) {
  return restoreDrStateFromHistory({ peerUidHex, ts, messageId });
}

function updateHistoryCursor({ peerUidHex, ts, messageId }) {
  const peer = normHex(peerUidHex);
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
    inviteId: info.inviteId,
    secret: info.secret,
    drHistoryCursorTs: Number.isFinite(stamp) ? stamp : null,
    drHistoryCursorId: messageId || null
  });
  if (isAutomationEnv()) {
    console.log('[dr-history-cursor]', JSON.stringify({
      peerUidHex: peer,
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

export function snapshotDrStateForPeer(peerUidHex) {
  const peer = normHex(peerUidHex);
  if (!peer) return null;
  const holder = drState(peer);
  if (!holder?.rk) return null;
  return snapshotDrState(holder);
}

export function restoreDrStateFromSnapshot({ peerUidHex, snapshot, force = false } = {}) {
  const peer = normHex(peerUidHex);
  if (!peer) return false;
  const data = sanitizeSnapshotInput(snapshot);
  if (!data) return false;
  const holder = drState(peer);
  if (!force && holder?.rk && holder.snapshotTs && data.updatedAt && holder.snapshotTs >= data.updatedAt) {
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
  markHolderSnapshot(holder, 'snapshot', data.updatedAt || Date.now());
  holder.baseKey = holder.baseKey || {};
  holder.baseKey.snapshot = true;
  if (data.role) holder.baseKey.role = data.role;
  return true;
}

export function persistDrSnapshot({ peerUidHex, state, snapshot } = {}) {
  const peer = normHex(peerUidHex);
  if (!peer) return false;
  const holder = state || drState(peer);
  if (!holder?.rk) return false;
  const snap = snapshot || snapshotDrState(holder);
  if (!snap) return false;
  const info = getContactSecret(peer);
  if (!info?.inviteId || !info?.secret) {
    if (isAutomationEnv()) {
      console.warn('[dr] persist snapshot skipped (missing contact secret)', { peerUidHex: peer, hasInfo: !!info });
    }
    return false;
  }
  try {
    setContactSecret(peer, {
      inviteId: info.inviteId,
      secret: info.secret,
      role: info.role || null,
      conversationToken: info.conversationToken || null,
      conversationId: info.conversationId || null,
      conversationDrInit: info.conversationDrInit || null,
      drState: snap,
      __debugSource: 'persistDrSnapshot'
    });
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
  for (const [peerUid, info] of map.entries()) {
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
          peerUid,
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
    const applied = restoreDrStateFromSnapshot({ peerUidHex: peerUid, snapshot });
    if (applied) {
      const holder = drState(peerUid);
      if (holder) {
        holder.historyCursorTs = Number.isFinite(info?.drHistoryCursorTs) ? info.drHistoryCursorTs : null;
        holder.historyCursorId = info?.drHistoryCursorId || null;
      }
      restoredCount += 1;
      if (snapshotFromHistory) {
        historyFallbackCount += 1;
        setContactSecret(peerUid, {
          inviteId: info.inviteId,
          secret: info.secret,
          drState: snapshot,
          __debugSource: 'hydrateDrStateFallback'
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

function copyDrState(target, source) {
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

async function ensureDevicePrivLoaded() {
  return ensureDevicePrivAvailable();
}

/**
 * 確保（本端→對方）的 DR 會話已初始化。
 * 會：
 *  - 若記憶體中尚無 devicePriv，等待登入 handoff（sessionStorage）或拋錯提醒重新登入
 *  - 呼叫 /keys/bundle 取得對方 bundle，執行 x3dhInitiate()，把狀態寫回 store.drState(peer)
 * @param {{ peerUidHex: string }} p
 * @returns {Promise<{ initialized: boolean }>} 
 */
export async function ensureDrSession({ peerUidHex }) {
  const me = getUidHex();
  const peer = normHex(peerUidHex);
  if (!me) throw new Error('UID not set (run SDM exchange)');
  if (!peer) throw new Error('peerUidHex required');

  const holder = drState(peer);
  if (holder?.rk && holder?.myRatchetPriv && holder?.myRatchetPub) {
    return { initialized: true, reused: true };
  }

  const priv = await ensureDevicePrivLoaded();

  const { r: rb, data: bundle } = await prekeysBundle({ peer_uidHex: peer });
  if (!rb.ok) throw new Error('prekeys.bundle failed: ' + (typeof bundle === 'string' ? bundle : JSON.stringify(bundle)));

  const st = await x3dhInitiate(priv, bundle);
  copyDrState(holder, st);
  holder.baseKey = { role: 'initiator', initializedAt: Date.now() };
  markHolderSnapshot(holder, 'initiator', Date.now());
  persistDrSnapshot({ peerUidHex: peer, state: holder });
  return { initialized: true };
}

function conversationContextForPeer(peerUid) {
  try {
    const key = String(peerUid || '').toUpperCase();
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
        if (info?.peerUid === key && info?.token_b64) {
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

/**
 * 發送 DR 文字訊息（必要時會先初始化會話）。
 * @param {{ peerUidHex: string, text: string, conversation?: { token_b64?:string, conversation_id?:string }, convId?: string }} p
 * @returns {Promise<{ msg: any, convId: string }>} 
 */
export async function sendDrText({ peerUidHex, text, conversation, convId }) {
  const me = getUidHex();
  const peer = normHex(peerUidHex);
  if (!me) throw new Error('UID not set');
  if (!peer) throw new Error('peerUidHex required');

  const convContext = conversation || conversationContextForPeer(peer);
  const tokenB64 = convContext?.token_b64 || convContext?.tokenB64 || null;
  if (!tokenB64) throw new Error('conversation token missing for peer, please refresh contacts');

  let state = drState(peer);
  let hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  const hasDrInit = !!(convContext?.dr_init?.guest_bundle || convContext?.dr_init?.guestBundle);

  if (!hasDrState) {
    try {
      await ensureDrSession({ peerUidHex: peer });
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

  const preSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  logDrSend('encrypt-before', { peerUidHex: peer, snapshot: preSnapshot || null });
  const pkt = await drEncryptText(state, text);
  const messageKeyB64 = pkt?.message_key_b64 || null;
  const postSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  const now = Math.floor(Date.now() / 1000);

  let conversationId = convContext?.conversation_id || convContext?.conversationId || null;
  if (!conversationId) conversationId = await conversationIdFromToken(tokenB64);

  const headerPayload = { ...pkt.header, iv_b64: pkt.iv_b64 };
  const headerJson = JSON.stringify(headerPayload);
  const hdrB64 = bytesToB64Url(new TextEncoder().encode(headerJson));
  const ctB64 = base64ToUrl(pkt.ciphertext_b64);
  const fingerprint = await computeConversationFingerprint(tokenB64, me);

  const securePayload = {
    v: 1,
    hdr_b64: hdrB64,
    ct_b64: ctB64,
    meta: {
      ts: now,
      sender_fingerprint: fingerprint,
      msg_type: 'text'
    }
  };

  const envelope = await encryptConversationEnvelope(tokenB64, securePayload);
  const { r, data } = await createSecureMessage({
    conversationId,
    payloadEnvelope: envelope,
    createdAt: now
  });
  if (!r.ok) throw new Error('sendText failed: ' + (typeof data === 'string' ? data : JSON.stringify(data)));
  if (preSnapshot) {
    recordDrMessageHistory({
      peerUidHex: peer,
      messageTs: now,
      messageId: data?.id || null,
      snapshot: preSnapshot,
      snapshotNext: postSnapshot,
      messageKeyB64
    });
  }
  persistDrSnapshot({ peerUidHex: peer, state });
  logDrSend('encrypt-after', { peerUidHex: peer, snapshot: postSnapshot });
  return { msg: data, convId: conversationId, secure: true };
}

export async function sendDrMedia({ peerUidHex, file, conversation, convId, dir, onProgress } = {}) {
  const me = getUidHex();
  const peer = normHex(peerUidHex);
  if (!me) throw new Error('UID not set');
  if (!peer) throw new Error('peerUidHex required');
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
      await ensureDrSession({ peerUidHex: peer });
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

  const uploadResult = await encryptAndPutWithProgress({
    convId: conversationId,
    file,
    dir,
    onProgress,
    skipIndex: true
  });

  const metadata = {
    type: 'media',
    objectKey: uploadResult.objectKey,
    name: typeof file.name === 'string' && file.name ? file.name : '附件',
    size: typeof file.size === 'number' ? file.size : uploadResult.size ?? null,
    contentType: file.type || 'application/octet-stream',
    envelope: uploadResult.envelope || null,
    dir: Array.isArray(dir) && dir.length ? dir.map((seg) => String(seg || '').trim()).filter(Boolean) : null
  };

  const payloadText = JSON.stringify({
    type: metadata.type,
    objectKey: metadata.objectKey,
    name: metadata.name,
    size: metadata.size,
    contentType: metadata.contentType,
    envelope: metadata.envelope,
    dir: metadata.dir
  });

  const preSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  logDrSend('encrypt-media-before', { peerUidHex: peer, snapshot: preSnapshot || null, objectKey: metadata.objectKey });
  const pkt = await drEncryptText(state, payloadText);
  const messageKeyB64 = pkt?.message_key_b64 || null;
  const postSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  const now = Math.floor(Date.now() / 1000);

  const headerPayload = { ...pkt.header, iv_b64: pkt.iv_b64 };
  const headerJson = JSON.stringify(headerPayload);
  const hdrB64 = bytesToB64Url(new TextEncoder().encode(headerJson));
  const ctB64 = base64ToUrl(pkt.ciphertext_b64);
  const fingerprint = await computeConversationFingerprint(tokenB64, me);

  const securePayload = {
    v: 1,
    hdr_b64: hdrB64,
    ct_b64: ctB64,
    meta: {
      ts: now,
      sender_fingerprint: fingerprint,
      msg_type: 'media',
      media: {
        object_key: metadata.objectKey,
        size: metadata.size,
        name: metadata.name,
        content_type: metadata.contentType
      }
    }
  };

  const envelope = await encryptConversationEnvelope(tokenB64, securePayload);
  const { r, data } = await createSecureMessage({
    conversationId,
    payloadEnvelope: envelope,
    createdAt: now
  });
  if (!r.ok) throw new Error('sendMedia failed: ' + (typeof data === 'string' ? data : JSON.stringify(data)));
  if (preSnapshot) {
    recordDrMessageHistory({
      peerUidHex: peer,
      messageTs: now,
      messageId: data?.id || null,
      snapshot: preSnapshot,
      snapshotNext: postSnapshot,
      messageKeyB64
    });
  }
  persistDrSnapshot({ peerUidHex: peer, state });
  logDrSend('encrypt-media-after', { peerUidHex: peer, snapshot: postSnapshot || null, objectKey: metadata.objectKey });

  return {
    msg: {
      id: data?.id || null,
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
        createdAt: now
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

export async function bootstrapDrFromGuestBundle({ peerUidHex, guestBundle, force = false }) {
  const peer = normHex(peerUidHex);
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
    persistDrSnapshot({ peerUidHex: peer, state: holder });
    return true;
  } catch (err) {
    console.warn('[dr] responder bootstrap failed', err);
    return false;
  }
}

export function primeDrStateFromInitiator({ peerUidHex, state }) {
  const peer = normHex(peerUidHex);
  if (!peer || !state) return false;
  const holder = drState(peer);
  if (holder?.rk) return false;
  copyDrState(holder, state);
  holder.baseKey = { role: 'initiator', initializedAt: Date.now(), primed: true };
  markHolderSnapshot(holder, 'prime', Date.now());
  return true;
}

export async function ensureDrReceiverState({ peerUidHex }) {
  const peer = normHex(peerUidHex);
  if (!peer) return false;
  const secretInfo = getContactSecret(peer);
  const relationshipRole = typeof secretInfo?.role === 'string' ? secretInfo.role.toLowerCase() : null;
  let state = drState(peer);
  if (!state?.rk && secretInfo?.drState) {
    try {
      restoreDrStateFromSnapshot({ peerUidHex: peer, snapshot: secretInfo.drState });
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
        const ok = restoreDrStateFromSnapshot({ peerUidHex: peer, snapshot: snap, force: true });
        if (ok) {
          const holder = drState(peer);
          if (holder) {
            if (Number.isFinite(entry.ts)) holder.historyCursorTs = entry.ts;
            if (entry.messageId) holder.historyCursorId = entry.messageId;
            markHolderSnapshot(holder, 'ensure-history', Date.now());
            persistDrSnapshot({ peerUidHex: peer, state: holder });
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
  if (state?.rk && (state.ckR instanceof Uint8Array || state.ckS instanceof Uint8Array) && state.myRatchetPriv && state.myRatchetPub) {
    return true;
  }

  const context = conversationContextForPeer(peer) || {};
  const drInit = context?.dr_init || secretInfo?.conversationDrInit || null;
  const guestBundle = drInit?.guest_bundle || drInit?.guestBundle || null;
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
    const shouldForce = !hasReceiveChain || roleNow !== 'responder';
    const ok = await bootstrapDrFromGuestBundle({ peerUidHex: peer, guestBundle, force: shouldForce });
    if (ok || shouldForce) {
      const refreshed = drState(peer);
      if (
        refreshed?.rk &&
        refreshed?.ckR instanceof Uint8Array &&
        refreshed.ckR.length > 0 &&
        refreshed.myRatchetPriv instanceof Uint8Array &&
        refreshed?.baseKey?.role === 'responder'
      ) {
        return true;
      }
    }
  }

  const holder = drState(peer);
  if (holder?.rk && holder?.myRatchetPriv && holder?.myRatchetPub) {
    return true;
  }

  throw new Error('缺少安全會話狀態，請重新同步好友或重新建立邀請');
}

export async function recoverDrState({ peerUidHex } = {}) {
  const peer = normHex(peerUidHex);
  if (!peer) return false;
  const hasReceiveChain = () => {
    const holder = drState(peer);
    return !!(
      holder?.rk &&
      holder?.ckR instanceof Uint8Array &&
      holder.ckR.length > 0 &&
      holder.myRatchetPriv instanceof Uint8Array &&
      holder?.baseKey?.role === 'responder'
    );
  };

  const secretInfo = getContactSecret(peer);
  const relationshipRole = typeof secretInfo?.role === 'string' ? secretInfo.role.toLowerCase() : null;
  if (secretInfo?.drState) {
    try {
      const ok = restoreDrStateFromSnapshot({ peerUidHex: peer, snapshot: secretInfo.drState, force: true });
      if (ok && hasReceiveChain()) {
        markHolderSnapshot(drState(peer), 'recover-snapshot', Date.now());
        if (isAutomationEnv()) console.log('[dr-recover]', JSON.stringify({ peerUidHex: peer, source: 'snapshot' }));
        return true;
      }
    } catch (err) {
      console.warn('[dr] recover snapshot failed', err);
    }
  }

  const context = conversationContextForPeer(peer) || {};
  const drInit = context?.dr_init || secretInfo?.conversationDrInit || null;
  const guestBundle = drInit?.guest_bundle || drInit?.guestBundle || null;
  if (guestBundle && relationshipRole !== 'guest') {
    try {
      const ok = await bootstrapDrFromGuestBundle({ peerUidHex: peer, guestBundle, force: true });
      if (ok && hasReceiveChain()) {
        markHolderSnapshot(drState(peer), 'recover-guest', Date.now());
        if (isAutomationEnv()) console.log('[dr-recover]', JSON.stringify({ peerUidHex: peer, source: 'guest-bundle' }));
        return true;
      }
    } catch (err) {
      console.warn('[dr] recover via guest bundle failed', err);
    }
  }

  if (hasReceiveChain()) {
    const holder = drState(peer);
    markHolderSnapshot(holder, 'recover', Date.now());
    if (isAutomationEnv()) console.log('[dr-recover]', JSON.stringify({ peerUidHex: peer, source: 'in-place' }));
    return true;
  }
  return false;
}

export function prepareDrForMessage({ peerUidHex, messageTs, messageId, allowCursorReplay = false }) {
  const peer = normHex(peerUidHex);
  if (!peer) return { restored: false, duplicate: false };
  const secretInfo = getContactSecret(peer);
  const holder = drState(peer);
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
      console.log('[dr-skip-duplicate]', JSON.stringify({ peerUidHex: peer, messageId, cursorTs }));
    }
    return { restored: false, duplicate: true };
  }
  if (allowReplay && hasMatchingHistory && historyEntry?.messageKey_b64) {
    return { restored: false, duplicate: false, replay: true, historyEntry };
  }
  let restored = false;
  const tryHistoryRestore = (reason) => {
    const ok = restoreDrStateFromHistory({ peerUidHex: peer, ts: stamp, messageId });
    if (ok && isAutomationEnv()) {
      console.log('[dr-history-restore]', JSON.stringify({
        peerUidHex: peer,
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
        console.log('[dr-skip-duplicate]', JSON.stringify({ peerUidHex: peer, messageId, cursorTs }));
      }
      return { restored: false, duplicate: true };
    }
  }
  if (restored) {
    const refreshed = drState(peer);
    if (refreshed) {
      if (Number.isFinite(stamp)) refreshed.historyCursorTs = stamp;
      if (messageId) refreshed.historyCursorId = messageId;
    }
  }
  return { restored, duplicate: false, historyEntry: hasMatchingHistory ? historyEntry : null };
}

export function recordDrMessageHistory({ peerUidHex, messageTs, messageId, snapshot, snapshotNext, messageKeyB64 }) {
  const peer = normHex(peerUidHex);
  const stamp = Number(messageTs);
  if (!peer || !snapshot || !Number.isFinite(stamp)) return false;
  appendDrHistoryEntry({
    peerUidHex: peer,
    ts: stamp,
    snapshot,
    snapshotNext,
    messageId,
    messageKeyB64
  });
  updateHistoryCursor({ peerUidHex: peer, ts: stamp, messageId });
  if (isAutomationEnv()) {
    console.log('[dr-history-record]', JSON.stringify({ peerUidHex: peer, ts: stamp, messageId: messageId || null }));
  }
  const holder = drState(peer);
  if (holder) {
    holder.historyCursorTs = stamp;
    if (messageId) holder.historyCursorId = messageId;
  }
  return true;
}
