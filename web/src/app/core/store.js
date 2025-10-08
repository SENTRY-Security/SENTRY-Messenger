

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
// - UID_HEX: normalized 7-byte UID hex (14 hex chars)
// - ACCOUNT_TOKEN: opaque token from /auth/sdm/exchange
// - ACCOUNT_DIGEST: hex digest identifying the account (HMAC(uid))
// - UID_DIGEST: optional hashed UID from backend (for diagnostics only)
// - MK_RAW: Uint8Array | null (decrypted MK, memory-only)
// - DEVICE_PRIV: { ik_priv_b64, ik_pub_b64, spk_priv_b64, spk_pub_b64, spk_sig_b64, next_opk_id } | null
// - DR_SESS: Map(peer_uidHex -> DR state object)

// --- primitives ---
let _SESSION = null;
let _HAS_MK = false;
let _WRAPPED_MK = null;
let _UID_HEX = null;
let _ACCOUNT_TOKEN = null;
let _ACCOUNT_DIGEST = null;
let _UID_DIGEST = null;
let _MK_RAW = null;        // Uint8Array
let _DEVICE_PRIV = null;   // object
const _DR_SESS = new Map(); // peer_uidHex -> { rk, ckS, ckR, Ns, Nr, PN, myRatchetPriv, myRatchetPub, theirRatchetPub }

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
export function setAccountDigest(v) {
  if (!v) {
    _ACCOUNT_DIGEST = null;
    return;
  }
  const cleaned = String(v).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  _ACCOUNT_DIGEST = cleaned || null;
}

export function getUidDigest() { return _UID_DIGEST; }
export function setUidDigest(v) {
  if (!v) {
    _UID_DIGEST = null;
    return;
  }
  const cleaned = String(v).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  _UID_DIGEST = cleaned || null;
}

export function getMkRaw() { return _MK_RAW; }
export function setMkRaw(u8) { _MK_RAW = u8 || null; }

export function getDevicePriv() { return _DEVICE_PRIV; }
export function setDevicePriv(obj) { _DEVICE_PRIV = obj || null; }

export function getDrSessMap() { return _DR_SESS; }
export function drState(peerUidHex) {
  const key = (peerUidHex || '').toUpperCase();
  if (!_DR_SESS.has(key)) {
    _DR_SESS.set(key, { rk:null, ckS:null, ckR:null, Ns:0, Nr:0, PN:0, myRatchetPriv:null, myRatchetPub:null, theirRatchetPub:null, baseKey:null });
  }
  return _DR_SESS.get(key);
}
export function clearDrState(peerUidHex) {
  if (!peerUidHex) { _DR_SESS.clear(); return; }
  _DR_SESS.delete((peerUidHex || '').toUpperCase());
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
  _DEVICE_PRIV = null;
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
  _UID_DIGEST = null;
  _MK_RAW = null;
  _DEVICE_PRIV = null;
  _DR_SESS.clear();
}

/**
 * Helper to build a payload including account credentials (accountToken/accountDigest)
 * and, optionally, the UID hex for backward compatibility.
 * @param {{ includeUid?: boolean, overrides?: Record<string, any> }} [opts]
 */
export function buildAccountPayload(opts = {}) {
  const { includeUid = true, overrides = {} } = opts;
  const payload = { ...overrides };
  if (_ACCOUNT_TOKEN && payload.accountToken == null) payload.accountToken = _ACCOUNT_TOKEN;
  if (_ACCOUNT_DIGEST && payload.accountDigest == null) payload.accountDigest = _ACCOUNT_DIGEST;
  if (includeUid && _UID_HEX && payload.uidHex == null) payload.uidHex = _UID_HEX;
  if (_UID_DIGEST && payload.uidDigest == null) payload.uidDigest = _UID_DIGEST;
  return payload;
}
