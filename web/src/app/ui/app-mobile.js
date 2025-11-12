// /app/ui/app-mobile.js
// Mobile-first App UI with bottom navigation: Contacts, Messages, Drive, Profile.
// Implements Drive tab using existing encrypted media features.

import { log, setLogSink } from '../core/log.js';
import { AUDIO_PERMISSION_KEY } from './login-ui.js';
import {
  getUidHex, getMkRaw,
  setMkRaw, setUidHex,
  setAccountToken, setAccountDigest, setUidDigest,
  setDevicePriv,
  resetAll, clearSecrets,
  drState,
  getAccountToken,
  getAccountDigest,
  getWrappedMK,
  setWrappedMK,
  getOpaqueServerId
} from '../core/store.js';
import {
  persistContactSecrets,
  lockContactSecrets,
  summarizeContactSecretsPayload,
  computeContactSecretsChecksum
} from '../core/contact-secrets.js';
import { friendsDeleteContact } from '../api/friends.js';
import { mkUpdate } from '../api/auth.js';
import { loadContacts, saveContact } from '../features/contacts.js';
import { ensureSettings, saveSettings, DEFAULT_SETTINGS } from '../features/settings.js';
import { getSimStoragePrefix, getSimStorageKey } from '../../libs/ntag424-sim.js';
import { setupShareController } from './mobile/share-controller.js';
import {
  sessionStore,
  resetShareState,
  resetDriveState,
  resetMessageState,
  resetUiState,
  resetWsState,
  resetContacts,
  resetProfileState,
  resetSettingsState,
  resetInviteSecrets
} from './mobile/session-store.js';
import { setupModalController } from './mobile/modal-utils.js';
import { createSwipeManager } from './mobile/swipe-utils.js';
import { initProfileCard } from './mobile/profile-card.js';
import { escapeHtml, b64u8 } from './mobile/ui-utils.js';
import { initContactsView } from './mobile/contacts-view.js';
import { createPresenceManager } from './mobile/presence-manager.js';
import { createToastController } from './mobile/toast-controller.js';
import { createNotificationAudioManager } from './mobile/notification-audio.js';
import { initMessagesPane } from './mobile/messages-pane.js';
import { initDrivePane } from './mobile/drive-pane.js';
import { hydrateDrStatesFromContactSecrets, persistDrSnapshot } from '../features/dr-session.js';
import { wrapMKWithPasswordArgon2id, unwrapMKWithPasswordArgon2id } from '../crypto/kdf.js';
import { opaqueRegister } from '../features/opaque.js';
import { requestWsToken } from '../api/ws.js';
import { initVersionInfoButton } from './version-info.js';
import {
  setCallSignalSender,
  handleCallSignalMessage,
  handleCallAuxMessage
} from '../features/calls/signaling.js';
import { initCallOverlay } from './mobile/call-overlay.js';

const out = document.getElementById('out');
setLogSink(out);

const { showToast, hideToast } = createToastController(document.getElementById('appToast'));

const navbarEl = document.querySelector('.navbar');
const mainContentEl = document.querySelector('main.content');
const navBadges = typeof document !== 'undefined' ? Array.from(document.querySelectorAll('.nav-badge')) : [];

initVersionInfoButton({ buttonId: 'userMenuVersionBtn', popupId: 'versionInfoPopupAppMenu' });

let pendingServerOps = 0;
let waitOverlayTimer = null;
let shareController = null;

const audioManager = createNotificationAudioManager({ permissionKey: AUDIO_PERMISSION_KEY });
const resumeNotifyAudioContext = () => audioManager.resume();
const playNotificationSound = () => audioManager.play();
const hasAudioPermission = () => audioManager.hasPermission();

function ensureTopbarVisible({ repeat = true } = {}) {
  const apply = () => {
    const topbarEl = document.querySelector('.topbar');
    if (!topbarEl) return;
    topbarEl.style.display = '';
    topbarEl.classList.remove('hidden');
    topbarEl.removeAttribute('aria-hidden');
  };
  apply();
  if (!repeat) return;
  if (typeof window !== 'undefined') {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(apply);
    }
    window.setTimeout?.(apply, 120);
  }
}

function clearLocalEncryptedCaches() {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || isSimStorageKey(key)) continue;
      if (key === 'contactSecrets-v1-latest') continue;
      if (key.startsWith('env_v1:')) keysToRemove.push(key);
    }
    for (const key of keysToRemove) {
      try { localStorage.removeItem(key); } catch (err) { log({ secureLogoutLocalRemoveError: err?.message || err, key }); }
    }
  } catch (err) {
    log({ secureLogoutLocalError: err?.message || err });
  }
}

function clearSessionHandoff() {
const keys = ['mk_b64', 'uid_hex', 'account_token', 'account_digest', 'uid_digest', 'wrapped_mk', 'wrapped_dev', 'inviteSecrets-v1', LOGOUT_MESSAGE_KEY];
  for (const key of keys) {
    try { sessionStorage.removeItem(key); } catch {}
  }
}

function secureLogout(message = '已登出', { auto = false } = {}) {
  if (logoutInProgress) return;
  logoutInProgress = true;
  _autoLoggedOut = true;

  const safeMessage = message || '已登出';

  try {
    flushDrSnapshotsBeforeLogout();
  } catch (err) {
    log({ contactSecretsSnapshotFlushError: err?.message || err, reason: 'secure-logout-call' });
  }

  try {
    lockContactSecrets('secure-logout');
    persistContactSecrets();
  } catch (err) {
    log({ contactSecretsPersistError: err?.message || err });
  }

  try { wsConn?.close(); } catch {}
  wsConn = null;
  wsAuthTokenInfo = null;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  pendingWsMessages.length = 0;
  presenceManager?.clearPresenceState?.();

  try { shareController?.closeShareModal?.(); } catch {}
  try { shareController?.clearInviteSecrets?.(); } catch {}

  resetInviteSecrets();
  resetShareState();
  resetDriveState();
  resetMessageState();
  resetUiState();
  resetWsState();
  resetContacts();
  resetProfileState();
  resetSettingsState();

  clearSessionHandoff();
  try {
    let localBytes = 0;
    let sessionBytesBefore = 0;
    try { localBytes = localStorage.getItem('contactSecrets-v1')?.length || 0; } catch {}
    try { sessionBytesBefore = sessionStorage?.getItem?.('contactSecrets-v1')?.length || 0; } catch {}
    try { console.log('[contact-secrets-handoff-check]', JSON.stringify({ localBytes, sessionBytesBefore })); } catch {}
    let contactSecretsSnapshot = localStorage.getItem('contactSecrets-v1');
    let source = 'localStorage';
    if ((!contactSecretsSnapshot || !contactSecretsSnapshot.length) && typeof sessionStorage !== 'undefined') {
      const handoffFallback = sessionStorage.getItem('contactSecrets-v1');
      if (handoffFallback && handoffFallback.length) {
        contactSecretsSnapshot = handoffFallback;
        source = 'sessionStorage';
      }
    }
    if (contactSecretsSnapshot && typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('contactSecrets-v1', contactSecretsSnapshot);
      let sessionBytes = null;
      try { sessionBytes = sessionStorage.getItem('contactSecrets-v1')?.length || 0; } catch { sessionBytes = null; }
      try { localStorage.setItem('contactSecrets-v1-latest', contactSecretsSnapshot); } catch {}
      const meta = persistContactSecretMetadata({ snapshot: contactSecretsSnapshot, source });
      log({
        contactSecretsHandoffStored: contactSecretsSnapshot.length,
        contactSecretsHandoffSource: source,
        contactSecretsSessionBytes: sessionBytes,
        contactSecretsEntries: meta?.entries || 0,
        contactSecretsDrStates: meta?.withDrState || 0
      });
      try {
        console.log('[contact-secrets-handoff]', JSON.stringify({
          stored: contactSecretsSnapshot.length,
          source,
          sessionBytes
        }));
      } catch {}
    } else if (!contactSecretsSnapshot) {
      persistContactSecretMetadata({ snapshot: null, source: 'missing' });
      log({ contactSecretsHandoffStored: 0, contactSecretsHandoffSource: 'missing' });
    }
  } catch (err) {
    log({ contactSecretsHandoffError: err?.message || err });
  }
  clearLocalEncryptedCaches();

  try { sessionStorage.setItem(LOGOUT_MESSAGE_KEY, safeMessage); } catch {}

  try { resetAll(); } catch (err) {
    log({ secureLogoutResetError: err?.message || err });
    try { clearSecrets(); } catch {}
  }

  if (!auto) {
    try { showToast?.(safeMessage); } catch {}
  }

  setTimeout(() => {
    try { location.replace('/pages/logout.html'); } catch { location.href = '/pages/logout.html'; }
  }, 60);
}

if (typeof window !== 'undefined') {
  try { window.secureLogout = secureLogout; } catch {}
}

function updateNavBadge(tab, value) {
  if (!navBadges?.length) return;
  for (const badge of navBadges) {
    if (badge?.dataset?.tab !== tab) continue;
    const parent = badge.closest('.navbtn');
    if (value && Number(value) > 0) {
      badge.textContent = String(value > 99 ? '99+' : value);
      badge.style.display = 'inline-flex';
      parent?.classList.add('has-badge');
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
      parent?.classList.remove('has-badge');
    }
  }
}

function handleServerOpStart() {
  pendingServerOps += 1;
}

function handleServerOpEnd() {
  pendingServerOps = Math.max(0, pendingServerOps - 1);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('app:fetch-start', handleServerOpStart);
  window.addEventListener('app:fetch-end', handleServerOpEnd);
  const resumeOnce = () => {
    resumeNotifyAudioContext();
  };
  window.addEventListener('pointerdown', resumeOnce, { once: true, passive: true });
  window.addEventListener('touchstart', resumeOnce, { once: true, passive: true });
  window.addEventListener('keydown', resumeOnce, { once: true });
  if (hasAudioPermission()) {
    resumeNotifyAudioContext();
  }
}

const SIM_STORAGE_PREFIX = (() => {
  try { return getSimStoragePrefix(); } catch { return 'ntag424-sim:'; }
})();
const SIM_STORAGE_KEY = (() => {
  try { return getSimStorageKey(); } catch { return null; }
})();

function isSimStorageKey(key) {
  if (!key) return false;
  if (SIM_STORAGE_KEY && key === SIM_STORAGE_KEY) return true;
  if (SIM_STORAGE_PREFIX && key.startsWith(SIM_STORAGE_PREFIX)) return true;
  return false;
}

const LOGOUT_MESSAGE_KEY = 'app:lastLogoutReason';
const CONTACT_SECRETS_META_KEY = 'contactSecrets-v1-meta';
const CONTACT_SECRETS_CHECKSUM_KEY = 'contactSecrets-v1-checksum';
let logoutInProgress = false;

function persistContactSecretMetadata({ snapshot, source }) {
  if (!snapshot || typeof snapshot !== 'string') {
    try {
      sessionStorage?.removeItem?.(CONTACT_SECRETS_META_KEY);
      sessionStorage?.removeItem?.(CONTACT_SECRETS_CHECKSUM_KEY);
      localStorage?.removeItem?.(CONTACT_SECRETS_META_KEY);
      localStorage?.removeItem?.(CONTACT_SECRETS_CHECKSUM_KEY);
    } catch {}
    return null;
  }
  const summary = summarizeContactSecretsPayload(snapshot);
  const meta = {
    ...summary,
    source: source || 'unknown',
    ts: Date.now()
  };
  try {
    sessionStorage?.setItem?.(CONTACT_SECRETS_META_KEY, JSON.stringify(meta));
  } catch {}
  try {
    localStorage?.setItem?.(CONTACT_SECRETS_META_KEY, JSON.stringify(meta));
  } catch {}
  try {
    window.__CONTACT_SECRETS_META__ = meta;
  } catch {}
  log({ contactSecretsSnapshotSummary: meta });
  computeContactSecretsChecksum(snapshot)
    ?.then((checksum) => {
      if (!checksum) return;
      const detail = {
        ...meta,
        checksumAlgo: checksum.algorithm || 'unknown',
        checksum: checksum.value || null
      };
      try {
        sessionStorage?.setItem?.(CONTACT_SECRETS_CHECKSUM_KEY, JSON.stringify(detail));
      } catch {}
      try {
        localStorage?.setItem?.(CONTACT_SECRETS_CHECKSUM_KEY, JSON.stringify(detail));
      } catch {}
      log({
        contactSecretsSnapshotChecksum: {
          checksum: detail.checksum,
          algo: detail.checksumAlgo,
          bytes: detail.bytes,
          source: detail.source
        }
      });
    })
    .catch((err) => log({ contactSecretsChecksumError: err?.message || err }));
  return meta;
}

function flushDrSnapshotsBeforeLogout(reason = 'secure-logout') {
  try {
    const peerSet = new Set();
    if (sessionStore.contactSecrets instanceof Map) {
      for (const key of sessionStore.contactSecrets.keys()) {
        if (key) peerSet.add(key);
      }
    }
    if (sessionStore.contactIndex instanceof Map) {
      for (const key of sessionStore.contactIndex.keys()) {
        if (key) peerSet.add(key);
      }
    }
    let attempted = 0;
    let persisted = 0;
    const missingState = [];
    for (const peerUid of peerSet) {
      attempted += 1;
      const state = drState(peerUid);
      if (state?.rk) {
        if (persistDrSnapshot({ peerUidHex: peerUid, state })) {
          persisted += 1;
        }
      } else {
        missingState.push(peerUid);
      }
    }
    log({
      contactSecretsSnapshotFlush: {
        reason,
        peers: peerSet.size,
        attempted,
        persisted,
        missingState
      }
    });
  } catch (err) {
    log({ contactSecretsSnapshotFlushError: err?.message || err, reason });
  }
}


// --- Hard-disable zoom gestures (reinforce meta viewport) ---
(function disableZoom(){
  try {
    // iOS Safari pinch gesture
    const stop = (e) => { e.preventDefault(); };
    ['gesturestart','gesturechange','gestureend'].forEach(t => {
      document.addEventListener(t, stop, { passive: false });
    });
    // Prevent double-tap zoom
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch < 350) { e.preventDefault(); }
      lastTouch = now;
    }, { passive: false });
    // Ctrl/Meta + wheel zoom (desktop browsers)
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    }, { passive: false });
    // Ctrl/Cmd + +/-/0
    window.addEventListener('keydown', (e) => {
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && (k === '+' || k === '-' || k === '=' || k === '0')) {
        e.preventDefault();
      }
    });
  } catch {}
})();

// Restore MK/UID from sessionStorage handoff (login → app)
(function restoreMkAndUidFromSession() {
  try {
    const mkb64 = sessionStorage.getItem('mk_b64');
    const uid = sessionStorage.getItem('uid_hex');
    const accountToken = sessionStorage.getItem('account_token');
    const accountDigest = sessionStorage.getItem('account_digest');
    const uidDigest = sessionStorage.getItem('uid_digest');
    const wrappedMkRaw = sessionStorage.getItem('wrapped_mk');
    log({
      restoreSession: {
        mk: !!mkb64,
        uid: !!uid,
        accountToken: !!accountToken,
        accountDigest: !!accountDigest,
        uidDigest: !!uidDigest,
        wrappedMk: !!wrappedMkRaw
      }
    });
    if (uid) setUidHex(uid);
    if (accountToken) setAccountToken(accountToken);
    if (accountDigest) setAccountDigest(accountDigest);
    if (uidDigest) setUidDigest(uidDigest);
    if (mkb64 && !getMkRaw()) setMkRaw(b64u8(mkb64));
    if (wrappedMkRaw) {
      try {
        const parsedWrapped = JSON.parse(wrappedMkRaw);
        setWrappedMK(parsedWrapped);
      } catch (err) {
        log({ wrappedMkRestoreError: err?.message || err });
        setWrappedMK(null);
      }
    } else {
      setWrappedMK(null);
    }
    sessionStorage.removeItem('mk_b64');
    sessionStorage.removeItem('uid_hex');
    sessionStorage.removeItem('account_token');
    sessionStorage.removeItem('account_digest');
    sessionStorage.removeItem('uid_digest');
    sessionStorage.removeItem('wrapped_mk');
  } catch (e) { log({ restoreError: String(e?.message || e) }); }
})();

(function hydrateDevicePrivFromSession() {
  try {
    let serialized = sessionStorage.getItem('wrapped_dev');
    if (!serialized) {
      let restoredFromLocal = false;
      if (typeof localStorage !== 'undefined') {
        try {
          const localCopy = localStorage.getItem('wrapped_dev_handoff');
          if (localCopy) {
            serialized = localCopy;
            restoredFromLocal = true;
            localStorage.removeItem('wrapped_dev_handoff');
          }
        } catch {}
      }
      if (!serialized && typeof window !== 'undefined' && window.name) {
        try {
          const handoff = JSON.parse(window.name);
          if (handoff && handoff.wrapped_dev) {
            serialized = JSON.stringify(handoff.wrapped_dev);
          }
        } catch {}
        try { window.name = ''; } catch {}
      }
      if (!serialized) {
        let sessionKeys = null;
        try {
          sessionKeys = [];
          for (let i = 0; i < sessionStorage.length; i += 1) {
            sessionKeys.push(sessionStorage.key(i));
          }
        } catch {}
        log({ devicePrivRestoreSkipped: 'session-missing', sessionKeys });
        return;
      }
      log({ devicePrivRestoreFallback: restoredFromLocal ? 'localStorage' : 'unknown-source' });
    } else {
      try {
        localStorage?.setItem?.('wrapped_dev_handoff', serialized);
      } catch {}
      try { window.name = ''; } catch {}
    }
    sessionStorage.removeItem('wrapped_dev');
    const mk = getMkRaw();
    if (!mk) {
      log({ devicePrivRestoreSkipped: 'mk-missing' });
      return;
    }
    const parsed = JSON.parse(serialized);
    unwrapDevicePrivWithMK(parsed, mk)
      .then((priv) => {
        if (priv) {
          setDevicePriv(priv);
          try { localStorage?.removeItem?.('wrapped_dev_handoff'); } catch {}
          log({ devicePrivRestored: true });
        }
      })
      .catch((err) => {
        log({ devicePrivRestoreError: err?.message || err });
      });
  } catch (err) {
    log({ devicePrivRestoreError: err?.message || err });
  }
})();

(function hydrateDrSnapshotsFromSecrets() {
  try {
    const restored = hydrateDrStatesFromContactSecrets();
    log({ drSnapshotsRestored: restored });
    try {
      const snapshot = localStorage.getItem('contactSecrets-v1');
      if (snapshot) {
        log({ contactSecretsAppLoadSummary: summarizeContactSecretsPayload(snapshot) });
      } else {
        log({ contactSecretsAppLoadSummary: { entries: 0, bytes: 0, parseError: 'missing' } });
      }
    } catch (err) {
      log({ contactSecretsAppLoadSummaryError: err?.message || err });
    }
  } catch (e) {
    log({ drSnapshotHydrateError: e?.message || e });
  }
})();

// Guard: require MK
(function ensureUnlockedOrRedirect(){
  if (!getMkRaw()) {
    log('Not unlocked: redirecting to /pages/logout.html …');
    secureLogout('登入資訊已失效，請重新感應晶片', { auto: true });
  }
})();

// Navigation
const tabs = ['contacts','messages','drive','profile'];
let currentTab = 'drive';
function switchTab(name, options = {}){
  currentTab = name;
  tabs.forEach((t) => {
    const page = document.getElementById(`tab-${t}`);
    const btn = document.getElementById(`nav-${t}`);
    if (page) page.style.display = t === name ? 'block' : 'none';
    if (btn) btn.classList.toggle('active', t === name);
  });

  if (name === 'drive') {
    drivePane.refreshDriveList().catch((err) => log({ driveListError: String(err?.message || err) }));
  }

  if (name === 'messages') {
    const state = messagesPane.getMessageState();
    const isDesktop = typeof window === 'undefined' ? true : window.innerWidth >= 960;
    if (!state.viewMode) {
      state.viewMode = state.activePeerUid ? 'detail' : 'list';
    }
    if (options.fromBack && !isDesktop) {
      state.viewMode = 'list';
    }
    messagesPane.syncConversationThreadsFromContacts();
    messagesPane.refreshConversationPreviews({ force: true }).catch((err) => log({ conversationPreviewRefreshError: err?.message || err }));
    messagesPane.renderConversationList();
    const isAutomation = typeof navigator !== 'undefined' && !!navigator.webdriver;
    if (options.fromBack && !isDesktop && isAutomation && state.activePeerUid) {
      messagesPane.showDeleteForPeer(state.activePeerUid);
    }
    messagesPane.updateComposerAvailability();
    messagesPane.updateMessagesUI({ scrollToEnd: true });
    messagesPane.updateLayoutMode({ force: true });
  } else {
    messagesPane.updateLayoutMode({ force: true });
    navbarEl?.classList.remove('hidden');
    mainContentEl?.classList.remove('fullscreen');
    document.body.classList.remove('messages-fullscreen');
    ensureTopbarVisible();
    setUserMenuOpen(false);
  }
}
// Topbar actions (avatar menu)
const headerAvatarImg = document.getElementById('headerAvatarImg');
const userMenu = document.getElementById('userMenu');
const userMenuBtn = document.getElementById('btnUserMenu');
const userMenuDropdown = document.getElementById('userMenuDropdown');
const userMenuSettingsBtn = userMenuDropdown?.querySelector('[data-action="settings"]') || null;
const userMenuVersionBtn = userMenuDropdown?.querySelector('[data-action="version-info"]') || null;
const userMenuVersionPopup = document.getElementById('versionInfoPopupAppMenu');
const userMenuLogoutBtn = userMenuDropdown?.querySelector('[data-action="logout"]') || null;

let userMenuOpen = false;
function setUserMenuOpen(next) {
  userMenuOpen = !!next;
  if (!userMenuDropdown || !userMenuBtn) return;
  userMenuDropdown.classList.toggle('open', userMenuOpen);
  userMenuDropdown.setAttribute('aria-hidden', userMenuOpen ? 'false' : 'true');
  userMenuBtn.setAttribute('aria-expanded', userMenuOpen ? 'true' : 'false');
  if (!userMenuOpen && userMenuVersionPopup) {
    userMenuVersionPopup.dataset.open = 'false';
    userMenuVersionPopup.setAttribute('aria-hidden', 'true');
  }
}

userMenuBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  ensureTopbarVisible({ repeat: false });
  const next = !userMenuOpen;
  setUserMenuOpen(next);
  if (next) {
    setTimeout(() => {
      userMenuSettingsBtn?.focus({ preventScroll: true });
    }, 20);
  }
});

userMenuDropdown?.addEventListener('click', (event) => {
  event.stopPropagation();
});

userMenuSettingsBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  setUserMenuOpen(false);
  openSystemSettingsModal().catch((err) => {
    log({ settingsModalError: err?.message || err });
  });
});

userMenuLogoutBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  setUserMenuOpen(false);
  secureLogout('已登出');
});

document.addEventListener('click', (event) => {
  if (!userMenuOpen) return;
  if (userMenu && event.target instanceof Node && userMenu.contains(event.target)) return;
  setUserMenuOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && userMenuOpen) {
    setUserMenuOpen(false);
    userMenuBtn?.focus({ preventScroll: true });
  }
});

function applyHeaderAvatar(src, hasCustom = false) {
  if (!headerAvatarImg) return;
  if (typeof src === 'string' && src.trim()) {
    headerAvatarImg.src = src;
  } else {
    headerAvatarImg.src = '/assets/images/avatar.png';
  }
  if (hasCustom) {
    headerAvatarImg.dataset.avatarState = 'custom';
  } else if (headerAvatarImg.dataset.avatarState) {
    delete headerAvatarImg.dataset.avatarState;
  }
}

const btnUploadOpen = document.getElementById('btnUploadOpen');
const inviteBtn = document.getElementById('btnInviteQr');
const inviteCountdownEl = document.getElementById('inviteCountdown');
const inviteQrBox = document.getElementById('inviteQrBox');
const inviteScanVideo = document.getElementById('inviteScanVideo');
const inviteScanStatus = document.getElementById('inviteScanStatus');
const btnShareModal = document.getElementById('btnShareModal');
const shareModal = document.getElementById('shareModal');
const shareModalBackdrop = document.querySelector('[data-share-close]');
const btnShareSwitchScan = document.getElementById('btnShareSwitchScan');
const btnShareSwitchQr = document.getElementById('btnShareSwitchQr');
const shareFlip = document.getElementById('shareFlip');
const statContactsEl = document.getElementById('statContacts');
const contactsCountEl = document.getElementById('contactsCount');
const statFilesEl = document.getElementById('statFiles');
const statInvitesEl = document.getElementById('statInvites');
const profileNicknameEl = document.getElementById('profileNickname');
const btnProfileNickEdit = document.getElementById('btnProfileNickEdit');
const btnProfileEdit = document.getElementById('btnProfileEdit');
const profileAvatarImg = document.getElementById('profileAvatarImg');
const contactsListEl = document.getElementById('contactsList');
const contactsScrollEl = document.getElementById('contactsScroll');
const contactsRefreshEl = document.getElementById('contactsRefreshHint');
const contactsRefreshLabel = contactsRefreshEl?.querySelector('.label') || null;
const connectionIndicator = document.getElementById('connectionIndicator');
const btnUp = document.getElementById('btnUp');
const btnNewFolder = document.getElementById('btnNewFolder');
const { inviteSecrets, shareState } = sessionStore;

const modalController = setupModalController({ shareButtonProvider: () => btnShareModal });
const {
  openModal,
  closeModal,
  showModalLoading,
  updateLoadingModal,
  showConfirmModal,
  showProgressModal,
  updateProgressModal,
  completeProgressModal,
  failProgressModal,
  setModalObjectUrl,
  showSecurityModal
} = modalController;

const { setupSwipe, closeSwipe, closeOpenSwipe } = createSwipeManager();

let removeContactLocalFn = () => {};

const messagesPane = initMessagesPane({
  navbarEl,
  mainContentEl,
  updateNavBadge,
  showToast,
  playNotificationSound,
  switchTab: (tab, options) => switchTab(tab, options),
  getCurrentTab: () => currentTab,
  showConfirmModal,
  saveContactApi: saveContact,
  setupSwipe,
  closeSwipe,
  modal: {
    openModal,
    closeModal,
    showModalLoading,
    updateLoadingModal,
    setModalObjectUrl,
    showSecurityModal
  }
});

initCallOverlay({ showToast });

messagesPane.attachDomEvents();
messagesPane.ensureConversationIndex();
messagesPane.renderConversationList();
messagesPane.updateComposerAvailability();
messagesPane.clearMessagesView();
messagesPane.setMessagesStatus('');
messagesPane.updateLayoutMode({ force: true });

const drivePane = initDrivePane({
  dom: {
    driveList: document.getElementById('driveList'),
    crumbEl: document.getElementById('driveCrumb'),
    btnUploadOpen,
    btnNewFolder,
    btnUp
  },
  modal: {
    openModal,
    closeModal,
    showConfirmModal,
    showModalLoading,
    updateLoadingModal,
    showProgressModal,
    updateProgressModal,
    completeProgressModal,
    failProgressModal,
    setModalObjectUrl
  },
  swipe: { setupSwipe, closeSwipe, closeOpenSwipe },
  updateStats: () => updateProfileStats()
});

if (typeof window !== 'undefined') {
  try { window.__messagesPane = messagesPane; } catch {}
  window.addEventListener('resize', () => messagesPane.updateLayoutMode());
}
document.addEventListener('contacts:rendered', () => messagesPane.renderConversationList());
document.addEventListener('contacts:open-conversation', (event) => {
  const detail = event?.detail || {};
  messagesPane.handleContactOpenConversation(detail);
});
document.addEventListener('contacts:broadcast-update', async (event) => {
  if (!shareController || typeof shareController.broadcastContactUpdate !== 'function') return;
  const detail = event?.detail || {};
  const targets = Array.isArray(detail?.targetPeers)
    ? detail.targetPeers
    : detail?.peerUid
      ? [detail.peerUid]
      : [];
  try {
    await shareController.broadcastContactUpdate({
      reason: detail?.reason || 'manual',
      targetPeers: targets
    });
  } catch (err) {
    log({ contactBroadcastError: err?.message || err, targetPeers: targets });
  }
});

tabs.forEach((t) => {
  const el = document.getElementById(`nav-${t}`);
  if (el) el.addEventListener('click', () => switchTab(t));
});

switchTab('drive');

let wsConn = null;
let wsReconnectTimer = null;
let wsAuthTokenInfo = null;
const pendingWsMessages = [];
let _autoLoggedOut = false;

const presenceManager = createPresenceManager({
  contactsListEl,
  wsSend
});

const contactsView = initContactsView({
  dom: { contactsListEl, contactsScrollEl, contactsRefreshEl, contactsRefreshLabel },
  loadContactsApi: loadContacts,
  saveContactApi: saveContact,
  friendsDeleteContact,
  modal: modalController,
  swipe: { setupSwipe, closeSwipe },
  presenceManager,
  updateStats: () => updateProfileStats()
});

const { loadInitialContacts, renderContacts, addContactEntry: addContactEntryRaw, removeContactLocal: removeContactLocalRaw } = contactsView;

if (typeof window !== 'undefined') {
  try {
    window.__refreshContacts = async () => {
      await loadInitialContacts();
      renderContacts();
    };
  } catch {}
}

async function addContactEntry(contact) {
  const result = await addContactEntryRaw(contact);
  messagesPane.syncConversationThreadsFromContacts();
  messagesPane.renderConversationList();
  messagesPane.refreshConversationPreviews({ force: true }).catch((err) => log({ conversationPreviewRefreshError: err?.message || err }));
  return result;
}

function removeContactLocal(peerUid) {
  removeContactLocalRaw?.(peerUid);
  shareController?.removeContactSecret?.(peerUid);
  messagesPane.syncConversationThreadsFromContacts();
  messagesPane.renderConversationList();
}

removeContactLocalFn = (peerUid) => removeContactLocal(peerUid);

const profileCard = initProfileCard({
  dom: {
    profileNicknameEl,
    btnProfileNickEdit,
    btnProfileEdit,
    profileAvatarImg
  },
  modal: modalController,
  shareButton: btnShareModal,
  updateStats: () => updateProfileStats(),
  onAvatarUpdate: ({ src, hasCustom }) => applyHeaderAvatar(src, hasCustom),
  broadcastContactUpdate: (...args) => shareController?.broadcastContactUpdate?.(...args)
});

const {
  loadProfile,
  ensureAvatarThumbnail,
  buildLocalContactPayload
} = profileCard;

const profileInitPromise = loadProfile().catch((err) => {
  log({ profileInitError: err?.message || err });
  throw err;
});

shareController = setupShareController({
  dom: {
    inviteBtn,
    inviteCountdownEl,
    inviteQrBox,
    btnShareModal,
    shareModal,
    shareModalBackdrop,
    btnShareSwitchScan,
    btnShareSwitchQr,
    shareFlip,
    inviteScanVideo,
    inviteScanStatus
  },
  inviteSecrets,
  shareState,
  getProfileState: () => sessionStore.profileState,
  profileInitPromise,
  ensureAvatarThumbnail,
  buildLocalContactPayload,
  addContactEntry,
  switchTab,
  updateProfileStats,
  getCurrentTab: () => currentTab,
  showToast
});

if (typeof window !== 'undefined') {
  try { window.__shareController = shareController; } catch {}
}

const {
  restoreInviteSecrets,
  clearInviteSecrets,
  handleContactShareEvent,
  closeShareModal
} = shareController;

restoreInviteSecrets();

profileInitPromise
  .then(() => {
    const state = sessionStore.profileState;
    if (sessionStore.currentAvatarUrl) {
      applyHeaderAvatar(sessionStore.currentAvatarUrl, !!state?.avatar?.objKey);
    } else {
      applyHeaderAvatar('/assets/images/avatar.png', false);
    }
  })
  .catch(() => {});

const settingsInitPromise = ensureSettings()
  .then((settings) => {
    sessionStore.settingsState = settings;
    return settings;
  })
  .catch((err) => {
    log({ settingsInitError: err?.message || err });
    const fallback = { ...DEFAULT_SETTINGS, updatedAt: Math.floor(Date.now() / 1000) };
    sessionStore.settingsState = fallback;
    return fallback;
  });

function getEffectiveSettingsState() {
  return { ...DEFAULT_SETTINGS, ...(sessionStore.settingsState || {}) };
}

const MODAL_VARIANTS = [
  'security-modal',
  'progress-modal',
  'folder-modal',
  'upload-modal',
  'loading-modal',
  'confirm-modal',
  'nickname-modal',
  'avatar-modal',
  'avatar-preview-modal',
  'settings-modal',
  'change-password-modal'
];

function resetModalVariants(modalElement) {
  modalElement.classList.remove(...MODAL_VARIANTS);
}

async function persistSettingsPatch(partial) {
  const previous = getEffectiveSettingsState();
  const next = { ...previous, ...partial };
  const noChange =
    previous.showOnlineStatus === next.showOnlineStatus &&
    previous.autoLogoutOnBackground === next.autoLogoutOnBackground;
  if (noChange) return previous;
  sessionStore.settingsState = next;
  try {
    const saved = await saveSettings(next);
    sessionStore.settingsState = saved;
    log({ settingsSaved: { showOnlineStatus: saved.showOnlineStatus, autoLogoutOnBackground: saved.autoLogoutOnBackground } });
    return saved;
  } catch (err) {
    sessionStore.settingsState = previous;
    throw err;
  }
}

async function openSystemSettingsModal() {
  let settings = sessionStore.settingsState;
  if (!settings) {
    try {
      settings = await settingsInitPromise;
    } catch (err) {
      log({ settingsLoadError: err?.message || err });
    }
  }
  const current = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  const modalElement = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');
  if (!modalElement || !body) return;

  resetModalVariants(modalElement);
  modalElement.classList.add('settings-modal');
  if (title) title.textContent = '系統設定';

  body.innerHTML = `
    <div id="systemSettings" class="settings-form">
      <div class="settings-item">
        <div class="settings-text">
          <strong>顯示我的上線狀態</strong>
          <p>好友可以看到你目前是否在線上。</p>
        </div>
        <label class="settings-switch">
          <input type="checkbox" id="settingsShowOnline" ${current.showOnlineStatus ? 'checked' : ''} />
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <div class="settings-item">
        <div class="settings-text">
          <strong>當畫面不在前台時自動登出</strong>
          <p>離開或縮小瀏覽器時自動清除登入狀態。</p>
        </div>
        <label class="settings-switch">
          <input type="checkbox" id="settingsAutoLogout" ${current.autoLogoutOnBackground ? 'checked' : ''} />
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <div class="settings-item">
        <div class="settings-text">
          <strong>變更密碼</strong>
          <p>更新登入密碼，需輸入目前密碼與新密碼。</p>
        </div>
        <button type="button" class="settings-link" id="settingsChangePassword">變更</button>
      </div>
      <div class="settings-actions">
        <button type="button" class="secondary" id="settingsClose">關閉</button>
      </div>
    </div>`;

  openModal();

  const closeBtn = body.querySelector('#settingsClose');
  const showOnlineInput = body.querySelector('#settingsShowOnline');
  const autoLogoutInput = body.querySelector('#settingsAutoLogout');
  const changePasswordBtn = body.querySelector('#settingsChangePassword');
  closeBtn?.addEventListener('click', () => {
    closeModal();
  }, { once: true });

  changePasswordBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    openChangePasswordModal().catch((err) => {
      log({ changePasswordModalError: err?.message || err });
      alert('目前無法開啟變更密碼視窗，請稍後再試。');
    });
  });

  const registerToggle = (input, key) => {
    if (!input) return;
    input.addEventListener('change', async () => {
      const previous = getEffectiveSettingsState();
      const nextValue = !!input.checked;
      if (previous[key] === nextValue) return;
      input.disabled = true;
      try {
        await persistSettingsPatch({ [key]: nextValue });
        if (key === 'autoLogoutOnBackground') {
          _autoLoggedOut = false;
        }
      } catch (err) {
        log({ settingsAutoSaveError: err?.message || err });
        alert('儲存設定失敗，請稍後再試。');
        input.checked = !!previous[key];
      } finally {
        input.disabled = false;
      }
    });
  };

  registerToggle(showOnlineInput, 'showOnlineStatus');
  registerToggle(autoLogoutInput, 'autoLogoutOnBackground');
}

async function openChangePasswordModal() {
  const modalElement = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');
  if (!modalElement || !body) return;

  resetModalVariants(modalElement);
  modalElement.classList.add('change-password-modal');
  if (title) title.textContent = '變更密碼';

  body.innerHTML = `
    <form id="changePasswordForm" class="change-password-form">
      <label for="currentPassword">
        目前密碼
        <input id="currentPassword" type="password" autocomplete="current-password" required />
      </label>
      <label for="newPassword">
        新密碼
        <input id="newPassword" type="password" autocomplete="new-password" minlength="6" required />
      </label>
      <label for="confirmPassword">
        確認新密碼
        <input id="confirmPassword" type="password" autocomplete="new-password" minlength="6" required />
      </label>
      <div id="changePasswordStatus" class="change-password-status" role="status" aria-live="polite"></div>
      <div class="change-password-actions">
        <button type="button" class="secondary" id="changePasswordCancel">取消</button>
        <button type="submit" class="primary" id="changePasswordSubmit">更新密碼</button>
      </div>
    </form>
  `;

  openModal();

  const form = body.querySelector('#changePasswordForm');
  const currentInput = body.querySelector('#currentPassword');
  const newInput = body.querySelector('#newPassword');
  const confirmInput = body.querySelector('#confirmPassword');
  const statusEl = body.querySelector('#changePasswordStatus');
  const cancelBtn = body.querySelector('#changePasswordCancel');
  const submitBtn = body.querySelector('#changePasswordSubmit');

  const setStatus = (text, { success = false } = {}) => {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('success', !!text && success);
  };

  const setSubmitting = (next) => {
    const disabled = !!next;
    [currentInput, newInput, confirmInput].forEach((input) => {
      if (input) input.disabled = disabled;
    });
    if (cancelBtn) cancelBtn.disabled = disabled;
    if (submitBtn) {
      submitBtn.disabled = disabled;
      if (disabled) {
        submitBtn.dataset.prevText = submitBtn.textContent || '更新密碼';
        submitBtn.textContent = '更新中...';
      } else if (submitBtn.dataset.prevText) {
        submitBtn.textContent = submitBtn.dataset.prevText;
        delete submitBtn.dataset.prevText;
      }
    }
  };

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPassword = currentInput?.value || '';
    const newPassword = newInput?.value || '';
    const confirmPassword = confirmInput?.value || '';
    setStatus('');

    if (!currentPassword) {
      setStatus('請輸入目前密碼。');
      currentInput?.focus();
      return;
    }
    if (!newPassword || newPassword.length < 6) {
      setStatus('新密碼至少需 6 個字元。');
      newInput?.focus();
      return;
    }
    if (newPassword === currentPassword) {
      setStatus('新密碼需與目前密碼不同。');
      newInput?.focus();
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatus('兩次輸入的密碼不一致。');
      confirmInput?.focus();
      return;
    }

    setSubmitting(true);
    try {
      await changeAccountPassword(currentPassword, newPassword);
      setStatus('密碼已更新，下次登入請使用新密碼。', { success: true });
      form?.reset();
      setTimeout(() => {
        closeModal();
      }, 1800);
    } catch (err) {
      const message = err?.userMessage || err?.message || '更新密碼失敗，請稍後再試。';
      setStatus(message);
    } finally {
      setSubmitting(false);
    }
  });

  cancelBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    closeModal();
  }, { once: true });
}

async function changeAccountPassword(currentPassword, newPassword) {
  const wrapped = getWrappedMK();
  if (!wrapped) {
    const err = new Error('目前無法取得主金鑰，請重新登入後再試。');
    err.userMessage = err.message;
    throw err;
  }
  const mk = await unwrapMKWithPasswordArgon2id(currentPassword, wrapped);
  if (!mk) {
    const err = new Error('目前的密碼不正確，請重新輸入。');
    err.userMessage = err.message;
    throw err;
  }
  const newWrapped = await wrapMKWithPasswordArgon2id(newPassword, mk);
  const uidHex = getUidHex();
  const accountToken = getAccountToken();
  const accountDigest = getAccountDigest();
  const serverId = getOpaqueServerId();
  if (!uidHex || !accountToken || !accountDigest) {
    const err = new Error('帳號資訊不足，請重新登入後再試。');
    err.userMessage = err.message;
    throw err;
  }
  const { r, data } = await mkUpdate({ uidHex, accountToken, accountDigest, wrapped_mk: newWrapped });
  if (r.status !== 204) {
    const userMessage = typeof data === 'object' && data?.message
      ? data.message
      : '更新密碼失敗，請稍後再試。';
    const err = new Error(userMessage);
    err.userMessage = userMessage;
    throw err;
  }
  try {
    await opaqueRegister({
      password: newPassword,
      accountDigest,
      serverId
    });
    log({ changePasswordOpaqueRegister: { ok: true, serverId: !!serverId } });
  } catch (err) {
    const message = err?.message || '更新登入驗證資料失敗，請稍後再試。';
    const error = new Error(message);
    error.userMessage = message;
    throw error;
  }
  log({ changePasswordUpdateStatus: r.status });
  setWrappedMK(newWrapped);
  setMkRaw(mk);
  log({ passwordChangedAt: Date.now() });
  return true;
}

function handleBackgroundAutoLogout(reason = '畫面已移至背景，已自動登出') {
  if (logoutInProgress || _autoLoggedOut) return;
  const settings = getEffectiveSettingsState();
  if (!settings.autoLogoutOnBackground) return;
  if (!getMkRaw()) return;
  secureLogout(reason, { auto: true });
}

loadInitialContacts()
  .then(() => {
    messagesPane.syncConversationThreadsFromContacts();
    return messagesPane.refreshConversationPreviews({ force: true });
  })
  .catch((err) => log({ contactsInitError: err?.message || err }))
  .finally(() => {
    messagesPane.renderConversationList();
    ensureWebSocket();
  });

function updateProfileStats() {
  const count = sessionStore.contactIndex.size || sessionStore.contactState.length || 0;
  if (statContactsEl) statContactsEl.textContent = String(count);
  if (contactsCountEl) contactsCountEl.textContent = String(count);
}

function ensureWebSocket() {
  if (wsConn || wsReconnectTimer) return;
  if (!getUidHex()) return;
  connectWebSocket().catch((err) => {
    log({ wsConnectError: err?.message || err });
  });
}

function scheduleWsReconnect(delay = 2000) {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket().catch((err) => {
      log({ wsReconnectError: err?.message || err });
    });
  }, delay);
}

async function getWsAuthToken({ force = false } = {}) {
  const uidHex = getUidHex();
  if (!uidHex) throw new Error('缺少 UID');
  const nowSec = Math.floor(Date.now() / 1000);
  if (!force && wsAuthTokenInfo && wsAuthTokenInfo.token) {
    const exp = Number(wsAuthTokenInfo.expiresAt || 0);
    if (!exp || exp - nowSec > 30) {
      return wsAuthTokenInfo;
    }
  }
  const accountToken = getAccountToken();
  const accountDigest = getAccountDigest();
  const { r, data } = await requestWsToken({ uidHex, accountToken, accountDigest });
  if (!r.ok || !data?.token) {
    const message = typeof data === 'string' ? data : data?.message || data?.error || 'ws token failed';
    throw new Error(message);
  }
  const expiresAt = Number(data.expiresAt || data.exp || 0) || null;
  wsAuthTokenInfo = { token: data.token, expiresAt };
  return wsAuthTokenInfo;
}

async function connectWebSocket() {
  const uid = getUidHex();
  if (!uid) return;
  let tokenInfo;
  try {
    tokenInfo = await getWsAuthToken();
  } catch (err) {
    log({ wsTokenError: err?.message || err });
    scheduleWsReconnect(4000);
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let baseHost = connectionIndicator?.dataset?.wsHost || '';
  let path = connectionIndicator?.dataset?.wsPath || '/api/ws';
  const apiOriginRaw = typeof globalThis !== 'undefined' && typeof globalThis.API_ORIGIN === 'string'
    ? globalThis.API_ORIGIN.trim()
    : '';
  if (apiOriginRaw) {
    try {
      const originUrl = new URL(apiOriginRaw);
      baseHost = originUrl.host || baseHost;
      const prefix = originUrl.pathname && originUrl.pathname !== '/' ? originUrl.pathname.replace(/\/$/, '') : '';
      if (prefix) {
        path = path.startsWith('/') ? `${prefix}${path}` : `${prefix}/${path}`;
      }
    } catch (err) {
      log({ apiOriginParseError: err?.message || err });
    }
  }
  if (!baseHost) baseHost = location.host;
  if (!path.startsWith('/')) path = `/${path}`;
  const ws = new WebSocket(`${proto}//${baseHost}${path}`);
  wsConn = ws;
  updateConnectionIndicator('connecting');
  ws.onopen = () => {
    log({ wsState: 'open' });
    wsReconnectTimer = null;
    try {
      ws.send(JSON.stringify({ type: 'auth', uid, token: tokenInfo.token }));
    } catch (err) {
      log({ wsAuthSendError: err?.message || err });
    }
    if (pendingWsMessages.length) {
      for (const msg of pendingWsMessages.splice(0)) {
        try { ws.send(JSON.stringify(msg)); } catch (err) { log({ wsSendError: err?.message || err }); }
      }
    }
  };
  ws.onmessage = (event) => {
    log({ wsMessageRaw: event.data });
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleWebSocketMessage(msg);
  };
  ws.onclose = (evt) => {
    log({ wsClose: { code: evt.code, reason: evt.reason } });
    wsConn = null;
    updateConnectionIndicator('offline');
    presenceManager.clearPresenceState();
    if (evt.code === 4401) {
      wsAuthTokenInfo = null;
    }
    scheduleWsReconnect();
  };
  ws.onerror = () => {
    log({ wsError: true });
    updateConnectionIndicator('offline');
    wsAuthTokenInfo = null;
    try { ws.close(); } catch {}
  };
}

function wsSend(payload) {
  if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
    pendingWsMessages.push(payload);
    ensureWebSocket();
    return false;
  }
  try {
    wsConn.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    log({ wsSendError: err?.message || err });
    pendingWsMessages.push(payload);
    ensureWebSocket();
    return false;
  }
}

messagesPane.setWsSend(wsSend);
shareController?.setWsSend?.(wsSend);
setCallSignalSender(wsSend);

function updateConnectionIndicator(state) {
  if (!connectionIndicator) return;
  connectionIndicator.classList.remove('online', 'connecting');
  if (state === 'online') {
    connectionIndicator.classList.add('online');
    connectionIndicator.innerHTML = `<span class="dot" aria-hidden="true"></span>在線`;
    return;
  }
  if (state === 'connecting') {
    connectionIndicator.classList.add('connecting');
    connectionIndicator.innerHTML = `<span class="dot" aria-hidden="true"></span>連線中…`;
    return;
  }
  connectionIndicator.innerHTML = `<span class="dot" aria-hidden="true"></span>離線`;
}

function handleWebSocketMessage(msg) {
  const type = msg?.type;
  if (type === 'hello') return;
  if (type === 'auth') {
    if (msg?.ok) updateConnectionIndicator('online');
    else updateConnectionIndicator('offline');
    if (msg?.ok) presenceManager.sendPresenceSubscribe();
    return;
  }
  if (handleCallSignalMessage(msg) || handleCallAuxMessage(msg)) {
    return;
  }
  if (type === 'invite-accepted') {
    if (msg?.inviteId && msg?.fromUid) {
      log({ inviteAcceptedEvent: msg });
    }
    return;
  }
  if (type === 'contact-removed') {
    const peerUid = String(msg?.peerUid || msg?.peer_uid || msg?.uid || '').toUpperCase();
    if (peerUid) {
      try {
        document.dispatchEvent(new CustomEvent('contacts:removed', { detail: { peerUid, notifyPeer: false } }));
      } catch (err) {
        log({ contactRemovedEventError: err?.message || err, peerUid });
      }
    }
    return;
  }
  if (type === 'contact-share') {
    handleContactShareEvent(msg).catch((err) => log({ contactShareError: err?.message || err }));
    return;
  }
  if (type === 'contacts-reload') {
    loadInitialContacts().catch((err) => log({ contactsInitError: err?.message || err }));
    return;
  }
  if (type === 'presence') {
    const online = Array.isArray(msg?.online) ? msg.online : [];
    presenceManager.applyPresenceSnapshot(online);
    return;
  }
  if (type === 'presence-update') {
    const uid = String(msg?.uid || '').trim().toUpperCase();
    if (!uid) return;
    presenceManager.setContactPresence(uid, !!msg?.online);
    return;
  }
  if (type === 'secure-message' || type === 'message-new') {
    messagesPane.handleIncomingSecureMessage(msg);
    return;
  }
}

// Harden autofill: disable autocomplete/autocapitalize/spellcheck on all inputs
(function hardenAutofill(){
  try {
    const els = document.querySelectorAll('input, textarea');
    els.forEach(el => {
      el.setAttribute('autocomplete','off');
      el.setAttribute('autocapitalize','off');
      el.setAttribute('autocorrect','off');
      el.setAttribute('spellcheck','false');
    });
  } catch {}
})();

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) handleBackgroundAutoLogout();
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', (event) => {
    if (logoutInProgress) return;
    if (event && event.persisted) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      handleBackgroundAutoLogout();
    }
  });
}
import { unwrapDevicePrivWithMK } from '../crypto/prekeys.js';
