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

export function initVersionInfoButton({ buttonId, popupId }) {
  const button = document.getElementById(buttonId);
  const popup = document.getElementById(popupId);
  if (!button || !popup) return;

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
