/**
 * Video Viewer — Full-screen video player with custom controls.
 *
 * Opens a fixed overlay (like image-viewer) with:
 *  - Top toolbar: close button, title, stats toggle
 *  - Center stage: <video> element (no native controls)
 *  - Buffering overlay (spinner + text)
 *  - Stats panel (MSE buffer, codec, chunks, encryption)
 *  - Bottom custom controls: play/pause, seek bar, time display
 *  - Auto-hide controls after inactivity
 *
 * The caller (media-handling-controller) streams chunks to the returned
 * <video> element via MSE. This module owns only the UI.
 */

/* ── Helpers ── */
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m}:${sec.toString().padStart(2, '0')}`;
};

const fmtBytes = (b) => {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
};

/* ── State ── */
let activeCleanup = null;

export function cleanupVideoViewer() {
    if (typeof activeCleanup === 'function') {
        try { activeCleanup(); } catch {}
    }
    activeCleanup = null;
}

/* ── SVG Icons ── */
const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const ICON_PLAY_CENTER = '<svg viewBox="0 0 48 48" width="56" height="56" fill="currentColor" opacity="0.9"><path d="M18 12v24l18-12z"/></svg>';
const ICON_CLOSE_SM = '<svg viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_ROTATE_CCW = '<svg viewBox="0 0 24 24" fill="none"><path d="M2.5 2v6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 8C4.7 4.7 8.1 3 12 3c5 0 9 4 9 9s-4 9-9 9c-3.5 0-6.6-2-8-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_ROTATE_CW = '<svg viewBox="0 0 24 24" fill="none"><path d="M21.5 2v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M21.5 8C19.3 4.7 15.9 3 12 3c-5 0-9 4-9 9s4 9 9 9c3.5 0 6.6-2 8-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/**
 * Open the full-screen video viewer.
 *
 * @param {Object} opts
 * @param {string} opts.name          – Display filename
 * @param {number} [opts.size]        – File size in bytes
 * @param {Function} [opts.onClose]   – Called when viewer is closed (caller should abort download)
 * @returns {{ video, showBuffering, hideBuffering, updateChunkStats, setMsePlayer, destroy }}
 */
export function openVideoViewer({ name = '影片', size, onClose } = {}) {
    cleanupVideoViewer();

    /* ── State ── */
    let msePlayer = null;
    let controlsTimer = null;
    let statsIntervalId = null;
    let seekDragging = false;
    let destroyed = false;

    const chunkStats = { received: 0, total: 0, bytes: 0 };

    /* ── Build DOM ── */
    const overlay = document.createElement('div');
    overlay.className = 'vv-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', name);

    overlay.innerHTML = `
        <div class="vv-toolbar">
            <button type="button" class="vv-btn" data-action="close" aria-label="關閉">${ICON_BACK}</button>
            <div class="vv-title">${escHtml(name)}</div>
            <div class="vv-toolbar-actions">
                <button type="button" class="vv-btn vv-rotate-btn" data-action="rotate-ccw" aria-label="向左旋轉">${ICON_ROTATE_CCW}</button>
                <button type="button" class="vv-btn vv-rotate-btn" data-action="rotate-cw" aria-label="向右旋轉">${ICON_ROTATE_CW}</button>
                <button type="button" class="vv-btn vv-stats-toggle" data-action="stats" aria-label="串流資訊">i</button>
            </div>
        </div>
        <div class="vv-stage">
            <video playsinline></video>
            <div class="vv-buffering">
                <div class="vv-buffering-spinner"></div>
                <div class="vv-buffering-text">緩衝中...</div>
            </div>
            <div class="vv-stats">
                <button type="button" class="vv-stats-close" aria-label="隱藏資訊">${ICON_CLOSE_SM}</button>
                <table class="stats-table">
                    <tr class="stats-section-header"><td colspan="2"><span class="stats-label">BUFFER</span></td></tr>
                    <tr><td colspan="2"><div class="vv-stats-buffer-bar"><div class="buf-range"></div><div class="buf-played"></div><div class="buf-cursor"></div></div></td></tr>
                    <tr><td class="stats-key">Position</td><td class="stats-val" data-vs="position">0:00 / 0:00</td></tr>
                    <tr><td class="stats-key">Buffered</td><td class="stats-val" data-vs="buffered">0.0s</td></tr>
                    <tr class="stats-section-header"><td colspan="2"><span class="stats-label">MSE</span></td></tr>
                    <tr><td class="stats-key">Type</td><td class="stats-val" data-vs="mse-type">—</td></tr>
                    <tr><td class="stats-key">State</td><td class="stats-val" data-vs="state">—</td></tr>
                    <tr><td class="stats-key">Codec</td><td class="stats-val" data-vs="codec">—</td></tr>
                    <tr><td class="stats-key">SB Mode</td><td class="stats-val" data-vs="sbmode">—</td></tr>
                    <tr><td class="stats-key">Queue</td><td class="stats-val" data-vs="queue">0</td></tr>
                    <tr class="stats-section-header"><td colspan="2"><span class="stats-label">CHUNKS</span></td></tr>
                    <tr><td colspan="2"><div class="vv-stats-chunk-bar"><div class="chunk-fill"></div><div class="chunk-buffered"></div></div></td></tr>
                    <tr><td class="stats-key">Progress</td><td class="stats-val" data-vs="chunks">0 / 0</td></tr>
                    <tr><td class="stats-key">Received</td><td class="stats-val" data-vs="bytes">0 B</td></tr>
                    <tr class="stats-section-header"><td colspan="2"><span class="stats-label">ENCRYPTION</span></td></tr>
                    <tr><td class="stats-key">Scheme</td><td class="stats-val">AEAD</td></tr>
                    <tr><td class="stats-key">Per-Chunk</td><td class="stats-val good">AES-256-GCM</td></tr>
                </table>
            </div>
            <button type="button" class="vv-center-play" data-action="toggle" aria-label="播放">${ICON_PLAY_CENTER}</button>
        </div>
        <div class="vv-controls">
            <button type="button" class="vv-ctrl-btn" data-action="toggle" aria-label="播放/暫停">${ICON_PLAY}</button>
            <span class="vv-time vv-time-current">0:00</span>
            <div class="vv-seekbar">
                <div class="vv-seekbar-track">
                    <div class="vv-seekbar-buffered"></div>
                    <div class="vv-seekbar-progress"></div>
                </div>
                <div class="vv-seekbar-thumb"></div>
            </div>
            <span class="vv-time vv-time-total">0:00</span>
        </div>
        <div class="vv-footer">使用 &copy; SENTRY 分片加密串流播放器</div>
    `;

    /* ── Query elements ── */
    const video = overlay.querySelector('video');
    const stage = overlay.querySelector('.vv-stage');
    const bufOverlay = overlay.querySelector('.vv-buffering');
    const bufText = overlay.querySelector('.vv-buffering-text');
    const statsPanel = overlay.querySelector('.vv-stats');
    const statsToggle = overlay.querySelector('.vv-stats-toggle');
    const controls = overlay.querySelector('.vv-controls');
    const toolbar = overlay.querySelector('.vv-toolbar');
    const centerPlay = overlay.querySelector('.vv-center-play');
    const toggleBtn = overlay.querySelector('.vv-ctrl-btn[data-action="toggle"]');
    const timeCurrent = overlay.querySelector('.vv-time-current');
    const timeTotal = overlay.querySelector('.vv-time-total');
    const seekbar = overlay.querySelector('.vv-seekbar');
    const seekBuffered = overlay.querySelector('.vv-seekbar-buffered');
    const seekProgress = overlay.querySelector('.vv-seekbar-progress');
    const seekThumb = overlay.querySelector('.vv-seekbar-thumb');

    /* ── Video Config ── */
    video.controls = false;
    video.playsInline = true;
    video.autoplay = true;
    video.muted = false;

    /* ── Manual Rotation ── */
    let manualRotation = 0; // 0, 90, 180, 270

    const applyVideoRotation = () => {
        if (manualRotation === 0) {
            video.style.width = '';
            video.style.height = '';
            video.style.transform = '';
            return;
        }
        if (manualRotation === 90 || manualRotation === 270) {
            // Swap the element's layout dimensions so that after rotation
            // the visual bounding box matches the stage exactly.
            // object-fit:contain then fits the video content within the
            // swapped box, and rotation maps it back → fills 100% width.
            const sw = stage.clientWidth;
            const sh = stage.clientHeight;
            video.style.width = sh + 'px';
            video.style.height = sw + 'px';
            video.style.transform = `rotate(${manualRotation}deg)`;
        } else {
            // 180°: no dimension swap needed
            video.style.width = '';
            video.style.height = '';
            video.style.transform = `rotate(${manualRotation}deg)`;
        }
    };

    // Re-apply on stage resize (device orientation change, window resize)
    const rotationResizeObs = new ResizeObserver(() => {
        if (manualRotation !== 0) applyVideoRotation();
    });
    rotationResizeObs.observe(stage);

    overlay.querySelector('[data-action="rotate-ccw"]').addEventListener('click', (e) => {
        e.stopPropagation();
        manualRotation = (manualRotation + 270) % 360; // -90°
        applyVideoRotation();
    });

    overlay.querySelector('[data-action="rotate-cw"]').addEventListener('click', (e) => {
        e.stopPropagation();
        manualRotation = (manualRotation + 90) % 360;
        applyVideoRotation();
    });

    /* ── Controls Visibility ── */
    const CONTROLS_TIMEOUT = 3500;

    const showControls = () => {
        overlay.classList.remove('vv-controls-hidden');
        resetControlsTimer();
    };

    const hideControls = () => {
        if (video.paused || seekDragging) return;
        overlay.classList.add('vv-controls-hidden');
    };

    const resetControlsTimer = () => {
        if (controlsTimer) clearTimeout(controlsTimer);
        controlsTimer = setTimeout(hideControls, CONTROLS_TIMEOUT);
    };

    // Show on any touch/mouse/keyboard activity
    const onActivity = () => showControls();
    stage.addEventListener('touchstart', onActivity, { passive: true });
    stage.addEventListener('mousemove', onActivity, { passive: true });
    overlay.addEventListener('keydown', onActivity, { passive: true });
    controls.addEventListener('touchstart', onActivity, { passive: true });
    controls.addEventListener('mousemove', onActivity, { passive: true });

    /* ── Play / Pause ── */
    const syncPlayButton = () => {
        const paused = video.paused;
        toggleBtn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
        centerPlay.style.display = paused ? '' : 'none';
        if (paused) {
            overlay.classList.remove('vv-controls-hidden');
            if (controlsTimer) clearTimeout(controlsTimer);
        } else {
            resetControlsTimer();
        }
    };

    const togglePlay = () => {
        if (video.paused) {
            video.play().catch(() => {});
        } else {
            video.pause();
        }
    };

    // Toggle on stage tap (but not on controls/stats/buffering)
    stage.addEventListener('click', (e) => {
        if (e.target === video || e.target === stage || e.target === centerPlay || centerPlay.contains(e.target)) {
            togglePlay();
        }
    });

    // Play/pause button
    overlay.querySelectorAll('[data-action="toggle"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });
    });

    video.addEventListener('play', syncPlayButton);
    video.addEventListener('pause', syncPlayButton);

    /* ── Waiting / Seeking — re-show buffering spinner when video stalls ── */
    let seekCallbacks = [];  // external callbacks registered via onSeeking()

    video.addEventListener('waiting', () => {
        // Video stalled waiting for data — show buffering spinner
        if (!destroyed && bufOverlay) {
            if (bufText) bufText.textContent = '緩衝中…';
            bufOverlay.classList.remove('vv-buf-hidden');
        }
    });

    video.addEventListener('seeking', () => {
        // Notify external seek handler (media-handling-controller)
        const t = video.currentTime;
        for (const cb of seekCallbacks) {
            try { cb(t); } catch {}
        }
    });

    // Hide buffering when playback actually resumes after a stall
    video.addEventListener('playing', () => {
        if (!destroyed && bufOverlay) {
            bufOverlay.classList.add('vv-buf-hidden');
        }
    });

    /* ── Seek Bar ── */
    const updateSeekBar = () => {
        if (seekDragging) return;
        const dur = video.duration || 0;
        const cur = video.currentTime || 0;
        if (dur > 0) {
            const pct = (cur / dur) * 100;
            seekProgress.style.width = `${pct}%`;
            seekThumb.style.left = `${pct}%`;
        }
        // Buffer visualization
        try {
            if (video.buffered.length > 0 && dur > 0) {
                const end = video.buffered.end(video.buffered.length - 1);
                seekBuffered.style.width = `${(end / dur) * 100}%`;
            }
        } catch {}
        timeCurrent.textContent = fmtTime(cur);
        timeTotal.textContent = fmtTime(dur);
    };

    video.addEventListener('timeupdate', updateSeekBar);
    video.addEventListener('durationchange', updateSeekBar);
    video.addEventListener('progress', updateSeekBar);

    // Seek interaction (touch + mouse)
    const seekTo = (clientX) => {
        const rect = seekbar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const dur = video.duration || 0;
        if (dur > 0) {
            video.currentTime = ratio * dur;
            seekProgress.style.width = `${ratio * 100}%`;
            seekThumb.style.left = `${ratio * 100}%`;
            timeCurrent.textContent = fmtTime(ratio * dur);
        }
    };

    // Mouse seek
    seekbar.addEventListener('mousedown', (e) => {
        seekDragging = true;
        seekTo(e.clientX);
        const onMove = (ev) => seekTo(ev.clientX);
        const onUp = () => {
            seekDragging = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    // Touch seek
    seekbar.addEventListener('touchstart', (e) => {
        seekDragging = true;
        if (e.touches.length) seekTo(e.touches[0].clientX);
    }, { passive: true });
    seekbar.addEventListener('touchmove', (e) => {
        if (e.touches.length) seekTo(e.touches[0].clientX);
    }, { passive: true });
    seekbar.addEventListener('touchend', () => { seekDragging = false; }, { passive: true });

    /* ── Stats Panel (default: visible) ── */
    statsToggle.classList.add('active');
    const statsCloseBtn = statsPanel.querySelector('.vv-stats-close');

    const hideStats = () => {
        statsPanel.hidden = true;
        statsToggle.classList.remove('active');
    };

    const showStats = () => {
        statsPanel.hidden = false;
        statsToggle.classList.add('active');
    };

    // Toolbar "i" button toggles panel
    statsToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (statsPanel.hidden) showStats(); else hideStats();
    });

    // X button inside the panel hides it
    statsCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideStats();
    });

    /* ── Video Orientation Detection ── */
    // Default to portrait; stats panel stays invisible (opacity:0) until
    // orientation is resolved to avoid a layout flash on MSE streams
    // where loadedmetadata may arrive after the first chunks are appended.
    overlay.classList.add('vv-portrait');

    const applyOrientation = () => {
        const w = video.videoWidth || 0;
        const h = video.videoHeight || 0;
        if (w <= 0 || h <= 0) return; // dimensions not yet available
        const isLandscape = w > h;
        overlay.classList.toggle('vv-landscape', isLandscape);
        overlay.classList.toggle('vv-portrait', !isLandscape);
        statsPanel.classList.add('vv-stats-ready');
    };

    // loadedmetadata: first chance — may report un-rotated coded dimensions
    video.addEventListener('loadedmetadata', applyOrientation);
    // resize: fires when browser updates intrinsic size (e.g. after applying
    // tkhd rotation matrix), giving us the correct display dimensions.
    video.addEventListener('resize', applyOrientation);

    // Fallback: if neither event fires within 3s (e.g. slow MSE init),
    // reveal the panel in its default portrait layout.
    const orientationFallbackTimer = setTimeout(() => {
        if (!statsPanel.classList.contains('vv-stats-ready')) {
            statsPanel.classList.add('vv-stats-ready');
        }
    }, 3000);

    const updateStats = () => {
        if (!msePlayer || statsPanel.hidden) return;
        try {
            const st = msePlayer.getStats();
            const dur = video.duration || 0;
            const cur = video.currentTime || 0;
            const muxedBuf = st.buffers.muxed;

            // Position
            const posEl = statsPanel.querySelector('[data-vs="position"]');
            if (posEl) posEl.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;

            // Buffer bar
            const barEl = statsPanel.querySelector('.vv-stats-buffer-bar');
            if (barEl && dur > 0) {
                const rangeEl = barEl.querySelector('.buf-range');
                const playedEl = barEl.querySelector('.buf-played');
                const cursorEl = barEl.querySelector('.buf-cursor');
                try {
                    if (video.buffered.length > 0) {
                        const bs = video.buffered.start(0);
                        const be = video.buffered.end(video.buffered.length - 1);
                        rangeEl.style.left = `${(bs / dur) * 100}%`;
                        rangeEl.style.width = `${((be - bs) / dur) * 100}%`;
                    } else {
                        rangeEl.style.left = '0%';
                        rangeEl.style.width = '0%';
                    }
                } catch { rangeEl.style.width = '0%'; }
                playedEl.style.left = '0%';
                playedEl.style.width = `${(cur / dur) * 100}%`;
                cursorEl.style.left = `${(cur / dur) * 100}%`;
            }

            // Buffered total
            const bufEl = statsPanel.querySelector('[data-vs="buffered"]');
            if (bufEl && muxedBuf) {
                const tb = muxedBuf.totalBuffered;
                bufEl.textContent = `${tb.toFixed(1)}s`;
                bufEl.className = `stats-val ${tb > 5 ? 'good' : tb > 1 ? '' : 'warn'}`;
            }

            // MSE info
            const typeEl = statsPanel.querySelector('[data-vs="mse-type"]');
            if (typeEl) typeEl.textContent = st.isMMS ? 'ManagedMediaSource' : 'MediaSource';

            const stateEl = statsPanel.querySelector('[data-vs="state"]');
            if (stateEl) {
                stateEl.textContent = st.readyState;
                stateEl.className = `stats-val ${st.readyState === 'open' ? 'good' : st.readyState === 'ended' ? '' : 'error'}`;
            }

            const codecEl = statsPanel.querySelector('[data-vs="codec"]');
            if (codecEl && muxedBuf) {
                const raw = muxedBuf.mimeCodec || '—';
                const match = raw.match(/codecs="([^"]+)"/);
                codecEl.textContent = match ? match[1] : raw;
            }

            const modeEl = statsPanel.querySelector('[data-vs="sbmode"]');
            if (modeEl && muxedBuf) modeEl.textContent = muxedBuf.mode || 'default';

            const queueEl = statsPanel.querySelector('[data-vs="queue"]');
            if (queueEl && muxedBuf) {
                queueEl.textContent = String(muxedBuf.queuePending);
                queueEl.className = `stats-val ${muxedBuf.queuePending > 3 ? 'warn' : ''}`;
            }

            // Chunks
            const chunksEl = statsPanel.querySelector('[data-vs="chunks"]');
            if (chunksEl) chunksEl.textContent = `${chunkStats.received} / ${chunkStats.total}`;

            const chunkFillEl = statsPanel.querySelector('.chunk-fill');
            if (chunkFillEl && chunkStats.total > 0) {
                chunkFillEl.style.width = `${(chunkStats.received / chunkStats.total) * 100}%`;
            }

            // Chunk-bar: overlay showing currently buffered range (vs evicted)
            const chunkBufEl = statsPanel.querySelector('.chunk-buffered');
            if (chunkBufEl && dur > 0) {
                try {
                    if (video.buffered.length > 0) {
                        const bs = video.buffered.start(0);
                        const be = video.buffered.end(video.buffered.length - 1);
                        chunkBufEl.style.left = `${(bs / dur) * 100}%`;
                        chunkBufEl.style.width = `${((be - bs) / dur) * 100}%`;
                    } else {
                        chunkBufEl.style.width = '0%';
                    }
                } catch {
                    chunkBufEl.style.width = '0%';
                }
            }

            // Bytes
            const bytesEl = statsPanel.querySelector('[data-vs="bytes"]');
            if (bytesEl) bytesEl.textContent = fmtBytes(chunkStats.bytes);
        } catch {}
    };

    statsIntervalId = setInterval(updateStats, 500);

    /* ── Close Handler ── */
    const close = () => {
        if (destroyed) return;
        destroy();
        onClose?.();
    };

    overlay.querySelector('[data-action="close"]').addEventListener('click', (e) => {
        e.stopPropagation();
        close();
    });

    // Android back button / Escape key
    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    };
    document.addEventListener('keydown', onKeyDown);

    /* ── Mount ── */
    document.body.appendChild(overlay);
    document.body.classList.add('vv-open');
    // Trigger entrance animation
    requestAnimationFrame(() => overlay.classList.add('vv-visible'));
    showControls();

    /* ── Destroy ── */
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (controlsTimer) clearTimeout(controlsTimer);
        clearTimeout(orientationFallbackTimer);
        rotationResizeObs.disconnect();
        if (statsIntervalId) { clearInterval(statsIntervalId); statsIntervalId = null; }
        document.removeEventListener('keydown', onKeyDown);
        document.body.classList.remove('vv-open');
        try { overlay.remove(); } catch {}
        activeCleanup = null;
    }

    activeCleanup = destroy;

    /* ── Public API ── */
    return {
        /** The <video> element — attach MSE here */
        video,

        /** The overlay element */
        overlay,

        /** Show buffering overlay with optional text */
        showBuffering(text) {
            if (bufOverlay) {
                bufOverlay.classList.remove('vv-buf-hidden');
                if (text && bufText) bufText.textContent = text;
            }
        },

        /** Hide buffering overlay with fade (keeps element in DOM for re-show) */
        hideBuffering() {
            if (bufOverlay) {
                bufOverlay.classList.add('vv-buf-hidden');
            }
        },

        /** Update chunk stats (called by streaming loop) */
        updateChunkStats({ received, total, bytes }) {
            if (received !== undefined) chunkStats.received = received;
            if (total !== undefined) chunkStats.total = total;
            if (bytes !== undefined) chunkStats.bytes = bytes;
        },

        /** Provide the MSE player for stats polling */
        setMsePlayer(player) {
            msePlayer = player;
        },

        /** Register a callback for seek events: cb(seekTimeSeconds) */
        onSeeking(cb) {
            if (typeof cb === 'function') seekCallbacks.push(cb);
        },

        /** Force cleanup */
        destroy
    };
}
