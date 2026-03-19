// Push notification management modal
// Opens from settings; manages push subscription sessions per device.

import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';
import {
  isPushSupported, isPWAMode, subscribePush, unsubscribePush,
  unsubscribeByEndpoint, listPushDevices, getPushSubscription
} from '../../../features/push-subscription.js';
import { ensureDeviceId } from '../../../core/store.js';

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function createPushModal({ deps }) {
  const { log, showToast, openModal, closeModal, resetModalVariants, showAlertModal,
    getAccountDigest, getEffectiveSettings, persistSettingsPatch } = deps;

  // Shared device list renderer
  async function renderDeviceList(container, onStatusChange) {
    if (!container) return;
    try {
      const devices = await listPushDevices();
      if (!devices.length) {
        container.innerHTML = `<p style="font-size:13px;color:var(--muted);">${escapeHtml(t('push.noDevices'))}</p>`;
        return;
      }
      container.innerHTML = devices.map(d => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);">
          <div style="font-size:13px;flex:1;">
            <span>${d.isThisDevice ? '📱 ' : '🔔 '}${escapeHtml(d.displayName)}</span>
            ${d.isThisDevice ? `<span style="color:var(--accent);font-size:11px;margin-left:4px;">(${escapeHtml(t('push.thisDevice'))})</span>` : ''}
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">${d.createdAt ? new Date(Number(d.createdAt) * 1000).toLocaleDateString() : ''}</div>
          </div>
          <button type="button" class="push-revoke-btn" data-endpoint="${escapeHtml(d.endpoint)}" style="padding:4px 10px;border-radius:6px;border:1px solid rgba(239,68,68,0.3);background:transparent;color:#ef4444;font-size:12px;cursor:pointer;">${escapeHtml(t('push.revoke'))}</button>
        </div>
      `).join('');

      container.querySelectorAll('.push-revoke-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const endpoint = btn.dataset.endpoint;
          if (!confirm(t('push.revokeConfirm'))) return;
          btn.disabled = true;
          btn.textContent = t('common.loading');
          try {
            await unsubscribeByEndpoint(endpoint);
            showToast(t('push.revokedToast'));
            if (onStatusChange) {
              const sub = await getPushSubscription().catch(() => null);
              onStatusChange(!!sub);
            }
            renderDeviceList(container, onStatusChange);
          } catch (err) {
            log({ pushRevokeError: err?.message || err });
            showAlertModal({ title: t('errors.operationFailed'), message: err?.message || '' });
            btn.disabled = false;
            btn.textContent = t('push.revoke');
          }
        }, { once: true });
      });
    } catch (err) {
      container.innerHTML = `<p style="font-size:13px;color:var(--muted);">${escapeHtml(t('push.loadDevicesFailed'))}</p>`;
      log({ pushDeviceListError: err?.message || err });
    }
  }

  async function open() {
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body) return;

    resetModalVariants(modalElement);
    modalElement.classList.add('push-modal');
    if (title) title.textContent = t('push.settingsTitle');

    const supported = isPushSupported();
    const ios = isIOS();
    const pwa = isPWAMode();
    // iOS Safari browser mode: API exists but subscribe fails — must use PWA
    const iosNeedsPWA = ios && supported && !pwa;

    // Check current subscription state
    let currentSub = null;
    try { currentSub = await getPushSubscription(); } catch {}
    const isActive = !!currentSub;

    // Determine which view to show
    let contentHTML;

    // iOS without Push API → still show PIN enrollment flow (they can use PWA)
    const iosNoPush = ios && !supported;

    if (!supported && !ios) {
      // Non-iOS browser doesn't support push at all
      contentHTML = `
        <div style="padding:16px 0;text-align:center;color:var(--muted);font-size:14px;">
          ${escapeHtml(t('push.statusUnsupported'))}<br>
          <span style="font-size:12px;">${escapeHtml(t('push.statusUnsupportedDetail'))}</span>
        </div>`;
    } else if (iosNeedsPWA || iosNoPush) {
      // iOS browser mode — step-by-step guide with images
      const currentSettings = getEffectiveSettings ? getEffectiveSettings() : {};
      const autoLogoutOn = !!currentSettings.autoLogoutOnBackground;
      const stepStyle = 'display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--line);';
      const numStyle = 'flex-shrink:0;width:24px;height:24px;border-radius:50%;background:rgba(56,189,248,0.15);color:#38bdf8;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:2px;';
      const imgStyle = 'width:100%;border-radius:8px;margin-top:8px;border:1px solid rgba(148,163,184,0.12);';
      contentHTML = `
        <div style="padding:8px 0;">
          <div style="${stepStyle}">
            <span style="${numStyle}">1</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;">${escapeHtml(t('push.iosStep1'))}</div>
              <img src="/assets/images/step1.jpg" alt="Step 1" style="${imgStyle}" />
            </div>
          </div>
          <div style="${stepStyle}">
            <span style="${numStyle}">2</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;">${escapeHtml(t('push.iosStep2'))}</div>
              <img src="/assets/images/step2.jpg" alt="Step 2" style="${imgStyle}" />
            </div>
          </div>
          <div style="${stepStyle}">
            <span style="${numStyle}">3</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;">${escapeHtml(t('push.iosStep3'))}</div>
              <img src="/assets/images/step3.jpg" alt="Step 3" style="${imgStyle}" />
            </div>
          </div>
          <div style="${stepStyle}border-bottom:none;">
            <span style="${numStyle}">4</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;margin-bottom:10px;">${escapeHtml(t('push.iosStep4'))}</div>
              <button type="button" id="pushGeneratePin" style="width:100%;padding:10px 16px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer;background:rgba(56,189,248,0.15);color:#38bdf8;">
                ${escapeHtml(t('push.generatePin'))}
              </button>
              <div id="pushPinDisplay" style="display:none;margin-top:12px;">
                <div style="text-align:center;">
                  <div id="pushPinCode" style="font-size:32px;font-weight:700;letter-spacing:8px;font-family:monospace;color:var(--accent);padding:12px;background:rgba(56,189,248,0.08);border-radius:10px;"></div>
                  <div style="font-size:11px;color:var(--muted);margin-top:6px;">${escapeHtml(t('push.pinExpiry'))}</div>
                </div>
                <div id="pushAutoLogoutToggle" style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding:12px;background:rgba(148,163,184,0.08);border-radius:10px;">
                  <div style="flex:1;">
                    <div style="font-size:13px;font-weight:600;">${escapeHtml(t('push.keepSessionAlive'))}</div>
                    <div style="font-size:11px;color:var(--muted);margin-top:2px;">${escapeHtml(t('push.keepSessionAliveDesc'))}</div>
                  </div>
                  <label class="settings-switch" style="margin-left:10px;">
                    <input type="checkbox" id="pushKeepAliveToggle" ${autoLogoutOn ? '' : 'checked'} />
                    <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div style="padding:14px 0;border-top:1px solid var(--line);">
          <div style="font-size:13px;font-weight:700;margin-bottom:10px;">${escapeHtml(t('push.deviceListTitle'))}</div>
          <div id="pushDeviceList">
            <p style="font-size:13px;color:var(--muted);">${escapeHtml(t('common.loading'))}</p>
          </div>
        </div>`;
    } else {
      // Full push support
      contentHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--line);">
          <span id="pushStatusDot" style="width:10px;height:10px;border-radius:50%;flex-shrink:0;${isActive ? 'background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,0.4);' : 'background:var(--muted);'}"></span>
          <div style="flex:1;">
            <div id="pushStatusLabel" style="font-size:14px;font-weight:600;">${escapeHtml(isActive ? t('push.statusActive') : t('push.statusInactive'))}</div>
            <div id="pushStatusDetail" style="font-size:12px;color:var(--muted);margin-top:2px;">${escapeHtml(isActive ? t('push.statusActiveDetail') : t('push.statusInactiveDetail'))}</div>
          </div>
        </div>
        <div style="padding:14px 0;border-bottom:1px solid var(--line);">
          <button type="button" id="pushActionBtn" style="width:100%;padding:10px 16px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer;${isActive ? 'background:rgba(239,68,68,0.15);color:#ef4444;' : 'background:rgba(56,189,248,0.15);color:#38bdf8;'}">
            ${escapeHtml(isActive ? t('push.disableBtn') : t('push.explainTitle'))}
          </button>
        </div>
        <div style="padding:14px 0;">
          <div style="font-size:13px;font-weight:700;margin-bottom:10px;">${escapeHtml(t('push.deviceListTitle'))}</div>
          <div id="pushDeviceList">
            <p style="font-size:13px;color:var(--muted);">${escapeHtml(t('common.loading'))}</p>
          </div>
        </div>
        <div style="padding:10px 0;border-top:1px solid var(--line);">
          <div style="font-size:12px;color:var(--muted);line-height:1.6;">
            ${escapeHtml(t('push.infoBasic1'))}<br>
            ${escapeHtml(t('push.infoBasic2'))}<br>
            ${escapeHtml(t('push.infoBasic3'))}
          </div>
        </div>`;
    }

    body.innerHTML = `
      <div class="push-modal-content" style="padding:4px 0;">
        ${contentHTML}
        <div style="padding:12px 0 4px;">
          <button type="button" class="secondary" id="pushCloseBtn" style="width:100%;">${escapeHtml(t('common.close'))}</button>
        </div>
      </div>`;

    openModal();

    body.querySelector('#pushCloseBtn')?.addEventListener('click', () => closeModal(), { once: true });

    if (!supported && !iosNoPush) return;

    const deviceList = body.querySelector('#pushDeviceList');

    // iOS browser mode: generate PIN + manage existing devices
    if (iosNeedsPWA || iosNoPush) {
      renderDeviceList(deviceList, null);

      const generatePinBtn = body.querySelector('#pushGeneratePin');
      const pinDisplay = body.querySelector('#pushPinDisplay');
      const pinCode = body.querySelector('#pushPinCode');

      generatePinBtn?.addEventListener('click', async () => {
        generatePinBtn.disabled = true;
        generatePinBtn.textContent = t('common.loading');
        try {
          const digest = getAccountDigest();
          if (!digest) throw new Error('Account not ready');
          const res = await fetch('/d1/push/pin/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accountDigest: digest, deviceId: (() => { try { return ensureDeviceId(); } catch { return null; } })() })
          });
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          if (!res.ok || !data.pin) throw new Error(data.error || data.message || 'Failed');
          if (pinCode) pinCode.textContent = data.pin;
          if (pinDisplay) pinDisplay.style.display = 'block';
          generatePinBtn.textContent = t('push.regeneratePin');
          generatePinBtn.disabled = false;
        } catch (err) {
          log({ pushPinGenerateError: err?.message || err });
          showAlertModal({ title: t('errors.operationFailed'), message: err?.message || '' });
          generatePinBtn.textContent = t('push.generatePin');
          generatePinBtn.disabled = false;
        }
      });

      // Keep session alive toggle (inverted: checked = keep alive = autoLogoutOnBackground OFF)
      const keepAliveToggle = body.querySelector('#pushKeepAliveToggle');
      if (keepAliveToggle && persistSettingsPatch) {
        keepAliveToggle.addEventListener('change', async () => {
          const wantKeepAlive = keepAliveToggle.checked;
          keepAliveToggle.disabled = true;
          try {
            await persistSettingsPatch({ autoLogoutOnBackground: !wantKeepAlive });
          } catch (err) {
            log({ pushKeepAliveToggleError: err?.message || err });
            keepAliveToggle.checked = !wantKeepAlive; // revert
          } finally {
            keepAliveToggle.disabled = false;
          }
        });
      }

      // Listen for push-device-paired WS event: close modal + refresh device list
      const onPaired = () => {
        document.removeEventListener('sentry:push-device-paired', onPaired);
        showToast(t('push.devicePaired'));
        closeModal();
      };
      document.addEventListener('sentry:push-device-paired', onPaired);
      // Cleanup listener when modal is manually closed
      body.querySelector('#pushCloseBtn')?.addEventListener('click', () => {
        document.removeEventListener('sentry:push-device-paired', onPaired);
      }, { once: true });

      return;
    }

    // Full mode — status + action + device list
    const statusDot = body.querySelector('#pushStatusDot');
    const statusLabel = body.querySelector('#pushStatusLabel');
    const statusDetail = body.querySelector('#pushStatusDetail');
    const actionBtn = body.querySelector('#pushActionBtn');

    function updateStatus(active) {
      if (statusDot) statusDot.style.cssText = `width:10px;height:10px;border-radius:50%;flex-shrink:0;${active ? 'background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,0.4);' : 'background:var(--muted);'}`;
      if (statusLabel) statusLabel.textContent = active ? t('push.statusActive') : t('push.statusInactive');
      if (statusDetail) statusDetail.textContent = active ? t('push.statusActiveDetail') : t('push.statusInactiveDetail');
      if (actionBtn) {
        actionBtn.textContent = active ? t('push.disableBtn') : t('push.explainTitle');
        actionBtn.style.cssText = `width:100%;padding:10px 16px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer;${active ? 'background:rgba(239,68,68,0.15);color:#ef4444;' : 'background:rgba(56,189,248,0.15);color:#38bdf8;'}`;
      }
    }

    actionBtn?.addEventListener('click', async () => {
      const sub = await getPushSubscription().catch(() => null);
      actionBtn.disabled = true;

      if (sub) {
        try {
          await unsubscribePush();
          showToast(t('push.disabledToast'));
          updateStatus(false);
          renderDeviceList(deviceList, updateStatus);
        } catch (err) {
          log({ pushUnsubscribeError: err?.message || err });
        }
      } else {
        const confirmed = await new Promise((resolve) => {
          showAlertModal({
            title: t('push.explainTitle'),
            message: t('push.explainBody'),
            confirmText: t('common.confirm'),
            cancelText: t('common.cancel'),
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false)
          });
        });

        if (!confirmed) {
          actionBtn.disabled = false;
          return;
        }

        try {
          await subscribePush();
          showToast(t('push.enabledToast'));
          open(); // reopen to refresh
          return;
        } catch (err) {
          log({ pushSubscribeError: err?.message || err });
          const msg = err?.code === 'PERMISSION_DENIED'
            ? t('push.permissionDenied')
            : (err?.message || t('errors.saveSettingsFailed'));
          showAlertModal({ title: t('errors.operationFailed'), message: msg });
        }
      }
      actionBtn.disabled = false;
    });

    renderDeviceList(deviceList, updateStatus);
  }

  return { open };
}
