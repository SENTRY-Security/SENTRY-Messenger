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
  let fitScale = 1;
  const pageCanvases = []; // { canvas, wrap, rendered, rendering, pageNum, zoom }
  const gestureCleanups = [];

  const cleanupCore = () => {
    for (const fn of gestureCleanups) { try { fn(); } catch {} }
    gestureCleanups.length = 0;
    try { pdfDoc?.cleanup?.(); pdfDoc?.destroy?.(); } catch {}
    modalEl.classList.remove('pdf-modal');
  };

  // Compute base scale to auto-fit stage width (edge-to-edge minus stage padding)
  const computeFitScale = (viewport) => {
    if (!stage?.clientWidth) return 1;
    const cs = getComputedStyle(stage);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const available = Math.max(stage.clientWidth - padL - padR, 320);
    return Math.min(3, Math.max(0.6, available / viewport.width));
  };

  // Render a page canvas at a given render scale; CSS size stays at fitScale dimensions
  const renderPageAt = async (entry, renderScale) => {
    if (entry.rendering) return;
    entry.rendering = true;
    try {
      const page = await pdfDoc.getPage(entry.pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      if (entry.pageNum === 1 && !entry.rendered) {
        fitScale = computeFitScale(baseViewport);
      }
      const cssViewport = page.getViewport({ scale: fitScale });
      const hiresViewport = page.getViewport({ scale: renderScale });
      const canvas = entry.canvas;
      const ctx = canvas.getContext('2d');
      // High-res pixel buffer
      canvas.width = hiresViewport.width;
      canvas.height = hiresViewport.height;
      // CSS size stays at fit dimensions (visual 1x size)
      canvas.style.width = `${cssViewport.width}px`;
      canvas.style.height = `${cssViewport.height}px`;
      entry.wrap.style.width = `${cssViewport.width}px`;
      entry.wrap.style.height = `${cssViewport.height}px`;
      entry.wrap.style.minHeight = '0';
      await page.render({ canvasContext: ctx, viewport: hiresViewport }).promise;
      entry.rendered = true;
      entry.currentRenderScale = renderScale;
    } catch (err) {
      log({ pdfPageRenderError: err?.message, page: entry.pageNum });
    }
    entry.rendering = false;
  };

  // Initial render at fitScale
  const renderPageCanvas = (entry) => renderPageAt(entry, fitScale);

  // ── Per-page pinch-zoom + pan ──
  const attachPageGesture = (entry) => {
    const wrap = entry.wrap;
    const canvas = entry.canvas;
    let zoom = 1, tx = 0, ty = 0;
    const activePointers = new Map();
    let pinchStartDist = null, pinchStartZoom = 1;
    let pinchStartMid = null, pinchStartTx = 0, pinchStartTy = 0;
    let panStart = null;
    let lastTapTime = 0;
    let hiresTimer = null;

    const applyTransform = () => {
      canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
      canvas.style.transformOrigin = '0 0';
      wrap.style.touchAction = zoom > 1.01 ? 'none' : 'pan-y';
    };

    const clampPan = () => {
      if (zoom <= 1) { tx = 0; ty = 0; return; }
      const w = canvas.offsetWidth * zoom;
      const h = canvas.offsetHeight * zoom;
      const ww = wrap.clientWidth;
      const wh = wrap.clientHeight;
      tx = Math.max(Math.min(0, ww - w), Math.min(0, tx));
      ty = Math.max(Math.min(0, wh - h), Math.min(0, ty));
    };

    // Re-render at high resolution, then reset CSS transform
    const scheduleHiresRender = () => {
      if (hiresTimer) clearTimeout(hiresTimer);
      if (zoom <= 1.05) return;
      hiresTimer = setTimeout(async () => {
        hiresTimer = null;
        const targetZoom = zoom;
        const targetRenderScale = fitScale * targetZoom;
        // Cap render scale to avoid excessive memory use
        const maxRenderScale = fitScale * 5;
        const renderScale = Math.min(maxRenderScale, targetRenderScale);
        if (entry.currentRenderScale && Math.abs(entry.currentRenderScale - renderScale) < 0.1) return;
        // Save current pan ratio before re-render
        const panRatioX = canvas.offsetWidth > 0 ? tx / (canvas.offsetWidth * zoom) : 0;
        const panRatioY = canvas.offsetHeight > 0 ? ty / (canvas.offsetHeight * zoom) : 0;
        entry.rendered = false;
        await renderPageAt(entry, renderScale);
        // After re-render: canvas CSS size is still fitScale dimensions,
        // but pixel buffer is hi-res. Keep CSS transform for pan only (zoom=1 visually via hi-res pixels).
        // Actually we keep the CSS zoom so the visual size = cssSize * zoom stays the same.
        // The hi-res buffer just provides sharper pixels within that zoomed view.
        tx = panRatioX * canvas.offsetWidth * zoom;
        ty = panRatioY * canvas.offsetHeight * zoom;
        clampPan();
        applyTransform();
      }, 250);
    };

    const resetZoom = () => {
      if (hiresTimer) { clearTimeout(hiresTimer); hiresTimer = null; }
      zoom = 1; tx = 0; ty = 0;
      applyTransform();
      // Re-render at base fitScale if we had a hi-res render
      if (entry.currentRenderScale && entry.currentRenderScale > fitScale + 0.1) {
        entry.rendered = false;
        renderPageAt(entry, fitScale);
      }
    };

    const pDist = () => {
      if (activePointers.size < 2) return 0;
      const pts = Array.from(activePointers.values());
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const pMid = () => {
      const pts = Array.from(activePointers.values());
      if (pts.length < 2) return { x: pts[0]?.x || 0, y: pts[0]?.y || 0 };
      return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    };

    const onDown = (e) => {
      wrap.setPointerCapture(e.pointerId);
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size === 2) {
        pinchStartDist = pDist();
        pinchStartZoom = zoom;
        pinchStartMid = pMid();
        pinchStartTx = tx;
        pinchStartTy = ty;
        panStart = null;
      } else if (activePointers.size === 1) {
        const now = Date.now();
        if (now - lastTapTime < 300) {
          if (zoom > 1.2) {
            resetZoom();
          } else {
            const rect = wrap.getBoundingClientRect();
            const tapX = e.clientX - rect.left;
            const tapY = e.clientY - rect.top;
            zoom = 2.5;
            tx = wrap.clientWidth / 2 - tapX * zoom;
            ty = wrap.clientHeight / 2 - tapY * zoom;
            clampPan();
            applyTransform();
            scheduleHiresRender();
          }
          lastTapTime = 0;
          return;
        }
        lastTapTime = now;
        if (zoom > 1.01) {
          panStart = { x: e.clientX, y: e.clientY, tx, ty };
        }
      }
    };

    const onMove = (e) => {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size >= 2 && pinchStartDist) {
        e.preventDefault();
        const dist = pDist();
        const newZoom = Math.min(5, Math.max(1, pinchStartZoom * (dist / pinchStartDist)));
        const mid = pMid();
        const rect = wrap.getBoundingClientRect();
        const focusX = pinchStartMid.x - rect.left;
        const focusY = pinchStartMid.y - rect.top;
        tx = pinchStartTx + (mid.x - pinchStartMid.x) - (focusX - pinchStartTx) * (newZoom / pinchStartZoom - 1);
        ty = pinchStartTy + (mid.y - pinchStartMid.y) - (focusY - pinchStartTy) * (newZoom / pinchStartZoom - 1);
        zoom = newZoom;
        clampPan();
        applyTransform();
      } else if (panStart && activePointers.size === 1) {
        e.preventDefault();
        const p = activePointers.get(e.pointerId);
        tx = panStart.tx + (p.x - panStart.x);
        ty = panStart.ty + (p.y - panStart.y);
        clampPan();
        applyTransform();
      }
    };

    const onUp = (e) => {
      wrap.releasePointerCapture?.(e.pointerId);
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) {
        pinchStartDist = null;
        if (activePointers.size === 1 && zoom > 1.01) {
          const remaining = activePointers.values().next().value;
          panStart = { x: remaining.x, y: remaining.y, tx, ty };
        }
      }
      if (activePointers.size === 0) {
        panStart = null;
        if (zoom < 1.05) {
          resetZoom();
        } else {
          scheduleHiresRender();
        }
      }
    };

    wrap.addEventListener('pointerdown', onDown);
    wrap.addEventListener('pointermove', onMove);
    wrap.addEventListener('pointerup', onUp);
    wrap.addEventListener('pointercancel', onUp);

    entry.zoom = { reset: resetZoom, getZoom: () => zoom };
    gestureCleanups.push(() => {
      if (hiresTimer) clearTimeout(hiresTimer);
      wrap.removeEventListener('pointerdown', onDown);
      wrap.removeEventListener('pointermove', onMove);
      wrap.removeEventListener('pointerup', onUp);
      wrap.removeEventListener('pointercancel', onUp);
    });
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
      const entry = { canvas, wrap, rendered: false, rendering: false, pageNum: i, zoom: null, currentRenderScale: 0 };
      pageCanvases.push(entry);
      attachPageGesture(entry);
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
      pdfDoc.getPage(1).then(page => {
        const baseViewport = page.getViewport({ scale: 1 });
        fitScale = computeFitScale(baseViewport);
        for (const pc of pageCanvases) {
          if (pc.rendered) {
            pc.rendered = false;
            pc.rendering = false;
          }
          pc.zoom?.reset();
        }
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
