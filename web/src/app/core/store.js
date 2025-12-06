

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
// - UID_HEX: normalized 7-byte UID hex（僅 SDM/硬體模擬使用，其他流程已改 accountDigest-only）
// - ACCOUNT_TOKEN: opaque token from /auth/sdm/exchange
// - ACCOUNT_DIGEST: hex digest identifying the account (HMAC(uid))
// - MK_RAW: Uint8Array | null (decrypted MK, memory-only)
// - DEVICE_PRIV: { ik_priv_b64, ik_pub_b64, spk_priv_b64, spk_pub_b64, spk_sig_b64, next_opk_id } | null
// - DR_SESS: Map(peer_uidHex -> DR state object)
// - OPAQUE_SERVER_ID: server identity string for OPAQUE handshake (optional)

// --- primitives ---
let _SESSION = null;
let _HAS_MK = false;
let _WRAPPED_MK = null;
let _UID_HEX = null;
let _ACCOUNT_TOKEN = null;
let _ACCOUNT_DIGEST = null;
let _MK_RAW = null;        // Uint8Array
let _DEVICE_PRIV = null;   // object
const _DEVICE_PRIV_WAITERS = new Set();
const _DR_SESS = new Map(); // peerKey (accountDigest) -> { rk, ckS, ckR, Ns, Nr, PN, myRatchetPriv, myRatchetPub, theirRatchetPub }
const _DR_PEER_ALIASES = new Map(); // alias -> primary peerKey
let _OPAQUE_SERVER_ID = null;

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

export function getUidHex() { return _UID_HEX; }
export function setUidHex(v) {
  _UID_HEX = (v || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase() || null;
}

export function getAccountToken() { return _ACCOUNT_TOKEN; }
export function setAccountToken(v) { _ACCOUNT_TOKEN = v ? String(v) : null; }

export function getAccountDigest() { return _ACCOUNT_DIGEST; }
export function normalizeAccountDigest(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned && cleaned.length === 64 ? cleaned : null;
}
export function normalizePeerUid(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned || null;
}
export function normalizePeerIdentity(peer) {
  if (peer && typeof peer === 'object') {
    const digest = normalizeAccountDigest(peer.peerAccountDigest ?? peer.accountDigest ?? peer.peer_account_digest ?? peer.account_digest);
    const uid = null; // UID deprecated
    const aliases = digest ? [digest] : [];
    return { key: digest || null, accountDigest: digest, uid, aliases };
  }
  const digest = normalizeAccountDigest(peer);
  const aliases = digest ? [digest] : [];
  return { key: digest || null, accountDigest: digest, uid: null, aliases };
}
function registerDrAliases(primary, aliases = []) {
  if (!primary) return;
  for (const alias of aliases) {
    if (!alias || alias === primary) continue;
    _DR_PEER_ALIASES.set(alias, primary);
  }
}
function resolveDrKey(peerInput) {
  const identity = normalizePeerIdentity(peerInput);
  const aliases = identity.aliases || [];
  if (!identity.key) {
    for (const alias of aliases) {
      if (!alias) continue;
      const mapped = _DR_PEER_ALIASES.get(alias);
      if (mapped) {
        return { key: mapped, aliases };
      }
    }
    return { key: null, aliases };
  }
  let key = identity.key;
  if (_DR_PEER_ALIASES.has(key)) {
    key = _DR_PEER_ALIASES.get(key) || key;
  }
  if (!_DR_SESS.has(key)) {
    for (const alias of aliases) {
      if (!alias) continue;
      const mapped = _DR_PEER_ALIASES.get(alias);
      if (mapped && _DR_SESS.has(mapped)) {
        key = mapped;
        break;
      }
      if (_DR_SESS.has(alias)) {
        key = alias;
        break;
      }
    }
  }
  registerDrAliases(key, aliases);
  return { key, aliases };
}
export function setAccountDigest(v) {
  _ACCOUNT_DIGEST = normalizeAccountDigest(v);
}

export function getMkRaw() { return _MK_RAW; }
export function setMkRaw(u8) { _MK_RAW = u8 || null; }

export function getDevicePriv() { return _DEVICE_PRIV; }
export function setDevicePriv(obj) {
  _DEVICE_PRIV = obj || null;
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
  const { key } = resolveDrKey(peerInput);
  if (!key) return null;
  if (!_DR_SESS.has(key)) {
    _DR_SESS.set(key, {
      rk: null,
      ckS: null,
      ckR: null,
      Ns: 0,
      Nr: 0,
      PN: 0,
      myRatchetPriv: null,
      myRatchetPub: null,
      theirRatchetPub: null,
      baseKey: null,
      pendingSendRatchet: false,
      historyCursorTs: null,
      historyCursorId: null,
      skippedKeys: new Map()
    });
  }
  const state = _DR_SESS.get(key);
  if (state && !(state.skippedKeys instanceof Map)) {
    try {
      state.skippedKeys = new Map();
    } catch {
      state.skippedKeys = null;
    }
  }
  return state;
}
export function clearDrState(peerInput) {
  if (!peerInput) {
    _DR_SESS.clear();
    _DR_PEER_ALIASES.clear();
    return;
  }
  const { key } = resolveDrKey(peerInput);
  if (!key) return;
  _DR_SESS.delete(key);
  for (const [alias, primary] of Array.from(_DR_PEER_ALIASES.entries())) {
    if (alias === key || primary === key) _DR_PEER_ALIASES.delete(alias);
  }
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
  _DR_SESS.clear();
}

/** Full reset (rarely needed) */
export function resetAll() {
  _SESSION = null;
  _HAS_MK = false;
  _WRAPPED_MK = null;
  _UID_HEX = null;
  _ACCOUNT_TOKEN = null;
  _ACCOUNT_DIGEST = null;
  _MK_RAW = null;
  setDevicePriv(null);
  _DR_SESS.clear();
  _DR_PEER_ALIASES.clear();
}

/**
 * Helper to build a payload including account credentials (accountToken/accountDigest).
 * UID hex is legacy and僅供 SDM/debug opt-in；預設僅回填 accountDigest/accountToken。
 * @param {{ includeUid?: boolean, overrides?: Record<string, any> }} [opts]
 */
export function buildAccountPayload(opts = {}) {
  const { includeUid = false, overrides = {} } = opts;
  const payload = { ...overrides };
  if (_ACCOUNT_TOKEN && payload.accountToken == null) payload.accountToken = _ACCOUNT_TOKEN;
  if (_ACCOUNT_DIGEST && payload.accountDigest == null) payload.accountDigest = _ACCOUNT_DIGEST;
  if (includeUid && _UID_HEX && payload.uidHex == null) payload.uidHex = _UID_HEX;
  return payload;
}

export function getOpaqueServerId() { return _OPAQUE_SERVER_ID; }
export function setOpaqueServerId(v) {
  _OPAQUE_SERVER_ID = v ? String(v) : null;
}
