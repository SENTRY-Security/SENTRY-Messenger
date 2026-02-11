// System settings modal (online status, auto-logout, logout redirect, change password)

import { escapeHtml } from '../ui-utils.js';

const LOGOUT_REDIRECT_DEFAULT_URL = '/pages/logout.html';
const LOGOUT_REDIRECT_PLACEHOLDER = 'https://example.com/logout';
const LOGOUT_REDIRECT_SUGGESTIONS = Object.freeze([
  'https://sentry.red',
  'https://apple.com',
  'https://www.cloudflare.com',
  'https://www.mozilla.org',
  'https://www.wikipedia.org'
]);

export function createSettingsModule({ deps }) {
  const { log, showToast, sessionStore, openModal, closeModal, resetModalVariants,
    DEFAULT_SETTINGS, saveSettings, loadSettings,
    getMkRaw, getAccountDigest,
    openChangePasswordModal } = deps;

  let initPromise = null;
  let customLogoutCtx = null;
  let customLogoutInvoker = null;
  let customLogoutBound = false;
  let _autoLoggedOut = false;

  function getEffective() {
    return { ...DEFAULT_SETTINGS, ...(sessionStore.settingsState || {}) };
  }

  function sanitizeUrl(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      if (!parsed.hostname) return '';
      return parsed.toString();
    } catch { return ''; }
  }

  function logBootStart({ digest, convId, mkReady }) {
    try { console.info('[settings] boot:load:start ' + JSON.stringify({ digest, convId, mkReady })); } catch { }
  }

  async function bootLoad() {
    const digest = getAccountDigest();
    const convId = digest ? `settings-${String(digest).toUpperCase()}` : null;
    const mkReady = !!getMkRaw();
    logBootStart({ digest: digest || null, convId, mkReady });
    if (!mkReady || !convId) {
      const err = new Error('settings boot prerequisites missing');
      try { console.info('[settings] boot:load:done ' + JSON.stringify({ ok: false, hasEnvelope: false, reason: 'mk/account missing', ts: null })); } catch { }
      throw err;
    }
    try {
      const { settings, meta } = await loadSettings({ returnMeta: true });
      const info = meta || {};
      try { console.info('[settings] boot:load:done ' + JSON.stringify({ ok: info.ok !== false, hasEnvelope: !!info.hasEnvelope, urlMode: info.urlMode || null, hasUrl: !!info.hasUrl, urlLen: info.urlLen || 0, ts: info.ts || null })); } catch { }
      const applied = settings || { ...DEFAULT_SETTINGS, updatedAt: Date.now() };
      sessionStore.settingsState = applied;
      try { console.info('[settings] boot:apply ' + JSON.stringify({ autoLogoutRedirectMode: applied.autoLogoutRedirectMode || null, hasCustomLogoutUrl: !!applied.autoLogoutCustomUrl })); } catch { }
      return applied;
    } catch (err) {
      try { console.info('[settings] boot:load:done ' + JSON.stringify({ ok: false, hasEnvelope: true, reason: err?.message || String(err), ts: null })); } catch { }
      throw err;
    }
  }

  function isSettingsConvId(convId) {
    return typeof convId === 'string' && convId.startsWith('settings-');
  }

  async function handleSecureMessage() {
    try {
      const refreshed = await loadSettings();
      if (refreshed && typeof refreshed === 'object') sessionStore.settingsState = refreshed;
    } catch (err) { log({ settingsHydrateError: err?.message || err }); }
  }

  // --- Custom logout URL modal ---

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

  function closeCustomLogoutModal() {
    const { modal } = getCustomLogoutElements();
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    customLogoutCtx = null;
    const focusTarget = customLogoutInvoker;
    customLogoutInvoker = null;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      try { focusTarget.focus({ preventScroll: true }); } catch { focusTarget.focus(); }
    }
  }

  function handleCustomLogoutCancel() {
    const handler = customLogoutCtx?.onCancel;
    closeCustomLogoutModal();
    if (typeof handler === 'function') {
      try { handler(); } catch (err) { log({ customLogoutCancelError: err?.message || err }); }
    }
  }

  async function handleCustomLogoutSave() {
    if (!customLogoutCtx || typeof customLogoutCtx.onSubmit !== 'function') return;
    const { input, saveBtn, errorEl } = getCustomLogoutElements();
    if (!input || !saveBtn) return;
    const sanitized = sanitizeUrl(input.value || '');
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
      await customLogoutCtx.onSubmit(sanitized);
      closeCustomLogoutModal();
    } catch (err) {
      log({ customLogoutSaveError: err?.message || err });
      if (errorEl) errorEl.textContent = err?.userMessage || err?.message || '儲存設定失敗，請稍後再試。';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  }

  function bindCustomLogoutHandlers() {
    if (customLogoutBound) return;
    const { cancelBtn, closeBtn, backdrop, saveBtn, input, errorEl } = getCustomLogoutElements();
    if (!cancelBtn && !closeBtn && !backdrop && !saveBtn && !input) return;
    cancelBtn?.addEventListener('click', (e) => { e.preventDefault(); handleCustomLogoutCancel(); });
    closeBtn?.addEventListener('click', (e) => { e.preventDefault(); handleCustomLogoutCancel(); });
    backdrop?.addEventListener('click', (e) => { e.preventDefault(); handleCustomLogoutCancel(); });
    saveBtn?.addEventListener('click', (e) => { e.preventDefault(); handleCustomLogoutSave(); });
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleCustomLogoutSave(); } });
    input?.addEventListener('input', () => { if (errorEl) errorEl.textContent = ''; });
    customLogoutBound = true;
  }

  function openCustomLogoutModal({ initialValue = '', onSubmit, onCancel, invoker } = {}) {
    const { modal, input, saveBtn, errorEl } = getCustomLogoutElements();
    if (!modal || !input || !saveBtn) return;
    bindCustomLogoutHandlers();
    customLogoutCtx = { onSubmit, onCancel };
    customLogoutInvoker = invoker || null;
    input.value = initialValue || '';
    input.placeholder = LOGOUT_REDIRECT_PLACEHOLDER;
    if (errorEl) errorEl.textContent = '';
    saveBtn.disabled = false;
    saveBtn.textContent = '儲存';
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => { try { input.focus({ preventScroll: true }); } catch { input.focus(); } }, 30);
  }

  // --- Settings persistence ---

  async function persistPatch(partial) {
    const previous = getEffective();
    const next = { ...previous, ...partial };
    const trackedKeys = ['showOnlineStatus', 'autoLogoutOnBackground', 'autoLogoutRedirectMode', 'autoLogoutCustomUrl'];
    const noChange = trackedKeys.every((key) => previous[key] === next[key]);
    if (noChange) return previous;
    sessionStore.settingsState = next;
    try {
      const saved = await saveSettings(next);
      sessionStore.settingsState = saved;
      log({ settingsSaved: { showOnlineStatus: saved.showOnlineStatus, autoLogoutOnBackground: saved.autoLogoutOnBackground, autoLogoutRedirectMode: saved.autoLogoutRedirectMode, hasCustomLogoutUrl: !!sanitizeUrl(saved.autoLogoutCustomUrl) } });
      return saved;
    } catch (err) {
      sessionStore.settingsState = previous;
      throw err;
    }
  }

  // --- Redirect info ---

  function getRedirectInfo(settings) {
    const state = settings || getEffective();
    const sanitized = sanitizeUrl(state.autoLogoutCustomUrl);
    const isCustom = state.autoLogoutRedirectMode === 'custom' && !!sanitized;
    return { url: isCustom ? sanitized : LOGOUT_REDIRECT_DEFAULT_URL, isCustom };
  }

  function getRedirectTarget(settings) {
    return getRedirectInfo(settings).url;
  }

  // --- Open settings modal ---

  async function open() {
    let settings = sessionStore.settingsState;
    if (!settings) {
      try { settings = await initPromise; } catch (err) { log({ settingsLoadError: err?.message || err }); }
    }
    const current = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body) return;
    resetModalVariants(modalElement);
    modalElement.classList.add('settings-modal');
    if (title) title.textContent = '系統設定';
    const customSummaryValue = sanitizeUrl(current.autoLogoutCustomUrl) || '尚未設定安全網址';
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

    closeBtn?.addEventListener('click', () => closeModal(), { once: true });
    changePasswordBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      openChangePasswordModal().catch((err) => {
        log({ changePasswordModalError: err?.message || err });
        alert('目前無法開啟變更密碼視窗，請稍後再試。');
      });
    });

    const setAutoLogoutVis = (visible) => {
      if (!autoLogoutOptionsSection) return;
      autoLogoutOptionsSection.classList.toggle('hidden', !visible);
      autoLogoutOptionsSection.setAttribute('aria-hidden', visible ? 'false' : 'true');
    };
    const syncRadios = () => {
      const state = getEffective();
      if (logoutDefaultRadio) logoutDefaultRadio.checked = state.autoLogoutRedirectMode !== 'custom';
      if (logoutCustomRadio) logoutCustomRadio.checked = state.autoLogoutRedirectMode === 'custom';
    };
    const refreshSummary = () => {
      if (!logoutSummaryEl) return;
      logoutSummaryEl.textContent = sanitizeUrl(getEffective().autoLogoutCustomUrl) || '尚未設定安全網址';
    };
    const launchCustomModal = (invoker) => {
      openCustomLogoutModal({
        initialValue: sanitizeUrl(getEffective().autoLogoutCustomUrl) || LOGOUT_REDIRECT_SUGGESTIONS[0] || '',
        invoker,
        onSubmit: async (url) => { await persistPatch({ autoLogoutCustomUrl: url, autoLogoutRedirectMode: 'custom' }); refreshSummary(); syncRadios(); },
        onCancel: () => { refreshSummary(); syncRadios(); }
      });
    };

    setAutoLogoutVis(autoLogoutDetailsVisible);
    syncRadios();
    refreshSummary();

    logoutManageBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      if (logoutCustomRadio) logoutCustomRadio.checked = true;
      launchCustomModal(event.currentTarget);
    });
    logoutDefaultRadio?.addEventListener('change', async () => {
      if (!logoutDefaultRadio.checked) return;
      logoutDefaultRadio.disabled = true;
      logoutCustomRadio && (logoutCustomRadio.disabled = true);
      try { await persistPatch({ autoLogoutRedirectMode: 'default', autoLogoutCustomUrl: null }); refreshSummary(); }
      catch (err) { log({ logoutRedirectModeSaveError: err?.message || err, mode: 'default' }); alert('儲存設定失敗，請稍後再試。'); }
      finally { logoutDefaultRadio.disabled = false; if (logoutCustomRadio) logoutCustomRadio.disabled = false; syncRadios(); }
    });
    logoutCustomRadio?.addEventListener('change', (event) => {
      if (!logoutCustomRadio.checked) return;
      if (event && event.isTrusted === false) return;
      launchCustomModal(event.currentTarget);
    });

    const registerToggle = (input, key) => {
      if (!input) return;
      input.addEventListener('change', async () => {
        const previous = getEffective();
        const nextValue = !!input.checked;
        if (previous[key] === nextValue) return;
        input.disabled = true;
        try { await persistPatch({ [key]: nextValue }); if (key === 'autoLogoutOnBackground') _autoLoggedOut = false; }
        catch (err) { log({ settingsAutoSaveError: err?.message || err }); alert('儲存設定失敗，請稍後再試。'); input.checked = !!previous[key]; }
        finally { input.disabled = false; }
      });
    };
    registerToggle(showOnlineInput, 'showOnlineStatus');
    if (autoLogoutInput) {
      autoLogoutInput.addEventListener('change', async () => {
        const previous = getEffective();
        const prevValue = !!previous.autoLogoutOnBackground;
        const nextValue = !!autoLogoutInput.checked;
        if (prevValue === nextValue) { setAutoLogoutVis(nextValue); return; }
        autoLogoutInput.disabled = true;
        setAutoLogoutVis(nextValue);
        try { await persistPatch({ autoLogoutOnBackground: nextValue }); _autoLoggedOut = false; }
        catch (err) { log({ settingsAutoSaveError: err?.message || err }); alert('儲存設定失敗，請稍後再試。'); autoLogoutInput.checked = prevValue; }
        finally { autoLogoutInput.disabled = false; const state = getEffective(); setAutoLogoutVis(!!state.autoLogoutOnBackground); syncRadios(); }
      });
    }
  }

  return {
    getEffective,
    sanitizeUrl,
    bootLoad,
    isSettingsConvId,
    handleSecureMessage,
    persistPatch,
    getRedirectInfo,
    getRedirectTarget,
    open,
    openCustomLogoutModal,
    get initPromise() { return initPromise; },
    set initPromise(v) { initPromise = v; },
    get autoLoggedOut() { return _autoLoggedOut; },
    set autoLoggedOut(v) { _autoLoggedOut = v; }
  };
}
