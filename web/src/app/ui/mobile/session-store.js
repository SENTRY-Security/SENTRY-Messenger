import { restoreContactSecrets } from '../../core/contact-secrets.js';
import { logCapped } from '../../core/log.js';
import { normalizeAccountDigest, normalizePeerDeviceId } from '../../core/store.js';

const cloneValue = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const defaultShareState = {
  mode: 'qr',
  open: false,
  currentInvite: null,
  inviteTimerId: null,
  scanner: null,
  scannerActive: false,
  scannerOpen: false
};

const defaultDriveState = {
  cwd: [],
  currentMessages: [],
  currentConvId: '',
  usageBytes: 0,
  usageQuotaBytes: 3 * 1024 * 1024 * 1024
};

const defaultMessageState = {
  activePeerDigest: null,
  activePeerDeviceId: null,
  conversationId: null,
  conversationToken: null,
  messages: [],
  nextCursor: null,
  nextCursorTs: null,
  loading: false,
  hasMore: true,
  viewMode: 'list',
  pendingDeletePeer: null,
  deletePreviewPeer: null,
  replayInProgress: false,
  historyReplayDoneByConvId: {}
};

const defaultUiState = {
  openSwipeItem: null,
  currentModalUrl: null
};

const defaultWsState = {
  connection: null,
  reconnectTimer: null
};

const PENDING_INVITES_STORAGE_KEY = 'pendingInvites-v1';
const OFFLINE_DECRYPT_CURSOR_STORAGE_KEY = 'offlineDecryptCursor-v1';
const PENDING_VAULT_PUT_STORAGE_KEY = 'pendingVaultPut-v1';
let pendingInvitesRestored = false;
let pendingInvitesConvIndexHydrated = false;
let offlineDecryptCursorRestored = false;
let pendingVaultPutsRestored = false;

const defaultSubscriptionState = {
  found: false,
  expiresAt: null,
  lastChecked: null,
  loading: false,
  expired: true,
  logs: [],
  accountCreatedAt: null
};

const CONVERSATION_INDEX_PATCHED = Symbol('conversationIndexPatched');

function buildConversationIndexCallsite() {
  const stack = new Error().stack;
  if (!stack) return null;
  const lines = stack.split('\n').map((line) => line.trim());
  const filtered = lines.filter((line) => !line.includes('session-store.js'));
  return filtered.slice(0, 3).join(' | ') || null;
}

function sanitizeConversationIndexEntry(entry, { callsite = null, suppressLog = false } = {}) {
  if (!entry || typeof entry !== 'object') return entry;
  const rawPeer = entry.peerAccountDigest;
  if (typeof rawPeer !== 'string' || !rawPeer.includes('::')) return entry;
  if (!suppressLog) {
    logCapped('conversationIndexPeerDigestAssert', {
      peerAccountDigest: rawPeer,
      callsite: callsite || buildConversationIndexCallsite() || 'unknown'
    }, 1);
  }
  const [digestPart, devicePart] = rawPeer.split('::');
  const digest = normalizeAccountDigest(digestPart) || (typeof digestPart === 'string' ? digestPart.trim() : null);
  const deviceId = normalizePeerDeviceId(entry.peerDeviceId || devicePart || null);
  const peerKey = entry.peerKey || (digest && deviceId ? `${digest}::${deviceId}` : rawPeer);
  return {
    ...entry,
    peerAccountDigest: digest || null,
    peerDeviceId: entry.peerDeviceId || deviceId || null,
    peerKey
  };
}

function patchConversationIndex(map) {
  if (!(map instanceof Map)) return map;
  if (map[CONVERSATION_INDEX_PATCHED]) return map;
  const originalSet = map.set.bind(map);
  Object.defineProperty(map, CONVERSATION_INDEX_PATCHED, { value: true });
  map.set = (key, value) => originalSet(key, sanitizeConversationIndexEntry(value));
  for (const [convId, entry] of map.entries()) {
    const sanitized = sanitizeConversationIndexEntry(entry, { callsite: 'conversationIndex:hydrate', suppressLog: true });
    if (sanitized !== entry) {
      originalSet(convId, sanitized);
    }
  }
  return map;
}

function resetState(target, defaults) {
  if (!target || typeof target !== 'object' || !defaults) return;
  const defaultClone = cloneValue(defaults);
  for (const key of Object.keys(target)) {
    if (!(key in defaults)) {
      delete target[key];
    }
  }
  Object.assign(target, defaultClone);
}

export const sessionStore = {
  profileState: null,
  settingsState: null,
  currentAvatarUrl: null,
  contactState: [],
  contactIndex: new Map(),
  conversationIndex: new Map(),
  conversationThreads: new Map(),
  contactSecrets: new Map(),
  corruptContacts: new Map(),
  pendingContacts: new Map(),
  pendingInvites: new Map(),
  offlineDecryptCursor: new Map(),
  pendingVaultPuts: [],
  corruptContactBackups: new Map(),
  lastCorruptContactBackup: null,
  onlineContacts: new Set(),
  deletedConversations: new Set(),
  shareState: cloneValue(defaultShareState),
  driveState: cloneValue(defaultDriveState),
  messageState: cloneValue(defaultMessageState),
  uiState: cloneValue(defaultUiState),
  wsState: cloneValue(defaultWsState),
  subscriptionState: cloneValue(defaultSubscriptionState)
};

sessionStore.historyReplayDoneByConvId = sessionStore.historyReplayDoneByConvId || {};
patchConversationIndex(sessionStore.conversationIndex);

export function resetShareState() {
  resetState(sessionStore.shareState, defaultShareState);
}

export function resetDriveState() {
  resetState(sessionStore.driveState, defaultDriveState);
}

export function resetMessageState() {
  resetState(sessionStore.messageState, defaultMessageState);
}

export function resetUiState() {
  resetState(sessionStore.uiState, defaultUiState);
}

export function resetWsState() {
  resetState(sessionStore.wsState, defaultWsState);
}

export function resetContacts() {
  sessionStore.contactState = [];
  sessionStore.contactIndex.clear();
  if (sessionStore.conversationIndex) sessionStore.conversationIndex.clear();
  if (sessionStore.contactSecrets) sessionStore.contactSecrets.clear();
  if (sessionStore.conversationThreads) sessionStore.conversationThreads.clear();
  if (sessionStore.corruptContacts) sessionStore.corruptContacts.clear();
  if (sessionStore.pendingContacts) sessionStore.pendingContacts.clear();
  if (sessionStore.pendingInvites) sessionStore.pendingInvites.clear();
  if (sessionStore.corruptContactBackups) sessionStore.corruptContactBackups.clear();
  sessionStore.lastCorruptContactBackup = null;
  sessionStore.onlineContacts.clear();
  sessionStore.deletedConversations.clear();
}

export function resetProfileState() {
  sessionStore.profileState = null;
  sessionStore.currentAvatarUrl = null;
}

export function resetSettingsState() {
  sessionStore.settingsState = null;
}

function ensurePendingInviteMap() {
  if (!(sessionStore.pendingInvites instanceof Map)) {
    const entries = sessionStore.pendingInvites && typeof sessionStore.pendingInvites.entries === 'function'
      ? Array.from(sessionStore.pendingInvites.entries())
      : [];
    sessionStore.pendingInvites = new Map(entries);
  }
  return sessionStore.pendingInvites;
}

function hydrateConversationIndexFromPendingInvites(store, { source = 'restorePendingInvites' } = {}) {
  if (pendingInvitesConvIndexHydrated) return;
  pendingInvitesConvIndexHydrated = true;
  if (!(sessionStore.conversationIndex instanceof Map)) {
    const entries = sessionStore.conversationIndex && typeof sessionStore.conversationIndex.entries === 'function'
      ? Array.from(sessionStore.conversationIndex.entries())
      : [];
    sessionStore.conversationIndex = new Map(entries);
  }
  const now = Date.now();
  let restoredCount = 0;
  const sampleConversationIdsPrefix8 = [];
  if (store instanceof Map) {
    for (const entry of store.values()) {
      const expiresAt = Number(entry?.expiresAt || 0);
      if (!Number.isFinite(expiresAt) || expiresAt <= now / 1000) continue;
      const conversationId = typeof entry?.conversationId === 'string' ? entry.conversationId.trim() : '';
      const conversationToken = typeof entry?.conversationToken === 'string' ? entry.conversationToken.trim() : '';
      if (!conversationId || !conversationToken) continue;
      const ownerAccountDigest = normalizeAccountDigest(entry?.ownerAccountDigest || null);
      const ownerDeviceId = normalizePeerDeviceId(entry?.ownerDeviceId || null);
      const prev = sessionStore.conversationIndex.get(conversationId) || {};
      const next = { ...prev };
      let changed = false;
      if (!prev.token_b64) {
        next.token_b64 = conversationToken;
        changed = true;
      }
      if (!prev.peerAccountDigest && ownerAccountDigest) {
        next.peerAccountDigest = ownerAccountDigest;
        changed = true;
      }
      if (!prev.peerDeviceId && ownerDeviceId) {
        next.peerDeviceId = ownerDeviceId;
        changed = true;
      }
      if (!changed) continue;
      sessionStore.conversationIndex.set(conversationId, next);
      restoredCount += 1;
      if (sampleConversationIdsPrefix8.length < 3) {
        sampleConversationIdsPrefix8.push(conversationId.slice(0, 8));
      }
    }
  }
  logCapped('pendingInviteConversationIndexHydrate', {
    restoredCount,
    sampleConversationIdsPrefix8,
    source: source || null
  }, 5);
}

export function restorePendingInvites() {
  const store = ensurePendingInviteMap();
  if (pendingInvitesRestored) {
    hydrateConversationIndexFromPendingInvites(store);
    return store;
  }
  pendingInvitesRestored = true;
  let parsed = [];
  try {
    const raw = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(PENDING_INVITES_STORAGE_KEY)
      : null;
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return store;
  for (const entry of parsed) {
    const inviteId = typeof entry?.inviteId === 'string' ? entry.inviteId.trim() : '';
    if (!inviteId) continue;
    const expiresAt = Number(entry?.expiresAt || 0);
    const ownerAccountDigest = normalizeAccountDigest(entry?.ownerAccountDigest || null);
    const ownerDeviceId = normalizePeerDeviceId(entry?.ownerDeviceId || null);
    const conversationId = typeof entry?.conversationId === 'string' ? entry.conversationId.trim() : '';
    const conversationToken = typeof entry?.conversationToken === 'string' ? entry.conversationToken.trim() : '';
    store.set(inviteId, {
      inviteId,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      ownerAccountDigest: ownerAccountDigest || null,
      ownerDeviceId: ownerDeviceId || null,
      conversationId: conversationId || null,
      conversationToken: conversationToken || null
    });
  }
  hydrateConversationIndexFromPendingInvites(store);
  return store;
}

export function persistPendingInvites() {
  const store = ensurePendingInviteMap();
  const payload = Array.from(store.values()).map((entry) => ({
    inviteId: entry?.inviteId || null,
    expiresAt: entry?.expiresAt || null,
    ownerAccountDigest: entry?.ownerAccountDigest || null,
    ownerDeviceId: entry?.ownerDeviceId || null,
    conversationId: entry?.conversationId || null,
    conversationToken: entry?.conversationToken || null
  })).filter((entry) => typeof entry.inviteId === 'string' && entry.inviteId.trim().length);
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(PENDING_INVITES_STORAGE_KEY, JSON.stringify(payload));
    }
  } catch { }
}

export function listPendingInvites() {
  const store = ensurePendingInviteMap();
  return Array.from(store.values());
}

function ensureOfflineDecryptCursorMap() {
  if (!(sessionStore.offlineDecryptCursor instanceof Map)) {
    const entries = sessionStore.offlineDecryptCursor && typeof sessionStore.offlineDecryptCursor.entries === 'function'
      ? Array.from(sessionStore.offlineDecryptCursor.entries())
      : [];
    sessionStore.offlineDecryptCursor = new Map(entries);
  }
  return sessionStore.offlineDecryptCursor;
}

export function restoreOfflineDecryptCursorStore() {
  const store = ensureOfflineDecryptCursorMap();
  if (offlineDecryptCursorRestored) return store;
  offlineDecryptCursorRestored = true;
  let parsed = [];
  try {
    const raw = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(OFFLINE_DECRYPT_CURSOR_STORAGE_KEY)
      : null;
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return store;
  for (const entry of parsed) {
    const conversationId = typeof entry?.conversationId === 'string' ? entry.conversationId.trim() : '';
    if (!conversationId) continue;
    const cursorTs = Number.isFinite(Number(entry?.cursorTs)) ? Number(entry.cursorTs) : null;
    const cursorId = typeof entry?.cursorId === 'string' ? entry.cursorId.trim() : null;
    const hasMoreAtCursor = entry?.hasMoreAtCursor === true;
    const updatedAt = Number.isFinite(Number(entry?.updatedAt)) ? Number(entry.updatedAt) : null;
    store.set(conversationId, { cursorTs, cursorId, hasMoreAtCursor, updatedAt });
  }
  return store;
}

export function persistOfflineDecryptCursorStore() {
  const store = ensureOfflineDecryptCursorMap();
  const payload = [];
  for (const [conversationId, entry] of store.entries()) {
    if (!conversationId) continue;
    payload.push({
      conversationId,
      cursorTs: Number.isFinite(Number(entry?.cursorTs)) ? Number(entry.cursorTs) : null,
      cursorId: typeof entry?.cursorId === 'string' ? entry.cursorId.trim() : null,
      hasMoreAtCursor: entry?.hasMoreAtCursor === true,
      updatedAt: Number.isFinite(Number(entry?.updatedAt)) ? Number(entry.updatedAt) : null
    });
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(OFFLINE_DECRYPT_CURSOR_STORAGE_KEY, JSON.stringify(payload));
    }
  } catch { }
}

function ensurePendingVaultPutQueue() {
  if (!Array.isArray(sessionStore.pendingVaultPuts)) {
    sessionStore.pendingVaultPuts = Array.isArray(sessionStore.pendingVaultPuts) ? sessionStore.pendingVaultPuts : [];
  }
  return sessionStore.pendingVaultPuts;
}

export function restorePendingVaultPuts() {
  const queue = ensurePendingVaultPutQueue();
  if (pendingVaultPutsRestored) return queue;
  pendingVaultPutsRestored = true;
  let parsed = [];
  try {
    const raw = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem(PENDING_VAULT_PUT_STORAGE_KEY)
      : null;
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return queue;
  sessionStore.pendingVaultPuts = parsed.filter((entry) => entry && typeof entry === 'object');
  return sessionStore.pendingVaultPuts;
}

export function persistPendingVaultPuts() {
  const queue = ensurePendingVaultPutQueue();
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(PENDING_VAULT_PUT_STORAGE_KEY, JSON.stringify(queue));
    }
  } catch { }
}

export async function hydrateConversationsFromSecrets() {
  const secrets = restoreContactSecrets();
  if (!(secrets instanceof Map)) return { ready: 0, pending: 0 };
  const { upsertContactCore } = await import('./contact-core-store.js');
  let ready = 0;
  let pending = 0;
  for (const [peerKey, info] of secrets.entries()) {
    const digest = normalizeAccountDigest(
      typeof peerKey === 'string' && peerKey.includes('::')
        ? peerKey.split('::')[0]
        : peerKey
    );
    const peerDeviceId = normalizePeerDeviceId(
      info?.peerDeviceId
      || (typeof peerKey === 'string' && peerKey.includes('::') ? peerKey.split('::')[1] : null)
      || null
    );
    const convId = info?.conversationId
      || info?.conversation?.conversation_id
      || info?.conversation?.id
      || null;
    const tokenB64 = info?.conversationToken
      || info?.conversation?.token_b64
      || info?.conversation?.token
      || null;
    const drInit = info?.conversationDrInit
      || info?.conversation?.dr_init
      || info?.conversation?.drInit
      || null;
    if (!digest || !peerDeviceId || !convId || !tokenB64) continue;
    const res = upsertContactCore({
      peerAccountDigest: digest,
      peerDeviceId,
      conversationId: convId,
      conversationToken: tokenB64,
      nickname: info?.nickname || null,
      avatar: info?.avatar || null,
      contactSecret: info?.conversationToken || info?.contactSecret || null,
      conversation: {
        conversation_id: convId,
        token_b64: tokenB64,
        peerDeviceId,
        ...(drInit ? { dr_init: drInit } : null)
      },
      profileUpdatedAt: info?.profileUpdatedAt || info?.updatedAt || info?.meta?.updatedAt || null
    }, 'session-store:hydrate-secrets');
    if (res?.isReady) ready += 1;
    else if (res) pending += 1;
  }
  return { ready, pending };
}
