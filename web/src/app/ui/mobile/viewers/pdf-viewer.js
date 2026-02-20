import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';
import { importWithSRI } from '/shared/utils/sri.js';
import { CDN_SRI } from '/shared/utils/cdn-integrity.js';

let pdfJsLibPromise = null;
let activePdfCleanup = null;

const PDFJS_ESM_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/+esm';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';

async function getPdfJs() {
  if (pdfJsLibPromise) return pdfJsLibPromise;
  pdfJsLibPromise = importWithSRI(PDFJS_ESM_URL, CDN_SRI[PDFJS_ESM_URL], { useNativeImport: true })
    .then((lib) => {
      try { lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; } catch (err) { log({ pdfWorkerInitError: err?.message || err }); }
      return lib;
    })
    .catch((err) => { pdfJsLibPromise = null; throw err; });
  return pdfJsLibPromise;
}

export function cleanupPdfViewer() {
  if (typeof activePdfCleanup === 'function') {
    try { activePdfCleanup(); } catch {}
  }
  activePdfCleanup = null;
}

function triggerDownload(url, filename) {
  try {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      const a = document.createElement('a');
      a.href = url;
      if (filename) a.download = filename;
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } catch (err) {
    log({ pdfDownloadError: err?.message || err });
  }
}

export async function getPdfJsLibrary() {
  return getPdfJs();
}

export async function renderPdfViewer({ url, name, modalApi }) {
  const { openModal, closeModal, showConfirmModal } = modalApi || {};
  let pdfjsLib;
  try {
    pdfjsLib = await getPdfJs();
  } catch (err) {
    log({ pdfJsLoadError: err?.message || err });
    return false;
  }
  const modalEl = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const modalTitle = document.getElementById('modalTitle');
  const closeBtn = document.getElementById('modalClose');
  const closeArea = document.getElementById('modalCloseArea');
  if (!modalEl || !body || !modalTitle) return false;
  cleanupPdfViewer();
  modalEl.classList.add('pdf-modal');
  modalTitle.textContent = '';
  body.innerHTML = `
    <div class="pdf-viewer">
      <div class="pdf-toolbar">
        <button type="button" class="pdf-btn" id="pdfCloseBtn" aria-label="關閉"><svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="pdf-title" title="${escapeHtml(name || 'PDF')}">${escapeHtml(name || 'PDF')}</div>
        <div class="pdf-actions">
          <button type="button" class="pdf-btn" id="pdfDownload" aria-label="下載 PDF">
            <svg viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="pdf-stage">
        <div class="pdf-canvas-wrap">
          <canvas id="pdfCanvas" class="pdf-canvas"></canvas>
          <div class="pdf-loading" id="pdfLoading">載入中…</div>
        </div>
      </div>
      <div class="pdf-footer">
        <div class="pdf-actions-row">
          <div class="pdf-page-info">
            <button type="button" class="pdf-btn" id="pdfPrev" aria-label="上一頁">‹</button>
            <span id="pdfPageLabel">– / –</span>
            <button type="button" class="pdf-btn" id="pdfNext" aria-label="下一頁">›</button>
          </div>
        </div>
      </div>
    </div>`;
  openModal?.();

  const canvas = body.querySelector('#pdfCanvas');
  const loadingEl = body.querySelector('#pdfLoading');
  const pageLabel = body.querySelector('#pdfPageLabel');
  const stage = body.querySelector('.pdf-stage');

  let pdfDoc = null;
  let pageNum = 1;
  let scale = 1;
  let rendering = false;
  let pendingPage = null;
  let fitWidth = true;

  const updateLabels = () => {
    if (pageLabel && pdfDoc) pageLabel.textContent = `${pageNum} / ${pdfDoc.numPages}`;
  };

  const cleanupCore = () => {
    try { pdfDoc?.cleanup?.(); pdfDoc?.destroy?.(); } catch {}
    modalEl.classList.remove('pdf-modal');
  };

  const renderPage = async (num) => {
    if (!pdfDoc || !canvas) return;
    rendering = true;
    const page = await pdfDoc.getPage(num);
    const baseViewport = page.getViewport({ scale: 1 });
    if (fitWidth && stage?.clientWidth) {
      const maxWidth = Math.max(stage.clientWidth, 320);
      scale = Math.min(3, Math.max(0.6, maxWidth / baseViewport.width));
    }
    const viewport = page.getViewport({ scale });
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    if (loadingEl) loadingEl.textContent = `載入第 ${num} 頁…`;
    await page.render({ canvasContext: ctx, viewport }).promise;
    rendering = false;
    updateLabels();
    if (loadingEl) loadingEl.textContent = '';
    if (pendingPage) {
      const next = pendingPage;
      pendingPage = null;
      renderPage(next);
    }
    if (stage) stage.style.touchAction = scale > 1 ? 'none' : 'auto';
  };

  try {
    pdfDoc = await pdfjsLib.getDocument({ url }).promise;
    pageNum = 1;
    updateLabels();
    await renderPage(pageNum);
  } catch (err) {
    if (loadingEl) {
      loadingEl.textContent = `PDF 載入失敗：${err?.message || err}`;
      loadingEl.classList.add('pdf-error');
    }
    return true;
  }

  const queueRender = (num) => {
    if (num < 1 || num > pdfDoc.numPages) return;
    pageNum = num;
    if (rendering) {
      pendingPage = num;
    } else {
      renderPage(num);
    }
  };

  body.querySelector('#pdfPrev')?.addEventListener('click', () => queueRender(pageNum - 1));
  body.querySelector('#pdfNext')?.addEventListener('click', () => queueRender(pageNum + 1));
  const downloadBtn = body.querySelector('#pdfDownload');
  downloadBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    const proceed = () => triggerDownload(url, name || 'file.pdf');
    if (typeof showConfirmModal === 'function') {
      showConfirmModal({
        title: '下載 PDF',
        message: '下載後會在外部開啟，返回通訊軟體可能需要重新感應。確定要下載嗎？',
        confirmLabel: '下載',
        onConfirm: proceed
      });
      return;
    }
    const existing = document.querySelector('.pdf-confirm');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pdf-confirm';
    overlay.innerHTML = `
      <div class="pdf-confirm-panel">
        <div class="pdf-confirm-title">下載 PDF</div>
        <div class="pdf-confirm-msg">下載後會在外部開啟，返回通訊軟體可能需要重新感應。確定要下載嗎？</div>
        <div class="pdf-confirm-actions">
          <button type="button" class="secondary" id="pdfDlCancel">取消</button>
          <button type="button" class="primary" id="pdfDlOk">下載</button>
        </div>
      </div>`;
    const cleanupConfirm = () => overlay.remove();
    overlay.querySelector('#pdfDlCancel')?.addEventListener('click', cleanupConfirm, { once: true });
    overlay.querySelector('#pdfDlOk')?.addEventListener('click', () => {
      cleanupConfirm();
      proceed();
    }, { once: true });
    document.body.appendChild(overlay);
  });
  body.querySelector('#pdfCloseBtn')?.addEventListener('click', () => activePdfCleanup?.());
  closeBtn?.addEventListener('click', () => activePdfCleanup?.(), { once: true });
  closeArea?.addEventListener('click', () => activePdfCleanup?.(), { once: true });
  const handleResize = () => { if (fitWidth) queueRender(pageNum); };
  window.addEventListener('resize', handleResize);

  // Pinch/pan with Pointer Events
  let activePointers = new Map();
  let pinchStartDist = null;
  let pinchStartScale = scale;
  let panStart = null;

  const updatePinch = () => {
    if (activePointers.size < 2 || !stage) return;
    const pts = Array.from(activePointers.values());
    const [a, b] = pts;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!pinchStartDist) {
      pinchStartDist = dist;
      pinchStartScale = scale;
      panStart = null;
      stage.style.touchAction = 'none';
      return;
    }
    const factor = dist / pinchStartDist;
    scale = Math.min(3, Math.max(0.6, pinchStartScale * factor));
    fitWidth = false;
    queueRender(pageNum);
  };

  const onPointerDown = (e) => {
    if (!stage) return;
    stage.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) {
      updatePinch();
    } else if (activePointers.size === 1 && scale > 1) {
      panStart = { x: e.clientX, y: e.clientY, scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop };
      stage.style.touchAction = 'none';
    }
  };

  const onPointerMove = (e) => {
    if (!stage || !activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size >= 2) {
      e.preventDefault();
      updatePinch();
    } else if (panStart && activePointers.size === 1) {
      e.preventDefault();
      const p = activePointers.get(e.pointerId);
      stage.scrollLeft = panStart.scrollLeft - (p.x - panStart.x);
      stage.scrollTop = panStart.scrollTop - (p.y - panStart.y);
    }
  };

  const onPointerUp = (e) => {
    if (stage) stage.releasePointerCapture?.(e.pointerId);
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) {
      pinchStartDist = null;
      if (!panStart || scale <= 1) {
        panStart = null;
        if (stage && scale <= 1) stage.style.touchAction = 'auto';
      }
    }
    if (activePointers.size === 0) panStart = null;
  };

  stage?.addEventListener('pointerdown', onPointerDown);
  stage?.addEventListener('pointermove', onPointerMove);
  stage?.addEventListener('pointerup', onPointerUp);
  stage?.addEventListener('pointercancel', onPointerUp);

  const prevCleanup = activePdfCleanup;
  activePdfCleanup = () => {
    if (typeof prevCleanup === 'function') prevCleanup();
    cleanupCore();
    window.removeEventListener('resize', handleResize);
    stage?.removeEventListener('pointerdown', onPointerDown);
    stage?.removeEventListener('pointermove', onPointerMove);
    stage?.removeEventListener('pointerup', onPointerUp);
    stage?.removeEventListener('pointercancel', onPointerUp);
    closeModal?.();
    activePdfCleanup = null;
    if (stage) stage.style.touchAction = 'auto';
  };
  return true;
}
