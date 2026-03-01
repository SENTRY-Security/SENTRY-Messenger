/**
 * Transfer Progress Module (singleton)
 *
 * Manages a top-pinned progress bar for upload/download transfers.
 * Enforces: at most one upload + one download active simultaneously.
 * Renders up to two horizontal bars stacked vertically at the top of the chat scroll area.
 *
 * Upload bar includes an expandable detail panel showing processing steps
 * (format detection, transcode, remux, upload) with status indicators.
 *
 * All DOM elements and event listeners are created exactly once.
 * Cancel buttons read the current onCancel from module-level state at click-time,
 * so no listener re-registration is needed when the callback changes.
 */

// ── SVG icons ──────────────────────────────────────────────────────────────

const UPLOAD_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>';

const CANCEL_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const INFO_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

const STEP_ICONS = {
    done: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="7" fill="#22c55e"/><path d="M5 8l2 2 4-4" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="7" fill="#f59e0b"/><path d="M8 5v3" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/><circle cx="8" cy="11" r="0.8" fill="#fff"/></svg>',
    error: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="7" fill="#ef4444"/><path d="M6 6l4 4M10 6l-4 4" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
    skip: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6.5" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1"/><line x1="5" y1="8" x2="11" y2="8" stroke="rgba(255,255,255,0.4)" stroke-width="1.5" stroke-linecap="round"/></svg>',
    pending: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6.5" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1"/></svg>',
};

// ── Singleton state ────────────────────────────────────────────────────────

let _initialized = false;
let _containerEl = null;

// Each: { name, percent, onCancel } | null
let _upload = null;
let _download = null;

// Pre-created once, reused forever — never recreated or cloned.
let _uploadBarEl = null;
let _downloadBarEl = null;

// Upload detail panel (expandable checklist)
let _uploadDetailPanelEl = null;
let _uploadDetailBtnEl = null;
let _uploadSteps = [];
let _detailExpanded = false;

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

        // Create upload detail panel once
        _uploadDetailPanelEl = document.createElement('div');
        _uploadDetailPanelEl.className = 'transfer-bar-detail-panel';
        _uploadDetailPanelEl.style.display = 'none';

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
    _uploadSteps = [];
    _detailExpanded = false;
    if (_uploadDetailBtnEl) _uploadDetailBtnEl.style.display = 'none';
    if (_uploadDetailPanelEl) {
        _uploadDetailPanelEl.style.display = 'none';
        _uploadDetailPanelEl.innerHTML = '';
    }
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
    _uploadSteps = [];
    _detailExpanded = false;
    if (_uploadDetailBtnEl) {
        _uploadDetailBtnEl.style.display = 'none';
        _uploadDetailBtnEl.classList.remove('active');
    }
    if (_uploadDetailPanelEl) {
        _uploadDetailPanelEl.style.display = 'none';
        _uploadDetailPanelEl.innerHTML = '';
    }
    _detachBar(_uploadBarEl);
    _updateVisibility();
}

/**
 * Update the upload detail panel's processing steps checklist.
 * Only shown for video uploads. The info button becomes visible when steps
 * are provided, and hidden when cleared.
 *
 * @param {Array<{ label: string, status: 'pending'|'active'|'done'|'warn'|'error'|'skip', detail?: string }>} steps
 */
export function updateUploadSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
        _uploadSteps = [];
        if (_uploadDetailBtnEl) _uploadDetailBtnEl.style.display = 'none';
        if (_detailExpanded && _uploadDetailPanelEl) {
            _uploadDetailPanelEl.style.display = 'none';
            _detailExpanded = false;
        }
        return;
    }
    _uploadSteps = steps;
    if (_uploadDetailBtnEl) _uploadDetailBtnEl.style.display = '';
    if (_detailExpanded) _renderSteps();
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
    // Attach detail panel right after upload bar
    if (barEl === _uploadBarEl && _uploadDetailPanelEl) {
        barEl.insertAdjacentElement('afterend', _uploadDetailPanelEl);
    }
}

function _detachBar(barEl) {
    if (barEl === _uploadBarEl && _uploadDetailPanelEl?.parentElement) {
        _uploadDetailPanelEl.remove();
    }
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

function _toggleDetailPanel() {
    _detailExpanded = !_detailExpanded;
    if (_uploadDetailPanelEl) {
        if (_detailExpanded) {
            _renderSteps();
            _uploadDetailPanelEl.style.display = '';
        } else {
            _uploadDetailPanelEl.style.display = 'none';
        }
    }
    if (_uploadDetailBtnEl) {
        _uploadDetailBtnEl.classList.toggle('active', _detailExpanded);
    }
}

function _renderSteps() {
    if (!_uploadDetailPanelEl) return;
    _uploadDetailPanelEl.innerHTML = '';
    for (const step of _uploadSteps) {
        const row = document.createElement('div');
        row.className = 'transfer-step';
        row.dataset.status = step.status || 'pending';

        const iconEl = document.createElement('span');
        iconEl.className = 'transfer-step-icon';
        if (step.status === 'active') {
            iconEl.innerHTML = '<span class="transfer-step-spinner"></span>';
        } else {
            iconEl.innerHTML = STEP_ICONS[step.status] || STEP_ICONS.pending;
        }

        const labelEl = document.createElement('span');
        labelEl.className = 'transfer-step-label';
        labelEl.textContent = step.label;

        row.appendChild(iconEl);
        row.appendChild(labelEl);

        if (step.detail) {
            const detailEl = document.createElement('span');
            detailEl.className = 'transfer-step-detail';
            detailEl.textContent = step.detail;
            row.appendChild(detailEl);
        }

        _uploadDetailPanelEl.appendChild(row);
    }
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

    // Info button (upload only) — toggles the detail steps panel
    if (type === 'upload') {
        const detailBtn = document.createElement('button');
        detailBtn.type = 'button';
        detailBtn.className = 'transfer-bar-detail-btn';
        detailBtn.title = '詳細資訊';
        detailBtn.innerHTML = INFO_ICON;
        detailBtn.style.display = 'none';
        detailBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            _toggleDetailPanel();
        });
        _uploadDetailBtnEl = detailBtn;
        bar.appendChild(detailBtn);
    }

    bar.appendChild(cancelBtn);

    return bar;
}
