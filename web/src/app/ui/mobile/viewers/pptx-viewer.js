import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';

const PPTX_LIB_URL = '/assets/libs/pptx-preview.min.mjs';
let pptxLibPromise = null;
let activePptxCleanup = null;

async function getPptxPreview() {
  if (pptxLibPromise) return pptxLibPromise;
  pptxLibPromise = import(/* webpackIgnore: true */ PPTX_LIB_URL)
    .then((mod) => mod)
    .catch((err) => { pptxLibPromise = null; throw err; });
  return pptxLibPromise;
}

export function cleanupPptxViewer() {
  if (typeof activePptxCleanup === 'function') {
    try { activePptxCleanup(); } catch {}
  }
  activePptxCleanup = null;
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
    log({ pptxDownloadError: err?.message || err });
  }
}

const PPTX_MIMES = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12'
];

export function isPptxMime(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return PPTX_MIMES.some(m => lower === m);
}

export function isPptxFilename(name) {
  if (!name) return false;
  return /\.(pptx|ppt|pptm)$/i.test(name);
}

export async function renderPptxViewer({ url, blob, name, modalApi }) {
  const { openModal, closeModal, showConfirmModal } = modalApi || {};
  let pptxMod;
  try {
    pptxMod = await getPptxPreview();
  } catch (err) {
    log({ pptxLibLoadError: err?.message || err });
    return false;
  }

  if (!pptxMod?.init) {
    log({ pptxLibError: 'init not found' });
    return false;
  }

  const modalEl = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const modalTitle = document.getElementById('modalTitle');
  const closeBtn = document.getElementById('modalClose');
  const closeArea = document.getElementById('modalCloseArea');
  if (!modalEl || !body || !modalTitle) return false;

  cleanupPptxViewer();
  modalEl.classList.add('pptx-modal');
  modalTitle.textContent = '';

  body.innerHTML = `
    <div class="pptx-viewer">
      <div class="pptx-toolbar">
        <button type="button" class="pptx-btn" id="pptxCloseBtn" aria-label="${t('viewer.close')}">
          <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="pptx-title" title="${escapeHtml(name || 'PowerPoint')}">${escapeHtml(name || 'PowerPoint')}</div>
        <span class="pptx-page-label" id="pptxPageLabel">– / –</span>
        <div class="pptx-actions">
          <button type="button" class="pptx-btn" id="pptxDownload" aria-label="${t('viewer.downloadPptx')}">
            <svg viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="pptx-stage" id="pptxStage">
        <div class="pptx-loading" id="pptxLoading">${t('common.loading')}</div>
      </div>
      <div class="pptx-nav">
        <button type="button" class="pptx-nav-btn" id="pptxPrev" aria-label="${t('viewer.prevPage')}">
          <svg viewBox="0 0 16 16" width="20" height="20" fill="none"><path d="M10 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button type="button" class="pptx-nav-btn" id="pptxNext" aria-label="${t('viewer.nextPage')}">
          <svg viewBox="0 0 16 16" width="20" height="20" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>`;
  openModal?.();

  const loadingEl = body.querySelector('#pptxLoading');
  const stageEl = body.querySelector('#pptxStage');
  const pageLabel = body.querySelector('#pptxPageLabel');
  let pptxInstance = null;

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

    // Create render container inside stage
    const renderContainer = document.createElement('div');
    renderContainer.className = 'pptx-render-container';
    stageEl.appendChild(renderContainer);

    // Get stage dimensions for sizing
    const stageW = stageEl.clientWidth || 960;
    const stageH = stageEl.clientHeight || 540;

    pptxInstance = pptxMod.init(renderContainer, {
      width: Math.min(stageW, 960),
      height: Math.min(stageH, 540)
    });

    await pptxInstance.preview(arrayBuffer);
    if (loadingEl) loadingEl.remove();

    // Count slides
    const slides = renderContainer.querySelectorAll('.slide-wrapper, [class*="slide"]');
    const totalSlides = slides.length || 1;
    let currentSlide = 0;

    const updateLabel = () => {
      pageLabel.textContent = `${currentSlide + 1} / ${totalSlides}`;
    };
    updateLabel();

    // Navigation
    const goTo = (idx) => {
      if (idx < 0 || idx >= totalSlides) return;
      currentSlide = idx;
      try {
        pptxInstance.renderSingleSlide(idx);
      } catch {
        // Fallback: scroll to slide
        const target = slides[idx];
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      updateLabel();
    };

    body.querySelector('#pptxPrev')?.addEventListener('click', () => goTo(currentSlide - 1));
    body.querySelector('#pptxNext')?.addEventListener('click', () => goTo(currentSlide + 1));

    // Swipe navigation
    let touchStartX = 0;
    stageEl.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) touchStartX = e.touches[0].clientX;
    }, { passive: true });
    stageEl.addEventListener('touchend', (e) => {
      if (e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 60) {
        goTo(currentSlide + (dx < 0 ? 1 : -1));
      }
    }, { passive: true });

    // Download
    body.querySelector('#pptxDownload')?.addEventListener('click', (e) => {
      e.preventDefault();
      const proceed = () => triggerDownload(url, name || 'file.pptx');
      if (typeof showConfirmModal === 'function') {
        showConfirmModal({
          title: t('viewer.downloadPptx'),
          message: t('drive.downloadPdfConfirm'),
          confirmLabel: t('drive.download'),
          onConfirm: proceed
        });
        return;
      }
      proceed();
    });

    // Close
    const doClose = () => activePptxCleanup?.();
    body.querySelector('#pptxCloseBtn')?.addEventListener('click', doClose);
    closeBtn?.addEventListener('click', doClose, { once: true });
    closeArea?.addEventListener('click', doClose, { once: true });

    const prevCleanup = activePptxCleanup;
    activePptxCleanup = () => {
      if (typeof prevCleanup === 'function') prevCleanup();
      try { pptxInstance?.destroy?.(); } catch {}
      modalEl.classList.remove('pptx-modal');
      closeModal?.();
      activePptxCleanup = null;
    };
  } catch (err) {
    log({ pptxViewerError: err?.message || err });
    if (loadingEl) {
      loadingEl.textContent = t('viewer.pptxLoadFailed', { error: err?.message || err });
      loadingEl.classList.add('pptx-error');
    }
    return true;
  }

  return true;
}
