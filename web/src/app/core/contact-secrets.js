// /app/core/contact-secrets.js
// Centralized helpers to persist and access contact-share secrets.

import { sessionStore } from '../ui/mobile/session-store.js';
import { log } from './log.js';

const STORAGE_KEY = 'contactSecrets-v1';
let restored = false;

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
    if (!raw) return map;
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return map;
    map.clear();
    for (const [peerUid, value] of items) {
      const key = normalizeUid(peerUid);
      if (!key) continue;
      const inviteId = typeof value?.inviteId === 'string' ? value.inviteId.trim() : null;
      const secret = typeof value?.secret === 'string' ? value.secret.trim() : null;
      if (!inviteId || !secret) continue;
      map.set(key, {
        inviteId,
        secret,
        role: typeof value?.role === 'string' ? value.role : null,
        conversationToken: typeof value?.conversationToken === 'string' ? value.conversationToken : null,
        conversationId: typeof value?.conversationId === 'string' ? value.conversationId : null,
        updatedAt: Number(value?.updatedAt || 0) || null
      });
    }
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
    const payload = JSON.stringify(Array.from(map.entries()));
    storage.setItem(STORAGE_KEY, payload);
  } catch (err) {
    log({ contactSecretPersistError: err?.message || err });
  }
}

export function setContactSecret(peerUid, { inviteId, secret, role, conversationToken, conversationId } = {}) {
  const key = normalizeUid(peerUid);
  if (!key) return;
  const id = typeof inviteId === 'string' ? inviteId.trim() : null;
  const secretStr = typeof secret === 'string' ? secret.trim() : null;
  if (!id || !secretStr) return;
  const map = ensureMap();
  map.set(key, {
    inviteId: id,
    secret: secretStr,
    role: role || null,
    conversationToken: typeof conversationToken === 'string' ? conversationToken.trim() || null : null,
    conversationId: typeof conversationId === 'string' ? conversationId.trim() || null : null,
    updatedAt: Math.floor(Date.now() / 1000)
  });
  persistContactSecrets();
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

function normalizeUid(value) {
  return String(value || '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase() || null;
}
