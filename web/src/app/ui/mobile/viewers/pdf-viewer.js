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

// ── Constants ──
const MAX_ALIVE_PAGES = 7; // max canvas elements kept in memory
const BASE_RENDER_SCALE = Math.max(2, window.devicePixelRatio || 2);

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
  window.__setLandscapeAllowed?.(true);
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
  const pages = []; // { wrap, canvas, rendered, rendering, pageNum, alive, currentRenderScale, gestureCleanup, zoom }
  const aliveQueue = []; // pageNum order of alive canvases (LRU)

  const cleanupCore = () => {
    for (const p of pages) {
      if (p.gestureCleanup) { try { p.gestureCleanup(); } catch {} }
      evictPage(p);
    }
    try { pdfDoc?.cleanup?.(); pdfDoc?.destroy?.(); } catch {}
    window.__setLandscapeAllowed?.(false);
    modalEl.classList.remove('pdf-modal');
  };

  // ── Content-aware crop ──
  const detectContentBounds = (canvas) => {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return null;
    const sample = Math.max(1, Math.floor(Math.min(w, h) / 400));
    const data = ctx.getImageData(0, 0, w, h).data;
    const THR = 245;
    let top = h, bottom = 0, left = w, right = 0;
    for (let y = 0; y < h; y += sample) {
      for (let x = 0; x < w; x += sample) {
        const i = (y * w + x) * 4;
        if (data[i] < THR || data[i + 1] < THR || data[i + 2] < THR) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    if (bottom <= top || right <= left) return null;
    const padX = Math.round(w * 0.01);
    const padY = Math.round(h * 0.01);
    return {
      x: Math.max(0, left - padX),
      y: Math.max(0, top - padY),
      w: Math.min(w, right - left + 2 * padX),
      h: Math.min(h, bottom - top + 2 * padY)
    };
  };

  const cropCanvas = (canvas, bounds) => {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    canvas.width = bounds.w;
    canvas.height = bounds.h;
    ctx.putImageData(imageData, 0, 0);
  };

  // ── Memory management ──
  const evictPage = (entry) => {
    if (!entry.alive) return;
    // Release canvas memory
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      entry.canvas.style.transform = '';
      entry.canvas.remove();
    }
    entry.canvas = null;
    entry.alive = false;
    entry.rendered = false;
    entry.rendering = false;
    entry.currentRenderScale = 0;
    // Reset zoom state
    if (entry.zoom) {
      try { entry.zoom.reset(); } catch {}
    }
    const idx = aliveQueue.indexOf(entry.pageNum);
    if (idx !== -1) aliveQueue.splice(idx, 1);
  };

  const ensureAliveSlot = () => {
    while (aliveQueue.length >= MAX_ALIVE_PAGES) {
      const oldestNum = aliveQueue.shift();
      const old = pages[oldestNum - 1];
      if (old) evictPage(old);
    }
  };

  const ensureCanvas = (entry) => {
    if (entry.canvas && entry.alive) {
      // Move to end of LRU
      const idx = aliveQueue.indexOf(entry.pageNum);
      if (idx !== -1) aliveQueue.splice(idx, 1);
      aliveQueue.push(entry.pageNum);
      return entry.canvas;
    }
    ensureAliveSlot();
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    entry.wrap.appendChild(canvas);
    entry.canvas = canvas;
    entry.alive = true;
    entry.rendered = false;
    entry.currentRenderScale = 0;
    aliveQueue.push(entry.pageNum);
    // Re-attach gesture to new canvas
    if (entry.gestureCleanup) { try { entry.gestureCleanup(); } catch {} }
    attachPageGesture(entry);
    return canvas;
  };

  // ── Render ──
  const renderPageAt = async (entry, renderScale) => {
    if (entry.rendering) return;
    entry.rendering = true;
    try {
      const canvas = ensureCanvas(entry);
      const page = await pdfDoc.getPage(entry.pageNum);
      const hiresViewport = page.getViewport({ scale: renderScale });
      const ctx = canvas.getContext('2d');
      canvas.width = hiresViewport.width;
      canvas.height = hiresViewport.height;
      await page.render({ canvasContext: ctx, viewport: hiresViewport }).promise;
      // Crop whitespace
      const bounds = detectContentBounds(canvas);
      if (bounds && (bounds.w < canvas.width * 0.95 || bounds.h < canvas.height * 0.95)) {
        cropCanvas(canvas, bounds);
      }
      // Update wrap aspect-ratio from cropped content
      const aspect = canvas.width / canvas.height;
      entry.wrap.style.aspectRatio = `${aspect}`;
      entry.rendered = true;
      entry.currentRenderScale = renderScale;
    } catch (err) {
      log({ pdfPageRenderError: err?.message, page: entry.pageNum });
    }
    entry.rendering = false;
  };

  const renderPageCanvas = (entry) => renderPageAt(entry, BASE_RENDER_SCALE);

  // ── Per-page pinch-zoom + pan ──
  const attachPageGesture = (entry) => {
    const wrap = entry.wrap;
    const canvas = entry.canvas;
    if (!canvas) return;
    let zoom = 1, tx = 0, ty = 0;
    const activePointers = new Map();
    let pinchStartDist = null, pinchStartZoom = 1;
    let pinchStartMid = null, pinchStartTx = 0, pinchStartTy = 0;
    let panStart = null;
    let lastTapTime = 0;
    let hiresTimer = null;

    const applyTransform = () => {
      if (!entry.canvas) return;
      entry.canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
      entry.canvas.style.transformOrigin = '0 0';
      wrap.style.touchAction = zoom > 1.01 ? 'none' : 'pan-y';
    };

    const clampPan = () => {
      if (zoom <= 1 || !entry.canvas) { tx = 0; ty = 0; return; }
      const w = entry.canvas.offsetWidth * zoom;
      const h = entry.canvas.offsetHeight * zoom;
      const ww = wrap.clientWidth;
      const wh = wrap.clientHeight;
      tx = Math.max(Math.min(0, ww - w), Math.min(0, tx));
      ty = Math.max(Math.min(0, wh - h), Math.min(0, ty));
    };

    const scheduleHiresRender = () => {
      if (hiresTimer) clearTimeout(hiresTimer);
      if (zoom <= 1.05) return;
      hiresTimer = setTimeout(async () => {
        hiresTimer = null;
        if (!entry.canvas) return;
        const renderScale = Math.min(BASE_RENDER_SCALE * 5, BASE_RENDER_SCALE * zoom);
        if (entry.currentRenderScale && Math.abs(entry.currentRenderScale - renderScale) < 0.1) return;
        const panRatioX = entry.canvas.offsetWidth > 0 ? tx / (entry.canvas.offsetWidth * zoom) : 0;
        const panRatioY = entry.canvas.offsetHeight > 0 ? ty / (entry.canvas.offsetHeight * zoom) : 0;
        entry.rendered = false;
        await renderPageAt(entry, renderScale);
        if (!entry.canvas) return;
        tx = panRatioX * entry.canvas.offsetWidth * zoom;
        ty = panRatioY * entry.canvas.offsetHeight * zoom;
        clampPan();
        applyTransform();
      }, 250);
    };

    const resetZoom = () => {
      if (hiresTimer) { clearTimeout(hiresTimer); hiresTimer = null; }
      zoom = 1; tx = 0; ty = 0;
      applyTransform();
      if (entry.currentRenderScale && entry.currentRenderScale > BASE_RENDER_SCALE + 0.1) {
        entry.rendered = false;
        renderPageAt(entry, BASE_RENDER_SCALE);
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
      if (!entry.canvas) return;
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
    entry.gestureCleanup = () => {
      if (hiresTimer) clearTimeout(hiresTimer);
      wrap.removeEventListener('pointerdown', onDown);
      wrap.removeEventListener('pointermove', onMove);
      wrap.removeEventListener('pointerup', onUp);
      wrap.removeEventListener('pointercancel', onUp);
    };
  };

  // ── Page label ──
  const updateCurrentPage = () => {
    if (!pdfDoc || !stage || pages.length === 0) return;
    const stageRect = stage.getBoundingClientRect();
    const mid = stageRect.top + stageRect.height * 0.35;
    let current = 1;
    for (const entry of pages) {
      const r = entry.wrap.getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid) { current = entry.pageNum; break; }
      if (r.top > mid) break;
      current = entry.pageNum;
    }
    if (pageLabel) pageLabel.textContent = `${current} / ${pdfDoc.numPages}`;
  };

  // ── Password modal overlay ──
  const showPasswordModal = (errorMsg) => new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'pdf-pw-overlay';
    overlay.innerHTML = `
      <div class="pdf-pw-modal">
        <div class="pdf-pw-icon">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div class="pdf-pw-title">${t('viewer.pdfPasswordRequired')}</div>
        <div class="pdf-pw-error" id="pdfPwError" style="display:${errorMsg ? 'block' : 'none'}">${errorMsg ? escapeHtml(errorMsg) : ''}</div>
        <div class="pdf-pw-field">
          <input type="password" class="pdf-pw-input" id="pdfPwInput" placeholder="${t('viewer.pdfPasswordPlaceholder')}" autocomplete="off" spellcheck="false" />
          <button type="button" class="pdf-pw-eye" id="pdfPwEye" aria-label="${t('viewer.togglePassword')}">
            <svg class="eye-open" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="eye-closed" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          </button>
        </div>
        <div class="pdf-pw-actions">
          <button type="button" class="pdf-pw-cancel" id="pdfPwCancel">${t('common.cancel')}</button>
          <button type="button" class="pdf-pw-submit" id="pdfPwSubmit">${t('viewer.pdfUnlock')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#pdfPwInput');
    const eyeBtn = overlay.querySelector('#pdfPwEye');
    const submitBtn = overlay.querySelector('#pdfPwSubmit');
    const cancelBtn = overlay.querySelector('#pdfPwCancel');
    const errEl = overlay.querySelector('#pdfPwError');
    let visible = false;

    eyeBtn.addEventListener('click', () => {
      visible = !visible;
      input.type = visible ? 'text' : 'password';
      eyeBtn.querySelector('.eye-open').style.display = visible ? 'none' : '';
      eyeBtn.querySelector('.eye-closed').style.display = visible ? '' : 'none';
    });

    const doSubmit = () => {
      const pw = input.value;
      if (!pw) {
        errEl.textContent = t('viewer.pdfPasswordEmpty');
        errEl.style.display = 'block';
        input.focus();
        return;
      }
      overlay.remove();
      resolve(pw);
    };

    submitBtn.addEventListener('click', doSubmit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });
    cancelBtn.addEventListener('click', () => { overlay.remove(); reject(new Error('cancelled')); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); reject(new Error('cancelled')); } });
    setTimeout(() => input.focus(), 50);
  });

  // ── Load document (with password retry loop) ──
  const loadDocument = async () => {
    try {
      return await pdfjsLib.getDocument({ url }).promise;
    } catch (err) {
      if (err?.name !== 'PasswordException') throw err;
      // Password required — enter retry loop
      let errorMsg = '';
      while (true) {
        let pw;
        try {
          pw = await showPasswordModal(errorMsg);
        } catch { return null; } // user cancelled
        try {
          return await pdfjsLib.getDocument({ url, password: pw }).promise;
        } catch (retryErr) {
          if (retryErr?.name === 'PasswordException') {
            errorMsg = t('viewer.pdfPasswordWrong');
            continue;
          }
          throw retryErr;
        }
      }
    }
  };

  try {
    pdfDoc = await loadDocument();
    if (!pdfDoc) {
      // User cancelled password — close viewer
      cleanupCore();
      closeModal?.();
      return true;
    }
    if (loadingEl) loadingEl.remove();

    // Get first page to estimate aspect-ratio for placeholders
    const firstPage = await pdfDoc.getPage(1);
    const firstVp = firstPage.getViewport({ scale: 1 });
    const defaultAspect = firstVp.width / firstVp.height;

    // Create lightweight placeholder wraps (no canvas yet)
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.dataset.page = i;
      wrap.style.aspectRatio = `${defaultAspect}`;
      stage.appendChild(wrap);
      pages.push({
        wrap, canvas: null, rendered: false, rendering: false,
        alive: false, pageNum: i, zoom: null, currentRenderScale: 0,
        gestureCleanup: null
      });
    }

    // IntersectionObserver: render on enter, evict on leave
    const observer = new IntersectionObserver((entries) => {
      for (const ioEntry of entries) {
        const num = parseInt(ioEntry.target.dataset.page, 10);
        const pc = pages[num - 1];
        if (!pc) continue;
        if (ioEntry.isIntersecting) {
          if (!pc.rendered && !pc.rendering) renderPageCanvas(pc);
          else if (pc.alive) {
            // Touch LRU
            const idx = aliveQueue.indexOf(pc.pageNum);
            if (idx !== -1) aliveQueue.splice(idx, 1);
            aliveQueue.push(pc.pageNum);
          }
        } else {
          // Only evict if not zoomed and not currently visible
          if (pc.alive && (!pc.zoom || pc.zoom.getZoom() <= 1.01)) {
            evictPage(pc);
          }
        }
      }
    }, { root: stage, rootMargin: '300px 0px' });

    for (const pc of pages) observer.observe(pc.wrap);

    // Render first visible pages
    const initialPages = Math.min(3, pdfDoc.numPages);
    for (let i = 0; i < initialPages; i++) {
      await renderPageCanvas(pages[i]);
    }
    updateCurrentPage();

    // Scroll → page label
    let scrollTick = false;
    const onScroll = () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => { updateCurrentPage(); scrollTick = false; });
    };
    stage.addEventListener('scroll', onScroll, { passive: true });

    // Resize
    const handleResize = () => {
      if (!pdfDoc || pages.length === 0) return;
      for (const pc of pages) {
        if (pc.alive) evictPage(pc);
        observer.unobserve(pc.wrap);
        observer.observe(pc.wrap);
      }
    };
    window.addEventListener('resize', handleResize);

    // Download — inline confirm overlay (showConfirmModal destroys viewer)
    const downloadBtn = body.querySelector('#pdfDownload');
    downloadBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      const proceed = () => triggerDownload(url, name || 'file.pdf');
      const msg = t('drive.downloadPdfConfirm');
      if (msg) {
        const overlay = document.createElement('div');
        overlay.className = 'word-confirm-overlay';
        overlay.innerHTML = `<div class="word-confirm-box"><div class="word-confirm-msg">${escapeHtml(msg)}</div><div class="word-confirm-actions"><button type="button" class="word-confirm-cancel">${escapeHtml(t('common.cancel'))}</button><button type="button" class="word-confirm-ok">${escapeHtml(t('drive.download') || t('modal.confirm'))}</button></div></div>`;
        body.querySelector('.pdf-viewer')?.appendChild(overlay) || body.appendChild(overlay);
        overlay.querySelector('.word-confirm-cancel')?.addEventListener('click', () => overlay.remove(), { once: true });
        overlay.querySelector('.word-confirm-ok')?.addEventListener('click', () => { overlay.remove(); proceed(); }, { once: true });
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
      overlay.querySelector('#pdfDlOk')?.addEventListener('click', () => { cleanupConfirm(); proceed(); }, { once: true });
      document.body.appendChild(overlay);
    });

    // Close
    body.querySelector('#pdfCloseBtn')?.addEventListener('click', () => activePdfCleanup?.());
    closeBtn?.addEventListener('click', () => activePdfCleanup?.(), { once: true });
    closeArea?.addEventListener('click', () => activePdfCleanup?.(), { once: true });

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
