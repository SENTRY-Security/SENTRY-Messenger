// /app/ui/version-info.js
// Small helper to attach a floating version info button & popup.

const STATUS_ENDPOINT = '/status';
let cachedInfo = null;
let pendingFetch = null;

function formatInfo(info) {
  const now = new Date();
  const fetchedAt = info?.fetchedAt ? new Date(info.fetchedAt) : now;
  return {
    service: info?.name || info?.service || 'SENTRY API',
    version: info?.version || info?.build || 'unknown',
    environment: info?.env || info?.environment || '-',
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

function renderPopup(popup, info) {
  const details = formatInfo(info);
  popup.innerHTML = `
    <strong>版本資訊</strong>
    <div>前端載入：${details.clientLoadedAt}</div>
    <div>服務：${details.service}</div>
    <div>版本：${details.version}</div>
    <div>環境：${details.environment}</div>
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
      const info = await fetchStatus();
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
