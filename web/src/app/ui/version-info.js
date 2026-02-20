// /app/ui/version-info.js
// Small helper to attach a floating version info button & popup.

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

  addStats(window.localStorage, '本機儲存');
  addStats(window.sessionStorage, '工作階段儲存');
  try {
    const indexedDBSize = window.indexedDB ? '支援 IndexedDB' : '不支援 IndexedDB';
    results.push({
      label: '資料庫',
      keyCount: 0,
      totalBytes: 0,
      note: indexedDBSize
    });
  } catch {
    results.push({
      label: '資料庫',
      keyCount: 0,
      totalBytes: 0,
      note: '不支援 IndexedDB'
    });
  }

  return results;
}

function collectStorageEntries(label) {
  if (typeof window === 'undefined') return { label, error: 'no-window' };
  const encoder = new TextEncoder();
  const isSession = label && (label.includes('工作階段') || label.includes('sessionStorage'));
  const storage = isSession ? window.sessionStorage : window.localStorage;
  if (!storage) return { label, error: 'storage-unavailable' };
  try {
    const entries = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key == null) continue;
      const value = storage.getItem(key);
      entries.push({
        key,
        value,
        sizeBytes: encoder.encode(String(key)).length + (value != null ? encoder.encode(String(value)).length : 0)
      });
    }
    return { label, entries };
  } catch (err) {
    return { label, error: err?.message || String(err) };
  }
}

function renderStorageDetailModal(detail) {
  const existing = document.getElementById('versionStorageDetail');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'versionStorageDetail';
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px'
  });
  const box = document.createElement('div');
  Object.assign(box.style, {
    background: '#0f172a',
    color: '#e2e8f0',
    borderRadius: '12px',
    width: 'min(90vw, 720px)',
    maxHeight: '80vh',
    overflow: 'hidden',
    boxShadow: '0 10px 40px rgba(0,0,0,0.35)',
    border: '1px solid rgba(255,255,255,0.08)'
  });
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.style.padding = '12px 16px';
  header.style.borderBottom = '1px solid rgba(255,255,255,0.08)';
  header.innerHTML = `<div style="font-weight:700;">${escapeHtml(detail.label || '儲存')}</div>`;
  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.gap = '8px';
  const clearBtn = document.createElement('button');
  clearBtn.textContent = '清除此儲存';
  Object.assign(clearBtn.style, {
    background: 'transparent',
    color: '#facc15',
    border: '1px solid rgba(250,204,21,0.4)',
    borderRadius: '8px',
    padding: '6px 10px',
    cursor: 'pointer'
  });
  clearBtn.addEventListener('click', () => {
    try {
      const isSession = (detail.label || '').toLowerCase().includes('session');
      const storage = isSession ? window.sessionStorage : window.localStorage;
      storage?.clear();
      // 清除後登出
      window.location.href = '/logout';
    } catch (err) {
      alert('清除失敗：' + (err?.message || err));
    }
  });
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '關閉';
  Object.assign(closeBtn.style, {
    background: 'transparent',
    color: '#e2e8f0',
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: '8px',
    padding: '6px 10px',
    cursor: 'pointer'
  });
  closeBtn.addEventListener('click', () => overlay.remove());
  btnRow.appendChild(clearBtn);
  btnRow.appendChild(closeBtn);
  header.appendChild(btnRow);
  const body = document.createElement('div');
  body.style.padding = '12px 16px';
  body.style.maxHeight = 'calc(80vh - 60px)';
  body.style.overflow = 'auto';
  if (detail.error) {
    body.innerHTML = `<div style="color:#f87171;">載入失敗：${escapeHtml(detail.error)}</div>`;
  } else if (!detail.entries || !detail.entries.length) {
    body.innerHTML = `<div style="color:#94a3b8;">無資料</div>`;
  } else {
    const total = detail.entries.reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
    const formatValue = (value) => {
      if (value == null) return '';
      let parsed = null;
      if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch {}
      }
      if (parsed && typeof parsed === 'object') {
        try {
          return JSON.stringify(parsed, null, 2);
        } catch {}
      }
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    };
    const list = detail.entries.map((entry, idx) => {
      const pretty = formatValue(entry.value);
      const display = typeof pretty === 'string' && pretty.length > 12000
        ? `${pretty.slice(0, 12000)}…`
        : pretty;
      return `
        <li class="storage-entry-row" style="list-style: none; margin: 0 0 10px 0;">
          <details style="border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; background: rgba(255,255,255,0.02);">
            <summary style="padding: 10px 12px; display:flex; justify-content:space-between; align-items:center; gap:8px; cursor:pointer; list-style:none;">
              <span class="storage-key" style="font-weight:700;word-break:break-all;">${escapeHtml(entry.key)}</span>
              <div style="display:flex; align-items:center; gap:8px; margin-left:auto;">
                <span class="storage-meta" style="color:#94a3b8;font-size:12px; white-space:nowrap;">${formatBytes(entry.sizeBytes || 0)}</span>
                <button type="button" class="storage-copy" data-idx="${idx}" aria-label="複製 ${escapeHtml(entry.key)} 的內容" style="border:1px solid rgba(148,163,184,0.4); background:rgba(255,255,255,0.06); color:#e2e8f0; border-radius:8px; padding:6px 8px; font-size:11px; cursor:pointer; display:flex; align-items:center; gap:4px;">
                  <i class='bx bx-copy' aria-hidden="true"></i>
                  <span class="sr-only">複製</span>
                </button>
              </div>
            </summary>
            <div style="padding: 0 12px 12px 12px;">
              <div style="max-height:320px; overflow:auto; border-radius:8px; background: rgba(255,255,255,0.04);">
                <pre class="storage-entry-value" style="margin:0; padding:10px; color:#e2e8f0; word-break:break-all; white-space:pre-wrap; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:13px;">${escapeHtml(display ?? '')}</pre>
              </div>
            </div>
          </details>
        </li>
      `;
    }).join('');
    body.innerHTML = `
      <div style="margin-bottom:8px;color:#cbd5e1;">共 ${detail.entries.length} 筆，約 ${formatBytes(total)}</div>
      <ul class="storage-entry-list" style="padding:0; margin:0;">${list}</ul>
    `;
    const copyButtons = Array.from(body.querySelectorAll('.storage-copy'));
    const copyText = async (text, btn) => {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        if (btn) {
          const old = btn.textContent;
          btn.textContent = '已複製';
          setTimeout(() => { btn.textContent = old || '複製內容'; }, 1200);
        }
      } catch {
        alert('複製失敗');
      }
    };
    copyButtons.forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.stopPropagation();
        const idx = Number(btn.dataset.idx);
        const entry = detail.entries?.[idx];
        if (!entry) return;
        const raw = entry.value ?? '';
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
        copyText(text, btn);
      });
    });
  }
  overlay.appendChild(box);
  box.appendChild(header);
  box.appendChild(body);
  document.body.appendChild(overlay);
}

function attachStorageDetailHandlers(root) {
  if (!root) return;
  root.querySelectorAll('[data-storage-label]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const label = el.dataset.storageLabel || 'storage';
      if (label.includes('資料庫') || label.toLowerCase().includes('indexeddb')) {
        const message = window.indexedDB ? 'IndexedDB 資料由瀏覽器管理，目前僅顯示狀態。' : '此瀏覽器不支援 IndexedDB。';
        renderStorageDetailModal({ label, entries: [], error: null, note: message });
      } else {
        const detail = collectStorageEntries(label);
        renderStorageDetailModal(detail);
      }
    });
  });
}

function getAppBuildTime() {
  if (typeof window !== 'undefined' && window.APP_BUILD_AT) return window.APP_BUILD_AT;
  try { return new Date(document.lastModified).toISOString(); } catch { return new Date().toISOString(); }
}

function getAppBuildCommit() {
  if (typeof window !== 'undefined' && window.APP_BUILD_COMMIT) return window.APP_BUILD_COMMIT;
  return null;
}

const GIT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-2px;margin-right:2px;opacity:.75"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
const GITHUB_TREE_URL = 'https://github.com/SENTRY-Security/SENTRY-Messenger/tree/';

function buildCommitHtml(commit) {
  const safe = escapeHtml(commit);
  const short = safe.length > 8 ? safe.slice(0, 8) : safe;
  return `<a href="${GITHUB_TREE_URL}${safe}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:2px" title="${safe}">${GIT_ICON}<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;font-size:11px;letter-spacing:.5px">${short}</code></a>`;
}

function formatInfo(info) {
  const now = new Date();
  const fetchedAt = info?.fetchedAt ? new Date(info.fetchedAt) : now;
  return {
    appBuildAt: getAppBuildTime(),
    appBuildCommit: getAppBuildCommit(),
    fetchedAt: fetchedAt.toLocaleString('zh-TW', { hour12: false }),
    clientLoadedAt: now.toLocaleString('zh-TW', { hour12: false })
  };
}

function renderPopup(popup, info) {
  const details = formatInfo(info);
  const storageStats = collectStorageStats();
  const totalBytes = storageStats.reduce((sum, item) => sum + item.totalBytes, 0);
  const storageRows = storageStats.map((item) => {
    const detail = item.error
      ? `<span style="color:#f87171;">錯誤：${escapeHtml(item.error)}</span>`
      : `<span>${item.keyCount} keys / ${formatBytes(item.totalBytes)}</span>`;
    return `
      <button type="button" class="version-storage-row" data-storage-label="${escapeHtml(item.label)}" aria-label="檢視 ${escapeHtml(item.label)}">
        <span>${escapeHtml(item.label)}</span>
        ${detail}
      </button>`;
  }).join('') || '<div class="version-storage-row">無可用資料</div>';

  popup.innerHTML = `
    <strong>版本資訊</strong>
    ${details.appBuildCommit ? `<div>建置版號：${buildCommitHtml(details.appBuildCommit)}</div>` : ''}
    <div>前端建置：${details.appBuildAt}</div>
    <div>前端載入：${details.clientLoadedAt}</div>
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
  const commitRow = details.appBuildCommit
    ? `<div class="version-row"><span class="version-label">${escapeHtml('建置版號')}</span><span class="version-value">${buildCommitHtml(details.appBuildCommit)}</span></div>`
    : '';
  const rows = [
    ['前端建置', details.appBuildAt],
    ['前端載入', details.clientLoadedAt],
    ['更新時間', details.fetchedAt]
  ];
  const storageRows = storageStats.map((item) => {
    const detail = item.error
      ? `<span class="version-value error">錯誤：${escapeHtml(item.error)}</span>`
      : `<span class="version-value">${item.keyCount} keys / ${formatBytes(item.totalBytes)}</span>`;
    return `<button type="button" class="version-row version-storage-button" data-storage-label="${escapeHtml(item.label)}"><span class="version-label">${escapeHtml(item.label)}</span>${detail}</button>`;
  }).join('') || '<div class="version-row"><span class="version-label">儲存</span><span class="version-value">無可用資料</span></div>';

  container.innerHTML = `
    <div class="version-modal">
      ${commitRow}
      ${rows.map(([label, value]) => `<div class="version-row"><span class="version-label">${escapeHtml(label)}</span><span class="version-value">${escapeHtml(value)}</span></div>`).join('')}
      <div class="version-section-title">前端儲存資訊</div>
      <div class="version-storage-list">
        ${storageRows}
        <div class="version-row version-storage-total"><span class="version-label">總計</span><span class="version-value">${formatBytes(totalBytes)}</span></div>
      </div>
    </div>`;
  attachStorageDetailHandlers(container);
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
  const info = { fetchedAt: new Date().toISOString() };
  renderModalContent(body, info);
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
    const info = { fetchedAt: new Date().toISOString() };
    renderPopup(popup, info);
    attachStorageDetailHandlers(popup);
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
