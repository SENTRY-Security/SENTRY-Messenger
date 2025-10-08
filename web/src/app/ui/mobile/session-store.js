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
  currentConvId: ''
};

const defaultMessageState = {
  activePeerUid: null,
  conversationId: null,
  conversationToken: null,
  messages: [],
  nextCursorTs: null,
  loading: false,
  hasMore: true,
  viewMode: 'list'
};

const defaultUiState = {
  openSwipeItem: null,
  currentModalUrl: null
};

const defaultWsState = {
  connection: null,
  reconnectTimer: null
};

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
  inviteSecrets: new Map(),
  shareState: cloneValue(defaultShareState),
  driveState: cloneValue(defaultDriveState),
  messageState: cloneValue(defaultMessageState),
  uiState: cloneValue(defaultUiState),
  wsState: cloneValue(defaultWsState)
};

export function resetShareState() {
  Object.assign(sessionStore.shareState, cloneValue(defaultShareState));
}

export function resetDriveState() {
  Object.assign(sessionStore.driveState, cloneValue(defaultDriveState));
}

export function resetMessageState() {
  Object.assign(sessionStore.messageState, cloneValue(defaultMessageState));
}

export function resetUiState() {
  Object.assign(sessionStore.uiState, cloneValue(defaultUiState));
}

export function resetWsState() {
  Object.assign(sessionStore.wsState, cloneValue(defaultWsState));
}

export function resetContacts() {
  sessionStore.contactState = [];
  sessionStore.contactIndex.clear();
  if (sessionStore.conversationIndex) sessionStore.conversationIndex.clear();
  if (sessionStore.contactSecrets) sessionStore.contactSecrets.clear();
  if (sessionStore.conversationThreads) sessionStore.conversationThreads.clear();
  sessionStore.onlineContacts.clear();
}

export function resetProfileState() {
  sessionStore.profileState = null;
  sessionStore.currentAvatarUrl = null;
}

export function resetSettingsState() {
  sessionStore.settingsState = null;
}

export function resetInviteSecrets() {
  sessionStore.inviteSecrets.clear();
}
