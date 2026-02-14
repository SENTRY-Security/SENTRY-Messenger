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
import { loadArgon2 } from '../crypto/kdf.js';
import { generateInitialBundle } from '../crypto/prekeys.js';
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
    uidIdenticonEl.classList.add('pending');
    const blocks = Array.from({ length: 25 }).map((_, i) => `<div style="--i:${i};"></div>`).join('');
    uidIdenticonEl.innerHTML = `<div class="mosaic">${blocks}</div>`;
    return;
  }
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
const transitionModal = document.getElementById('loginTransitionModal');
const transitionBar = document.getElementById('loginTransitionBar');
const transitionLabel = document.getElementById('loginTransitionLabel');

// --- Unified white loading modal (progress bar + label) ---
// Login phase covers 0%→70%, app.html continues from 70%→100%.
// New-account path: opaque → wrap-mk → mk-store → generate-bundle → prekeys-publish
//   → wrap-device → devkeys-store → nickname-init → avatar-init
// Existing-account path: opaque → wrap-mk → mk-store → devkeys-fetch → prekeys-sync
//   → contact-restore
// Both paths span 0%→70% since flow-specific steps occupy non-overlapping ranges.
const STEP_PROGRESS = {
  // Shared steps (0% → 20%)
  'opaque':          { start: 2,  done: 10, label: '驗證帳戶中…' },
  'wrap-mk':         { start: 10, done: 16, label: '保護主金鑰…' },
  'mk-store':        { start: 16, done: 20, label: '儲存主金鑰…' },
  // New-account only (20% → 70%)
  'generate-bundle': { start: 20, done: 30, label: '產生加密金鑰…' },
  'prekeys-publish': { start: 30, done: 40, label: '上傳加密金鑰…' },
  'wrap-device':     { start: 40, done: 48, label: '備份裝置金鑰…' },
  'devkeys-store':   { start: 48, done: 54, label: '儲存裝置備份…' },
  'nickname-init':   { start: 54, done: 62, label: '設定暱稱…' },
  'avatar-init':     { start: 62, done: 70, label: '設定頭像…' },
  // Existing-account only (20% → 70%)
  'devkeys-fetch':   { start: 20, done: 32, label: '讀取裝置備份…' },
  'prekeys-sync':    { start: 32, done: 50, label: '同步加密金鑰…' },
  'contact-restore': { start: 50, done: 70, label: '還原聯絡人…' },
};
let currentProgress = 0;
let fillRAF = null;
let fillTarget = 0;
let fillLast = 0;
const FILL_SPEED = 10; // % per second — smooth continuous fill

function setBarWidth(pct) {
  if (transitionBar) transitionBar.style.width = pct + '%';
}

function startSlowFill(target) {
  fillTarget = target;
  if (fillRAF) return;               // already animating
  fillLast = performance.now();
  function tick(now) {
    const dt = (now - fillLast) / 1000;
    fillLast = now;
    if (currentProgress < fillTarget - 0.3) {
      currentProgress = Math.min(currentProgress + FILL_SPEED * dt, fillTarget - 0.3);
      setBarWidth(currentProgress);
      fillRAF = requestAnimationFrame(tick);
    } else {
      fillRAF = null;
    }
  }
  fillRAF = requestAnimationFrame(tick);
}

function stopSlowFill() {
  if (fillRAF) { cancelAnimationFrame(fillRAF); fillRAF = null; }
}

function setTransitionProgress(pct, label) {
  stopSlowFill();
  if (pct > currentProgress) currentProgress = pct;
  setBarWidth(currentProgress);
  if (transitionLabel && label) transitionLabel.textContent = label;
}

function updateBootstrapStep(step, status) {
  const def = STEP_PROGRESS[step];
  if (!def) return;
  if (status === 'start') {
    // Snap to start value, update label, then slowly fill toward done
    if (def.start > currentProgress) currentProgress = def.start;
    setBarWidth(currentProgress);
    if (transitionLabel) transitionLabel.textContent = def.label;
    startSlowFill(def.done);
  } else if (status === 'success' || status === 'skip' || status === 'info') {
    // Snap to done value immediately
    setTransitionProgress(def.done, null);
  }
  // error status: keep current progress/label — hideLoading will dismiss modal
}

function resetBootstrapProgress() { currentProgress = 0; }
function initBootstrapProgress() { /* no-op: progress bar driven by updateBootstrapStep */ }

function showLoading(message) {
  stopSlowFill();
  if (transitionModal) transitionModal.classList.remove('hidden');
  currentProgress = 0;
  setBarWidth(0);
  if (transitionLabel) transitionLabel.textContent = message || '登入中…';
  if (unlockBtn) unlockBtn.disabled = true;
}

function updateLoading(message) {
  if (transitionLabel && message) transitionLabel.textContent = message;
}

function hideLoading() {
  stopSlowFill();
  if (transitionModal) transitionModal.classList.add('hidden');
  currentProgress = 0;
  setBarWidth(0);
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
if (typeof window.__hideLoginSplash === 'function') window.__hideLoginSplash();

let appPrefetched = false;
function prefetchAppResources() {
  if (appPrefetched) return;
  appPrefetched = true;
  // Prefetch app-mobile.js and bundled CSS for faster post-login page load
  const urls = [
    '/app/ui/app-mobile.js',
    '/assets/app-bundle.css',
  ];
  for (const url of urls) {
    try {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = url;
      document.head.appendChild(link);
    } catch { }
  }
}

let preBundlePromise = null;

function markVerifiedUI() {
  setPasswordAreaVisible(true);
  if (pwdEl) {
    requestAnimationFrame(() => {
      try {
        pwdEl.focus({ preventScroll: true });
      } catch { }
    });
  }
  // Preload Argon2 WASM while user types password (eliminates CDN fetch during MK unwrap)
  loadArgon2().catch(() => {});
  // Prefetch app.html resources during password-typing idle time
  prefetchAppResources();
  // Pre-generate keypair bundle for new accounts during idle time
  if (!getHasMK() && !preBundlePromise) {
    preBundlePromise = generateInitialBundle(1, 50).catch(() => null);
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
const PW_ICON_SHOW = '<path d="M12 9a3.02 3.02 0 0 0-3 3c0 1.642 1.358 3 3 3 1.641 0 3-1.358 3-3 0-1.641-1.359-3-3-3z"/><path d="M12 5c-7.633 0-9.927 6.617-9.948 6.684L1.946 12l.105.316C2.073 12.383 4.367 19 12 19s9.927-6.617 9.948-6.684l.106-.316-.105-.316C21.927 11.617 19.633 5 12 5zm0 12c-5.351 0-7.424-3.846-7.926-5C4.578 10.842 6.652 7 12 7c5.351 0 7.424 3.846 7.926 5-.504 1.158-2.578 5-7.926 5z"/>';
const PW_ICON_HIDE = '<path d="M12 19c.946 0 1.81-.103 2.598-.281l-1.757-1.757c-.273.021-.55.038-.841.038-5.351 0-7.424-3.846-7.926-5a8.642 8.642 0 0 1 1.508-2.297L4.184 8.305c-1.538 1.667-2.121 3.346-2.132 3.379a.994.994 0 0 0 0 .633C2.073 12.383 4.367 19 12 19zm0-14c-1.837 0-3.346.396-4.604.981L3.707 2.293 2.293 3.707l18 18 1.414-1.414-3.319-3.319c2.614-1.951 3.547-4.615 3.561-4.657a.994.994 0 0 0 0-.633C21.927 11.617 19.633 5 12 5zm4.972 10.558-2.28-2.28c.19-.39.308-.819.308-1.278 0-1.641-1.359-3-3-3-.459 0-.888.118-1.277.308L8.915 7.5A9.458 9.458 0 0 1 12 7c5.351 0 7.424 3.846 7.926 5-.302.692-1.166 2.342-2.954 3.558z"/>';
passwordToggles.forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    if (!id) return;
    const input = document.getElementById(id);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    const icon = btn.querySelector('.pw-icon');
    if (icon) {
      icon.innerHTML = isPassword ? PW_ICON_HIDE : PW_ICON_SHOW;
      icon.dataset.state = isPassword ? 'hide' : 'show';
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
    let contactRestorePromise = null;
    let profileInitPromise = null;
    const currentPreBundle = newAccount ? preBundlePromise : undefined;
    preBundlePromise = null; // consumed; re-generated on next exchange if needed
    const r = await unlockAndInit({
      password: pwd,
      preBundle: currentPreBundle,
      onProgress: (step, status, detail) => {
        updateBootstrapStep(step, status, detail);
      },
      onMkReady: () => {
        // Start contact restore early — runs in parallel with prekey operations
        if (!newAccount) {
          updateBootstrapStep('contact-restore', 'start');
          contactRestorePromise = hydrateContactSecretsFromBackup({ reason: 'login-bootstrap' })
            .then((res) => {
              if (res.ok) {
                updateBootstrapStep('contact-restore', 'success', `還原 ${res.entries} 筆資料`);
              } else if (res.status === 404) {
                updateBootstrapStep('contact-restore', 'info', '無備份資料');
              } else {
                updateBootstrapStep('contact-restore', 'skip', '還原略過或失敗');
              }
              return res;
            })
            .catch((err) => {
              log({ contactRestoreError: err?.message || err });
              updateBootstrapStep('contact-restore', 'error', '還原失敗');
              return { ok: false };
            });
        }
      },
      onDeviceReady: (info) => {
        // Start profile init early — runs in parallel with wrapDevice + storeDevkeys
        if (newAccount) {
          updateBootstrapStep('nickname-init', 'start');
          updateBootstrapStep('avatar-init', 'start');
          profileInitPromise = initProfileDefaultsOnce({ uidHex: getAccountDigest(), evidence: info?.evidence || null })
            .then((result) => {
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
              return result;
            })
            .catch((err) => {
              const msg = err?.message || err;
              updateBootstrapStep('nickname-init', 'error', msg);
              updateBootstrapStep('avatar-init', 'error', msg);
              return { _profileError: err };
            });
        }
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
    // Await profile init started in onDeviceReady (parallel with wrapDevice + storeDevkeys)
    if (newAccount) {
      if (profileInitPromise) {
        const result = await profileInitPromise;
        if (result?._profileError) throw result._profileError;
      } else {
        // Fallback: onDeviceReady was not called (e.g. existing backup path)
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
      // Await contact restore started in onMkReady (parallel with prekeys)
      if (contactRestorePromise) {
        await contactRestorePromise;
      } else {
        // Fallback: onMkReady was not called (should not happen)
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
        }
      }
    }
    updateUidDisplay();
    // Set progress to 70% (matches app.html initial bar-fill) for seamless visual handoff
    setTransitionProgress(70, '載入中…');
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
    // sessionStorage is synchronous — redirect immediately for seamless transition
    location.replace(window.location.origin + '/pages/app.html');
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
  { pattern: /EnvelopeRecoveryError/i, message: PASSWORD_ERROR_MESSAGE },
  { pattern: /MK_UNWRAP_FAILED_HARDBLOCK/i, message: PASSWORD_ERROR_MESSAGE }
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
