// Push notification management modal
// Opens from settings; manages push subscription sessions per device.

import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';
import {
  isPushSupported, subscribePush, unsubscribePush,
  unsubscribeByEndpoint, listPushDevices, getPushSubscription
} from '../../../features/push-subscription.js';

export function createPushModal({ deps }) {
  const { log, showToast, openModal, closeModal, resetModalVariants, showAlertModal, getAccountDigest } = deps;

  async function open() {
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body) return;

    resetModalVariants(modalElement);
    modalElement.classList.add('push-modal');
    if (title) title.textContent = t('push.settingsTitle');

    const supported = isPushSupported();
    const accountDigest = getAccountDigest();

    // Check current subscription state
    let currentSub = null;
    try { currentSub = await getPushSubscription(); } catch {}

    const isActive = !!currentSub;

    body.innerHTML = `
      <div class="push-modal-content" style="padding:4px 0;">
        ${!supported ? `
          <div style="padding:16px 0;text-align:center;color:var(--muted);font-size:14px;">
            ${escapeHtml(t('push.statusUnsupported'))}<br>
            <span style="font-size:12px;">${escapeHtml(t('push.statusUnsupportedDetail'))}</span>
          </div>
        ` : `
          <!-- Status -->
          <div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--line);">
            <span id="pushStatusDot" style="width:10px;height:10px;border-radius:50%;flex-shrink:0;${isActive ? 'background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,0.4);' : 'background:var(--muted);'}"></span>
            <div style="flex:1;">
              <div id="pushStatusLabel" style="font-size:14px;font-weight:600;">${escapeHtml(isActive ? t('push.statusActive') : t('push.statusInactive'))}</div>
              <div id="pushStatusDetail" style="font-size:12px;color:var(--muted);margin-top:2px;">${escapeHtml(isActive ? t('push.statusActiveDetail') : t('push.statusInactiveDetail'))}</div>
            </div>
          </div>

          <!-- Action button -->
          <div style="padding:14px 0;border-bottom:1px solid var(--line);">
            <button type="button" id="pushActionBtn" class="settings-link" style="width:100%;padding:10px 16px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer;${isActive ? 'background:rgba(239,68,68,0.15);color:#ef4444;' : 'background:rgba(56,189,248,0.15);color:#38bdf8;'}">
              ${escapeHtml(isActive ? t('push.disableBtn') : t('push.explainTitle'))}
            </button>
          </div>

          <!-- Device list section -->
          <div style="padding:14px 0;">
            <div style="font-size:13px;font-weight:700;margin-bottom:10px;">${escapeHtml(t('push.deviceListTitle'))}</div>
            <div id="pushDeviceList">
              <p style="font-size:13px;color:var(--muted);">${escapeHtml(t('common.loading'))}</p>
            </div>
          </div>

          <!-- Info -->
          <div style="padding:10px 0;border-top:1px solid var(--line);">
            <div style="font-size:12px;color:var(--muted);line-height:1.6;">
              ${escapeHtml(t('push.infoBasic1'))}<br>
              ${escapeHtml(t('push.infoBasic2'))}<br>
              ${escapeHtml(t('push.infoBasic3'))}
            </div>
          </div>
        `}

        <div style="padding:12px 0 4px;">
          <button type="button" class="secondary" id="pushCloseBtn" style="width:100%;">${escapeHtml(t('common.close'))}</button>
        </div>
      </div>`;

    openModal();

    // Close button
    body.querySelector('#pushCloseBtn')?.addEventListener('click', () => closeModal(), { once: true });

    if (!supported) return;

    const statusDot = body.querySelector('#pushStatusDot');
    const statusLabel = body.querySelector('#pushStatusLabel');
    const statusDetail = body.querySelector('#pushStatusDetail');
    const actionBtn = body.querySelector('#pushActionBtn');
    const deviceList = body.querySelector('#pushDeviceList');

    function updateStatus(active) {
      if (statusDot) statusDot.style.cssText = `width:10px;height:10px;border-radius:50%;flex-shrink:0;${active ? 'background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,0.4);' : 'background:var(--muted);'}`;
      if (statusLabel) statusLabel.textContent = active ? t('push.statusActive') : t('push.statusInactive');
      if (statusDetail) statusDetail.textContent = active ? t('push.statusActiveDetail') : t('push.statusInactiveDetail');
      if (actionBtn) {
        actionBtn.textContent = active ? t('push.disableBtn') : t('push.explainTitle');
        actionBtn.style.cssText = `width:100%;padding:10px 16px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer;${active ? 'background:rgba(239,68,68,0.15);color:#ef4444;' : 'background:rgba(56,189,248,0.15);color:#38bdf8;'}`;
      }
    }

    // Refresh device list
    async function refreshDevices() {
      if (!deviceList) return;
      try {
        const devices = await listPushDevices();
        if (!devices.length) {
          deviceList.innerHTML = `<p style="font-size:13px;color:var(--muted);">${escapeHtml(t('push.noDevices'))}</p>`;
          return;
        }
        deviceList.innerHTML = devices.map(d => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);">
            <div style="font-size:13px;flex:1;">
              <span>${d.isThisDevice ? '📱 ' : '🔔 '}${escapeHtml(d.displayName)}</span>
              ${d.isThisDevice ? `<span style="color:var(--accent);font-size:11px;margin-left:4px;">(${escapeHtml(t('push.thisDevice'))})</span>` : ''}
              <div style="font-size:11px;color:var(--muted);margin-top:2px;">${d.createdAt ? new Date(Number(d.createdAt) * 1000).toLocaleDateString() : ''}</div>
            </div>
            <button type="button" class="push-revoke-btn" data-endpoint="${escapeHtml(d.endpoint)}" style="padding:4px 10px;border-radius:6px;border:1px solid rgba(239,68,68,0.3);background:transparent;color:#ef4444;font-size:12px;cursor:pointer;">${escapeHtml(t('push.revoke'))}</button>
          </div>
        `).join('');

        deviceList.querySelectorAll('.push-revoke-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const endpoint = btn.dataset.endpoint;
            if (!confirm(t('push.revokeConfirm'))) return;
            btn.disabled = true;
            btn.textContent = t('common.loading');
            try {
              await unsubscribeByEndpoint(endpoint);
              showToast(t('push.revokedToast'));
              // Recheck status
              const sub = await getPushSubscription();
              updateStatus(!!sub);
              refreshDevices();
            } catch (err) {
              log({ pushRevokeError: err?.message || err });
              showAlertModal({ title: t('errors.operationFailed'), message: err?.message || '' });
              btn.disabled = false;
              btn.textContent = t('push.revoke');
            }
          }, { once: true });
        });
      } catch (err) {
        deviceList.innerHTML = `<p style="font-size:13px;color:var(--muted);">${escapeHtml(t('push.loadDevicesFailed'))}</p>`;
        log({ pushDeviceListError: err?.message || err });
      }
    }

    // Action button (enable/disable)
    actionBtn?.addEventListener('click', async () => {
      const sub = await getPushSubscription().catch(() => null);
      actionBtn.disabled = true;

      if (sub) {
        // Disable
        try {
          await unsubscribePush();
          showToast(t('push.disabledToast'));
          updateStatus(false);
          refreshDevices();
        } catch (err) {
          log({ pushUnsubscribeError: err?.message || err });
        }
      } else {
        // Enable — show explanation first
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
          // Reopen the modal to refresh everything
          open();
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

    // Load device list
    refreshDevices();
  }

  return { open };
}
