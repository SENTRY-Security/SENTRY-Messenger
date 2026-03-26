import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';

const XLSX_LIB_URL = '/assets/libs/xlsx.min.mjs';
let xlsxLibPromise = null;
let activeExcelCleanup = null;

async function getXlsx() {
  if (xlsxLibPromise) return xlsxLibPromise;
  xlsxLibPromise = import(/* webpackIgnore: true */ XLSX_LIB_URL)
    .then((mod) => mod.default || mod.XLSX || mod)
    .catch((err) => { xlsxLibPromise = null; throw err; });
  return xlsxLibPromise;
}

export function cleanupExcelViewer() {
  if (typeof activeExcelCleanup === 'function') {
    try { activeExcelCleanup(); } catch {}
  }
  activeExcelCleanup = null;
}

function triggerDownload(url, filename) {
  try {
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.download = filename;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    log({ excelDownloadError: err?.message || err });
  }
}

const EXCEL_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'text/csv'
];

export function isExcelMime(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return EXCEL_MIMES.some(m => lower === m || lower.startsWith(m));
}

export function isExcelFilename(name) {
  if (!name) return false;
  return /\.(xlsx|xls|xlsm|csv)$/i.test(name);
}

export async function renderExcelViewer({ url, blob, name, modalApi }) {
  const { openModal, closeModal, showConfirmModal } = modalApi || {};
  let XLSX;
  try {
    XLSX = await getXlsx();
  } catch (err) {
    log({ xlsxLoadError: err?.message || err });
    return false;
  }

  const modalEl = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const modalTitle = document.getElementById('modalTitle');
  const closeBtn = document.getElementById('modalClose');
  const closeArea = document.getElementById('modalCloseArea');
  if (!modalEl || !body || !modalTitle) return false;

  cleanupExcelViewer();
  modalEl.classList.add('excel-modal');
  window.__setLandscapeAllowed?.(true);
  modalTitle.textContent = '';

  body.innerHTML = `
    <div class="excel-viewer">
      <div class="excel-toolbar">
        <button type="button" class="excel-btn" id="excelCloseBtn" aria-label="${t('viewer.close')}">
          <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="excel-title" title="${escapeHtml(name || 'Excel')}">${escapeHtml(name || 'Excel')}</div>
        <div class="excel-actions">
          <button type="button" class="excel-btn" id="excelDownload" aria-label="${t('viewer.downloadExcel')}">
            <svg viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="excel-tabs" id="excelTabs"></div>
      <div class="excel-stage" id="excelStage">
        <div class="excel-loading" id="excelLoading">${t('common.loading')}</div>
      </div>
    </div>`;
  openModal?.();

  const loadingEl = body.querySelector('#excelLoading');
  const tabsEl = body.querySelector('#excelTabs');
  const stageEl = body.querySelector('#excelStage');

  try {
    // Read file
    let arrayBuffer;
    if (blob) {
      arrayBuffer = await blob.arrayBuffer();
    } else if (url) {
      const resp = await fetch(url);
      arrayBuffer = await resp.arrayBuffer();
    } else {
      throw new Error('No data source');
    }

    const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
    if (loadingEl) loadingEl.remove();

    const sheetNames = workbook.SheetNames;
    if (!sheetNames.length) throw new Error('No sheets');

    let activeSheet = 0;

    // Build sheet tabs
    const renderTabs = () => {
      tabsEl.innerHTML = '';
      sheetNames.forEach((name, idx) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'excel-tab' + (idx === activeSheet ? ' active' : '');
        tab.textContent = name;
        tab.addEventListener('click', () => {
          activeSheet = idx;
          renderTabs();
          renderSheet(idx);
        });
        tabsEl.appendChild(tab);
      });
    };

    // Render sheet as HTML table
    const renderSheet = (idx) => {
      const sheetName = sheetNames[idx];
      const sheet = workbook.Sheets[sheetName];
      const html = XLSX.utils.sheet_to_html(sheet, { editable: false });
      // Extract just the table from the generated HTML
      const match = html.match(/<table[\s\S]*<\/table>/i);
      stageEl.innerHTML = match ? match[0] : `<p>${t('viewer.excelEmpty')}</p>`;
      // Style the rendered table
      const table = stageEl.querySelector('table');
      if (table) {
        table.className = 'excel-table';
        table.setAttribute('draggable', 'false');
        // Prevent drag on all cells
        table.addEventListener('dragstart', e => e.preventDefault());
      }
    };

    renderTabs();
    renderSheet(0);

    // Download — inline confirm overlay (showConfirmModal destroys viewer)
    const downloadBtn = body.querySelector('#excelDownload');
    downloadBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      const proceed = () => triggerDownload(url, name || 'file.xlsx');
      const msg = t('drive.downloadPdfConfirm');
      if (msg) {
        const overlay = document.createElement('div');
        overlay.className = 'word-confirm-overlay';
        overlay.innerHTML = `<div class="word-confirm-box"><div class="word-confirm-msg">${escapeHtml(msg)}</div><div class="word-confirm-actions"><button type="button" class="word-confirm-cancel">${escapeHtml(t('common.cancel'))}</button><button type="button" class="word-confirm-ok">${escapeHtml(t('drive.download') || t('modal.confirm'))}</button></div></div>`;
        body.querySelector('.excel-viewer')?.appendChild(overlay) || body.appendChild(overlay);
        overlay.querySelector('.word-confirm-cancel')?.addEventListener('click', () => overlay.remove(), { once: true });
        overlay.querySelector('.word-confirm-ok')?.addEventListener('click', () => { overlay.remove(); proceed(); }, { once: true });
        return;
      }
      proceed();
    });

    // Close
    const doClose = () => activeExcelCleanup?.();
    body.querySelector('#excelCloseBtn')?.addEventListener('click', doClose);
    closeBtn?.addEventListener('click', doClose, { once: true });
    closeArea?.addEventListener('click', doClose, { once: true });

    const prevCleanup = activeExcelCleanup;
    activeExcelCleanup = () => {
      if (typeof prevCleanup === 'function') prevCleanup();
      window.__setLandscapeAllowed?.(false);
      modalEl.classList.remove('excel-modal');
      closeModal?.();
      activeExcelCleanup = null;
    };
  } catch (err) {
    log({ excelViewerError: err?.message || err });
    if (loadingEl) {
      loadingEl.textContent = t('viewer.excelLoadFailed', { error: err?.message || err });
      loadingEl.classList.add('excel-error');
    }
    return true;
  }

  return true;
}

/**
 * Render an Excel file as a thumbnail preview for chat messages.
 * Extracts the first sheet and renders a few rows as a small HTML table.
 * @param {ArrayBuffer} buffer - file content
 * @returns {HTMLElement|null}
 */
export async function renderExcelThumbnail(buffer) {
  try {
    const XLSX = await getXlsx();
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    if (!wb.SheetNames.length) return null;

    const sheet = wb.Sheets[wb.SheetNames[0]];
    const ref = sheet['!ref'];
    if (!ref) return null;

    // Limit to first 12 rows for thumbnail
    const range = XLSX.utils.decode_range(ref);
    range.e.r = Math.min(range.e.r, 11);
    range.e.c = Math.min(range.e.c, 7);
    const limitedRef = XLSX.utils.encode_range(range);

    const html = XLSX.utils.sheet_to_html(sheet, { editable: false, header: '', footer: '' });
    // Extract just the table
    const match = html.match(/<table[\s\S]*<\/table>/i);
    if (!match) return null;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'width:180px;height:120px;overflow:hidden;position:relative;background:#fff;border-radius:12px;';

    const inner = document.createElement('div');
    inner.style.cssText = 'transform-origin:top left;transform:scale(0.32);width:312%;pointer-events:none;';
    inner.innerHTML = match[0];

    // Style the table
    const tbl = inner.querySelector('table');
    if (tbl) {
      tbl.style.cssText = 'border-collapse:collapse;font-size:9pt;line-height:1.2;color:#1e293b;width:100%;';
      inner.querySelectorAll('td,th').forEach(cell => {
        cell.style.cssText = 'border:1px solid #e2e8f0;padding:2px 4px;white-space:nowrap;max-width:80px;overflow:hidden;text-overflow:ellipsis;';
      });
      inner.querySelectorAll('th').forEach(cell => {
        cell.style.cssText += 'background:#f1f5f9;font-weight:600;';
      });
    }
    wrapper.appendChild(inner);

    // File type badge
    const ext = wb.SheetNames[0] ? 'XLSX' : 'XLS';
    const badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;bottom:4px;right:4px;background:rgba(22,163,74,0.9);color:#fff;font-size:9px;font-weight:600;padding:2px 5px;border-radius:4px;line-height:1.2;pointer-events:none;letter-spacing:0.5px;';
    badge.textContent = ext;
    wrapper.appendChild(badge);

    return wrapper;
  } catch {
    return null;
  }
}
