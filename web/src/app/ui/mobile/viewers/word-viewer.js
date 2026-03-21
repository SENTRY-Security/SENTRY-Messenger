import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';

const DOCX_LIB_URL = '/assets/libs/docx-preview.min.mjs';
let docxLibPromise = null;
let activeWordCleanup = null;

async function getDocxPreview() {
  if (docxLibPromise) return docxLibPromise;
  docxLibPromise = import(/* webpackIgnore: true */ DOCX_LIB_URL)
    .then((mod) => mod.default || mod.docx || mod)
    .catch((err) => { docxLibPromise = null; throw err; });
  return docxLibPromise;
}

export function cleanupWordViewer() {
  if (typeof activeWordCleanup === 'function') {
    try { activeWordCleanup(); } catch {}
  }
  activeWordCleanup = null;
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
    log({ wordDownloadError: err?.message || err });
  }
}

const WORD_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.ms-word.document.macroenabled.12'
];

export function isWordMime(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return WORD_MIMES.some(m => lower === m || lower.startsWith(m));
}

export function isWordFilename(name) {
  if (!name) return false;
  return /\.(docx|doc|docm)$/i.test(name);
}

export async function renderWordViewer({ url, blob, name, modalApi }) {
  const { openModal, closeModal, showConfirmModal } = modalApi || {};
  let docxLib;
  try {
    docxLib = await getDocxPreview();
  } catch (err) {
    log({ docxLibLoadError: err?.message || err });
    return false;
  }

  if (!docxLib?.renderAsync) {
    log({ docxLibError: 'renderAsync not found' });
    return false;
  }

  const modalEl = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const modalTitle = document.getElementById('modalTitle');
  const closeBtn = document.getElementById('modalClose');
  const closeArea = document.getElementById('modalCloseArea');
  if (!modalEl || !body || !modalTitle) return false;

  cleanupWordViewer();
  modalEl.classList.add('word-modal');
  modalTitle.textContent = '';

  body.innerHTML = `
    <div class="word-viewer">
      <div class="word-toolbar">
        <button type="button" class="word-btn" id="wordCloseBtn" aria-label="${t('viewer.close')}">
          <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="word-title" title="${escapeHtml(name || 'Word')}">${escapeHtml(name || 'Word')}</div>
        <div class="word-actions">
          <button type="button" class="word-btn" id="wordDownload" aria-label="${t('viewer.downloadWord')}">
            <svg viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="word-stage" id="wordStage">
        <div class="word-loading" id="wordLoading">${t('common.loading')}</div>
      </div>
    </div>`;
  openModal?.();

  const loadingEl = body.querySelector('#wordLoading');
  const stageEl = body.querySelector('#wordStage');

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

    // Create a container for docx-preview to render into
    const docContainer = document.createElement('div');
    docContainer.className = 'word-doc-container';

    await docxLib.renderAsync(arrayBuffer, docContainer, null, {
      className: 'word-docx',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
      trimXmlDeclaration: true,
      useBase64URL: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true
    });

    if (loadingEl) loadingEl.remove();
    stageEl.appendChild(docContainer);

    // Download
    const downloadBtn = body.querySelector('#wordDownload');
    downloadBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      const proceed = () => triggerDownload(url, name || 'file.docx');
      if (typeof showConfirmModal === 'function') {
        showConfirmModal({
          title: t('viewer.downloadWord'),
          message: t('drive.downloadPdfConfirm'),
          confirmLabel: t('drive.download'),
          onConfirm: proceed
        });
        return;
      }
      proceed();
    });

    // Close
    const doClose = () => activeWordCleanup?.();
    body.querySelector('#wordCloseBtn')?.addEventListener('click', doClose);
    closeBtn?.addEventListener('click', doClose, { once: true });
    closeArea?.addEventListener('click', doClose, { once: true });

    const prevCleanup = activeWordCleanup;
    activeWordCleanup = () => {
      if (typeof prevCleanup === 'function') prevCleanup();
      modalEl.classList.remove('word-modal');
      closeModal?.();
      activeWordCleanup = null;
    };
  } catch (err) {
    log({ wordViewerError: err?.message || err });
    if (loadingEl) {
      loadingEl.textContent = t('viewer.wordLoadFailed', { error: err?.message || err });
      loadingEl.classList.add('word-error');
    }
    return true;
  }

  return true;
}
