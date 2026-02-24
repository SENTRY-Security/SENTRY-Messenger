/**
 * Transfer Progress Module (singleton)
 *
 * Manages a top-pinned progress bar for upload/download transfers.
 * Enforces: at most one upload + one download active simultaneously.
 * Renders up to two horizontal bars stacked vertically at the top of the chat scroll area.
 *
 * All DOM elements and event listeners are created exactly once.
 * Cancel buttons read the current onCancel from module-level state at click-time,
 * so no listener re-registration is needed when the callback changes.
 */

// ── SVG icons ──────────────────────────────────────────────────────────────

const UPLOAD_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>';

const CANCEL_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

// ── Singleton state ────────────────────────────────────────────────────────

let _initialized = false;
let _containerEl = null;

// Each: { name, percent, onCancel } | null
let _upload = null;
let _download = null;

// Pre-created once, reused forever — never recreated or cloned.
let _uploadBarEl = null;
let _downloadBarEl = null;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Idempotent init. Safe to call multiple times; only the first call creates DOM.
 * If the scrollEl changes (unlikely), re-attaches the existing container.
 */
export function initTransferProgress(scrollEl) {
    if (!scrollEl) return;

    if (!_initialized) {
        _containerEl = document.createElement('div');
        _containerEl.className = 'transfer-progress-container';
        _containerEl.style.display = 'none';

        // Create both bars once with permanent click listeners
        _uploadBarEl = _createBarElement('upload', () => _upload?.onCancel?.());
        _downloadBarEl = _createBarElement('download', () => _download?.onCancel?.());

        _initialized = true;
    }

    // (Re-)attach container if not already a child of this scrollEl
    if (_containerEl.parentElement !== scrollEl) {
        scrollEl.insertBefore(_containerEl, scrollEl.firstChild);
    }
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
    _attachBar(_uploadBarEl, true);
    _updateBar(_uploadBarEl, _upload);
    _updateVisibility();
}

export function updateUploadProgress(percent) {
    if (!_upload) return;
    _upload.percent = percent;
    _updateBar(_uploadBarEl, _upload);
}

export function endUpload() {
    _upload = null;
    _detachBar(_uploadBarEl);
    _updateVisibility();
}

/**
 * Start showing download progress.
 * @param {string} name - file name
 * @param {Function} onCancel - called when user clicks cancel
 */
export function startDownload(name, onCancel) {
    _download = { name: name || '檔案', percent: 0, onCancel };
    _attachBar(_downloadBarEl, false);
    _updateBar(_downloadBarEl, _download);
    _updateVisibility();
}

export function updateDownloadProgress(percent) {
    if (!_download) return;
    _download.percent = percent;
    _updateBar(_downloadBarEl, _download);
}

export function endDownload() {
    _download = null;
    _detachBar(_downloadBarEl);
    _updateVisibility();
}

// ── Internal helpers (no listener registration) ────────────────────────────

function _updateVisibility() {
    if (!_containerEl) return;
    _containerEl.style.display = (_upload || _download) ? '' : 'none';
}

function _attachBar(barEl, prepend) {
    if (!_containerEl || !barEl) return;
    if (barEl.parentElement === _containerEl) return; // already attached
    if (prepend) {
        _containerEl.insertBefore(barEl, _containerEl.firstChild);
    } else {
        _containerEl.appendChild(barEl);
    }
}

function _detachBar(barEl) {
    if (barEl?.parentElement) barEl.remove();
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

/**
 * Create a bar element once. The cancel button's click handler reads
 * the current onCancel from module state at click-time (no re-binding needed).
 */
function _createBarElement(type, onCancelThunk) {
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
    // Single permanent listener — reads current callback via thunk at click-time
    cancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onCancelThunk();
    });

    bar.appendChild(icon);
    bar.appendChild(info);
    bar.appendChild(pctEl);
    bar.appendChild(cancelBtn);

    return bar;
}
