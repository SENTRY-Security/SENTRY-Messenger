// /app/core/contact-secrets.js
// Centralized helpers to persist and access contact-share secrets.

import { sessionStore } from '../ui/mobile/session-store.js';
import { log, logCapped } from './log.js';
import { b64 } from '../crypto/nacl.js';
import {
  getAccountDigest,
  ensureDeviceId,
  normalizePeerIdentity,
  normalizeAccountDigest,
  normalizePeerDeviceId
} from './store.js';
import { encryptWithMK, decryptWithMK, b64u8, assertEnvelopeStrict } from '../crypto/aead.js';

const STORAGE_KEY_BASE = 'contactSecrets-v2';
const LATEST_KEY_BASE = 'contactSecrets-v2-latest';
const META_KEY_BASE = 'contactSecrets-v2-meta';
const CHECKSUM_KEY_BASE = 'contactSecrets-v2-checksum';
const CONTACT_SECRETS_VERSION = 4;
const LEGACY_STORAGE_KEY_BASE = 'contactSecrets-v1';
const LEGACY_LATEST_KEY_BASE = 'contactSecrets-v1-latest';
const LEGACY_META_KEY_BASE = 'contactSecrets-v1-meta';
const LEGACY_CHECKSUM_KEY_BASE = 'contactSecrets-v1-checksum';
let restored = false;
let contactSecretsLocked = false;
const SNAPSHOT_INFO_TAG = 'contact-secrets/backup/v1';
const SNAPSHOT_ALLOWED_INFO_TAGS = new Set([SNAPSHOT_INFO_TAG]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TEXT_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const contactAliasToPrimary = new Map(); // alias -> primary key (accountDigest::deviceId preferred)
const contactPrimaryToAliases = new Map(); // primary -> Set(alias)
const CORRUPT_REASON_DEFAULT = 'invalid-contact-secret';
const PENDING_REASON_DEFAULT = 'pending-material';
let lastRestoreSummary = null;
let lastRestoreError = null;
const ROLE_NORMALIZE_LOG_LIMIT = 5;
let roleNormalizeLogCount = 0;
const CONTACT_SECRETS_RESTORE_TRACE_LIMIT = 3;
const CONTACT_SECRETS_SANITIZE_DROP_LIMIT = 3;
const CONTACT_SECRET_WRITE_TRACE_LIMIT = 3;
let contactSecretsRestoreTraceCount = 0;
let contactSecretsSanitizeDropCount = 0;
let contactSecretWriteTraceCount = 0;

function logContactSecretsRestoreTrace(payload = {}) {
  if (contactSecretsRestoreTraceCount >= CONTACT_SECRETS_RESTORE_TRACE_LIMIT) return;
  contactSecretsRestoreTraceCount += 1;
  log({ contactSecretsRestoreTrace: payload });
}

function logContactSecretsSanitizeDropTrace(payload = {}) {
  if (contactSecretsSanitizeDropCount >= CONTACT_SECRETS_SANITIZE_DROP_LIMIT) return;
  contactSecretsSanitizeDropCount += 1;
  log({ contactSecretsSanitizeDropTrace: payload });
}

function logContactSecretWriteTrace(payload = {}) {
  if (contactSecretWriteTraceCount >= CONTACT_SECRET_WRITE_TRACE_LIMIT) return;
  contactSecretWriteTraceCount += 1;
  log({ contactSecretWriteTrace: payload });
}

export function normalizeContactRole(rawRole, { source = null, identity = null, logChange = false } = {}) {
  const val = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
  if (!val) return null;
  let normalized = val;
  // Legacy role conversion removed. Strict role preservation.
  // if (val === 'responder') { normalized = 'owner'; ... }
  // if (val === 'initiator') { normalized = 'guest'; ... }
  if (logChange && normalized !== val) {
    // Only log if normalization (lowercase) changed it, not value transformation
    roleNormalizeLogCount += 1;
    log({
      contactSecretsRoleNormalizeTrace: {
        fromRole: val,
        toRole: normalized,
        peerAccountDigest: identity?.accountDigest || null,
        peerDeviceId: identity?.deviceId || null,
        source: source || null
      }
    });
  }
  return normalized;
}

function ensureCorruptContactMap() {
  if (!(sessionStore.corruptContacts instanceof Map)) {
    const entries = sessionStore.corruptContacts && typeof sessionStore.corruptContacts.entries === 'function'
      ? Array.from(sessionStore.corruptContacts.entries())
      : [];
    sessionStore.corruptContacts = new Map(entries);
  }
  return sessionStore.corruptContacts;
}

function recordCorruptContact({ peerKey = null, peerAccountDigest = null, peerDeviceId = null, reason = CORRUPT_REASON_DEFAULT, source = null } = {}) {
  const store = ensureCorruptContactMap();
  const identity = normalizePeerIdentity(peerKey || { peerAccountDigest, peerDeviceId });
  const key = identity.key;
  const entry = {
    peerAccountDigest: identity.accountDigest,
    peerDeviceId: identity.deviceId,
    reason: reason || CORRUPT_REASON_DEFAULT,
    source: source || null,
    ts: Date.now()
  };
  if (key) store.set(key, entry);
  if (identity.accountDigest && identity.deviceId && !store.has(identity.accountDigest)) {
    store.set(identity.accountDigest, { ...entry });
  }
  return entry;
}

function clearCorruptContact(peerKey = null) {
  const store = ensureCorruptContactMap();
  if (!peerKey) {
    store.clear();
    return;
  }
  const identity = normalizePeerIdentity(peerKey);
  if (identity.key && store.delete(identity.key)) return;
  if (identity.accountDigest) {
    store.delete(identity.accountDigest);
    for (const key of Array.from(store.keys())) {
      if (typeof key === 'string' && key.startsWith(`${identity.accountDigest}::`)) {
        store.delete(key);
      }
    }
  }
}

export function getCorruptContact(peer) {
  const store = ensureCorruptContactMap();
  const identity = normalizePeerIdentity(peer);
  if (identity.key && store.has(identity.key)) return store.get(identity.key);
  if (identity.accountDigest && store.has(identity.accountDigest)) return store.get(identity.accountDigest);
  return null;
}

export function listCorruptContacts() {
  const store = ensureCorruptContactMap();
  return Array.from(store.values());
}

function ensurePendingContactMap() {
  if (!(sessionStore.pendingContacts instanceof Map)) {
    const entries = sessionStore.pendingContacts && typeof sessionStore.pendingContacts.entries === 'function'
      ? Array.from(sessionStore.pendingContacts.entries())
      : [];
    sessionStore.pendingContacts = new Map(entries);
  }
  return sessionStore.pendingContacts;
}

export function recordPendingContact(peerAccountDigest, reason = PENDING_REASON_DEFAULT, { source = null, peerDeviceId = null } = {}) {
  const store = ensurePendingContactMap();
  const { key, identity } = resolvePeerKey(peerAccountDigest, { peerDeviceIdHint: peerDeviceId });
  if (!key) return null;
  const entry = {
    peerAccountDigest: identity.accountDigest,
    peerDeviceId: identity.deviceId,
    reason: reason || PENDING_REASON_DEFAULT,
    source: source || null,
    ts: Date.now()
  };
  store.set(key, entry);
  if (identity.accountDigest && identity.deviceId && !store.has(identity.accountDigest)) {
    store.set(identity.accountDigest, { ...entry });
  }
  return entry;
}

export function clearPendingContact(peerKey = null) {
  const store = ensurePendingContactMap();
  if (!peerKey) {
    store.clear();
    return;
  }
  const identity = normalizePeerIdentity(peerKey);
  if (identity.key && store.delete(identity.key)) return;
  if (identity.accountDigest) {
    store.delete(identity.accountDigest);
    for (const key of Array.from(store.keys())) {
      if (typeof key === 'string' && key.startsWith(`${identity.accountDigest}::`)) {
        store.delete(key);
      }
    }
  }
}

export function listPendingContacts() {
  const store = ensurePendingContactMap();
  return Array.from(store.values());
}

export function quarantineCorruptContact(peerAccountDigest, reason = CORRUPT_REASON_DEFAULT, { badField = null, type = null, source = 'quarantine' } = {}) {
  const sourceTag = source || 'quarantine';
  const { key, identity } = resolvePeerKey(peerAccountDigest);
  if (!key) return false;
  const map = ensureMap();
  const record = map.get(key) || null;
  if (record && record.devices && typeof record.devices === 'object') {
    for (const dev of Object.values(record.devices)) {
      if (!dev || typeof dev !== 'object') continue;
      dev.drState = null;
      dev.drHistory = [];
      dev.drHistoryCursorTs = null;
      dev.drHistoryCursorId = null;
    }
  }
  const entry = recordCorruptContact({
    peerKey: key,
    peerAccountDigest: identity.accountDigest,
    peerDeviceId: identity.deviceId,
    reason: reason || CORRUPT_REASON_DEFAULT,
    source: sourceTag
  });
  try {
    console.warn('[contact-core] corrupt', JSON.stringify({
      peerKey: key,
      reason: reason || CORRUPT_REASON_DEFAULT,
      badField: badField || null,
      type: type || null,
      sourceTag,
      source: sourceTag
    }));
  } catch { }
  try {
    persistContactSecrets();
  } catch (err) {
    log({ contactSecretsQuarantinePersistError: err?.message || err, peerKey: key, source: sourceTag });
  }
  return !!entry;
}

function cloneImmutable(value, { path = '', sourceTag = 'contact-secrets:clone' } = {}) {
  const location = path || '(root)';
  const logCloneError = (reason) => {
    try {
      console.warn('[contact-secrets:clone-fail]', JSON.stringify({
        path: location,
        ctor: value?.constructor?.name || null,
        typeof: typeof value,
        reason,
        sourceTag
      }));
    } catch { }
  };

  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof ArrayBuffer) {
    try {
      return value.slice(0);
    } catch { }
    const bufferCopy = new ArrayBuffer(value.byteLength);
    new Uint8Array(bufferCopy).set(new Uint8Array(value));
    return bufferCopy;
  }

  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      const bufferCopy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      return new DataView(bufferCopy);
    }
    if (value.constructor && typeof value.constructor.from === 'function') {
      return value.constructor.from(value);
    }
    if (typeof value.slice === 'function') {
      return value.slice(0);
    }
    const bufferCopy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    try {
      return new value.constructor(bufferCopy);
    } catch {
      logCloneError('unsupported-typed-array');
      throw new Error(`contact-secrets clone failed at ${location}`);
    }
  }

  if (Array.isArray(value)) {
    return value.map((item, idx) => {
      const childPath = path ? `${path}[${idx}]` : `[${idx}]`;
      return cloneImmutable(item, { path: childPath, sourceTag });
    });
  }

  if (value instanceof Set) {
    const next = new Set();
    let idx = 0;
    for (const entry of value) {
      const childPath = path ? `${path}[${idx}]` : `[${idx}]`;
      next.add(cloneImmutable(entry, { path: childPath, sourceTag }));
      idx += 1;
    }
    return next;
  }

  if (value instanceof Map) {
    return new Map(Array.from(value.entries()).map(([k, v]) => {
      const childPath = path ? `${path}.${String(k)}` : String(k);
      return [k, cloneImmutable(v, { path: childPath, sourceTag })];
    }));
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    logCloneError('unsupported-object');
    throw new Error(`contact-secrets clone failed at ${location}`);
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const childPath = path ? `${path}.${k}` : k;
    out[k] = cloneImmutable(v, { path: childPath, sourceTag });
  }
  return out;
}


function normalizeDeviceId(value) {
  if (!value) return null;
  const v = String(value).trim();
  return v || null;
}

function getLocalStorageSafe() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

function getSessionStorageSafe() {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage || null;
  } catch {
    return null;
  }
}

function parseJsonSafe(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveContactSecretsNamespace({ accountDigest } = {}) {
  const digest = normalizeAccountDigest(accountDigest) || normalizeAccountDigest(getAccountDigest?.());
  if (digest) return `acct-${digest}`;
  return null;
}

function buildKey(base, namespace) {
  return namespace ? `${base}:${namespace}` : base;
}

function extractNamespaceFromKey(key, base) {
  if (!key || !base) return null;
  if (key === base) return null;
  const prefix = `${base}:`;
  if (key.startsWith(prefix)) return key.slice(prefix.length);
  return null;
}

function uniqueKeys(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function getKeyVariants(base, opts = {}, { includeLegacyFallback = false, includeBase = true } = {}) {
  const namespace = resolveContactSecretsNamespace(opts);
  const keys = [];
  if (namespace) keys.push(buildKey(base, namespace));
  if (includeLegacyFallback && namespace) {
    if (base === STORAGE_KEY_BASE) keys.push(buildKey(LEGACY_STORAGE_KEY_BASE, namespace));
    if (base === LATEST_KEY_BASE) keys.push(buildKey(LEGACY_LATEST_KEY_BASE, namespace));
    if (base === META_KEY_BASE) keys.push(buildKey(LEGACY_META_KEY_BASE, namespace));
    if (base === CHECKSUM_KEY_BASE) keys.push(buildKey(LEGACY_CHECKSUM_KEY_BASE, namespace));
  }
  if (includeBase !== false) {
    keys.push(base);
  }
  return uniqueKeys(keys);
}

export function getContactSecretsStorageKeys(opts = {}, { includeLegacy = false, includeBase = true } = {}) {
  return getKeyVariants(STORAGE_KEY_BASE, opts, { includeLegacyFallback: includeLegacy, includeBase });
}

export function getContactSecretsLatestKeys(opts = {}, { includeLegacy = false, includeBase = true } = {}) {
  return getKeyVariants(LATEST_KEY_BASE, opts, { includeLegacyFallback: includeLegacy, includeBase });
}

export function getContactSecretsMetaKeys(opts = {}, { includeLegacy = false, includeBase = true } = {}) {
  return getKeyVariants(META_KEY_BASE, opts, { includeLegacyFallback: includeLegacy, includeBase });
}

export function getContactSecretsChecksumKeys(opts = {}, { includeLegacy = false, includeBase = true } = {}) {
  return getKeyVariants(CHECKSUM_KEY_BASE, opts, { includeLegacyFallback: includeLegacy, includeBase });
}

export function getLegacyContactSecretsStorageKeys(opts = {}) {
  return getKeyVariants(LEGACY_STORAGE_KEY_BASE, opts, { includeLegacyFallback: false });
}

export function getLegacyContactSecretsLatestKeys(opts = {}) {
  return getKeyVariants(LEGACY_LATEST_KEY_BASE, opts, { includeLegacyFallback: false });
}

export function getLegacyContactSecretsMetaKeys(opts = {}) {
  return getKeyVariants(LEGACY_META_KEY_BASE, opts, { includeLegacyFallback: false });
}

export function getLegacyContactSecretsChecksumKeys(opts = {}) {
  return getKeyVariants(LEGACY_CHECKSUM_KEY_BASE, opts, { includeLegacyFallback: false });
}

function pullLatestSnapshot({ forcePromote = false, reason = 'hydrate', removeSessionIfCopied = true } = {}) {
  let localPayload = null;
  let sessionPayload = null;
  let localMeta = null;
  let sessionMeta = null;
  let localChecksum = null;
  let sessionChecksum = null;
  const local = getLocalStorageSafe();
  const session = getSessionStorageSafe();

  const storageKeys = getContactSecretsStorageKeys();

  const activeNamespace = resolveContactSecretsNamespace();

  const readPayloadRecord = (store, baseKey) => {
    if (!store) return { payload: null, key: buildKey(baseKey, activeNamespace), namespace: activeNamespace };
    for (const key of storageKeys) {
      try {
        const value = store.getItem(key);
        if (value) {
          return { payload: value, key, namespace: extractNamespaceFromKey(key, baseKey) };
        }
      } catch (err) {
        const field = store === local ? 'contactSecretLocalReadError' : 'contactSecretSessionReadError';
        log({ [field]: err?.message || err, key });
      }
    }
    return { payload: null, key: buildKey(baseKey, activeNamespace), namespace: activeNamespace };
  };

  const readMetaRecord = (store, baseKey, namespace) => {
    if (!store) return null;
    const key = buildKey(baseKey, namespace);
    try {
      return parseJsonSafe(store.getItem(key));
    } catch {
      return null;
    }
  };

  const readChecksumRecord = (store, baseKey, namespace) => {
    if (!store) return null;
    const key = buildKey(baseKey, namespace);
    try {
      return parseJsonSafe(store.getItem(key));
    } catch {
      return null;
    }
  };

  const localRecord = readPayloadRecord(local, STORAGE_KEY_BASE);
  const sessionRecord = readPayloadRecord(session, STORAGE_KEY_BASE);
  localPayload = localRecord.payload;
  sessionPayload = sessionRecord.payload;
  localMeta = readMetaRecord(local, META_KEY_BASE, localRecord.namespace);
  sessionMeta = readMetaRecord(session, META_KEY_BASE, sessionRecord.namespace);
  localChecksum = readChecksumRecord(local, CHECKSUM_KEY_BASE, localRecord.namespace);
  sessionChecksum = readChecksumRecord(session, CHECKSUM_KEY_BASE, sessionRecord.namespace);

  const localLen = typeof localPayload === 'string' ? localPayload.length : 0;
  const sessionLen = typeof sessionPayload === 'string' ? sessionPayload.length : 0;
  const localTs = Number(localMeta?.ts || 0);
  const sessionTs = Number(sessionMeta?.ts || 0);
  const localChecksumVal = typeof localChecksum?.checksum === 'string' ? localChecksum.checksum : null;
  const sessionChecksumVal = typeof sessionChecksum?.checksum === 'string' ? sessionChecksum.checksum : null;

  let promoteReason = null;
  if (sessionPayload) {
    if (forcePromote) {
      promoteReason = 'force';
    } else if (!localPayload) {
      promoteReason = 'missing-local';
    } else if (sessionLen > localLen) {
      promoteReason = 'length-greater';
    } else if (sessionLen === localLen) {
      if (sessionTs && (!localTs || sessionTs > localTs)) {
        promoteReason = 'newer-timestamp';
      } else if (sessionTs && localTs && sessionTs === localTs && sessionChecksumVal && localChecksumVal && sessionChecksumVal !== localChecksumVal) {
        promoteReason = 'checksum-diff';
      } else if (!sessionTs && !localTs && sessionChecksumVal && localChecksumVal && sessionChecksumVal !== localChecksumVal) {
        promoteReason = 'checksum-diff';
      } else if (!localTs && sessionTs) {
        promoteReason = 'timestamp-available';
      }
    }
  }

  const shouldPromote = !!promoteReason;
  let wroteToLocal = false;
  const resolvedNamespace = sessionRecord.namespace ?? activeNamespace;

  if (shouldPromote && local) {
    try {
      const targetKey = buildKey(STORAGE_KEY_BASE, resolvedNamespace);
      local.setItem(targetKey, sessionPayload);
      wroteToLocal = true;
      if (sessionMeta) {
        local.setItem(buildKey(META_KEY_BASE, resolvedNamespace), JSON.stringify(sessionMeta));
      }
      if (sessionChecksum) {
        local.setItem(buildKey(CHECKSUM_KEY_BASE, resolvedNamespace), JSON.stringify(sessionChecksum));
      }
    } catch (err) {
      log({ contactSecretSessionCopyError: err?.message || err });
      wroteToLocal = false;
    }
  }

  if (shouldPromote) {
    if (session && removeSessionIfCopied && (!local || wroteToLocal)) {
      try { session.removeItem(sessionRecord.key); } catch { }
    }
    debugLog('session-promote', {
      reason,
      bytes: sessionPayload?.length || 0,
      wroteToLocal,
      hasLocal: !!local,
      promoteReason,
      localBytes: localLen,
      sessionBytes: sessionLen,
      localTs,
      sessionTs,
      checksumChanged: sessionChecksumVal && localChecksumVal ? sessionChecksumVal !== localChecksumVal : null
    });
    return sessionPayload;
  }

  debugLog('session-skip', {
    reason,
    forcePromote,
    localBytes: localLen,
    sessionBytes: sessionLen,
    localTs,
    sessionTs,
    checksumEqual: sessionChecksumVal && localChecksumVal ? sessionChecksumVal === localChecksumVal : null
  });

  return localPayload || sessionPayload || null;
}

(function hydrateContactSecretsFromSession() {
  try {
    pullLatestSnapshot({ forcePromote: false, reason: 'module-init' });
  } catch {
    // ignore hydration errors
  }
})();

function isAutomationEnv() {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  if (typeof window !== 'undefined' && window.__DEBUG_CONTACT_SECRETS__) return true;
  return false;
}

const CONTACT_DEBUG = { enabled: false };
try {
  CONTACT_DEBUG.enabled = isAutomationEnv();
} catch {
  CONTACT_DEBUG.enabled = false;
}
if (CONTACT_DEBUG.enabled) {
  try {
    console.log('[contact-secrets] debug enabled');
  } catch { }
}

function debugLog(event, payload) {
  if (!CONTACT_DEBUG.enabled) return;
  try {
    console.log('[contact-secrets]', event, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function trimString(value) {
  if (typeof value !== 'string') {
    console.warn('[contact-secrets:invalid-string]', { reason: 'not-string', type: typeof value, ctor: value?.constructor?.name || null });
    throw new Error('contact-secrets invalid string: not-string');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    console.warn('[contact-secrets:invalid-string]', { reason: 'empty-string', type: typeof value, ctor: value?.constructor?.name || null });
    throw new Error('contact-secrets invalid string: empty');
  }
  return trimmed;
}

function chooseString(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return trimString(value);
}

function normalizeOptionalString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

function toBase64Maybe(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value instanceof Uint8Array) return b64(value);
  if (Array.isArray(value) && value.length) {
    const copy = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      const n = Number(value[i]);
      copy[i] = Number.isFinite(n) ? (n & 0xff) : 0;
    }
    return b64(copy);
  }
  if (ArrayBuffer.isView(value)) {
    return b64(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
  }
  return null;
}

function normalizeOptionalB64(raw, { keyName, peerKey = null, deviceId = null, source = null, strict = false } = {}) {
  if (raw === undefined) return null;
  if (raw === null) return null;
  const converted = toBase64Maybe(raw);
  if (!strict) return converted;
  const provided = raw !== undefined;
  if (provided && converted === null) {
    logPersistInvalidKey({ keyName, raw, peerKey, deviceId, source, reason: 'not-b64-string' });
    throw new Error(`contact-secrets persist blocked: ${keyName} not string`);
  }
  return converted;
}

function logPersistInvalidKey({ keyName, raw, peerKey = null, deviceId = null, source = null, reason = null }) {
  try {
    console.warn('[contact-secrets:persist-invalid-key]', {
      keyName,
      peerKey,
      deviceId,
      source,
      reason: reason || null,
      type: typeof raw,
      ctor: raw?.constructor?.name || null,
      isView: ArrayBuffer.isView(raw),
      byteLength: typeof raw?.byteLength === 'number' ? raw.byteLength : null,
      length: typeof raw?.length === 'number' ? raw.length : null
    });
  } catch { }
}

function logImportInvalidSnapshotKey({ keyName, raw, peerKey = null, deviceId = null, source = null, reason = null }) {
  try {
    console.warn('[contact-secrets:import-invalid-key]', {
      keyName,
      peerKey,
      deviceId,
      source,
      reason: reason || null,
      type: typeof raw,
      ctor: raw?.constructor?.name || null,
      isView: ArrayBuffer.isView(raw),
      byteLength: typeof raw?.byteLength === 'number' ? raw.byteLength : null,
      length: typeof raw?.length === 'number' ? raw.length : null
    });
  } catch { }
}

function requireSnapshotString(raw, { keyName, required = false, allowNull = false, peerKey = null, deviceId = null, source = null } = {}) {
  const provided = raw !== undefined;
  if (!provided) {
    if (required) {
      logImportInvalidSnapshotKey({ keyName, raw, peerKey, deviceId, source, reason: 'missing' });
      throw new Error(`contact-secrets import blocked: missing ${keyName}`);
    }
    return null;
  }
  if (raw === null) {
    if (allowNull) return null;
    logImportInvalidSnapshotKey({ keyName, raw, peerKey, deviceId, source, reason: 'null' });
    throw new Error(`contact-secrets import blocked: missing ${keyName}`);
  }
  if (typeof raw !== 'string') {
    logImportInvalidSnapshotKey({ keyName, raw, peerKey, deviceId, source, reason: 'not-string' });
    throw new Error(`contact-secrets import blocked: ${keyName} not string`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    logImportInvalidSnapshotKey({ keyName, raw, peerKey, deviceId, source, reason: 'empty-string' });
    throw new Error(`contact-secrets import blocked: ${keyName} empty`);
  }
  return trimmed;
}

function validateDrSnapshotInput(raw, { peerKey = null, deviceId = null, source = null } = {}) {
  if (!raw || typeof raw !== 'object') {
    logImportInvalidSnapshotKey({ keyName: 'snapshot', raw, peerKey, deviceId, source, reason: 'not-object' });
    throw new Error('contact-secrets import blocked: dr snapshot not object');
  }
  const ctx = { peerKey, deviceId, source };
  requireSnapshotString(raw.rk_b64 ?? raw.rk, { ...ctx, keyName: 'rk_b64', required: true });
  requireSnapshotString(raw.ckR_b64 ?? raw.ckR, { ...ctx, keyName: 'ckR_b64' });
  requireSnapshotString(raw.ckS_b64 ?? raw.ckS, { ...ctx, keyName: 'ckS_b64' });
  requireSnapshotString(raw.myRatchetPriv_b64 ?? raw.myRatchetPriv, { ...ctx, keyName: 'myRatchetPriv_b64', allowNull: true });
  requireSnapshotString(raw.myRatchetPub_b64 ?? raw.myRatchetPub, { ...ctx, keyName: 'myRatchetPub_b64', allowNull: true });
  requireSnapshotString(raw.theirRatchetPub_b64 ?? raw.theirRatchetPub, { ...ctx, keyName: 'theirRatchetPub_b64', allowNull: true });
}

function validateDrHistoryInput(entries, { peerKey = null, deviceId = null, source = null } = {}) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const snap = entry.snapshot || entry.drState || entry.state || null;
    if (snap) validateDrSnapshotInput(snap, { peerKey, deviceId, source });
    const snapAfter = entry.snapshotAfter || entry.snapshot_after || entry.nextSnapshot || entry.snapshot_next || null;
    if (snapAfter) validateDrSnapshotInput(snapAfter, { peerKey, deviceId, source: source ? `${source}:after` : 'dr-history:after' });
  }
}

function normalizeDrKeyString(raw, { keyName, peerKey = null, deviceId = null, source = null, required = false, hasKey = false } = {}) {
  const present = hasKey || raw !== undefined;
  if (!present) {
    if (required) {
      logPersistInvalidKey({ keyName, raw, peerKey, deviceId, source, reason: 'missing' });
      throw new Error(`contact-secrets persist blocked: missing ${keyName}`);
    }
    return null;
  }
  if (typeof raw !== 'string') {
    logPersistInvalidKey({ keyName, raw, peerKey, deviceId, source, reason: 'not-string' });
    throw new Error(`contact-secrets persist blocked: ${keyName} not string`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    logPersistInvalidKey({ keyName, raw, peerKey, deviceId, source, reason: 'empty-string' });
    throw new Error(`contact-secrets persist blocked: ${keyName} empty`);
  }
  return trimmed;
}

function toNumberOrDefault(value, def = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

function toNumberRequired(value, keyName, { source = null, peerKey = null, deviceId = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    logPersistInvalidKey({ keyName, raw: value, peerKey, deviceId, source, reason: 'missing-number' });
    throw new Error(`contact-secrets invalid dr snapshot: missing ${keyName}`);
  }
  return n;
}

function toTimestampOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function normalizeDrSnapshot(input, { setDefaultUpdatedAt = false, source = 'normalize', peerKey = null, deviceId = null, strictB64 = false } = {}) {
  if (!input || typeof input !== 'object') {
    console.warn('[contact-secrets:invalid-dr-snapshot]', { reason: 'not-object', type: typeof input, source, peerKey, deviceId });
    throw new Error('contact-secrets invalid dr snapshot: not object');
  }
  const hasRk = Object.prototype.hasOwnProperty.call(input, 'rk_b64') || Object.prototype.hasOwnProperty.call(input, 'rk');
  const hasCkS = Object.prototype.hasOwnProperty.call(input, 'ckS_b64') || Object.prototype.hasOwnProperty.call(input, 'ckS');
  const hasCkR = Object.prototype.hasOwnProperty.call(input, 'ckR_b64') || Object.prototype.hasOwnProperty.call(input, 'ckR');

  // Prioritize _b64 suffix
  const rk = normalizeDrKeyString(input.rk_b64 ?? input.rk, { keyName: 'rk_b64', peerKey, deviceId, source, required: true, hasKey: hasRk });
  const ckS = normalizeDrKeyString(input.ckS_b64 ?? input.ckS, { keyName: 'ckS_b64', peerKey, deviceId, source, required: hasCkS, hasKey: hasCkS });
  const ckR = normalizeDrKeyString(input.ckR_b64 ?? input.ckR, { keyName: 'ckR_b64', peerKey, deviceId, source, required: hasCkR, hasKey: hasCkR });
  const hasNsTotal = Object.prototype.hasOwnProperty.call(input, 'NsTotal') || Object.prototype.hasOwnProperty.call(input, 'Ns_total');
  const hasNrTotal = Object.prototype.hasOwnProperty.call(input, 'NrTotal') || Object.prototype.hasOwnProperty.call(input, 'Nr_total');
  if (!hasNsTotal) {
    logPersistInvalidKey({ keyName: 'NsTotal', raw: input?.NsTotal ?? input?.Ns_total, peerKey, deviceId, source, reason: 'missing-counter' });
    throw new Error('contact-secrets invalid dr snapshot: missing NsTotal');
  }
  if (!hasNrTotal) {
    logPersistInvalidKey({ keyName: 'NrTotal', raw: input?.NrTotal ?? input?.Nr_total, peerKey, deviceId, source, reason: 'missing-counter' });
    throw new Error('contact-secrets invalid dr snapshot: missing NrTotal');
  }
  const out = {
    v: Number.isFinite(Number(input.v)) ? Number(input.v) : 1,
    rk_b64: rk,
    Ns: toNumberOrDefault(input.Ns, 0),
    Nr: toNumberOrDefault(input.Nr, 0),
    PN: toNumberOrDefault(input.PN, 0),
    NsTotal: toNumberRequired(input.NsTotal ?? input.Ns_total, 'NsTotal', { source, peerKey, deviceId }),
    NrTotal: toNumberRequired(input.NrTotal ?? input.Nr_total, 'NrTotal', { source, peerKey, deviceId }),
    myRatchetPriv_b64: normalizeOptionalB64(input.myRatchetPriv ?? input.myRatchetPriv_b64, { keyName: 'myRatchetPriv_b64', peerKey, deviceId, source, strict: strictB64 }),
    myRatchetPub_b64: normalizeOptionalB64(input.myRatchetPub ?? input.myRatchetPub_b64, { keyName: 'myRatchetPub_b64', peerKey, deviceId, source, strict: strictB64 }),
    theirRatchetPub_b64: normalizeOptionalB64(input.theirRatchetPub ?? input.theirRatchetPub_b64, { keyName: 'theirRatchetPub_b64', peerKey, deviceId, source, strict: strictB64 }),
    pendingSendRatchet: !!input.pendingSendRatchet,
    updatedAt: toTimestampOrNull(input.updatedAt ?? input.snapshotTs ?? input.ts ?? null)
  };
  if (ckS) out.ckS_b64 = ckS;
  if (ckR) out.ckR_b64 = ckR;
  const role = chooseString(input.role, null);
  if (role) out.role = role.toLowerCase();
  const selfDev = chooseString(input.selfDeviceId ?? input.self_device_id, null);
  if (selfDev) out.selfDeviceId = selfDev;
  if (setDefaultUpdatedAt && !out.updatedAt) {
    out.updatedAt = Date.now();
  }
  return out;
}

function normalizeDrHistory(entries, { source = 'dr-history', peerKey = null, deviceId = null, strictB64 = false } = {}) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const ts = Number(entry.ts ?? entry.timestamp ?? entry.createdAt ?? entry.created_at);
    const snap = normalizeDrSnapshot(
      entry.snapshot || entry.drState || entry.state || null,
      { setDefaultUpdatedAt: false, source, peerKey, deviceId, strictB64 }
    );
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (!snap) continue;
    const messageId = chooseString(entry.messageId ?? entry.id ?? entry.message_id, null);
    const messageKey = chooseString(entry.messageKey_b64 ?? entry.message_key_b64 ?? entry.messageKey ?? entry.message_key, null);
    const snapshotAfter = normalizeDrSnapshot(
      entry.snapshotAfter || entry.snapshot_after || entry.nextSnapshot || entry.snapshot_next || null,
      { setDefaultUpdatedAt: false, source: `${source}:after`, peerKey, deviceId, strictB64 }
    );
    out.push({
      ts,
      messageId,
      snapshot: snap,
      snapshotAfter: snapshotAfter || null,
      messageKey_b64: messageKey || null
    });
  }
  out.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.messageId && b.messageId && a.messageId !== b.messageId) {
      return a.messageId.localeCompare(b.messageId);
    }
    if (a.messageId) return 1;
    if (b.messageId) return -1;
    return 0;
  });
  return out;
}

function getStorage() {
  const local = getLocalStorageSafe();
  if (local) return local;
  const session = getSessionStorageSafe();
  if (session) return session;
  return null;
}

function ensureMap() {
  if (!(sessionStore.contactSecrets instanceof Map)) {
    const entries = sessionStore.contactSecrets && typeof sessionStore.contactSecrets.entries === 'function'
      ? Array.from(sessionStore.contactSecrets.entries())
      : [];
    sessionStore.contactSecrets = new Map(entries);
  }
  return sessionStore.contactSecrets;
}

function registerContactAliases(primary, aliases = []) {
  if (!primary) return;
  let aliasSet = contactPrimaryToAliases.get(primary);
  if (!aliasSet) {
    aliasSet = new Set();
    contactPrimaryToAliases.set(primary, aliasSet);
  }
  for (const alias of aliases) {
    if (!alias || alias === primary) continue;
    contactAliasToPrimary.set(alias, primary);
    aliasSet.add(alias);
  }
}

function clearContactAliases(primary) {
  const aliasSet = contactPrimaryToAliases.get(primary);
  if (aliasSet) {
    for (const alias of aliasSet) {
      contactAliasToPrimary.delete(alias);
    }
  }
  contactPrimaryToAliases.delete(primary);
  contactAliasToPrimary.delete(primary);
}

export function normalizePeerKeyForQuarantine({ peerAccountDigest = null, peerDeviceId = null, sourceTag = null } = {}) {
  const tag = sourceTag || 'normalizePeerKeyForQuarantine';
  const digestInput = typeof peerAccountDigest === 'string' && peerAccountDigest.includes('::')
    ? peerAccountDigest.split('::')[0]
    : peerAccountDigest;
  const digest = normalizeAccountDigest(digestInput);
  const device = normalizePeerDeviceId(peerDeviceId);
  const logInvalid = (reason) => {
    try {
      console.warn('[contact-secrets:peer-key-invalid]', JSON.stringify({
        peerAccountDigest: peerAccountDigest || null,
        peerDeviceId: peerDeviceId || null,
        digest: digest || null,
        device: device || null,
        reason,
        sourceTag: tag
      }));
    } catch { }
  };
  if (!digest) {
    logInvalid(peerAccountDigest ? 'invalid-digest' : 'missing-digest');
    return null;
  }
  if (!device || device.includes('::')) {
    logInvalid(peerDeviceId ? 'invalid-device' : 'missing-device');
    return null;
  }
  return `${digest}::${device}`;
}

function parsePeerKey(key) {
  const identity = normalizePeerIdentity(key);
  return {
    accountDigest: identity.accountDigest,
    deviceId: identity.deviceId
  };
}

function resolvePeerKey(input, { peerDeviceIdHint = null, conversationId = null } = {}) {
  const identity = normalizePeerIdentity(input);
  if (!identity.key && identity.accountDigest) {
    const hintDeviceId = normalizePeerDeviceId(peerDeviceIdHint);
    if (hintDeviceId) {
      identity.deviceId = hintDeviceId;
      identity.key = `${identity.accountDigest}::${hintDeviceId}`;
    }
  }
  const { key } = identity;
  const aliases = [];
  if (!key) return { key: null, aliases: [], identity };
  if (identity.accountDigest) aliases.push(identity.accountDigest);
  if (identity.deviceId) aliases.push(identity.deviceId);
  return { key, aliases, identity };
}

export function restoreContactSecrets() {
  if (restored) return ensureMap();
  restored = true;
  const map = ensureMap();
  const snapshot = pullLatestSnapshot({ forcePromote: true, reason: 'restore' });
  if (!snapshot) {
    debugLog('restore-skip', { reason: 'storage-empty' });
    return map;
  }
  applySnapshotPayload(map, snapshot, { replace: true, reason: 'restore' });
  try {
    sanitizeContactSecretsForDevice({ map, reason: 'restore' });
  } catch (err) {
    log({ contactSecretsSanitizeError: err?.message || err, source: 'restore' });
  }
  return map;
}

export function importContactSecretsSnapshot(snapshot, { replace = true, reason = 'import', persist = true } = {}) {
  if (!snapshot) return null;
  if (contactSecretsLocked) {
    debugLog('import-skip-locked', { reason });
    return null;
  }
  const map = ensureMap();
  const summary = applySnapshotPayload(map, snapshot, { replace, reason });
  try {
    sanitizeContactSecretsForDevice({ map, reason: `import:${reason}` });
  } catch (err) {
    log({ contactSecretsSanitizeError: err?.message || err, source: reason });
  }
  if (summary && persist) {
    try {
      persistContactSecrets();
    } catch (err) {
      log({ contactSecretsImportPersistError: err?.message || err });
    }
  }
  return summary;
}

function applySnapshotPayload(map, snapshot, { replace = true, reason = 'import' } = {}) {
  let totalEntries = 0;
  let withDrState = 0;
  let withHistory = 0;
  let withSeed = 0;
  let structuredVersion = null;
  let structuredGeneratedAt = null;
  const corruptEntries = [];
  if (!snapshot || typeof snapshot !== 'string') {
    debugLog('restore-skip', { reason: 'snapshot-empty', source: reason });
    return null;
  }
  try {
    if (replace) {
      map.clear();
      contactAliasToPrimary.clear();
      contactPrimaryToAliases.clear();
      clearCorruptContact();
    }
    const parsed = JSON.parse(snapshot);
    if (Array.isArray(parsed)) {
      debugLog('restore-skip', { reason: 'legacy-array-format', source: reason });
      return null;
    }
    const structured = parseStructuredSnapshot(parsed);
    if (!structured) {
      debugLog('restore-skip', { reason: 'unsupported-format', source: reason });
      return null;
    }
    structuredVersion = structured.version || null;
    structuredGeneratedAt = structured.generatedAt || null;
    for (const entry of structured.entries) {
      try {
        const normalized = normalizeStructuredEntry(entry, { source: reason });
        if (!normalized) {
          const rawDigest = normalizeAccountDigest(
            entry?.peerAccountDigest || entry?.peer_account_digest || entry?.accountDigest || entry?.account_digest || entry?.peerKey || entry?.peer_key || entry?.peer || null
          );
          const rawDevice = normalizePeerDeviceId(entry?.peerDeviceId || entry?.peer_device_id || null);
          logContactSecretsRestoreTrace({
            reason: 'normalize-entry-failed',
            peerAccountDigest: rawDigest || null,
            peerDeviceId: rawDevice || null,
            source: reason || null
          });
          continue;
        }
        const { peerKey, aliases, record, corruptDevices = [] } = normalized;
        const explicitPeerDeviceId = normalizePeerDeviceId(entry?.peerDeviceId || entry?.peer_device_id || null);
        if (explicitPeerDeviceId && record?.peerDeviceId && explicitPeerDeviceId !== record.peerDeviceId) {
          logContactSecretsRestoreTrace({
            reason: 'peer-device-normalized',
            peerAccountDigest: peerKey || null,
            peerDeviceId: record.peerDeviceId || null,
            source: reason || null
          });
        }
        totalEntries += 1;
        const devices = record.devices && typeof record.devices === 'object' ? record.devices : {};
        let hasDr = false;
        let hasHistory = false;
        let hasSeed = false;
        const devList = Object.keys(devices).length ? Object.values(devices) : [];
        for (const dev of devList) {
          const rk = dev?.drState?.rk_b64 || dev?.drState?.rk;
          if (!hasDr && typeof rk === 'string' && rk.length) hasDr = true;
          const historyLen = Array.isArray(dev?.drHistory) ? dev.drHistory.length : 0;
          if (historyLen > 0) {
            hasHistory = true;
          }
          if (!hasSeed && typeof dev?.drSeed === 'string' && dev.drSeed.length) hasSeed = true;
        }
        if (hasDr) withDrState += 1;
        if (hasHistory) withHistory += 1;
        if (hasSeed) withSeed += 1;
        clearCorruptContact(peerKey);
        if (Array.isArray(corruptDevices) && corruptDevices.length) {
          const parsedKey = parsePeerKey(peerKey);
          for (const info of corruptDevices) {
            const corrupt = recordCorruptContact({
              peerKey,
              peerAccountDigest: parsedKey.accountDigest || peerKey,
              peerDeviceId: info?.peerDeviceId || parsedKey.deviceId || null,
              reason: info?.reason || CORRUPT_REASON_DEFAULT,
              source: reason
            });
            if (corrupt) corruptEntries.push(corrupt);
          }
          try {
            console.warn('[contact-secrets:corrupt-import]', {
              peerKey,
              peerDeviceId: parsedKey.deviceId || null,
              corruptDevices: corruptDevices.length,
              source: reason
            });
          } catch { }
        }
        map.set(peerKey, record);
        registerContactAliases(peerKey, aliases);
        debugLog('restore-entry', {
          peerAccountDigest: peerKey,
          hasDrState: hasDr,
          historyLen: devList.reduce((acc, dev) => Math.max(acc, Array.isArray(dev?.drHistory) ? dev.drHistory.length : 0), 0),
          cursorTs: null,
          cursorId: null,
          corruptDevices: Array.isArray(corruptDevices) ? corruptDevices.length : 0,
          version: structured.version,
          source: reason
        });
      } catch (err) {
        const identity = normalizePeerIdentity({
          peerAccountDigest: entry?.peerAccountDigest ?? entry?.peer_account_digest ?? entry?.accountDigest ?? entry?.account_digest ?? entry?.peerKey ?? entry?.peer_key ?? entry?.peer ?? null,
          peerDeviceId: entry?.peerDeviceId ?? entry?.peer_device_id ?? null
        });
        const corrupt = recordCorruptContact({
          peerKey: identity.key || entry?.peerKey || entry?.peer_key || null,
          peerAccountDigest: identity.accountDigest || null,
          peerDeviceId: identity.deviceId || null,
          reason: err?.message || err,
          source: reason
        });
        if (corrupt) corruptEntries.push(corrupt);
        log({ contactSecretRestoreError: err?.message || err, source: reason, peerAccountDigest: identity.key || identity.accountDigest || null });
      }
    }
    debugLog('restore', { entries: map.size, corruptEntries: corruptEntries.length, source: reason });
    const summaryPayload = {
      entries: totalEntries,
      withDrState,
      withHistory,
      withSeed,
      bytes: snapshot.length,
      version: structuredVersion,
      generatedAt: structuredGeneratedAt,
      corruptEntries,
      parseError: null
    };
    lastRestoreSummary = { ...summaryPayload };
    lastRestoreError = null;
    log({
      contactSecretsRestoreSummary: summaryPayload
    });
    return summaryPayload;
  } catch (err) {
    log({ contactSecretRestoreError: err?.message || err, source: reason });
    lastRestoreError = err?.message || String(err);
    lastRestoreSummary = {
      entries: totalEntries,
      withDrState,
      withHistory,
      withSeed,
      bytes: snapshot.length,
      version: structuredVersion,
      generatedAt: structuredGeneratedAt,
      corruptEntries,
      parseError: lastRestoreError
    };
    return lastRestoreSummary;
  }
}

export function sanitizeContactSecretsForDevice({ map = null, deviceId = null, reason = 'sanitize' } = {}) {
  const targetMap = map || ensureMap();
  const selfDeviceId = normalizeDeviceId(deviceId || ensureDeviceId());
  if (!selfDeviceId || !(targetMap instanceof Map)) return;
  let removed = 0;
  let prunedDevices = 0;
  for (const [peerKey, record] of targetMap.entries()) {
    const peerDeviceId = normalizePeerDeviceId(record?.peerDeviceId || null);
    const devices = record?.devices && typeof record.devices === 'object' ? record.devices : {};
    const selfDeviceRecord = devices[selfDeviceId];
    const role = typeof record?.role === 'string' ? record.role.toLowerCase() : null;
    const hasRkBefore = selfDeviceRecord ? !!(selfDeviceRecord.drState?.rk_b64 || selfDeviceRecord.drState?.rk) : null;
    if (!peerDeviceId) {
      logCapped('contactShareStateChangeTrace', {
        reasonCode: 'SANITIZE_DROP',
        fromKey: peerKey,
        toKey: null,
        hasRkBefore,
        hasRkAfter: false,
        sourceTag: `sanitize:${reason}`
      }, 5);
      logContactSecretsSanitizeDropTrace({
        reason: 'missing-peer-device',
        peerKey,
        peerDeviceId: null,
        role: role || null,
        deviceId: selfDeviceId
      });
      targetMap.delete(peerKey);
      removed += 1;
      continue;
    }
    // Removed incorrect responder check (peerDeviceId !== selfDeviceId).
    // Responder role implies peer is Scanner, so IDs naturally differ.
    if (!selfDeviceRecord) {
      logCapped('contactShareStateChangeTrace', {
        reasonCode: 'SANITIZE_DROP',
        fromKey: peerKey,
        toKey: null,
        hasRkBefore,
        hasRkAfter: false,
        sourceTag: `sanitize:${reason}`
      }, 5);
      logContactSecretsSanitizeDropTrace({
        reason: 'missing-self-device-record',
        peerKey,
        peerDeviceId,
        role: role || null,
        deviceId: selfDeviceId
      });
      targetMap.delete(peerKey);
      removed += 1;
      continue;
    }
    if (Object.keys(devices).length > 1) {
      record.devices = { [selfDeviceId]: selfDeviceRecord };
      prunedDevices += 1;
    }
    record.peerDeviceId = peerDeviceId;
  }
  if (removed || prunedDevices) {
    log({ contactSecretsSanitized: { removed, prunedDevices, reason, deviceId: selfDeviceId } });
  }
}

export function persistContactSecrets() {
  const map = ensureMap();
  const storage = getStorage();
  if (!storage) return;
  try {
    const { payload, summary, checksum } = serializeContactSecretsMap(map);
    // [STRICT SINGLE PATH] Do not write to global base key, only namespaced key.
    const storageKeys = getContactSecretsStorageKeys({}, { includeBase: false });
    const metaKeys = getContactSecretsMetaKeys({}, { includeBase: false });
    const checksumKeys = getContactSecretsChecksumKeys({}, { includeBase: false });
    storageKeys.forEach((key) => {
      try { storage.setItem(key, payload); } catch { }
    });
    let sessionBytes = null;
    const sessionStore = getSessionStorageSafe();
    if (sessionStore) {
      storageKeys.forEach((key) => {
        try {
          sessionStore.setItem(key, payload);
          sessionBytes = payload.length;
        } catch { }
      });
    }
    if (typeof window !== 'undefined') {
      try {
        if (!window.__LOGIN_SEED_LOCALSTORAGE || typeof window.__LOGIN_SEED_LOCALSTORAGE !== 'object') {
          window.__LOGIN_SEED_LOCALSTORAGE = {};
        }
        storageKeys.forEach((key) => {
          window.__LOGIN_SEED_LOCALSTORAGE[key] = payload;
        });
      } catch { }
    }
    const metaRecord = {
      version: summary.version,
      ts: summary.generatedAt,
      entries: summary.entries,
      withDrState: summary.withDrState,
      withoutDrState: summary.withoutDrState,
      withHistory: summary.withHistory,
      maxHistory: summary.maxHistory,
      withSeed: summary.withSeed,
      bytes: summary.bytes
    };
    const metaJson = JSON.stringify(metaRecord);
    for (const key of metaKeys) {
      try { storage.setItem(key, metaJson); } catch { }
    }
    if (sessionStore) {
      for (const key of metaKeys) {
        try { sessionStore.setItem(key, metaJson); } catch { }
      }
    }
    const localStore = getLocalStorageSafe();
    if (localStore) {
      for (const key of metaKeys) {
        try { localStore.setItem(key, metaJson); } catch { }
      }
    }
    if (checksum) {
      const checksumRecord = { checksum, algorithm: 'sum32', ts: summary.generatedAt };
      const checksumJson = JSON.stringify(checksumRecord);
      for (const key of checksumKeys) {
        try { storage.setItem(key, checksumJson); } catch { }
      }
      if (sessionStore) {
        for (const key of checksumKeys) {
          try { sessionStore.setItem(key, checksumJson); } catch { }
        }
      }
      if (localStore) {
        for (const key of checksumKeys) {
          try { localStore.setItem(key, checksumJson); } catch { }
        }
      }
    }
    debugLog('persist', {
      entries: summary.entries,
      bytes: summary.bytes,
      sessionBytes,
      version: summary.version,
      withDrState: summary.withDrState,
      withHistory: summary.withHistory,
      withSeed: summary.withSeed
    });
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        const evt = new CustomEvent('contactSecrets:persisted', {
          detail: {
            payload,
            summary,
            checksum,
            snapshotVersion: summary.version || CONTACT_SECRETS_VERSION,
            generatedAt: summary.generatedAt || Date.now()
          }
        });
        window.dispatchEvent(evt);
      } catch (err) {
        log({ contactSecretsPersistEventError: err?.message || err });
      }
    }
  } catch (err) {
    log({ contactSecretPersistError: err?.message || err });
  }
}

function createEmptyContactSecret() {
  return {
    peerDeviceId: null,
    role: null,
    conversationToken: null,
    conversationId: null,
    conversationDrInit: null,
    devices: {}, // deviceId -> { drState, drSeed, drHistory, drHistoryCursorTs, drHistoryCursorId, updatedAt }
    isHidden: false,
    updatedAt: null,
    // Profile fields (synced with contact-core-store)
    nickname: null,
    avatar: null
  };
}

function cloneContactSecretRecord(existing) {
  if (!existing) return createEmptyContactSecret();
  const devices = {};
  if (existing.devices && typeof existing.devices === 'object') {
    for (const [devId, devVal] of Object.entries(existing.devices)) {
      if (!devId) continue;
      const normalizedState = devVal?.drState
        ? normalizeDrSnapshot(devVal.drState, { setDefaultUpdatedAt: false, source: 'clone-record', deviceId: devId, strictB64: true })
        : null;
      devices[devId] = {
        drState: normalizedState,
        drSeed: devVal?.drSeed || null,
        drHistory: Array.isArray(devVal?.drHistory) ? devVal.drHistory.slice() : [],
        drHistoryCursorTs: Number.isFinite(devVal?.drHistoryCursorTs) ? devVal.drHistoryCursorTs : null,
        drHistoryCursorId: devVal?.drHistoryCursorId || null,
        updatedAt: Number.isFinite(devVal?.updatedAt) ? devVal.updatedAt : null
      };
    }
  }
  return {
    peerDeviceId: existing.peerDeviceId || null,
    role: existing.role || null,
    conversationToken: existing.conversationToken || null,
    conversationId: existing.conversationId || null,
    conversationDrInit: existing.conversationDrInit || null,
    devices,
    isHidden: !!existing.isHidden,
    updatedAt: Number.isFinite(existing.updatedAt) ? existing.updatedAt : null
  };
}

function ensureDeviceRecord(record, deviceId, { create = false } = {}) {
  if (!record || !deviceId) return null;
  if (!record.devices || typeof record.devices !== 'object') record.devices = {};
  if (!record.devices[deviceId] && create) {
    record.devices[deviceId] = {
      drState: null,
      drSeed: null,
      drHistory: [],
      drHistoryCursorTs: null,
      drHistoryCursorId: null,
      updatedAt: null
    };
  }
  return record.devices[deviceId] || null;
}

function selectDeviceRecord(record, deviceId = null) {
  if (!record || !record.devices || typeof record.devices !== 'object') return { deviceId: null, deviceRecord: null };
  if (deviceId && record.devices[deviceId]) return { deviceId, deviceRecord: record.devices[deviceId] };
  const keys = Object.keys(record.devices);
  if (keys.length === 0) return { deviceId: null, deviceRecord: null };
  return { deviceId: keys[0], deviceRecord: record.devices[keys[0]] };
}

function derivePeerIdentityForEntry(peerKey, record = {}) {
  const parsed = parsePeerKey(peerKey);
  const peerAccountDigest = parsed.accountDigest || normalizeAccountDigest(peerKey);
  const peerDeviceId = normalizePeerDeviceId(
    record?.peerDeviceId
    || parsed.deviceId
    || null
  );
  return {
    peerAccountDigest: peerAccountDigest || null,
    peerDeviceId: peerDeviceId || null
  };
}

function buildStructuredEntry(peerAccountDigest, record) {
  const identity = derivePeerIdentityForEntry(peerAccountDigest, record);
  if (!identity.peerAccountDigest) return null;
  const devicesObj = {};
  const sourceDevices = record.devices && typeof record.devices === 'object' ? record.devices : {};
  const deviceEntries = Object.keys(sourceDevices);
  if (!deviceEntries.length) return null;
  for (const devId of deviceEntries) {
    if (!devId) continue;
    const dev = sourceDevices[devId] || {};
    const normalizedState = dev?.drState
      ? normalizeDrSnapshot(dev.drState, { setDefaultUpdatedAt: false, source: 'serialize', peerKey: identity.key, deviceId: devId, strictB64: true })
      : null;
    if (normalizedState && record?.devices?.[devId]) {
      record.devices[devId].drState = normalizedState;
    }
    devicesObj[devId] = {
      drState: normalizedState,
      drSeed: dev.drSeed || null,
      drHistory: normalizeDrHistory(dev.drHistory, { source: 'serialize-history', peerKey: identity.key, deviceId: devId, strictB64: true }),
      drHistoryCursorTs: Number.isFinite(dev.drHistoryCursorTs) ? dev.drHistoryCursorTs : null,
      drHistoryCursorId: dev.drHistoryCursorId || null,
      updatedAt: Number.isFinite(dev.updatedAt) ? dev.updatedAt : null
    };
  }
  const peerDeviceId = identity.peerDeviceId || record.peerDeviceId || null;
  if (!peerDeviceId) return null;
  return {
    peerAccountDigest: identity.peerAccountDigest || null,
    peerDeviceId,
    role: record.role || null,
    conversation: {
      token: record.conversationToken || null,
      id: record.conversationId || null,
      drInit: record.conversationDrInit || null,
      peerDeviceId
    },
    devices: devicesObj,
    // Profile fields
    nickname: record.nickname || null,
    avatar: record.avatar || null,
    meta: {
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : null
    }
  };
}

function serializeContactSecretsMap(map) {
  const entries = [];
  const summary = {
    entries: 0,
    withDrState: 0,
    withHistory: 0,
    withoutDrState: 0,
    withSeed: 0,
    maxHistory: 0,
    bytes: 0,
    version: CONTACT_SECRETS_VERSION,
    generatedAt: Date.now(),
    corruptSkipped: 0
  };

  for (const [peerKey, record] of map.entries()) {
    try {
      if (!peerKey) continue;
      const entry = buildStructuredEntry(peerKey, record);
      if (!entry) continue;

      // Validate DR state integrity before serialization
      // This ensures we don't persist corrupted state that would block restoration
      const devices = record.devices && typeof record.devices === 'object' ? Object.values(record.devices) : [];
      for (const dev of devices) {
        if (dev?.drState) {
          // Will throw if critical keys (like rk) are missing
          normalizeDrSnapshot(
            dev.drState,
            { setDefaultUpdatedAt: false, source: 'serialize', peerKey: entry.peerAccountDigest, deviceId: dev.peerDeviceId || record.peerDeviceId, strictB64: true }
          );
        }
      }

      entries.push(entry);
      summary.entries += 1;

      // Update stats based on the successfully serialized entry
      let hasDr = false;
      let hasHistory = false;
      let hasSeed = false;
      const devList = record.devices && typeof record.devices === 'object' ? Object.values(record.devices) : [];

      if (devList.length > 0) {
        for (const dev of devList) {
          if (!hasDr && (dev?.drState?.rk_b64 || dev?.drState?.rk)) {
            hasDr = true;
          }
          const historyLen = Array.isArray(dev?.drHistory) ? dev.drHistory.length : 0;
          if (historyLen > 0) {
            hasHistory = true;
            if (historyLen > summary.maxHistory) summary.maxHistory = historyLen;
          }
          if (!hasSeed && typeof dev?.drSeed === 'string' && dev.drSeed.length) {
            hasSeed = true;
          }
        }
        if (hasDr) summary.withDrState += 1;
        if (hasHistory) summary.withHistory += 1;
        if (hasSeed) summary.withSeed += 1;
      }
    } catch (err) {
      summary.corruptSkipped += 1;
      try {
        console.warn('[contact-secrets] serialization skipped corrupt entry', {
          peerKey,
          reason: err?.message || err
        });
        // Optionally record as corrupt so it can be inspected
        recordCorruptContact({
          peerKey,
          reason: `serialize-fail: ${err?.message || err}`,
          source: 'serializeContactSecretsMap'
        });
      } catch { }
    }
  }

  summary.withoutDrState = Math.max(0, summary.entries - summary.withDrState);
  const generatedAt = summary.generatedAt;
  const payloadObj = {
    v: CONTACT_SECRETS_VERSION,
    generatedAt,
    entries
  };
  const payload = JSON.stringify(payloadObj);
  summary.bytes = payload.length;
  summary.generatedAt = generatedAt;
  summary.version = CONTACT_SECRETS_VERSION;
  const checksum = basicChecksum(payload);
  return { payload, summary, checksum };
}

export function buildContactSecretsSnapshot() {
  const map = ensureMap();
  return serializeContactSecretsMap(map);
}

export function buildPartialContactSecretsSnapshot(peerAccountDigest, { peerDeviceId = null } = {}) {
  const map = ensureMap();
  const { key } = resolvePeerKey(peerAccountDigest, { peerDeviceIdHint: peerDeviceId });
  if (!key || !map.has(key)) return null;
  const record = map.get(key);
  const entry = buildStructuredEntry(key, record);
  if (!entry) return null;

  const payloadObj = {
    v: CONTACT_SECRETS_VERSION,
    generatedAt: Date.now(),
    entries: [entry]
  };
  return JSON.stringify(payloadObj);
}

/**
 * Build contact-secrets snapshot directly from a drState snapshot object.
 * This bypasses the contact-secrets map and uses the provided state directly.
 * Used when we need to vault the current in-memory state before persistDrSnapshot may have updated the map.
 */
export function buildContactSecretsSnapshotFromDrState(peerAccountDigest, {
  peerDeviceId = null,
  drStateSnapshot = null,
  role = null,
  conversationToken = null,
  conversationId = null
} = {}) {
  if (!peerAccountDigest || !peerDeviceId || !drStateSnapshot) return null;

  const normalizedDigest = normalizeAccountDigest(peerAccountDigest);
  if (!normalizedDigest) return null;

  const normalizedPeerDeviceId = normalizePeerDeviceId(peerDeviceId);
  if (!normalizedPeerDeviceId) return null;

  const selfDeviceId = ensureDeviceId();
  if (!selfDeviceId) return null;

  // Normalize the drState snapshot
  const normalizedState = normalizeDrSnapshot(drStateSnapshot, {
    setDefaultUpdatedAt: true,
    source: 'buildFromDrState',
    peerKey: `${normalizedDigest}::${normalizedPeerDeviceId}`,
    deviceId: selfDeviceId,
    strictB64: true
  });

  if (!normalizedState) return null;

  // Build the entry structure
  const entry = {
    peerAccountDigest: normalizedDigest,
    peerDeviceId: normalizedPeerDeviceId,
    role: role || normalizedState?.role || null,
    conversation: {
      token: conversationToken || null,
      id: conversationId || null,
      drInit: null,
      peerDeviceId: normalizedPeerDeviceId
    },
    devices: {
      [selfDeviceId]: {
        drState: normalizedState,
        drSeed: null,
        drHistory: [],
        drHistoryCursorTs: null,
        drHistoryCursorId: null,
        updatedAt: Date.now()
      }
    },
    meta: {
      updatedAt: Date.now()
    }
  };

  const payloadObj = {
    v: CONTACT_SECRETS_VERSION,
    generatedAt: Date.now(),
    entries: [entry]
  };

  return JSON.stringify(payloadObj);
}

export async function encryptContactSecretPayload(payload, mkRaw) {
  const plain = encoder.encode(payload);
  const { cipherBuf, iv, hkdfSalt } = await encryptWithMK(plain, mkRaw, SNAPSHOT_INFO_TAG);
  return {
    v: 1,
    aead: 'aes-256-gcm',
    info: SNAPSHOT_INFO_TAG,
    salt_b64: b64(hkdfSalt),
    iv_b64: b64(iv),
    ct_b64: b64(cipherBuf)
  };
}

export async function decryptContactSecretPayload(envelope, mkRaw) {
  if (!envelope || envelope.aead !== 'aes-256-gcm') {
    return { ok: false, corrupt: true, reason: 'invalid contact-secrets backup envelope' };
  }
  try {
    const normalized = assertEnvelopeStrict(envelope, { allowInfoTags: SNAPSHOT_ALLOWED_INFO_TAGS });
    const salt = b64u8(normalized.salt_b64);
    const iv = b64u8(normalized.iv_b64);
    const ct = b64u8(normalized.ct_b64);
    const plain = await decryptWithMK(ct, mkRaw, salt, iv, normalized.info);
    return { ok: true, snapshot: decoder.decode(plain) };
  } catch (err) {
    return { ok: false, corrupt: true, reason: err?.message || 'decrypt failed' };
  }
}

function normalizeStructuredEntry(entry, { source = 'normalize-entry' } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const peerAccountDigest = normalizeAccountDigest(entry.peerAccountDigest || null);
  if (!peerAccountDigest) return null;
  const conversation = entry.conversation || {};
  const explicitPeerDeviceId = normalizePeerDeviceId(entry.peerDeviceId || null);
  const devices = entry.devices && typeof entry.devices === 'object' ? entry.devices : null;
  const deviceKeys = devices ? Object.keys(devices).map((k) => normalizePeerDeviceId(k)).filter(Boolean) : [];
  const peerDeviceId = explicitPeerDeviceId || (deviceKeys.length === 1 ? deviceKeys[0] : null);
  if (!peerDeviceId) return null;
  const role = normalizeContactRole(entry.role, {
    source,
    peerAccountDigest,
    peerDeviceId,
    logChange: true
  });
  const identity = normalizePeerIdentity({
    peerAccountDigest,
    peerDeviceId
  });
  if (!identity.key) return null;
  const record = createEmptyContactSecret();
  record.peerDeviceId = identity.deviceId || peerDeviceId || null;
  record.role = role || null;
  const corruptDevices = [];

  record.conversationToken = normalizeOptionalString(conversation.token) || null;
  record.conversationId = normalizeOptionalString(conversation.id) || null;
  if (Object.prototype.hasOwnProperty.call(conversation, 'drInit')) {
    record.conversationDrInit = conversation.drInit || null;
  }
  if (!devices || !deviceKeys.length) return null;
  for (const [devIdRaw, devVal] of Object.entries(devices)) {
    const devId = normalizeDeviceId(devIdRaw);
    if (!devId) continue;
    const slot = ensureDeviceRecord(record, devId, { create: true });
    let deviceCorrupt = false;
    const ctx = { source, peerKey: identity.key, deviceId: devId };
    if (Object.prototype.hasOwnProperty.call(devVal, 'drState')) {
      try {
        if (devVal.drState) validateDrSnapshotInput(devVal.drState, ctx);
        const normalizedState = devVal.drState
          ? normalizeDrSnapshot(devVal.drState, { setDefaultUpdatedAt: false, source, peerKey: identity.key, deviceId: devId, strictB64: true })
          : null;
        if (normalizedState) slot.drState = normalizedState;
      } catch (err) {
        deviceCorrupt = true;
        slot.drState = null;
        slot.drHistory = [];
        slot.drHistoryCursorTs = null;
        slot.drHistoryCursorId = null;
        corruptDevices.push({ peerKey: identity.key, peerDeviceId: devId, reason: err?.message || err });
      }
    }
    if (Object.prototype.hasOwnProperty.call(devVal, 'drSeed')) {
      slot.drSeed = normalizeOptionalString(devVal.drSeed) || null;
    }
    if (!deviceCorrupt && Object.prototype.hasOwnProperty.call(devVal, 'drHistory')) {
      try {
        validateDrHistoryInput(devVal.drHistory, ctx);
        slot.drHistory = normalizeDrHistory(devVal.drHistory, { source, peerKey: identity.key, deviceId: devId, strictB64: true });
      } catch (err) {
        deviceCorrupt = true;
        slot.drHistory = [];
        slot.drHistoryCursorTs = null;
        slot.drHistoryCursorId = null;
        corruptDevices.push({ peerKey: identity.key, peerDeviceId: devId, reason: err?.message || err });
      }
    }
    const cursorTsRaw = devVal.drHistoryCursorTs ?? devVal.cursorTs ?? devVal?.dr?.cursor?.ts;
    const cursorIdRaw = devVal.drHistoryCursorId ?? devVal.cursorId ?? devVal?.dr?.cursor?.id;
    if (!deviceCorrupt && cursorTsRaw !== undefined) {
      const cursorTs = Number(cursorTsRaw);
      slot.drHistoryCursorTs = Number.isFinite(cursorTs) ? cursorTs : null;
    }
    if (!deviceCorrupt && cursorIdRaw !== undefined) {
      slot.drHistoryCursorId = normalizeOptionalString(cursorIdRaw) || null;
    }
    if (Object.prototype.hasOwnProperty.call(devVal, 'updatedAt')) {
      const updated = Number(devVal.updatedAt);
      slot.updatedAt = Number.isFinite(updated) ? updated : null;
    }
  }

  const meta = entry.meta || {};
  if (Object.prototype.hasOwnProperty.call(meta, 'updatedAt')) {
    const updated = Number(meta.updatedAt);
    record.updatedAt = Number.isFinite(updated) ? updated : null;
  }

  // Profile fields
  if (Object.prototype.hasOwnProperty.call(entry, 'nickname')) {
    record.nickname = normalizeOptionalString(entry.nickname) || null;
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'avatar')) {
    record.avatar = normalizeOptionalString(entry.avatar) || null;
  }

  const aliases = [];
  if (identity.accountDigest) aliases.push(identity.accountDigest);
  if (identity.deviceId) aliases.push(identity.deviceId);

  return { peerKey: identity.key, aliases, record, corruptDevices };
}

function parseStructuredSnapshot(payloadObj) {
  if (!payloadObj || typeof payloadObj !== 'object') return null;
  const entries = Array.isArray(payloadObj.entries) ? payloadObj.entries : [];
  const versionRaw = payloadObj.v ?? payloadObj.version ?? null;
  const version = Number.isFinite(Number(versionRaw)) ? Number(versionRaw) : CONTACT_SECRETS_VERSION;
  const generatedAt = Number.isFinite(Number(payloadObj.generatedAt ?? payloadObj.ts))
    ? Number(payloadObj.generatedAt ?? payloadObj.ts)
    : null;
  return {
    version,
    generatedAt,
    entries
  };
}

function normalizeContactSecretUpdate(update = {}) {
  const structured = {
    peerDeviceId: { has: false, value: null },
    deviceId: { has: false, value: null },
    role: { has: false, value: null },
    conversation: {
      token: { has: false, value: null },
      id: { has: false, value: null },
      drInit: { has: false, value: null },
      peerDeviceId: { has: false, value: null }
    },
    dr: {
      state: { has: false, value: null },
      seed: { has: false, value: null },
      history: { has: false, value: null },
      cursorTs: { has: false, value: null },
      cursorId: { has: false, value: null }
    },
    meta: {
      updatedAt: { has: false, value: null }
    },
    // Profile fields
    profile: {
      nickname: { has: false, value: null },
      avatar: { has: false, value: null }
    },
    debugSource: update?.__debugSource || update?.source || update?.meta?.source || null
  };

  const applyString = (holder, key, raw) => {
    if (raw === undefined) return;
    holder[key] = { has: true, value: normalizeOptionalString(raw) ?? null };
  };

  const applyTimestamp = (holder, key, raw) => {
    if (raw === undefined) return;
    if (raw === null) {
      holder[key] = { has: true, value: null };
      return;
    }
    const n = Number(raw);
    holder[key] = { has: true, value: Number.isFinite(n) ? Math.floor(n) : null };
  };

  const applyDeviceId = (raw) => {
    if (raw === undefined) return;
    structured.deviceId = { has: true, value: normalizeDeviceId(raw) };
  };

  const applyPeerDeviceId = (raw) => {
    if (raw === undefined) return;
    structured.peerDeviceId = { has: true, value: normalizePeerDeviceId(raw) };
  };

  const applyRole = (raw) => {
    if (raw === undefined) return;
    structured.role = { has: true, value: normalizeContactRole(raw) };
  };

  function applyDrState(raw) {
    if (raw === undefined) return;
    if (raw === null) {
      structured.dr.state = { has: true, value: null };
      return;
    }
    const normalized = normalizeDrSnapshot(raw, { setDefaultUpdatedAt: true, source: structured.debugSource || 'setContactSecret', strictB64: true });
    structured.dr.state = { has: true, value: normalized };
  }

  function applyDrHistory(raw) {
    if (raw === undefined) return;
    if (raw === null) {
      structured.dr.history = { has: true, value: [] };
      return;
    }
    structured.dr.history = { has: true, value: normalizeDrHistory(raw, { source: structured.debugSource || 'setContactSecret', strictB64: true }) };
  }

  function applyDrSeed(raw) {
    if (raw === undefined) return;
    structured.dr.seed = { has: true, value: normalizeOptionalString(raw) ?? null };
  }

  // New structured payload
  if (update?.conversation && typeof update.conversation === 'object') {
    applyString(structured.conversation, 'token', update.conversation.token);
    applyString(structured.conversation, 'id', update.conversation.id);
    if (Object.prototype.hasOwnProperty.call(update.conversation, 'peerDeviceId')) {
      const peerDev = update.conversation.peerDeviceId;
      structured.conversation.peerDeviceId = { has: true, value: normalizePeerDeviceId(peerDev) };
    }
    if (Object.prototype.hasOwnProperty.call(update.conversation, 'drInit')) {
      structured.conversation.drInit = { has: true, value: update.conversation.drInit || null };
    }
  }
  if (Object.prototype.hasOwnProperty.call(update, 'deviceId')) {
    applyDeviceId(update.deviceId);
  } else if (Object.prototype.hasOwnProperty.call(update, 'device_id')) {
    applyDeviceId(update.device_id);
  } else if (update?.device && Object.prototype.hasOwnProperty.call(update.device, 'id')) {
    applyDeviceId(update.device.id);
  }
  if (update?.dr && typeof update.dr === 'object') {
    if (Object.prototype.hasOwnProperty.call(update.dr, 'state')) applyDrState(update.dr.state);
    if (Object.prototype.hasOwnProperty.call(update.dr, 'seed')) applyDrSeed(update.dr.seed);
    if (Object.prototype.hasOwnProperty.call(update.dr, 'history')) applyDrHistory(update.dr.history);
    if (update.dr.cursor && typeof update.dr.cursor === 'object') {
      if (Object.prototype.hasOwnProperty.call(update.dr.cursor, 'ts')) applyTimestamp(structured.dr, 'cursorTs', update.dr.cursor.ts);
      if (Object.prototype.hasOwnProperty.call(update.dr.cursor, 'id')) applyString(structured.dr, 'cursorId', update.dr.cursor.id);
    } else {
      if (Object.prototype.hasOwnProperty.call(update.dr, 'cursorTs')) applyTimestamp(structured.dr, 'cursorTs', update.dr.cursorTs);
      if (Object.prototype.hasOwnProperty.call(update.dr, 'cursorId')) applyString(structured.dr, 'cursorId', update.dr.cursorId);
    }
  }
  if (update?.meta && typeof update.meta === 'object') {
    if (Object.prototype.hasOwnProperty.call(update.meta, 'updatedAt')) {
      applyTimestamp(structured.meta, 'updatedAt', update.meta.updatedAt);
    }
    if (typeof update.meta.source === 'string') {
      structured.debugSource = update.meta.source;
    }
  }

  // Legacy invite fields removed
  applyString(structured.conversation, 'token', update.conversationToken);
  applyString(structured.conversation, 'id', update.conversationId);
  applyPeerDeviceId(update.peerDeviceId);
  applyRole(update.role);
  if (Object.prototype.hasOwnProperty.call(update, 'conversationDrInit')) {
    structured.conversation.drInit = { has: true, value: update.conversationDrInit || null };
  }
  if (Object.prototype.hasOwnProperty.call(update, 'drState')) applyDrState(update.drState);
  if (Object.prototype.hasOwnProperty.call(update, 'drSeed')) applyDrSeed(update.drSeed);
  if (Object.prototype.hasOwnProperty.call(update, 'drHistory')) applyDrHistory(update.drHistory);
  if (Object.prototype.hasOwnProperty.call(update, 'drHistoryCursorTs')) {
    applyTimestamp(structured.dr, 'cursorTs', update.drHistoryCursorTs);
  }
  if (Object.prototype.hasOwnProperty.call(update, 'drHistoryCursorId')) {
    applyString(structured.dr, 'cursorId', update.drHistoryCursorId);
  }
  if (Object.prototype.hasOwnProperty.call(update, 'deviceId')) applyDeviceId(update.deviceId);
  if (Object.prototype.hasOwnProperty.call(update, 'device_id')) applyDeviceId(update.device_id);

  // Profile fields
  if (Object.prototype.hasOwnProperty.call(update, 'nickname')) {
    applyString(structured.profile, 'nickname', update.nickname);
  }
  if (Object.prototype.hasOwnProperty.call(update, 'avatar')) {
    applyString(structured.profile, 'avatar', update.avatar);
  }

  return structured;
}

export function setContactSecret(peerAccountDigest, opts = {}) {
  if (contactSecretsLocked) {
    const identity = normalizePeerIdentity(peerAccountDigest);
    debugLog('set-skip-locked', { peerAccountDigest: identity.key || null, source: opts?.__debugSource || null });
    return;
  }
  const structured = normalizeContactSecretUpdate(opts);
  const sourceTag = structured.debugSource || opts?.__debugSource || 'unknown';
  const peerDeviceIdHint =
    (structured.peerDeviceId.has ? structured.peerDeviceId.value : null)
    || normalizePeerDeviceId(opts?.peerDeviceId ?? null);
  const conversationIdHint =
    (structured.conversation.id.has ? structured.conversation.id.value : null)
    || opts?.conversationId
    || opts?.conversation_id
    || opts?.conversation?.id
    || opts?.conversation?.conversation_id
    || null;
  const { key, aliases, identity } = resolvePeerKey(peerAccountDigest, { peerDeviceIdHint, conversationId: conversationIdHint });
  if (!key) return;
  const parsedKey = parsePeerKey(key);
  const desiredPeerDeviceId = (structured.peerDeviceId.has ? structured.peerDeviceId.value : null) || peerDeviceIdHint || null;
  const shouldMigratePeerDevice =
    desiredPeerDeviceId
    && parsedKey.accountDigest
    && parsedKey.deviceId
    && desiredPeerDeviceId !== parsedKey.deviceId;
  const finalKey = shouldMigratePeerDevice
    ? `${parsedKey.accountDigest}::${desiredPeerDeviceId}`
    : key;
  const map = ensureMap();
  const existing = map.get(key) || null;
  const existingAtFinal = finalKey !== key ? (map.get(finalKey) || null) : null;
  const base = existingAtFinal || existing;
  const next = cloneContactSecretRecord(base);
  const mergeMissingFields = (source) => {
    if (!source || typeof source !== 'object') return;
    if (!next.role && source.role) next.role = source.role;
    if (!next.conversationToken && source.conversationToken) next.conversationToken = source.conversationToken;
    if (!next.conversationId && source.conversationId) next.conversationId = source.conversationId;
    if (!next.conversationDrInit && source.conversationDrInit) next.conversationDrInit = source.conversationDrInit;
    if (!next.peerDeviceId && source.peerDeviceId) next.peerDeviceId = source.peerDeviceId;
    if (!next.updatedAt && source.updatedAt) next.updatedAt = source.updatedAt;
    if (source.devices && typeof source.devices === 'object') {
      for (const [devId, devVal] of Object.entries(source.devices)) {
        if (!devId || !devVal || typeof devVal !== 'object') continue;
        const target = ensureDeviceRecord(next, devId, { create: true });
        if (!target) continue;
        if (!target.drState && devVal.drState) target.drState = devVal.drState;
        if (!target.drSeed && devVal.drSeed) target.drSeed = devVal.drSeed;
        if (!Array.isArray(target.drHistory) || !target.drHistory.length) {
          target.drHistory = Array.isArray(devVal.drHistory) ? devVal.drHistory.slice() : [];
        }
        if (!target.drHistoryCursorTs && devVal.drHistoryCursorTs) target.drHistoryCursorTs = devVal.drHistoryCursorTs;
        if (!target.drHistoryCursorId && devVal.drHistoryCursorId) target.drHistoryCursorId = devVal.drHistoryCursorId;
        if (!target.updatedAt && devVal.updatedAt) target.updatedAt = devVal.updatedAt;
      }
    }
  };
  if (existingAtFinal && existing && existingAtFinal !== existing) {
    mergeMissingFields(cloneContactSecretRecord(existing));
  }
  if (identity?.deviceId) {
    next.peerDeviceId = identity.deviceId;
  } else if (peerDeviceIdHint) {
    next.peerDeviceId = peerDeviceIdHint;
  }
  const resolvedDeviceId =
    (structured.deviceId.has ? structured.deviceId.value : null)
    || opts.deviceId
    || ensureDeviceId();
  const deviceRecord = ensureDeviceRecord(next, resolvedDeviceId, { create: true });
  let migrateTrace = null;
  if (finalKey !== key) {
    const beforeRecord = existing;
    const beforeSelected = beforeRecord && resolvedDeviceId
      ? selectDeviceRecord(beforeRecord, resolvedDeviceId)
      : { deviceId: null, deviceRecord: null };
    const beforeDeviceRecord = beforeSelected.deviceId === resolvedDeviceId ? beforeSelected.deviceRecord : null;
    migrateTrace = {
      reasonCode: 'MIGRATE_PEERKEY',
      fromKey: key,
      toKey: finalKey,
      hasRkBefore: beforeDeviceRecord ? !!(beforeDeviceRecord.drState?.rk_b64 || beforeDeviceRecord.drState?.rk) : null,
      hasRkAfter: null,
      sourceTag
    };
  }

  if (structured.conversation.token.has) next.conversationToken = structured.conversation.token.value;
  if (structured.conversation.id.has) next.conversationId = structured.conversation.id.value;
  if (structured.conversation.drInit.has) next.conversationDrInit = structured.conversation.drInit.value;
  // 禁止用 conversation.peerDeviceId 覆寫 peer 裝置，僅接受明確的 peerDeviceId 欄位。
  if (structured.role?.has) {
    next.role = structured.role.value || null;
  } else if (typeof opts.role === 'string') {
    next.role = opts.role.toLowerCase();
  }
  if (structured.dr.state.has) deviceRecord.drState = structured.dr.state.value;
  if (structured.dr.seed.has) deviceRecord.drSeed = structured.dr.seed.value;
  if (structured.dr.history.has) deviceRecord.drHistory = structured.dr.history.value || [];
  if (structured.dr.cursorTs.has) deviceRecord.drHistoryCursorTs = structured.dr.cursorTs.value;
  if (structured.dr.cursorId.has) deviceRecord.drHistoryCursorId = structured.dr.cursorId.value;

  // Profile fields
  if (structured.profile.nickname.has) next.nickname = structured.profile.nickname.value;
  if (structured.profile.avatar.has) next.avatar = structured.profile.avatar.value;

  if (structured.meta.updatedAt.has) {
    const ts = structured.meta.updatedAt.value ?? null;
    next.updatedAt = ts;
    deviceRecord.updatedAt = ts;
  } else {
    const ts = Date.now();
    next.updatedAt = ts;
    deviceRecord.updatedAt = ts;
  }

  const deviceEntries = next.devices && typeof next.devices === 'object' ? Object.entries(next.devices) : [];
  for (const [devId, devVal] of deviceEntries) {
    if (!devVal || !devVal.drState) continue;
    devVal.drState = normalizeDrSnapshot(devVal.drState, {
      setDefaultUpdatedAt: false,
      source: sourceTag,
      peerKey: finalKey,
      deviceId: devId,
      strictB64: true
    });
  }

  map.set(finalKey, next);
  if (finalKey !== key) {
    map.delete(key);
    clearContactAliases(key);
  }
  const aliasList = finalKey === key ? aliases : Array.from(new Set([...(aliases || []), key]));
  registerContactAliases(finalKey, aliasList);
  persistContactSecrets();
  logContactSecretWriteTrace({
    peerKey: finalKey,
    prevPeerKey: finalKey !== key ? key : null,
    peerDeviceId: next.peerDeviceId || identity?.deviceId || null,
    deviceId: resolvedDeviceId,
    role: next.role || null,
    hasDrState: !!deviceRecord.drState,
    hasRk: !!(deviceRecord.drState?.rk_b64 || deviceRecord.drState?.rk),
    conversationId: next.conversationId || null,
    hasToken: !!next.conversationToken,
    source: sourceTag,
    migrated: finalKey !== key
  });
  if (migrateTrace) {
    migrateTrace.hasRkAfter = !!(deviceRecord?.drState?.rk_b64 || deviceRecord?.drState?.rk);
    logCapped('contactShareStateChangeTrace', migrateTrace, 5);
  }
  debugLog('set', {
    peerAccountDigest: normalizeAccountDigest(key) || key || null,
    peerDeviceId: next.peerDeviceId || identity?.deviceId || null,
    role: next.role || null,
    deviceId: resolvedDeviceId,
    hasDrState: !!deviceRecord.drState,
    drUpdatedAt: deviceRecord.drState?.updatedAt || null,
    historyLen: Array.isArray(deviceRecord.drHistory) ? deviceRecord.drHistory.length : 0,
    cursorTs: deviceRecord.drHistoryCursorTs || null,
    cursorId: deviceRecord.drHistoryCursorId || null,
    source: sourceTag
  });
}

export function deleteContactSecret(peerAccountDigest) {
  const { key } = resolvePeerKey(peerAccountDigest);
  if (!key) return;
  const map = ensureMap();
  if (map.delete(key)) {
    clearContactAliases(key);
    persistContactSecrets();
  }
}

/**
 * Update contact profile fields (nickname, avatar) only.
 * This is a lightweight update that doesn't touch DR state.
 */
export function updateContactProfile(peerAccountDigest, { nickname, avatar, peerDeviceId } = {}) {
  const peerDeviceIdHint = normalizePeerDeviceId(peerDeviceId || null);
  const { key } = resolvePeerKey(peerAccountDigest, { peerDeviceIdHint });
  if (!key) return null;
  const map = ensureMap();
  const record = map.get(key);
  if (!record) return null;
  let changed = false;
  if (nickname !== undefined && record.nickname !== nickname) {
    record.nickname = nickname || null;
    changed = true;
  }
  if (avatar !== undefined && record.avatar !== avatar) {
    record.avatar = avatar || null;
    changed = true;
  }
  if (changed) {
    record.updatedAt = Date.now();
    persistContactSecrets();
  }
  return { peerKey: key, nickname: record.nickname, avatar: record.avatar };
}

export function getContactSecret(peerAccountDigest, opts = {}) {
  const peerDeviceIdHint = normalizePeerDeviceId(opts.peerDeviceId || opts.peer_device_id || opts.peerDeviceIdHint || null);
  const { key } = resolvePeerKey(peerAccountDigest, { peerDeviceIdHint });
  if (!key) return null;
  const parsedKey = parsePeerKey(key);
  const map = ensureMap();
  const record = map.get(key);
  if (!record) return null;
  const desiredDeviceId = normalizeDeviceId(opts.deviceId) || normalizeDeviceId(ensureDeviceId());
  const { deviceId, deviceRecord } = selectDeviceRecord(record, desiredDeviceId);
  if (desiredDeviceId && deviceId !== desiredDeviceId) return null;
  if (!deviceRecord) return null;

  const merged = {
    ...record,
    peerDeviceId: record.peerDeviceId || parsedKey.deviceId || null,
    deviceId: deviceId || desiredDeviceId || null
  };
  merged.drState = deviceRecord?.drState || null;
  merged.drSeed = deviceRecord?.drSeed || null;
  merged.drHistory = Array.isArray(deviceRecord?.drHistory) ? deviceRecord.drHistory : [];
  merged.drHistoryCursorTs = Number.isFinite(deviceRecord?.drHistoryCursorTs) ? deviceRecord.drHistoryCursorTs : null;
  merged.drHistoryCursorId = deviceRecord?.drHistoryCursorId || null;
  merged.updatedAt = Number.isFinite(deviceRecord?.updatedAt) ? deviceRecord.updatedAt : (Number.isFinite(record.updatedAt) ? record.updatedAt : null);
  const cloned = cloneImmutable(merged, { sourceTag: 'getContactSecret' });
  debugLog('export-immutable', {
    peerKey: key,
    hasDrState: !!cloned?.drState,
    hasDrHistory: Array.isArray(cloned?.drHistory) ? cloned.drHistory.length > 0 : false,
    strategy: 'clone'
  });
  return cloned;
}

export function getContactSecretSections(peerAccountDigest, opts = {}) {
  const record = getContactSecret(peerAccountDigest, opts);
  if (!record) return null;
  return {
    conversation: {
      token: record.conversationToken || null,
      id: record.conversationId || null,
      drInit: record.conversationDrInit || null
    },
    dr: {
      state: record.drState ? { ...record.drState } : null,
      seed: record.drSeed || null,
      history: Array.isArray(record.drHistory) ? record.drHistory.slice() : [],
      cursor: {
        ts: Number.isFinite(record.drHistoryCursorTs) ? record.drHistoryCursorTs : null,
        id: record.drHistoryCursorId || null
      }
    },
    meta: {
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : null
    }
  };
}

/**
 * Get conversation token for call key derivation.
 * Unlike getContactSecret, this does NOT filter by deviceId.
 * For calls, we only need the shared conversationToken.
 */
export function getConversationTokenForCall(peerAccountDigest, opts = {}) {
  const peerDeviceIdHint = normalizePeerDeviceId(opts.peerDeviceId || null);
  const { key } = resolvePeerKey(peerAccountDigest, { peerDeviceIdHint });
  const map = ensureMap();
  const normalized = normalizeAccountDigest(peerAccountDigest);

  // 1. Exact key lookup
  if (key) {
    const record = map.get(key);
    if (record?.conversationToken) return record.conversationToken;
  }

  // 2. Digest-prefix fallback: find any entry in the cloud-restored map
  //    matching this peer digest (handles device-id differences).
  if (normalized) {
    for (const [k, v] of map.entries()) {
      if (k.startsWith(normalized + '::') || k === normalized) {
        if (v?.conversationToken) return v.conversationToken;
      }
    }
  }

  return null;
}

/**
 * Find a peer's device ID by account digest from the cloud-restored
 * contact-secrets map.  Used during D1 contact restore when the encrypted
 * blob is missing the peerDeviceId that was available at share-time.
 */
export function findPeerDeviceIdByDigest(digest) {
  const normalized = normalizeAccountDigest(digest);
  if (!normalized) return null;
  const map = ensureMap();
  for (const [k] of map.entries()) {
    if (k.startsWith(normalized + '::')) {
      const sep = k.indexOf('::');
      if (sep > 0 && k.length > sep + 2) return k.slice(sep + 2);
    }
  }
  return null;
}

export function lockContactSecrets(reason = 'locked') {
  if (contactSecretsLocked) return false;
  contactSecretsLocked = true;
  debugLog('lock', { reason });
  return true;
}

function basicChecksum(payload) {
  let hash = 0;
  for (let i = 0; i < payload.length; i += 1) {
    hash = (hash + payload.charCodeAt(i)) >>> 0; // unsigned 32-bit accumulate
  }
  return hash.toString(16).padStart(8, '0');
}

function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export async function computeContactSecretsChecksum(payload) {
  if (!payload || typeof payload !== 'string') return null;
  if (typeof crypto !== 'undefined' && crypto?.subtle && TEXT_ENCODER) {
    try {
      const encoded = TEXT_ENCODER.encode(payload);
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      return { algorithm: 'sha256', value: bufferToHex(digest) };
    } catch (err) {
      log({ contactSecretChecksumError: err?.message || err });
    }
  }
  return { algorithm: 'sum32', value: basicChecksum(payload) };
}

export function summarizeContactSecretsPayload(payload) {
  const summary = {
    entries: 0,
    withDrState: 0,
    withHistory: 0,
    withSeed: 0,
    maxHistory: 0,
    bytes: typeof payload === 'string' ? payload.length : 0
  };
  if (!payload || typeof payload !== 'string') {
    summary.parseError = 'empty';
    return summary;
  }
  try {
    const parsed = JSON.parse(payload);
    const entries = parsed && typeof parsed === 'object' && Array.isArray(parsed.entries) ? parsed.entries : null;
    if (!entries) {
      summary.parseError = 'unsupported-format';
      return summary;
    }
    summary.version = Number.isFinite(Number(parsed.v ?? parsed.version)) ? Number(parsed.v ?? parsed.version) : CONTACT_SECRETS_VERSION;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      summary.entries += 1;
      const devices = entry.devices && typeof entry.devices === 'object' ? Object.values(entry.devices) : [];
      if (!devices.length && entry.dr) devices.push(entry.dr); // legacy single-device snapshot
      let hasDr = false;
      let hasHistory = false;
      let hasSeed = false;
      for (const dev of devices) {
        const rk = dev?.drState?.rk_b64 || dev?.drState?.rk || dev?.state?.rk || dev?.state?.rk_b64;
        if (!hasDr && typeof rk === 'string' && rk.length) hasDr = true;
        const history = dev?.drHistory || dev?.history || [];
        const historyLen = Array.isArray(history) ? history.length : 0;
        if (historyLen > 0) {
          hasHistory = true;
          if (historyLen > summary.maxHistory) summary.maxHistory = historyLen;
        }
        const seedVal = dev?.drSeed || dev?.seed;
        if (!hasSeed && typeof seedVal === 'string' && seedVal.length) hasSeed = true;
      }
      if (hasDr) summary.withDrState += 1;
      if (hasHistory) summary.withHistory += 1;
      if (hasSeed) summary.withSeed += 1;
    }
    summary.withoutDrState = Math.max(0, summary.entries - summary.withDrState);
    if (!summary.version) summary.version = CONTACT_SECRETS_VERSION;
  } catch (err) {
    summary.parseError = err?.message || String(err);
  }
  return summary;
}

export function getLastContactSecretsRestoreSummary() {
  if (!lastRestoreSummary) return null;
  try {
    return JSON.parse(JSON.stringify(lastRestoreSummary));
  } catch {
    return { ...lastRestoreSummary };
  }
}

export function getLastContactSecretsRestoreError() {
  return lastRestoreError || null;
}
export async function hideContactSecret(key) {
  const digest = typeof key === 'string' ? key : null;
  if (!digest) return;
  // Use setContactSecret to persist
  // We need to support 'isHidden' in the update payload or manually setting it.
  // Currently setContactSecret uses a structured builder.
  // We can just get the record, modify it, and persist.
  // Or extend setContactSecret support.
  // Simplest: direct mod + persist (since setContactSecret is complex).

  const record = getContactSecret(digest);
  if (record) {
    record.isHidden = true;
    record.updatedAt = Date.now();
    ensureMap().set(digest, cloneContactSecretRecord(record));
    await persistContactSecrets();
  }
}

export async function unhideContactSecret(key) {
  const digest = typeof key === 'string' ? key : null;
  if (!digest) return;
  const record = getContactSecret(digest);
  if (record) {
    record.isHidden = false;
    record.updatedAt = Date.now();
    ensureMap().set(digest, cloneContactSecretRecord(record));
    await persistContactSecrets();
  }
}
