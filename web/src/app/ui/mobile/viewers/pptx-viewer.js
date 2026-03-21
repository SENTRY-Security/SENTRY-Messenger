import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';

const JSZIP_URL = '/assets/libs/jszip.min.js';
let activePptxCleanup = null;

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

// Extract text from slide XML
function extractSlideText(xml) {
  const texts = [];
  // Match all <a:t> text nodes
  const matches = xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g);
  let currentParagraph = [];
  let lastIdx = 0;

  // Also track paragraph breaks <a:p>
  const paragraphs = [];
  const pBlocks = xml.split(/<\/a:p>/);
  for (const block of pBlocks) {
    const lineTexts = [];
    const tMatches = block.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g);
    for (const m of tMatches) {
      lineTexts.push(m[1]);
    }
    if (lineTexts.length) paragraphs.push(lineTexts.join(''));
  }
  return paragraphs;
}

// Extract image relationships from slide XML + rels
function extractSlideImages(slideXml, relsXml, zip) {
  const images = [];
  if (!relsXml) return images;

  // Build relationship map
  const relMap = {};
  const relMatches = relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g);
  for (const m of relMatches) {
    relMap[m[1]] = m[2];
  }

  // Find image references in slide XML: <a:blip r:embed="rIdX"/>
  const blipMatches = slideXml.matchAll(/r:embed="(rId\d+)"/g);
  for (const m of blipMatches) {
    const target = relMap[m[1]];
    if (target && /\.(png|jpg|jpeg|gif|bmp|svg|webp|emf|wmf|tiff?)$/i.test(target)) {
      // Resolve path relative to ppt/slides/
      const resolved = target.startsWith('/') ? target.slice(1) : 'ppt/slides/' + target;
      const normalized = resolved.replace(/\/\.\.\//g, () => { return '/'; });
      // Simple path normalization
      const parts = normalized.split('/');
      const stack = [];
      for (const p of parts) {
        if (p === '..') stack.pop();
        else if (p !== '.') stack.push(p);
      }
      images.push(stack.join('/'));
    }
  }
  return images;
}

export async function renderPptxViewer({ url, blob, name, modalApi }) {
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

    const zip = await JSZip.loadAsync(arrayBuffer);
    if (loadingEl) loadingEl.remove();

    // Find all slides
    const slideFiles = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
        const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
        return na - nb;
      });

    if (!slideFiles.length) throw new Error('No slides found');

    // Parse each slide
    const slides = [];
    for (const slideFile of slideFiles) {
      const slideXml = await zip.file(slideFile)?.async('string');
      if (!slideXml) continue;
      const slideNum = slideFile.match(/slide(\d+)/)?.[1] || '1';
      const relsFile = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
      const relsXml = await zip.file(relsFile)?.async('string').catch(() => null);

      const texts = extractSlideText(slideXml);
      const imagePaths = extractSlideImages(slideXml, relsXml, zip);

      // Load images as blob URLs
      const imageUrls = [];
      for (const imgPath of imagePaths) {
        try {
          const imgFile = zip.file(imgPath);
          if (!imgFile) continue;
          const imgBlob = await imgFile.async('blob');
          const imgUrl = URL.createObjectURL(imgBlob);
          objectUrls.push(imgUrl);
          imageUrls.push(imgUrl);
        } catch {}
      }

      slides.push({ texts, imageUrls, num: slides.length + 1 });
    }

    if (!slides.length) throw new Error('No slide content');

    // Build slide elements
    const slideEls = [];
    for (const slide of slides) {
      const el = document.createElement('div');
      el.className = 'pptx-slide';

      let html = '';
      // Images
      if (slide.imageUrls.length) {
        html += '<div class="pptx-slide-images">';
        for (const imgUrl of slide.imageUrls) {
          html += `<img src="${imgUrl}" class="pptx-slide-img" alt="" decoding="async" />`;
        }
        html += '</div>';
      }
      // Text
      if (slide.texts.length) {
        html += '<div class="pptx-slide-text">';
        for (const line of slide.texts) {
          html += `<p>${escapeHtml(line)}</p>`;
        }
        html += '</div>';
      }
      if (!html) {
        html = `<div class="pptx-slide-empty">${t('viewer.pptxSlideEmpty')}</div>`;
      }

      el.innerHTML = html;
      slideEls.push(el);
    }

    // Show first slide
    let currentSlide = 0;
    const showSlide = (idx) => {
      if (idx < 0 || idx >= slideEls.length) return;
      currentSlide = idx;
      stageEl.innerHTML = '';
      stageEl.appendChild(slideEls[idx]);
      pageLabel.textContent = `${idx + 1} / ${slideEls.length}`;
    };
    showSlide(0);

    // Navigation
    body.querySelector('#pptxPrev')?.addEventListener('click', () => showSlide(currentSlide - 1));
    body.querySelector('#pptxNext')?.addEventListener('click', () => showSlide(currentSlide + 1));

    // Swipe
    let touchStartX = 0;
    stageEl.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) touchStartX = e.touches[0].clientX;
    }, { passive: true });
    stageEl.addEventListener('touchend', (e) => {
      if (e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 60) showSlide(currentSlide + (dx < 0 ? 1 : -1));
    }, { passive: true });

    // Keyboard
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') showSlide(currentSlide - 1);
      else if (e.key === 'ArrowRight') showSlide(currentSlide + 1);
    };
    document.addEventListener('keydown', onKey);

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
      cleanup();
      document.removeEventListener('keydown', onKey);
      modalEl.classList.remove('pptx-modal');
      closeModal?.();
      activePptxCleanup = null;
    };
  } catch (err) {
    log({ pptxViewerError: err?.message || err });
    // Show error with download fallback
    stageEl.innerHTML = `
      <div class="viewer-error-state">
        <div class="viewer-error-msg">${escapeHtml(t('viewer.pptxLoadFailed', { error: err?.message || err }))}</div>
        <button type="button" class="viewer-error-download" id="pptxErrorDownload">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          ${t('viewer.downloadPptx')}
        </button>
      </div>`;
    stageEl.querySelector('#pptxErrorDownload')?.addEventListener('click', () => triggerDownload(url, name || 'file.pptx'));
    // Always set up close handlers even on error
    const doClose = () => activePptxCleanup?.();
    body.querySelector('#pptxCloseBtn')?.addEventListener('click', doClose);
    closeBtn?.addEventListener('click', doClose, { once: true });
    closeArea?.addEventListener('click', doClose, { once: true });
    const prevCleanup = activePptxCleanup;
    activePptxCleanup = () => {
      if (typeof prevCleanup === 'function') prevCleanup();
      cleanup();
      modalEl.classList.remove('pptx-modal');
      closeModal?.();
      activePptxCleanup = null;
    };
    return true;
  }

  return true;
}
