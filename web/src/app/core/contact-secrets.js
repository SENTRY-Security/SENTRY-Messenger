// /app/core/contact-secrets.js
// Centralized helpers to persist and access contact-share secrets.

import { sessionStore } from '../ui/mobile/session-store.js';
import { log } from './log.js';
import { b64 } from '../crypto/nacl.js';

const STORAGE_KEY = 'contactSecrets-v1';
let restored = false;

(function hydrateContactSecretsFromSession() {
  try {
    if (typeof window === 'undefined') return;
    const session = window.sessionStorage;
    if (!session) return;
    const snapshot = session.getItem(STORAGE_KEY);
    if (!snapshot || typeof snapshot !== 'string' || !snapshot.length) return;
    const storage = window.localStorage;
    if (storage) {
      const existing = storage.getItem(STORAGE_KEY);
      if (!existing || existing.length < snapshot.length) {
        storage.setItem(STORAGE_KEY, snapshot);
      }
    }
    session.removeItem(STORAGE_KEY);
  } catch {
    // ignore hydration errors; fallback to storage copy
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
    out.push({ ts, messageId, snapshot: snap });
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
  if (typeof window !== 'undefined') {
    try {
      if (window.localStorage) return window.localStorage;
    } catch {}
    try {
      if (window.sessionStorage) return window.sessionStorage;
    } catch {}
  }
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
  const storage = getStorage();
  if (!storage) return map;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      debugLog('restore-skip', { reason: 'storage-empty' });
      return map;
    }
    const items = JSON.parse(raw);
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
    }
    debugLog('restore', { entries: map.size });
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
