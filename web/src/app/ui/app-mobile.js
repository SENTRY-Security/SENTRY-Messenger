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
import { LOCAL_SNAPSHOT_FLUSH_ON_EACH_EVENT, REMOTE_BACKUP_FORCE_ON_LOGOUT } from '../features/restore-policy.js';
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
  triggerContactSecretsBackup,
  hydrateContactSecretsFromBackup,
  getLastBackupHydrateResult,
  getLatestBackupMeta
} from '../features/contact-backup.js';
import { subscriptionStatus, redeemSubscription, uploadSubscriptionQr } from '../api/subscription.js';
import { showVersionModal } from './version-info.js';
import QrScanner from '../lib/vendor/qr-scanner.min.js';

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
const mediaPermissionOverlay = document.getElementById('mediaPermissionOverlay');
const mediaPermissionAllowBtn = document.getElementById('mediaPermissionAllowBtn');
const mediaPermissionAllowLabel = document.getElementById('mediaPermissionAllowLabel');
const mediaPermissionSkipBtn = document.getElementById('mediaPermissionSkipBtn');
const mediaPermissionDebugBtn = document.getElementById('mediaPermissionDebugBtn');
const mediaPermissionStatus = document.getElementById('mediaPermissionStatus');
let mediaPermissionAwaitingConfirm = false;
let mediaPermissionSystemGranted = false;
let mediaPermissionActivePrompt = null;
let mediaPermissionPollingTimer = null;
let cachedMicrophoneStream = null;
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

const LOGOUT_REDIRECT_DEFAULT_URL = '/pages/logout.html';
const LOGOUT_REDIRECT_PLACEHOLDER = 'https://example.com/logout';
const LOGOUT_REDIRECT_SUGGESTIONS = Object.freeze([
  'https://sentry.red',
  'https://apple.com',
  'https://www.cloudflare.com',
  'https://www.mozilla.org',
  'https://www.wikipedia.org'
]);
const LOGOUT_MESSAGE_KEY = 'app:lastLogoutReason';
let logoutInProgress = false;
let _autoLoggedOut = false;
let wsConn = null;
let wsReconnectTimer = null;
let wsAuthTokenInfo = null;
const pendingWsMessages = [];
let presenceManager = null;
let wsMonitorTimer = null;

let customLogoutModalContext = null;
let customLogoutInvoker = null;
let customLogoutHandlersBound = false;

function getCustomLogoutElements() {
  return {
    modal: document.getElementById('customLogoutModal'),
    backdrop: document.getElementById('customLogoutBackdrop'),
    closeBtn: document.getElementById('customLogoutClose'),
    input: document.getElementById('customLogoutInput'),
    saveBtn: document.getElementById('customLogoutSave'),
    cancelBtn: document.getElementById('customLogoutCancel'),
    errorEl: document.getElementById('customLogoutError')
  };
}
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

function isIosWebKitLikeBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const maxTouchPoints = Number(navigator.maxTouchPoints) || 0;
  const isTouchMac = platform === 'MacIntel' && maxTouchPoints > 1;
  const uaHintsPlatform = navigator.userAgentData?.platform || '';
  const isiOSUA = /iPad|iPhone|iPod/i.test(ua);
  const isiOSPlatformHint = /iOS/i.test(uaHintsPlatform || '');
  const isStandalone = typeof navigator.standalone === 'boolean' ? navigator.standalone : false;
  return isiOSUA || isTouchMac || isiOSPlatformHint || isStandalone;
}

function supportsMediaConstraint(key) {
  if (typeof navigator === 'undefined') return false;
  const supported = navigator.mediaDevices?.getSupportedConstraints?.();
  if (!supported || typeof supported !== 'object') return false;
  return Boolean(supported[key]);
}

function isConstraintUnsatisfiedError(err) {
  if (!err) return false;
  const code = (err.name || err.code || '').toLowerCase();
  return code === 'overconstrainederror' || code === 'constraintnotsatisfiederror';
}

function getMicrophoneConstraintProfiles() {
  const supportsEchoCancellation = supportsMediaConstraint('echoCancellation');
  const supportsNoiseSuppression = supportsMediaConstraint('noiseSuppression') && !isIosWebKitLikeBrowser();
  const profiles = [];
  if (supportsNoiseSuppression) {
    const advanced = {};
    if (supportsEchoCancellation) advanced.echoCancellation = true;
    advanced.noiseSuppression = true;
    profiles.push({ audio: advanced, video: false });
  }
  if (supportsEchoCancellation) {
    profiles.push({ audio: { echoCancellation: true }, video: false });
  }
  profiles.push({ audio: true, video: false });
  return profiles;
}

function isAutomationEnvironment() {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  if (typeof window !== 'undefined' && (window.Cypress || window.Playwright)) return true;
  try {
    const ua = navigator.userAgent || '';
    if (/Playwright|HeadlessChrome|puppeteer/i.test(ua)) return true;
  } catch { }
  return false;
}

function hasMediaPermissionFlag() {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    return sessionStorage.getItem(MEDIA_PERMISSION_KEY) === 'granted';
  } catch {
    return false;
  }
}

function markMediaPermissionGranted() {
  if (typeof sessionStorage === 'undefined') return;
  try { sessionStorage.setItem(MEDIA_PERMISSION_KEY, 'granted'); } catch { }
  try { sessionStorage.setItem(AUDIO_PERMISSION_KEY, 'granted'); } catch { }
}

function setMediaPermissionStatus(message = '', { success = false } = {}) {
  if (!mediaPermissionStatus) return;
  mediaPermissionStatus.textContent = message || '';
  mediaPermissionStatus.classList.toggle('success', !!message && success);
  if (!success) {
    mediaPermissionStatus.classList.remove('success');
  }
}

function hideMediaPermissionPrompt() {
  if (!mediaPermissionOverlay) return;
  if (mediaPermissionPollingTimer) {
    clearInterval(mediaPermissionPollingTimer);
    mediaPermissionPollingTimer = null;
  }
  mediaPermissionOverlay.style.display = 'none';
  mediaPermissionOverlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('media-permission-open');
  if (mediaPermissionAllowBtn) {
    mediaPermissionAllowBtn.disabled = false;
  }
  setMediaPermissionStatus('');
}

function showMediaPermissionPrompt() {
  if (!mediaPermissionOverlay) return;
  mediaPermissionOverlay.style.display = 'flex';
  mediaPermissionOverlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('media-permission-open');
  setMediaPermissionStatus('');
  mediaPermissionAllowBtn?.focus?.();
}

function stopStreamTracks(stream) {
  if (!stream?.getTracks) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { }
  }
}

function isLiveMicrophoneStream(stream) {
  if (!stream?.getAudioTracks) return false;
  return stream.getAudioTracks().some((track) => track?.readyState === 'live');
}

function cacheMicrophoneStream(stream) {
  if (!isLiveMicrophoneStream(stream)) return null;
  if (cachedMicrophoneStream && cachedMicrophoneStream !== stream) {
    try { stopStreamTracks(cachedMicrophoneStream); } catch { }
  }
  cachedMicrophoneStream = stream;
  try { sessionStore.cachedMicrophoneStream = stream; } catch { }
  return cachedMicrophoneStream;
}

async function collectMicrophonePermissionSignals() {
  const result = { permState: null, hasLabel: false };
  if (typeof navigator === 'undefined') return result;
  const { permissions, mediaDevices } = navigator;
  if (permissions?.query) {
    try {
      result.permState = (await permissions.query({ name: 'microphone' }))?.state || null;
    } catch { }
  }
  if (mediaDevices?.enumerateDevices) {
    try {
      const devices = await mediaDevices.enumerateDevices();
      result.hasLabel = Array.isArray(devices)
        && devices.some((device) => device.kind === 'audioinput' && device.label && device.label.trim());
    } catch { }
  }
  return result;
}

function startMediaPermissionPolling() {
  if (mediaPermissionPollingTimer) return;
  mediaPermissionPollingTimer = setInterval(async () => {
    try {
      const { permState, hasLabel } = await collectMicrophonePermissionSignals();
      if (permState === 'granted' || hasLabel) {
        hideMediaPermissionPrompt();
        setMediaPermissionStatus('');
      }
    } catch (err) {
      log({ mediaPermissionPollError: err?.message || err });
    }
  }, 500);
}

async function detectUnlockedMicrophonePermission() {
  const { permState, hasLabel } = await collectMicrophonePermissionSignals();
  if (permState === 'granted') return true;
  if (hasLabel) return true;
  return false;
}

async function requestUserMediaAccess({ timeoutMs = 5000 } = {}) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('瀏覽器不支援麥克風授權，請改用最新版 Safari / Chrome。');
  }
  const withTimeout = (promise, label) => Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label || 'media'} timeout`)), timeoutMs);
    })
  ]);
  const constraintProfiles = getMicrophoneConstraintProfiles();
  let lastError = null;
  for (let attempt = 0; attempt < constraintProfiles.length; attempt += 1) {
    const constraints = constraintProfiles[attempt];
    try {
      const audioStream = await withTimeout(
        navigator.mediaDevices.getUserMedia(constraints),
        'audio'
      );
      stopStreamTracks(audioStream);
      return { audioGranted: true, videoGranted: false };
    } catch (err) {
      lastError = err;
      if (!isConstraintUnsatisfiedError(err)) {
        throw err || new Error('需要授權麥克風才能繼續使用語音通話');
      }
      log({
        mediaPermissionConstraintRetry: {
          name: err?.name,
          message: err?.message,
          nextProfile: attempt < constraintProfiles.length - 1
        }
      });
    }
  }
  throw lastError || new Error('需要授權麥克風才能繼續使用語音通話');
}

function describeMediaPermissionError(err) {
  if (!err) return '授權失敗，請在瀏覽器或系統設定中允許麥克風。';
  const message = String(err?.message || '').toLowerCase();
  const name = (err.name || err.code || '').toLowerCase();
  if (name === 'overconstrainederror' || name === 'constraintnotsatisfiederror') {
    return '麥克風已允許，但此裝置不支援進階音訊設定，請改用預設麥克風或稍後再試。';
  }
  if (name === 'notallowederror' || name === 'securityerror') {
    return '你已拒絕麥克風，請到瀏覽器或系統設定重新允許後再試。';
  }
  if (name === 'notfounderror' || name === 'devicesnotfounderror') {
    return '找不到可用的麥克風，請確認裝置已啟用。';
  }
  if (name === 'notreadableerror' || name === 'trackstarterror') {
    return '無法啟動麥克風，可能已被其他應用程式使用。';
  }
  if (message.includes('timeout')) {
    return '等待授權逾時，請確認瀏覽器有顯示「允許麥克風」提示或稍後再試。';
  }
  return err?.message || '授權失敗，請稍後再試或檢查系統權限設定。';
}

async function warmUpSilentAudioPlayback() {
  if (typeof window === 'undefined') return;
  try { await resumeNotifyAudioContext()?.catch(() => { }); } catch { }
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      await ctx.resume().catch(() => { });
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start?.(0);
      await ctx.close().catch(() => { });
    }
  } catch { }
  try {
    if (typeof Audio !== 'undefined') {
      const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=');
      audio.muted = true;
      audio.playsInline = true;
      await audio.play().catch(() => { });
      audio.pause();
    }
  } catch { }
}

function forceImmediateAudioPlayback() {
  if (typeof Audio === 'undefined') return;
  try {
    const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=');
    audio.muted = true;
    audio.playsInline = true;
    audio.loop = false;
    audio.play()
      ?.catch((err) => log({ mediaPermissionForcePlayError: err?.message || err }));
    setTimeout(() => {
      try { audio.pause(); audio.src = ''; } catch { }
    }, 1200);
  } catch (err) {
    log({ mediaPermissionForcePlayInitError: err?.message || err });
  }
}

function playConnectChime({ volume = 0.3 } = {}) {
  if (typeof Audio === 'undefined') return;
  try {
    const audio = new Audio('/assets/audio/click.mp3');
    audio.volume = Math.min(Math.max(volume, 0), 1);
    audio.playsInline = true;
    audio.muted = false;
    const cleanup = () => {
      try { audio.pause(); audio.src = ''; audio.load(); } catch { }
    };
    audio.play()
      ?.then(() => setTimeout(cleanup, 4000))
      .catch((err) => {
        log({ mediaPermissionChimeError: err?.message || err });
        cleanup();
      });
  } catch (err) {
    log({ mediaPermissionChimeInitError: err?.message || err });
  }
}

async function finalizeMediaPermission({ warning = false, autoCloseDelayMs = 600, statusMessage } = {}) {
  await warmUpSilentAudioPlayback();
  markMediaPermissionGranted();
  const message = statusMessage !== undefined
    ? statusMessage
    : warning
      ? '麥克風授權已允許，若仍無法通話請在設定中重新測試。'
      : '麥克風已啟用，可立即使用語音通話。';
  if (message !== null) {
    setMediaPermissionStatus(message, { success: true });
  }
  if (mediaPermissionAllowBtn) {
    mediaPermissionAllowBtn.disabled = false;
  }
  setMediaPermissionButtonState('initial');
  mediaPermissionSystemGranted = false;
  showToast?.(
    warning
      ? '麥克風已允許，但裝置暫時無法啟動；稍後可再嘗試通話。'
      : '已啟用麥克風，可使用語音通話',
    { variant: warning ? 'warning' : 'success' }
  );
  setTimeout(() => hideMediaPermissionPrompt(), Math.max(0, Number(autoCloseDelayMs) || 0));
}

function setMediaPermissionButtonState(state = 'initial') {
  if (!mediaPermissionAllowBtn || !mediaPermissionAllowLabel) return;
  if (state === 'confirm') {
    mediaPermissionAllowBtn.classList.add('state-confirm');
    mediaPermissionAllowLabel.textContent = '我已按下同意';
    mediaPermissionAwaitingConfirm = true;
  } else {
    mediaPermissionAllowBtn.classList.remove('state-confirm');
    mediaPermissionAllowLabel.textContent = '允許麥克風';
    mediaPermissionAwaitingConfirm = false;
  }
}

async function startMediaPermissionPrompt() {
  if (mediaPermissionActivePrompt) return;
  mediaPermissionSystemGranted = false;
  setMediaPermissionStatus('請在系統視窗中按下「允許」，完成後再點「我已按下同意」。');
  log({ mediaPermission: 'requestUserMedia:start' });
  mediaPermissionActivePrompt = requestUserMediaAccess({ timeoutMs: 5000 })
    .then(async () => {
      mediaPermissionSystemGranted = true;
      try {
        await finalizeMediaPermission({ warning: false, autoCloseDelayMs: 1500, statusMessage: '已確認授權並啟動麥克風，稍後會自動關閉提示。' });
        log({ mediaPermission: 'prompt-detected' });
      } catch (err) {
        log({ mediaPermissionPromptFinalizeError: err?.message || err });
      }
    })
    .catch((err) => {
      log({ mediaPermissionError: err?.message || err });
      mediaPermissionSystemGranted = false;
      setMediaPermissionStatus(describeMediaPermissionError(err));
      showToast?.('授權失敗，請再試一次', { variant: 'warning' });
      setMediaPermissionButtonState('initial');
    })
    .finally(() => {
      mediaPermissionActivePrompt = null;
    });
}

async function verifyMediaPermissionAfterConfirm() {
  try {
    const { permState, hasLabel } = await collectMicrophonePermissionSignals();
    try {
      const toastMessage = permState === 'granted'
        ? '已授權麥克風權限'
        : `權限狀態：${permState || 'unknown'} / Label: ${hasLabel ? '有' : '無'}`;
      showToast?.(toastMessage, { variant: permState === 'granted' || hasLabel ? 'success' : 'warning' });
      log({ mediaPermissionConfirmCheck: { perm: permState, label: hasLabel, toast: toastMessage } });
    } catch (err) {
      log({ mediaPermissionConfirmToastError: err?.message || err });
    }
    const grantedByQuery = permState === 'granted' || hasLabel;
    const fallbackUnlocked = grantedByQuery
      ? false
      : await detectUnlockedMicrophonePermission().catch(() => false);
    const unlocked = mediaPermissionSystemGranted || grantedByQuery || fallbackUnlocked;
    if (unlocked) {
      mediaPermissionSystemGranted = false;
      if (grantedByQuery) {
        hideMediaPermissionPrompt();
        setMediaPermissionStatus('');
      }
      await finalizeMediaPermission({ warning: false, statusMessage: grantedByQuery ? null : undefined });
      log({ mediaPermission: 'confirmed-by-user' });
      setMediaPermissionButtonState('initial');
      return true;
    }
    setMediaPermissionStatus('尚未偵測到授權，請再次確認或稍後到 Safari 設定允許。');
    showToast?.('尚未允許麥克風', { variant: 'warning' });
    setMediaPermissionButtonState('initial');
    return false;
  } catch (err) {
    log({ mediaPermissionVerifyError: err?.message || err });
    showToast?.('檢查授權時發生錯誤，請再試一次', { variant: 'warning' });
    setMediaPermissionButtonState('initial');
    return false;
  }
}

async function handleMediaPermissionGrant() {
  if (!mediaPermissionOverlay || !mediaPermissionAllowBtn) return;
  forceImmediateAudioPlayback();
  playConnectChime({ volume: 0.3 });
  if (!mediaPermissionAwaitingConfirm) {
    resumeNotifyAudioContext()?.catch(() => { });
    audioManager.loadBuffer?.();
    log({ mediaPermission: 'triggered' });
    setMediaPermissionButtonState('confirm');
    startMediaPermissionPolling();
    await startMediaPermissionPrompt();
    return;
  }
  log({ mediaPermission: 'confirm-button-clicked' });
  await verifyMediaPermissionAfterConfirm();
}

function initMediaPermissionPrompt() {
  if (!mediaPermissionOverlay) return;
  if (mediaPermissionOverlay.dataset.init === '1') return;
  mediaPermissionOverlay.dataset.init = '1';
  setMediaPermissionButtonState('initial');
  if (isAutomationEnvironment()) {
    markMediaPermissionGranted();
    hideMediaPermissionPrompt();
    warmUpSilentAudioPlayback();
    return;
  }
  if (hasMediaPermissionFlag()) {
    hideMediaPermissionPrompt();
    warmUpSilentAudioPlayback();
    return;
  }
  showMediaPermissionPrompt();
  mediaPermissionAllowBtn?.addEventListener('click', handleMediaPermissionGrant);
  mediaPermissionSkipBtn?.addEventListener('click', () => {
    forceImmediateAudioPlayback();
    hideMediaPermissionPrompt();
    setMediaPermissionStatus('');
    mediaPermissionSystemGranted = false;
    setMediaPermissionButtonState('initial');
    warmUpSilentAudioPlayback();
    showToast?.('未啟用麥克風，通話可能無法使用', { variant: 'warning' });
  });
  if (mediaPermissionDebugBtn && !mediaPermissionDebugBtn.dataset.init) {
    mediaPermissionDebugBtn.dataset.init = '1';
    mediaPermissionDebugBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        const perm = await navigator.permissions?.query?.({ name: 'microphone' }).catch(() => null);
        const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []);
        const hasLabel = Array.isArray(devices) && devices.some((d) => d.kind === 'audioinput' && d.label);
        const toastMessage = perm?.state === 'granted'
          ? '已授權麥克風權限'
          : `權限狀態：${perm?.state || 'unknown'} / Label: ${hasLabel ? '有' : '無'}`;
        showToast?.(toastMessage, { variant: perm?.state === 'granted' || hasLabel ? 'success' : 'warning' });
        log({ mediaPermissionDebugCheck: { perm: perm?.state, label: hasLabel, devicesLength: devices?.length || 0, toast: toastMessage } });
        if (perm?.state === 'granted' || hasLabel) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            log({ mediaPermissionDebugStream: { tracks: stream?.getTracks?.().length || 0 } });
            setMediaPermissionStatus('已確認授權並啟動麥克風，稍後會自動關閉提示。', { success: true });
            await finalizeMediaPermission({ warning: false, autoCloseDelayMs: 1500, statusMessage: null });
            setTimeout(() => {
              try { stream?.getTracks?.().forEach((track) => track.stop()); } catch { }
            }, 500);
          } catch (err) {
            log({ mediaPermissionDebugStreamError: err?.message || err });
          }
        }
      } catch (err) {
        showToast?.('無法取得權限狀態', { variant: 'warning' });
        log({ mediaPermissionDebugError: err?.message || err });
      }
    });
  }
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
    await flushDrSnapshotsBeforeLogout('secure-logout', {
      forceRemote: true,
      keepalive: true,
      sourceTag: 'app-mobile:secure-logout'
    });
  } catch (err) {
    log({ contactSecretsSnapshotFlushError: err?.message || err, reason: 'secure-logout-call' });
  }

  try {
    persistContactSecrets();
    const backupPromise = triggerContactSecretsBackup('secure-logout', {
      force: REMOTE_BACKUP_FORCE_ON_LOGOUT === true,
      keepalive: true,
      sourceTag: 'app-mobile:secureLogout'
    });
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 5000));
    await Promise.race([backupPromise, timeoutPromise]).catch((err) => {
      log({ contactSecretsBackupDuringLogoutError: err?.message || err });
    });
  } catch (err) {
    log({ contactSecretsPersistError: err?.message || err });
  } finally {
    try {
      lockContactSecrets('secure-logout');
    } catch (err) {
      log({ contactSecretsLockError: err?.message || err });
    }
  }

  try { wsConn?.close(); } catch { }
  wsConn = null;
  wsAuthTokenInfo = null;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  pendingWsMessages.length = 0;
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

function flushDrSnapshotsBeforeLogout(reason = 'secure-logout', { forceRemote = false, keepalive = false, sourceTag = null } = {}) {
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
  try {
    const shouldForceRemote = forceRemote || REMOTE_BACKUP_FORCE_ON_LOGOUT === true;
    if (shouldForceRemote) {
      triggerContactSecretsBackup(reason || 'secure-logout', {
        force: true,
        keepalive: keepalive === true,
        sourceTag: sourceTag || `app-mobile:flush:${reason || 'secure-logout'}`
      }).catch((err) => log({ contactSecretsBackupDuringLogoutError: err?.message || err }));
    }
  } catch (err) {
    log({ contactSecretsBackupDuringLogoutError: err?.message || err });
  }
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


// --- Hard-disable zoom gestures (reinforce meta viewport) ---
(function disableZoom() {
  try {
    // iOS Safari pinch gesture
    const stop = (e) => { e.preventDefault(); };
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => {
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
  } catch { }
})();

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

settingsInitPromise = bootLoadSettings()
  .catch((err) => {
    log({ settingsBootError: err?.message || err });
    const fallback = { ...DEFAULT_SETTINGS, updatedAt: Date.now() };
    if (!sessionStore.settingsState) sessionStore.settingsState = fallback;
    return sessionStore.settingsState || fallback;
  });

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
let subscriptionCountdownTimer = null;
let subscriptionScanner = null;
let subscriptionScannerActive = false;

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

function updateSubscriptionBadge(expired) {
  if (!userAvatarWrap || !userMenuBadge) return;
  const show = !!expired;
  userAvatarWrap.classList.toggle('has-alert', show);
  userMenuBadge.style.display = show ? 'inline-flex' : 'none';
  if (userMenuSubscriptionBadge) {
    userMenuSubscriptionBadge.style.display = show ? 'inline-flex' : 'none';
  }
}

function normalizeSubscriptionLogs(logsRaw) {
  if (!Array.isArray(logsRaw)) return [];
  return logsRaw.map((log, idx) => {
    const extendDays = Number(log?.extend_days ?? log?.extendDays ?? log?.duration_days ?? log?.durationDays ?? 0) || 0;
    const expiresAfter = Number(log?.expires_at_after ?? log?.expiresAtAfter ?? log?.expires_at ?? log?.expiresAt ?? 0) || null;
    const usedAt = Number(log?.used_at ?? log?.usedAt ?? log?.updated_at ?? log?.redeemed_at ?? 0) || null;
    const issuedAt = Number(log?.issued_at ?? log?.issuedAt ?? 0) || null;
    const status = typeof log?.status === 'string' ? log.status : (extendDays ? 'used' : 'active');
    const tokenId = log?.token_id || log?.tokenId || log?.voucher_id || log?.jti || `token-${idx + 1}`;
    let channel = log?.channel || log?.gateway || null;
    if (!channel && (log?.key_id || log?.keyId)) channel = `憑證 ${log?.key_id || log?.keyId}`;
    if (!channel) channel = 'QR 憑證';
    const type = extendDays > 0 ? 'extend' : 'activate';
    return { tokenId, extendDays, expiresAfter, usedAt, issuedAt, status, channel, type };
  });
}

function computeSubscriptionCountdown(expiresAt) {
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return { expired: true, text: '已到期', seconds: 0 };
  const diff = expiresAt - now;
  if (diff <= 0) return { expired: true, text: '已到期', seconds: 0 };
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return { expired: false, text: `剩餘 ${days} 天`, seconds: diff };
  if (hours > 0) return { expired: false, text: `剩餘 ${hours} 小時`, seconds: diff };
  return { expired: false, text: `剩餘 ${Math.max(mins, 1)} 分鐘`, seconds: diff };
}

async function refreshSubscriptionStatus({ silent = false } = {}) {
  const state = sessionStore.subscriptionState;
  state.loading = true;
  state.logs = [];
  try {
    const { r, data } = await subscriptionStatus();
    if (!r.ok || !data?.ok) throw new Error(typeof data === 'string' ? data : data?.message || 'status failed');
    state.lastChecked = Date.now();
    state.logs = normalizeSubscriptionLogs(data?.logs);
    state.accountCreatedAt = Number(data?.account_created_at ?? data?.accountCreatedAt ?? 0) || null;
    if (data.found && Number.isFinite(Number(data.expires_at))) {
      state.found = true;
      state.expiresAt = Number(data.expires_at);
      state.expired = !(state.expiresAt && state.expiresAt > Date.now());
    } else {
      state.found = false;
      state.expiresAt = null;
      state.expired = true;
      if (!state.logs.length) state.accountCreatedAt = state.accountCreatedAt || null;
    }
  } catch (err) {
    if (!silent) showToast?.(`查詢訂閱失敗：${err?.message || err}`, { variant: 'error' });
    state.found = false;
    state.expiresAt = null;
    state.expired = true;
    state.logs = [];
    state.accountCreatedAt = state.accountCreatedAt || null;
  } finally {
    state.loading = false;
    updateSubscriptionBadge(state.expired);
    try {
      document.dispatchEvent(new CustomEvent('subscription:state', { detail: { state: { ...state } } }));
    } catch { }
  }
  return sessionStore.subscriptionState;
}

function stopSubscriptionCountdown() {
  if (subscriptionCountdownTimer) {
    clearInterval(subscriptionCountdownTimer);
    subscriptionCountdownTimer = null;
  }
}

function showSubscriptionGateModal() {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');
  if (!modal || !body) return;
  stopSubscriptionScanner({ destroy: true });
  stopSubscriptionCountdown();
  resetModalVariants(modal);
  modal.classList.add('confirm-modal', 'subscription-modal-shell');
  if (title) title.textContent = '帳號已到期';
  body.innerHTML = `
    <div class="confirm-message">帳號已到期，請進行儲值。</div>
    <div class="confirm-actions">
      <button type="button" class="secondary" id="subscriptionGateClose">關閉</button>
      <button type="button" class="primary" id="subscriptionGateOpen">點我儲值</button>
    </div>
  `;
  openModal();
  document.getElementById('subscriptionGateClose')?.addEventListener('click', () => closeModal());
  document.getElementById('subscriptionGateOpen')?.addEventListener('click', () => {
    closeModal();
    openSubscriptionModal();
  });
}

document.addEventListener('subscription:gate', showSubscriptionGateModal);

function stopSubscriptionScanner({ destroy = false } = {}) {
  if (subscriptionScanner && subscriptionScannerActive) {
    try { subscriptionScanner.stop(); } catch { }
  }
  subscriptionScannerActive = false;
  if (destroy && subscriptionScanner) {
    try { subscriptionScanner.destroy?.(); } catch { }
    subscriptionScanner = null;
  }
}

function startSubscriptionCountdown(expiresAt) {
  stopSubscriptionCountdown();
  const statusText = document.getElementById('subscriptionStatusText');
  const countdownHint = document.getElementById('subscriptionCountdownHint');
  if (!statusText) return;
  const tick = () => {
    const { expired, text } = computeSubscriptionCountdown(expiresAt);
    statusText.textContent = expired ? '已到期' : text;
    statusText.className = expired ? 'sub-status error' : 'sub-status ok';
    if (countdownHint) countdownHint.textContent = expired ? '請儲值以延長使用' : '狀態會自動同步，無需手動刷新';
    if (expired) updateSubscriptionBadge(true);
  };
  tick();
  const interval = Math.max(30, Math.min(300, Math.floor(Math.max(expiresAt - Date.now(), 60) / 2)));
  subscriptionCountdownTimer = setInterval(tick, interval * 1000);
}

async function handleRedeemToken(token, hooks = {}) {
  if (!token) {
    showToast?.('請輸入或掃描憑證', { variant: 'warning' });
    const err = new Error('token missing');
    hooks.onError?.(err);
    return { ok: false, error: err };
  }
  const { onStart, onSuccess, onError } = hooks;
  const redeemBtn = document.getElementById('subscriptionRedeemBtn');
  if (redeemBtn) redeemBtn.disabled = true;
  onStart?.();
  try {
    const { r, data } = await redeemSubscription({ token });
    if (!r.ok || !data?.ok) throw new Error(typeof data === 'string' ? data : data?.message || 'redeem failed');
    sessionStore.subscriptionState.expiresAt = Number(data.expiresAt || data.expires_at || 0);
    sessionStore.subscriptionState.found = true;
    sessionStore.subscriptionState.expired = !(sessionStore.subscriptionState.expiresAt > Date.now());
    updateSubscriptionBadge(sessionStore.subscriptionState.expired);
    const statusText = document.getElementById('subscriptionStatusText');
    if (statusText) statusText.textContent = '展期成功，正在更新狀態…';
    await refreshSubscriptionStatus({ silent: true });
    const msg = typeof data?.message === 'string' ? data.message : '展期成功';
    showToast?.(msg, { variant: 'success' });
    onSuccess?.(data);
    return { ok: true, data };
  } catch (err) {
    const detail = err?.message || err;
    const msg = typeof detail === 'string' ? detail : '展期失敗，請稍後再試';
    showToast?.(msg, { variant: 'error' });
    onError?.(err);
    return { ok: false, error: err };
  } finally {
    if (redeemBtn) redeemBtn.disabled = false;
  }
}

async function handleSubscriptionFile(files, hooks = {}) {
  const list = files && typeof files.length === 'number' ? files : [];
  const file = list[0] || null;
  if (!file) return { ok: false, error: new Error('file missing') };
  try {
    hooks.onStart?.();
    const { r, data } = await uploadSubscriptionQr({ file });
    if (!r.ok || !data?.ok) {
      const msg = typeof data === 'object' && data?.message ? data.message : '展期失敗，請稍後再試';
      throw new Error(msg);
    }
    return { ok: true, data };
  } catch (err) {
    if (hooks?.onError) hooks.onError(err);
    else showToast?.(`檔案解析失敗：${err?.message || err}`, { variant: 'error' });
    return { ok: false, error: err };
  }
}

async function openSubscriptionModal() {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');
  if (!modal || !body) return;
  stopSubscriptionScanner({ destroy: true });
  stopSubscriptionCountdown();
  resetModalVariants(modal);
  modal.classList.add('settings-modal', 'subscription-modal-shell');
  if (title) title.textContent = '訂閱 / 儲值';
  body.innerHTML = `
    <div class="subscription-modal">
      <div class="sub-tabs" role="tablist">
        <button type="button" class="sub-tab active" data-tab="status" aria-selected="true" role="tab">訂閱狀態</button>
        <button type="button" class="sub-tab" data-tab="topup" aria-selected="false" role="tab">儲值 / 展期</button>
      </div>
      <div class="sub-tabpanel" data-tabpanel="status" role="tabpanel">
        <div class="subscription-hero">
          <div class="hero-text">
            <div class="hero-label">目前狀態</div>
            <div id="subscriptionStatusText" class="sub-status">查詢中…</div>
            <div class="sub-meta" id="subscriptionMeta"></div>
          </div>
        </div>
        <div class="sub-table-block">
          <div class="sub-table-head">
            <div class="sub-table-title">開通 / 儲值紀錄</div>
            <button type="button" class="ghost-btn" id="subscriptionRefreshBtn"><i class='bx bx-sync'></i> 重新整理</button>
          </div>
          <div class="sub-table" id="subscriptionCombinedTable"></div>
        </div>
      </div>
      <div class="sub-tabpanel" data-tabpanel="topup" role="tabpanel" hidden>
        <div class="sub-steps" id="subscriptionWizardSteps">
          <div class="sub-step" data-step="1"><span class="step-number">1</span><small>選擇管道</small></div>
          <div class="sub-step" data-step="2"><span class="step-number">2</span><small>掃描 / 上傳</small></div>
          <div class="sub-step" data-step="3"><span class="step-number">3</span><small>結果</small></div>
        </div>
        <div id="subscriptionWizardContent" class="sub-wizard-content"></div>
      </div>
    </div>
  `;
  modal.__subscriptionCleanup = () => {
    stopSubscriptionCountdown();
    stopSubscriptionScanner({ destroy: true });
  };
  openModal();
  const wizard = { step: 1, channel: null, result: null, busy: false };

  const tabButtons = Array.from(body.querySelectorAll('.sub-tab'));
  const tabPanels = Array.from(body.querySelectorAll('.sub-tabpanel'));
  const wizardContent = document.getElementById('subscriptionWizardContent');

  function subscriptionSwitchTab(target) {
    tabButtons.forEach((btn) => {
      const active = btn.dataset.tab === target;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    tabPanels.forEach((panel) => {
      const active = panel.dataset.tabpanel === target;
      panel.hidden = !active;
    });
    if (target !== 'topup') stopSubscriptionScanner({ destroy: true });
    if (target === 'topup') renderWizard();
  }

  function fmt(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return '—';
    return new Date(ts * 1000).toLocaleString();
  }

  function renderTables(logs = []) {
    const table = document.getElementById('subscriptionCombinedTable');
    if (!table) return;
    const activationTs = Number(sessionStore?.subscriptionState?.accountCreatedAt
      ?? sessionStore?.profileState?.createdAt
      ?? sessionStore?.profileState?.created_at
      ?? sessionStore?.profileState?.created
      ?? 0);
    const baseRows = [];
    if (Number.isFinite(activationTs) && activationTs > 0) {
      baseRows.push({
        usedAt: activationTs,
        issuedAt: activationTs,
        type: 'account',
        status: 'active',
        channel: '帳號建立',
        tokenId: '—',
        extendDays: 0
      });
    }
    const sorted = [...baseRows, ...(Array.isArray(logs) ? logs : [])].sort((a, b) => {
      const ta = Number(a.usedAt || a.issuedAt || 0);
      const tb = Number(b.usedAt || b.issuedAt || 0);
      return tb - ta;
    });
    if (!sorted.length) {
      table.innerHTML = `<div class="sub-empty">尚無開通/儲值紀錄</div>`;
      return;
    }
    table.innerHTML = sorted.map((log) => {
      const statusLabel = (() => {
        if (log.status === 'used' || log.status === 'active') return '成功';
        if (log.status === 'invalid') return '無效';
        if (log.status === 'expired') return '已過期';
        return log.status || '未知';
      })();
      const actionLabel = log.type === 'account'
        ? '帳號啟用'
        : (log.type === 'activate' ? '開通' : `展期 ${log.extendDays ? `+${log.extendDays} 天` : ''}`.trim());
      const channel = log.channel || (log.type === 'account' ? '帳號建立' : 'QR 憑證');
      const expiresAfter = log.expiresAfter ? fmt(log.expiresAfter) : null;
      const ts = Number(log.usedAt || log.issuedAt || 0) * 1000;
      const dt = Number.isFinite(ts) && ts > 0 ? new Date(ts) : null;
      const dateStr = dt ? dt.toLocaleDateString() : '—';
      const timeStr = dt ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      return `
        <div class="sub-table-row">
          <div class="cell primary">
            <div class="cell-title">${dateStr}${timeStr ? `<span class="sub-time"> ${timeStr}</span>` : ''}</div>
            <div class="cell-sub"></div>
          </div>
          <div class="cell">
            <div class="cell-title">${actionLabel}${statusLabel ? ` ｜ ${statusLabel}` : ''}</div>
            <div class="cell-sub"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderStatusTab() {
    const current = sessionStore.subscriptionState;
    stopSubscriptionCountdown();
    const statusText = document.getElementById('subscriptionStatusText');
    const meta = document.getElementById('subscriptionMeta');
    if (statusText) {
      const { expired, text } = computeSubscriptionCountdown(current.expiresAt || 0);
      statusText.textContent = current.found ? text : '尚未儲值';
      statusText.className = expired ? 'sub-status error' : 'sub-status ok';
    }
    if (meta) {
      meta.textContent = current.found ? '狀態自動同步' : '尚無訂閱紀錄';
    }
    renderTables(current.logs || []);
  }

  function renderWizard() {
    const steps = Array.from(document.querySelectorAll('#subscriptionWizardSteps .sub-step'));
    steps.forEach((stepEl) => {
      const n = Number(stepEl.dataset.step || 0);
      stepEl.classList.toggle('active', wizard.step === n);
      stepEl.classList.toggle('done', wizard.step > n);
    });
    if (!wizardContent) return;
    if (wizard.step === 1) {
      wizardContent.innerHTML = `
        <div class="channel-grid">
          <button type="button" class="channel-card" data-channel="qr">
            <div class="channel-icon"><i class='bx bx-qr-scan'></i></div>
            <div class="channel-body">
              <div class="channel-title">QRCode 儲值</div>
              <div class="channel-sub">使用憑證 QR 展期，支援掃描與圖檔上傳。</div>
            </div>
          </button>
          <div class="channel-card disabled" data-channel="ecpay">
            <div class="channel-icon"><i class='bx bx-credit-card'></i></div>
            <div class="channel-body">
              <div class="channel-title">綠界金流</div>
              <div class="channel-sub">即將開放，敬請期待。</div>
            </div>
            <span class="channel-badge">即將開放</span>
          </div>
        </div>
      `;
      wizardContent.querySelector('[data-channel="qr"]')?.addEventListener('click', () => {
        wizard.channel = 'qr';
        wizard.step = 2;
        wizard.result = null;
        renderWizard();
      });
      wizardContent.querySelector('[data-channel="ecpay"]')?.addEventListener('click', () => {
        showToast?.('綠界管道即將開放，請先使用 QR 憑證儲值', { variant: 'info' });
      });
      stopSubscriptionScanner({ destroy: true });
      return;
    }

    if (wizard.step === 2) {
      wizardContent.innerHTML = `
        <div class="scan-pane">
          <div class="scan-video-wrap">
            <video id="subscriptionScanVideo" class="scan-video" muted playsinline></video>
            <div class="scan-overlay">請將 QR 憑證置中</div>
          </div>
          <div class="scan-actions">
            <input id="subscriptionFileInput" type="file" accept="image/*" style="display:none" />
            <button id="subscriptionUploadBtn" type="button" class="wide-btn" ${wizard.busy ? 'disabled' : ''}>
              <i class='bx bx-upload'></i> 點擊上傳 QRCode 圖像
            </button>
            <div id="subscriptionScanStatus" class="sub-meta">正在啟動相機…</div>
          </div>
        </div>
      `;
      const fileInput = document.getElementById('subscriptionFileInput');
      const uploadBtn = document.getElementById('subscriptionUploadBtn');
      const scanStatus = document.getElementById('subscriptionScanStatus');
      uploadBtn?.addEventListener('click', () => fileInput?.click());
      fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file || wizard.busy) return;
        wizard.busy = true;
        stopSubscriptionScanner({ destroy: true });
        uploadBtn.disabled = true;
        if (scanStatus) scanStatus.textContent = '上傳並解析中…';
        const tokenRes = await handleSubscriptionFile([file], {
          onError: (err) => {
            wizard.result = { ok: false, message: `解析失敗：${err?.message || err}` };
            wizard.step = 3;
            renderWizard();
          }
        });
        wizard.busy = false;
        uploadBtn.disabled = false;
        if (tokenRes?.ok) {
          wizard.step = 3;
          wizard.result = { ok: true, expiresAt: sessionStore.subscriptionState.expiresAt };
          renderWizard();
          renderStatusTab();
        } else if (!wizard.result) {
          wizard.step = 3;
          wizard.result = { ok: false, message: tokenRes?.error?.message || '儲值失敗，請重試' };
          renderWizard();
        }
      });
      const scanVideo = document.getElementById('subscriptionScanVideo');
      if (scanStatus) scanStatus.textContent = '正在啟動相機…';
      if (scanVideo) {
        QrScanner.WORKER_PATH = '/app/lib/vendor/qr-scanner-worker.min.js';
        stopSubscriptionScanner({ destroy: true });
        try {
          subscriptionScanner = new QrScanner(scanVideo, async (res) => {
            const text = typeof res === 'string' ? res : res?.data || '';
            if (!text || wizard.busy) return;
            wizard.busy = true;
            if (scanStatus) scanStatus.textContent = '辨識到憑證，驗證中…';
            stopSubscriptionScanner();
            const result = await handleRedeemToken(text);
            wizard.busy = false;
            wizard.result = result?.ok
              ? { ok: true, expiresAt: sessionStore.subscriptionState.expiresAt }
              : { ok: false, message: result?.error?.message || '儲值失敗' };
            wizard.step = 3;
            renderWizard();
            if (result?.ok) renderStatusTab();
          });
          subscriptionScanner.start().then(() => {
            subscriptionScannerActive = true;
            if (scanStatus) scanStatus.textContent = '請將憑證 QR 對準框線，或上傳圖檔';
          }).catch((err) => {
            if (scanStatus) scanStatus.textContent = `相機無法啟動：${err?.message || err}`;
          });
        } catch (err) {
          if (scanStatus) scanStatus.textContent = `相機無法啟動：${err?.message || err}`;
        }
      }
      return;
    }

    wizardContent.innerHTML = `
      <div class="result-card ${wizard.result?.ok ? 'success' : 'error'}">
        <div class="result-icon">${wizard.result?.ok ? '✅' : '⚠️'}</div>
        <div class="result-title">${wizard.result?.ok ? '儲值完成' : '儲值失敗'}</div>
        <div class="result-meta">
          ${wizard.result?.ok
        ? `最新到期：${wizard.result?.expiresAt ? fmt(wizard.result.expiresAt) : '已更新'}`
        : (wizard.result?.message || '請確認憑證是否有效或已使用')}
        </div>
        <div class="result-actions">
          <button type="button" class="secondary" id="subscriptionWizardRetry">再儲值一次</button>
          <button type="button" class="primary" id="subscriptionWizardViewStatus">查看訂閱狀態</button>
        </div>
      </div>
    `;
    document.getElementById('subscriptionWizardRetry')?.addEventListener('click', () => {
      wizard.step = 1;
      wizard.result = null;
      wizard.channel = null;
      stopSubscriptionScanner({ destroy: true });
      renderWizard();
    });
    document.getElementById('subscriptionWizardViewStatus')?.addEventListener('click', () => {
      subscriptionSwitchTab('status');
      renderStatusTab();
    });
    stopSubscriptionScanner({ destroy: true });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => subscriptionSwitchTab(btn.dataset.tab));
  });

  document.getElementById('subscriptionRefreshBtn')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.classList.add('loading');
    await refreshSubscriptionStatus();
    renderStatusTab();
    btn.disabled = false;
    btn.classList.remove('loading');
  });

  renderWizard();
  refreshSubscriptionStatus({ silent: true }).then(() => {
    renderStatusTab();
  });
}

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
  wsSend
});

const contactsView = initContactsView({
  dom: { contactsListEl, contactsScrollEl, contactsRefreshEl, contactsRefreshLabel, contactsCountEl },
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
    contact?.peer_account_digest ||
    contact?.accountDigest ||
    contact?.account_digest ||
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

function getEffectiveSettingsState() {
  return { ...DEFAULT_SETTINGS, ...(sessionStore.settingsState || {}) };
}

function sanitizeLogoutRedirectUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    if (!parsed.hostname) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function logSettingsBootStart({ digest, convId, mkReady }) {
  try {
    console.info('[settings] boot:load:start ' + JSON.stringify({ digest, convId, mkReady }));
  } catch { }
}

async function bootLoadSettings() {
  const digest = getAccountDigest();
  const convId = digest ? `settings-${String(digest).toUpperCase()}` : null;
  const mkReady = !!getMkRaw();
  logSettingsBootStart({ digest: digest || null, convId, mkReady });
  if (!mkReady || !convId) {
    const err = new Error('settings boot prerequisites missing');
    try {
      console.info('[settings] boot:load:done ' + JSON.stringify({
        ok: false,
        hasEnvelope: false,
        reason: 'mk/account missing',
        ts: null
      }));
    } catch { }
    throw err;
  }
  try {
    const { settings, meta } = await loadSettings({ returnMeta: true });
    const info = meta || {};
    try {
      console.info('[settings] boot:load:done ' + JSON.stringify({
        ok: info.ok !== false,
        hasEnvelope: !!info.hasEnvelope,
        urlMode: info.urlMode || null,
        hasUrl: !!info.hasUrl,
        urlLen: info.urlLen || 0,
        ts: info.ts || null
      }));
    } catch { }
    const applied = settings || { ...DEFAULT_SETTINGS, updatedAt: Date.now() };
    sessionStore.settingsState = applied;
    try {
      console.info('[settings] boot:apply ' + JSON.stringify({
        autoLogoutRedirectMode: applied.autoLogoutRedirectMode || null,
        hasCustomLogoutUrl: !!applied.autoLogoutCustomUrl
      }));
    } catch { }
    return applied;
  } catch (err) {
    try {
      console.info('[settings] boot:load:done ' + JSON.stringify({
        ok: false,
        hasEnvelope: true,
        reason: err?.message || String(err),
        ts: null
      }));
    } catch { }
    throw err;
  }
}

function isSettingsConversationId(convId) {
  return typeof convId === 'string' && convId.startsWith('settings-');
}

async function handleSettingsSecureMessage() {
  try {
    const refreshed = await loadSettings();
    if (refreshed && typeof refreshed === 'object') {
      sessionStore.settingsState = refreshed;
    }
  } catch (err) {
    log({ settingsHydrateError: err?.message || err });
  }
}

function openCustomLogoutUrlModal({ initialValue = '', onSubmit, onCancel, invoker } = {}) {
  const {
    modal,
    input,
    saveBtn,
    errorEl
  } = getCustomLogoutElements();
  if (!modal || !input || !saveBtn) return;
  bindCustomLogoutHandlers();
  customLogoutModalContext = { onSubmit, onCancel };
  customLogoutInvoker = invoker || null;
  input.value = initialValue || '';
  input.placeholder = LOGOUT_REDIRECT_PLACEHOLDER;
  if (errorEl) errorEl.textContent = '';
  saveBtn.disabled = false;
  saveBtn.textContent = '儲存';
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => {
    try { customLogoutInput.focus({ preventScroll: true }); } catch { customLogoutInput.focus(); }
  }, 30);
}

function closeCustomLogoutUrlModal() {
  const { modal } = getCustomLogoutElements();
  if (!modal) return;
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
  customLogoutModalContext = null;
  const focusTarget = customLogoutInvoker;
  customLogoutInvoker = null;
  if (focusTarget && typeof focusTarget.focus === 'function') {
    try { focusTarget.focus({ preventScroll: true }); } catch { focusTarget.focus(); }
  }
}

function handleCustomLogoutCancel() {
  const handler = customLogoutModalContext?.onCancel;
  closeCustomLogoutUrlModal();
  if (typeof handler === 'function') {
    try { handler(); } catch (err) { log({ customLogoutCancelError: err?.message || err }); }
  }
}

async function handleCustomLogoutSave() {
  if (!customLogoutModalContext || typeof customLogoutModalContext.onSubmit !== 'function') return;
  const { input, saveBtn, errorEl } = getCustomLogoutElements();
  if (!input || !saveBtn) return;
  const sanitized = sanitizeLogoutRedirectUrl(input.value || '');
  if (!sanitized) {
    if (errorEl) errorEl.textContent = '請輸入有效的 http/https 網址，例如 https://example.com。';
    input.focus();
    return;
  }
  if (errorEl) errorEl.textContent = '';
  const originalLabel = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = '儲存中…';
  try {
    await customLogoutModalContext.onSubmit(sanitized);
    closeCustomLogoutUrlModal();
  } catch (err) {
    log({ customLogoutSaveError: err?.message || err });
    const message = err?.userMessage || err?.message || '儲存設定失敗，請稍後再試。';
    if (errorEl) errorEl.textContent = message;
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = originalLabel;
  }
}

function bindCustomLogoutHandlers() {
  if (customLogoutHandlersBound) return;
  const { cancelBtn, closeBtn, backdrop, saveBtn, input, errorEl } = getCustomLogoutElements();
  if (!cancelBtn && !closeBtn && !backdrop && !saveBtn && !input) return;
  cancelBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    handleCustomLogoutCancel();
  });
  closeBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    handleCustomLogoutCancel();
  });
  backdrop?.addEventListener('click', (event) => {
    event.preventDefault();
    handleCustomLogoutCancel();
  });
  saveBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    handleCustomLogoutSave();
  });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleCustomLogoutSave();
    }
  });
  input?.addEventListener('input', () => {
    if (errorEl) errorEl.textContent = '';
  });
  customLogoutHandlersBound = true;
}

function getLogoutRedirectInfo(settings = getEffectiveSettingsState()) {
  const state = settings || getEffectiveSettingsState();
  const sanitized = sanitizeLogoutRedirectUrl(state.autoLogoutCustomUrl);
  const isCustom = state.autoLogoutRedirectMode === 'custom' && !!sanitized;
  return {
    url: isCustom ? sanitized : LOGOUT_REDIRECT_DEFAULT_URL,
    isCustom
  };
}

function getLogoutRedirectTarget(settings) {
  return getLogoutRedirectInfo(settings).url;
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

function resetModalVariants(modalElement) {
  modalElement.classList.remove(...MODAL_VARIANTS);
}

async function persistSettingsPatch(partial) {
  const previous = getEffectiveSettingsState();
  const next = { ...previous, ...partial };
  const trackedKeys = ['showOnlineStatus', 'autoLogoutOnBackground', 'autoLogoutRedirectMode', 'autoLogoutCustomUrl'];
  const noChange = trackedKeys.every((key) => previous[key] === next[key]);
  if (noChange) return previous;
  sessionStore.settingsState = next;
  try {
    const saved = await saveSettings(next);
    sessionStore.settingsState = saved;
    log({
      settingsSaved: {
        showOnlineStatus: saved.showOnlineStatus,
        autoLogoutOnBackground: saved.autoLogoutOnBackground,
        autoLogoutRedirectMode: saved.autoLogoutRedirectMode,
        hasCustomLogoutUrl: !!sanitizeLogoutRedirectUrl(saved.autoLogoutCustomUrl)
      }
    });
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

  const customSummaryValue = sanitizeLogoutRedirectUrl(current.autoLogoutCustomUrl) || '尚未設定安全網址';
  const autoLogoutDetailsVisible = !!current.autoLogoutOnBackground;

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
      <div id="settingsAutoLogoutOptions" class="settings-nested ${autoLogoutDetailsVisible ? '' : 'hidden'}" aria-hidden="${autoLogoutDetailsVisible ? 'false' : 'true'}">
        <label class="settings-option">
          <input type="radio" name="autoLogoutRedirect" id="settingsLogoutDefault" value="default" ${current.autoLogoutRedirectMode !== 'custom' ? 'checked' : ''} />
        <div class="option-body">
          <strong>預設登出頁面</strong>
          <p>使用系統提供的安全登出頁面。</p>
        </div>
      </label>
      <div class="settings-option custom-option">
        <input type="radio" name="autoLogoutRedirect" id="settingsLogoutCustom" value="custom" ${current.autoLogoutRedirectMode === 'custom' ? 'checked' : ''} />
        <div class="option-body">
          <strong>客製化登出頁面</strong>
          <p>導向指定的 HTTPS 網址，僅限受信任的頁面。</p>
          <div class="custom-summary" id="settingsLogoutSummary">${escapeHtml(customSummaryValue)}</div>
          <button type="button" class="settings-link subtle" id="settingsLogoutManage">設定網址</button>
        </div>
      </div>
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
  const autoLogoutOptionsSection = body.querySelector('#settingsAutoLogoutOptions');
  const logoutDefaultRadio = body.querySelector('#settingsLogoutDefault');
  const logoutCustomRadio = body.querySelector('#settingsLogoutCustom');
  const logoutSummaryEl = body.querySelector('#settingsLogoutSummary');
  const logoutManageBtn = body.querySelector('#settingsLogoutManage');
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

  const setAutoLogoutOptionsVisibility = (visible) => {
    if (!autoLogoutOptionsSection) return;
    autoLogoutOptionsSection.classList.toggle('hidden', !visible);
    autoLogoutOptionsSection.setAttribute('aria-hidden', visible ? 'false' : 'true');
  };

  const syncLogoutRadios = () => {
    const state = getEffectiveSettingsState();
    if (logoutDefaultRadio) logoutDefaultRadio.checked = state.autoLogoutRedirectMode !== 'custom';
    if (logoutCustomRadio) logoutCustomRadio.checked = state.autoLogoutRedirectMode === 'custom';
  };

  const syncLogoutSaveButton = () => {
    const { saveBtn } = getCustomLogoutElements();
    if (!saveBtn) return;
    const state = getEffectiveSettingsState();
    const url = sanitizeLogoutRedirectUrl(state.autoLogoutCustomUrl);
    const enabled = !!url && state.autoLogoutRedirectMode === 'custom';
    saveBtn.disabled = !enabled;
  };

  const refreshLogoutSummary = () => {
    if (!logoutSummaryEl) return;
    const saved = sanitizeLogoutRedirectUrl(getEffectiveSettingsState().autoLogoutCustomUrl);
    logoutSummaryEl.textContent = saved || '尚未設定安全網址';
  };

  const launchCustomLogoutModal = (invoker) => {
    openCustomLogoutUrlModal({
      initialValue: sanitizeLogoutRedirectUrl(getEffectiveSettingsState().autoLogoutCustomUrl) || LOGOUT_REDIRECT_SUGGESTIONS[0] || '',
      invoker,
      onSubmit: async (url) => {
        await persistSettingsPatch({ autoLogoutCustomUrl: url, autoLogoutRedirectMode: 'custom' });
        refreshLogoutSummary();
        syncLogoutRadios();
      },
      onCancel: () => {
        refreshLogoutSummary();
        syncLogoutRadios();
      }
    });
  };

  setAutoLogoutOptionsVisibility(autoLogoutDetailsVisible);
  syncLogoutRadios();
  refreshLogoutSummary();

  logoutManageBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    if (logoutCustomRadio) logoutCustomRadio.checked = true;
    launchCustomLogoutModal(event.currentTarget);
  });

  logoutDefaultRadio?.addEventListener('change', async () => {
    if (!logoutDefaultRadio.checked) return;
    logoutDefaultRadio.disabled = true;
    logoutCustomRadio && (logoutCustomRadio.disabled = true);
    try {
      await persistSettingsPatch({ autoLogoutRedirectMode: 'default', autoLogoutCustomUrl: null });
      refreshLogoutSummary();
    } catch (err) {
      log({ logoutRedirectModeSaveError: err?.message || err, mode: 'default' });
      alert('儲存設定失敗，請稍後再試。');
    } finally {
      logoutDefaultRadio.disabled = false;
      if (logoutCustomRadio) logoutCustomRadio.disabled = false;
      syncLogoutRadios();
    }
  });

  logoutCustomRadio?.addEventListener('change', (event) => {
    if (!logoutCustomRadio.checked) return;
    if (event && event.isTrusted === false) return;
    launchCustomLogoutModal(event.currentTarget);
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
  if (autoLogoutInput) {
    autoLogoutInput.addEventListener('change', async () => {
      const previous = getEffectiveSettingsState();
      const prevValue = !!previous.autoLogoutOnBackground;
      const nextValue = !!autoLogoutInput.checked;
      if (prevValue === nextValue) {
        setAutoLogoutOptionsVisibility(nextValue);
        return;
      }
      autoLogoutInput.disabled = true;
      setAutoLogoutOptionsVisibility(nextValue);
      try {
        await persistSettingsPatch({ autoLogoutOnBackground: nextValue });
        _autoLoggedOut = false;
      } catch (err) {
        log({ settingsAutoSaveError: err?.message || err });
        alert('儲存設定失敗，請稍後再試。');
        autoLogoutInput.checked = prevValue;
      } finally {
        autoLogoutInput.disabled = false;
        const state = getEffectiveSettingsState();
        setAutoLogoutOptionsVisibility(!!state.autoLogoutOnBackground);
        syncLogoutRadios();
        syncLogoutSaveButton();
      }
    });
  }
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
  const accountToken = getAccountToken();
  const accountDigest = getAccountDigest();
  const serverId = getOpaqueServerId();
  if (!accountToken || !accountDigest) {
    const err = new Error('帳號資訊不足，請重新登入後再試。');
    err.userMessage = err.message;
    throw err;
  }
  const { r, data } = await mkUpdate({ accountToken, accountDigest, wrapped_mk: newWrapped });
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
  emitMkSetTrace('app-mobile:change-password', mk);
  log({ passwordChangedAt: Date.now() });
  return true;
}

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

let profileHydrationStarted = false;

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
      const acct = toProfileDigest(thread?.peerAccountDigest || thread?.peer_account_digest || null);
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
      const acct = toProfileDigest(thread?.peerAccountDigest || thread?.peer_account_digest || null);
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
  if (profileHydrationStarted) return;
  profileHydrationStarted = true;
  const targets = collectProfileHydrateTargets();
  for (const digest of targets) {
    // 逐個執行，避免洪泛請求；失敗會記錄原因。
    // eslint-disable-next-line no-await-in-loop
    await hydrateProfileSnapshotForDigest(digest);
  }
}

// [FIX: Hydration Race] Flag to block WS until keys are loaded
let hydrationComplete = false;

const postLoginInitPromise = (async () => {
  try {
    await seedProfileCounterOnce();
  } catch (err) {
    log({ profileCounterSeedError: err?.message || err });
  }
  return runPostLoginContactHydrate();
})();

postLoginInitPromise
  .then(() => {
    messagesPane.syncConversationThreadsFromContacts();
    return messagesPane.refreshConversationPreviews({ force: true });
  })
  .catch((err) => log({ contactsInitError: err?.message || err }))
  .finally(() => {
    messagesPane.renderConversationList();
    messagesFlowFacade.onLoginResume({ source: 'login', runOfflineCatchup: false });
    flushOutbox({ sourceTag: 'post_login' }).catch(() => { });
    hydrationComplete = true; // [FIX] Release the guard
    ensureWebSocket();
    hydrateProfileSnapshots().catch((err) => log({ profileHydrateStartError: err?.message || err }));
    logRestoreOverview({ reason: 'post-login' });
    messagesFlowFacade.onLoginResume({ source: 'login', runRestore: false, runOfflineDecrypt: false });
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

function ensureWebSocket() {
  if (wsConn || wsReconnectTimer) return;
  const digest = getAccountDigest();
  if (!digest) {
    log({ wsSkip: 'missing_account_digest' });
    return;
  }
  // [FIX] Block connection if keys aren't ready
  if (!hydrationComplete) {
    if (wsDebugEnabled) console.log('[ws-ensure] Skipped: Hydration pending');
    return;
  }
  log({ wsEnsure: true, state: wsConn?.readyState ?? 'none' });
  connectWebSocket().catch((err) => {
    log({ wsConnectError: err?.message || err });
  });
}

function resolveWsPeer(msg = {}) {
  return normalizePeerIdentity({
    peerAccountDigest: msg.peerAccountDigest || msg.fromAccountDigest || null
  });
}

function isTargetingThisDevice(msg = {}) {
  const targetDeviceId = msg.targetDeviceId || null;
  if (!targetDeviceId) return true;
  const selfDeviceId = typeof getDeviceId === 'function' ? (getDeviceId() || ensureDeviceId()) : null;
  if (!selfDeviceId) return false;
  return String(targetDeviceId).trim() === String(selfDeviceId).trim();
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
  const accountDigest = getAccountDigest();
  if (!accountDigest) throw new Error('缺少 accountDigest');
  const nowSec = Date.now();
  if (!force && wsAuthTokenInfo && wsAuthTokenInfo.token) {
    const exp = Number(wsAuthTokenInfo.expiresAt || 0);
    if (!exp || exp - nowSec > 30) {
      return wsAuthTokenInfo;
    }
  }
  const accountToken = getAccountToken();
  const sessionTs = getLoginSessionTs();
  const { r, data } = await requestWsToken({ accountToken, accountDigest, sessionTs });
  if (!r.ok || !data?.token) {
    const message = typeof data === 'string' ? data : data?.message || data?.error || 'ws token failed';
    const err = new Error(message);
    err.status = r.status;
    err.code = typeof data === 'object' ? (data?.error || null) : null;
    throw err;
  }
  const expiresAt = Number(data.expiresAt || data.exp || 0) || null;
  wsAuthTokenInfo = { token: data.token, expiresAt };
  return wsAuthTokenInfo;
}

async function connectWebSocket() {
  const accountDigest = getAccountDigest();
  if (!accountDigest) return;
  if (wsDebugEnabled) {
    log({ wsConnectStart: true, accountDigest });
  }
  let tokenInfo;
  try {
    tokenInfo = await getWsAuthToken();
  } catch (err) {
    log({ wsTokenError: err?.message || err, status: err?.status, code: err?.code });
    if (err?.status === 409 || err?.code === 'StaleSession') {
      showForcedLogoutModal('帳號已在其他裝置登入');
      secureLogout('帳號已在其他裝置登入', { auto: true });
      return;
    }
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
  const wsUrl = `${proto}//${baseHost}${path}`;
  if (wsDebugEnabled) {
    log({ wsConnectUrl: wsUrl });
  }
  const ws = new WebSocket(wsUrl);
  wsConn = ws;
  updateConnectionIndicator('connecting');
  ws.onopen = () => {
    if (ws !== wsConn) return; // stale socket
    if (wsDebugEnabled) {
      log({ wsState: 'open' });
    }
    wsReconnectTimer = null;
    try {
      ws.send(JSON.stringify({ type: 'auth', accountDigest, token: tokenInfo.token }));
    } catch (err) {
      log({ wsAuthSendError: err?.message || err });
    }
    if (pendingWsMessages.length) {
      for (const msg of pendingWsMessages.splice(0)) {
        try {
          ws.send(JSON.stringify(msg));
        } catch (err) {
          log({ wsSendError: err?.message || err });
        }
      }
    }
  };
  ws.onmessage = (event) => {
    if (ws !== wsConn) return; // stale socket
    if (wsDebugEnabled) {
      log({ wsMessageRaw: event.data });
    }
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const msgType = msg?.type || null;
    if (isForensicsWsSecureMessage(msgType)) {
      try {
        logForensicsEvent('WS_RECV', buildWsForensicsSummary(msg));
      } catch { }
    }
    handleWebSocketMessage(msg);
  };
  ws.onclose = (evt) => {
    if (ws !== wsConn) return; // stale socket (likely replaced)
    if (wsDebugEnabled) {
      log({ wsClose: { code: evt.code, reason: evt.reason } });
    }
    wsConn = null;
    updateConnectionIndicator('offline');
    presenceManager.clearPresenceState();
    if (evt.code === 4409) {
      showForcedLogoutModal('帳號已在其他裝置登入');
      secureLogout('帳號已在其他裝置登入', { auto: true });
      return;
    }
    if (evt.code === 4401) {
      wsAuthTokenInfo = null;
    }
    scheduleWsReconnect();
  };
  ws.onerror = () => {
    if (ws !== wsConn) return; // stale socket
    if (wsDebugEnabled) {
      log({ wsError: true });
    }
    updateConnectionIndicator('offline');
    wsAuthTokenInfo = null;
    try { ws.close(); } catch { }
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

wsSend.isReady = () => !!(wsConn && wsConn.readyState === WebSocket.OPEN);
messagesPane.setWsSend(wsSend);
setMessagesWsSender(wsSend);
setMessagesFlowFacadeWsSend(wsSend);
shareController?.setWsSend?.(wsSend);
setCallSignalSender(wsSend);
if (!wsMonitorTimer) {
  wsMonitorTimer = setInterval(() => {
    if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
      log({ wsMonitorReconnect: true, readyState: wsConn?.readyState ?? null });
      ensureWebSocket();
    }
  }, 5000);
}

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

function isForensicsWsSecureMessage(type) {
  return type === 'secure-message' || type === 'message-new';
}

function buildWsForensicsSummary(msg = {}) {
  const conversationId = String(msg?.conversationId || msg?.conversation_id || '').trim() || null;
  const messageId = msg?.messageId || msg?.message_id || msg?.id || null;
  const serverMessageId = msg?.serverMessageId || msg?.server_message_id || null;
  const senderDeviceId = msg?.senderDeviceId || msg?.sender_device_id || null;
  const targetDeviceId = msg?.targetDeviceId || msg?.target_device_id || null;
  const msgType = msg?.msgType || msg?.msg_type || msg?.type || null;
  const ts = msg?.ts ?? msg?.timestamp ?? msg?.createdAt ?? msg?.created_at ?? null;
  return {
    conversationId,
    messageId,
    serverMessageId,
    senderDeviceId,
    targetDeviceId,
    msgType,
    ts
  };
}

function normalizeWsToken(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function resolveWsIncomingPeerIdentity(msg = {}) {
  return normalizePeerIdentity({
    peerAccountDigest: msg?.senderAccountDigest
      || msg?.fromAccountDigest
      || msg?.sender_account_digest
      || msg?.senderDigest
      || msg?.sender_digest
      || null,
    peerDeviceId: msg?.senderDeviceId
      || msg?.sender_device_id
      || null
  });
}

function resolveWsConversationToken({ conversationId, peerAccountDigest, peerDeviceId } = {}) {
  const convId = typeof conversationId === 'string' ? conversationId.trim() : '';
  let tokenB64 = null;
  let resolvedPeerDigest = normalizeAccountDigest(peerAccountDigest || null);
  let resolvedPeerDeviceId = normalizePeerDeviceId(peerDeviceId || null);
  if (!convId) {
    return { tokenB64: null, peerAccountDigest: resolvedPeerDigest || null, peerDeviceId: resolvedPeerDeviceId || null };
  }
  const convIndex = sessionStore.conversationIndex instanceof Map ? sessionStore.conversationIndex : null;
  if (convIndex) {
    const entry = convIndex.get(convId) || null;
    const tokenCandidate = normalizeWsToken(entry?.token_b64 || entry?.tokenB64 || entry?.conversationToken || null);
    if (!tokenB64 && tokenCandidate) tokenB64 = tokenCandidate;
    if (!resolvedPeerDigest) {
      resolvedPeerDigest = normalizeAccountDigest(entry?.peerAccountDigest || entry?.peer_account_digest || null);
    }
    if (!resolvedPeerDeviceId) {
      resolvedPeerDeviceId = normalizePeerDeviceId(entry?.peerDeviceId || entry?.peer_device_id || null);
    }
  }
  const threads = sessionStore.conversationThreads instanceof Map ? sessionStore.conversationThreads : null;
  if (!tokenB64 && threads) {
    const entry = threads.get(convId) || null;
    const tokenCandidate = normalizeWsToken(entry?.conversationToken || entry?.token_b64 || entry?.tokenB64 || null);
    if (!tokenB64 && tokenCandidate) tokenB64 = tokenCandidate;
    if (!resolvedPeerDigest) {
      resolvedPeerDigest = normalizeAccountDigest(entry?.peerAccountDigest || entry?.peer_account_digest || null);
    }
    if (!resolvedPeerDeviceId) {
      resolvedPeerDeviceId = normalizePeerDeviceId(entry?.peerDeviceId || entry?.peer_device_id || null);
    }
  }
  if (!tokenB64 && resolvedPeerDigest) {
    const secret = getContactSecret(resolvedPeerDigest, { peerDeviceId: resolvedPeerDeviceId });
    const tokenCandidate = normalizeWsToken(secret?.conversationToken || secret?.conversation?.token || null);
    if (!tokenB64 && tokenCandidate) tokenB64 = tokenCandidate;
    if (!resolvedPeerDeviceId) {
      resolvedPeerDeviceId = normalizePeerDeviceId(secret?.peerDeviceId || null);
    }
  }
  return {
    tokenB64: tokenB64 || null,
    peerAccountDigest: resolvedPeerDigest || null,
    peerDeviceId: resolvedPeerDeviceId || null
  };
}

function buildWsLiveJobContext(msg = {}, convId = null) {
  const conversationId = typeof convId === 'string' ? convId.trim() : '';
  const peerIdentity = resolveWsIncomingPeerIdentity(msg);
  const tokenInfo = resolveWsConversationToken({
    conversationId,
    peerAccountDigest: peerIdentity.accountDigest,
    peerDeviceId: peerIdentity.deviceId
  });
  return {
    conversationId: conversationId || null,
    tokenB64: tokenInfo.tokenB64 || null,
    peerAccountDigest: tokenInfo.peerAccountDigest || peerIdentity.accountDigest || null,
    peerDeviceId: tokenInfo.peerDeviceId || peerIdentity.deviceId || null,
    messageId: msg?.messageId || msg?.message_id || msg?.id || null,
    serverMessageId: msg?.serverMessageId || msg?.server_message_id || msg?.serverMsgId || null,
    sourceTag: 'ws_incoming'
  };
}

function handleWebSocketMessage(msg) {
  const type = msg?.type;
  if (type === 'hello') return;
  if (type === 'auth') {
    if (msg?.ok) updateConnectionIndicator('online');
    else updateConnectionIndicator('offline');
    if (msg?.ok) {
      presenceManager.sendPresenceSubscribe();
      messagesPane.refreshAfterReconnect?.();
      messagesFlowFacade.onLoginResume({
        source: 'ws_reconnect',
        runRestore: false,
        onOfflineDecryptError: (err) => log({ offlineDecryptSyncError: err?.message || err, source: 'ws_reconnect' }),
        reconcileOutgoingStatus: (params) => messagesFlowFacade.reconcileOutgoingStatusNow({
          ...params,
          reconcileOutgoingStatusNow: messagesPane?.reconcileOutgoingStatusNow
        })
      });
      flushOutbox({ sourceTag: 'ws_auth_ok' }).catch(() => { });
    }
    return;
  }
  if (type === 'force-logout') {
    const reason = msg?.reason || '帳號已被清除';
    showForcedLogoutModal(reason);
    secureLogout(reason, { auto: true });
    return;
  }
  if (handleCallSignalMessage(msg) || handleCallAuxMessage(msg)) {
    return;
  }
  if (type === 'contact-removed') {
    if (!isTargetingThisDevice(msg)) return;
    const identity = resolveWsPeer(msg);
    const peerAccountDigest = identity.key;
    if (peerAccountDigest) {
      try {
        document.dispatchEvent(new CustomEvent('contacts:removed', { detail: { peerAccountDigest, notifyPeer: false } }));
      } catch (err) {
        log({ contactRemovedEventError: err?.message || err, peerAccountDigest });
      }
    }
    return;
  }
  if (type === 'invite-delivered') {
    if (!isTargetingThisDevice(msg)) return;
    const inviteId = msg?.inviteId || null;
    if (!inviteId) {
      log({ inviteDeliveredMissingId: true });
      return;
    }
    shareController?.consumeInviteDropbox?.(inviteId, { source: 'ws' })
      .catch((err) => log({ inviteConsumeError: err?.message || err, inviteId }));
    return;
  }
  if (type === 'contacts-reload') {
    if (!isTargetingThisDevice(msg)) return;
    loadInitialContacts()
      .then(() => hydrateProfileSnapshots())
      .catch((err) => log({ contactsInitError: err?.message || err }));
    return;
  }
  if (type === 'presence') {
    const online = Array.isArray(msg?.onlineAccountDigests) ? msg.onlineAccountDigests
      : Array.isArray(msg?.onlineDigests) ? msg.onlineDigests
        : Array.isArray(msg?.online_accounts) ? msg.online_accounts
          : Array.isArray(msg?.online) ? msg.online
            : [];
    presenceManager.applyPresenceSnapshot(online);
    return;
  }
  if (type === 'presence-update') {
    const identity = resolveWsPeer(msg);
    if (!identity.key) return;
    presenceManager.setContactPresence(identity, !!msg?.online);
    return;
  }
  if (type === 'vault-ack') {
    if (!isTargetingThisDevice(msg)) return;
    messagesPane.handleVaultAckEvent?.(msg);
    return;
  }
  if (type === 'conversation-deleted') {
    if (!isTargetingThisDevice(msg)) return;
    if (!msg?.senderDeviceId || !msg?.targetDeviceId) {
      log({ secureMessageMissingDeviceId: true, type, hasSender: !!msg?.senderDeviceId, hasTarget: !!msg?.targetDeviceId });
      return;
    }
    const convId = String(msg?.conversationId || msg?.conversation_id || '').trim();
    if (isSettingsConversationId(convId)) {
      handleSettingsSecureMessage();
      return;
    }
    const liveJobCtx = buildWsLiveJobContext(msg, convId);
    messagesFlowFacade.onWsIncomingMessageNew({
      event: msg,
      handleIncomingSecureMessage: messagesPane.handleIncomingSecureMessage
    }, liveJobCtx);
    return;
  }
  if (type === 'secure-message' || type === 'message-new') {
    if (!isTargetingThisDevice(msg)) return;
    if (!msg?.senderDeviceId || !msg?.targetDeviceId) {
      log({ secureMessageMissingDeviceId: true, type, hasSender: !!msg?.senderDeviceId, hasTarget: !!msg?.targetDeviceId });
      return;
    }
    const convId = String(msg?.conversationId || msg?.conversation_id || '').trim();
    if (isSettingsConversationId(convId)) {
      handleSettingsSecureMessage();
      return;
    }
    if (wsDebugEnabled) {
      try {
        console.log('[ws-dispatch]', {
          type,
          conversationId: convId || null,
          senderAccountDigest: msg?.senderAccountDigest || null,
          senderDeviceId: msg?.senderDeviceId || null,
          targetDeviceId: msg?.targetDeviceId || null,
          targetAccountDigest: msg?.targetAccountDigest || null,
          peerAccountDigest: msg?.peerAccountDigest || null
        });
      } catch { }
    }
    try {
      const summary = buildWsForensicsSummary(msg);
      logForensicsEvent('WS_DISPATCH', {
        ...summary,
        conversationId: convId || summary.conversationId || null,
        handler: 'messagesPane.handleIncomingSecureMessage'
      });
    } catch { }
    const liveJobCtx = buildWsLiveJobContext(msg, convId);
    messagesFlowFacade.onWsIncomingMessageNew({
      event: msg,
      handleIncomingSecureMessage: messagesPane.handleIncomingSecureMessage
    }, liveJobCtx);
    return;
  }
}

// Harden autofill: disable autocomplete/autocapitalize/spellcheck on all inputs
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
      flushDrSnapshotsBeforeLogout('visibilitychange', {
        forceRemote: true,
        keepalive: true,
        sourceTag: 'app-mobile:visibilitychange'
      });
      flushContactSecretsLocal('visibilitychange');
      backgroundLogoutTimer = setTimeout(() => {
        backgroundLogoutTimer = null;
        handleBackgroundAutoLogout();
      }, 500);
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
    flushDrSnapshotsBeforeLogout('pagehide', {
      forceRemote: true,
      keepalive: true,
      sourceTag: 'app-mobile:pagehide'
    });
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
    // 僅在 visibilityState === hidden 時才自動登出；單純 blur 不觸發
    log({ autoLogoutSkip: 'blur-ignored' });
  });
  window.addEventListener('beforeunload', () => {
    disposeCallMediaSession();
  });
}
import { unwrapDevicePrivWithMK } from '../crypto/prekeys.js';

// [DEBUG-NOTIFY] Listen for implicit DR resets
if (typeof document !== 'undefined') {
  document.addEventListener('dr:session-reset', (e) => {
    try {
      const reason = e.detail?.reason || 'unknown';
      const peer = e.detail?.peerAccountDigest || 'unknown';
      console.warn('[App] Implicit DR Session Reset Detected:', e.detail);
      showToast?.(`[Warning] DR Session Reset: ${reason} (${peer.slice(0, 8)}...)`, { variant: 'error', duration: 5000 });
    } catch (err) {
      console.error('[App] Failed to handle dr:session-reset event', err);
    }
  });
}
