// /app/core/contact-secrets.js
// Centralized helpers to persist and access contact-share secrets.

import { sessionStore } from '../ui/mobile/session-store.js';
import { log } from './log.js';
import { b64 } from '../crypto/nacl.js';

const STORAGE_KEY = 'contactSecrets-v1';
const META_KEY = 'contactSecrets-v1-meta';
const CHECKSUM_KEY = 'contactSecrets-v1-checksum';
let restored = false;
let contactSecretsLocked = false;
const TEXT_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

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

function pullLatestSnapshot({ forcePromote = false, reason = 'hydrate', removeSessionIfCopied = true } = {}) {
  let localPayload = null;
  let sessionPayload = null;
  let localMeta = null;
  let sessionMeta = null;
  let localChecksum = null;
  let sessionChecksum = null;
  const local = getLocalStorageSafe();
  const session = getSessionStorageSafe();

  if (local) {
    try {
      localPayload = local.getItem(STORAGE_KEY);
    } catch (err) {
      log({ contactSecretLocalReadError: err?.message || err });
    }
    try {
      localMeta = parseJsonSafe(local.getItem(META_KEY));
    } catch {}
    try {
      localChecksum = parseJsonSafe(local.getItem(CHECKSUM_KEY));
    } catch {}
  }

  if (session) {
    try {
      sessionPayload = session.getItem(STORAGE_KEY);
    } catch (err) {
      log({ contactSecretSessionReadError: err?.message || err });
    }
    try {
      sessionMeta = parseJsonSafe(session.getItem(META_KEY));
    } catch {}
    try {
      sessionChecksum = parseJsonSafe(session.getItem(CHECKSUM_KEY));
    } catch {}
  }

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

  if (shouldPromote && local) {
    try {
      local.setItem(STORAGE_KEY, sessionPayload);
      wroteToLocal = true;
      if (sessionMeta) {
        local.setItem(META_KEY, JSON.stringify(sessionMeta));
      }
      if (sessionChecksum) {
        local.setItem(CHECKSUM_KEY, JSON.stringify(sessionChecksum));
      }
    } catch (err) {
      log({ contactSecretSessionCopyError: err?.message || err });
      wroteToLocal = false;
    }
  }

  if (shouldPromote) {
    if (session && removeSessionIfCopied && (!local || wroteToLocal)) {
      try { session.removeItem(STORAGE_KEY); } catch {}
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
  return String(value || '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase() || null;
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

export function restoreContactSecrets() {
  if (restored) return ensureMap();
  restored = true;
  const map = ensureMap();
  const snapshot = pullLatestSnapshot({ forcePromote: true, reason: 'restore' });
  if (!snapshot) {
    debugLog('restore-skip', { reason: 'storage-empty' });
    return map;
  }
  let totalEntries = 0;
  let withDrState = 0;
  let withHistory = 0;
  try {
    const items = JSON.parse(snapshot);
    if (!Array.isArray(items)) return map;
    map.clear();
    for (const [peerUid, value] of items) {
      const key = normalizeUid(peerUid);
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
        updatedAt: Number(value?.updatedAt || 0) || null
      });
      debugLog('restore-entry', {
        peerUid: key,
        hasDrState: !!drState,
        historyLen: drHistory.length,
        cursorTs: Number.isFinite(drHistoryCursorTs) ? drHistoryCursorTs : null,
        cursorId: drHistoryCursorId || null
      });
    }
    debugLog('restore', { entries: map.size });
    log({
      contactSecretsRestoreSummary: {
        entries: totalEntries,
        withDrState,
        withHistory,
        bytes: snapshot.length
      }
    });
  } catch (err) {
    log({ contactSecretRestoreError: err?.message || err });
  }
  return map;
}

export function persistContactSecrets() {
  const map = ensureMap();
  const storage = getStorage();
  if (!storage) return;
  try {
    const entriesArray = Array.from(map.entries());
    const payload = JSON.stringify(entriesArray);
    storage.setItem(STORAGE_KEY, payload);
    let sessionBytes = null;
    try {
      sessionStorage?.setItem?.(STORAGE_KEY, payload);
      sessionBytes = payload.length;
    } catch {}
    if (typeof window !== 'undefined') {
      try {
        if (!window.__LOGIN_SEED_LOCALSTORAGE || typeof window.__LOGIN_SEED_LOCALSTORAGE !== 'object') {
          window.__LOGIN_SEED_LOCALSTORAGE = {};
        }
        window.__LOGIN_SEED_LOCALSTORAGE[STORAGE_KEY] = payload;
      } catch {}
    }
    debugLog('persist', { entries: map.size, bytes: payload.length, sessionBytes });
  } catch (err) {
    log({ contactSecretPersistError: err?.message || err });
  }
}

export function setContactSecret(peerUid, opts = {}) {
  if (contactSecretsLocked) {
    debugLog('set-skip-locked', { peerUid: normalizeUid(peerUid), source: opts?.__debugSource || null });
    return;
  }
  const {
    inviteId,
    secret,
    role,
    conversationToken,
    conversationId,
    conversationDrInit,
    drState: drStateInput,
    drSeed: drSeedInput,
    drHistory: drHistoryInput,
    drHistoryCursorTs,
    drHistoryCursorId,
    __debugSource
  } = opts || {};
  const hasDrState = Object.prototype.hasOwnProperty.call(opts, 'drState');
  const hasDrSeed = Object.prototype.hasOwnProperty.call(opts, 'drSeed');
  const hasDrHistory = Object.prototype.hasOwnProperty.call(opts, 'drHistory');
  const hasHistoryCursor = Object.prototype.hasOwnProperty.call(opts, 'drHistoryCursorTs');
  const hasHistoryCursorId = Object.prototype.hasOwnProperty.call(opts, 'drHistoryCursorId');
  const key = normalizeUid(peerUid);
  if (!key) return;
  const map = ensureMap();
  const existing = map.get(key) || null;
  const id = chooseString(inviteId, existing?.inviteId);
  const secretStr = chooseString(secret, existing?.secret);
  if (!id || !secretStr) return;

  const next = {
    inviteId: id,
    secret: secretStr,
    role: existing?.role || null,
    conversationToken: existing?.conversationToken || null,
    conversationId: existing?.conversationId || null,
    conversationDrInit: existing?.conversationDrInit || null,
    drState: existing?.drState || null,
    drSeed: existing?.drSeed || null,
    drHistory: Array.isArray(existing?.drHistory) ? existing.drHistory.slice() : [],
    drHistoryCursorTs: Number.isFinite(existing?.drHistoryCursorTs) ? existing.drHistoryCursorTs : null,
    drHistoryCursorId: existing?.drHistoryCursorId || null,
    updatedAt: Math.floor(Date.now() / 1000)
  };

  if (role !== undefined) next.role = chooseString(role, next.role);
  if (conversationToken !== undefined) next.conversationToken = chooseString(conversationToken, next.conversationToken);
  if (conversationId !== undefined) next.conversationId = chooseString(conversationId, next.conversationId);
  if (conversationDrInit !== undefined) next.conversationDrInit = conversationDrInit || null;

  if (hasDrState) {
    const candidate = drStateInput;
    if (candidate === null) {
      next.drState = null;
    } else {
      const normalized = normalizeDrSnapshot(candidate, { setDefaultUpdatedAt: true });
      if (normalized) next.drState = normalized;
    }
  }

  if (hasDrSeed) {
    next.drSeed = chooseString(drSeedInput, next.drSeed);
  }

  if (hasDrHistory) {
    const normalizedHistory = normalizeDrHistory(drHistoryInput);
    next.drHistory = normalizedHistory;
  }

  if (hasHistoryCursor) {
    const cursorVal = Number(drHistoryCursorTs);
    next.drHistoryCursorTs = Number.isFinite(cursorVal) ? cursorVal : null;
  }
  if (hasHistoryCursorId) {
    next.drHistoryCursorId = chooseString(drHistoryCursorId, next.drHistoryCursorId);
  }

  map.set(key, next);
  persistContactSecrets();
  debugLog('set', {
    peerUid: key,
    role: next.role || null,
    hasDrState: !!next.drState,
    drUpdatedAt: next.drState?.updatedAt || null,
    historyLen: Array.isArray(next.drHistory) ? next.drHistory.length : 0,
    cursorTs: next.drHistoryCursorTs || null,
    cursorId: next.drHistoryCursorId || null,
    source: __debugSource || 'unknown'
  });
}

export function deleteContactSecret(peerUid) {
  const key = normalizeUid(peerUid);
  if (!key) return;
  const map = ensureMap();
  if (map.delete(key)) persistContactSecrets();
}

export function getContactSecret(peerUid) {
  const key = normalizeUid(peerUid);
  if (!key) return null;
  const map = ensureMap();
  return map.get(key) || null;
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
    if (!Array.isArray(parsed)) {
      summary.parseError = 'not-array';
      return summary;
    }
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
    summary.withoutDrState = Math.max(0, summary.entries - summary.withDrState);
  } catch (err) {
    summary.parseError = err?.message || String(err);
  }
  return summary;
}
