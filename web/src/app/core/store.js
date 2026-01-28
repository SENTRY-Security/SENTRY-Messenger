

// core/store.js
// Centralized in-memory state for the front-end (zero persistence).
// This module intentionally keeps everything in RAM only, to preserve
// the 0-knowledge / non-persistent login model. If you later decide to
// persist anything, do so with encrypted blobs in a different module.
//
// Exposed state:
// - SESSION: one-time token from /auth/sdm/exchange (60s, single-use)
// - HAS_MK: boolean (server has wrapped_mk)
// - WRAPPED_MK: object | null (from exchange)
// - ACCOUNT_TOKEN: opaque token from /auth/sdm/exchange
// - ACCOUNT_DIGEST: hex digest identifying the account (HMAC(uid))
// - MK_RAW: Uint8Array | null (decrypted MK, memory-only)
// - DEVICE_PRIV: { ik_priv_b64, ik_pub_b64, spk_priv_b64, spk_pub_b64, spk_sig_b64, next_opk_id } | null
// - DR_SESS: Map(peer_accountDigest::peerDeviceId -> DR state object)
// - OPAQUE_SERVER_ID: server identity string for OPAQUE handshake (optional)

import { logCapped } from './log.js';

// --- primitives ---
let _SESSION = null;
let _HAS_MK = false;
let _WRAPPED_MK = null;
let _ACCOUNT_TOKEN = null;
let _ACCOUNT_DIGEST = null;
let _DEVICE_ID = null;
let _MK_RAW = null;        // Uint8Array
let _DEVICE_PRIV = null;   // object
let _beforeClearDrStateHook = null;
const _DEVICE_PRIV_WAITERS = new Set();
const _DR_SESS = new Map(); // peerKey (accountDigest::deviceId) -> { rk, ckS, ckR, Ns, Nr, PN, myRatchetPriv, myRatchetPub, theirRatchetPub }
const _DR_PEER_ALIASES = null; // legacy unused
let _OPAQUE_SERVER_ID = null;
const DEVICE_ID_STORAGE_KEY = 'device_id';
const DEVICE_COUNTER_PREFIX = 'device_counter::';

function ensureDrHolderDebugId(holder) {
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

function captureDrStackTop(limit = 3) {
  try {
    const err = new Error('dr-state-clear');
    const lines = String(err.stack || '').split('\n').slice(2);
    const frames = [];
    for (const raw of lines) {
      const clean = raw.trim().replace(/^at\s+/, '');
      if (!clean) continue;
      if (
        clean.includes('captureDrStackTop') ||
        clean.includes('logDrStateClear') ||
        clean.includes('logDrStateCreate') ||
        clean.includes('logAllDrStates')
      ) {
        continue;
      }
      frames.push(clean);
      if (frames.length >= limit) break;
    }
    return frames.length ? frames : null;
  } catch {
    return null;
  }
}

export function logDrStateClear(tag, stateKey, holder) {
  const entry = {
    tag,
    stateKey: stateKey || null,
    holderId: ensureDrHolderDebugId(holder),
    hasRk: holder?.rk instanceof Uint8Array,
    hasCkR: holder?.ckR instanceof Uint8Array,
    hasCkS: holder?.ckS instanceof Uint8Array,
    stackTop3: captureDrStackTop()
  };
  try {
    console.warn('[dr-debug:state-clear]', entry);
  } catch { }
  logCapped('contactShareStateChangeTrace', {
    reasonCode: 'CLEAR_DR_STATE',
    fromKey: stateKey || null,
    toKey: null,
    hasRkBefore: holder?.rk instanceof Uint8Array,
    hasRkAfter: false,
    sourceTag: tag || null
  }, 5);
}

function logDrStateCreate(stateKey, holder) {
  const entry = {
    tag: 'dr-state:create',
    stateKey: stateKey || null,
    holderId: ensureDrHolderDebugId(holder),
    hasRk: holder?.rk instanceof Uint8Array,
    hasCkR: holder?.ckR instanceof Uint8Array,
    hasCkS: holder?.ckS instanceof Uint8Array,
    stackTop3: captureDrStackTop()
  };
  try {
    console.warn('[dr-debug:state-create]', entry);
  } catch { }
}

function logAllDrStates(tag, predicate = null) {
  for (const [stateKey, holder] of _DR_SESS.entries()) {
    if (typeof predicate === 'function' && !predicate(stateKey, holder)) continue;
    logDrStateClear(tag, stateKey, holder);
  }
}
function resetDeviceCounter(id) {
  if (!id) return;
  const key = `${DEVICE_COUNTER_PREFIX}${id}`;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, '0');
    }
  } catch {
    // ignore storage errors; counter will start from 1 on next usage
  }
}

// Restore deviceId from sessionStorage on load to survive reload
(function restoreDeviceIdFromStorage() {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const stored = sessionStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (stored && typeof stored === 'string' && stored.trim()) {
      _DEVICE_ID = stored.trim();
    }
  } catch {
    /* ignore */
  }
})();

function recoverDeviceIdFromCaches() {
  if (_DEVICE_ID) return;
  const candidates = new Set();
  try {
    if (typeof sessionStorage !== 'undefined') {
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(DEVICE_COUNTER_PREFIX)) {
          const id = k.slice(DEVICE_COUNTER_PREFIX.length).trim();
          if (id) candidates.add(id);
        }
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.includes('contactSecrets-v2')) continue;
        try {
          const parsed = JSON.parse(localStorage.getItem(key) || '{}');
          const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
          for (const entry of entries) {
            if (entry?.devices && typeof entry.devices === 'object') {
              for (const devId of Object.keys(entry.devices)) {
                if (devId && typeof devId === 'string') candidates.add(devId.trim());
              }
            }
          }
        } catch {
          /* ignore parse errors */
        }
      }
    }
  } catch {
    /* ignore */
  }
  if (candidates.size === 1) {
    const [id] = candidates;
    setDeviceId(id);
  }
}

function settleDevicePrivWaiter(entry, value) {
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  _DEVICE_PRIV_WAITERS.delete(entry);
  try {
    entry.resolve(value);
  } catch {
    // ignore downstream errors from listeners
  }
}

// --- getters / setters ---
export function getSession() { return _SESSION; }
export function setSession(v) { _SESSION = v || null; }

export function getHasMK() { return !!_HAS_MK; }
export function setHasMK(v) { _HAS_MK = !!v; }

export function getWrappedMK() { return _WRAPPED_MK; }
export function setWrappedMK(obj) { _WRAPPED_MK = obj || null; }


export function getAccountToken() { return _ACCOUNT_TOKEN; }
export function setAccountToken(v) { _ACCOUNT_TOKEN = v ? String(v) : null; }

export function getAccountDigest() { return _ACCOUNT_DIGEST; }
export function normalizeAccountDigest(value) {
  if (!value) return null;
  // Handle wrapped object if passed by mistake
  const raw = (typeof value === 'object') ? (value.peerAccountDigest ?? value.accountDigest ?? value.digest ?? String(value)) : value;
  const cleaned = String(raw).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned && cleaned.length === 64 ? cleaned : null;
}
export function normalizePeerUid(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned || null;
}
export function normalizePeerDeviceId(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}
// General deviceId normalizer（同 normalizePeerDeviceId，但供其他模組直接使用）
export function normalizeDeviceId(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}
export function normalizePeerIdentity(peer) {
  let digest = null;
  let deviceId = null;
  if (typeof peer === 'string' && peer.includes('::')) {
    const [dPart, devPart] = peer.split('::');
    digest = normalizeAccountDigest(dPart);
    deviceId = normalizeDeviceId(devPart);
  }
  if (!digest && peer && typeof peer === 'object' && typeof peer.peerAccountDigest === 'string' && peer.peerAccountDigest.includes('::')) {
    const [dPart, devPart] = peer.peerAccountDigest.split('::');
    digest = normalizeAccountDigest(dPart);
    deviceId = normalizeDeviceId(devPart);
  }
  if (!digest) {
    digest = normalizeAccountDigest(
      peer && typeof peer === 'object'
        ? (peer.peerAccountDigest ?? peer.accountDigest ?? peer)
        : peer
    );
  }
  if (!deviceId) {
    deviceId = normalizePeerDeviceId(
      peer && typeof peer === 'object'
        ? (peer.peerDeviceId ?? peer.deviceId ?? null)
        : null
    );
  }
  if (!digest || !deviceId) {
    return {
      key: null,
      accountDigest: digest || null,
      deviceId: deviceId || null
    };
  }
  const key = `${digest}::${deviceId}`;
  return {
    key,
    accountDigest: digest,
    deviceId
  };
}
function resolveDrKey(peerInput) {
  const identity = normalizePeerIdentity(peerInput);
  if (!identity.key) return { key: null, aliases: [] };
  return { key: identity.key, aliases: [] };
}
export function setAccountDigest(v) {
  const prev = _ACCOUNT_DIGEST;
  _ACCOUNT_DIGEST = normalizeAccountDigest(v);
  if (prev !== _ACCOUNT_DIGEST) {
    try {
      console.warn('[dr-debug:set-account-digest]', {
        tag: 'core/store.js:272:setAccountDigest',
        prev,
        next: _ACCOUNT_DIGEST,
        drStates: _DR_SESS.size,
        stackTop3: captureDrStackTop()
      });
    } catch { }
  }
}

export function getDeviceId() { return _DEVICE_ID; }
export function setDeviceId(v) {
  if (typeof v === 'string' && v.trim()) {
    const nextId = v.trim();
    const isNew = nextId !== _DEVICE_ID;
    _DEVICE_ID = nextId;
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(DEVICE_ID_STORAGE_KEY, _DEVICE_ID);
        if (isNew) {
          resetDeviceCounter(_DEVICE_ID);
        }
      }
    } catch {
      /* ignore */
    }
  } else {
    _DEVICE_ID = null;
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(DEVICE_ID_STORAGE_KEY);
        resetDeviceCounter(_DEVICE_ID);
      }
    } catch {
      /* ignore */
    }
  }
}
export function ensureDeviceId() {
  if (_DEVICE_ID) return _DEVICE_ID;
  recoverDeviceIdFromCaches();
  if (_DEVICE_ID) return _DEVICE_ID;
  if (_DEVICE_PRIV && (typeof _DEVICE_PRIV === 'object')) {
    const fromPriv = _DEVICE_PRIV.device_id || _DEVICE_PRIV.deviceId || null;
    if (fromPriv && typeof fromPriv === 'string' && fromPriv.trim()) {
      setDeviceId(fromPriv.trim());
      return _DEVICE_ID;
    }
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      const stored = sessionStorage.getItem(DEVICE_ID_STORAGE_KEY);
      if (stored && stored.trim()) {
        _DEVICE_ID = stored.trim();
        return _DEVICE_ID;
      }
    }
  } catch {
    /* ignore */
  }
  throw new Error('deviceId missing; please re-login');
}
function readDeviceCounter(deviceId) {
  const key = `${DEVICE_COUNTER_PREFIX}${deviceId}`;
  try {
    if (typeof sessionStorage === 'undefined') return 0;
    const raw = sessionStorage.getItem(key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}
function writeDeviceCounter(deviceId, value) {
  if (!Number.isFinite(value) || value < 0) return;
  const key = `${DEVICE_COUNTER_PREFIX}${deviceId}`;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, String(value));
    }
  } catch {
    // ignore storage write errors; caller will surface failure via API response
  }
}
export function setDeviceCounter(value) {
  const deviceId = ensureDeviceId();
  writeDeviceCounter(deviceId, Number(value));
}
/**
 * Allocate next counter for current device, but only persist on commit().
 * This prevents failed requests from burning counters and causing mismatch.
 */
export function allocateDeviceCounter() {
  const deviceId = ensureDeviceId();
  const last = readDeviceCounter(deviceId);
  const next = last + 1;
  const commit = () => {
    // Persist only if still ahead of last known; avoid regression.
    const current = readDeviceCounter(deviceId);
    if (next > current) {
      writeDeviceCounter(deviceId, next);
    }
  };
  return { deviceId, counter: next, commit };
}
// Restore deviceId from sessionStorage if present
try {
  if (!_DEVICE_ID && typeof sessionStorage !== 'undefined') {
    const stored = sessionStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (stored && stored.trim()) _DEVICE_ID = stored.trim();
  }
} catch {
  /* ignore */
}

export function getMkRaw() { return _MK_RAW; }
export function setMkRaw(u8) { _MK_RAW = u8 || null; }

export function getDevicePriv() { return _DEVICE_PRIV; }
export function setDevicePriv(obj) {
  _DEVICE_PRIV = obj || null;
  if (obj && typeof obj === 'object') {
    const maybeId = obj.device_id || obj.deviceId || null;
    if (maybeId && typeof maybeId === 'string' && maybeId.trim()) {
      setDeviceId(maybeId.trim());
    }
  }
  if (_DEVICE_PRIV_WAITERS.size) {
    const current = _DEVICE_PRIV;
    for (const entry of Array.from(_DEVICE_PRIV_WAITERS)) {
      settleDevicePrivWaiter(entry, current);
    }
  }
}

export function waitForDevicePriv({ timeoutMs = 5000 } = {}) {
  const current = _DEVICE_PRIV;
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => {
    const entry = { resolve, timer: null };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        settleDevicePrivWaiter(entry, null);
      }, timeoutMs);
    }
    _DEVICE_PRIV_WAITERS.add(entry);
  });
}

export function getDrSessMap() { return _DR_SESS; }
export function drState(peerInput) {
  const identity = normalizePeerIdentity(peerInput);
  const { key } = resolveDrKey(peerInput);
  if (!key) return null;
  let created = false;
  if (!_DR_SESS.has(key)) {
    _DR_SESS.set(key, {
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
      baseKey: null,
      pendingSendRatchet: false,
      historyCursorTs: null,
      historyCursorId: null,
      skippedKeys: new Map(),
      __bornReason: 'drState'
    });
    created = true;
  }
  const state = _DR_SESS.get(key);
  if (!Number.isFinite(state?.NsTotal)) state.NsTotal = 0;
  if (!Number.isFinite(state?.NrTotal)) state.NrTotal = 0;
  if (!state.__bornReason) state.__bornReason = created ? 'drState' : 'drState-existing';
  ensureDrHolderDebugId(state);
  if (state && !(state.skippedKeys instanceof Map)) {
    try {
      state.skippedKeys = new Map();
    } catch {
      state.skippedKeys = null;
    }
  }
  if (created) {
    try {
      console.log('[msg] state:init-transport-counter', JSON.stringify({
        conversationId: state?.baseKey?.conversationId || null,
        peerDigest: identity?.accountDigest || null,
        peerDeviceId: identity?.deviceId || null,
        NsTotal: state?.NsTotal ?? null,
        NrTotal: state?.NrTotal ?? null,
        reason: state?.__bornReason || 'state-birth'
      }));
    } catch { }
    logDrStateCreate(key, state);
  }
  return state;
}
export function clearDrState(peerInput, opts = {}) {
  const debugTag =
    (peerInput && typeof peerInput === 'object' && peerInput.__drDebugTag) ||
    opts.__drDebugTag ||
    'core/store.js:465:clearDrState';
  if (!peerInput) {
    if (typeof _beforeClearDrStateHook === 'function') {
      try {
        _beforeClearDrStateHook({ peerAccountDigest: null, peerDeviceId: null, reason: debugTag });
      } catch { }
    }
    logAllDrStates(debugTag);
    _DR_SESS.clear();
    return;
  }
  const identity = normalizePeerIdentity(peerInput);
  const { key } = resolveDrKey(peerInput);
  if (!key) return;
  if (typeof _beforeClearDrStateHook === 'function') {
    try {
      _beforeClearDrStateHook({
        peerAccountDigest: identity?.accountDigest || identity?.key || null,
        peerDeviceId: identity?.deviceId || null,
        reason: debugTag
      });
    } catch { }
  }
  const holder = _DR_SESS.get(key) || null;
  logDrStateClear(debugTag, key, holder);
  _DR_SESS.delete(key);
}

export function clearDrStatesByAccount(peerAccountDigest, opts = {}) {
  const debugTag =
    (peerAccountDigest && typeof peerAccountDigest === 'object' && peerAccountDigest.__drDebugTag) ||
    opts.__drDebugTag ||
    'core/store.js:482:clearDrStatesByAccount';
  const digest = normalizeAccountDigest(
    peerAccountDigest && typeof peerAccountDigest === 'object'
      ? (peerAccountDigest.peerAccountDigest ?? peerAccountDigest.accountDigest ?? peerAccountDigest.peer ?? peerAccountDigest)
      : peerAccountDigest
  );
  if (!digest) return;
  if (typeof _beforeClearDrStateHook === 'function') {
    try {
      _beforeClearDrStateHook({ peerAccountDigest: digest, peerDeviceId: null, reason: debugTag });
    } catch { }
  }
  const toDelete = [];
  for (const key of _DR_SESS.keys()) {
    if (typeof key === 'string' && key.startsWith(`${digest}::`)) {
      toDelete.push(key);
    }
  }
  for (const k of toDelete) {
    const holder = _DR_SESS.get(k) || null;
    logDrStateClear(debugTag, k, holder);
    _DR_SESS.delete(k);
  }
}

export function setBeforeClearDrStateHook(fn) {
  _beforeClearDrStateHook = typeof fn === 'function' ? fn : null;
}

// --- clear helpers ---
/** Clear exchange/session-related state but keep MK/DEVICE_PRIV (e.g., after successful login). */
export function clearExchangeState() {
  _SESSION = null;
  _WRAPPED_MK = null;
  _HAS_MK = false;
}

/** Clear the decrypted MK and DR sessions (e.g., on logout). */
export function clearSecrets() {
  _MK_RAW = null;
  setDevicePriv(null);
  logAllDrStates('core/store.js:515:clearSecrets');
  _DR_SESS.clear();
}

/** Full reset (rarely needed) */
export function resetAll() {
  _SESSION = null;
  _HAS_MK = false;
  _WRAPPED_MK = null;
  _ACCOUNT_TOKEN = null;
  _ACCOUNT_DIGEST = null;
  _MK_RAW = null;
  setDevicePriv(null);
  logAllDrStates('core/store.js:523:resetAll');
  _DR_SESS.clear();
}

/**
 * Helper to build a payload including account credentials (accountToken/accountDigest).
 * @param {{ overrides?: Record<string, any> }} [opts]
 */
export function buildAccountPayload(opts = {}) {
  const { overrides = {} } = opts;
  const payload = { ...overrides };
  if (_ACCOUNT_TOKEN && payload.accountToken == null) payload.accountToken = _ACCOUNT_TOKEN;
  if (_ACCOUNT_DIGEST && payload.accountDigest == null) payload.accountDigest = _ACCOUNT_DIGEST;
  return payload;
}

export function getOpaqueServerId() { return _OPAQUE_SERVER_ID; }
export function setOpaqueServerId(v) {
  _OPAQUE_SERVER_ID = v ? String(v) : null;
}
