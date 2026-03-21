import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';

let pdfJsLibPromise = null;
let activePdfCleanup = null;

const PDFJS_ESM_URL = '/assets/libs/pdfjs/pdf.mjs';
const PDFJS_WORKER_URL = '/assets/libs/pdfjs/pdf.worker.min.mjs';

async function getPdfJs() {
  if (pdfJsLibPromise) return pdfJsLibPromise;
  pdfJsLibPromise = import(/* webpackIgnore: true */ PDFJS_ESM_URL)
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
        <button type="button" class="pdf-btn" id="pdfCloseBtn" aria-label="${t('viewer.close')}"><svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="pdf-title" title="${escapeHtml(name || 'PDF')}">${escapeHtml(name || 'PDF')}</div>
        <span id="pdfPageLabel" class="pdf-page-label">– / –</span>
        <div class="pdf-actions">
          <button type="button" class="pdf-btn" id="pdfDownload" aria-label="${t('viewer.downloadPdf')}">
            <svg viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="pdf-stage" id="pdfStage">
        <div class="pdf-loading" id="pdfLoading">${t('common.loading')}</div>
      </div>
    </div>`;
  openModal?.();

  const loadingEl = body.querySelector('#pdfLoading');
  const pageLabel = body.querySelector('#pdfPageLabel');
  const stage = body.querySelector('#pdfStage');

  let pdfDoc = null;
  let scale = 1;
  const pageCanvases = []; // { canvas, rendered, pageNum }

  const cleanupCore = () => {
    try { pdfDoc?.cleanup?.(); pdfDoc?.destroy?.(); } catch {}
    modalEl.classList.remove('pdf-modal');
  };

  // Compute scale to fit stage width
  const computeScale = (viewport) => {
    if (!stage?.clientWidth) return 1;
    const maxWidth = Math.max(stage.clientWidth - 16, 320); // 8px padding each side
    return Math.min(3, Math.max(0.6, maxWidth / viewport.width));
  };

  // Render a single page into its canvas
  const renderPageCanvas = async (entry) => {
    if (entry.rendered || entry.rendering) return;
    entry.rendering = true;
    try {
      const page = await pdfDoc.getPage(entry.pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      if (entry.pageNum === 1) {
        scale = computeScale(baseViewport);
      }
      const viewport = page.getViewport({ scale });
      const canvas = entry.canvas;
      const ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      await page.render({ canvasContext: ctx, viewport }).promise;
      entry.rendered = true;
    } catch (err) {
      log({ pdfPageRenderError: err?.message, page: entry.pageNum });
    }
    entry.rendering = false;
  };

  // Update the page label based on scroll position
  const updateCurrentPage = () => {
    if (!pdfDoc || !stage || pageCanvases.length === 0) return;
    const stageRect = stage.getBoundingClientRect();
    const mid = stageRect.top + stageRect.height * 0.35;
    let current = 1;
    for (const entry of pageCanvases) {
      const r = entry.wrap.getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid) {
        current = entry.pageNum;
        break;
      }
      if (r.top > mid) break;
      current = entry.pageNum;
    }
    if (pageLabel) pageLabel.textContent = `${current} / ${pdfDoc.numPages}`;
  };

  try {
    pdfDoc = await pdfjsLib.getDocument({ url }).promise;
    if (loadingEl) loadingEl.remove();

    // Create placeholder wraps + canvases for every page
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.dataset.page = i;
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      wrap.appendChild(canvas);
      stage.appendChild(wrap);
      pageCanvases.push({ canvas, wrap, rendered: false, rendering: false, pageNum: i });
    }

    // Lazy-render pages as they scroll into view
    const observer = new IntersectionObserver((entries) => {
      for (const ioEntry of entries) {
        if (!ioEntry.isIntersecting) continue;
        const num = parseInt(ioEntry.target.dataset.page, 10);
        const pc = pageCanvases[num - 1];
        if (pc && !pc.rendered) renderPageCanvas(pc);
      }
    }, { root: stage, rootMargin: '200px 0px' });

    for (const pc of pageCanvases) observer.observe(pc.wrap);

    // Render first few pages immediately
    const initialPages = Math.min(3, pdfDoc.numPages);
    for (let i = 0; i < initialPages; i++) {
      await renderPageCanvas(pageCanvases[i]);
    }
    updateCurrentPage();

    // Track scroll for page label
    let scrollTick = false;
    const onScroll = () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => {
        updateCurrentPage();
        scrollTick = false;
      });
    };
    stage.addEventListener('scroll', onScroll, { passive: true });

    // Resize handler — recompute scale and re-render visible pages
    const handleResize = () => {
      if (!pdfDoc || pageCanvases.length === 0) return;
      const first = pageCanvases[0];
      if (!first.rendered) return;
      // Recompute scale from first page
      pdfDoc.getPage(1).then(page => {
        const baseViewport = page.getViewport({ scale: 1 });
        scale = computeScale(baseViewport);
        // Re-render all already-rendered pages
        for (const pc of pageCanvases) {
          if (pc.rendered) {
            pc.rendered = false;
            pc.rendering = false;
          }
        }
        // Re-trigger observer checks
        for (const pc of pageCanvases) {
          observer.unobserve(pc.wrap);
          observer.observe(pc.wrap);
        }
      });
    };
    window.addEventListener('resize', handleResize);

    // Download button
    const downloadBtn = body.querySelector('#pdfDownload');
    downloadBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      const proceed = () => triggerDownload(url, name || 'file.pdf');
      if (typeof showConfirmModal === 'function') {
        showConfirmModal({
          title: t('viewer.downloadPdf'),
          message: t('drive.downloadPdfConfirm'),
          confirmLabel: t('drive.download'),
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
          <div class="pdf-confirm-title">${t('viewer.downloadPdf')}</div>
          <div class="pdf-confirm-msg">${t('drive.downloadPdfConfirm')}</div>
          <div class="pdf-confirm-actions">
            <button type="button" class="secondary" id="pdfDlCancel">${t('viewer.close')}</button>
            <button type="button" class="primary" id="pdfDlOk">${t('drive.download')}</button>
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

    // Close handlers
    body.querySelector('#pdfCloseBtn')?.addEventListener('click', () => activePdfCleanup?.());
    closeBtn?.addEventListener('click', () => activePdfCleanup?.(), { once: true });
    closeArea?.addEventListener('click', () => activePdfCleanup?.(), { once: true });

    // Cleanup registration
    const prevCleanup = activePdfCleanup;
    activePdfCleanup = () => {
      if (typeof prevCleanup === 'function') prevCleanup();
      observer.disconnect();
      stage.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', handleResize);
      cleanupCore();
      closeModal?.();
      activePdfCleanup = null;
    };
  } catch (err) {
    if (loadingEl) {
      loadingEl.textContent = t('viewer.pdfLoadFailed', { error: err?.message || err });
      loadingEl.classList.add('pdf-error');
    }
    return true;
  }

  return true;
}
