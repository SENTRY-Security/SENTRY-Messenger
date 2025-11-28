// /app/ui/version-info.js
// Small helper to attach a floating version info button & popup.

const STATUS_ENDPOINT = '/status';
const HEALTH_ENDPOINT = '/api/health';
let cachedInfo = null;
let pendingFetch = null;
let cachedHealth = null;
let pendingHealth = null;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const tier = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** tier);
  return `${value.toFixed(tier === 0 ? 0 : 1)} ${units[tier]}`;
}

function collectStorageStats() {
  if (typeof window === 'undefined') return [];
  const encoder = new TextEncoder();
  const results = [];
  const addStats = (storage, label) => {
    if (!storage) return;
    try {
      const length = storage.length;
      let totalBytes = 0;
      for (let i = 0; i < length; i += 1) {
        const key = storage.key(i);
        if (key == null) continue;
        const value = storage.getItem(key);
        totalBytes += encoder.encode(String(key)).length;
        if (value != null) {
          totalBytes += encoder.encode(String(value)).length;
        }
      }
      results.push({
        label,
        keyCount: length,
        totalBytes
      });
    } catch (err) {
      results.push({
        label,
        keyCount: 0,
        totalBytes: 0,
        error: err?.message || String(err)
      });
    }
  };

  addStats(window.localStorage, 'localStorage');
  addStats(window.sessionStorage, 'sessionStorage');

  return results;
}

function getAppVersion() {
  if (typeof window !== 'undefined') {
    return window.APP_VERSION || 'unknown';
  }
  return 'unknown';
}

function getAppBuildTime() {
  if (typeof window !== 'undefined' && window.APP_BUILD_AT) return window.APP_BUILD_AT;
  try { return new Date(document.lastModified).toISOString(); } catch { return new Date().toISOString(); }
}

function summarizeStatus(info) {
  if (!info) return '－';
  if (info.error) return `錯誤：${info.error}`;
  if (info.status && info.status !== 200 && info.status !== 'ok') {
    return `HTTP ${info.status}`;
  }
  return '正常';
}

function summarizeHealth(health) {
  if (!health) return '－';
  if (health.error) return `錯誤：${health.error}`;
  if (health.ok === false) {
    return health.message ? `失敗：${health.message}` : '失敗';
  }
  return '正常';
}

function formatInfo(info) {
  const now = new Date();
  const fetchedAt = info?.fetchedAt ? new Date(info.fetchedAt) : now;
  const hasWindow = typeof window !== 'undefined';
  return {
    version: info?.version || info?.build || 'unknown',
    statusSummary: summarizeStatus(info),
    healthSummary: summarizeHealth(info?.apiHealth),
    appVersion: getAppVersion(),
    appBuildAt: getAppBuildTime(),
    fetchedAt: fetchedAt.toLocaleString('zh-TW', { hour12: false }),
    clientLoadedAt: now.toLocaleString('zh-TW', { hour12: false })
  };
}

async function fetchStatus() {
  if (cachedInfo) return cachedInfo;
  if (pendingFetch) return pendingFetch;
  pendingFetch = fetch(STATUS_ENDPOINT, { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      data.fetchedAt = new Date().toISOString();
      cachedInfo = data;
      return cachedInfo;
    })
    .catch((err) => {
      cachedInfo = {
        error: err?.message || 'Unknown error',
        fetchedAt: new Date().toISOString()
      };
      return cachedInfo;
    })
    .finally(() => {
      pendingFetch = null;
    });
  return pendingFetch;
}

async function fetchApiHealth() {
  if (cachedHealth) return cachedHealth;
  if (pendingHealth) return pendingHealth;
  pendingHealth = fetch(HEALTH_ENDPOINT, { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) {
        cachedHealth = { error: `HTTP ${res.status}` };
        return cachedHealth;
      }
      const data = await res.json().catch(() => ({}));
      cachedHealth = data;
      return cachedHealth;
    })
    .catch((err) => {
      cachedHealth = { error: err?.message || 'Unknown error' };
      return cachedHealth;
    })
    .finally(() => {
      pendingHealth = null;
    });
  return pendingHealth;
}

function renderPopup(popup, info) {
  const details = formatInfo(info);
  const storageStats = collectStorageStats();
  const totalBytes = storageStats.reduce((sum, item) => sum + item.totalBytes, 0);
  const storageRows = storageStats.map((item) => {
    const detail = item.error
      ? `<span style="color:#f87171;">錯誤：${item.error}</span>`
      : `<span>${item.keyCount} keys / ${formatBytes(item.totalBytes)}</span>`;
    return `
      <div class="version-storage-row">
        <span>${item.label}</span>
        ${detail}
      </div>`;
  }).join('') || '<div class="version-storage-row">無可用資料</div>';

  popup.innerHTML = `
    <strong>版本資訊</strong>
    <div>前端版本：${details.appVersion}</div>
    <div>前端建置：${details.appBuildAt}</div>
    <div>前端載入：${details.clientLoadedAt}</div>
    <div>版本：${details.version}</div>
    <div>服務狀態：${details.statusSummary}</div>
    <div>API 健康：${details.healthSummary}</div>
    <div style="margin-top:10px;font-weight:600;">前端儲存資訊</div>
    <div class="version-storage-list">
      ${storageRows}
    </div>
    <div class="version-storage-total">總計：${formatBytes(totalBytes)}</div>
    <div style="margin-top:6px; font-size:11px;">更新時間：${details.fetchedAt}</div>
  `;
  popup.setAttribute('aria-hidden', 'false');
  popup.dataset.open = 'true';
}

function renderError(popup, message) {
  popup.innerHTML = `
    <strong>版本資訊</strong>
    <div style="color:#fecaca;">載入失敗：${message}</div>
  `;
  popup.setAttribute('aria-hidden', 'false');
  popup.dataset.open = 'true';
}

function closePopup(popup) {
  popup.dataset.open = 'false';
  popup.setAttribute('aria-hidden', 'true');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderModalContent(container, info) {
  const details = formatInfo(info);
  const storageStats = collectStorageStats();
  const totalBytes = storageStats.reduce((sum, item) => sum + item.totalBytes, 0);
  const rows = [
    ['前端版本', details.appVersion],
    ['前端建置', details.appBuildAt],
    ['前端載入', details.clientLoadedAt],
    ['版本', details.version],
    ['服務狀態', details.statusSummary],
    ['API 健康', details.healthSummary],
    ['更新時間', details.fetchedAt]
  ];
  const storageRows = storageStats.map((item) => {
    const detail = item.error
      ? `<span class="version-value error">錯誤：${escapeHtml(item.error)}</span>`
      : `<span class="version-value">${item.keyCount} keys / ${formatBytes(item.totalBytes)}</span>`;
    return `<div class="version-row"><span class="version-label">${escapeHtml(item.label)}</span>${detail}</div>`;
  }).join('') || '<div class="version-row"><span class="version-label">儲存</span><span class="version-value">無可用資料</span></div>';

  container.innerHTML = `
    <div class="version-modal">
      ${rows.map(([label, value]) => `<div class="version-row"><span class="version-label">${escapeHtml(label)}</span><span class="version-value">${escapeHtml(value)}</span></div>`).join('')}
      <div class="version-section-title">前端儲存資訊</div>
      <div class="version-storage-list">
        ${storageRows}
        <div class="version-row version-storage-total"><span class="version-label">總計</span><span class="version-value">${formatBytes(totalBytes)}</span></div>
      </div>
    </div>`;
}

export async function showVersionModal({ openModal, closeModal } = {}) {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');
  if (!modal || !body) return;
  modal.classList.remove(
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
    'pdf-modal'
  );
  if (title) title.textContent = '版本資訊';
  body.innerHTML = `<div class="version-modal loading"><div class="loading-spinner"></div><div class="version-loading-text">載入版本資訊…</div></div>`;
  openModal?.();
  try {
    const [statusInfo, healthInfo] = await Promise.all([fetchStatus(), fetchApiHealth()]);
    if (statusInfo) statusInfo.apiHealth = healthInfo;
    const info = statusInfo || { apiHealth: healthInfo };
    if (info?.error) {
      renderModalContent(body, info);
      body.querySelector('.version-value')?.classList?.add('error');
    } else {
      renderModalContent(body, info);
    }
  } catch (err) {
    body.innerHTML = `<div class="version-modal"><div class="version-row"><span class="version-label">載入失敗</span><span class="version-value error">${escapeHtml(err?.message || '未知錯誤')}</span></div></div>`;
  }
  const modalClose = document.getElementById('modalClose');
  const modalCloseArea = document.getElementById('modalCloseArea');
  modalClose?.addEventListener('click', () => closeModal?.(), { once: true });
  modalCloseArea?.addEventListener('click', () => closeModal?.(), { once: true });
}

export function initVersionInfoButton({ buttonId, popupId, openModal, closeModal }) {
  const button = document.getElementById(buttonId);
  const popup = popupId ? document.getElementById(popupId) : null;
  if (!button) return;
  const useModal = typeof openModal === 'function' && typeof closeModal === 'function';

  if (useModal) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showVersionModal({ openModal, closeModal });
    });
    return;
  }

  if (!popup) return;

  const togglePopup = async () => {
    const isOpen = popup.dataset.open === 'true';
    if (isOpen) {
      closePopup(popup);
      return;
    }
    popup.innerHTML = `<strong>版本資訊</strong><div>載入中…</div>`;
    popup.setAttribute('aria-hidden', 'false');
    popup.dataset.open = 'true';
    try {
      const [statusInfo, healthInfo] = await Promise.all([fetchStatus(), fetchApiHealth()]);
      if (statusInfo) statusInfo.apiHealth = healthInfo;
      const info = statusInfo || { apiHealth: healthInfo };
      if (info?.error) {
        renderError(popup, info.error);
      } else {
        renderPopup(popup, info);
      }
    } catch (err) {
      renderError(popup, err?.message || '未知錯誤');
    }
  };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePopup();
  });

  popup.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  document.addEventListener('click', () => {
    if (popup.dataset.open === 'true') {
      closePopup(popup);
    }
  });
}
