import { restoreContactSecrets } from '../../core/contact-secrets.js';
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
  replayInProgress: false
};

const defaultUiState = {
  openSwipeItem: null,
  currentModalUrl: null
};

const defaultWsState = {
  connection: null,
  reconnectTimer: null
};

const defaultSubscriptionState = {
  found: false,
  expiresAt: null,
  lastChecked: null,
  loading: false,
  expired: true,
  logs: [],
  accountCreatedAt: null
};

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
