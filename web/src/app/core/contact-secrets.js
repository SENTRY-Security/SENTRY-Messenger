// /app/core/contact-secrets.js
// Centralized helpers to persist and access contact-share secrets.

import { sessionStore } from '../ui/mobile/session-store.js';
import { log } from './log.js';
import { b64 } from '../crypto/nacl.js';
import {
  getUidHex,
  getAccountDigest,
  normalizePeerIdentity,
  normalizeAccountDigest,
  normalizePeerUid
} from './store.js';

const STORAGE_KEY_BASE = 'contactSecrets-v1';
const LATEST_KEY_BASE = 'contactSecrets-v1-latest';
const META_KEY_BASE = 'contactSecrets-v1-meta';
const CHECKSUM_KEY_BASE = 'contactSecrets-v1-checksum';
const CONTACT_SECRETS_VERSION = 2;
let restored = false;
let contactSecretsLocked = false;
const TEXT_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const contactAliasToPrimary = new Map(); // alias -> primary key (accountDigest preferred)
const contactPrimaryToAliases = new Map(); // primary -> Set(alias)

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

function resolveContactSecretsNamespace({ uid, accountDigest } = {}) {
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

function getKeyVariants(base, opts = {}) {
  const namespace = resolveContactSecretsNamespace(opts);
  const keys = [];
  if (namespace) keys.push(buildKey(base, namespace));
  keys.push(base);
  return uniqueKeys(keys);
}

export function getContactSecretsStorageKeys(opts = {}) {
  return getKeyVariants(STORAGE_KEY_BASE, opts);
}

export function getContactSecretsLatestKeys(opts = {}) {
  return getKeyVariants(LATEST_KEY_BASE, opts);
}

export function getContactSecretsMetaKeys(opts = {}) {
  return getKeyVariants(META_KEY_BASE, opts);
}

export function getContactSecretsChecksumKeys(opts = {}) {
  return getKeyVariants(CHECKSUM_KEY_BASE, opts);
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
    // Legacy fallback for older builds – keep base key in sync
    if (resolvedNamespace) {
      try { local.setItem(STORAGE_KEY_BASE, sessionPayload); } catch {}
      if (sessionMeta) {
        try { local.setItem(META_KEY_BASE, JSON.stringify(sessionMeta)); } catch {}
      }
      if (sessionChecksum) {
        try { local.setItem(CHECKSUM_KEY_BASE, JSON.stringify(sessionChecksum)); } catch {}
      }
    }
  }

  if (shouldPromote) {
    if (session && removeSessionIfCopied && (!local || wroteToLocal)) {
      try { session.removeItem(sessionRecord.key); } catch {}
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
    // ignore hydration errors; rely on restoreContactSecrets fallback
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
  } catch {}
}

function debugLog(event, payload) {
  if (!CONTACT_DEBUG.enabled) return;
  try {
    console.log('[contact-secrets]', event, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function normalizeUid(value) {
  return normalizePeerUid(value);
}

function trimString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function chooseString(value, fallback) {
  if (value === undefined) return fallback ?? null;
  if (value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return fallback ?? null;
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

function toNumberOrDefault(value, def = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

function toTimestampOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeDrSnapshot(input, { setDefaultUpdatedAt = false } = {}) {
  if (!input || typeof input !== 'object') return null;
  const rk = toBase64Maybe(input.rk ?? input.rk_b64);
  if (!rk) return null;
  const out = {
    v: Number.isFinite(Number(input.v)) ? Number(input.v) : 1,
    rk_b64: rk,
    ckS_b64: toBase64Maybe(input.ckS ?? input.ckS_b64),
    ckR_b64: toBase64Maybe(input.ckR ?? input.ckR_b64),
    Ns: toNumberOrDefault(input.Ns, 0),
    Nr: toNumberOrDefault(input.Nr, 0),
    PN: toNumberOrDefault(input.PN, 0),
    myRatchetPriv_b64: toBase64Maybe(input.myRatchetPriv ?? input.myRatchetPriv_b64),
    myRatchetPub_b64: toBase64Maybe(input.myRatchetPub ?? input.myRatchetPub_b64),
    theirRatchetPub_b64: toBase64Maybe(input.theirRatchetPub ?? input.theirRatchetPub_b64),
    pendingSendRatchet: !!input.pendingSendRatchet,
    updatedAt: toTimestampOrNull(input.updatedAt ?? input.snapshotTs ?? input.ts ?? null)
  };
  const role = chooseString(input.role, null);
  if (role) out.role = role.toLowerCase();
  if (setDefaultUpdatedAt && !out.updatedAt) {
    out.updatedAt = Date.now();
  }
  return out;
}

function normalizeDrHistory(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const ts = Number(entry.ts ?? entry.timestamp ?? entry.createdAt ?? entry.created_at);
    const snap = normalizeDrSnapshot(entry.snapshot || entry.drState || entry.state || null, { setDefaultUpdatedAt: false });
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (!snap) continue;
    const messageId = chooseString(entry.messageId ?? entry.id ?? entry.message_id, null);
    const messageKey = chooseString(entry.messageKey_b64 ?? entry.message_key_b64 ?? entry.messageKey ?? entry.message_key, null);
    const snapshotAfter = normalizeDrSnapshot(
      entry.snapshotAfter || entry.snapshot_after || entry.nextSnapshot || entry.snapshot_next || null,
      { setDefaultUpdatedAt: false }
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

function resolvePeerKey(input) {
  const identity = normalizePeerIdentity(input);
  if (!identity.key) return { key: null, aliases: [], identity };
  const aliases = identity.aliases || [];
  let key = identity.key;
  const map = ensureMap();
  const preferredKey = identity.accountDigest || null;

  if (preferredKey) {
    if (map.has(preferredKey)) {
      key = preferredKey;
    } else {
      const legacyAlias = identity.uid && map.has(identity.uid) ? identity.uid : null;
      if (legacyAlias) {
        const legacyValue = map.get(legacyAlias);
        map.delete(legacyAlias);
        key = preferredKey;
        map.set(key, legacyValue);
        registerContactAliases(key, [legacyAlias]);
      } else {
        key = preferredKey;
      }
    }
  }

  if (contactAliasToPrimary.has(key)) {
    key = contactAliasToPrimary.get(key) || key;
  }

  if (!map.has(key)) {
    for (const alias of aliases) {
      if (!alias) continue;
      const mapped = contactAliasToPrimary.get(alias);
      if (mapped && map.has(mapped)) {
        key = mapped;
        break;
      }
      if (map.has(alias)) {
        key = alias;
        break;
      }
    }
  }

  registerContactAliases(key, aliases);
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
  if (!snapshot || typeof snapshot !== 'string') {
    debugLog('restore-skip', { reason: 'snapshot-empty', source: reason });
    return null;
  }
  try {
    if (replace) {
      map.clear();
      contactAliasToPrimary.clear();
      contactPrimaryToAliases.clear();
    }
    const parsed = JSON.parse(snapshot);
    if (Array.isArray(parsed)) {
      for (const [peerUid, value] of parsed) {
        const { key } = resolvePeerKey(peerUid);
        if (!key) continue;
        const inviteId = typeof value?.inviteId === 'string' ? value.inviteId.trim() : null;
        const secret = typeof value?.secret === 'string' ? value.secret.trim() : null;
        const drState = normalizeDrSnapshot(value?.drState || value?.dr_state || null, { setDefaultUpdatedAt: false });
        const drSeed = chooseString(value?.drSeed ?? value?.dr_seed, null);
        const drHistory = normalizeDrHistory(value?.drHistory || value?.dr_history || null);
        const drHistoryCursorTs = Number(value?.drHistoryCursorTs ?? value?.dr_history_cursor_ts ?? null);
        const drHistoryCursorId = chooseString(value?.drHistoryCursorId ?? value?.dr_history_cursor_id, null);
        if (!inviteId || !secret) continue;
        totalEntries += 1;
        if (drState) withDrState += 1;
        if (drHistory.length) withHistory += 1;
        if (drSeed) withSeed += 1;
        const sessionBootstrapTs = Number(value?.sessionBootstrapTs ?? value?.session_bootstrap_ts ?? null);
        map.set(key, {
          inviteId,
          secret,
          role: typeof value?.role === 'string' ? value.role : null,
          conversationToken: typeof value?.conversationToken === 'string' ? value.conversationToken : null,
          conversationId: typeof value?.conversationId === 'string' ? value.conversationId : null,
          conversationDrInit: value?.conversationDrInit || null,
          drState,
          drSeed,
          drHistory,
          drHistoryCursorTs: Number.isFinite(drHistoryCursorTs) ? drHistoryCursorTs : null,
          drHistoryCursorId: drHistoryCursorId || null,
          sessionBootstrapTs: Number.isFinite(sessionBootstrapTs) ? sessionBootstrapTs : null,
          updatedAt: Number(value?.updatedAt || 0) || null
        });
        debugLog('restore-entry', {
          peerUid: key,
          hasDrState: !!drState,
          historyLen: drHistory.length,
          cursorTs: Number.isFinite(drHistoryCursorTs) ? drHistoryCursorTs : null,
          cursorId: drHistoryCursorId || null,
          source: reason
        });
      }
    } else {
      const structured = parseStructuredSnapshot(parsed);
      if (!structured) {
        debugLog('restore-skip', { reason: 'unsupported-format', source: reason });
        return null;
      }
      structuredVersion = structured.version || null;
      structuredGeneratedAt = structured.generatedAt || null;
      for (const entry of structured.entries) {
        const normalized = normalizeStructuredEntry(entry);
        if (!normalized) continue;
        const { peerKey, aliases, record } = normalized;
        if (!record.inviteId || !record.secret) continue;
        totalEntries += 1;
        if (record.drState) withDrState += 1;
        if (Array.isArray(record.drHistory) && record.drHistory.length) withHistory += 1;
        if (record.drSeed) withSeed += 1;
        map.set(peerKey, record);
        registerContactAliases(peerKey, aliases);
        debugLog('restore-entry', {
          peerUid: peerKey,
          hasDrState: !!record.drState,
          historyLen: Array.isArray(record.drHistory) ? record.drHistory.length : 0,
          cursorTs: Number.isFinite(record.drHistoryCursorTs) ? record.drHistoryCursorTs : null,
          cursorId: record.drHistoryCursorId || null,
          version: structured.version,
          source: reason
        });
      }
    }
    debugLog('restore', { entries: map.size, source: reason });
    const summaryPayload = {
      entries: totalEntries,
      withDrState,
      withHistory,
      withSeed,
      bytes: snapshot.length,
      version: structuredVersion,
      generatedAt: structuredGeneratedAt
    };
    log({
      contactSecretsRestoreSummary: summaryPayload
    });
    return summaryPayload;
  } catch (err) {
    log({ contactSecretRestoreError: err?.message || err });
    return null;
  }
}

export function persistContactSecrets() {
  const map = ensureMap();
  const storage = getStorage();
  if (!storage) return;
  try {
    const { payload, summary, checksum } = serializeContactSecretsMap(map);
    const storageKeys = getContactSecretsStorageKeys();
    const metaKeys = getContactSecretsMetaKeys();
    const checksumKeys = getContactSecretsChecksumKeys();
    storageKeys.forEach((key) => {
      try { storage.setItem(key, payload); } catch {}
    });
    let sessionBytes = null;
    const sessionStore = getSessionStorageSafe();
    if (sessionStore) {
      storageKeys.forEach((key) => {
        try {
          sessionStore.setItem(key, payload);
          sessionBytes = payload.length;
        } catch {}
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
      } catch {}
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
      try { storage.setItem(key, metaJson); } catch {}
    }
    if (sessionStore) {
      for (const key of metaKeys) {
        try { sessionStore.setItem(key, metaJson); } catch {}
      }
    }
    const localStore = getLocalStorageSafe();
    if (localStore) {
      for (const key of metaKeys) {
        try { localStore.setItem(key, metaJson); } catch {}
      }
    }
    if (checksum) {
      const checksumRecord = { checksum, algorithm: 'sum32', ts: summary.generatedAt };
      const checksumJson = JSON.stringify(checksumRecord);
      for (const key of checksumKeys) {
        try { storage.setItem(key, checksumJson); } catch {}
      }
      if (sessionStore) {
        for (const key of checksumKeys) {
          try { sessionStore.setItem(key, checksumJson); } catch {}
        }
      }
      if (localStore) {
        for (const key of checksumKeys) {
          try { localStore.setItem(key, checksumJson); } catch {}
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
          detail: { payload, summary, checksum }
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
    inviteId: null,
    secret: null,
    role: null,
    conversationToken: null,
    conversationId: null,
    conversationDrInit: null,
    sessionBootstrapTs: null,
    drState: null,
    drSeed: null,
    drHistory: [],
    drHistoryCursorTs: null,
    drHistoryCursorId: null,
    updatedAt: null
  };
}

function cloneContactSecretRecord(existing) {
  if (!existing) return createEmptyContactSecret();
  return {
    inviteId: existing.inviteId || null,
    secret: existing.secret || null,
    role: existing.role || null,
    conversationToken: existing.conversationToken || null,
    conversationId: existing.conversationId || null,
    conversationDrInit: existing.conversationDrInit || null,
    sessionBootstrapTs: Number.isFinite(existing.sessionBootstrapTs) ? existing.sessionBootstrapTs : null,
    drState: existing.drState ? { ...existing.drState } : null,
    drSeed: existing.drSeed || null,
    drHistory: Array.isArray(existing.drHistory) ? existing.drHistory.slice() : [],
    drHistoryCursorTs: Number.isFinite(existing.drHistoryCursorTs) ? existing.drHistoryCursorTs : null,
    drHistoryCursorId: existing.drHistoryCursorId || null,
    updatedAt: Number.isFinite(existing.updatedAt) ? existing.updatedAt : null
  };
}

function derivePeerIdentityForEntry(peerKey) {
  const peerAccountDigest = normalizeAccountDigest(peerKey);
  const aliasSet = contactPrimaryToAliases.get(peerKey);
  let peerUid = null;
  if (aliasSet) {
    for (const alias of aliasSet) {
      const normalized = normalizePeerUid(alias);
      if (normalized && normalized !== peerAccountDigest) {
        peerUid = normalized;
        break;
      }
    }
  }
  if (!peerUid) {
    const normalizedKey = normalizePeerUid(peerKey);
    if (normalizedKey && normalizedKey !== peerAccountDigest) {
      peerUid = normalizedKey;
    }
  }
  return {
    peerAccountDigest: peerAccountDigest || null,
    peerUid: peerUid || (peerAccountDigest ? null : normalizePeerUid(peerKey) || null)
  };
}

function buildStructuredEntry(peerUid, record) {
  const identity = derivePeerIdentityForEntry(peerUid);
  return {
    peerUid: identity.peerUid || identity.peerAccountDigest || null,
    peerAccountDigest: identity.peerAccountDigest || null,
    invite: {
      id: record.inviteId || null,
      secret: record.secret || null,
      role: record.role || null
    },
    conversation: {
      token: record.conversationToken || null,
      id: record.conversationId || null,
      drInit: record.conversationDrInit || null
    },
    dr: {
      state: record.drState || null,
      seed: record.drSeed || null,
      history: Array.isArray(record.drHistory) ? record.drHistory : [],
      cursor: {
        ts: Number.isFinite(record.drHistoryCursorTs) ? record.drHistoryCursorTs : null,
        id: record.drHistoryCursorId || null
      }
    },
    session: {
      bootstrapTs: Number.isFinite(record.sessionBootstrapTs) ? record.sessionBootstrapTs : null
    },
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
    withSeed: 0,
    maxHistory: 0
  };
  if (map instanceof Map) {
    for (const [peerKey, record] of map.entries()) {
      if (!peerKey || !record?.inviteId || !record?.secret) continue;
      const entry = buildStructuredEntry(peerKey, record);
      entries.push(entry);
      summary.entries += 1;
      if (entry.dr?.state && typeof entry.dr.state === 'object') {
        const rk = entry.dr.state.rk_b64 || entry.dr.state.rk;
        if (typeof rk === 'string' && rk.length) summary.withDrState += 1;
      }
      const historyLen = Array.isArray(entry.dr?.history) ? entry.dr.history.length : 0;
      if (historyLen > 0) {
        summary.withHistory += 1;
        if (historyLen > summary.maxHistory) summary.maxHistory = historyLen;
      }
      if (entry.dr?.seed && typeof entry.dr.seed === 'string' && entry.dr.seed.length) {
        summary.withSeed += 1;
      }
    }
  }
  summary.withoutDrState = Math.max(0, summary.entries - summary.withDrState);
  const generatedAt = Date.now();
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

function normalizeStructuredEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const identity = normalizePeerIdentity({
    peerAccountDigest: entry.peerAccountDigest || entry.peer_account_digest || null,
    peerUid: entry.peerUid || entry.peer_uid || null
  });
  if (!identity.key) return null;
  const invite = entry.invite || {};
  const inviteId = normalizeOptionalString(invite.id);
  const secret = normalizeOptionalString(invite.secret);
  if (!inviteId || !secret) return null;
  const record = createEmptyContactSecret();
  record.inviteId = inviteId;
  record.secret = secret;
  record.role = normalizeOptionalString(invite.role) || null;

  const conversation = entry.conversation || {};
  record.conversationToken = normalizeOptionalString(conversation.token) || null;
  record.conversationId = normalizeOptionalString(conversation.id) || null;
  if (Object.prototype.hasOwnProperty.call(conversation, 'drInit')) {
    record.conversationDrInit = conversation.drInit || null;
  }

  const dr = entry.dr || {};
  if (Object.prototype.hasOwnProperty.call(dr, 'state')) {
    const normalizedState = dr.state ? normalizeDrSnapshot(dr.state, { setDefaultUpdatedAt: false }) : null;
    if (normalizedState) record.drState = normalizedState;
  }
  if (Object.prototype.hasOwnProperty.call(dr, 'seed')) {
    record.drSeed = normalizeOptionalString(dr.seed) || null;
  }
  if (Object.prototype.hasOwnProperty.call(dr, 'history')) {
    record.drHistory = normalizeDrHistory(dr.history);
  }
  const cursor = dr.cursor || {};
  if (Object.prototype.hasOwnProperty.call(cursor, 'ts')) {
    const cursorTs = Number(cursor.ts);
    record.drHistoryCursorTs = Number.isFinite(cursorTs) ? cursorTs : null;
  }
  if (Object.prototype.hasOwnProperty.call(cursor, 'id')) {
    record.drHistoryCursorId = normalizeOptionalString(cursor.id) || null;
  }

  const session = entry.session || {};
  if (Object.prototype.hasOwnProperty.call(session, 'bootstrapTs')) {
    const bootstrapTs = Number(session.bootstrapTs);
    record.sessionBootstrapTs = Number.isFinite(bootstrapTs) ? bootstrapTs : null;
  }

  const meta = entry.meta || {};
  if (Object.prototype.hasOwnProperty.call(meta, 'updatedAt')) {
    const updated = Number(meta.updatedAt);
    record.updatedAt = Number.isFinite(updated) ? updated : null;
  }

  return { peerKey: identity.key, aliases: identity.aliases || [], record };
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
    invite: {
      id: { has: false, value: null },
      secret: { has: false, value: null },
      role: { has: false, value: null }
    },
    conversation: {
      token: { has: false, value: null },
      id: { has: false, value: null },
      drInit: { has: false, value: null }
    },
    session: {
      bootstrapTs: { has: false, value: null }
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

  function applyDrState(raw) {
    if (raw === undefined) return;
    if (raw === null) {
      structured.dr.state = { has: true, value: null };
      return;
    }
    const normalized = normalizeDrSnapshot(raw, { setDefaultUpdatedAt: true });
    if (normalized) {
      structured.dr.state = { has: true, value: normalized };
    }
  }

  function applyDrHistory(raw) {
    if (raw === undefined) return;
    if (raw === null) {
      structured.dr.history = { has: true, value: [] };
      return;
    }
    structured.dr.history = { has: true, value: normalizeDrHistory(raw) };
  }

  function applyDrSeed(raw) {
    if (raw === undefined) return;
    structured.dr.seed = { has: true, value: normalizeOptionalString(raw) ?? null };
  }

  // New structured payload
  if (update?.invite && typeof update.invite === 'object') {
    applyString(structured.invite, 'id', update.invite.id);
    applyString(structured.invite, 'secret', update.invite.secret);
    applyString(structured.invite, 'role', update.invite.role);
  }
  if (update?.conversation && typeof update.conversation === 'object') {
    applyString(structured.conversation, 'token', update.conversation.token);
    applyString(structured.conversation, 'id', update.conversation.id);
    if (Object.prototype.hasOwnProperty.call(update.conversation, 'drInit')) {
      structured.conversation.drInit = { has: true, value: update.conversation.drInit || null };
    }
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
  if (update?.session && typeof update.session === 'object') {
    if (Object.prototype.hasOwnProperty.call(update.session, 'bootstrapTs')) {
      applyTimestamp(structured.session, 'bootstrapTs', update.session.bootstrapTs);
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

  // Backwards compatibility (legacy top-level fields)
  applyString(structured.invite, 'id', update.inviteId);
  applyString(structured.invite, 'secret', update.secret);
  applyString(structured.invite, 'role', update.role);
  applyString(structured.conversation, 'token', update.conversationToken);
  applyString(structured.conversation, 'id', update.conversationId);
  if (Object.prototype.hasOwnProperty.call(update, 'conversationDrInit')) {
    structured.conversation.drInit = { has: true, value: update.conversationDrInit || null };
  }
  applyTimestamp(structured.session, 'bootstrapTs', update.sessionBootstrapTs);
  if (Object.prototype.hasOwnProperty.call(update, 'drState')) applyDrState(update.drState);
  if (Object.prototype.hasOwnProperty.call(update, 'drSeed')) applyDrSeed(update.drSeed);
  if (Object.prototype.hasOwnProperty.call(update, 'drHistory')) applyDrHistory(update.drHistory);
  if (Object.prototype.hasOwnProperty.call(update, 'drHistoryCursorTs')) {
    applyTimestamp(structured.dr, 'cursorTs', update.drHistoryCursorTs);
  }
  if (Object.prototype.hasOwnProperty.call(update, 'drHistoryCursorId')) {
    applyString(structured.dr, 'cursorId', update.drHistoryCursorId);
  }

  return structured;
}

export function setContactSecret(peerUid, opts = {}) {
  if (contactSecretsLocked) {
    const identity = normalizePeerIdentity(peerUid);
    debugLog('set-skip-locked', { peerUid: identity.key || null, source: opts?.__debugSource || null });
    return;
  }
  const structured = normalizeContactSecretUpdate(opts);
  const { key, aliases } = resolvePeerKey(peerUid);
  if (!key) return;
  const map = ensureMap();
  const existing = map.get(key) || null;
  const next = cloneContactSecretRecord(existing);

  const resolvedInviteId = structured.invite.id.has ? structured.invite.id.value : next.inviteId;
  const resolvedSecret = structured.invite.secret.has ? structured.invite.secret.value : next.secret;
  if (!resolvedInviteId || !resolvedSecret) return;
  next.inviteId = resolvedInviteId;
  next.secret = resolvedSecret;

  if (structured.invite.role.has) next.role = structured.invite.role.value;
  if (structured.conversation.token.has) next.conversationToken = structured.conversation.token.value;
  if (structured.conversation.id.has) next.conversationId = structured.conversation.id.value;
  if (structured.conversation.drInit.has) next.conversationDrInit = structured.conversation.drInit.value;
  if (structured.session.bootstrapTs.has) next.sessionBootstrapTs = structured.session.bootstrapTs.value;
  if (structured.dr.state.has) next.drState = structured.dr.state.value;
  if (structured.dr.seed.has) next.drSeed = structured.dr.seed.value;
  if (structured.dr.history.has) next.drHistory = structured.dr.history.value || [];
  if (structured.dr.cursorTs.has) next.drHistoryCursorTs = structured.dr.cursorTs.value;
  if (structured.dr.cursorId.has) next.drHistoryCursorId = structured.dr.cursorId.value;

  if (structured.meta.updatedAt.has) {
    next.updatedAt = structured.meta.updatedAt.value ?? null;
  } else {
    next.updatedAt = Math.floor(Date.now() / 1000);
  }

  map.set(key, next);
  registerContactAliases(key, aliases);
  persistContactSecrets();
  debugLog('set', {
    peerUid: key,
    peerAccountDigest: normalizeAccountDigest(key) || null,
    role: next.role || null,
    hasDrState: !!next.drState,
    drUpdatedAt: next.drState?.updatedAt || null,
    historyLen: Array.isArray(next.drHistory) ? next.drHistory.length : 0,
    cursorTs: next.drHistoryCursorTs || null,
    cursorId: next.drHistoryCursorId || null,
    source: structured.debugSource || opts?.__debugSource || 'unknown',
    sessionBootstrapTs: next.sessionBootstrapTs || null
  });
}

export function deleteContactSecret(peerUid) {
  const { key } = resolvePeerKey(peerUid);
  if (!key) return;
  const map = ensureMap();
  if (map.delete(key)) {
    clearContactAliases(key);
    persistContactSecrets();
  }
}

export function getContactSecret(peerUid) {
  const { key } = resolvePeerKey(peerUid);
  if (!key) return null;
  const map = ensureMap();
  return map.get(key) || null;
}

export function getContactSecretSections(peerUid) {
  const record = getContactSecret(peerUid);
  if (!record) return null;
  return {
    invite: {
      id: record.inviteId || null,
      secret: record.secret || null,
      role: record.role || null
    },
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
    session: {
      bootstrapTs: Number.isFinite(record.sessionBootstrapTs) ? record.sessionBootstrapTs : null
    },
    meta: {
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : null
    }
  };
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
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const value = entry[1] || {};
        summary.entries += 1;
        if (value?.drState && typeof value.drState === 'object') {
          const rk = value.drState.rk_b64 || value.drState.rk;
          if (typeof rk === 'string' && rk.length) summary.withDrState += 1;
        }
        const historyLen = Array.isArray(value?.drHistory) ? value.drHistory.length : 0;
        if (historyLen > 0) {
          summary.withHistory += 1;
          if (historyLen > summary.maxHistory) summary.maxHistory = historyLen;
        }
        if (typeof value?.drSeed === 'string' && value.drSeed.length) {
          summary.withSeed += 1;
        }
      }
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      summary.version = Number.isFinite(Number(parsed.v ?? parsed.version)) ? Number(parsed.v ?? parsed.version) : CONTACT_SECRETS_VERSION;
      for (const entry of parsed.entries) {
        if (!entry || typeof entry !== 'object') continue;
        const invite = entry.invite || {};
        if (!invite.secret || !invite.id) continue;
        summary.entries += 1;
        const dr = entry.dr || {};
        if (dr.state && typeof dr.state === 'object') {
          const rk = dr.state.rk_b64 || dr.state.rk;
          if (typeof rk === 'string' && rk.length) summary.withDrState += 1;
        }
        const historyLen = Array.isArray(dr.history) ? dr.history.length : 0;
        if (historyLen > 0) {
          summary.withHistory += 1;
          if (historyLen > summary.maxHistory) summary.maxHistory = historyLen;
        }
        if (typeof dr.seed === 'string' && dr.seed.length) {
          summary.withSeed += 1;
        }
      }
    } else {
      summary.parseError = 'unsupported-format';
      return summary;
    }
    summary.withoutDrState = Math.max(0, summary.entries - summary.withDrState);
    if (!summary.version) {
      summary.version = Array.isArray(parsed) ? 1 : CONTACT_SECRETS_VERSION;
    }
  } catch (err) {
    summary.parseError = err?.message || String(err);
  }
  return summary;
}
