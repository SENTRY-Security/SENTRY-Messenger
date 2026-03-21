import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';

const JSZIP_URL = '/assets/libs/jszip.min.js';
let activeZipCleanup = null;

async function ensureJSZip() {
  if (typeof window.JSZip !== 'undefined') return window.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSZIP_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('JSZip load failed'));
    document.head.appendChild(s);
  });
  return window.JSZip;
}

export function cleanupZipViewer() {
  if (typeof activeZipCleanup === 'function') {
    try { activeZipCleanup(); } catch {}
  }
  activeZipCleanup = null;
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

const ZIP_MIMES = [
  'application/zip', 'application/x-zip-compressed',
  'application/x-rar-compressed', 'application/x-7z-compressed',
  'application/gzip', 'application/x-tar',
  'application/x-bzip2'
];

export function isZipMime(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return ZIP_MIMES.some(m => lower === m);
}

export function isZipFilename(name) {
  if (!name) return false;
  return /\.(zip|rar|7z|gz|tar|tgz|bz2)$/i.test(name);
}

function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function getFileIcon(name) {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';
  const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'];
  const vidExts = ['mp4', 'mov', 'webm', 'avi', 'mkv'];
  const audioExts = ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'];
  const docExts = ['docx', 'doc', 'rtf', 'odt', 'pages'];
  const xlsExts = ['xlsx', 'xls', 'csv'];
  const pptExts = ['pptx', 'ppt', 'odp', 'key'];
  const archiveExts = ['zip', 'rar', '7z', 'gz', 'tar', 'tgz', 'bz2'];
  if (imgExts.includes(ext)) return { icon: '🖼️', color: '#16a34a' };
  if (vidExts.includes(ext)) return { icon: '🎬', color: '#7c3aed' };
  if (audioExts.includes(ext)) return { icon: '🎵', color: '#7c3aed' };
  if (ext === 'pdf') return { icon: '📄', color: '#dc2626' };
  if (docExts.includes(ext)) return { icon: '📝', color: '#2563eb' };
  if (xlsExts.includes(ext)) return { icon: '📊', color: '#16a34a' };
  if (pptExts.includes(ext)) return { icon: '📽️', color: '#ea580c' };
  if (archiveExts.includes(ext)) return { icon: '📦', color: '#d97706' };
  if (['txt', 'md', 'log'].includes(ext)) return { icon: '📃', color: '#94a3b8' };
  if (['json', 'xml', 'js', 'ts', 'py', 'html', 'css', 'sh'].includes(ext)) return { icon: '💻', color: '#8b5cf6' };
  return { icon: '📎', color: '#64748b' };
}

function isPreviewable(name) {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';
  const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
  const textExts = ['txt', 'md', 'log', 'json', 'xml', 'js', 'ts', 'py', 'html', 'css', 'sh', 'sql', 'yml', 'yaml', 'ini', 'toml', 'csv', 'env', 'conf'];
  return imgExts.includes(ext) ? 'image' : textExts.includes(ext) ? 'text' : null;
}

export async function renderZipViewer({ url, blob, name, modalApi }) {
  const { openModal, closeModal, showConfirmModal } = modalApi || {};
  let JSZip;
  try {
    JSZip = await ensureJSZip();
  } catch (err) {
    log({ jszipLoadError: err?.message || err });
    return false;
  }

  const modalEl = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const modalTitle = document.getElementById('modalTitle');
  const closeBtn = document.getElementById('modalClose');
  const closeArea = document.getElementById('modalCloseArea');
  if (!modalEl || !body || !modalTitle) return false;

  cleanupZipViewer();
  modalEl.classList.add('zip-modal');
  modalTitle.textContent = '';

  body.innerHTML = `
    <div class="zip-viewer">
      <div class="zip-toolbar">
        <button type="button" class="zip-btn" id="zipCloseBtn" aria-label="${t('viewer.close')}">
          <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="zip-title" title="${escapeHtml(name || 'ZIP')}">${escapeHtml(name || 'ZIP')}</div>
        <div class="zip-actions">
          <button type="button" class="zip-btn" id="zipDownload" aria-label="${t('viewer.downloadZip')}">
            <svg viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="zip-info" id="zipInfo"></div>
      <div class="zip-stage" id="zipStage">
        <div class="zip-loading" id="zipLoading">${t('common.loading')}</div>
      </div>
      <div class="zip-preview-panel" id="zipPreviewPanel" style="display:none">
        <div class="zip-preview-header">
          <button type="button" class="zip-btn" id="zipPreviewBack">
            <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <span class="zip-preview-name" id="zipPreviewName"></span>
          <button type="button" class="zip-btn" id="zipPreviewDownload" aria-label="${t('viewer.downloadZip')}">
            <svg viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div class="zip-preview-body" id="zipPreviewBody"></div>
      </div>
    </div>`;
  openModal?.();

  const loadingEl = body.querySelector('#zipLoading');
  const stageEl = body.querySelector('#zipStage');
  const infoEl = body.querySelector('#zipInfo');
  const previewPanel = body.querySelector('#zipPreviewPanel');
  const previewBody = body.querySelector('#zipPreviewBody');
  const previewName = body.querySelector('#zipPreviewName');
  let zipInstance = null;
  const objectUrls = [];

  const cleanup = () => {
    for (const u of objectUrls) { try { URL.revokeObjectURL(u); } catch {} }
    objectUrls.length = 0;
  };

  try {
    let arrayBuffer;
    if (blob) {
      arrayBuffer = await blob.arrayBuffer();
    } else if (url) {
      const resp = await fetch(url);
      arrayBuffer = await resp.arrayBuffer();
    } else {
      throw new Error('No data source');
    }

    zipInstance = await JSZip.loadAsync(arrayBuffer);
    if (loadingEl) loadingEl.remove();

    // Build file list
    const entries = [];
    let totalSize = 0;
    zipInstance.forEach((path, entry) => {
      if (!entry.dir) {
        entries.push({ path, entry, name: path.split('/').pop() || path });
        totalSize += entry._data?.uncompressedSize || 0;
      }
    });

    // Sort: folders first (by path depth), then alphabetically
    entries.sort((a, b) => a.path.localeCompare(b.path));

    // Info bar
    infoEl.textContent = `${entries.length} ${t('viewer.zipFiles')}${totalSize ? ' · ' + fmtSize(totalSize) : ''}`;

    // Render file list
    const listEl = document.createElement('div');
    listEl.className = 'zip-file-list';

    let currentFolder = '';
    for (const item of entries) {
      const parts = item.path.split('/');
      const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

      // Folder header
      if (folder && folder !== currentFolder) {
        currentFolder = folder;
        const folderEl = document.createElement('div');
        folderEl.className = 'zip-folder-header';
        folderEl.innerHTML = `<span class="zip-folder-icon">📁</span> ${escapeHtml(folder)}`;
        listEl.appendChild(folderEl);
      }

      const { icon } = getFileIcon(item.name);
      const size = item.entry._data?.uncompressedSize;
      const previewType = isPreviewable(item.name);

      const row = document.createElement('div');
      row.className = 'zip-file-row' + (previewType ? ' zip-file-previewable' : '');
      row.innerHTML = `
        <span class="zip-file-icon">${icon}</span>
        <span class="zip-file-name">${escapeHtml(item.name)}</span>
        <span class="zip-file-size">${size ? fmtSize(size) : ''}</span>
        <button type="button" class="zip-file-extract" aria-label="${t('drive.download')}">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>`;

      // Extract single file
      row.querySelector('.zip-file-extract').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const fileBlob = await item.entry.async('blob');
          triggerBlobDownload(fileBlob, item.name);
        } catch (err) {
          log({ zipExtractError: err?.message, file: item.path });
        }
      });

      // Preview on row click
      if (previewType) {
        row.addEventListener('click', async () => {
          previewName.textContent = item.name;
          previewBody.innerHTML = `<div class="zip-loading">${t('common.loading')}</div>`;
          previewPanel.style.display = 'flex';
          stageEl.style.display = 'none';
          infoEl.style.display = 'none';

          // Download for preview
          const downloadBtn = body.querySelector('#zipPreviewDownload');
          const newDownload = downloadBtn.cloneNode(true);
          downloadBtn.replaceWith(newDownload);
          newDownload.addEventListener('click', async () => {
            try {
              const b = await item.entry.async('blob');
              triggerBlobDownload(b, item.name);
            } catch {}
          });

          try {
            if (previewType === 'image') {
              const imgBlob = await item.entry.async('blob');
              const imgUrl = URL.createObjectURL(imgBlob);
              objectUrls.push(imgUrl);
              previewBody.innerHTML = '';
              const img = document.createElement('img');
              img.src = imgUrl;
              img.className = 'zip-preview-img';
              img.alt = item.name;
              previewBody.appendChild(img);
            } else {
              const text = await item.entry.async('string');
              previewBody.innerHTML = '';
              const pre = document.createElement('pre');
              pre.className = 'zip-preview-text';
              pre.textContent = text.slice(0, 50000);
              previewBody.appendChild(pre);
            }
          } catch (err) {
            previewBody.innerHTML = `<div class="zip-error">${escapeHtml(err?.message || 'Preview failed')}</div>`;
          }
        });
      }

      listEl.appendChild(row);
    }

    stageEl.appendChild(listEl);

    // Preview back button
    body.querySelector('#zipPreviewBack')?.addEventListener('click', () => {
      previewPanel.style.display = 'none';
      stageEl.style.display = '';
      infoEl.style.display = '';
    });

    // Download whole ZIP
    body.querySelector('#zipDownload')?.addEventListener('click', (e) => {
      e.preventDefault();
      if (blob) {
        triggerBlobDownload(blob, name || 'archive.zip');
      } else if (url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = name || 'archive.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    });

    // Close
    const doClose = () => activeZipCleanup?.();
    body.querySelector('#zipCloseBtn')?.addEventListener('click', doClose);
    closeBtn?.addEventListener('click', doClose, { once: true });
    closeArea?.addEventListener('click', doClose, { once: true });

    const prevCleanup = activeZipCleanup;
    activeZipCleanup = () => {
      if (typeof prevCleanup === 'function') prevCleanup();
      cleanup();
      modalEl.classList.remove('zip-modal');
      closeModal?.();
      activeZipCleanup = null;
    };
  } catch (err) {
    log({ zipViewerError: err?.message || err });
    if (loadingEl) {
      loadingEl.textContent = t('viewer.zipLoadFailed', { error: err?.message || err });
      loadingEl.classList.add('zip-error');
    }
    return true;
  }

  return true;
}
