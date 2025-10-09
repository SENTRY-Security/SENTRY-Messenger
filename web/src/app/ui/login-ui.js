// /app/ui/login-ui.js
// Login page binder: SDM Exchange → Unlock (argon2id) → ensureKeysAfterUnlock → redirect to /pages/app.html
// This module is intentionally self-contained for the login page; it reuses core modules and minimal crypto helpers.

// Removed import of fetchJSON, jsonReq from ../core/http.js
import { log, setLogSink } from '../core/log.js';
import {
  getSession, setSession,
  getHasMK, setHasMK,
  getWrappedMK, setWrappedMK,
  getUidHex, setUidHex,
  getMkRaw, setMkRaw,
  getAccountToken, setAccountToken,
  getAccountDigest, setAccountDigest,
  getUidDigest, setUidDigest,
  getDevicePriv,
  resetAll, clearSecrets,
  setOpaqueServerId
} from '../core/store.js';
import { exchangeSDM, unlockAndInit } from '../features/login-flow.js';
import { exchangeFromURLIfPresent, exchangeWithParams, parseSdmParams } from '../features/sdm.js';
import { sdmDebugKit } from '../api/auth.js';

// ---- UI elements ----
const $ = (sel) => document.querySelector(sel);
const out = $('#out');
const modalEl = document.getElementById('loginModal');
const modalBody = document.getElementById('loginModalBody');
const modalClose = document.getElementById('loginModalClose');
const modalBackdrop = document.getElementById('loginModalBackdrop');
const welcomeModal = document.getElementById('welcomeModal');
const welcomeContent = document.getElementById('welcomeContent');
const welcomeNextBtn = document.getElementById('welcomeNext');
const welcomeCloseBtn = document.getElementById('welcomeClose');

setLogSink((line) => {
  if (out) out.textContent = line;
  if (shouldShowModal(line)) showModalMessage(line);
});

const uidEl = $('#uidHex');
const uidDisplayEl = document.getElementById('uidHexDisplay');
const macEl = $('#sdmMac');
const ctrEl = $('#sdmCtr');
const nonceEl = $('#nonce');
const btnSdmExchangeEl = document.getElementById('btnSdmExchange');
const sessionView = $('#sessionView');
const pwdEl = $('#pwd');
const unlockBtn = $('#btnUnlock');
const actionsBlock = document.querySelector('.actions');
const simDebugBtn = document.getElementById('btnSimDebug');
const passwordWrapper = document.getElementById('passwordWrapper');
const confirmWrapper = document.getElementById('confirmWrapper');
const pwdConfirmEl = document.getElementById('pwdConfirm');
const passwordToggles = document.querySelectorAll('.password-toggle');
export const AUDIO_PERMISSION_KEY = 'audio-permission';

let loginInProgress = false;
const SIM_DEBUG_STORAGE_KEY = 'ntag424-sim:debug-kit';
let newAccount = false;
let welcomeAcknowledged = false;

if (pwdEl) {
  try {
    const rand = Math.random().toString(36).slice(2);
    pwdEl.name = `pw_${Date.now()}_${rand}`;
    pwdEl.setAttribute('autocomplete', 'off');
    pwdEl.setAttribute('data-keep-autocomplete-off', 'true');
  } catch {}
}
if (pwdConfirmEl) {
  try {
    const rand = Math.random().toString(36).slice(2);
    pwdConfirmEl.name = `pw_c_${Date.now()}_${rand}`;
    pwdConfirmEl.setAttribute('autocomplete', 'off');
  } catch {}
}
applyAccountMode();
const loadingBackdrop = document.getElementById('loginLoading'); const loadingTextEl = document.getElementById('loginLoadingText');

function loadSimDebugState() {
  try {
    const raw = localStorage.getItem(SIM_DEBUG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSimDebugState(data) {
  try {
    localStorage.setItem(SIM_DEBUG_STORAGE_KEY, JSON.stringify(data || {}));
  } catch {}
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
  if (welcomeContent) welcomeContent.focus({ preventScroll: true });
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
  const uid = getUidHex() || '';
  if (uidEl) uidEl.value = uid;
  if (uidDisplayEl) uidDisplayEl.textContent = uid || '請重新感應晶片';
};
updateUidDisplay();

function setUidVerifyingState(active) {
  if (active) {
    if (uidVerifying) return;
    uidVerifying = true;
    if (uidEl) {
      uidEl.dataset.prevValue = uidEl.value || '';
      uidEl.value = '晶片序號驗證中...';
      uidEl.readOnly = true;
      uidEl.classList.add('uid-verifying');
    }
    if (uidDisplayEl) uidDisplayEl.textContent = '晶片序號驗證中...';
    return;
  }
  if (!uidVerifying) return;
  uidVerifying = false;
  if (uidEl) {
    if (uidEl.dataset.prevValue !== undefined) {
      uidEl.value = uidEl.dataset.prevValue;
      delete uidEl.dataset.prevValue;
    }
    uidEl.readOnly = false;
    uidEl.classList.remove('uid-verifying');
  }
  updateUidDisplay();
}

function isLikelyDesktop() {
  try {
    const mm = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null;
    const pointerFine = mm ? mm('(pointer: fine)').matches : false;
    const pointerCoarse = mm ? mm('(pointer: coarse)').matches : false;
    const hoverCapable = mm ? mm('(hover: hover)').matches : false;
    const touchPoints = typeof navigator !== 'undefined' ? Number(navigator.maxTouchPoints || 0) : 0;
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    const desktopUA = /Windows NT|Macintosh|Linux x86_64/.test(ua);
    if (pointerFine || (hoverCapable && touchPoints === 0)) return true;
    if (!pointerCoarse && desktopUA) return true;
    if (localStorage.getItem('ntag424-sim:forceDebug') === '1') return true;
    return false;
  } catch {
    return true;
  }
}

if (isLikelyDesktop() && simDebugBtn) {
  simDebugBtn.classList.remove('hidden');
  simDebugBtn.addEventListener('click', onSimDebugClick);
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
  const uidHex = (uidEl.value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  const macHex = (macEl.value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  const ctrRaw = (ctrEl.value || '').trim();
  const nonce = (nonceEl.value || '').trim() || 'n/a';
  if (!uidHex || uidHex.length < 14) return log('UID hex required (14 hex)');
  if (!macHex || macHex.length < 16) return log('SDM MAC (16 hex) required');
  try {
    await exchangeWithParams({ uidHex, sdmmac: macHex, sdmcounter: ctrRaw, nonce });
    sessionView.value = getSession() || '';
    updateUidDisplay();
    log({ exchange: { hasMK: getHasMK(), session: !!getSession(), wrapped: !!getWrappedMK() } });
    newAccount = !getHasMK();
    if (newAccount) welcomeAcknowledged = false;
    applyAccountMode();
  } catch (e) {
    log({ exchangeError: String(e?.message || e) });
  }
}

async function onSimDebugClick() {
  try {
    const stored = loadSimDebugState();
    const payload = stored?.uidHex ? { uidHex: stored.uidHex } : {};
    const { r, data } = await sdmDebugKit(payload);
    if (!r.ok) {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      log({ debugSimError: `debug-kit failed (${r.status})`, detail: text });
      return;
    }
    const kit = data || {};
    if (!kit.uidHex || !kit.sdmcounter || !kit.sdmmac) {
      throw new Error('後端回傳的 debug 資料不完整');
    }

    saveSimDebugState({ uidHex: kit.uidHex });

    setUidHex(kit.uidHex);
    updateUidDisplay();
    if (uidEl) uidEl.value = kit.uidHex;
    if (macEl) macEl.value = kit.sdmmac;
    if (ctrEl) ctrEl.value = kit.sdmcounter;
    if (nonceEl) nonceEl.value = kit.nonce || `debug-${Date.now()}`;

    log({ debugSim: { uidHex: kit.uidHex } });
    welcomeAcknowledged = false;
    newAccount = false;
    await onSdmExchange();
  } catch (err) {
    log({ debugSimError: String(err?.message || err) });
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
    }
  } catch (e) {
    log({ exchangeError: String(e?.message || e) });
  } finally {
    setUidVerifyingState(false);
  }
})();

// ---- Unlock / Reset ----
if (unlockBtn) unlockBtn.onclick = onUnlock;
const btnResetMK = document.getElementById('btnResetMK');
if (btnResetMK) btnResetMK.onclick = () => { try { setMkRaw(null); log('Local MK cleared.'); } catch {} };

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
    loginInProgress = true;
    showLoading(newAccount ? '正在建立安全環境…' : '登入中，請稍候…');
    const r = await unlockAndInit({ password: pwd });
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
    updateUidDisplay();
    updateLoading('登入成功，正在導向…');
    // handoff MK/UID to next page (sessionStorage, same-tab only)
    try {
      const mk = getMkRaw();
      if (mk && mk.length) sessionStorage.setItem('mk_b64', b64(mk));
      const uid = getUidHex();
      if (uid) sessionStorage.setItem('uid_hex', uid);
      const accountToken = getAccountToken();
      if (accountToken) sessionStorage.setItem('account_token', accountToken);
      const accountDigest = getAccountDigest();
      if (accountDigest) sessionStorage.setItem('account_digest', accountDigest);
      const uidDigest = getUidDigest();
      if (uidDigest) sessionStorage.setItem('uid_digest', uidDigest);
    } catch {}
    setTimeout(() => location.replace('/pages/app.html'), 300);
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
  setUidDigest(null);
  setOpaqueServerId(null);
  try {
    sessionStorage.removeItem('account_token');
    sessionStorage.removeItem('account_digest');
    sessionStorage.removeItem('uid_digest');
  } catch {}
  newAccount = false;
  welcomeAcknowledged = false;
  applyAccountMode();
}


const FALLBACK_ERROR_MESSAGE = '發生未知錯誤，請稍後再試。';

const ERROR_CODE_MESSAGES = {
  ConfigError: '伺服器設定異常，請通知客服。',
  Unauthorized: '標籤驗證失敗，請重新感應卡片。',
  ExchangeFailed: '伺服器驗證失敗，請稍後再試。',
  Replay: '偵測到晶片計數器重複，請關閉頁面後重新感應。',
  SessionExpired: '驗證已逾時，請重新感應卡片。',
  SessionMismatch: '驗證資料不一致，請重新感應卡片。',
  StoreFailed: '伺服器儲存資料失敗，請稍後再試。',
  BadRequest: '送出的資訊格式不正確，請確認後重試。'
};

const ERROR_PATTERNS = [
  { pattern: /uid hex \(14\) required/i, message: '尚未偵測到標籤 UID，請重新感應。' },
  { pattern: /sdm mac \(16\) required/i, message: 'MAC 資料缺失，請重新感應標籤。' },
  { pattern: /password required/i, message: '請輸入解鎖密碼。' },
  { pattern: /請輸入密碼。?/i, message: '請輸入密碼。' },
  { pattern: /密碼至少需 6 個字元/i, message: '密碼至少需 6 個字元。' },
  { pattern: /兩次輸入的密碼不一致/i, message: '兩次輸入的密碼不一致。' },
  { pattern: /sdm exchange required/i, message: '請先完成標籤驗證。' },
  { pattern: /uid not set/i, message: '尚未偵測到標籤 UID，請重新感應。' },
  { pattern: /wrong password or envelope mismatch/i, message: '密碼不正確，請重新輸入。' },
  { pattern: /unlock failed/i, message: '密碼不正確，請重新輸入。' },
  { pattern: /enter a password first/i, message: '請輸入解鎖密碼。' },
  { pattern: /run sdm exchange first/i, message: '請先感應標籤並完成驗證。' },
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
  { pattern: /sdm verify failed/i, message: '標籤驗證失敗，請重新感應卡片。' }
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
function safeJSON(text){ try{ return JSON.parse(text); }catch{ return text; } }
function b64(u8){ let s=''; for(let i=0;i<u8.length;i++) s+=String.fromCharCode(u8[i]); return btoa(s); }
function b64u8(b64s){ const bin=atob(b64s); const u8=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i); return u8; }

// Harden: disable password storing/autofill on all inputs
(function hardenInputs(){
  try {
    const els = document.querySelectorAll('input, textarea');
    els.forEach(el => {
      el.setAttribute('autocomplete','off');
      el.setAttribute('autocapitalize','off');
      el.setAttribute('autocorrect','off');
      el.setAttribute('spellcheck','false');
      // for password fields specifically
      if (el.type === 'password') {
        el.setAttribute('autocomplete','new-password');
        el.setAttribute('data-1p-ignore','true');
        el.setAttribute('data-lpignore','true');
        if (!el.getAttribute('name')) el.setAttribute('name','__no_store_pwd__');
      }
    });
  } catch {}
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
    await ctx.resume().catch(() => {});
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    try { source.start(0); } catch {}
    sessionStorage.setItem(AUDIO_PERMISSION_KEY, 'granted');
    try { await ctx.close(); } catch {}
    log({ audioPermission: 'granted' });
  } catch (err) {
    log({ audioPermissionError: err?.message || err });
  }
}
