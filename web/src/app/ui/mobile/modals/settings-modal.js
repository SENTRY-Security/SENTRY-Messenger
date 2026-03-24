// System settings modal (online status, auto-logout, logout redirect, change password)

import { escapeHtml } from '../ui-utils.js';
import { t, getCurrentLang, setLang, applyDOMTranslations } from '/locales/index.js';

const SUPPORTED_LANGUAGES = [
  { code: 'zh-Hant', label: '🇹🇼 繁體中文' },
  { code: 'zh-Hans', label: '🇨🇳 简体中文' },
  { code: 'en',      label: '🇺🇸 English' },
  { code: 'ja',      label: '🇯🇵 日本語' },
  { code: 'ko',      label: '🇰🇷 한국어' },
  { code: 'th',      label: '🇹🇭 ภาษาไทย' },
  { code: 'vi',      label: '🇻🇳 Tiếng Việt' }
];

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
    openChangePasswordModal, openPushModal, showAlertModal, onLabToggle } = deps;

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
      // Apply saved language preference from encrypted settings (post-login)
      if (applied.language && applied.language !== getCurrentLang()) {
        try {
          await setLang(applied.language);
          console.info('[settings] language applied from encrypted settings:', applied.language);
        } catch (err) { console.warn('[settings] language apply failed', err); }
      }
      try { console.info('[settings] boot:apply ' + JSON.stringify({ autoLogoutRedirectMode: applied.autoLogoutRedirectMode || null, hasCustomLogoutUrl: !!applied.autoLogoutCustomUrl, language: applied.language || null })); } catch { }
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
      if (errorEl) errorEl.textContent = t('settings.invalidUrlError');
      input.focus();
      return;
    }
    if (errorEl) errorEl.textContent = '';
    const originalLabel = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = t('settings.saving');
    try {
      await customLogoutCtx.onSubmit(sanitized);
      closeCustomLogoutModal();
    } catch (err) {
      log({ customLogoutSaveError: err?.message || err });
      if (errorEl) errorEl.textContent = err?.userMessage || err?.message || t('errors.saveSettingsFailed');
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
    saveBtn.textContent = t('settings.saved');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => { try { input.focus({ preventScroll: true }); } catch { input.focus(); } }, 30);
  }

  // --- Settings persistence ---

  async function persistPatch(partial) {
    const previous = getEffective();
    const next = { ...previous, ...partial };
    const trackedKeys = ['autoLogoutOnBackground', 'autoLogoutRedirectMode', 'autoLogoutCustomUrl', 'language', 'sentryLab'];
    const noChange = trackedKeys.every((key) => previous[key] === next[key]);
    if (noChange) return previous;
    sessionStore.settingsState = next;
    try {
      const saved = await saveSettings(next);
      sessionStore.settingsState = saved;
      log({ settingsSaved: { autoLogoutOnBackground: saved.autoLogoutOnBackground, autoLogoutRedirectMode: saved.autoLogoutRedirectMode, hasCustomLogoutUrl: !!sanitizeUrl(saved.autoLogoutCustomUrl) } });
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
    if (title) title.textContent = t('settings.systemSettings');
    const customSummaryValue = sanitizeUrl(current.autoLogoutCustomUrl) || t('settings.noSafeUrlSet');
    const autoLogoutDetailsVisible = !!current.autoLogoutOnBackground;
    body.innerHTML = `
      <div id="systemSettings" class="settings-form">
        <div class="settings-item">
          <div class="settings-text">
            <strong>${escapeHtml(t('settings.autoLogoutOnBackground'))}</strong>
            <p>${escapeHtml(t('settings.autoLogoutOnBackgroundDesc'))}</p>
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
            <strong>${escapeHtml(t('settings.defaultLogoutPage'))}</strong>
            <p>${escapeHtml(t('settings.defaultLogoutPageDesc'))}</p>
          </div>
        </label>
        <div class="settings-option custom-option">
          <input type="radio" name="autoLogoutRedirect" id="settingsLogoutCustom" value="custom" ${current.autoLogoutRedirectMode === 'custom' ? 'checked' : ''} />
          <div class="option-body">
            <strong>${escapeHtml(t('settings.customLogoutPage'))}</strong>
            <p>${escapeHtml(t('settings.customLogoutPageDesc'))}</p>
            <div class="custom-summary" id="settingsLogoutSummary">${escapeHtml(customSummaryValue)}</div>
            <button type="button" class="settings-link subtle" id="settingsLogoutManage">${escapeHtml(t('settings.setUrl'))}</button>
          </div>
        </div>
        </div>
        <div class="settings-item">
          <div class="settings-text">
            <strong>${escapeHtml(t('settings.changePassword'))}</strong>
            <p>${escapeHtml(t('password.newPasswordMinLength'))}</p>
          </div>
          <button type="button" class="settings-link" id="settingsChangePassword">${escapeHtml(t('settings.changePassword'))}</button>
        </div>
        <div class="settings-item">
          <div class="settings-text">
            <strong>${escapeHtml(t('settings.language'))}</strong>
          </div>
          <select id="settingsLanguage" class="settings-select" style="padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--bg);color:var(--fg);">
            ${SUPPORTED_LANGUAGES.map(l => `<option value="${l.code}" ${l.code === getCurrentLang() ? 'selected' : ''}>${escapeHtml(l.label)}</option>`).join('')}
          </select>
        </div>
        <div class="settings-item" id="settingsPushRow" style="cursor:pointer;">
          <div class="settings-text">
            <strong>${escapeHtml(t('push.settingsTitle'))}</strong>
            <p>${escapeHtml(t('push.settingsDesc'))}</p>
          </div>
          <span style="color:var(--muted);font-size:18px;">›</span>
        </div>
        ${window.APP_ENV && window.APP_ENV !== 'production' ? `<div class="settings-item">
          <div class="settings-text" style="display:flex;align-items:center;gap:8px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
              <path d="M10 2v6L4.5 18.5A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-2.5L14 8V2"/>
              <path d="M8.5 2h7"/>
              <path d="M7 16h10"/>
            </svg>
            <div>
              <strong>${escapeHtml(t('settings.sentryLab'))}</strong>
              <p>${escapeHtml(t('settings.sentryLabDesc'))}</p>
            </div>
          </div>
          <label class="settings-switch">
            <input type="checkbox" id="settingsSentryLab" ${current.sentryLab ? 'checked' : ''} />
            <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
          </label>
        </div>
        <div id="sentryLabSubItems" style="padding-left:36px;${current.sentryLab ? '' : 'display:none;'}">
          <div class="settings-item" style="border-top:none;padding-top:4px;padding-bottom:4px;">
            <div class="settings-text">
              <strong style="font-size:14px;">${escapeHtml(t('settings.sentryLabApps'))}</strong>
              <p>${escapeHtml(t('settings.sentryLabAppsDesc'))}</p>
            </div>
            <label class="settings-switch">
              <input type="checkbox" id="settingsSentryLabApps" ${current.sentryLabApps ? 'checked' : ''} />
              <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
            </label>
          </div>
          <div class="settings-item" style="border-top:none;padding-top:4px;padding-bottom:4px;">
            <div class="settings-text">
              <strong style="font-size:14px;">${escapeHtml(t('settings.sentryLabSafe'))}</strong>
              <p>${escapeHtml(t('settings.sentryLabSafeDesc'))}</p>
            </div>
            <label class="settings-switch">
              <input type="checkbox" id="settingsSentryLabSafe" ${current.sentryLabSafe ? 'checked' : ''} />
              <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
            </label>
          </div>
        </div>` : ''}
        <div class="settings-actions">
          <button type="button" class="secondary" id="settingsClose">${escapeHtml(t('common.close'))}</button>
        </div>
      </div>`;
    openModal();

    const closeBtn = body.querySelector('#settingsClose');
    const autoLogoutInput = body.querySelector('#settingsAutoLogout');
    const autoLogoutOptionsSection = body.querySelector('#settingsAutoLogoutOptions');
    const logoutDefaultRadio = body.querySelector('#settingsLogoutDefault');
    const logoutCustomRadio = body.querySelector('#settingsLogoutCustom');
    const logoutSummaryEl = body.querySelector('#settingsLogoutSummary');
    const logoutManageBtn = body.querySelector('#settingsLogoutManage');
    const changePasswordBtn = body.querySelector('#settingsChangePassword');

    const languageSelect = body.querySelector('#settingsLanguage');
    languageSelect?.addEventListener('change', async (e) => {
      const newLang = e.target.value;
      languageSelect.disabled = true;
      try {
        // Save language to encrypted settings (not localStorage)
        await persistPatch({ language: newLang });
        await setLang(newLang);
        // Live switch: close and re-open settings modal with new language
        closeModal();
        setTimeout(() => open(), 80);
      } catch (err) {
        log({ languageSaveError: err?.message || err });
        languageSelect.disabled = false;
        if (typeof showAlertModal === 'function') showAlertModal({ title: t('errors.saveFailed'), message: t('errors.saveSettingsFailed') });
      }
    });

    // --- Push notification row → opens push modal ---
    const pushRow = body.querySelector('#settingsPushRow');
    if (pushRow && typeof openPushModal === 'function') {
      pushRow.addEventListener('click', () => openPushModal(), { once: true });
    }

    closeBtn?.addEventListener('click', () => closeModal(), { once: true });
    changePasswordBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      openChangePasswordModal().catch((err) => {
        log({ changePasswordModalError: err?.message || err });
        if (typeof showAlertModal === 'function') showAlertModal({ title: t('errors.operationFailed'), message: t('settings.cannotOpenPasswordModal') });
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
      logoutSummaryEl.textContent = sanitizeUrl(getEffective().autoLogoutCustomUrl) || t('settings.noSafeUrlSet');
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
      catch (err) { log({ logoutRedirectModeSaveError: err?.message || err, mode: 'default' }); if (typeof showAlertModal === 'function') showAlertModal({ title: t('errors.saveFailed'), message: t('errors.saveSettingsFailed') }); }
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
        try { await persistPatch({ [key]: nextValue }); if (key === 'autoLogoutOnBackground') _autoLoggedOut = false; if (key === 'sentryLab' && typeof onLabToggle === 'function') onLabToggle(nextValue); }
        catch (err) { log({ settingsAutoSaveError: err?.message || err }); if (typeof showAlertModal === 'function') showAlertModal({ title: t('errors.saveFailed'), message: t('errors.saveSettingsFailed') }); input.checked = !!previous[key]; }
        finally { input.disabled = false; }
      });
    };
    if (autoLogoutInput) {
      autoLogoutInput.addEventListener('change', async () => {
        const previous = getEffective();
        const prevValue = !!previous.autoLogoutOnBackground;
        const nextValue = !!autoLogoutInput.checked;
        if (prevValue === nextValue) { setAutoLogoutVis(nextValue); return; }
        autoLogoutInput.disabled = true;
        setAutoLogoutVis(nextValue);
        try { await persistPatch({ autoLogoutOnBackground: nextValue }); _autoLoggedOut = false; }
        catch (err) { log({ settingsAutoSaveError: err?.message || err }); if (typeof showAlertModal === 'function') showAlertModal({ title: t('errors.saveFailed'), message: t('errors.saveSettingsFailed') }); autoLogoutInput.checked = prevValue; }
        finally { autoLogoutInput.disabled = false; const state = getEffective(); setAutoLogoutVis(!!state.autoLogoutOnBackground); syncRadios(); }
      });
    }

    const sentryLabInput = body.querySelector('#settingsSentryLab');
    const sentryLabSubItems = body.querySelector('#sentryLabSubItems');
    const sentryLabAppsInput = body.querySelector('#settingsSentryLabApps');
    const sentryLabSafeInput = body.querySelector('#settingsSentryLabSafe');

    // Parent toggle: show/hide sub-items and propagate to tab visibility
    if (sentryLabInput) {
      sentryLabInput.addEventListener('change', async () => {
        const previous = getEffective();
        const nextValue = !!sentryLabInput.checked;
        if (previous.sentryLab === nextValue) return;
        sentryLabInput.disabled = true;
        try {
          await persistPatch({ sentryLab: nextValue });
          if (sentryLabSubItems) sentryLabSubItems.style.display = nextValue ? '' : 'none';
          if (typeof onLabToggle === 'function') {
            const s = getEffective();
            onLabToggle({ apps: nextValue && s.sentryLabApps, safe: nextValue && s.sentryLabSafe });
          }
        } catch (err) {
          log({ settingsAutoSaveError: err?.message || err });
          if (typeof showAlertModal === 'function') showAlertModal({ title: t('errors.saveFailed'), message: t('errors.saveSettingsFailed') });
          sentryLabInput.checked = !!previous.sentryLab;
        } finally { sentryLabInput.disabled = false; }
      });
    }

    // Sub-toggle: Apps
    if (sentryLabAppsInput) {
      sentryLabAppsInput.addEventListener('change', async () => {
        const previous = getEffective();
        const nextValue = !!sentryLabAppsInput.checked;
        if (previous.sentryLabApps === nextValue) return;
        sentryLabAppsInput.disabled = true;
        try {
          await persistPatch({ sentryLabApps: nextValue });
          if (typeof onLabToggle === 'function') {
            const s = getEffective();
            onLabToggle({ apps: s.sentryLab && nextValue, safe: s.sentryLab && s.sentryLabSafe });
          }
        } catch (err) {
          log({ settingsAutoSaveError: err?.message || err });
          if (typeof showAlertModal === 'function') showAlertModal({ title: t('errors.saveFailed'), message: t('errors.saveSettingsFailed') });
          sentryLabAppsInput.checked = !!previous.sentryLabApps;
        } finally { sentryLabAppsInput.disabled = false; }
      });
    }

    // Sub-toggle: SAFE
    if (sentryLabSafeInput) {
      sentryLabSafeInput.addEventListener('change', async () => {
        const previous = getEffective();
        const nextValue = !!sentryLabSafeInput.checked;
        if (previous.sentryLabSafe === nextValue) return;
        sentryLabSafeInput.disabled = true;
        try {
          await persistPatch({ sentryLabSafe: nextValue });
          if (typeof onLabToggle === 'function') {
            const s = getEffective();
            onLabToggle({ apps: s.sentryLab && s.sentryLabApps, safe: s.sentryLab && nextValue });
          }
        } catch (err) {
          log({ settingsAutoSaveError: err?.message || err });
          if (typeof showAlertModal === 'function') showAlertModal({ title: t('errors.saveFailed'), message: t('errors.saveSettingsFailed') });
          sentryLabSafeInput.checked = !!previous.sentryLabSafe;
        } finally { sentryLabSafeInput.disabled = false; }
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
