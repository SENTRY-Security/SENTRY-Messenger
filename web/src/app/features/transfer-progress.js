/**
 * Transfer Progress Module (singleton)
 *
 * Manages a top-pinned progress bar for upload/download transfers.
 * Enforces: at most one upload + one download active simultaneously.
 * Renders up to two horizontal bars stacked vertically at the top of the chat scroll area.
 *
 * Upload bar includes an expandable detail panel showing:
 *   - Upload stats: uploaded/total bytes + upload speed
 *   - Processing steps (format detection, transcode, remux, upload) with status indicators.
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

// Upload stats tracking
let _uploadLoaded = 0;
let _uploadTotal = 0;
let _uploadSpeedSamples = [];   // { time, loaded } ring buffer for speed calc
let _uploadStatsEl = null;      // DOM element inside detail panel
let _statsRefreshTimer = null;  // 1s interval for reliable stats refresh

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
 * @param {{ fileSize?: number }} [opts] - optional metadata
 */
export function startUpload(name, onCancel, opts) {
    _upload = { name: name || '檔案', percent: 0, onCancel };
    _uploadSteps = [];
    _detailExpanded = false;
    _uploadLoaded = 0;
    _uploadTotal = (opts?.fileSize > 0) ? opts.fileSize : 0;
    _uploadSpeedSamples = [];
    _uploadStatsEl = null;
    if (_uploadDetailBtnEl) {
        _uploadDetailBtnEl.style.display = '';
        _uploadDetailBtnEl.classList.remove('active');
    }
    if (_uploadDetailPanelEl) {
        _uploadDetailPanelEl.style.display = 'none';
        _uploadDetailPanelEl.innerHTML = '';
    }
    _attachBar(_uploadBarEl, true);
    _updateBar(_uploadBarEl, _upload);
    _updateVisibility();
}

/**
 * Update upload progress.
 * @param {number} percent - 0-100
 * @param {{ loaded?: number, total?: number }} [stats] - byte-level stats for speed display
 */
export function updateUploadProgress(percent, stats) {
    if (!_upload) return;
    _upload.percent = percent;
    _updateBar(_uploadBarEl, _upload);

    // Track byte-level stats for speed calculation
    if (stats && Number.isFinite(stats.loaded)) {
        _uploadLoaded = stats.loaded;
        if (Number.isFinite(stats.total) && stats.total > 0) _uploadTotal = stats.total;

        const now = Date.now();
        _uploadSpeedSamples.push({ time: now, loaded: stats.loaded });
        // Keep only samples from the last 5 seconds for a smooth rolling average
        while (_uploadSpeedSamples.length > 1 && now - _uploadSpeedSamples[0].time > 5000) {
            _uploadSpeedSamples.shift();
        }
    }

    // Update stats display if detail panel is open
    if (_detailExpanded) _updateStatsDisplay();
}

export function endUpload() {
    _upload = null;
    _uploadSteps = [];
    _detailExpanded = false;
    _uploadLoaded = 0;
    _uploadTotal = 0;
    _uploadSpeedSamples = [];
    _uploadStatsEl = null;
    _stopStatsRefresh();
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
        // Don't hide the info button — it always shows upload stats now
        if (_detailExpanded) _renderDetailContent();
        return;
    }
    // Fast path: if step count and statuses are unchanged, only update pies
    if (_detailExpanded && _uploadSteps.length === steps.length &&
        steps.every((s, i) => s.status === _uploadSteps[i].status && s.label === _uploadSteps[i].label)) {
        _uploadSteps = steps;
        _updateStepPies();
        return;
    }
    _uploadSteps = steps;
    if (_detailExpanded) _renderDetailContent();
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
            _renderDetailContent();
            _uploadDetailPanelEl.style.display = '';
            _startStatsRefresh();
        } else {
            _uploadDetailPanelEl.style.display = 'none';
            _stopStatsRefresh();
        }
    }
    if (_uploadDetailBtnEl) {
        _uploadDetailBtnEl.classList.toggle('active', _detailExpanded);
    }
}

/** Start a 1s interval that refreshes the stats display while the panel is open */
function _startStatsRefresh() {
    _stopStatsRefresh();
    _statsRefreshTimer = setInterval(() => {
        if (!_upload || !_detailExpanded) {
            _stopStatsRefresh();
            return;
        }
        _updateStatsDisplay();
    }, 1000);
}

function _stopStatsRefresh() {
    if (_statsRefreshTimer) {
        clearInterval(_statsRefreshTimer);
        _statsRefreshTimer = null;
    }
}

/** Format bytes to human-readable string */
function _fmtBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Calculate upload speed from rolling samples (bytes/sec) */
function _calcSpeed() {
    if (_uploadSpeedSamples.length < 2) return 0;
    const first = _uploadSpeedSamples[0];
    const last = _uploadSpeedSamples[_uploadSpeedSamples.length - 1];
    const dt = (last.time - first.time) / 1000; // seconds
    if (dt <= 0) return 0;
    return (last.loaded - first.loaded) / dt;
}

/** Build a small SVG progress-pie circle (24×24). */
const _PIE_R = 9;
const _PIE_C = 2 * Math.PI * _PIE_R; // ≈ 56.55

function _buildPieSvg(pct) {
    const frac = Math.min(1, Math.max(0, pct / 100));
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.classList.add('transfer-step-pie');

    const bg = document.createElementNS(NS, 'circle');
    bg.setAttribute('cx', '12'); bg.setAttribute('cy', '12'); bg.setAttribute('r', String(_PIE_R));
    bg.setAttribute('fill', 'none');
    bg.setAttribute('stroke', 'rgba(255,255,255,0.15)');
    bg.setAttribute('stroke-width', '2.5');
    svg.appendChild(bg);

    const arc = document.createElementNS(NS, 'circle');
    arc.setAttribute('cx', '12'); arc.setAttribute('cy', '12'); arc.setAttribute('r', String(_PIE_R));
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', '#38bdf8');
    arc.setAttribute('stroke-width', '2.5');
    arc.setAttribute('stroke-dasharray', String(_PIE_C));
    arc.setAttribute('stroke-dashoffset', String(_PIE_C * (1 - frac)));
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('transform', 'rotate(-90 12 12)');
    arc.dataset.role = 'arc';
    svg.appendChild(arc);

    return svg;
}

/** Check if a step has progress data to show. */
function _stepHasProgress(step) {
    return step.status === 'active' &&
        Number.isFinite(step.percent) && step.percent > 0;
}

/** Fast-path: update only pie SVGs + segment labels without full DOM rebuild */
function _updateStepPies() {
    if (!_uploadDetailPanelEl) return;
    const rows = _uploadDetailPanelEl.querySelectorAll('.transfer-step');
    for (let i = 0; i < _uploadSteps.length && i < rows.length; i++) {
        const step = _uploadSteps[i];
        const row = rows[i];
        const pie = row.querySelector('.transfer-step-pie');
        const segEl = row.querySelector('.transfer-step-frac');
        if (_stepHasProgress(step)) {
            const pct = Math.min(100, Math.max(0, step.percent));
            const frac = pct / 100;
            if (pie) {
                const arc = pie.querySelector('[data-role="arc"]');
                if (arc) arc.setAttribute('stroke-dashoffset', String(_PIE_C * (1 - frac)));
            } else {
                row.appendChild(_buildPieSvg(pct));
            }
            if (step.segCount > 0) {
                if (segEl) {
                    segEl.textContent = `段 ${step.segCount}`;
                } else {
                    const el = document.createElement('span');
                    el.className = 'transfer-step-frac';
                    el.textContent = `段 ${step.segCount}`;
                    row.appendChild(el);
                }
            }
        } else {
            if (pie) pie.remove();
            if (segEl) segEl.remove();
        }
    }
}

/** Render the full detail panel content (stats + steps) */
function _renderDetailContent() {
    if (!_uploadDetailPanelEl) return;
    _uploadDetailPanelEl.innerHTML = '';

    // Upload stats row (always shown)
    const statsRow = document.createElement('div');
    statsRow.className = 'transfer-stats-row';
    _uploadStatsEl = statsRow;
    _updateStatsDisplay();
    _uploadDetailPanelEl.appendChild(statsRow);

    // Processing steps (if any)
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

        // Progress pie (encode %) + segment count for active transcode steps
        if (_stepHasProgress(step)) {
            row.appendChild(_buildPieSvg(step.percent));
            if (step.segCount > 0) {
                const segEl = document.createElement('span');
                segEl.className = 'transfer-step-frac';
                segEl.textContent = `段 ${step.segCount}`;
                row.appendChild(segEl);
            }
        }

        _uploadDetailPanelEl.appendChild(row);
    }
}

/** Update the stats display without full DOM rebuild */
function _updateStatsDisplay() {
    if (!_uploadStatsEl) return;
    const speed = _calcSpeed();
    const loadedStr = _fmtBytes(_uploadLoaded);
    const totalStr = _uploadTotal > 0 ? _fmtBytes(_uploadTotal) : '—';
    const speedStr = speed > 0
        ? `${_fmtBytes(speed)}/s`
        : (_uploadLoaded > 0 ? '計算中…' : '—');

    // Reuse existing child elements if possible (avoids flicker from innerHTML='')
    let line1 = _uploadStatsEl.firstElementChild;
    let sizeLabel, speedLabel;

    if (line1 && line1.childElementCount === 2) {
        // Fast path: update text only
        sizeLabel = line1.children[0];
        speedLabel = line1.children[1];
    } else {
        // First render: create elements
        _uploadStatsEl.innerHTML = '';
        line1 = document.createElement('div');
        line1.style.cssText = 'display:flex;justify-content:space-between;gap:12px';
        sizeLabel = document.createElement('span');
        speedLabel = document.createElement('span');
        speedLabel.style.opacity = '0.7';
        line1.appendChild(sizeLabel);
        line1.appendChild(speedLabel);
        _uploadStatsEl.appendChild(line1);
    }

    // Always show uploaded/total format
    sizeLabel.textContent = `已上傳 ${loadedStr} / ${totalStr}`;
    speedLabel.textContent = speedStr;
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

    // Info button (upload only) — toggles the detail panel
    if (type === 'upload') {
        const detailBtn = document.createElement('button');
        detailBtn.type = 'button';
        detailBtn.className = 'transfer-bar-detail-btn';
        detailBtn.title = '詳細資訊';
        detailBtn.innerHTML = INFO_ICON;
        detailBtn.style.display = 'none'; // shown when upload starts
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
