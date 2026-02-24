/**
 * Transfer Progress Module
 *
 * Manages a top-pinned progress bar for upload/download transfers.
 * Enforces: at most one upload + one download active simultaneously.
 * Renders up to two horizontal bars stacked vertically at the top of the chat scroll area.
 */

// ── SVG icons ──────────────────────────────────────────────────────────────

const UPLOAD_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>';

const CANCEL_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

// ── State ──────────────────────────────────────────────────────────────────

let _scrollEl = null;
let _containerEl = null;

// Each: { name, percent, onCancel } | null
let _upload = null;
let _download = null;

// Pre-created bar elements (reused, not recreated each render)
let _uploadBarEl = null;
let _downloadBarEl = null;

// ── Public API ─────────────────────────────────────────────────────────────

/** Call once after DOM is ready. Pass the messages-scroll element. */
export function initTransferProgress(scrollEl) {
    _scrollEl = scrollEl;
    if (!_scrollEl) return;
    _containerEl = document.createElement('div');
    _containerEl.className = 'transfer-progress-container';
    _containerEl.style.display = 'none';
    _scrollEl.insertBefore(_containerEl, _scrollEl.firstChild);
}

export function isUploadBusy() { return !!_upload; }
export function isDownloadBusy() { return !!_download; }

/**
 * Start showing upload progress.
 * @param {string} name - file name
 * @param {Function} onCancel - called when user clicks cancel
 */
export function startUpload(name, onCancel) {
    _upload = { name: name || '檔案', percent: 0, onCancel };
    _renderUpload();
    _updateVisibility();
}

export function updateUploadProgress(percent) {
    if (!_upload) return;
    _upload.percent = percent;
    _updateBar(_uploadBarEl, _upload);
}

export function endUpload() {
    _upload = null;
    if (_uploadBarEl) {
        _uploadBarEl.remove();
        _uploadBarEl = null;
    }
    _updateVisibility();
}

/**
 * Start showing download progress.
 * @param {string} name - file name
 * @param {Function} onCancel - called when user clicks cancel
 */
export function startDownload(name, onCancel) {
    _download = { name: name || '檔案', percent: 0, onCancel };
    _renderDownload();
    _updateVisibility();
}

export function updateDownloadProgress(percent) {
    if (!_download) return;
    _download.percent = percent;
    _updateBar(_downloadBarEl, _download);
}

export function endDownload() {
    _download = null;
    if (_downloadBarEl) {
        _downloadBarEl.remove();
        _downloadBarEl = null;
    }
    _updateVisibility();
}

// ── Internal rendering ─────────────────────────────────────────────────────

function _updateVisibility() {
    if (!_containerEl) return;
    _containerEl.style.display = (_upload || _download) ? '' : 'none';
}

function _renderUpload() {
    if (!_containerEl || !_upload) return;
    if (!_uploadBarEl) {
        _uploadBarEl = _createBarElement('upload');
        // Upload bar always first
        _containerEl.insertBefore(_uploadBarEl, _containerEl.firstChild);
    }
    _updateBar(_uploadBarEl, _upload);
    _wireCancel(_uploadBarEl, () => {
        _upload?.onCancel?.();
    });
}

function _renderDownload() {
    if (!_containerEl || !_download) return;
    if (!_downloadBarEl) {
        _downloadBarEl = _createBarElement('download');
        _containerEl.appendChild(_downloadBarEl);
    }
    _updateBar(_downloadBarEl, _download);
    _wireCancel(_downloadBarEl, () => {
        _download?.onCancel?.();
    });
}

function _updateBar(barEl, state) {
    if (!barEl || !state) return;
    const nameEl = barEl.querySelector('.transfer-bar-name');
    const inner = barEl.querySelector('.transfer-bar-progress-inner');
    const pctEl = barEl.querySelector('.transfer-bar-pct');
    const pct = Math.min(100, Math.max(0, Math.round(state.percent || 0)));
    if (nameEl) nameEl.textContent = state.name || '檔案';
    if (inner) inner.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
}

function _wireCancel(barEl, handler) {
    const btn = barEl?.querySelector('.transfer-bar-cancel');
    if (!btn) return;
    // Replace to avoid duplicate listeners
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handler();
    });
}

function _createBarElement(type) {
    const bar = document.createElement('div');
    bar.className = `transfer-bar transfer-bar--${type}`;

    const icon = document.createElement('div');
    icon.className = 'transfer-bar-icon';
    icon.innerHTML = type === 'upload' ? UPLOAD_ICON : DOWNLOAD_ICON;

    const info = document.createElement('div');
    info.className = 'transfer-bar-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'transfer-bar-name';

    const progressWrap = document.createElement('div');
    progressWrap.className = 'transfer-bar-progress';
    const progressInner = document.createElement('div');
    progressInner.className = 'transfer-bar-progress-inner';
    progressWrap.appendChild(progressInner);

    info.appendChild(nameEl);
    info.appendChild(progressWrap);

    const pctEl = document.createElement('div');
    pctEl.className = 'transfer-bar-pct';
    pctEl.textContent = '0%';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'transfer-bar-cancel';
    cancelBtn.title = '取消';
    cancelBtn.innerHTML = CANCEL_ICON;

    bar.appendChild(icon);
    bar.appendChild(info);
    bar.appendChild(pctEl);
    bar.appendChild(cancelBtn);

    return bar;
}
