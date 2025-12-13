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

export function hydrateConversationsFromSecrets() {
  const secrets = restoreContactSecrets();
  if (!(secrets instanceof Map)) return;
  for (const [peerKey, info] of secrets.entries()) {
    const digest = normalizeAccountDigest(
      typeof peerKey === 'string' && peerKey.includes('::')
        ? peerKey.split('::')[0]
        : peerKey
    );
    const peerDeviceId = normalizePeerDeviceId(info?.peerDeviceId || (typeof peerKey === 'string' && peerKey.includes('::') ? peerKey.split('::')[1] : null) || null);
    const conv = info?.conversation || {};
    const convId = conv?.id || conv?.conversation_id || null;
    const tokenB64 = conv?.token || conv?.token_b64 || null;
    if (!digest || !peerDeviceId || !convId || !tokenB64) continue;
    sessionStore.conversationIndex.set(convId, {
      peerAccountDigest: digest,
      peerDeviceId,
      token_b64: tokenB64,
      dr_init: conv?.drInit || conv?.dr_init || null
    });
  }
}
