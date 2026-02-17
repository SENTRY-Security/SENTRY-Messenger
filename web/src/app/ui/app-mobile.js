// /app/ui/app-mobile.js
// Mobile-first App UI with bottom navigation: Contacts, Messages, Drive, Profile.
// Implements Drive tab using existing encrypted media features.

// app lifecycle only. Do not add message pipeline logic; call messages-flow-legacy facade.

import { log, logCapped, logForensicsEvent, setLogSink } from '../core/log.js';

console.info('[App] Version: 2026-01-14T10:55:00Z (Round 11 Fix + Debug)');
import { AUDIO_PERMISSION_KEY } from './login-ui.js';
import { DEBUG } from './mobile/debug-flags.js';
import { flushOutbox } from '../features/queue/outbox.js';
import { setMessagesWsSender } from '../features/messages-support/ws-sender-adapter.js';
import {
  getMkRaw,
  setMkRaw,
  setAccountToken, setAccountDigest,
  setDevicePriv,
  resetAll, clearSecrets,
  drState,
  getDrSessMap,
  getAccountToken,
  getAccountDigest,
  getWrappedMK,
  setWrappedMK,
  getOpaqueServerId,
  normalizePeerIdentity,
  normalizeAccountDigest,
  normalizePeerDeviceId,
  getDeviceId,
  ensureDeviceId,
  clearDrState,
  setBeforeClearDrStateHook
} from '../core/store.js';
import {
  persistContactSecrets,
  lockContactSecrets,
  summarizeContactSecretsPayload,
  computeContactSecretsChecksum,
  getContactSecretsStorageKeys,
  getContactSecretsLatestKeys,
  getContactSecretsMetaKeys,
  getContactSecretsChecksumKeys,
  getLegacyContactSecretsStorageKeys,
  getLegacyContactSecretsLatestKeys,
  getLegacyContactSecretsMetaKeys,
  getLegacyContactSecretsChecksumKeys,
  restoreContactSecrets,
  getLastContactSecretsRestoreSummary,
  getLastContactSecretsRestoreError,
  listCorruptContacts,
  getContactSecret
} from '../core/contact-secrets.js';
import { friendsDeleteContact } from '../api/friends.js';
import { mkUpdate } from '../api/auth.js';
import { loadContacts, saveContact, getLastContactsHydrateSummary, uplinkContactToD1 } from '../features/contacts.js';
import { saveSettings, loadSettings, DEFAULT_SETTINGS } from '../features/settings.js';
import { getSimStoragePrefix, getSimStorageKey } from '../../libs/ntag424-sim.js';
// 加上版本 query 以強制瀏覽器抓最新版（避免舊版 module 快取）
import { SecureStatusController } from './mobile/controllers/secure-status-controller.js';
import { setupShareController } from './mobile/controllers/share-controller.js';
import { initInviteReconciler, reconcileUnconfirmedInvites } from '../features/invite-reconciler.js';
import {
  loadLatestProfile as loadProfileControlState,
  persistProfileForAccount,
  normalizeNickname as normalizeProfileNickname,
  seedProfileCounterOnce,
  PROFILE_WRITE_SOURCE
} from '../features/profile.js';
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
  hydrateConversationsFromSecrets
} from './mobile/session-store.js';
import { clearContactCore, contactCoreCounts, listContactCoreEntries, listReadyContacts, patchContactCore, upsertContactCore } from './mobile/contact-core-store.js';
import { setupModalController } from './mobile/modal-utils.js';
import { createSwipeManager } from './mobile/swipe-utils.js';
import { initProfileCard } from './mobile/profile-card.js';
import { escapeHtml, b64u8 } from './mobile/ui-utils.js';
import { initContactsView } from './mobile/contacts-view.js';
import { createPresenceManager } from './mobile/presence-manager.js';
import { ConversationListController } from './mobile/controllers/conversation-list-controller.js';
import { createToastController } from './mobile/controllers/toast-controller.js';
import { createNotificationAudioManager } from './mobile/notification-audio.js';
import { initMessagesPane } from './mobile/messages-pane.js';
import { initDrivePane } from './mobile/drive-pane.js';
import { hydrateDrStatesFromContactSecrets, persistDrSnapshot } from '../features/dr-session.js';
import { resetAllProcessedMessages } from '../features/messages-support/processed-messages-store.js';
import { resetReceiptStore } from '../features/messages-support/receipt-store.js';
import { messagesFlowFacade, setMessagesFlowFacadeWsSend } from '../features/messages-flow-facade.js';
import { LOCAL_SNAPSHOT_FLUSH_ON_EACH_EVENT } from '../features/restore-policy.js';
import { wrapMKWithPasswordArgon2id, unwrapMKWithPasswordArgon2id } from '../crypto/kdf.js';
import { opaqueRegister } from '../features/opaque.js';
import { requestWsToken } from '../api/ws.js';
import { initVersionInfoButton } from './version-info.js';
import {
  setCallSignalSender,
  handleCallSignalMessage,
  handleCallAuxMessage,
  sendCallSignal,
  initCallKeyManager,
  initCallMediaSession,
  disposeCallMediaSession
} from '../features/calls/index.js';
import { initCallOverlay } from './mobile/call-overlay.js';
import {
  initContactSecretsBackup,
  hydrateContactSecretsFromBackup,
  getLastBackupHydrateResult,
  getLatestBackupMeta
} from '../features/contact-backup.js';
import { subscriptionStatus, redeemSubscription, uploadSubscriptionQr } from '../api/subscription.js';
import { showVersionModal } from './version-info.js';
import QrScanner from '../lib/vendor/qr-scanner.min.js';
import { disableZoom } from './mobile/zoom-disabler.js';
import { createMediaPermissionManager } from './mobile/media-permission-manager.js';
import { createConnectionIndicator } from './mobile/connection-indicator.js';
import { createSubscriptionModule } from './mobile/modals/subscription-modal.js';
import { createSettingsModule } from './mobile/modals/settings-modal.js';
import { createPasswordModal } from './mobile/modals/password-modal.js';
import { createWsIntegration } from './mobile/ws-integration.js';

// --- Loading Modal: report JS modules loaded ---
window.__updateLoadingProgress?.('scripts');

function summarizeMkForLog(mkRaw) {
  const summary = { mkLen: mkRaw instanceof Uint8Array ? mkRaw.length : 0, mkHash12: null };
  if (!(mkRaw instanceof Uint8Array) || typeof crypto === 'undefined' || !crypto.subtle?.digest) return Promise.resolve(summary);
  return crypto.subtle.digest('SHA-256', mkRaw).then((digest) => {
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    summary.mkHash12 = hex.slice(0, 12);
    return summary;
  }).catch(() => summary);
}

setBeforeClearDrStateHook(({ reason } = {}) => {
  if (LOCAL_SNAPSHOT_FLUSH_ON_EACH_EVENT !== true) return;
  try {
    persistContactSecrets();
  } catch (err) {
    log({ contactSecretsPersistError: err?.message || err, reason: reason || 'before-clear-dr' });
  }
});

let mkSetTraceLogged = false;
async function emitMkSetTrace(sourceTag, mkRaw) {
  if (mkSetTraceLogged) return;
  mkSetTraceLogged = true;
  try {
    const { mkLen, mkHash12 } = await summarizeMkForLog(mkRaw);
    log({
      mkSetTrace: {
        sourceTag,
        mkLen,
        mkHash12,
        accountDigestSuffix4: (getAccountDigest() || '').slice(-4) || null,
        deviceIdSuffix4: (getDeviceId() || '').slice(-4) || null
      }
    });
  } catch { }
}

const contactCoreVerbose = DEBUG.contactCoreVerbose === true;
const wsDebugEnabled = DEBUG.ws === true;
const MEDIA_PERMISSION_KEY = 'media-permission-v1';
const out = document.getElementById('out');
setLogSink(out);
try {
  log({ appVersion: window.APP_VERSION || 'unknown', buildAt: window.APP_BUILD_AT || document.lastModified || null });
} catch { }
const BUILD_META = (() => {
  try {
    const version = String(window.APP_VERSION || 'dev');
    const buildAt = String(window.APP_BUILD_AT || document.lastModified || '');
    return { version, buildAt, label: buildAt ? `${version} @ ${buildAt}` : version };
  } catch {
    return { version: 'unknown', buildAt: null, label: 'unknown build' };
  }
})();

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
  'subscription-modal-shell',
  'change-password-modal'
];

let settingsInitPromise = null;

const { showToast, hideToast } = createToastController(document.getElementById('appToast'));
const rootStyle = typeof document !== 'undefined' ? document.documentElement?.style || null : null;

const navbarEl = document.querySelector('.navbar');
const mainContentEl = document.querySelector('main.content');
const navBadges = typeof document !== 'undefined' ? Array.from(document.querySelectorAll('.nav-badge')) : [];
const logoutRedirectCover = document.getElementById('logoutRedirectCover');
let forcedLogoutOverlay = null;
let backgroundLogoutTimer = null;
const SIM_STORAGE_PREFIX = (() => {
  try { return getSimStoragePrefix(); } catch { return 'ntag424-sim:'; }
})();
const SIM_STORAGE_KEY = (() => {
  try { return getSimStorageKey(); } catch { return null; }
})();
const SESSION_LOGIN_TS_KEY = 'session-login-ts';
function getLoginSessionTs() {
  const now = Date.now();
  try {
    if (typeof sessionStorage !== 'undefined') {
      const existing = Number(sessionStorage.getItem(SESSION_LOGIN_TS_KEY) || '');
      let ts = now;
      if (Number.isFinite(existing) && existing > 0 && existing <= now + 3600) {
        ts = Math.max(existing, now); // always move forward to current login time
      }
      sessionStorage.setItem(SESSION_LOGIN_TS_KEY, String(ts));
      return ts;
    }
  } catch { }
  return now;
}

function isSimStorageKey(key) {
  if (!key) return false;
  if (SIM_STORAGE_KEY && key === SIM_STORAGE_KEY) return true;
  if (SIM_STORAGE_PREFIX && key.startsWith(SIM_STORAGE_PREFIX)) return true;
  return false;
}

let reloadNavigationMemo = null;
let reloadNavigationReason = null;
let reloadLogoutTriggered = false;

const LOGOUT_MESSAGE_KEY = 'app:lastLogoutReason';
let logoutInProgress = false;
let _autoLoggedOut = false;
let presenceManager = null;


initContactSecretsBackup();
observeTopbarHeight();

function normalizeOverlayState() {
  const modal = document.getElementById('modal');
  const modalHidden = !modal || modal.getAttribute('aria-hidden') === 'true' || modal.style.display === 'none';
  if (modalHidden && modal && modal.style.display !== 'none') modal.style.display = 'none';
  if (modalHidden) document.body.classList.remove('modal-open');

  const shareModal = document.getElementById('shareModal');
  const shareHidden = !shareModal || shareModal.getAttribute('aria-hidden') === 'true' || shareModal.style.display === 'none';
  if (shareHidden && shareModal && shareModal.style.display !== 'none') shareModal.style.display = 'none';
  if (shareHidden) document.body.classList.remove('modal-open');

  const mediaOverlay = document.getElementById('mediaPermissionOverlay');
  const mediaHidden = !mediaOverlay || mediaOverlay.getAttribute('aria-hidden') === 'true' || mediaOverlay.style.display === 'none';
  if (mediaHidden && mediaOverlay) mediaOverlay.style.display = 'none';
  if (mediaHidden) document.body.classList.remove('media-permission-open');
}

function refreshTopbarOffset() {
  if (!rootStyle) return;
  const topbarEl = document.querySelector('.topbar');
  const height = Math.max(0, topbarEl?.offsetHeight || 0);
  rootStyle.setProperty('--topbar-height', `${height}px`);
  rootStyle.setProperty('--topbar-offset', `${height}px`);
}

function observeTopbarHeight() {
  const topbarEl = document.querySelector('.topbar');
  if (!topbarEl) return;
  refreshTopbarOffset();
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => refreshTopbarOffset());
    ro.observe(topbarEl);
  }
  window.addEventListener('resize', refreshTopbarOffset);
  window.addEventListener('orientationchange', refreshTopbarOffset);
}

let pendingServerOps = 0;
let waitOverlayTimer = null;
let shareController = null;

let unsubscribeSecureStatus = null;
let unsubscribeTimeline = null;

const { setupSwipe, closeSwipe, closeOpenSwipe } = createSwipeManager();

// --- Controller System Integration ---
const audioManager = createNotificationAudioManager({ permissionKey: AUDIO_PERMISSION_KEY });
const resumeNotifyAudioContext = () => audioManager.resume();
const playNotificationSound = () => audioManager.play();
const hasAudioPermission = () => audioManager.hasPermission();

function getContactSecretKeyOptions() {
  return {
    accountDigest: getAccountDigest()
  };
}

function readContactSnapshot(storage, keys = []) {
  if (!storage || !keys?.length) return null;
  for (const key of keys) {
    try {
      const value = storage.getItem(key);
      if (value) return { key, value };
    } catch { }
  }
  return null;
}

function writeContactSnapshot(storage, keys = [], value) {
  if (!storage || !keys?.length || value == null) return;
  for (const key of keys) {
    try { storage.setItem(key, value); } catch { }
  }
}

function removeContactKeys(storage, keys = []) {
  if (!storage || !keys?.length) return;
  for (const key of keys) {
    try { storage.removeItem(key); } catch { }
  }
}

function mergeUniqueKeyLists(...lists) {
  const result = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const key of list) {
      if (!key) continue;
      if (!result.includes(key)) result.push(key);
    }
  }
  return result;
}



function resetMainContentScroll({ smooth = false } = {}) {
  if (!mainContentEl) return;
  try {
    mainContentEl.scrollTo({ top: 0, left: 0, behavior: smooth ? 'smooth' : 'auto' });
  } catch {
    mainContentEl.scrollTop = 0;
  }
}

function ensureTopbarVisible({ repeat = true } = {}) {
  const apply = () => {
    const topbarEl = document.querySelector('.topbar');
    if (!topbarEl) return;
    topbarEl.style.display = '';
    topbarEl.classList.remove('hidden');
    topbarEl.removeAttribute('aria-hidden');
    refreshTopbarOffset();
    normalizeOverlayState();
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
      if (key?.startsWith('contactSecrets-v2')) continue;
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
  const baseKeys = ['mk_b64', 'account_token', 'account_digest', 'wrapped_mk', 'wrapped_dev', LOGOUT_MESSAGE_KEY, SESSION_LOGIN_TS_KEY];
  const opts = getContactSecretKeyOptions();
  const contactKeys = mergeUniqueKeyLists(
    getContactSecretsStorageKeys(opts),
    getContactSecretsStorageKeys({}),
    getContactSecretsLatestKeys(opts),
    getContactSecretsLatestKeys({}),
    getContactSecretsMetaKeys(opts),
    getContactSecretsMetaKeys({}),
    getContactSecretsChecksumKeys(opts),
    getContactSecretsChecksumKeys({}),
    getLegacyContactSecretsStorageKeys(opts),
    getLegacyContactSecretsStorageKeys({}),
    getLegacyContactSecretsLatestKeys(opts),
    getLegacyContactSecretsLatestKeys({}),
    getLegacyContactSecretsMetaKeys(opts),
    getLegacyContactSecretsMetaKeys({}),
    getLegacyContactSecretsChecksumKeys(opts),
    getLegacyContactSecretsChecksumKeys({})
  );
  const keys = [...baseKeys, ...contactKeys];
  for (const key of keys) {
    try { sessionStorage.removeItem(key); } catch { }
  }
}

function clearAllBrowserStorage(logoutMessage) {
  try {
    if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
      caches.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch((err) => log({ secureLogoutCacheClearError: err?.message || err }));
    }
  } catch (err) {
    log({ secureLogoutCacheClearError: err?.message || err });
  }

  try {
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
      indexedDB.databases()
        .then((dbs) => Promise.all(
          dbs
            .map((db) => db?.name)
            .filter((name) => typeof name === 'string' && name.length)
            .map((name) => new Promise((resolve) => {
              try {
                const req = indexedDB.deleteDatabase(name);
                req.onsuccess = () => resolve();
                req.onblocked = () => resolve();
                req.onerror = () => {
                  log({ secureLogoutIndexedDbDeleteError: req.error?.message || req.error || name, name });
                  resolve();
                };
              } catch {
                resolve();
              }
            }))
        ))
        .catch((err) => log({ secureLogoutIndexedDbClearError: err?.message || err }));
    }
  } catch (err) {
    log({ secureLogoutIndexedDbClearError: err?.message || err });
  }

  try { localStorage.clear?.(); } catch (err) { log({ secureLogoutLocalClearError: err?.message || err }); }
  try { sessionStorage.clear?.(); } catch (err) { log({ secureLogoutSessionClearError: err?.message || err }); }

  try { sessionStorage.setItem(LOGOUT_MESSAGE_KEY, logoutMessage || '已登出'); } catch { }
}

async function secureLogout(message = '已登出', { auto = false } = {}) {
  if (logoutInProgress) return;
  logoutInProgress = true;
  _autoLoggedOut = true;

  const safeMessage = message || '已登出';
  const settingsSnapshot = getEffectiveSettingsState();
  const logoutRedirectInfo = getLogoutRedirectInfo(settingsSnapshot);
  const logoutRedirectTarget = logoutRedirectInfo.url;
  if (logoutRedirectInfo.isCustom) {
    showLogoutRedirectCover();
  } else {
    hideLogoutRedirectCover();
  }

  try {
    disposeCallMediaSession();
    await flushDrSnapshotsBeforeLogout('secure-logout');
  } catch (err) {
    log({ contactSecretsSnapshotFlushError: err?.message || err, reason: 'secure-logout-call' });
  }

  // ── 不需要在登出時推送 contact-secrets backup ──
  // 接收鏈在收訊時已透過 Vault Put 保存 message key 並推進 DR 計數器 (Nr)。
  // 即使登出前備份失敗，下次登入的自癒迴圈會自動修復：
  //   1. 伺服器訊息不會因下載而刪除（cursor 分頁，無 auto-delete）
  //   2. 登入時從 vault 還原 DR state → gap-queue 偵測缺口 → 重新拉取未處理訊息
  //   3. DR ratchet 具確定性：同起點 + 同密文 = 同 key，解密必定成功
  //   4. Vault Put 冪等（UNIQUE 約束），重複寫入無副作用
  // 因此登出時的 remote backup 是冗餘的，移除可避免登出延遲與超時風險。
  // 僅保留 persistContactSecrets (本地快照) 與 lockContactSecrets (清除記憶體)。
  try {
    persistContactSecrets();
  } catch (err) {
    log({ contactSecretsPersistError: err?.message || err });
  } finally {
    try {
      lockContactSecrets('secure-logout');
    } catch (err) {
      log({ contactSecretsLockError: err?.message || err });
    }
  }

  wsIntegration.close();
  presenceManager?.clearPresenceState?.();

  try { shareController?.closeShareModal?.(); } catch { }
  resetShareState();
  resetDriveState();
  resetAllProcessedMessages();
  resetReceiptStore();
  resetMessageState();
  resetUiState();
  resetWsState();
  clearContactCore();
  resetContacts();
  resetProfileState();
  resetSettingsState();

  clearSessionHandoff();
  try {
    let localBytes = 0;
    let sessionBytesBefore = 0;
    const keyOptions = getContactSecretKeyOptions();
    const storageKeys = getContactSecretsStorageKeys(keyOptions);
    const latestKeys = getContactSecretsLatestKeys(keyOptions);
    const legacyStorageKeys = getLegacyContactSecretsStorageKeys(keyOptions);
    const legacyLatestKeys = getLegacyContactSecretsLatestKeys(keyOptions);
    const legacyMetaKeys = getLegacyContactSecretsMetaKeys(keyOptions);
    const legacyChecksumKeys = getLegacyContactSecretsChecksumKeys(keyOptions);
    try {
      for (const key of storageKeys) {
        const len = localStorage.getItem(key)?.length || 0;
        if (len > localBytes) localBytes = len;
      }
    } catch { }
    try {
      if (typeof sessionStorage !== 'undefined') {
        for (const key of storageKeys) {
          const len = sessionStorage.getItem(key)?.length || 0;
          if (len > sessionBytesBefore) sessionBytesBefore = len;
        }
      }
    } catch { }
    try { console.log('[contact-secrets-handoff-check]', JSON.stringify({ localBytes, sessionBytesBefore })); } catch { }
    let contactSecretsSnapshot = null;
    let source = 'localStorage';
    const localRecord = readContactSnapshot(localStorage, storageKeys);
    if (localRecord?.value) {
      contactSecretsSnapshot = localRecord.value;
      source = `localStorage:${localRecord.key}`;
    } else if (typeof sessionStorage !== 'undefined') {
      const sessionRecord = readContactSnapshot(sessionStorage, storageKeys);
      if (sessionRecord?.value) {
        contactSecretsSnapshot = sessionRecord.value;
        source = `sessionStorage:${sessionRecord.key}`;
      }
    }
    if (!contactSecretsSnapshot) {
      const legacyLocal = readContactSnapshot(localStorage, legacyStorageKeys);
      const legacySession = typeof sessionStorage !== 'undefined' ? readContactSnapshot(sessionStorage, legacyStorageKeys) : null;
      const legacyRecord = legacyLocal || legacySession;
      if (legacyRecord?.value) {
        contactSecretsSnapshot = legacyRecord.value;
        source = `legacy:${legacyRecord.key}`;
        try { writeContactSnapshot(localStorage, storageKeys, contactSecretsSnapshot); } catch { }
        try { if (typeof sessionStorage !== 'undefined') writeContactSnapshot(sessionStorage, storageKeys, contactSecretsSnapshot); } catch { }
        try { writeContactSnapshot(localStorage, latestKeys, contactSecretsSnapshot); } catch { }
        removeContactKeys(localStorage, [...legacyStorageKeys, ...legacyLatestKeys, ...legacyMetaKeys, ...legacyChecksumKeys]);
        removeContactKeys(sessionStorage, [...legacyStorageKeys, ...legacyLatestKeys, ...legacyMetaKeys, ...legacyChecksumKeys]);
      }
    }
    if (contactSecretsSnapshot && typeof sessionStorage !== 'undefined') {
      writeContactSnapshot(sessionStorage, storageKeys, contactSecretsSnapshot);
      let sessionBytes = null;
      try {
        for (const key of storageKeys) {
          const len = sessionStorage.getItem(key)?.length || 0;
          if (len > sessionBytes) sessionBytes = len;
        }
      } catch { sessionBytes = null; }
      writeContactSnapshot(localStorage, latestKeys, contactSecretsSnapshot);
      try {
        if (typeof window !== 'undefined') {
          if (!window.__LOGIN_SEED_LOCALSTORAGE || typeof window.__LOGIN_SEED_LOCALSTORAGE !== 'object') {
            window.__LOGIN_SEED_LOCALSTORAGE = {};
          }
          storageKeys.forEach((key) => { window.__LOGIN_SEED_LOCALSTORAGE[key] = contactSecretsSnapshot; });
          latestKeys.forEach((key) => { window.__LOGIN_SEED_LOCALSTORAGE[key] = contactSecretsSnapshot; });
        }
      } catch { }
      const meta = persistContactSecretMetadata({ snapshot: contactSecretsSnapshot, source, keyOptions });
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
      } catch { }
    } else if (!contactSecretsSnapshot) {
      persistContactSecretMetadata({ snapshot: null, source: 'missing', keyOptions });
      log({ contactSecretsHandoffStored: 0, contactSecretsHandoffSource: 'missing' });
    }
  } catch (err) {
    log({ contactSecretsHandoffError: err?.message || err });
  }
  clearLocalEncryptedCaches();
  clearAllBrowserStorage(safeMessage);

  try { resetAll(); } catch (err) {
    log({ secureLogoutResetError: err?.message || err });
    try { clearSecrets(); } catch { }
  }

  if (!auto) {
    try { showToast?.(safeMessage); } catch { }
  }

  setTimeout(() => {
    try { location.replace(logoutRedirectTarget); } catch { location.href = logoutRedirectTarget; }
  }, 60);
}

function showForcedLogoutModal(message = '帳號已在其他裝置登入') {
  try {
    if (forcedLogoutOverlay && forcedLogoutOverlay.parentElement) {
      forcedLogoutOverlay.parentElement.removeChild(forcedLogoutOverlay);
    }
    const wrap = document.createElement('div');
    wrap.className = 'forced-logout-overlay';
    Object.assign(wrap.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(15,23,42,0.65)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '2000',
      padding: '16px'
    });
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#fff',
      color: '#0f172a',
      padding: '20px 22px',
      borderRadius: '14px',
      width: 'min(420px, 92vw)',
      boxShadow: '0 16px 48px rgba(0,0,0,0.25)',
      textAlign: 'center'
    });
    const title = document.createElement('div');
    Object.assign(title.style, { fontSize: '16px', fontWeight: '700', marginBottom: '8px' });
    title.textContent = '安全提示';
    const msg = document.createElement('div');
    Object.assign(msg.style, { fontSize: '14px', lineHeight: '1.6', marginBottom: '16px' });
    msg.textContent = message;
    const hint = document.createElement('div');
    Object.assign(hint.style, { fontSize: '12px', color: '#475569' });
    hint.textContent = '將登出此裝置，請重新感應晶片登入。';
    panel.appendChild(title);
    panel.appendChild(msg);
    panel.appendChild(hint);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);
    forcedLogoutOverlay = wrap;
  } catch (err) {
    log({ forcedLogoutOverlayError: err?.message || err });
  }
}

if (typeof window !== 'undefined') {
  try { window.secureLogout = secureLogout; } catch { }
}

function isReloadNavigation() {
  if (reloadNavigationMemo !== null) return reloadNavigationMemo;
  let detected = false;
  let reason = null;
  try {
    if (typeof performance !== 'undefined') {
      if (typeof performance.getEntriesByType === 'function') {
        const entries = performance.getEntriesByType('navigation');
        if (entries && entries.length) {
          const latest = entries[entries.length - 1];
          const type = (latest?.type || '').toLowerCase();
          if (type === 'reload' || type === 'back_forward') {
            detected = true;
            reason = `navigation-entry:${type}`;
          }
        }
      }
      if (!detected && performance.navigation) {
        const navType = Number(performance.navigation.type);
        const reloadConst = typeof performance.navigation.TYPE_RELOAD === 'number'
          ? performance.navigation.TYPE_RELOAD
          : 1;
        if (navType === reloadConst || navType === 1) {
          detected = true;
          reason = 'performance.navigation';
        }
      }
    }
    if (!detected && typeof document !== 'undefined' && typeof location !== 'undefined') {
      const ref = document.referrer || '';
      if (ref && location.href && ref === location.href) {
        detected = true;
        reason = 'referrer-match';
      }
    }
  } catch (err) {
    log({ reloadNavigationDetectError: err?.message || err });
  }
  reloadNavigationMemo = detected;
  if (detected) reloadNavigationReason = reason;
  return reloadNavigationMemo;
}

function forceReloadLogout(message = '重新整理後已自動登出') {
  if (reloadLogoutTriggered) return;
  reloadLogoutTriggered = true;
  try {
    secureLogout(message, { auto: true });
  } catch (err) {
    log({ forceReloadLogoutError: err?.message || err });
  }
}

(function enforceReloadLogoutOnLoad() {
  if (!isReloadNavigation()) return;
  log({ reloadNavigationDetected: reloadNavigationReason || true });
  forceReloadLogout();
})();

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

function persistContactSecretMetadata({ snapshot, source, keyOptions }) {
  const opts = keyOptions || getContactSecretKeyOptions();
  const metaKeys = getContactSecretsMetaKeys(opts);
  const checksumKeys = getContactSecretsChecksumKeys(opts);
  const legacyMetaKeys = getLegacyContactSecretsMetaKeys(opts);
  const legacyChecksumKeys = getLegacyContactSecretsChecksumKeys(opts);
  if (!snapshot || typeof snapshot !== 'string') {
    removeContactKeys(sessionStorage, [...metaKeys, ...checksumKeys, ...legacyMetaKeys, ...legacyChecksumKeys]);
    removeContactKeys(localStorage, [...metaKeys, ...checksumKeys, ...legacyMetaKeys, ...legacyChecksumKeys]);
    return null;
  }
  const summary = summarizeContactSecretsPayload(snapshot);
  const meta = {
    ...summary,
    source: source || 'unknown',
    ts: Date.now()
  };
  const metaJson = JSON.stringify(meta);
  writeContactSnapshot(sessionStorage, metaKeys, metaJson);
  writeContactSnapshot(localStorage, metaKeys, metaJson);
  removeContactKeys(sessionStorage, [...legacyMetaKeys, ...legacyChecksumKeys]);
  removeContactKeys(localStorage, [...legacyMetaKeys, ...legacyChecksumKeys]);
  try {
    window.__CONTACT_SECRETS_META__ = meta;
  } catch { }
  log({ contactSecretsSnapshotSummary: meta });
  computeContactSecretsChecksum(snapshot)
    ?.then((checksum) => {
      if (!checksum) return;
      const detail = {
        ...meta,
        checksumAlgo: checksum.algorithm || 'unknown',
        checksum: checksum.value || null
      };
      const checksumJson = JSON.stringify(detail);
      writeContactSnapshot(sessionStorage, checksumKeys, checksumJson);
      writeContactSnapshot(localStorage, checksumKeys, checksumJson);
      try {
        window.__CONTACT_SECRETS_CHECKSUM__ = detail;
      } catch { }
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
  const startedAt = Date.now();
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
  logCapped('contactSecretsSnapshotFlushStartTrace', {
    reason,
    peers: peerSet.size
  }, 5);
  let attempted = 0;
  let persisted = 0;
  const missingState = [];
  for (const peerKey of peerSet) {
    attempted += 1;
    let identity = null;
    try {
      identity = normalizePeerIdentity(peerKey);
    } catch (err) {
      missingState.push(peerKey);
      log({ contactSecretsSnapshotFlushError: err?.message || err, reason });
      continue;
    }
    const peerAccountDigest = identity?.accountDigest || null;
    const peerDeviceId = identity?.deviceId || null;
    if (!peerAccountDigest || !peerDeviceId) {
      missingState.push(peerKey);
      continue;
    }
    try {
      const state = drState({ peerAccountDigest, peerDeviceId });
      if (state?.rk) {
        if (persistDrSnapshot({ peerAccountDigest, peerDeviceId, state })) {
          persisted += 1;
        } else {
          missingState.push(peerKey);
        }
      } else {
        missingState.push(peerKey);
      }
    } catch (err) {
      missingState.push(peerKey);
      log({ contactSecretsSnapshotFlushError: err?.message || err, reason });
    }
  }
  try {
    persistContactSecrets();
  } catch (err) {
    log({ contactSecretsPersistError: err?.message || err, reason: 'flushDrSnapshotsBeforeLogout' });
  }
  // remote backup 已移除 — 理由同 secureLogout 註解：
  // 自癒迴圈保證下次登入能從 vault 還原 + gap-fill 重新解密，不需要在登出時推送。
  logCapped('contactSecretsSnapshotFlushDoneTrace', {
    reason,
    peers: peerSet.size,
    attempted,
    persisted,
    missingStateCount: missingState.length,
    tookMs: Math.max(0, Date.now() - startedAt)
  }, 5);
  log({
    contactSecretsSnapshotFlush: {
      reason,
      peers: peerSet.size,
      attempted,
      persisted,
      missingState
    }
  });
}

function flushContactSecretsLocal(reason = 'manual') {
  if (LOCAL_SNAPSHOT_FLUSH_ON_EACH_EVENT !== true) return;
  try {
    persistContactSecrets();
  } catch (err) {
    log({ contactSecretsPersistError: err?.message || err, reason });
  }
}



// Restore MK/UID from sessionStorage handoff (login → app)
(function restoreMkAndUidFromSession() {
  try {
    const mkb64 = sessionStorage.getItem('mk_b64');
    const accountToken = sessionStorage.getItem('account_token');
    const accountDigest = sessionStorage.getItem('account_digest');
    const wrappedMkRaw = sessionStorage.getItem('wrapped_mk');
    log({
      restoreSession: {
        mk: !!mkb64,
        accountToken: !!accountToken,
        accountDigest: !!accountDigest,
        wrappedMk: !!wrappedMkRaw
      }
    });
    const identityKey = accountDigest || null;
    if (identityKey) setAccountDigest(identityKey);
    if (accountToken) setAccountToken(accountToken);
    if (mkb64 && !getMkRaw()) {
      const mk = b64u8(mkb64);
      setMkRaw(mk);
      emitMkSetTrace('app-mobile:handoff', mk);
    }
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
    sessionStorage.removeItem('account_token');
    sessionStorage.removeItem('account_digest');
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
        } catch { }
      }
      if (!serialized && typeof window !== 'undefined' && window.name) {
        try {
          const handoff = JSON.parse(window.name);
          if (handoff && handoff.wrapped_dev) {
            serialized = JSON.stringify(handoff.wrapped_dev);
          }
        } catch { }
        try { window.name = ''; } catch { }
      }
      if (!serialized) {
        let sessionKeys = null;
        try {
          sessionKeys = [];
          for (let i = 0; i < sessionStorage.length; i += 1) {
            sessionKeys.push(sessionStorage.key(i));
          }
        } catch { }
        log({ devicePrivRestoreSkipped: 'session-missing', sessionKeys });
        return;
      }
      log({ devicePrivRestoreFallback: restoredFromLocal ? 'localStorage' : 'unknown-source' });
    } else {
      try {
        localStorage?.setItem?.('wrapped_dev_handoff', serialized);
      } catch { }
      try { window.name = ''; } catch { }
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
          try { localStorage?.removeItem?.('wrapped_dev_handoff'); } catch { }
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

// Guard: require MK
(function ensureUnlockedOrRedirect() {
  if (!getMkRaw()) {
    log('Not unlocked: redirecting to /pages/logout.html …');
    secureLogout('登入資訊已失效，請重新感應晶片', { auto: true });
  }
})();

// Navigation
const tabs = ['contacts', 'messages', 'drive', 'profile'];
let currentTab = 'drive';
function switchTab(name, options = {}) {
  currentTab = name;
  normalizeOverlayState();
  resetMainContentScroll({ smooth: false });
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
      state.viewMode = state.activePeerDigest ? 'detail' : 'list';
    }
    if (options.fromBack && !isDesktop) {
      state.viewMode = 'list';
    }
    messagesPane.syncConversationThreadsFromContacts();
    messagesPane.refreshConversationPreviews({ force: true }).catch((err) => log({ conversationPreviewRefreshError: err?.message || err }));
    messagesPane.renderConversationList();
    const isAutomation = typeof navigator !== 'undefined' && !!navigator.webdriver;
    if (options.fromBack && !isDesktop && isAutomation && state.activePeerDigest) {
      messagesPane.showDeleteForPeer(state.activePeerDigest);
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
const userMenuSubscriptionBtn = userMenuDropdown?.querySelector('[data-action="subscription"]') || null;
const userMenuSubscriptionBadge = userMenuSubscriptionBtn?.querySelector('.menu-item-badge') || null;
const userMenuVersionBtn = userMenuDropdown?.querySelector('[data-action="version-info"]') || null;
const userMenuVersionPopup = document.getElementById('versionInfoPopupAppMenu');
const userMenuVersionModalBtn = document.getElementById('userMenuVersionBtn');
const userMenuLogoutBtn = userMenuDropdown?.querySelector('[data-action="logout"]') || null;
const userMenuBadge = document.getElementById('userMenuBadge');
const userAvatarWrap = document.getElementById('userAvatarWrap');

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

userMenuSubscriptionBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  openSubscriptionModal();
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
const inviteRefreshBtn = document.getElementById('inviteRefreshBtn');
const inviteRetryBtn = document.getElementById('inviteRetryBtn');
const inviteConsumeBtn = document.getElementById('inviteConsumeBtn');
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
const contactsSearchEl = document.getElementById('contactsSearch');
const contactsRefreshEl = document.getElementById('contactsRefreshHint');
const contactsRefreshLabel = contactsRefreshEl?.querySelector('.label') || null;
const connectionIndicator = document.getElementById('connectionIndicator');
const btnUp = document.getElementById('btnUp');
const btnNewFolder = document.getElementById('btnNewFolder');
const { shareState } = sessionStore;

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

// --- Extracted modules: Phase 1 ---
const mediaPermissionMgr = createMediaPermissionManager({
  overlay: document.getElementById('mediaPermissionOverlay'),
  allowBtn: document.getElementById('mediaPermissionAllowBtn'),
  allowLabel: document.getElementById('mediaPermissionAllowLabel'),
  skipBtn: document.getElementById('mediaPermissionSkipBtn'),
  debugBtn: document.getElementById('mediaPermissionDebugBtn'),
  statusEl: document.getElementById('mediaPermissionStatus'),
  mediaPermissionKey: MEDIA_PERMISSION_KEY,
  audioPermissionKey: AUDIO_PERMISSION_KEY,
  deps: { log, showToast, sessionStore, resumeNotifyAudioContext, audioManager }
});
let _mediaPermissionNeeded = false;
const initMediaPermissionPrompt = () => {
  const result = mediaPermissionMgr.init();
  _mediaPermissionNeeded = result?.permissionNeeded ?? false;
};

const connIndicator = createConnectionIndicator(connectionIndicator);
const updateConnectionIndicator = (state) => connIndicator.update(state);

function resetModalVariants(modalElement) {
  modalElement.classList.remove(...MODAL_VARIANTS);
}

function showLogoutRedirectCover() {
  if (!logoutRedirectCover) return;
  logoutRedirectCover.classList.add('show');
  logoutRedirectCover.setAttribute('aria-hidden', 'false');
}

function hideLogoutRedirectCover() {
  if (!logoutRedirectCover) return;
  logoutRedirectCover.classList.remove('show');
  logoutRedirectCover.setAttribute('aria-hidden', 'true');
}

hideLogoutRedirectCover();

// --- Extracted modules: Phase 2 ---
const passwordModal = createPasswordModal({
  deps: {
    log, openModal, closeModal, resetModalVariants, emitMkSetTrace,
    getWrappedMK, setWrappedMK, setMkRaw,
    unwrapMKWithPasswordArgon2id, wrapMKWithPasswordArgon2id,
    getAccountToken, getAccountDigest, getOpaqueServerId,
    mkUpdate, opaqueRegister
  }
});
const openChangePasswordModal = () => passwordModal.open();

const settingsMod = createSettingsModule({
  deps: {
    log, showToast, sessionStore, openModal, closeModal, resetModalVariants,
    DEFAULT_SETTINGS, saveSettings, loadSettings,
    getMkRaw, getAccountDigest,
    openChangePasswordModal
  }
});
const getEffectiveSettingsState = () => settingsMod.getEffective();
const bootLoadSettings = () => settingsMod.bootLoad();
const isSettingsConversationId = (convId) => settingsMod.isSettingsConvId(convId);
const handleSettingsSecureMessage = () => settingsMod.handleSecureMessage();
const getLogoutRedirectInfo = (settings) => settingsMod.getRedirectInfo(settings);
const openSystemSettingsModal = () => settingsMod.open();

const subscriptionMod = createSubscriptionModule({
  deps: {
    showToast, log, sessionStore, openModal, closeModal, resetModalVariants,
    subscriptionStatus, redeemSubscription, uploadSubscriptionQr, QrScanner,
    userAvatarWrap, userMenuBadge, userMenuSubscriptionBadge
  }
});
const openSubscriptionModal = () => subscriptionMod.open();
const refreshSubscriptionStatus = (opts) => subscriptionMod.refreshStatus(opts);
const showSubscriptionGateModal = () => subscriptionMod.showGateModal();

document.addEventListener('subscription:gate', showSubscriptionGateModal);

disableZoom();

settingsInitPromise = bootLoadSettings()
  .catch((err) => {
    log({ settingsBootError: err?.message || err });
    const fallback = { ...DEFAULT_SETTINGS, updatedAt: Date.now() };
    if (!sessionStore.settingsState) sessionStore.settingsState = fallback;
    return sessionStore.settingsState || fallback;
  });
settingsMod.initPromise = settingsInitPromise;

initVersionInfoButton({
  buttonId: 'userMenuVersionBtn',
  popupId: 'versionInfoPopupAppMenu',
  openModal,
  closeModal
});

// 讓主畫面選單的版本資訊強制使用 modal（同登入頁）
if (userMenuVersionBtn) {
  userMenuVersionBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showVersionModal({ openModal, closeModal });
  });
}

setTimeout(() => {
  refreshSubscriptionStatus({ silent: true });
  if (drivePane?.showSubscriptionGateIfExpired) drivePane.showSubscriptionGateIfExpired();
}, 1200);



let removeContactLocalFn = () => { };

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
initCallKeyManager();
initCallMediaSession({
  sendSignalFn: (type, payload) => sendCallSignal(type, payload),
  showToastFn: showToast
});
initMediaPermissionPrompt();

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
  try { window.__messagesPane = messagesPane; } catch { }
  window.addEventListener('resize', () => messagesPane.updateLayoutMode());
}
document.addEventListener('contacts:rendered', () => messagesPane.renderConversationList());
document.addEventListener('contacts:open-conversation', (event) => {
  const detail = event?.detail || {};
  messagesPane.handleContactOpenConversation(detail);
});
document.addEventListener('contacts:entry-updated', (event) => {
  const detail = event?.detail || {};
  if (typeof messagesPane.handleContactEntryUpdated === 'function') {
    messagesPane.handleContactEntryUpdated(detail);
  }
  if (typeof messagesPane.renderConversationList === 'function') {
    messagesPane.renderConversationList();
  }
  updateProfileStats();
});
document.addEventListener('contacts:removed', () => {
  updateProfileStats();
});
document.addEventListener('subscription:state', () => {
  if (typeof messagesPane.updateComposerAvailability === 'function') {
    messagesPane.updateComposerAvailability();
  }
  if (typeof drivePane.updateDriveActionAvailability === 'function') {
    drivePane.updateDriveActionAvailability();
  }
});
document.addEventListener('contacts:broadcast-update', async (event) => {
  if (!shareController || typeof shareController.broadcastContactUpdate !== 'function') return;
  const detail = event?.detail || {};
  const targets = Array.isArray(detail?.targetPeers)
    ? detail.targetPeers
    : detail?.peerAccountDigest
      ? [detail.peerAccountDigest]
      : [];
  try {
    await shareController.broadcastContactUpdate({
      reason: detail?.reason || 'manual',
      targetPeers: targets,
      overrides: detail?.overrides || null
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
presenceManager = createPresenceManager({
  contactsListEl,
  wsSend: (payload) => wsIntegration.send(payload)
});

const contactsView = initContactsView({
  dom: { contactsListEl, contactsScrollEl, contactsSearchEl, contactsRefreshEl, contactsRefreshLabel, contactsCountEl },
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
      const result = await messagesFlowFacade.onPullToRefreshContacts({
        loadInitialContacts,
        renderContacts
      });
      if (result?.ok === false) {
        log({ contactsRefreshError: result.errorMessage || 'unknown', source: '__refreshContacts' });
      }
    };
    window.__debugDumpPostLogin = () => logRestoreOverview({ reason: 'manual', force: true });
  } catch { }
}

let contactSecretsRefreshInFlight = false;
let postLoginHydrateInFlight = false;
let readyCountLogged = false;
let restoreOverviewLogged = false;
const contactDiagLoggedKeys = new Set();
document.addEventListener('contactSecrets:restored', async () => {
  if (contactSecretsRefreshInFlight) return;
  contactSecretsRefreshInFlight = true;
  const result = await messagesFlowFacade.onPullToRefreshContacts({
    loadInitialContacts,
    syncConversationThreadsFromContacts: messagesPane.syncConversationThreadsFromContacts,
    refreshConversationPreviews: messagesPane.refreshConversationPreviews,
    onError: (err) => log({ contactsInitError: err?.message || err, source: 'contactSecrets:restored' }),
    onFinally: () => {
      try { messagesPane.renderConversationList(); } catch { }
      contactSecretsRefreshInFlight = false;
    }
  });
  if (result?.ok === false) {
    log({ contactsInitError: result.errorMessage || 'unknown', source: 'contactSecrets:restored' });
  }
});

function summarizeTokenForDiag(token) {
  if (!token) return { len: 0 };
  const raw = String(token);
  return { len: raw.length, prefix6: raw.slice(0, 6), suffix6: raw.slice(-6) };
}

function buildCorruptContactReasonMap() {
  const out = new Map();
  const list = typeof listCorruptContacts === 'function' ? listCorruptContacts() : [];
  for (const entry of Array.isArray(list) ? list : []) {
    const digest = normalizeAccountDigest(entry?.peerAccountDigest || entry?.peerKey || entry) || null;
    const dev = normalizePeerDeviceId(entry?.peerDeviceId || null);
    const reason = entry?.reason || 'corrupt';
    if (digest && dev) out.set(`${digest}::${dev}`, reason);
    if (digest) out.set(digest, reason);
  }
  return out;
}

function logContactCoreDiagnostics({ force = false, limit = 20 } = {}) {
  try {
    if (force) contactDiagLoggedKeys.clear();
    const corruptMap = buildCorruptContactReasonMap();
    const entries = listContactCoreEntries({ limit: Math.max(0, limit || 0) }) || [];
    const targets = entries.slice(0, limit || 20);
    let idx = 0;
    for (const entry of targets) {
      const key = entry?.peerKey || entry?.peerAccountDigest || `idx:${idx}`;
      idx += 1;
      if (!force && contactDiagLoggedKeys.has(key)) continue;
      contactDiagLoggedKeys.add(key);
      const missing = [];
      if (!entry?.peerKey) missing.push('peerKey');
      if (!entry?.peerAccountDigest) missing.push('peerAccountDigest');
      if (!entry?.peerDeviceId) missing.push('peerDeviceId');
      if (!entry?.conversationId) missing.push('conversationId');
      if (!entry?.conversationToken) missing.push('conversationToken');
      let hasDrSnapshot = false;
      try {
        const secret = getContactSecret?.(entry?.peerKey || entry?.peerAccountDigest || null, { peerDeviceId: entry?.peerDeviceId }) || null;
        if (secret?.drState) hasDrSnapshot = true;
        if (Array.isArray(secret?.drHistory) && secret.drHistory.length > 0) hasDrSnapshot = true;
        if (secret?.drSeed) hasDrSnapshot = true;
      } catch { }
      const corruptReason = corruptMap.get(entry?.peerKey) || corruptMap.get(entry?.peerAccountDigest || '') || null;
      const payload = {
        event: 'contact-core',
        peerKey: entry?.peerKey || null,
        peerAccountDigest: entry?.peerAccountDigest || null,
        peerDeviceId: entry?.peerDeviceId || null,
        conversationId: entry?.conversationId || null,
        conversationToken: summarizeTokenForDiag(entry?.conversationToken || entry?.conversation?.token_b64 || null),
        hasDrInit: !!(entry?.drInit || entry?.conversation?.dr_init),
        hasDrSnapshot,
        sourceTag: entry?.sourceTag || null,
        isReady: !!entry?.isReady,
        isPending: !entry?.isReady && !corruptReason,
        isCorrupt: !!corruptReason,
        missingCoreFields: missing,
        corruptReason: corruptReason || null
      };
      console.info('[diag] ' + JSON.stringify(payload));
    }
  } catch (err) {
    try { console.info('[diag] ' + JSON.stringify({ event: 'contact-core-log-error', error: err?.message || err })); } catch { }
  }
}

async function logRestoreOverview({ reason = 'post-login', force = false } = {}) {
  if (restoreOverviewLogged && !force) return;
  if (force) contactDiagLoggedKeys.clear();
  restoreOverviewLogged = true;
  try {
    if (profileInitPromise?.then) {
      await profileInitPromise.catch(() => { });
    }
  } catch { }
  try {
    const counts = contactCoreCounts();
    const corruptCount = (sessionStore?.corruptContacts instanceof Map) ? sessionStore.corruptContacts.size : 0;
    const restoreSummary = getLastContactSecretsRestoreSummary?.() || null;
    const backupHydrate = getLastBackupHydrateResult?.() || null;
    const backupMeta = getLatestBackupMeta?.() || null;
    const contactsHydrate = getLastContactsHydrateSummary?.() || null;
    const profileState = sessionStore?.profileState || null;
    const overview = {
      event: 'restore-overview',
      reason,
      hasMk: !!getMkRaw(),
      hasAccountDigest: !!getAccountDigest(),
      hasAccountToken: !!getAccountToken(),
      selfDeviceId: getDeviceId() || ensureDeviceId() || null,
      contactCore: {
        readyCount: counts.ready,
        pendingCount: counts.pending,
        corruptCount
      },
      contactSecretsRestoreSummary: restoreSummary ? {
        entries: restoreSummary.entries ?? null,
        bytes: restoreSummary.bytes ?? null,
        parseError: restoreSummary.parseError || getLastContactSecretsRestoreError?.() || null
      } : null,
      remoteBackupHydrate: backupHydrate ? {
        status: backupHydrate.status ?? null,
        ok: !!backupHydrate.ok,
        entries: backupHydrate.entries ?? null,
        corruptCount: backupHydrate.corruptCount ?? null,
        snapshotVersion: backupHydrate.snapshotVersion || backupMeta?.snapshotVersion || null,
        backupVersion: backupMeta?.backupVersion || backupHydrate?.backupMeta?.version || null,
        backupUpdatedAt: backupMeta?.updatedAt || backupHydrate?.backupMeta?.updatedAt || null
      } : (backupMeta ? {
        status: null,
        ok: false,
        entries: null,
        corruptCount: null,
        snapshotVersion: backupMeta?.snapshotVersion || null,
        backupVersion: backupMeta?.backupVersion || null,
        backupUpdatedAt: backupMeta?.updatedAt || null
      } : null),
      contactsFetch: contactsHydrate ? {
        status: contactsHydrate.status ?? null,
        itemCount: contactsHydrate.itemCount ?? null,
        decryptOkCount: contactsHydrate.decryptOkCount ?? null,
        missingPeerDeviceCount: contactsHydrate.missingPeerDeviceCount ?? null,
        missingConvFieldsCount: contactsHydrate.missingConvFieldsCount ?? null
      } : null,
      profileHydrate: {
        ok: !!profileState,
        nicknamePresent: !!(profileState && normalizeProfileNickname(profileState.nickname || '')),
        avatarEnvPresent: !!profileState?.avatar?.env
      }
    };
    console.info('[diag] ' + JSON.stringify(overview));
  } catch (err) {
    try { console.info('[diag] ' + JSON.stringify({ event: 'restore-overview-error', error: err?.message || err })); } catch { }
  } finally {
    logContactCoreDiagnostics({ force });
  }
}

async function hydrateDrSnapshotsAfterBackup() {
  try {
    return hydrateDrStatesFromContactSecrets({ source: 'post-login-hydrate' });
  } catch (err) {
    log({ drSnapshotHydrateError: err?.message || err, source: 'post-login-hydrate' });
    return { restoredCount: 0, skippedCount: 0, errorCount: 1 };
  }
}

async function runPostLoginContactHydrate() {
  if (postLoginHydrateInFlight) return;
  postLoginHydrateInFlight = true;
  contactSecretsRefreshInFlight = true;
  const mk = getMkRaw();
  const secrets = restoreContactSecrets();
  const hasLocalSecrets = secrets instanceof Map && secrets.size > 0;
  const willFetchRemote = !!mk;
  if (contactCoreVerbose) {
    try { console.log('[contact-core] hydrate:start ' + JSON.stringify({ hasMk: !!mk, hasLocalSecrets, willFetchRemote })); } catch { }
  }
  let remoteResult = { ok: false, status: null, entries: 0, corruptCount: 0 };
  const restorePerformedInLogin = sessionStorage.getItem('contact_restore_performed') === '1';
  if (restorePerformedInLogin) {
    sessionStorage.removeItem('contact_restore_performed');
    if (contactCoreVerbose) {
      try { console.log('[contact-core] hydrate:skip (performed in login)'); } catch { }
    }
    // Fake a success result for logging consistency
    remoteResult = { ok: true, status: 'skipped-login', entries: secrets.size, corruptCount: 0 };
  } else if (willFetchRemote) {
    // [FIX] Optimistic Local Hydration:
    // Load local secrets into memory IMMEDIATELY before awaiting network.
    // This prevents the "Hydration Gap" where _DR_SESS is empty during the network request.
    if (hasLocalSecrets) {
      try {
        await hydrateDrSnapshotsAfterBackup();
        if (contactCoreVerbose) console.log('[contact-core] hydrate:optimistic-local-done');
      } catch (err) {
        log({ drSnapshotHydrateError: err?.message || err, source: 'optimistic-local-hydrate' });
      }
    }

    try {
      remoteResult = await hydrateContactSecretsFromBackup({ reason: 'post-login-hydrate' });
    } catch (err) {
      log({ contactSecretsHydrateError: err?.message || err });
    }
  }
  if (remoteResult?.corrupt || remoteResult?.corruptBackup) {
    showToast?.('備份損壞，需重新同步/重新邀請', { variant: 'error' });
  }
  if (contactCoreVerbose) {
    try {
      console.log('[contact-core] hydrate:remote ' + JSON.stringify({
        ok: !!remoteResult?.ok,
        status: remoteResult?.status ?? null,
        entries: remoteResult?.entries ?? 0,
        corruptCount: remoteResult?.corruptCount ?? 0
      }));
    } catch { }
  }
  try {
    await hydrateDrSnapshotsAfterBackup();
  } catch (err) {
    log({ drSnapshotHydrateError: err?.message || err, source: 'post-login-hydrate' });
  }
  let loadError = null;
  try {
    await loadInitialContacts();
  } catch (err) {
    loadError = err;
  } finally {
    contactSecretsRefreshInFlight = false;
    postLoginHydrateInFlight = false;
  }
  const counts = contactCoreCounts();
  if (!readyCountLogged) {
    readyCountLogged = true;
    if (contactCoreVerbose) {
      try { console.log('[contact-core] ready-count ' + JSON.stringify({ count: counts.ready, pendingCount: counts.pending, source: 'post-login-hydrate' })); } catch { }
    }
  }
  if (contactCoreVerbose) {
    try { console.log('[contact-core] hydrate:done ' + JSON.stringify({ readyCount: counts.ready, pendingCount: counts.pending })); } catch { }
  }
  if (loadError) throw loadError;
}

async function addContactEntry(contact) {
  const peerDigest =
    contact?.peerAccountDigest ||
    contact?.accountDigest ||
    contact?.peer ||
    null;
  console.log('[app-mobile]', {
    contactAddWrapperStart: {
      peerAccountDigest: peerDigest || null,
      hasConversation: !!(contact?.conversation?.conversation_id && contact?.conversation?.token_b64),
      hasSecret: !!contact?.contactSecret || !!contact?.contact_secret
    }
  });
  try {
    const result = await addContactEntryRaw(contact);
    console.log('[app-mobile]', {
      contactAddWrapperDone: {
        peerAccountDigest: peerDigest || null,
        msgId: result?.msgId || result?.id || null,
        conversationId: result?.conversation?.conversation_id || null
      }
    });
    messagesPane.syncConversationThreadsFromContacts();
    messagesPane.renderConversationList();
    messagesPane.refreshConversationPreviews({ force: true }).catch((err) =>
      log({ conversationPreviewRefreshError: err?.message || err })
    );
    return result;
  } catch (err) {
    console.error('[app-mobile]', { contactAddWrapperError: err?.message || err, peerAccountDigest: peerDigest || null });
    throw err;
  }
}

function removeContactLocal(peerAccountDigest) {
  removeContactLocalRaw?.(peerAccountDigest);
  shareController?.removeContactSecret?.(peerAccountDigest);
  messagesPane.syncConversationThreadsFromContacts();
  messagesPane.renderConversationList();
}

removeContactLocalFn = (peerAccountDigest) => removeContactLocal(peerAccountDigest);

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
    inviteRefreshBtn,
    inviteRetryBtn,
    inviteConsumeBtn,
    btnShareModal,
    shareModal,
    shareModalBackdrop,
    btnShareSwitchScan,
    btnShareSwitchQr,
    shareFlip,
    inviteScanVideo,
    inviteScanStatus
  },
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
  try { window.__shareController = shareController; } catch { }
}

const {
  handleContactInitEvent,
  closeShareModal
} = shareController;

initInviteReconciler({ handleContactInitEvent });

// --- WebSocket integration ---
const wsIntegration = createWsIntegration({
  deps: {
    log, logForensicsEvent, wsDebugEnabled,
    getAccountDigest, getAccountToken, getLoginSessionTs,
    normalizePeerIdentity, normalizeAccountDigest, normalizePeerDeviceId,
    getDeviceId, ensureDeviceId, getContactSecret,
    sessionStore, requestWsToken, flushOutbox,
    handleCallSignalMessage, handleCallAuxMessage,
    messagesFlowFacade,
    updateConnectionIndicator,
    isSettingsConversationId,
    handleSettingsSecureMessage,
    connectionIndicatorEl: connectionIndicator,
    getPresenceManager: () => presenceManager,
    getMessagesPane: () => messagesPane,
    getShareController: () => shareController,
    showForcedLogoutModal,
    secureLogout,
    loadInitialContacts,
    hydrateProfileSnapshots: () => hydrateProfileSnapshots(),
    isHydrationComplete: () => hydrationComplete
  }
});
const wsSend = wsIntegration.send;
const ensureWebSocket = () => wsIntegration.ensure();
messagesPane.setWsSend(wsSend);
setMessagesWsSender(wsSend);
setMessagesFlowFacadeWsSend(wsSend);
shareController?.setWsSend?.(wsSend);
setCallSignalSender(wsSend);
wsIntegration.startMonitor();

profileInitPromise
  .then(() => {
    const state = sessionStore.profileState;
    if (sessionStore.currentAvatarUrl) {
      applyHeaderAvatar(sessionStore.currentAvatarUrl, !!state?.avatar?.objKey);
    } else {
      applyHeaderAvatar('/assets/images/avatar.png', false);
    }
  })
  .catch(() => { });




function handleBackgroundAutoLogout(reason = '畫面已移至背景，已自動登出') {
  if (logoutInProgress || _autoLoggedOut) {
    log({ autoLogoutSkip: 'logout-in-progress', logoutInProgress, _autoLoggedOut });
    return;
  }
  if (isReloadNavigation()) {
    forceReloadLogout();
    return;
  }
  const settings = getEffectiveSettingsState();
  if (!settings.autoLogoutOnBackground) {
    log({ autoLogoutSkip: 'setting-disabled' });
    return;
  }
  if (!getMkRaw()) {
    log({ autoLogoutSkip: 'missing-mk' });
    return;
  }
  log({
    autoLogoutBackgroundTriggered: true,
    reason,
    visibility: typeof document !== 'undefined' ? document.visibilityState : null
  });
  secureLogout(reason, { auto: true });
}

let profileHydrationRunning = false;

const toProfileDigest = (value) => {
  if (!value) return null;
  const primary = typeof value === 'string' && value.includes('::') ? value.split('::')[0] : value;
  return normalizeAccountDigest(primary);
};

function isFallbackProfileName(name, digest = null) {
  if (!name) return true;
  const normalized = normalizeProfileNickname(name);
  if (!normalized) return true;
  const trimmed = String(name).trim();
  if (trimmed.startsWith('好友')) return true;
  if (digest && trimmed === `好友 ${digest.slice(-4)}`) return true;
  return false;
}

function collectProfileHydrateTargets() {
  const targets = new Set();
  // Fix: Only hydrate SELF profile from Vault/Control-State.
  // Peer profiles are synced via Contact Metadata / Broadcasting, not by reading their private Vault entries.
  const self = toProfileDigest(getAccountDigest());
  if (self) targets.add(self);
  return targets;
}

function resolveLocalProfileSnapshot(peerDigest) {
  const digest = toProfileDigest(peerDigest);
  if (!digest) return null;
  let candidate = null;
  const maybeSelect = (entry) => {
    if (!entry) return;
    const nickname = entry.nickname || entry.profileNickname || entry.name || null;
    const avatar = entry.avatar || null;
    const updatedAt = Number.isFinite(entry.profileUpdatedAt)
      ? Number(entry.profileUpdatedAt)
      : Number.isFinite(entry.updatedAt)
        ? Number(entry.updatedAt)
        : null;
    const hasProfile = !!normalizeProfileNickname(nickname || '') || !!avatar;
    if (!hasProfile) return;
    if (!candidate || (updatedAt && updatedAt > (candidate.updatedAt || 0))) {
      candidate = { nickname, avatar, updatedAt: updatedAt || null };
    }
  };
  if (sessionStore.contactIndex instanceof Map) {
    for (const entry of sessionStore.contactIndex.values()) {
      const acct = toProfileDigest(entry?.peerAccountDigest || entry?.accountDigest || null);
      if (acct && acct === digest) maybeSelect(entry);
    }
  }
  if (Array.isArray(sessionStore.contactState)) {
    sessionStore.contactState.forEach((entry) => {
      const acct = toProfileDigest(entry?.peerAccountDigest || entry?.accountDigest || entry);
      if (acct && acct === digest) maybeSelect(entry);
    });
  }
  return candidate;
}

function applyProfileSnapshotToStores(peerDigest, profile) {
  const digest = toProfileDigest(peerDigest);
  if (!digest) return;
  const nickname = normalizeProfileNickname(profile?.nickname || '') || `好友 ${digest.slice(-4)}`;
  const avatar = profile?.avatar || null;
  const updatedAt =
    Number.isFinite(profile?.updatedAt) ? Number(profile.updatedAt)
      : Number.isFinite(profile?.ts) ? Number(profile.ts)
        : null;
  const threadsMap = sessionStore.conversationThreads instanceof Map ? sessionStore.conversationThreads : null;
  let threadForPeer = null;
  if (threadsMap) {
    for (const thread of threadsMap.values()) {
      const acct = toProfileDigest(thread?.peerAccountDigest || null);
      if (acct === digest) {
        threadForPeer = thread;
        break;
      }
    }
  }
  const shouldOverwriteNickname = (current) => {
    if (!current) return true;
    return isFallbackProfileName(current, digest);
  };
  let updated = false;
  const updatedKeys = new Set();
  const ensureContactIndex = () => {
    if (!(sessionStore.contactIndex instanceof Map)) {
      const entries = sessionStore.contactIndex && typeof sessionStore.contactIndex.entries === 'function'
        ? Array.from(sessionStore.contactIndex.entries())
        : [];
      sessionStore.contactIndex = new Map(entries);
    }
  };

  const readyContacts = listReadyContacts();
  for (const entry of readyContacts) {
    const acct = toProfileDigest(entry?.peerAccountDigest || entry?.accountDigest || entry?.peerKey || entry);
    if (acct !== digest) continue;
    const patch = {};
    if (shouldOverwriteNickname(entry?.nickname)) patch.nickname = nickname;
    if (avatar && entry?.avatar !== avatar) patch.avatar = avatar;
    if (updatedAt) patch.profileUpdatedAt = updatedAt;
    if (Object.keys(patch).length) {
      const patched = patchContactCore(entry?.peerKey || entry?.peerAccountDigest || acct, patch, 'app-mobile:profile-hydrate');
      updated = true;
      updatedKeys.add(entry?.peerKey || entry?.peerAccountDigest || acct);
      uplinkContactToD1(patched).catch(err => logCapped(`[applyProfileSnapshot] uplink failed for ${acct.slice(0, 8)}`, err));
    }
  }

  if (threadsMap) {
    for (const thread of threadsMap.values()) {
      const acct = toProfileDigest(thread?.peerAccountDigest || null);
      if (acct !== digest) continue;
      const peerDeviceId = thread?.peerDeviceId || null;
      if (thread?.conversationId && (thread?.conversationToken || thread?.conversation?.token_b64) && peerDeviceId) {
        const saved = upsertContactCore({
          peerAccountDigest: `${digest}::${peerDeviceId}`,
          peerDeviceId,
          conversationId: thread.conversationId,
          conversationToken: thread.conversationToken || thread.conversation?.token_b64,
          nickname: shouldOverwriteNickname(thread?.nickname) ? nickname : thread?.nickname || null,
          avatar: avatar || thread?.avatar || null
        }, 'app-mobile:profile-thread');
        updated = true;
        updatedKeys.add(`${digest}::${peerDeviceId}`);
        uplinkContactToD1(saved).catch(err => logCapped(`[applyProfileSnapshot] thread uplink failed`, err));
      }
    }
  }

  if (!updated && threadForPeer && threadForPeer?.conversationId && (threadForPeer?.conversationToken || threadForPeer?.conversation?.token_b64) && threadForPeer?.peerDeviceId) {
    const saved = upsertContactCore({
      peerAccountDigest: `${digest}::${threadForPeer.peerDeviceId}`,
      peerDeviceId: threadForPeer.peerDeviceId,
      conversationId: threadForPeer.conversationId,
      conversationToken: threadForPeer.conversationToken || threadForPeer.conversation?.token_b64,
      nickname,
      avatar: avatar || null,
      profileUpdatedAt: updatedAt || null
    }, 'app-mobile:profile-thread-seed');
    updated = true;
    updatedKeys.add(`${digest}::${threadForPeer.peerDeviceId}`);
    uplinkContactToD1(saved).catch(err => logCapped(`[applyProfileSnapshot] seed uplink failed`, err));
  }

  if (updated) {
    if (typeof renderContacts === 'function') {
      try { renderContacts(); } catch (err) { log({ profileHydrateRenderError: err?.message || err }); }
    }
    try { messagesPane.renderConversationList(); } catch { }
    for (const key of updatedKeys) {
      try {
        if (typeof messagesPane.handleContactEntryUpdated === 'function') {
          messagesPane.handleContactEntryUpdated({ peerAccountDigest: key, entry: sessionStore.contactIndex?.get?.(key) || null });
        }
      } catch (err) {
        log({ profileHydrateEntryUpdateError: err?.message || err, peerAccountDigest: key });
      }
    }
  }
}

async function hydrateProfileSnapshotForDigest(peerDigest) {
  const digest = toProfileDigest(peerDigest);
  if (!digest) {
    log({
      peerProfilePullFailed: {
        peerAccountDigest: peerDigest || null,
        reasonCode: 'PeerProfileInvalidDigest',
        message: 'profile digest invalid',
        sourceTag: 'app-mobile:profile-hydrate'
      }
    });
    return;
  }
  let profile = null;
  try {
    profile = await loadProfileControlState(digest);
  } catch (err) {
    log({
      peerProfilePullFailed: {
        peerAccountDigest: digest,
        reasonCode: 'PeerProfileDecryptFailed',
        message: err?.message || err,
        sourceTag: 'app-mobile:profile-hydrate'
      }
    });
    return;
  }
  if (!profile) {
    log({
      peerProfilePullFailed: {
        peerAccountDigest: digest,
        reasonCode: 'PeerProfileNotFound',
        message: 'profile not found',
        sourceTag: 'app-mobile:profile-hydrate'
      }
    });
    return;
  }
  const normalizedNick = normalizeProfileNickname(profile?.nickname || '');
  const hasProfile = !!normalizedNick || !!profile?.avatar;
  // [FIX] Self-Profile Stale Read Protection & Sync
  const selfDigest = toProfileDigest(getAccountDigest());
  if (digest === selfDigest) {
    const current = sessionStore.profileState;
    const remoteTs = Number(profile?.updatedAt || profile?.ts || 0);
    const localTs = Number(current?.updatedAt || 0);

    // 1. Prevent Revert: If local is newer OR EQUAL, ignore remote data.
    // This prevents "reflected" updates (the save we just made) from re-triggering processing
    // or overwriting optimistic state with potentially propagated/stale data.
    if (localTs >= remoteTs) {
      log({
        profileHydrateSkip: {
          reason: 'local-is-newer-or-equal',
          digest,
          localTs,
          remoteTs
        }
      });
      return;
    }

    // 2. Cross-Device Sync: If remote is strictly newer, update local state
    if (remoteTs > localTs) {
      log({
        profileHydrateSync: {
          reason: 'remote-is-newer',
          digest,
          localTs,
          remoteTs
        }
      });
      sessionStore.profileState = { ...profile, nickname: normalizedNick };

      // Update UI for Self
      if (typeof profileCard?.updateProfileNicknameUI === 'function') {
        profileCard.updateProfileNicknameUI();
      }
      if (typeof profileCard?.updateProfileAvatarUI === 'function') {
        profileCard.updateProfileAvatarUI();
      }
    }
  }

  if (!hasProfile) {
    log({
      peerProfilePullFailed: {
        peerAccountDigest: digest,
        reasonCode: 'PeerProfileEmpty',
        message: 'profile missing nickname/avatar',
        sourceTag: 'app-mobile:profile-hydrate'
      }
    });
    return;
  }
  applyProfileSnapshotToStores(digest, profile);
  log({
    peerProfilePullSuccess: {
      peerAccountDigest: digest,
      hasNickname: !!normalizedNick,
      hasAvatar: !!profile?.avatar,
      sourceTag: 'app-mobile:profile-hydrate'
    }
  });
}

async function hydrateProfileSnapshots() {
  if (profileHydrationRunning) return;
  profileHydrationRunning = true;
  try {
    const targets = collectProfileHydrateTargets();
    for (const digest of targets) {
      // 逐個執行，避免洪泛請求；失敗會記錄原因。
      // eslint-disable-next-line no-await-in-loop
      await hydrateProfileSnapshotForDigest(digest);
    }
  } finally {
    profileHydrationRunning = false;
  }
}

// [FIX: Hydration Race] Flag to block WS until keys are loaded
let hydrationComplete = false;

const postLoginInitPromise = (async () => {
  window.__updateLoadingProgress?.('account');
  try {
    await seedProfileCounterOnce();
  } catch (err) {
    log({ profileCounterSeedError: err?.message || err });
  }
  window.__updateLoadingProgress?.('contacts');
  return runPostLoginContactHydrate();
})();

postLoginInitPromise
  .then(() => {
    window.__updateLoadingProgress?.('conversations');
    messagesPane.syncConversationThreadsFromContacts();
    return messagesPane.refreshConversationPreviews({ force: true });
  })
  .catch((err) => log({ contactsInitError: err?.message || err }))
  .finally(async () => {
    messagesPane.renderConversationList();
    messagesFlowFacade.onLoginResume({ source: 'login', runOfflineCatchup: false });
    flushOutbox({ sourceTag: 'post_login' }).catch(() => { });
    hydrationComplete = true; // [FIX] Release the guard
    ensureWebSocket();
    hydrateProfileSnapshots().catch((err) => log({ profileHydrateStartError: err?.message || err }));
    logRestoreOverview({ reason: 'post-login' });
    messagesFlowFacade.onLoginResume({ source: 'login', runRestore: false, runOfflineDecrypt: false });
    // Ensure profile (identicon/avatar) is loaded before dismissing modal
    await profileInitPromise.catch(() => { });
    // --- Loading Modal: hydration done → enter or dismiss ---
    window.__updateLoadingProgress?.('ready');
    if (_mediaPermissionNeeded) {
      setTimeout(() => {
        window.__morphToEnterButton?.();
        // Wire up splash enter-button click → request mic+camera permission
        const enterBtn = document.getElementById('appEnterBtn');
        const skipBtn = document.getElementById('appLoadingSkip');
        let splashBusy = false;
        const handleEnter = async () => {
          if (splashBusy) return;
          splashBusy = true;
          mediaPermissionMgr.warmUpAudio();
          mediaPermissionMgr.playChime({ volume: 0.3 });
          window.__setSplashAuthorizing?.(true);
          window.__setSplashStatus?.('');
          try {
            const result = await mediaPermissionMgr.requestAccessWithVideo({ timeoutMs: 8000 });
            log({ splashPermission: 'granted', video: result.videoGranted });
            await mediaPermissionMgr.finalize({ warning: false, autoCloseDelayMs: 0, statusMessage: null });
            window.__setSplashSuccess?.();
          } catch (err) {
            log({ splashPermissionError: err?.message || err });
            window.__setSplashAuthorizing?.(false);
            window.__setSplashStatus?.(mediaPermissionMgr.describeError(err));
            showToast?.('授權失敗，請再試一次', { variant: 'warning' });
            splashBusy = false;
          }
        };
        const handleSkip = () => {
          mediaPermissionMgr.warmUpAudio();
          try { sessionStorage.setItem(AUDIO_PERMISSION_KEY, 'granted'); } catch { }
          showToast?.('未啟用麥克風，通話可能無法使用', { variant: 'warning' });
          window.__hideLoadingModal?.();
        };
        enterBtn?.addEventListener('click', handleEnter);
        skipBtn?.addEventListener('click', handleSkip);
      }, 350);
    } else {
      setTimeout(() => window.__hideLoadingModal?.(), 350);
    }
  });

function updateProfileStats() {
  const contacts = Array.isArray(sessionStore.contactState) ? sessionStore.contactState : [];
  const uniq = new Set();
  for (const entry of contacts) {
    if (!entry || entry.hidden === true || entry.isSelfContact === true) continue;
    const id = normalizePeerIdentity(entry.peerAccountDigest ?? entry.accountDigest ?? entry)?.accountDigest || null;
    if (id) uniq.add(id);
  }
  const count = uniq.size;
  if (statContactsEl) statContactsEl.textContent = String(count);
  if (contactsCountEl) contactsCountEl.textContent = String(count);
}

(function hardenAutofill() {
  try {
    const els = document.querySelectorAll('input, textarea');
    els.forEach(el => {
      el.setAttribute('autocomplete', 'off');
      el.setAttribute('autocapitalize', 'off');
      el.setAttribute('autocorrect', 'off');
      el.setAttribute('spellcheck', 'false');
    });
  } catch { }
})();

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (backgroundLogoutTimer) {
      clearTimeout(backgroundLogoutTimer);
      backgroundLogoutTimer = null;
    }
    log({ autoLogoutVisibilityChange: document.visibilityState });
    if (!document.hidden) {
      messagesFlowFacade.onVisibilityResume({
        source: 'visibility_resume',
        onOfflineDecryptError: (err) => log({ offlineDecryptSyncError: err?.message || err, source: 'visibility_resume' }),
        reconcileOutgoingStatus: (params) => messagesFlowFacade.reconcileOutgoingStatusNow({
          ...params,
          reconcileOutgoingStatusNow: messagesPane?.reconcileOutgoingStatusNow
        })
      });
    }
    if (document.hidden) {
      flushDrSnapshotsBeforeLogout('visibilitychange');
      flushContactSecretsLocal('visibilitychange');
      backgroundLogoutTimer = setTimeout(() => {
        backgroundLogoutTimer = null;
        handleBackgroundAutoLogout();
      }, 0);
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (event) => {
    if (event && event.persisted) {
      messagesFlowFacade.onVisibilityResume({
        source: 'pageshow_resume',
        onOfflineDecryptError: (err) => log({ offlineDecryptSyncError: err?.message || err, source: 'pageshow_resume' }),
        reconcileOutgoingStatus: (params) => messagesFlowFacade.reconcileOutgoingStatusNow({
          ...params,
          reconcileOutgoingStatusNow: messagesPane?.reconcileOutgoingStatusNow
        })
      });
    }
  });
  window.addEventListener('pagehide', (event) => {
    if (logoutInProgress) return;
    if (event && event.persisted) return;
    flushDrSnapshotsBeforeLogout('pagehide');
    flushContactSecretsLocal('pagehide');
    if (isReloadNavigation()) {
      forceReloadLogout();
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      if (backgroundLogoutTimer) {
        clearTimeout(backgroundLogoutTimer);
        backgroundLogoutTimer = null;
      }
      backgroundLogoutTimer = setTimeout(() => {
        backgroundLogoutTimer = null;
        handleBackgroundAutoLogout();
      }, 0);
    }
  });
  window.addEventListener('blur', () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      log({ autoLogoutBlur: 'hidden-immediate' });
      if (!backgroundLogoutTimer) {
        backgroundLogoutTimer = setTimeout(() => {
          backgroundLogoutTimer = null;
          handleBackgroundAutoLogout();
        }, 0);
      }
    } else {
      log({ autoLogoutSkip: 'blur-visible' });
    }
  });
  window.addEventListener('beforeunload', () => {
    disposeCallMediaSession();
  });
}
import { unwrapDevicePrivWithMK } from '../crypto/prekeys.js';

// [FATAL] Listen for Outbox Fatal Failure (Retry Exhausted)
if (typeof document !== 'undefined') {
  document.addEventListener('sentry:outbox-fatal', (e) => {
    try {
      const errorMsg = e.detail?.error || '連線發生嚴重錯誤';
      console.error('[App] Outbox Fatal Error:', errorMsg);
      showFatalErrorModal(errorMsg);
    } catch (err) {
      console.error('[App] Failed to handle outbox-fatal event', err);
    }
  });
}

/**
 * Show a non-closable modal for fatal errors (e.g., persistent network failure).
 * User must re-login to restore consistency.
 */
function showFatalErrorModal(message = '連線發生錯誤') {
  try {
    // Reuse or replace existing overlay
    if (forcedLogoutOverlay && forcedLogoutOverlay.parentElement) {
      forcedLogoutOverlay.parentElement.removeChild(forcedLogoutOverlay);
    }
    const wrap = document.createElement('div');
    wrap.className = 'fatal-error-overlay';
    Object.assign(wrap.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(15,23,42,0.85)', // Darker backdrop
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '9999', // Highest priority
      padding: '16px',
      backdropFilter: 'blur(4px)'
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#fff',
      color: '#0f172a',
      padding: '24px',
      borderRadius: '16px',
      width: 'min(360px, 90vw)',
      boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
      textAlign: 'center',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px'
    });

    // Icon
    const icon = document.createElement('div');
    icon.innerHTML = `<i class='bx bx-error-circle' style='font-size: 48px; color: #ef4444;'></i>`;

    // Title
    const title = document.createElement('div');
    Object.assign(title.style, { fontSize: '18px', fontWeight: '800', color: '#b91c1c' });
    title.textContent = '無法傳送訊息';

    // Body
    const msg = document.createElement('div');
    Object.assign(msg.style, { fontSize: '15px', lineHeight: '1.5', color: '#334155' });
    msg.textContent = `偵測到持續性的連線或加密錯誤，為確保安全，請重新登入以修復連線。\n\n錯誤詳情: ${message}`;

    // Action Button
    const btn = document.createElement('button');
    btn.textContent = '重新登入';
    Object.assign(btn.style, {
      padding: '12px',
      borderRadius: '12px',
      border: 'none',
      background: '#ef4444',
      color: '#fff',
      fontSize: '16px',
      fontWeight: '700',
      cursor: 'pointer',
      width: '100%',
      marginTop: '8px'
    });

    // Force logout on click
    btn.onclick = () => {
      btn.disabled = true;
      btn.textContent = '正在登出...';
      secureLogout('Fatal Error Reset', { auto: false });
    };

    panel.appendChild(icon);
    panel.appendChild(title);
    panel.appendChild(msg);
    panel.appendChild(btn);
    wrap.appendChild(panel);

    document.body.appendChild(wrap);
    forcedLogoutOverlay = wrap; // Track it so we don't stack multiple
  } catch (err) {
    console.error('Failed to show fatal modal:', err);
    // Fallback if UI fails: force immediate logout
    secureLogout('Fatal Error Fallback', { auto: true });
  }
}
