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
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
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

// ── OOXML Parser Helpers ──
const EMU_PX = 914400 / 96; // 1px = 9525 EMU → conversion factor
const emuToPx = (emu) => Math.round(Number(emu) / EMU_PX);

function attr(xml, name) {
  const m = xml.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function parseColor(rPr) {
  // <a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
  const srgb = rPr.match(/<a:srgbClr\s+val="([^"]+)"/);
  if (srgb) return '#' + srgb[1];
  // <a:schemeClr val="dk1"/>
  const scheme = rPr.match(/<a:schemeClr\s+val="([^"]+)"/);
  if (scheme) {
    const map = { dk1: '#1e293b', dk2: '#334155', lt1: '#ffffff', lt2: '#f1f5f9', accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47', tx1: '#1e293b', tx2: '#475569', bg1: '#ffffff', bg2: '#e2e8f0' };
    return map[scheme[1]] || '#1e293b';
  }
  return null;
}

function parseFontSize(rPr) {
  // sz="2400" → 24pt → convert to px-ish
  const sz = rPr.match(/sz="(\d+)"/);
  if (sz) return Math.round(Number(sz[1]) / 100);
  return null;
}

function parseTextRun(runXml) {
  const textMatch = runXml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/);
  const text = textMatch ? textMatch[1] : '';
  if (!text) return null;

  const rPrMatch = runXml.match(/<a:rPr[\s\S]*?(?:\/>|<\/a:rPr>)/);
  const rPr = rPrMatch ? rPrMatch[0] : '';

  const bold = /\bb="1"/.test(rPr);
  const italic = /\bi="1"/.test(rPr);
  const underline = /\bu="sng"/.test(rPr);
  const fontSize = parseFontSize(rPr);
  const color = parseColor(rPr);

  return { text, bold, italic, underline, fontSize, color };
}

function parseParagraph(pXml) {
  const runs = [];
  // Match each <a:r>...</a:r>
  const rMatches = pXml.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g);
  for (const m of rMatches) {
    const run = parseTextRun(m[1]);
    if (run) runs.push(run);
  }

  // Paragraph alignment
  const pPrMatch = pXml.match(/<a:pPr[^>]*>/);
  let align = 'left';
  if (pPrMatch) {
    const algn = attr(pPrMatch[0], 'algn');
    if (algn === 'ctr') align = 'center';
    else if (algn === 'r') align = 'right';
    else if (algn === 'just') align = 'justify';
  }

  return { runs, align };
}

function parseShape(spXml, relMap, zip, objectUrls) {
  // Get position and size from <a:off> and <a:ext>
  const offMatch = spXml.match(/<a:off\s+x="(\d+)"\s+y="(\d+)"/);
  const extMatch = spXml.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);

  const x = offMatch ? emuToPx(offMatch[1]) : 0;
  const y = offMatch ? emuToPx(offMatch[2]) : 0;
  const w = extMatch ? emuToPx(extMatch[1]) : 0;
  const h = extMatch ? emuToPx(extMatch[2]) : 0;

  // Check if this is an image shape
  const blipMatch = spXml.match(/r:embed="(rId\d+)"/);
  if (blipMatch && relMap[blipMatch[1]]) {
    return { type: 'image', x, y, w, h, rId: blipMatch[1], target: relMap[blipMatch[1]] };
  }

  // Parse text body <p:txBody>
  const txBody = spXml.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/);
  if (!txBody) return null;

  const paragraphs = [];
  const pMatches = txBody[1].matchAll(/<a:p>([\s\S]*?)<\/a:p>/g);
  for (const m of pMatches) {
    const para = parseParagraph(m[1]);
    if (para.runs.length) paragraphs.push(para);
  }
  if (!paragraphs.length) return null;

  // Shape fill
  const fillMatch = spXml.match(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/);
  const bgColor = fillMatch ? parseColor(fillMatch[0]) : null;

  return { type: 'text', x, y, w, h, paragraphs, bgColor };
}

function buildRelMap(relsXml) {
  const map = {};
  if (!relsXml) return map;
  const matches = relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g);
  for (const m of matches) map[m[1]] = m[2];
  return map;
}

function resolvePath(target) {
  const resolved = target.startsWith('/') ? target.slice(1) : 'ppt/slides/' + target;
  const parts = resolved.split('/');
  const stack = [];
  for (const p of parts) {
    if (p === '..') stack.pop();
    else if (p !== '.') stack.push(p);
  }
  return stack.join('/');
}

// Get slide dimensions from presentation.xml
async function getSlideSize(zip) {
  try {
    const presXml = await zip.file('ppt/presentation.xml')?.async('string');
    if (!presXml) return { w: 960, h: 540 };
    const sldSz = presXml.match(/<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/);
    if (sldSz) return { w: emuToPx(sldSz[1]), h: emuToPx(sldSz[2]) };
  } catch {}
  return { w: 960, h: 540 };
}

// Parse slide background
function parseSlideBg(slideXml) {
  // Solid fill background
  const bgMatch = slideXml.match(/<p:bg>([\s\S]*?)<\/p:bg>/);
  if (!bgMatch) return null;
  return parseColor(bgMatch[1]);
}

// ── Build slide DOM ──
async function buildSlideElement(slideXml, relsXml, zip, slideSize, objectUrls) {
  const relMap = buildRelMap(relsXml);
  const bgColor = parseSlideBg(slideXml) || '#ffffff';

  const slide = document.createElement('div');
  slide.className = 'pptx-slide';
  slide.style.cssText = `aspect-ratio:${slideSize.w}/${slideSize.h};background:${bgColor};position:relative;overflow:hidden;`;

  // Parse all shapes <p:sp>
  const shapes = [];
  const spMatches = slideXml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g);
  for (const m of spMatches) {
    const shape = parseShape(m[1], relMap, zip, objectUrls);
    if (shape) shapes.push(shape);
  }

  // Also parse <p:pic> (picture shapes)
  const picMatches = slideXml.matchAll(/<p:pic>([\s\S]*?)<\/p:pic>/g);
  for (const m of picMatches) {
    const offMatch = m[1].match(/<a:off\s+x="(\d+)"\s+y="(\d+)"/);
    const extMatch = m[1].match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
    const blipMatch = m[1].match(/r:embed="(rId\d+)"/);
    if (blipMatch && relMap[blipMatch[1]]) {
      shapes.push({
        type: 'image',
        x: offMatch ? emuToPx(offMatch[1]) : 0,
        y: offMatch ? emuToPx(offMatch[2]) : 0,
        w: extMatch ? emuToPx(extMatch[1]) : 0,
        h: extMatch ? emuToPx(extMatch[2]) : 0,
        rId: blipMatch[1],
        target: relMap[blipMatch[1]]
      });
    }
  }

  // Scale factor: slide is rendered at a max width, positions need to be percentage-based
  const scaleX = 100 / slideSize.w;
  const scaleY = 100 / slideSize.h;

  for (const shape of shapes) {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;left:${shape.x * scaleX}%;top:${shape.y * scaleY}%;width:${shape.w * scaleX}%;height:${shape.h * scaleY}%;overflow:hidden;`;

    if (shape.type === 'image') {
      const imgPath = resolvePath(shape.target);
      try {
        const imgFile = zip.file(imgPath);
        if (imgFile) {
          const imgBlob = await imgFile.async('blob');
          const imgUrl = URL.createObjectURL(imgBlob);
          objectUrls.push(imgUrl);
          const img = document.createElement('img');
          img.src = imgUrl;
          img.className = 'pptx-shape-img';
          img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
          img.decoding = 'async';
          el.appendChild(img);
        }
      } catch {}
    } else if (shape.type === 'text') {
      if (shape.bgColor) el.style.background = shape.bgColor;
      el.style.padding = '4px 8px';
      el.style.boxSizing = 'border-box';
      el.style.display = 'flex';
      el.style.flexDirection = 'column';
      el.style.justifyContent = 'center';

      for (const para of shape.paragraphs) {
        const pEl = document.createElement('p');
        pEl.style.cssText = `margin:0 0 2px;text-align:${para.align};line-height:1.3;`;

        for (const run of para.runs) {
          const span = document.createElement('span');
          let style = '';
          if (run.fontSize) style += `font-size:${run.fontSize}pt;`;
          if (run.color) style += `color:${run.color};`;
          if (run.bold) style += 'font-weight:700;';
          if (run.italic) style += 'font-style:italic;';
          if (run.underline) style += 'text-decoration:underline;';
          if (style) span.style.cssText = style;
          span.textContent = run.text;
          pEl.appendChild(span);
        }
        el.appendChild(pEl);
      }
    }

    slide.appendChild(el);
  }

  return slide;
}

// ── Main Viewer ──
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

    // Get slide dimensions
    const slideSize = await getSlideSize(zip);

    // Find all slides
    const slideFiles = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
        const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
        return na - nb;
      });

    if (!slideFiles.length) throw new Error('No slides found');
    if (loadingEl) loadingEl.remove();

    // Parse and build each slide
    const slideEls = [];
    for (const slideFile of slideFiles) {
      const slideXml = await zip.file(slideFile)?.async('string');
      if (!slideXml) continue;
      const slideNum = slideFile.match(/slide(\d+)/)?.[1] || '1';
      const relsFile = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
      const relsXml = await zip.file(relsFile)?.async('string').catch(() => null);
      const slideEl = await buildSlideElement(slideXml, relsXml, zip, slideSize, objectUrls);
      slideEls.push(slideEl);
    }

    if (!slideEls.length) throw new Error('No slide content');

    // Show slides
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
        showConfirmModal({ title: t('viewer.downloadPptx'), message: t('drive.downloadPdfConfirm'), confirmLabel: t('drive.download'), onConfirm: proceed });
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
