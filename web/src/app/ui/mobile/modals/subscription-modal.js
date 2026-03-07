// Subscription status & top-up modal
//
// Usage:
//   const sub = createSubscriptionModule({ deps: { ... } });
//   sub.openModal();

import { t } from '/locales/index.js';

export function createSubscriptionModule({ deps }) {
  const { showToast, log, sessionStore, openModal, closeModal, resetModalVariants,
    subscriptionStatus, redeemSubscription, uploadSubscriptionQr, QrScanner,
    userAvatarWrap, userMenuBadge, userMenuSubscriptionBadge } = deps;

  let countdownTimer = null;
  let scanner = null;
  let scannerActive = false;

  function updateBadge(expired) {
    if (!userAvatarWrap || !userMenuBadge) return;
    const show = !!expired;
    userAvatarWrap.classList.toggle('has-alert', show);
    userMenuBadge.style.display = show ? 'inline-flex' : 'none';
    if (userMenuSubscriptionBadge) userMenuSubscriptionBadge.style.display = show ? 'inline-flex' : 'none';
  }

  function normalizeLogs(logsRaw) {
    if (!Array.isArray(logsRaw)) return [];
    return logsRaw.map((log, idx) => {
      const extendDays = Number(log?.extend_days ?? log?.extendDays ?? log?.duration_days ?? log?.durationDays ?? 0) || 0;
      const expiresAfter = Number(log?.expires_at_after ?? log?.expiresAtAfter ?? log?.expires_at ?? log?.expiresAt ?? 0) || null;
      const usedAt = Number(log?.used_at ?? log?.usedAt ?? log?.updated_at ?? log?.redeemed_at ?? 0) || null;
      const issuedAt = Number(log?.issued_at ?? log?.issuedAt ?? 0) || null;
      const status = typeof log?.status === 'string' ? log.status : (extendDays ? 'used' : 'active');
      const tokenId = log?.token_id || log?.tokenId || log?.voucher_id || log?.jti || `token-${idx + 1}`;
      let channel = log?.channel || log?.gateway || null;
      if (!channel && (log?.key_id || log?.keyId)) channel = t('subscription.voucherPrefix', { id: log?.key_id || log?.keyId });
      if (!channel) channel = t('subscription.qrVoucher');
      const type = extendDays > 0 ? 'extend' : 'activate';
      return { tokenId, extendDays, expiresAfter, usedAt, issuedAt, status, channel, type };
    });
  }

  function computeCountdown(expiresAt) {
    const now = Date.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return { expired: true, text: t('subscription.expired'), seconds: 0 };
    const diff = expiresAt - now;
    if (diff <= 0) return { expired: true, text: t('subscription.expired'), seconds: 0 };
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    if (days > 0) return { expired: false, text: t('subscription.remainingDays', { days }), seconds: diff };
    if (hours > 0) return { expired: false, text: t('subscription.remainingHours', { hours }), seconds: diff };
    return { expired: false, text: t('subscription.remainingMinutes', { minutes: Math.max(mins, 1) }), seconds: diff };
  }

  async function refreshStatus({ silent = false } = {}) {
    const state = sessionStore.subscriptionState;
    state.loading = true;
    state.logs = [];
    try {
      const { r, data } = await subscriptionStatus();
      if (!r.ok || !data?.ok) throw new Error(typeof data === 'string' ? data : data?.message || 'status failed');
      state.lastChecked = Date.now();
      state.logs = normalizeLogs(data?.logs);
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
      if (!silent) showToast?.(t('subscription.querySubscriptionFailed', { error: err?.message || err }), { variant: 'error' });
      state.found = false;
      state.expiresAt = null;
      state.expired = true;
      state.logs = [];
      state.accountCreatedAt = state.accountCreatedAt || null;
    } finally {
      state.loading = false;
      updateBadge(state.expired);
      try { document.dispatchEvent(new CustomEvent('subscription:state', { detail: { state: { ...state } } })); } catch { }
    }
    return sessionStore.subscriptionState;
  }

  function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function stopScanner({ destroy = false } = {}) {
    if (scanner && scannerActive) { try { scanner.stop(); } catch { } }
    scannerActive = false;
    if (destroy && scanner) { try { scanner.destroy?.(); } catch { } scanner = null; }
  }

  function startCountdown(expiresAt) {
    stopCountdown();
    const statusText = document.getElementById('subscriptionStatusText');
    const countdownHint = document.getElementById('subscriptionCountdownHint');
    if (!statusText) return;
    const tick = () => {
      const { expired, text } = computeCountdown(expiresAt);
      statusText.textContent = expired ? t('subscription.expired') : text;
      statusText.className = expired ? 'sub-status error' : 'sub-status ok';
      if (countdownHint) countdownHint.textContent = expired ? t('subscription.pleaseTopUp') : t('subscription.autoSyncHint');
      if (expired) updateBadge(true);
    };
    tick();
    const interval = Math.max(30, Math.min(300, Math.floor(Math.max(expiresAt - Date.now(), 60) / 2)));
    countdownTimer = setInterval(tick, interval * 1000);
  }

  async function handleRedeem(token, hooks = {}) {
    if (!token) {
      showToast?.(t('subscription.enterOrScanVoucher'), { variant: 'warning' });
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
      updateBadge(sessionStore.subscriptionState.expired);
      const statusText = document.getElementById('subscriptionStatusText');
      if (statusText) statusText.textContent = t('subscription.extensionSuccessUpdating');
      await refreshStatus({ silent: true });
      const msg = typeof data?.message === 'string' ? data.message : t('subscription.extensionSuccess');
      showToast?.(msg, { variant: 'success' });
      onSuccess?.(data);
      return { ok: true, data };
    } catch (err) {
      const detail = err?.message || err;
      const msg = typeof detail === 'string' ? detail : t('subscription.extensionFailed');
      showToast?.(msg, { variant: 'error' });
      onError?.(err);
      return { ok: false, error: err };
    } finally {
      if (redeemBtn) redeemBtn.disabled = false;
    }
  }

  async function handleFile(files, hooks = {}) {
    const list = files && typeof files.length === 'number' ? files : [];
    const file = list[0] || null;
    if (!file) return { ok: false, error: new Error('file missing') };
    try {
      hooks.onStart?.();
      const { r, data } = await uploadSubscriptionQr({ file });
      if (!r.ok || !data?.ok) {
        const msg = typeof data === 'object' && data?.message ? data.message : t('subscription.extensionFailed');
        throw new Error(msg);
      }
      return { ok: true, data };
    } catch (err) {
      if (hooks?.onError) hooks.onError(err);
      else showToast?.(t('subscription.fileParseError', { error: err?.message || err }), { variant: 'error' });
      return { ok: false, error: err };
    }
  }

  function showGateModal() {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modal || !body) return;
    stopScanner({ destroy: true });
    stopCountdown();
    resetModalVariants(modal);
    modal.classList.add('confirm-modal', 'subscription-modal-shell');
    if (title) title.textContent = t('subscription.expiredTitle');
    body.innerHTML = `
      <div class="confirm-message">${t('subscription.accountExpiredMessage')}</div>
      <div class="confirm-actions">
        <button type="button" class="secondary" id="subscriptionGateClose">${t('common.close')}</button>
        <button type="button" class="primary" id="subscriptionGateOpen">${t('subscription.clickToTopUp')}</button>
      </div>
    `;
    openModal();
    document.getElementById('subscriptionGateClose')?.addEventListener('click', () => closeModal());
    document.getElementById('subscriptionGateOpen')?.addEventListener('click', () => { closeModal(); open(); });
  }

  function open() {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modal || !body) return;
    stopScanner({ destroy: true });
    stopCountdown();
    resetModalVariants(modal);
    modal.classList.add('settings-modal', 'subscription-modal-shell');
    if (title) title.textContent = t('subscription.title');
    body.innerHTML = `
      <div class="subscription-modal">
        <div class="sub-tabs" role="tablist">
          <button type="button" class="sub-tab active" data-tab="status" aria-selected="true" role="tab">${t('subscription.subscriptionStatusTab')}</button>
          <button type="button" class="sub-tab" data-tab="topup" aria-selected="false" role="tab">${t('subscription.topUpTab')}</button>
        </div>
        <div class="sub-tabpanel" data-tabpanel="status" role="tabpanel">
          <div class="subscription-hero">
            <div class="hero-text">
              <div class="hero-label">${t('subscription.currentStatus')}</div>
              <div id="subscriptionStatusText" class="sub-status">${t('subscription.querying')}</div>
              <div class="sub-meta" id="subscriptionMeta"></div>
            </div>
          </div>
          <div class="sub-table-block">
            <div class="sub-table-head">
              <div class="sub-table-title">${t('subscription.activationRecords')}</div>
              <button type="button" class="ghost-btn" id="subscriptionRefreshBtn"><i class='bx bx-sync'></i> ${t('subscription.refresh')}</button>
            </div>
            <div class="sub-table" id="subscriptionCombinedTable"></div>
          </div>
        </div>
        <div class="sub-tabpanel" data-tabpanel="topup" role="tabpanel" hidden>
          <div class="sub-steps" id="subscriptionWizardSteps">
            <div class="sub-step" data-step="1"><span class="step-number">1</span><small>${t('subscription.selectChannel')}</small></div>
            <div class="sub-step" data-step="2"><span class="step-number">2</span><small>${t('subscription.scanUpload')}</small></div>
            <div class="sub-step" data-step="3"><span class="step-number">3</span><small>${t('subscription.result')}</small></div>
          </div>
          <div id="subscriptionWizardContent" class="sub-wizard-content"></div>
        </div>
      </div>
    `;
    modal.__subscriptionCleanup = () => { stopCountdown(); stopScanner({ destroy: true }); };
    openModal();
    const wizard = { step: 1, channel: null, result: null, busy: false };
    const tabButtons = Array.from(body.querySelectorAll('.sub-tab'));
    const tabPanels = Array.from(body.querySelectorAll('.sub-tabpanel'));
    const wizardContent = document.getElementById('subscriptionWizardContent');

    function switchTab(target) {
      tabButtons.forEach((btn) => {
        const active = btn.dataset.tab === target;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      tabPanels.forEach((panel) => { panel.hidden = panel.dataset.tabpanel !== target; });
      if (target !== 'topup') stopScanner({ destroy: true });
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
        ?? sessionStore?.profileState?.createdAt ?? sessionStore?.profileState?.created_at
        ?? sessionStore?.profileState?.created ?? 0);
      const baseRows = [];
      if (Number.isFinite(activationTs) && activationTs > 0) {
        baseRows.push({ usedAt: activationTs, issuedAt: activationTs, type: 'account', status: 'active', channel: t('subscription.accountCreation'), tokenId: '—', extendDays: 0 });
      }
      const sorted = [...baseRows, ...(Array.isArray(logs) ? logs : [])].sort((a, b) => {
        return (Number(b.usedAt || b.issuedAt || 0)) - (Number(a.usedAt || a.issuedAt || 0));
      });
      if (!sorted.length) { table.innerHTML = `<div class="sub-empty">${t('subscription.noRecords')}</div>`; return; }
      table.innerHTML = sorted.map((log) => {
        const statusLabel = (() => {
          if (log.status === 'used' || log.status === 'active') return t('subscription.statusUsed');
          if (log.status === 'invalid') return t('subscription.statusInvalid');
          if (log.status === 'expired') return t('subscription.statusExpired');
          return log.status || t('subscription.statusUnknown');
        })();
        const actionLabel = log.type === 'account' ? t('subscription.activation')
          : (log.type === 'activate' ? t('subscription.activation') : (log.extendDays ? t('subscription.extensionDays', { days: log.extendDays }) : ''));
        const channel = log.channel || (log.type === 'account' ? t('subscription.accountCreation') : t('subscription.qrVoucher'));
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
      stopCountdown();
      const statusText = document.getElementById('subscriptionStatusText');
      const meta = document.getElementById('subscriptionMeta');
      if (statusText) {
        const { expired, text } = computeCountdown(current.expiresAt || 0);
        statusText.textContent = current.found ? text : t('subscription.notTopUpYet');
        statusText.className = expired ? 'sub-status error' : 'sub-status ok';
      }
      if (meta) meta.textContent = current.found ? t('subscription.statusAutoSync') : t('subscription.noSubscriptionRecord');
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
                <div class="channel-title">${t('subscription.qrTopUp')}</div>
                <div class="channel-sub">${t('subscription.qrTopUpDesc')}</div>
              </div>
            </button>
            <div class="channel-card disabled" data-channel="ecpay">
              <div class="channel-icon"><i class='bx bx-credit-card'></i></div>
              <div class="channel-body">
                <div class="channel-title">${t('subscription.ecpayTitle')}</div>
                <div class="channel-sub">${t('subscription.ecpayDesc')}</div>
              </div>
              <span class="channel-badge">${t('subscription.comingSoon')}</span>
            </div>
          </div>
        `;
        wizardContent.querySelector('[data-channel="qr"]')?.addEventListener('click', () => {
          wizard.channel = 'qr'; wizard.step = 2; wizard.result = null; renderWizard();
        });
        wizardContent.querySelector('[data-channel="ecpay"]')?.addEventListener('click', () => {
          showToast?.(t('subscription.ecpayComingSoon'), { variant: 'info' });
        });
        stopScanner({ destroy: true });
        return;
      }
      if (wizard.step === 2) {
        wizardContent.innerHTML = `
          <div class="scan-pane">
            <div class="scan-video-wrap">
              <video id="subscriptionScanVideo" class="scan-video" muted playsinline></video>
              <div class="scan-overlay">${t('subscription.centerQrVoucher')}</div>
            </div>
            <div class="scan-actions">
              <input id="subscriptionFileInput" type="file" accept="image/*" style="display:none" />
              <button id="subscriptionUploadBtn" type="button" class="wide-btn" ${wizard.busy ? 'disabled' : ''}>
                <i class='bx bx-upload'></i> ${t('subscription.uploadQrImage')}
              </button>
              <div id="subscriptionScanStatus" class="sub-meta">${t('subscription.startingCamera')}</div>
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
          stopScanner({ destroy: true });
          uploadBtn.disabled = true;
          if (scanStatus) scanStatus.textContent = t('subscription.uploadAndParsing');
          const tokenRes = await handleFile([file], {
            onError: (err) => { wizard.result = { ok: false, message: t('subscription.parseFailed', { error: err?.message || err }) }; wizard.step = 3; renderWizard(); }
          });
          wizard.busy = false;
          uploadBtn.disabled = false;
          if (tokenRes?.ok) {
            wizard.step = 3; wizard.result = { ok: true, expiresAt: sessionStore.subscriptionState.expiresAt };
            renderWizard(); renderStatusTab();
          } else if (!wizard.result) {
            wizard.step = 3; wizard.result = { ok: false, message: tokenRes?.error?.message || t('subscription.topUpFailed') };
            renderWizard();
          }
        });
        const scanVideo = document.getElementById('subscriptionScanVideo');
        if (scanStatus) scanStatus.textContent = t('subscription.startingCamera');
        if (scanVideo) {
          QrScanner.WORKER_PATH = '/app/lib/vendor/qr-scanner-worker.min.js';
          stopScanner({ destroy: true });
          try {
            scanner = new QrScanner(scanVideo, async (res) => {
              const text = typeof res === 'string' ? res : res?.data || '';
              if (!text || wizard.busy) return;
              wizard.busy = true;
              if (scanStatus) scanStatus.textContent = t('subscription.voucherDetected');
              stopScanner();
              const result = await handleRedeem(text);
              wizard.busy = false;
              wizard.result = result?.ok
                ? { ok: true, expiresAt: sessionStore.subscriptionState.expiresAt }
                : { ok: false, message: result?.error?.message || t('subscription.topUpFailedTitle') };
              wizard.step = 3;
              renderWizard();
              if (result?.ok) renderStatusTab();
            });
            scanner.start().then(() => {
              scannerActive = true;
              if (scanStatus) scanStatus.textContent = t('subscription.pointCameraAtQR');
            }).catch((err) => { if (scanStatus) scanStatus.textContent = `相機無法啟動：${err?.message || err}`; });
          } catch (err) { if (scanStatus) scanStatus.textContent = `相機無法啟動：${err?.message || err}`; }
        }
        return;
      }
      wizardContent.innerHTML = `
        <div class="result-card ${wizard.result?.ok ? 'success' : 'error'}">
          <div class="result-icon">${wizard.result?.ok ? '✅' : '⚠️'}</div>
          <div class="result-title">${wizard.result?.ok ? t('subscription.topUpComplete') : t('subscription.topUpFailedTitle')}</div>
          <div class="result-meta">
            ${wizard.result?.ok
          ? `最新到期：${wizard.result?.expiresAt ? fmt(wizard.result.expiresAt) : '已更新'}`
          : (wizard.result?.message || t('subscription.checkVoucherValidity'))}
          </div>
          <div class="result-actions">
            <button type="button" class="secondary" id="subscriptionWizardRetry">再儲值一次</button>
            <button type="button" class="primary" id="subscriptionWizardViewStatus">查看訂閱狀態</button>
          </div>
        </div>
      `;
      document.getElementById('subscriptionWizardRetry')?.addEventListener('click', () => {
        wizard.step = 1; wizard.result = null; wizard.channel = null; stopScanner({ destroy: true }); renderWizard();
      });
      document.getElementById('subscriptionWizardViewStatus')?.addEventListener('click', () => { switchTab('status'); renderStatusTab(); });
      stopScanner({ destroy: true });
    }

    tabButtons.forEach((btn) => { btn.addEventListener('click', () => switchTab(btn.dataset.tab)); });
    document.getElementById('subscriptionRefreshBtn')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true; btn.classList.add('loading');
      await refreshStatus(); renderStatusTab();
      btn.disabled = false; btn.classList.remove('loading');
    });
    renderWizard();
    refreshStatus({ silent: true }).then(() => renderStatusTab());
  }

  return {
    updateBadge,
    refreshStatus,
    computeCountdown,
    showGateModal,
    open,
    stopScanner,
    stopCountdown
  };
}
