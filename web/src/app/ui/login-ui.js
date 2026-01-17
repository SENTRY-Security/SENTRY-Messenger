// /app/ui/login-ui.js
// Login page binder: SDM Exchange → Unlock (argon2id) → ensureKeysAfterUnlock → redirect to /pages/app.html
// This module is intentionally self-contained for the login page; it reuses core modules and minimal crypto helpers.

// Removed import of fetchJSON, jsonReq from ../core/http.js
import { log, setLogSink } from '../core/log.js';
import { DEBUG } from './mobile/debug-flags.js';
import { initVersionInfoButton } from './version-info.js';
import {
  getSession, setSession,
  getHasMK, setHasMK,
  getWrappedMK, setWrappedMK,
  getMkRaw, setMkRaw,
  getAccountToken, setAccountToken,
  getAccountDigest, setAccountDigest,
  getDevicePriv, ensureDeviceId,
  resetAll, clearSecrets,
  setOpaqueServerId
} from '../core/store.js';
import { exchangeSDM, unlockAndInit } from '../features/login-flow.js';
import { exchangeFromURLIfPresent, exchangeWithParams, parseSdmParams } from '../features/sdm.js';
import {
  summarizeContactSecretsPayload,
  getContactSecretsStorageKeys,
  getContactSecretsLatestKeys,
  getContactSecretsMetaKeys,
  getContactSecretsChecksumKeys,
  getLegacyContactSecretsStorageKeys,
  getLegacyContactSecretsLatestKeys,
  getLegacyContactSecretsMetaKeys,
  getLegacyContactSecretsChecksumKeys
} from '../core/contact-secrets.js';
import { triggerContactSecretsBackup, hydrateContactSecretsFromBackup } from '../features/contact-backup.js';
import { IDENTICON_PALETTE, buildIdenticonSvg } from '../lib/identicon.js';
import { initProfileDefaultsOnce } from '../features/profile.js';
import { generateSimExchange, upsertSimTag, setSimConfig } from '../../libs/ntag424-sim.js';

function summarizeMkForLog(mkRaw) {
  const summary = { mkLen: mkRaw instanceof Uint8Array ? mkRaw.length : 0, mkHash12: null };
  if (!(mkRaw instanceof Uint8Array) || typeof crypto === 'undefined' || !crypto.subtle?.digest) return Promise.resolve(summary);
  return crypto.subtle.digest('SHA-256', mkRaw).then((digest) => {
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    summary.mkHash12 = hex.slice(0, 12);
    return summary;
  }).catch(() => summary);
}

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
        deviceIdSuffix4: (ensureDeviceId?.() || '').slice(-4) || null
      }
    });
  } catch { }
}

let identityTraceCount = 0;
async function emitIdentityTrace(sourceTag, extra = {}) {
  if (!DEBUG.identityTrace || identityTraceCount >= 5) return;
  identityTraceCount += 1;
  try {
    const { mkHash12 } = await summarizeMkForLog(getMkRaw());
    const accountDigest = getAccountDigest() || null;
    const uidHex = null; // UID removed from store, using accountDigest instead
    let deviceId = null;
    try { deviceId = ensureDeviceId(); } catch { deviceId = null; }
    log({
      identityTrace: {
        sourceTag,
        accountDigestSuffix4: accountDigest ? accountDigest.slice(-4) : null,
        uidHexSuffix4: uidHex ? uidHex.slice(-4) : null,
        deviceIdSuffix4: deviceId ? deviceId.slice(-4) : null,
        mkHash12: mkHash12 || null,
        ...extra
      }
    });
  } catch { }
}

// ---- UI elements ----
const $ = (sel) => document.querySelector(sel);
const out = $('#out');
const modalEl = document.getElementById('loginModal');
const modalBody = document.getElementById('loginModalBody');
const modalClose = document.getElementById('loginModalClose');
const modalBackdrop = document.getElementById('loginModalBackdrop');
const welcomeModal = document.getElementById('welcomeModal');
const welcomeNextBtn = document.getElementById('welcomeNext');
const welcomeCloseBtn = document.getElementById('welcomeClose');
const loginShellEl = document.querySelector('.login-shell');
const uidIdenticonEl = document.getElementById('uidIdenticon');
const uidCardEl = document.getElementById('uidCard');
const passwordAreaEl = document.getElementById('passwordArea');

initVersionInfoButton({ buttonId: 'versionInfoBtnLogin', popupId: 'versionInfoPopupLogin' });

let pendingLogoutNotice = null;

function isAutomationEnv() {
  try {
    if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  } catch { }
  return false;
}
(function captureLogoutNotice() {
  try {
    pendingLogoutNotice = sessionStorage.getItem('app:lastLogoutReason');
  } catch { }
})();

(function clearStorageOnLogin() {
  const logoutReason = pendingLogoutNotice;
  (async () => {
    try {
      if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    } catch (err) {
      log({ loginCacheClearError: err?.message || err });
    }
    try {
      if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
        const dbs = await indexedDB.databases();
        await Promise.all(
          dbs
            .map((db) => db?.name)
            .filter((name) => typeof name === 'string' && name.length)
            .map((name) => new Promise((resolve) => {
              try {
                const req = indexedDB.deleteDatabase(name);
                req.onsuccess = () => resolve();
                req.onblocked = () => resolve();
                req.onerror = () => resolve();
              } catch {
                resolve();
              }
            }))
        );
      }
    } catch (err) {
      log({ loginIndexedDbClearError: err?.message || err });
    }
    try { localStorage.clear?.(); } catch (err) { log({ loginLocalClearError: err?.message || err }); }
    try { sessionStorage.clear?.(); } catch (err) { log({ loginSessionClearError: err?.message || err }); }
    if (logoutReason) {
      try { sessionStorage.setItem('app:lastLogoutReason', logoutReason); } catch { }
    }
  })();
})();

setLogSink((line) => {
  if (out) out.textContent = line;
  if (shouldShowModal(line)) showModalMessage(line);
});

let identiconRenderSeq = 0;
let mosaicTimer = null;
let pendingStartAt = null;
let pendingRenderTimeout = null;

function applyMosaicColors() {
  if (!uidIdenticonEl) return;
  const cells = uidIdenticonEl.querySelectorAll('.mosaic div');
  if (!cells?.length) return;
  cells.forEach((cell) => {
    const color = IDENTICON_PALETTE[Math.floor(Math.random() * IDENTICON_PALETTE.length)];
    cell.style.background = color;
  });
}

function startMosaicColors() {
  stopMosaicColors();
  applyMosaicColors();
  mosaicTimer = setInterval(applyMosaicColors, 320);
}

function stopMosaicColors() {
  if (mosaicTimer) {
    clearInterval(mosaicTimer);
    mosaicTimer = null;
  }
  if (pendingRenderTimeout) {
    clearTimeout(pendingRenderTimeout);
    pendingRenderTimeout = null;
  }
}
let passwordAreaVisible = false;

function setPasswordAreaVisible(visible) {
  passwordAreaVisible = !!visible;
  if (loginShellEl) loginShellEl.classList.toggle('login-verified', passwordAreaVisible);
  if (!passwordAreaVisible) {
    if (pwdEl) pwdEl.value = '';
    if (pwdConfirmEl) pwdConfirmEl.value = '';
  }
}

async function renderIdenticon(uid, { pending = false } = {}) {
  if (!uidIdenticonEl) return;
  if (pending || !uid) {
    pendingStartAt = Date.now();
    uidIdenticonEl.classList.add('pending');
    const blocks = Array.from({ length: 25 }).map((_, i) => `<div style="--i:${i};"></div>`).join('');
    uidIdenticonEl.innerHTML = `<div class="mosaic">${blocks}</div>`;
    startMosaicColors();
    return;
  }
  const elapsed = pendingStartAt ? Date.now() - pendingStartAt : null;
  const minPendingMs = 2500;
  if (elapsed !== null && elapsed < minPendingMs) {
    if (pendingRenderTimeout) {
      clearTimeout(pendingRenderTimeout);
      pendingRenderTimeout = null;
    }
    const remain = minPendingMs - elapsed;
    pendingRenderTimeout = setTimeout(() => renderIdenticon(uid, { pending: false }), remain);
    return;
  }
  pendingStartAt = null;
  stopMosaicColors();
  uidIdenticonEl.classList.remove('pending');
  const seq = ++identiconRenderSeq;
  try {
    const svg = await buildIdenticonSvg(uid);
    if (seq !== identiconRenderSeq) return;
    uidIdenticonEl.innerHTML = svg;
  } catch (err) {
    uidIdenticonEl.classList.add('pending');
    log({ identiconError: String(err?.message || err) });
  }
}

function getContactSecretKeyOptionsForLogin(uidOverride) {
  return {
    accountDigest: getAccountDigest()
  };
}

function readContactSnapshotFrom(storage, keys = []) {
  if (!storage || !keys?.length) return null;
  for (const key of keys) {
    try {
      const value = storage.getItem(key);
      if (value) return { key, value };
    } catch { }
  }
  return null;
}

function purgeLoginStorage() {
  const seedCache = typeof window !== 'undefined' && window.__LOGIN_SEED_LOCALSTORAGE && typeof window.__LOGIN_SEED_LOCALSTORAGE === 'object'
    ? { ...window.__LOGIN_SEED_LOCALSTORAGE }
    : null;
  let seeds = null;
  const keyOptions = getContactSecretKeyOptionsForLogin();
  const storageKeys = Array.from(new Set([
    ...getContactSecretsStorageKeys(keyOptions),
    ...getContactSecretsStorageKeys({})
  ]));
  const latestKeys = Array.from(new Set([
    ...getContactSecretsLatestKeys(keyOptions),
    ...getContactSecretsLatestKeys({})
  ]));
  const legacyStorageKeys = Array.from(new Set([
    ...getLegacyContactSecretsStorageKeys(keyOptions),
    ...getLegacyContactSecretsStorageKeys({})
  ]));
  const legacyLatestKeys = Array.from(new Set([
    ...getLegacyContactSecretsLatestKeys(keyOptions),
    ...getLegacyContactSecretsLatestKeys({})
  ]));
  const legacyMetaKeys = Array.from(new Set([
    ...getLegacyContactSecretsMetaKeys(keyOptions),
    ...getLegacyContactSecretsMetaKeys({})
  ]));
  const legacyChecksumKeys = Array.from(new Set([
    ...getLegacyContactSecretsChecksumKeys(keyOptions),
    ...getLegacyContactSecretsChecksumKeys({})
  ]));
  const candidates = [];
  const addCandidate = (store, keys, source, isLegacy = false) => {
    const record = readContactSnapshotFrom(store, keys);
    if (record?.value) {
      candidates.push({
        value: record.value,
        source: `${source}:${record.key}`,
        isLegacy
      });
    }
  };
  const addSeedCandidate = (cache, keys, source, isLegacy = false) => {
    if (!cache) return;
    for (const key of keys) {
      if (typeof cache[key] === 'string') {
        candidates.push({ value: cache[key], source, isLegacy });
        break;
      }
    }
  };
  try {
    const storage = localStorage;
    addCandidate(storage, storageKeys, 'local', false);
    addCandidate(storage, latestKeys, 'local-latest', false);
    addCandidate(storage, legacyStorageKeys, 'legacy-local', true);
    addCandidate(storage, legacyLatestKeys, 'legacy-local-latest', true);
    addSeedCandidate(seedCache, storageKeys, 'seed-v2', false);
    addSeedCandidate(seedCache, legacyStorageKeys, 'seed-v1', true);
    let handoffChecksum = null;
    if (typeof sessionStorage !== 'undefined') {
      addCandidate(sessionStorage, storageKeys, 'session', false);
      addCandidate(sessionStorage, latestKeys, 'session-latest', false);
      addCandidate(sessionStorage, legacyStorageKeys, 'legacy-session', true);
      addCandidate(sessionStorage, legacyLatestKeys, 'legacy-session-latest', true);
      try {
        const checksumRaw = readContactSnapshotFrom(sessionStorage, legacyChecksumKeys)?.value || null;
        if (checksumRaw) handoffChecksum = JSON.parse(checksumRaw);
      } catch { }
      if (handoffChecksum) {
        log({ contactSecretsHandoffChecksum: handoffChecksum });
      }
      [...legacyMetaKeys, ...legacyChecksumKeys, ...legacyStorageKeys, ...legacyLatestKeys].forEach((key) => {
        try { sessionStorage.removeItem(key); } catch { }
      });
    }
    const best = candidates.reduce((prev, cand) => {
      const len = typeof cand.value === 'string' ? cand.value.length : 0;
      if (!len) return prev;
      if (!prev) return { ...cand, len };
      if (len > prev.len) return { ...cand, len };
      if (len === prev.len && prev.isLegacy && !cand.isLegacy) return { ...cand, len };
      return prev;
    }, null);
    if (best?.value) {
      seeds = {};
      storageKeys.forEach((key) => { seeds[key] = best.value; });
      latestKeys.forEach((key) => { seeds[key] = best.value; });
      seeds.__CONTACT_SECRET_SOURCE = best.source;
      seeds.__CONTACT_SECRET_VERSION = best.isLegacy ? 'migrated-v1' : 'v2';
      const summary = summarizeContactSecretsPayload(best.value);
      log({ contactSecretsSeedPrepared: summary });
      if (isAutomationEnv()) {
        log({ contactSecretsSeedSource: best.source, contactSecretsSeedBytes: best.value.length });
      }
    }
    storage.clear();
    if (seeds) {
      for (const [key, value] of Object.entries(seeds)) {
        if (key.startsWith('__')) continue;
        try { storage.setItem(key, value); } catch (err) { log({ loginStorageSeedWriteError: err?.message || err, key }); }
      }
      const primarySeed = Object.entries(seeds).find(([key]) => !key.startsWith('__'));
      if (primarySeed && typeof primarySeed[1] === 'string') {
        log({ contactSecretsSeedApplied: summarizeContactSecretsPayload(primarySeed[1]) });
      }
    }
  } catch (err) {
    log({ loginStorageClearLocalError: err?.message || err });
  }
  try {
    resetAll();
    clearSecrets();
  } catch (err) {
    log({ loginStoreResetError: err?.message || err });
  }
  try {
    sessionStorage.removeItem('wrapped_dev');
    const keyOptions = getContactSecretKeyOptionsForLogin();
    const keysToRemove = new Set([
      ...getContactSecretsStorageKeys(keyOptions),
      ...getContactSecretsStorageKeys({}),
      ...getContactSecretsLatestKeys(keyOptions),
      ...getContactSecretsLatestKeys({}),
      ...getContactSecretsMetaKeys(keyOptions),
      ...getContactSecretsMetaKeys({}),
      ...getContactSecretsChecksumKeys(keyOptions),
      ...getContactSecretsChecksumKeys({}),
      ...getLegacyContactSecretsStorageKeys(keyOptions),
      ...getLegacyContactSecretsStorageKeys({}),
      ...getLegacyContactSecretsLatestKeys(keyOptions),
      ...getLegacyContactSecretsLatestKeys({}),
      ...getLegacyContactSecretsMetaKeys(keyOptions),
      ...getLegacyContactSecretsMetaKeys({}),
      ...getLegacyContactSecretsChecksumKeys(keyOptions),
      ...getLegacyContactSecretsChecksumKeys({})
    ]);
    keysToRemove.forEach((key) => {
      try { sessionStorage.removeItem(key); } catch { }
    });
  } catch { }
  if (typeof window !== 'undefined' && window.__LOGIN_SEED_LOCALSTORAGE) {
    try { delete window.__LOGIN_SEED_LOCALSTORAGE; } catch { }
  }
  if (typeof window !== 'undefined' && window.caches?.keys) {
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .catch((err) => log({ loginCacheClearError: err?.message || err }));
  }
  if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
    indexedDB.databases()
      .then((dbs) => Promise.all(
        dbs
          .map((db) => db?.name)
          .filter((name) => typeof name === 'string' && name.length)
          .map((name) => new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onblocked = () => resolve();
            req.onerror = () => {
              log({ loginIndexedDbDeleteError: req.error?.message || req.error || name, name });
              resolve();
            };
          }))
      ))
      .catch((err) => log({ loginIndexedDbClearError: err?.message || err }));
  }
}

purgeLoginStorage();
if (pendingLogoutNotice) {
  log(pendingLogoutNotice);
  try { sessionStorage.removeItem('app:lastLogoutReason'); } catch { }
  pendingLogoutNotice = null;
}

const uidEl = $('#uidHex');
const macEl = $('#sdmMac');
const ctrEl = $('#sdmCtr');
const nonceEl = $('#nonce');
const btnSdmExchangeEl = document.getElementById('btnSdmExchange');
const sessionView = $('#sessionView');
const pwdEl = $('#pwd');
const unlockBtn = $('#btnUnlock');
const passwordWrapper = document.getElementById('passwordWrapper');
const confirmWrapper = document.getElementById('confirmWrapper');
const pwdConfirmEl = document.getElementById('pwdConfirm');
const passwordToggles = document.querySelectorAll('.password-toggle');
export const AUDIO_PERMISSION_KEY = 'audio-permission';

let loginInProgress = false;
let newAccount = false;
let welcomeAcknowledged = false;

setPasswordAreaVisible(false);

if (pwdEl) {
  try {
    const rand = Math.random().toString(36).slice(2);
    pwdEl.name = `pw_${Date.now()}_${rand}`;
    pwdEl.setAttribute('autocomplete', 'off');
    pwdEl.setAttribute('data-keep-autocomplete-off', 'true');
  } catch { }
}
if (pwdConfirmEl) {
  try {
    const rand = Math.random().toString(36).slice(2);
    pwdConfirmEl.name = `pw_c_${Date.now()}_${rand}`;
    pwdConfirmEl.setAttribute('autocomplete', 'off');
  } catch { }
}
applyAccountMode();
if (getSession() || getHasMK() || getWrappedMK()) {
  markVerifiedUI();
}
const loadingBackdrop = document.getElementById('loginLoading'); const loadingTextEl = document.getElementById('loginLoadingText');
const bootstrapProgressEl = document.getElementById('loginBootstrapProgress');
const bootstrapStepsListEl = document.getElementById('loginBootstrapSteps');
const bootstrapStepDefs = [
  { key: 'opaque', label: '驗證帳戶（OPAQUE）' },
  { key: 'wrap-mk', label: '保護主金鑰' },
  { key: 'mk-store', label: '儲存主金鑰' },
  { key: 'devkeys-fetch', label: '讀取裝置備份' },
  { key: 'prekeys-sync', label: '同步預共享金鑰' },
  { key: 'generate-bundle', label: '產生預共享金鑰' },
  { key: 'prekeys-publish', label: '上傳預共享金鑰' },
  { key: 'wrap-device', label: '備份裝置金鑰' },
  { key: 'devkeys-store', label: '儲存裝置備份' },
  { key: 'nickname-init', label: '設定初始暱稱中' },
  { key: 'avatar-init', label: '設定初始頭像中' },
  { key: 'contact-restore', label: '還原聯絡人及金鑰' }
];
const bootstrapStepMap = new Map();
let bootstrapInitialized = false;


function resetBootstrapProgress() {
  bootstrapInitialized = false;
  bootstrapStepMap.clear();
  if (bootstrapStepsListEl) bootstrapStepsListEl.innerHTML = '';
  if (bootstrapProgressEl) bootstrapProgressEl.classList.add('hidden');
}

function formatBootstrapDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'number') return String(detail);
  if (typeof detail === 'object') {
    if (detail.opkCount !== undefined && detail.opkCount !== null) {
      return `OPK 數量：${detail.opkCount}`;
    }
    if (detail.message) return String(detail.message);
    if (detail.note) return String(detail.note);
    if (detail.error) return String(detail.error);
  }
  return '';
}

function initBootstrapProgress() {
  if (!bootstrapProgressEl || !bootstrapStepsListEl) return;
  bootstrapProgressEl.classList.remove('hidden');
  bootstrapStepsListEl.innerHTML = '';
  bootstrapStepMap.clear();
  for (const def of bootstrapStepDefs) {
    if (newAccount && def.key === 'prekeys-sync') continue;
    if (newAccount && def.key === 'contact-restore') continue;
    if (!newAccount && (def.key === 'nickname-init' || def.key === 'avatar-init')) continue;
    if (!newAccount && (def.key === 'devkeys-fetch' || def.key === 'devkeys-store')) continue; // Login flow uses contact-restore instead of devkeys raw fetch
    const li = document.createElement('li');
    li.dataset.step = def.key;
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.className = 'label-text';
    label.textContent = def.label;
    const status = document.createElement('span');
    status.className = 'status-text';
    status.textContent = '等待';
    row.append(label, status);
    const detail = document.createElement('span');
    detail.className = 'detail-text';
    detail.textContent = '';
    detail.style.display = 'none';
    li.append(row, detail);
    bootstrapStepsListEl.append(li);
    bootstrapStepMap.set(def.key, { el: li, statusText: status, detailText: detail, status: 'pending' });
  }
  bootstrapInitialized = true;
}

const BOOTSTRAP_STATE_CLASS = {
  start: 'in-progress',
  success: 'success',
  error: 'error',
  skip: 'skip',
  info: 'info'
};

const BOOTSTRAP_STATUS_TEXT = {
  pending: '等待',
  start: '處理中…',
  success: '完成',
  error: '失敗',
  skip: '略過',
  info: '完成'
};

function fadeOutBootstrapEntry(step, entry) {
  if (!entry?.el || entry.el.dataset.fading === '1') return;
  const el = entry.el;
  el.dataset.fading = '1';
  const triggerFade = () => el.classList.add('fading-out');
  requestAnimationFrame(() => requestAnimationFrame(triggerFade));
  const remove = () => {
    if (el?.parentElement) {
      el.parentElement.removeChild(el);
    }
    bootstrapStepMap.delete(step);
  };
  el.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 650);
}

function updateBootstrapStep(step, status, detail) {
  const entry = bootstrapStepMap.get(step);
  if (!entry) return;
  entry.status = status;
  const classNames = ['in-progress', 'success', 'error', 'skip', 'info'];
  entry.el.classList.remove(...classNames);
  const cls = BOOTSTRAP_STATE_CLASS[status];
  if (cls) entry.el.classList.add(cls);
  if (status === 'start' && !cls) entry.el.classList.add('in-progress');
  entry.statusText.textContent = BOOTSTRAP_STATUS_TEXT[status] || BOOTSTRAP_STATUS_TEXT.pending;
  const detailText = formatBootstrapDetail(detail);
  if (detailText) {
    entry.detailText.textContent = detailText;
    entry.detailText.style.display = '';
  } else {
    entry.detailText.textContent = '';
    entry.detailText.style.display = 'none';
  }
  if (status === 'success' || status === 'skip' || status === 'info') {
    fadeOutBootstrapEntry(step, entry);
  }
}

function showLoading(message) {
  if (loadingBackdrop) loadingBackdrop.classList.remove('hidden');
  if (loadingTextEl) loadingTextEl.textContent = message || '登入中，請稍候…';
  if (unlockBtn) unlockBtn.disabled = true;
}

function updateLoading(message) {
  if (loadingTextEl && message) loadingTextEl.textContent = message;
}

function hideLoading() {
  if (loadingBackdrop) loadingBackdrop.classList.add('hidden');
  if (unlockBtn) unlockBtn.disabled = false;
}

function showWelcomeModal() {
  if (!welcomeModal) return;
  welcomeModal.classList.remove('hidden');
  welcomeModal.setAttribute('aria-hidden', 'false');
  const focusTarget = welcomeNextBtn || welcomeCloseBtn;
  if (focusTarget && typeof focusTarget.focus === 'function') {
    try {
      focusTarget.focus({ preventScroll: true });
    } catch {
      focusTarget.focus();
    }
  }
}

function hideWelcomeModal() {
  if (!welcomeModal) return;
  welcomeModal.classList.add('hidden');
  welcomeModal.setAttribute('aria-hidden', 'true');
  if (newAccount) {
    welcomeAcknowledged = true;
    if (confirmWrapper) confirmWrapper.classList.remove('hidden');
    if (unlockBtn) unlockBtn.disabled = false;
  }
}

function applyAccountMode() {
  if (newAccount) {
    if (passwordWrapper) {
      const label = passwordWrapper.querySelector('label');
      if (label) label.textContent = '設定登入密碼';
    }
    if (confirmWrapper) {
      if (welcomeAcknowledged) confirmWrapper.classList.remove('hidden');
      else confirmWrapper.classList.add('hidden');
    }
    if (unlockBtn) {
      unlockBtn.textContent = '登入';
      unlockBtn.disabled = !welcomeAcknowledged;
    }
    if (!welcomeAcknowledged) showWelcomeModal();
  } else {
    if (passwordWrapper) {
      const label = passwordWrapper.querySelector('label');
      if (label) label.textContent = '登入密碼';
    }
    if (confirmWrapper) {
      confirmWrapper.classList.add('hidden');
      if (pwdConfirmEl) pwdConfirmEl.value = '';
    }
    if (pwdEl) pwdEl.value = '';
    hideWelcomeModal();
    welcomeAcknowledged = false;
    if (unlockBtn) {
      unlockBtn.textContent = '登入';
      unlockBtn.disabled = false;
    }
  }
}

let uidVerifying = false;

const updateUidDisplay = () => {
  if (uidVerifying) return;
  const uid = getAccountDigest() || '';
  if (uidEl) uidEl.value = uid;
  renderIdenticon(uid, { pending: !uid });
};
updateUidDisplay();

function markVerifiedUI() {
  setPasswordAreaVisible(true);
  if (pwdEl) {
    requestAnimationFrame(() => {
      try {
        pwdEl.focus({ preventScroll: true });
      } catch { }
    });
  }
}

function setUidVerifyingState(active) {
  if (active) {
    if (uidVerifying) return;
    uidVerifying = true;
    renderIdenticon(null, { pending: true });
    return;
  }
  if (!uidVerifying) return;
  uidVerifying = false;
  updateUidDisplay();
}


// ---- Health & Clear ----
const btnHealth = document.getElementById('btnHealth');
if (btnHealth) {
  btnHealth.onclick = async () => {
    const r = await fetch('/api/health'); const text = await r.text();
    log({ status: r.status, data: safeJSON(text) });
  };
}
const btnClear = document.getElementById('btnClear');
if (btnClear) btnClear.onclick = () => { if (out) out.textContent = ''; closeModalMessage(); };
if (modalClose) modalClose.addEventListener('click', closeModalMessage);
if (modalBackdrop) modalBackdrop.addEventListener('click', closeModalMessage);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (welcomeModal && !welcomeModal.classList.contains('hidden')) {
    hideWelcomeModal();
    return;
  }
  if (modalEl && !modalEl.classList.contains('hidden')) closeModalMessage();
});
passwordToggles.forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    if (!id) return;
    const input = document.getElementById(id);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    const icon = btn.querySelector('i');
    if (icon) {
      if (isPassword) {
        icon.classList.remove('bx-show');
        icon.classList.add('bx-hide');
      } else {
        icon.classList.remove('bx-hide');
        icon.classList.add('bx-show');
      }
    }
    btn.setAttribute('aria-label', isPassword ? '隱藏密碼' : '顯示密碼');
  });
});
if (welcomeNextBtn) {
  welcomeNextBtn.addEventListener('click', () => {
    hideWelcomeModal();
    if (pwdEl) pwdEl.focus({ preventScroll: true });
  });
}
if (welcomeCloseBtn) {
  welcomeCloseBtn.addEventListener('click', () => {
    hideWelcomeModal();
  });
}

// ---- SDM Exchange ----
if (btnSdmExchangeEl) btnSdmExchangeEl.onclick = onSdmExchange;
async function onSdmExchange() {
  if (!uidEl || !macEl || !ctrEl) {
    log({ debugSimError: 'exchange form missing required fields' });
    throw new Error('exchange form missing required fields');
  }
  const uidHex = (uidEl.value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  const macHex = (macEl.value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  const ctrRaw = (ctrEl.value || '').trim();
  const nonce = (nonceEl?.value || '').trim() || 'n/a';
  if (!uidHex || uidHex.length < 14) return log('UID hex required (14 hex)');
  if (!macHex || macHex.length < 16) return log('SDM MAC (16 hex) required');
  try {
    await exchangeWithParams({ uidHex, sdmmac: macHex, sdmcounter: ctrRaw, nonce });
    if (sessionView) sessionView.value = getSession() || '';
    updateUidDisplay();
    log({ exchange: { hasMK: getHasMK(), session: !!getSession(), wrapped: !!getWrappedMK() } });
    newAccount = !getHasMK();
    if (newAccount) welcomeAcknowledged = false;
    applyAccountMode();
    markVerifiedUI();
  } catch (e) {
    log({ exchangeError: String(e?.message || e) });
  }
}


// auto-exchange from URL if params present (via features/sdm)
(async function autoExchangeFromURL() {
  try {
    const hasParams = !!parseSdmParams();
    if (hasParams) setUidVerifyingState(true);
    const res = await exchangeFromURLIfPresent();
    if (res && res.performed) {
      // prefill inputs for visibility
      updateUidDisplay();
      sessionView.value = getSession() || '';
      log({ exchange: { hasMK: getHasMK(), session: !!getSession(), wrapped: !!getWrappedMK() } });
      newAccount = !getHasMK();
      if (newAccount) welcomeAcknowledged = false;
      applyAccountMode();
      markVerifiedUI();
    }
  } catch (e) {
    log({ exchangeError: String(e?.message || e) });
  } finally {
    setUidVerifyingState(false);
  }
})();


// ---- Unlock / Reset ----
if (unlockBtn) unlockBtn.onclick = onUnlock;
if (pwdEl) {
  pwdEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onUnlock();
    }
  });
}
if (pwdConfirmEl) {
  pwdConfirmEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onUnlock();
    }
  });
}
const btnResetMK = document.getElementById('btnResetMK');
if (btnResetMK) btnResetMK.onclick = () => {
  try {
    setMkRaw(null);
    emitMkSetTrace('login-ui:debug-reset', null);
    log('Local MK cleared.');
  } catch { }
};

async function onUnlock() {
  if (loginInProgress) return;
  const pwd = pwdEl.value || '';
  if (!getSession()) { log('Run SDM Exchange first.'); return; }
  if (!pwd) { log('請輸入密碼。'); return; }
  if (newAccount) {
    if ((pwd || '').length < 6) {
      log('密碼至少需 6 個字元。');
      return;
    }
    const confirmPwd = pwdConfirmEl?.value || '';
    if (confirmPwd !== pwd) {
      log('兩次輸入的密碼不一致。');
      return;
    }
  }
  try {
    await ensureAudioPermissionForLogin();
    if (newAccount) {
      resetBootstrapProgress();
      initBootstrapProgress();
    } else {
      resetBootstrapProgress();
      initBootstrapProgress(); // Enable UI for re-login flow (contact-restore)
    }
    loginInProgress = true;
    showLoading(newAccount ? '正在建立安全環境…' : '登入中，請稍候…');
    const r = await unlockAndInit({
      password: pwd,
      onProgress: (step, status, detail) => {
        updateBootstrapStep(step, status, detail);
      }
    });
    log({ unlocked: r.unlocked, initialized: r.initialized, replenished: r.replenished, next_opk_id: r.next_opk_id });
    const devicePriv = getDevicePriv();
    const hasPrekeys = !!(devicePriv &&
      typeof devicePriv.ik_priv_b64 === 'string' && devicePriv.ik_priv_b64 &&
      typeof devicePriv.spk_priv_b64 === 'string' && devicePriv.spk_priv_b64 &&
      typeof devicePriv.spk_pub_b64 === 'string' && devicePriv.spk_pub_b64);
    if (!hasPrekeys) {
      hideLoading();
      loginInProgress = false;
      log('預共享金鑰尚未就緒，請稍後再試。');
      return;
    }
    let deviceIdAfterUnlock = null;
    try {
      deviceIdAfterUnlock = ensureDeviceId();
      console.log('[login-ui] deviceId:ensure:post-unlock', deviceIdAfterUnlock);
    } catch (err) {
      log({ deviceIdError: err?.message || err });
      throw err;
    }
    try {
      const stored = sessionStorage?.getItem('device_id');
      console.log('[login-ui] deviceId:sessionStorage', stored || null);
    } catch (err) {
      log({ deviceIdStorageError: err?.message || err });
    }
    if (newAccount) {
      updateBootstrapStep('nickname-init', 'start');
      updateBootstrapStep('avatar-init', 'start');
      try {
        const result = await initProfileDefaultsOnce({ uidHex: getAccountDigest(), evidence: r?.evidence || null });
        if (result?.skipped) {
          const reason = result.reason || '已存在暱稱/頭像';
          updateBootstrapStep('nickname-init', 'skip', reason);
          updateBootstrapStep('avatar-init', 'skip', reason);
        } else {
          updateBootstrapStep('nickname-init', 'success');
          if (result?.avatarWritten) {
            updateBootstrapStep('avatar-init', 'success');
          } else {
            updateBootstrapStep('avatar-init', 'skip', result?.avatarReason || '已存在頭像');
          }
        }
      } catch (err) {
        const msg = err?.message || err;
        updateBootstrapStep('nickname-init', 'error', msg);
        updateBootstrapStep('avatar-init', 'error', msg);
        throw err;
      }
    }
    await emitIdentityTrace('login-ui:post-unlock');
    try {
      const deviceIdBeforeRedirect = ensureDeviceId();
      console.log('[login-ui] deviceId:ensure:before-redirect', deviceIdBeforeRedirect);
    } catch (err) {
      log({ deviceIdBeforeRedirectError: err?.message || err });
      throw err;
    }
    if (!newAccount) {
      updateBootstrapStep('contact-restore', 'start');
      try {
        const restoreRes = await hydrateContactSecretsFromBackup({ reason: 'login-bootstrap' });
        if (restoreRes.ok) {
          updateBootstrapStep('contact-restore', 'success', `還原 ${restoreRes.entries} 筆資料`);
        } else if (restoreRes.status === 404) {
          updateBootstrapStep('contact-restore', 'info', '無備份資料');
        } else {
          updateBootstrapStep('contact-restore', 'skip', '還原略過或失敗');
        }
      } catch (err) {
        log({ contactRestoreError: err?.message || err });
        updateBootstrapStep('contact-restore', 'error', '還原失敗');
        // Non-critical, continue
      }
    }
    updateUidDisplay();
    updateLoading('登入成功，正在導向…');
    // handoff MK/UID to next page (sessionStorage, same-tab only)
    try {
      const mk = getMkRaw();
      const accountToken = getAccountToken();
      const accountDigest = getAccountDigest();
      const wrappedMk = getWrappedMK();
      const identityForHandoff = accountDigest || null;
      log({
        loginHandoff: {
          mk: !!mk,
          uid: !!identityForHandoff,
          accountToken: !!accountToken,
          accountDigest: !!accountDigest,
          wrappedMk: !!wrappedMk,
          wrappedDev: !!r?.wrapped_dev
        }
      });
      if (mk && mk.length) sessionStorage.setItem('mk_b64', b64(mk));
      // handoff 以 accountDigest 為主（不再使用 uid_hex）
      if (accountToken) sessionStorage.setItem('account_token', accountToken);
      if (accountDigest) sessionStorage.setItem('account_digest', accountDigest);
      if (wrappedMk) {
        try {
          sessionStorage.setItem('wrapped_mk', JSON.stringify(wrappedMk));
        } catch (err) {
          log({ wrappedMkSerializeError: err?.message || err });
        }
      } else {
        sessionStorage.removeItem('wrapped_mk');
      }
      const isAutomationEnv = (() => {
        try { return typeof navigator !== 'undefined' && !!navigator.webdriver; } catch { return false; }
      })();
      if (r?.wrapped_dev) {
        const serializedWrapped = JSON.stringify(r.wrapped_dev);
        sessionStorage.setItem('wrapped_dev', serializedWrapped);
        try { localStorage.setItem('wrapped_dev_handoff', serializedWrapped); } catch { }
        try { window.name = JSON.stringify({ wrapped_dev: r.wrapped_dev }); } catch { }
        if (isAutomationEnv) {
          try {
            console.log('[login-handoff] wrapped_dev stored', serializedWrapped.length);
          } catch { }
        }
      } else {
        sessionStorage.removeItem('wrapped_dev');
        try { localStorage.removeItem('wrapped_dev_handoff'); } catch { }
        try { window.name = ''; } catch { }
        if (isAutomationEnv) {
          try { console.warn('[login-handoff] wrapped_dev missing'); } catch { }
        }
      }
      try {
        const keyOptions = getContactSecretKeyOptionsForLogin();
        const storageKeys = getContactSecretsStorageKeys(keyOptions);
        const snapshotRecord = readContactSnapshotFrom(localStorage, storageKeys);
        if (snapshotRecord?.value) {
          for (const key of storageKeys) {
            sessionStorage.setItem(key, snapshotRecord.value);
          }
        } else {
          for (const key of storageKeys) {
            sessionStorage.removeItem(key);
          }
        }
        if (!newAccount) {
          sessionStorage.setItem('contact_restore_performed', '1');
        }
      } catch (err) {
        log({ contactSecretHandoffError: err?.message || err });
      }
    } catch { }
    setTimeout(() => location.replace(window.location.origin + '/pages/app.html'), 300);
  } catch (e) {
    hideLoading();
    loginInProgress = false;
    log({ unlockError: String(e?.message || e) });
  }
}

function invalidateExchange() {
  setSession(null);
  setHasMK(false);
  setWrappedMK(null);
  setUidHex(null);
  setAccountToken(null);
  setAccountDigest(null);
  setOpaqueServerId(null);
  try {
    sessionStorage.removeItem('account_token');
    sessionStorage.removeItem('account_digest');
  } catch { }
  newAccount = false;
  welcomeAcknowledged = false;
  applyAccountMode();
}


const FALLBACK_ERROR_MESSAGE = '發生未知錯誤，請稍後再試。';
const PASSWORD_ERROR_MESSAGE = '密碼不正確，請重新輸入。';

const ERROR_CODE_MESSAGES = {
  ConfigError: '伺服器設定異常，請通知客服。',
  Unauthorized: '晶片驗證失敗，請重新感應卡片。',
  ExchangeFailed: '伺服器驗證失敗，請稍後再試。',
  Replay: '偵測到晶片計數器重複，請關閉頁面後重新感應。',
  SessionExpired: '驗證已逾時，請重新感應卡片。',
  SessionMismatch: '驗證資料不一致，請重新感應卡片。',
  StoreFailed: '伺服器儲存資料失敗，請稍後再試。',
  BadRequest: '送出的資訊格式不正確，請確認後重試。',
  OpaqueLoginFinishFailed: PASSWORD_ERROR_MESSAGE,
  OpaqueSessionExpired: '驗證已逾時，請重新感應卡片。',
  OpaqueSessionNotFound: '驗證資訊不存在，請重新感應卡片。'
};

const ERROR_PATTERNS = [
  { pattern: /uid hex \(14\) required/i, message: '尚未偵測到晶片 UID，請重新感應。' },
  { pattern: /sdm mac \(16\) required/i, message: 'MAC 資料缺失，請重新感應晶片。' },
  { pattern: /password required/i, message: '請輸入解鎖密碼。' },
  { pattern: /請輸入密碼。?/i, message: '請輸入密碼。' },
  { pattern: /密碼至少需 6 個字元/i, message: '密碼至少需 6 個字元。' },
  { pattern: /兩次輸入的密碼不一致/i, message: '兩次輸入的密碼不一致。' },
  { pattern: /sdm exchange required/i, message: '請先完成晶片驗證。' },
  { pattern: /uid not set/i, message: '尚未偵測到晶片 UID，請重新感應。' },
  { pattern: /wrong password or envelope mismatch/i, message: '密碼不正確，請重新輸入。' },
  { pattern: /unlock failed/i, message: PASSWORD_ERROR_MESSAGE },
  { pattern: /enter a password first/i, message: '請輸入解鎖密碼。' },
  { pattern: /run sdm exchange first/i, message: '請先感應晶片並完成驗證。' },
  { pattern: /mk\.store failed/i, message: '儲存主金鑰失敗，請稍後再試。' },
  { pattern: /initialize mk failed/i, message: '初始化主金鑰失敗，請稍後再試。' },
  { pattern: /devkeys\.fetch failed/i, message: '讀取裝置備份失敗，請稍後再試。' },
  { pattern: /keys\.publish.*failed/i, message: '同步裝置金鑰失敗，請稍後再試。' },
  { pattern: /devkeys\.store.*failed/i, message: '儲存裝置備份失敗，請稍後再試。' },
  { pattern: /prekeys initialization failed/i, message: '初始化預共享金鑰失敗，請稍後再試。' },
  { pattern: /prekeys re-initialization failed/i, message: '重新建置預共享金鑰失敗，請稍後再試。' },
  { pattern: /prekeys replenish failed/i, message: '補貨預共享金鑰失敗，請稍後再試。' },
  { pattern: /please re-tap the tag/i, message: '驗證已逾時，請重新感應卡片。' },
  { pattern: /counter must be strictly increasing/i, message: '偵測到晶片計數器重複，請關閉頁面後重新感應。' },
  { pattern: /uid mismatch/i, message: '驗證資料不一致，請重新感應卡片。' },
  { pattern: /sdm verify failed/i, message: '晶片驗證失敗，請重新感應卡片。' },
  { pattern: /opaque login.*failed/i, message: PASSWORD_ERROR_MESSAGE },
  { pattern: /opaque.*password/i, message: PASSWORD_ERROR_MESSAGE },
  { pattern: /OpaqueLoginFinishFailed/i, message: PASSWORD_ERROR_MESSAGE },
  { pattern: /EnvelopeRecoveryError/i, message: PASSWORD_ERROR_MESSAGE }
];

function parseLinePayload(line) {
  if (line === null || line === undefined) return '';
  if (typeof line === 'string') {
    const trimmed = line.trim();
    if (!trimmed) return '';
    try { return JSON.parse(trimmed); } catch { return trimmed; }
  }
  return line;
}

function translateError(line) {
  const payload = parseLinePayload(line);
  let msg = null;
  if (typeof payload === 'string') {
    msg = translateString(payload);
  } else {
    msg = translateFromObj(payload);
  }
  return msg || FALLBACK_ERROR_MESSAGE;
}

function translateFromObj(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const msg = translateFromObj(item);
      if (msg) return msg;
    }
    return null;
  }
  if (obj.exchangeError) return translateString(obj.exchangeError);
  if (obj.unlockError) return translateString(obj.unlockError);
  if (obj.error) {
    const codeMsg = translateErrorCode(obj.error, obj);
    if (codeMsg) return codeMsg;
  }
  if (obj.details) {
    const detailMsg = translateDetail(obj.details);
    if (detailMsg) return detailMsg;
  }
  if (obj.message && typeof obj.message === 'string') {
    const message = translateString(obj.message);
    if (message) return message;
  }
  if (obj.detail && typeof obj.detail === 'string') {
    const message = translateString(obj.detail);
    if (message) return message;
  }
  if (typeof obj.status === 'number' && obj.status >= 400 && obj.statusText) {
    const message = translateString(String(obj.statusText));
    if (message) return message;
  }
  return null;
}

function translateDetail(detail) {
  if (!detail) return null;
  if (typeof detail === 'string') return translateString(detail);
  return translateFromObj(detail);
}

function translateString(str) {
  if (!str) return null;
  const trimmed = str.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    const fromObj = translateFromObj(obj);
    if (fromObj) return fromObj;
  } catch {
    // not JSON
  }
  if (trimmed.includes('sdm.exchange failed')) {
    const idx = trimmed.indexOf('sdm.exchange failed:');
    if (idx >= 0) {
      const payload = trimmed.slice(idx + 21).trim();
      const translated = translateString(payload);
      if (translated) return translated;
      return ERROR_CODE_MESSAGES.ExchangeFailed;
    }
  }
  if (trimmed.includes('please re-tap the tag')) return ERROR_CODE_MESSAGES.SessionExpired;
  if (trimmed.includes('counter must be strictly increasing')) return '偵測到晶片計數器重複，請關閉頁面後重新感應。';

  const patternMsg = findPatternMessage(trimmed);
  if (patternMsg) return patternMsg;
  return null;
}

function translateErrorCode(code, source) {
  if (!code) return null;
  if (code === 'ExchangeFailed' && source && source.details) {
    const detailMsg = translateDetail(source.details);
    if (detailMsg) return detailMsg;
  }
  if (source && source.details) {
    const detailMsg = translateDetail(source.details);
    if (detailMsg) return detailMsg;
  }
  if (ERROR_CODE_MESSAGES[code]) return ERROR_CODE_MESSAGES[code];
  return null;
}

function findPatternMessage(str) {
  for (const item of ERROR_PATTERNS) {
    if (item.pattern.test(str)) return item.message;
  }
  return null;
}

function shouldShowModal(line) {
  const translated = translateError(line);
  if (translated && translated !== FALLBACK_ERROR_MESSAGE) return true;
  try {
    if (typeof line === 'string') {
      const lower = line.toLowerCase();
      if (lower.includes('error') || lower.includes('fail') || lower.includes('失敗')) return true;
      const obj = JSON.parse(line);
      if (obj && (obj.error || obj.errors || obj.status >= 400)) return true;
      return false;
    }
    if (line && typeof line === 'object') {
      if (typeof line.status === 'number' && line.status >= 400) return true;
      if ('error' in line || 'errors' in line) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function showModalMessage(line) {
  if (!modalEl || !modalBody) return;
  modalBody.textContent = translateError(line);
  modalEl.classList.remove('hidden');
  modalEl.setAttribute('aria-hidden', 'false');
}

function closeModalMessage() {
  if (!modalEl || !modalBody) return;
  modalBody.textContent = '';
  modalEl.classList.add('hidden');
  modalEl.setAttribute('aria-hidden', 'true');
}

// ---- small utils ----
function safeJSON(text) { try { return JSON.parse(text); } catch { return text; } }
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
function b64u8(b64s) { const bin = atob(b64s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }

// Harden: disable password storing/autofill on all inputs
(function hardenInputs() {
  try {
    const els = document.querySelectorAll('input, textarea');
    els.forEach(el => {
      el.setAttribute('autocomplete', 'off');
      el.setAttribute('autocapitalize', 'off');
      el.setAttribute('autocorrect', 'off');
      el.setAttribute('spellcheck', 'false');
      // for password fields specifically
      if (el.type === 'password') {
        el.setAttribute('autocomplete', 'new-password');
        el.setAttribute('data-1p-ignore', 'true');
        el.setAttribute('data-lpignore', 'true');
        if (!el.getAttribute('name')) el.setAttribute('name', '__no_store_pwd__');
      }
    });
  } catch { }
})();
async function ensureAudioPermissionForLogin() {
  if (typeof window === 'undefined') return;
  if (sessionStorage.getItem(AUDIO_PERMISSION_KEY) === 'granted') return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    sessionStorage.setItem(AUDIO_PERMISSION_KEY, 'unsupported');
    return;
  }
  try {
    const ctx = new AudioCtx();
    await ctx.resume().catch(() => { });
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    try { source.start(0); } catch { }
    sessionStorage.setItem(AUDIO_PERMISSION_KEY, 'granted');
    try { await ctx.close(); } catch { }
    log({ audioPermission: 'granted' });
  } catch (err) {
    log({ audioPermissionError: err?.message || err });
  }
}
