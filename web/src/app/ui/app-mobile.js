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
  computeContactSecretsChecksum,
  getContactSecretsStorageKeys,
  getContactSecretsLatestKeys,
  getContactSecretsMetaKeys,
  getContactSecretsChecksumKeys
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
import { initRemoteConsoleRelay } from './mobile/remote-console.js';
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
  triggerContactSecretsBackup
} from '../features/contact-backup.js';

const MEDIA_PERMISSION_KEY = 'media-permission-v1';
const REMOTE_CONSOLE_HANDOFF_KEY = 'remoteConsole:autoEnable';
const out = document.getElementById('out');
setLogSink(out);
try {
  log({ appVersion: window.APP_VERSION || 'unknown', buildAt: window.APP_BUILD_AT || document.lastModified || null });
} catch {}
const BUILD_META = (() => {
  try {
    const version = String(window.APP_VERSION || 'dev');
    const buildAt = String(window.APP_BUILD_AT || document.lastModified || '');
    return { version, buildAt, label: buildAt ? `${version} @ ${buildAt}` : version };
  } catch {
    return { version: 'unknown', buildAt: null, label: 'unknown build' };
  }
})();

const { showToast, hideToast } = createToastController(document.getElementById('appToast'));
let remoteConsoleAutoEnabled = false;
const rootStyle = typeof document !== 'undefined' ? document.documentElement?.style || null : null;

(function autoEnableRemoteConsoleFromHandoff() {
  if (!consumeRemoteConsoleHandoffFlag()) return;
  setTimeout(() => {
    try {
      window.RemoteConsoleRelay?.enable?.();
      showToast?.(`已依登入頁設定啟用遠端 Console（${BUILD_META.label}）。`, { variant: 'info' });
      log({ remoteConsoleAutoEnabled: true });
      remoteConsoleAutoEnabled = true;
      updateMediaPermissionDebugVisibility();
    } catch (err) {
      log({ remoteConsoleAutoEnableError: err?.message || err });
    }
  }, 250);
})();

const navbarEl = document.querySelector('.navbar');
const mainContentEl = document.querySelector('main.content');
const navBadges = typeof document !== 'undefined' ? Array.from(document.querySelectorAll('.nav-badge')) : [];
const logoutRedirectCover = document.getElementById('logoutRedirectCover');
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

let reloadNavigationMemo = null;
let reloadNavigationReason = null;
let reloadLogoutTriggered = false;

const LOGOUT_REDIRECT_DEFAULT_URL = '/pages/logout.html';
const LOGOUT_REDIRECT_PLACEHOLDER = 'https://example.com/logout';
const LOGOUT_REDIRECT_SUGGESTIONS = Object.freeze([
  'https://google.com',
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

const customLogoutModal = document.getElementById('customLogoutModal');
const customLogoutBackdrop = document.getElementById('customLogoutBackdrop');
const customLogoutCloseBtn = document.getElementById('customLogoutClose');
const customLogoutInput = document.getElementById('customLogoutInput');
const customLogoutSaveBtn = document.getElementById('customLogoutSave');
const customLogoutCancelBtn = document.getElementById('customLogoutCancel');
const customLogoutErrorEl = document.getElementById('customLogoutError');
let customLogoutModalContext = null;
let customLogoutInvoker = null;
initRemoteConsoleRelay();
initContactSecretsBackup();
observeTopbarHeight();

function consumeRemoteConsoleHandoffFlag() {
  try {
    const flag = sessionStorage.getItem(REMOTE_CONSOLE_HANDOFF_KEY);
    if (flag === '1') {
      sessionStorage.removeItem(REMOTE_CONSOLE_HANDOFF_KEY);
      return true;
    }
  } catch {}
  return false;
}

function isRemoteConsoleActive() {
  try {
    if (remoteConsoleAutoEnabled) return true;
    return !!window.RemoteConsoleRelay?.status?.()?.enabled;
  } catch {
    return remoteConsoleAutoEnabled;
  }
}

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

function updateMediaPermissionDebugVisibility() {
  if (!mediaPermissionDebugBtn) return;
  mediaPermissionDebugBtn.style.display = isRemoteConsoleActive() ? 'inline-block' : 'none';
}

let pendingServerOps = 0;
let waitOverlayTimer = null;
let shareController = null;

const audioManager = createNotificationAudioManager({ permissionKey: AUDIO_PERMISSION_KEY });
const resumeNotifyAudioContext = () => audioManager.resume();
const playNotificationSound = () => audioManager.play();
const hasAudioPermission = () => audioManager.hasPermission();

function getContactSecretKeyOptions() {
  return {
    uid: getUidHex(),
    accountDigest: getAccountDigest()
  };
}

function readContactSnapshot(storage, keys = []) {
  if (!storage || !keys?.length) return null;
  for (const key of keys) {
    try {
      const value = storage.getItem(key);
      if (value) return { key, value };
    } catch {}
  }
  return null;
}

function writeContactSnapshot(storage, keys = [], value) {
  if (!storage || !keys?.length || value == null) return;
  for (const key of keys) {
    try { storage.setItem(key, value); } catch {}
  }
}

function removeContactKeys(storage, keys = []) {
  if (!storage || !keys?.length) return;
  for (const key of keys) {
    try { storage.removeItem(key); } catch {}
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
  } catch {}
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
  try { sessionStorage.setItem(MEDIA_PERMISSION_KEY, 'granted'); } catch {}
  try { sessionStorage.setItem(AUDIO_PERMISSION_KEY, 'granted'); } catch {}
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
    try { track.stop(); } catch {}
  }
}

function isLiveMicrophoneStream(stream) {
  if (!stream?.getAudioTracks) return false;
  return stream.getAudioTracks().some((track) => track?.readyState === 'live');
}

function cacheMicrophoneStream(stream) {
  if (!isLiveMicrophoneStream(stream)) return null;
  if (cachedMicrophoneStream && cachedMicrophoneStream !== stream) {
    try { stopStreamTracks(cachedMicrophoneStream); } catch {}
  }
  cachedMicrophoneStream = stream;
  try { sessionStore.cachedMicrophoneStream = stream; } catch {}
  return cachedMicrophoneStream;
}

async function collectMicrophonePermissionSignals() {
  const result = { permState: null, hasLabel: false };
  if (typeof navigator === 'undefined') return result;
  const { permissions, mediaDevices } = navigator;
  if (permissions?.query) {
    try {
      result.permState = (await permissions.query({ name: 'microphone' }))?.state || null;
    } catch {}
  }
  if (mediaDevices?.enumerateDevices) {
    try {
      const devices = await mediaDevices.enumerateDevices();
      result.hasLabel = Array.isArray(devices)
        && devices.some((device) => device.kind === 'audioinput' && device.label && device.label.trim());
    } catch {}
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
  try { await resumeNotifyAudioContext()?.catch(() => {}); } catch {}
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      await ctx.resume().catch(() => {});
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start?.(0);
      await ctx.close().catch(() => {});
    }
  } catch {}
  try {
    if (typeof Audio !== 'undefined') {
      const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=');
      audio.muted = true;
      audio.playsInline = true;
      await audio.play().catch(() => {});
      audio.pause();
    }
  } catch {}
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
      try { audio.pause(); audio.src = ''; } catch {}
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
      try { audio.pause(); audio.src = ''; audio.load(); } catch {}
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
    if (isRemoteConsoleActive()) {
      try {
        const toastMessage = permState === 'granted'
          ? '已授權麥克風權限'
          : `權限狀態：${permState || 'unknown'} / Label: ${hasLabel ? '有' : '無'}`;
        showToast?.(toastMessage, { variant: permState === 'granted' || hasLabel ? 'success' : 'warning' });
        log({ mediaPermissionConfirmCheck: { perm: permState, label: hasLabel, toast: toastMessage } });
      } catch (err) {
        log({ mediaPermissionConfirmToastError: err?.message || err });
      }
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
    resumeNotifyAudioContext()?.catch(() => {});
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
      if (!isRemoteConsoleActive()) {
        showToast?.('須啟用遠端 Console 才可查詢', { variant: 'warning' });
        return;
      }
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
          try { stream?.getTracks?.().forEach((track) => track.stop()); } catch {}
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
  updateMediaPermissionDebugVisibility();
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
      if (key?.startsWith('contactSecrets-v1-latest')) continue;
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
  const baseKeys = ['mk_b64', 'uid_hex', 'account_token', 'account_digest', 'uid_digest', 'wrapped_mk', 'wrapped_dev', 'inviteSecrets-v1', LOGOUT_MESSAGE_KEY];
  const opts = getContactSecretKeyOptions();
  const contactKeys = mergeUniqueKeyLists(
    getContactSecretsStorageKeys(opts),
    getContactSecretsStorageKeys({}),
    getContactSecretsLatestKeys(opts),
    getContactSecretsLatestKeys({}),
    getContactSecretsMetaKeys(opts),
    getContactSecretsMetaKeys({}),
    getContactSecretsChecksumKeys(opts),
    getContactSecretsChecksumKeys({})
  );
  const keys = [...baseKeys, ...contactKeys];
  for (const key of keys) {
    try { sessionStorage.removeItem(key); } catch {}
  }
}

function secureLogout(message = '已登出', { auto = false } = {}) {
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
    flushDrSnapshotsBeforeLogout();
  } catch (err) {
    log({ contactSecretsSnapshotFlushError: err?.message || err, reason: 'secure-logout-call' });
  }

  try {
    persistContactSecrets();
    triggerContactSecretsBackup('secure-logout', { force: true, keepalive: true }).catch((err) => {
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
    const keyOptions = getContactSecretKeyOptions();
    const storageKeys = getContactSecretsStorageKeys(keyOptions);
    const latestKeys = getContactSecretsLatestKeys(keyOptions);
    try {
      for (const key of storageKeys) {
        const len = localStorage.getItem(key)?.length || 0;
        if (len > localBytes) localBytes = len;
      }
    } catch {}
    try {
      if (typeof sessionStorage !== 'undefined') {
        for (const key of storageKeys) {
          const len = sessionStorage.getItem(key)?.length || 0;
          if (len > sessionBytesBefore) sessionBytesBefore = len;
        }
      }
    } catch {}
    try { console.log('[contact-secrets-handoff-check]', JSON.stringify({ localBytes, sessionBytesBefore })); } catch {}
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
      } catch {}
    } else if (!contactSecretsSnapshot) {
      persistContactSecretMetadata({ snapshot: null, source: 'missing', keyOptions });
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
    try { location.replace(logoutRedirectTarget); } catch { location.href = logoutRedirectTarget; }
  }, 60);
}

if (typeof window !== 'undefined') {
  try { window.secureLogout = secureLogout; } catch {}
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
  if (!snapshot || typeof snapshot !== 'string') {
    removeContactKeys(sessionStorage, [...metaKeys, ...checksumKeys]);
    removeContactKeys(localStorage, [...metaKeys, ...checksumKeys]);
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
      const checksumJson = JSON.stringify(detail);
      writeContactSnapshot(sessionStorage, checksumKeys, checksumJson);
      writeContactSnapshot(localStorage, checksumKeys, checksumJson);
      try {
        window.__CONTACT_SECRETS_CHECKSUM__ = detail;
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
      const snapshotRecord = readContactSnapshot(localStorage, getContactSecretsStorageKeys(getContactSecretKeyOptions()));
      if (snapshotRecord?.value) {
        log({ contactSecretsAppLoadSummary: summarizeContactSecretsPayload(snapshotRecord.value) });
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
const topbarTitleEl = document.querySelector('.topbar .title');
let remoteConsolePressTimer = null;

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

function handleRemoteConsoleLongPressStart() {
  if (remoteConsolePressTimer) return;
  remoteConsolePressTimer = setTimeout(() => {
    remoteConsolePressTimer = null;
    try {
      window.RemoteConsoleRelay?.enable?.();
      showToast?.(`已啟用遠端 Console，記錄將上傳到 API。（${BUILD_META.label}）`, { variant: 'info' });
      remoteConsoleAutoEnabled = true;
      updateMediaPermissionDebugVisibility();
    } catch (err) {
      log({ remoteConsoleEnableError: err?.message || err });
    }
  }, 1500);
}

function handleRemoteConsoleLongPressEnd() {
  if (!remoteConsolePressTimer) return;
  clearTimeout(remoteConsolePressTimer);
  remoteConsolePressTimer = null;
}

topbarTitleEl?.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch' || event.pointerType === 'mouse') {
    handleRemoteConsoleLongPressStart();
  }
});
topbarTitleEl?.addEventListener('pointerup', handleRemoteConsoleLongPressEnd);
topbarTitleEl?.addEventListener('pointerleave', handleRemoteConsoleLongPressEnd);

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

initVersionInfoButton({
  buttonId: 'userMenuVersionBtn',
  popupId: 'versionInfoPopupAppMenu',
  openModal,
  closeModal
});

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
  try { window.__messagesPane = messagesPane; } catch {}
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
presenceManager = createPresenceManager({
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
    inviteRefreshBtn,
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

function sanitizeLogoutRedirectUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return '';
    if (!parsed.hostname) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function openCustomLogoutUrlModal({ initialValue = '', onSubmit, onCancel, invoker } = {}) {
  if (!customLogoutModal || !customLogoutInput || !customLogoutSaveBtn) return;
  customLogoutModalContext = { onSubmit, onCancel };
  customLogoutInvoker = invoker || null;
  customLogoutInput.value = initialValue || '';
  customLogoutInput.placeholder = LOGOUT_REDIRECT_PLACEHOLDER;
  if (customLogoutErrorEl) customLogoutErrorEl.textContent = '';
  customLogoutSaveBtn.disabled = false;
  customLogoutSaveBtn.textContent = '儲存';
  customLogoutModal.style.display = 'flex';
  customLogoutModal.setAttribute('aria-hidden', 'false');
  setTimeout(() => {
    try { customLogoutInput.focus({ preventScroll: true }); } catch { customLogoutInput.focus(); }
  }, 30);
}

function closeCustomLogoutUrlModal() {
  if (!customLogoutModal) return;
  customLogoutModal.style.display = 'none';
  customLogoutModal.setAttribute('aria-hidden', 'true');
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
  if (!customLogoutInput || !customLogoutSaveBtn) return;
  const sanitized = sanitizeLogoutRedirectUrl(customLogoutInput.value || '');
  if (!sanitized) {
    if (customLogoutErrorEl) customLogoutErrorEl.textContent = '請輸入有效的 HTTPS 網址，例如 https://example.com。';
    customLogoutInput.focus();
    return;
  }
  if (customLogoutErrorEl) customLogoutErrorEl.textContent = '';
  const originalLabel = customLogoutSaveBtn.textContent;
  customLogoutSaveBtn.disabled = true;
  customLogoutSaveBtn.textContent = '儲存中…';
  try {
    await customLogoutModalContext.onSubmit(sanitized);
    closeCustomLogoutUrlModal();
  } catch (err) {
    log({ customLogoutSaveError: err?.message || err });
    const message = err?.userMessage || err?.message || '儲存設定失敗，請稍後再試。';
    if (customLogoutErrorEl) customLogoutErrorEl.textContent = message;
  } finally {
    customLogoutSaveBtn.disabled = false;
    customLogoutSaveBtn.textContent = originalLabel;
  }
}

customLogoutCancelBtn?.addEventListener('click', () => {
  handleCustomLogoutCancel();
});
customLogoutCloseBtn?.addEventListener('click', () => {
  handleCustomLogoutCancel();
});
customLogoutBackdrop?.addEventListener('click', () => {
  handleCustomLogoutCancel();
});
customLogoutSaveBtn?.addEventListener('click', () => {
  handleCustomLogoutSave();
});
customLogoutInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleCustomLogoutSave();
  }
});
customLogoutInput?.addEventListener('input', () => {
  if (customLogoutErrorEl) customLogoutErrorEl.textContent = '';
});

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
      await persistSettingsPatch({ autoLogoutRedirectMode: 'default' });
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
  if (isReloadNavigation()) {
    forceReloadLogout();
    return;
  }
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
  const contacts = Array.isArray(sessionStore.contactState) ? sessionStore.contactState : [];
  const count = contacts.filter((entry) => entry && entry.hidden !== true && entry.isSelfContact !== true).length;
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
    if (isReloadNavigation()) {
      forceReloadLogout();
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      handleBackgroundAutoLogout();
    }
  });
  window.addEventListener('beforeunload', () => {
    disposeCallMediaSession();
  });
}
import { unwrapDevicePrivWithMK } from '../crypto/prekeys.js';
