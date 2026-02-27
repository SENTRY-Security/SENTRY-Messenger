/**
 * MediaHandlingController
 * Manages media preview interactions and modals.
 * Video playback uses MSE (ManagedMediaSource on iOS Safari 17.1+)
 * for streaming encrypted chunks without loading the entire video into memory.
 */

import { BaseController } from './base-controller.js';
import { downloadAndDecrypt } from '../../../features/media.js';
import { downloadChunkedManifest, streamChunks } from '../../../features/chunked-download.js';
import { isMseSupported, detectCodecFromInitSegment, buildMimeFromCodecString, createMsePlayer } from '../../../features/mse-player.js';
import { mergeInitSegments } from '../../../features/mp4-remuxer.js';
import { renderPdfViewer, cleanupPdfViewer } from '../viewers/pdf-viewer.js';
import { openImageViewer, cleanupImageViewer } from '../viewers/image-viewer.js';
import { escapeHtml, fmtSize, escapeSelector } from '../ui-utils.js';
import { isDownloadBusy, startDownload, updateDownloadProgress, endDownload } from '../../../features/transfer-progress.js';

export class MediaHandlingController extends BaseController {
    constructor(deps) {
        super(deps);
    }

    /**
     * Show modal loading state.
     */
    _showModalLoading(text) {
        if (typeof this.deps.showModalLoading === 'function') {
            this.deps.showModalLoading(text);
            return;
        }
        // Fallback: open modal manually
        const modalEl = document.getElementById('modal');
        const title = document.getElementById('modalTitle');
        const body = document.getElementById('modalBody');
        if (!modalEl || !title || !body) return;
        modalEl.classList.add('loading-modal');
        title.textContent = text || '載入中…';
        body.innerHTML = '<div class="loading-wrap"><div class="progress-bar" style="width:100%;"><div id="loadingBar" class="progress-inner" style="width:0%;"></div></div><div id="loadingText" class="loading-text"></div></div>';
        this.deps.openPreviewModal?.();
    }

    _updateLoadingModal(state) {
        if (typeof this.deps.updateLoadingModal === 'function') {
            this.deps.updateLoadingModal(state);
            return;
        }
        // Fallback: update DOM directly
        const bar = document.getElementById('loadingBar');
        if (bar && typeof state.percent === 'number') {
            bar.style.width = `${Math.min(Math.max(state.percent, 0), 100)}%`;
        }
        const label = document.getElementById('loadingText');
        if (label && typeof state.text === 'string') {
            label.textContent = state.text;
        }
    }

    /**
     * Update the video overlay DOM in-place without a full re-render.
     */
    _updateVideoOverlayUI(msgId, media) {
        const messagesList = this.elements?.messagesList || document.querySelector('.messages-list');
        if (!messagesList) return;
        const selector = `.message-bubble[data-message-id="${escapeSelector(msgId)}"] .message-file`;
        const wrapper = messagesList.querySelector(selector);
        if (!wrapper) return;
        const renderer = this.deps.getMessageRenderer?.();
        if (renderer && typeof renderer.renderVideoOverlay === 'function') {
            renderer.renderVideoOverlay(wrapper, media, msgId);
        }
    }

    /**
     * Download and play a video inline using MSE streaming.
     * ALL videos use chunked upload with segment-aligned chunks.
     * Each downloaded chunk is a complete fMP4 segment → appendBuffer directly to MSE.
     *
     * No blob is stored in memory — playback streams chunk by chunk.
     * Only one download at a time (enforced by transfer-progress lock).
     */
    async downloadVideoInline(media, msgId) {
        if (!media?.chunked || !media.baseKey || !media.manifestEnvelope) {
            this.deps.showToast?.('影片資料不完整，無法播放');
            return;
        }
        return this.downloadChunkedVideoInline(media, msgId);
    }

    /**
     * Download a chunked video and play via MSE streaming.
     *
     * Each chunk is a complete fMP4 segment (init segment or moof+mdat pair)
     * that can be directly appended to MSE SourceBuffer.
     *
     * Flow:
     * 1. Download manifest → get chunk metadata
     * 2. Download chunk 0 (init segment) → detect codec → init MSE → append
     * 3. Stream remaining chunks → append each to SourceBuffer
     * 4. Playback starts as soon as first media segment is buffered
     */
    async downloadChunkedVideoInline(media, msgId) {
        if (!media || !media.baseKey || !media.manifestEnvelope) return;
        if (media._videoState === 'downloading') return;

        if (isDownloadBusy()) {
            this.deps.showToast?.('目前有檔案正在下載，請稍候再試');
            return;
        }

        // Check MSE support
        if (!isMseSupported()) {
            this.deps.showToast?.('此瀏覽器不支援影片串流播放');
            return;
        }

        media._videoState = 'downloading';
        media._videoProgress = 0;
        this._updateVideoOverlayUI(msgId, media);

        const downloadAbort = new AbortController();
        startDownload(media.name || '影片', () => {
            try { downloadAbort.abort(); } catch {}
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);
            endDownload();
        });

        let msePlayer = null;

        // Step 1: IMMEDIATELY open modal with video element + buffering overlay
        const modalBody = document.getElementById('modalBody');
        const modalTitle = document.getElementById('modalTitle');
        const modalEl = document.getElementById('modal');
        if (!modalBody || !modalEl) {
            endDownload();
            media._videoState = 'idle';
            this.deps.showToast?.('無法開啟播放視窗');
            return;
        }

        const classesToRemove = [
            'loading-modal', 'progress-modal', 'folder-modal', 'upload-modal',
            'confirm-modal', 'nickname-modal', 'avatar-modal',
            'avatar-preview-modal', 'settings-modal'
        ];
        modalEl.classList.remove(...classesToRemove);
        modalBody.innerHTML = '';
        if (modalTitle) {
            modalTitle.textContent = media.name || '影片';
            modalTitle.setAttribute('title', media.name || '影片');
        }

        const container = document.createElement('div');
        container.className = 'preview-wrap';
        const wrap = document.createElement('div');
        wrap.className = 'viewer';
        wrap.style.position = 'relative';
        container.appendChild(wrap);
        modalBody.appendChild(container);

        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.autoplay = true;
        video.style.width = '100%';
        wrap.appendChild(video);

        // Buffering overlay — shown until first media segment is appended
        const bufOverlay = document.createElement('div');
        bufOverlay.className = 'video-buffering-overlay';
        bufOverlay.innerHTML = `
            <div class="video-buffering-spinner"></div>
            <div class="video-buffering-text">緩衝中...</div>
        `;
        wrap.appendChild(bufOverlay);

        // ── Stats overlay — shows MSE buffer, codec, chunk & encryption info ──
        const statsState = { chunksReceived: 0, totalChunks: 0, bytesReceived: 0, intervalId: null };

        const statsToggle = document.createElement('button');
        statsToggle.className = 'video-stats-toggle';
        statsToggle.textContent = 'i';
        statsToggle.setAttribute('aria-label', '串流資訊');

        const statsPanel = document.createElement('div');
        statsPanel.className = 'video-stats-panel';
        statsPanel.hidden = true;

        statsPanel.innerHTML = `
            <div class="stats-section">
                <div class="stats-label">BUFFER</div>
                <div class="video-stats-buffer-bar">
                    <div class="buf-range"></div>
                    <div class="buf-played"></div>
                    <div class="buf-cursor"></div>
                </div>
                <div class="stats-row"><span class="stats-key">Position</span><span class="stats-val" data-vs="position">0:00 / 0:00</span></div>
                <div class="stats-row"><span class="stats-key">Buffered</span><span class="stats-val" data-vs="buffered">0.0s</span></div>
            </div>
            <div class="stats-section">
                <div class="stats-label">MSE</div>
                <div class="stats-row"><span class="stats-key">Type</span><span class="stats-val" data-vs="mse-type">—</span></div>
                <div class="stats-row"><span class="stats-key">State</span><span class="stats-val" data-vs="state">—</span></div>
                <div class="stats-row"><span class="stats-key">Codec</span><span class="stats-val" data-vs="codec">—</span></div>
                <div class="stats-row"><span class="stats-key">SB Mode</span><span class="stats-val" data-vs="sbmode">—</span></div>
                <div class="stats-row"><span class="stats-key">Queue</span><span class="stats-val" data-vs="queue">0</span></div>
            </div>
            <div class="stats-section">
                <div class="stats-label">CHUNKS</div>
                <div class="video-stats-chunk-bar"><div class="chunk-fill"></div></div>
                <div class="stats-row"><span class="stats-key">Progress</span><span class="stats-val" data-vs="chunks">0 / 0</span></div>
                <div class="stats-row"><span class="stats-key">Received</span><span class="stats-val" data-vs="bytes">0 B</span></div>
            </div>
            <div class="stats-section">
                <div class="stats-label">ENCRYPTION</div>
                <div class="stats-row"><span class="stats-key">Scheme</span><span class="stats-val">AEAD</span></div>
                <div class="stats-row"><span class="stats-key">Per-Chunk</span><span class="stats-val good">AES-256-GCM</span></div>
            </div>
        `;

        statsToggle.addEventListener('click', () => {
            const show = statsPanel.hidden;
            statsPanel.hidden = !show;
            statsToggle.classList.toggle('active', show);
        });

        wrap.appendChild(statsToggle);
        wrap.appendChild(statsPanel);

        // Helpers for stats display
        const fmtTime = (s) => {
            if (!isFinite(s) || s < 0) return '0:00';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return `${m}:${sec.toString().padStart(2, '0')}`;
        };
        const fmtBytes = (b) => {
            if (b < 1024) return `${b} B`;
            if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
            return `${(b / 1048576).toFixed(1)} MB`;
        };

        // Polling update for stats panel
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

                // Buffer bar visualization
                const barEl = statsPanel.querySelector('.video-stats-buffer-bar');
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

                // MSE type
                const typeEl = statsPanel.querySelector('[data-vs="mse-type"]');
                if (typeEl) typeEl.textContent = st.isMMS ? 'ManagedMediaSource' : 'MediaSource';

                // State
                const stateEl = statsPanel.querySelector('[data-vs="state"]');
                if (stateEl) {
                    stateEl.textContent = st.readyState;
                    stateEl.className = `stats-val ${st.readyState === 'open' ? 'good' : st.readyState === 'ended' ? '' : 'error'}`;
                }

                // Codec
                const codecEl = statsPanel.querySelector('[data-vs="codec"]');
                if (codecEl && muxedBuf) {
                    const raw = muxedBuf.mimeCodec || '—';
                    const match = raw.match(/codecs="([^"]+)"/);
                    codecEl.textContent = match ? match[1] : raw;
                }

                // SB Mode
                const modeEl = statsPanel.querySelector('[data-vs="sbmode"]');
                if (modeEl && muxedBuf) modeEl.textContent = muxedBuf.mode || 'default';

                // Queue
                const queueEl = statsPanel.querySelector('[data-vs="queue"]');
                if (queueEl && muxedBuf) {
                    queueEl.textContent = String(muxedBuf.queuePending);
                    queueEl.className = `stats-val ${muxedBuf.queuePending > 3 ? 'warn' : ''}`;
                }

                // Chunks
                const chunksEl = statsPanel.querySelector('[data-vs="chunks"]');
                if (chunksEl) chunksEl.textContent = `${statsState.chunksReceived} / ${statsState.totalChunks}`;

                const chunkFillEl = statsPanel.querySelector('.chunk-fill');
                if (chunkFillEl && statsState.totalChunks > 0) {
                    chunkFillEl.style.width = `${(statsState.chunksReceived / statsState.totalChunks) * 100}%`;
                }

                // Bytes
                const bytesEl = statsPanel.querySelector('[data-vs="bytes"]');
                if (bytesEl) bytesEl.textContent = fmtBytes(statsState.bytesReceived);
            } catch {}
        };

        statsState.intervalId = setInterval(updateStats, 500);

        // Open modal immediately so user sees the player right away.
        // Use both deps callback AND direct DOM manipulation to ensure
        // the modal is actually visible (guards against missing deps or
        // normalizeOverlayState() racing to close it).
        this.deps.openPreviewModal?.();
        modalEl.style.display = 'flex';
        modalEl.setAttribute('aria-hidden', 'false');
        modalEl.classList.add('show');
        document.body.classList.add('modal-open');

        let manifest = null;
        try {
            // Step 2: Download and decrypt manifest (user already sees the modal)
            media._videoProgress = 2;
            this._updateVideoOverlayUI(msgId, media);
            updateDownloadProgress(2);

            manifest = await downloadChunkedManifest({
                baseKey: media.baseKey,
                manifestEnvelope: media.manifestEnvelope,
                abortSignal: downloadAbort.signal
            });

            media._videoProgress = 5;
            this._updateVideoOverlayUI(msgId, media);
            updateDownloadProgress(5);

            statsState.totalChunks = manifest.totalChunks || 0;

            // Non-segment-aligned manifests cannot use MSE streaming.
            // Blob URL fallback is strictly forbidden — reject playback.
            if (!manifest.segment_aligned || !manifest.tracks) {
                throw new Error('此影片格式不支援串流播放（非分段對齊）');
            }

            // Segment-aligned fMP4 — use MSE streaming with single muxed SourceBuffer.
            // New manifests: tracks = [{ type: 'muxed', codec }], chunk 0 = init, rest = media.
            // Legacy manifests: tracks = [{ type: 'video' }, { type: 'audio' }],
            //   first N chunks = per-track init → merge into one, rest = media.
            const manifestTracks = manifest.tracks;
            const numTracks = manifestTracks.length;
            const isLegacyMultiTrack = numTracks > 1;

            // Create MSE player — always single 'muxed' SourceBuffer
            const createPlayer = () => createMsePlayer({
                videoElement: video,
                onError: (err) => {
                    console.warn('[mse-player] segment error (non-fatal):', err?.message || err);
                }
            });
            msePlayer = createPlayer();
            await msePlayer.open();

            let mseInitialized = false;
            let firstMediaAppended = false;
            let consecutiveErrors = 0;
            const MAX_CONSECUTIVE_ERRORS = 5;
            const initChunks = []; // For legacy multi-track: collect init segments

            /**
             * Try to initialize MSE with the given init segment and codec.
             * Returns true on success. On failure, tries fallback strategies:
             *   1. Re-detect codec from actual init segment bytes
             *   2. Recreate MSE player and retry with detected codec
             */
            const tryInitMse = async (initData, primaryMimeCodec) => {
                // Build ordered list of codecs to try
                const codecs = [];
                // Prefer codec detected from actual init segment data (most accurate)
                const detected = detectCodecFromInitSegment(initData, 'muxed');
                if (detected) codecs.push(detected);
                // Then manifest codec (might differ in profile/level)
                if (primaryMimeCodec && !codecs.includes(primaryMimeCodec)) {
                    codecs.push(primaryMimeCodec);
                }
                if (codecs.length === 0) {
                    throw new Error('無法偵測影片編碼格式');
                }

                for (let attempt = 0; attempt < codecs.length; attempt++) {
                    const codec = codecs[attempt];
                    try {
                        if (attempt > 0) {
                            // Previous codec failed — recreate MSE player entirely
                            console.warn(`[mse] init append failed with ${codecs[attempt - 1]}, retrying with ${codec}`);
                            try { msePlayer.destroy(); } catch {}
                            video.src = '';
                            video.load();
                            msePlayer = createPlayer();
                            await msePlayer.open();
                        }
                        msePlayer.addSourceBuffer('muxed', codec);
                        await msePlayer.appendChunk('muxed', initData);
                        return; // Success
                    } catch (err) {
                        console.warn(`[mse] init attempt ${attempt + 1}/${codecs.length} failed (${codec}):`, err?.message);
                        if (attempt === codecs.length - 1) {
                            // All codecs exhausted — try one more time with a clean player
                            // using the first detected codec but without setting sb.mode
                            throw err;
                        }
                    }
                }
            };

            // Step 3: Stream chunks via MSE
            for await (const { data, index } of streamChunks({
                baseKey: media.baseKey,
                manifest,
                manifestEnvelope: media.manifestEnvelope,
                abortSignal: downloadAbort.signal,
                onProgress: ({ percent }) => {
                    const adjusted = 5 + Math.round(percent * 0.9);
                    media._videoProgress = Math.min(95, adjusted);
                    this._updateVideoOverlayUI(msgId, media);
                    updateDownloadProgress(media._videoProgress);
                }
            })) {
                statsState.chunksReceived++;
                statsState.bytesReceived += (data?.byteLength || 0);
                const isInitSegment = index < numTracks;

                if (isInitSegment) {
                    if (isLegacyMultiTrack) {
                        // Old multi-track: collect per-track init segments, merge when all received
                        initChunks.push(data);
                        if (initChunks.length < numTracks) continue;

                        const mergedInit = mergeInitSegments(initChunks);
                        const manifestCodec = manifestTracks.map(t => t.codec).filter(Boolean).join(',');
                        const primaryMime = manifestCodec ? buildMimeFromCodecString(manifestCodec) : null;
                        await tryInitMse(mergedInit, primaryMime);
                        mseInitialized = true;
                    } else {
                        // New muxed manifest: single init segment (chunk 0)
                        const track = manifestTracks[0];
                        const primaryMime = track.codec ? buildMimeFromCodecString(track.codec) : null;
                        await tryInitMse(data, primaryMime);
                        mseInitialized = true;
                    }
                } else {
                    // Media segment — append to single muxed SourceBuffer
                    if (!mseInitialized) continue;

                    try {
                        await msePlayer.appendChunk('muxed', data);
                        consecutiveErrors = 0;
                    } catch (appendErr) {
                        consecutiveErrors++;
                        console.warn(`[mse] segment ${index} append failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, appendErr?.message);
                        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            throw new Error('MSE 串流持續失敗');
                        }
                        continue;
                    }

                    // Remove buffering overlay after first successful media segment
                    if (!firstMediaAppended && bufOverlay.parentNode) {
                        firstMediaAppended = true;
                        bufOverlay.classList.add('fade-out');
                        setTimeout(() => {
                            try { bufOverlay.remove(); } catch {}
                        }, 300);
                    }
                }
            }

            // All chunks appended — signal end of stream
            if (msePlayer) {
                await msePlayer.endOfStream();
            }

            // Ensure overlay is removed
            if (bufOverlay.parentNode) {
                try { bufOverlay.remove(); } catch {}
            }

            endDownload();
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);

            // Cleanup MSE when modal closes.
            // Check display==='none' (set by closeModal / normalizeOverlayState).
            // Do NOT check 'active' class — openModal() never adds it.
            const modalObserver = new MutationObserver(() => {
                if (modalEl.style.display === 'none' || modalEl.getAttribute('aria-hidden') === 'true') {
                    if (statsState.intervalId) { clearInterval(statsState.intervalId); statsState.intervalId = null; }
                    if (msePlayer) {
                        try { msePlayer.destroy(); } catch {}
                        msePlayer = null;
                    }
                    try { video.src = ''; video.load(); } catch {}
                    modalEl.classList.remove('show');
                    modalObserver.disconnect();
                }
            });
            modalObserver.observe(modalEl, { attributes: true, attributeFilter: ['class', 'style'] });

        } catch (err) {
            // Release stats polling
            if (statsState.intervalId) { clearInterval(statsState.intervalId); statsState.intervalId = null; }
            // Release MSE resources
            if (msePlayer) {
                try { msePlayer.destroy(); } catch {}
                msePlayer = null;
            }
            try { video.src = ''; video.load(); } catch {}

            if (err?.name === 'AbortError' || (err instanceof DOMException && err.message === 'aborted')) {
                endDownload();
                modalEl.classList.remove('show');
                this.deps.closePreviewModal?.();
                return;
            }

            // No blob URL fallback — MSE streaming is strictly required.
            console.error('[video] MSE playback failed:', err?.message);

            endDownload();
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);
            modalEl.classList.remove('show');
            this.deps.closePreviewModal?.();
            this.deps.showToast?.(`影片播放失敗：${err?.message || err}`);
        }
    }

    /**
     * Open media preview modal.
     */
    async openMediaPreview(media) {
        if (!media) return;
        try {
            const displayName = media.name || '附件';
            let result = null;

            if (media.objectKey && media.envelope) {
                this._showModalLoading('下載加密檔案中…');
                result = await downloadAndDecrypt({
                    key: media.objectKey,
                    envelope: media.envelope,
                    messageKeyB64: media.messageKey_b64 || media.message_key_b64 || null,
                    onStatus: ({ stage, loaded, total }) => {
                        if (stage === 'sign') {
                            this._updateLoadingModal({ percent: 5, text: '取得下載授權中…' });
                        } else if (stage === 'download-start') {
                            this._updateLoadingModal({ percent: 10, text: '下載加密檔案中…' });
                        } else if (stage === 'download') {
                            const pct = total && total > 0 ? Math.round((loaded / total) * 100) : null;
                            const percent = pct != null ? Math.min(95, Math.max(15, pct)) : 45;
                            const text = pct != null
                                ? `下載加密檔案中… ${pct}% (${fmtSize(loaded)} / ${fmtSize(total)})`
                                : `下載加密檔案中… (${fmtSize(loaded)})`;
                            this._updateLoadingModal({ percent, text });
                        } else if (stage === 'decrypt') {
                            this._updateLoadingModal({ percent: 98, text: '解密檔案中…' });
                        }
                    }
                });
            } else if (media.localUrl) {
                this._showModalLoading(`準備 ${displayName}…`);
                const response = await fetch(media.localUrl);
                if (!response.ok) throw new Error('讀取本機預覽失敗');
                const blob = await response.blob();
                result = {
                    blob,
                    contentType: media.contentType || blob.type || 'application/octet-stream',
                    name: displayName
                };
            } else {
                throw new Error('無法預覽：無效的檔案來源');
            }

            await this.renderMediaPreviewModal({
                blob: result.blob,
                contentType: result.contentType || media.contentType || 'application/octet-stream',
                name: result.name || displayName
            });
        } catch (err) {
            console.error('Media preview error', err);
            this.deps.closePreviewModal?.();
            this.deps.showToast?.(`附件預覽失敗：${err?.message || err}`);
        }
    }

    /**
     * Render the actual preview modal content.
     */
    async renderMediaPreviewModal({ blob, contentType, name }) {
        const modalEl = document.getElementById('modal');
        const body = document.getElementById('modalBody');
        const title = document.getElementById('modalTitle');

        if (!modalEl || !body || !title) {
            this.deps.closePreviewModal?.();
            this.deps.showToast?.('無法顯示附件預覽');
            return;
        }

        cleanupPdfViewer();

        // Clear all modal classes
        const classesToRemove = [
            'loading-modal', 'progress-modal', 'folder-modal', 'upload-modal',
            'confirm-modal', 'nickname-modal', 'avatar-modal',
            'avatar-preview-modal', 'settings-modal'
        ];
        modalEl.classList.remove(...classesToRemove);

        body.innerHTML = '';
        const resolvedName = name || '附件';
        title.textContent = resolvedName;
        title.setAttribute('title', resolvedName);

        const url = URL.createObjectURL(blob);

        const downloadBtn = document.getElementById('modalDownload');
        if (downloadBtn) {
            downloadBtn.style.display = 'none';
            downloadBtn.onclick = null;
        }

        const container = document.createElement('div');
        container.className = 'preview-wrap';
        const wrap = document.createElement('div');
        wrap.className = 'viewer';
        container.appendChild(wrap);
        body.appendChild(container);

        const ct = (contentType || '').toLowerCase();

        const openModal = () => this.deps.openPreviewModal?.();
        const closeModal = () => this.deps.closePreviewModal?.();
        const showConfirm = this.deps.showConfirmModal;

        if (ct === 'application/pdf' || ct.startsWith('application/pdf')) {
            const handled = await renderPdfViewer({
                url,
                name: resolvedName,
                modalApi: { openModal, closeModal, showConfirmModal: showConfirm }
            });
            if (handled) {
                this.deps.openPreviewModal?.();
                return;
            }

            const msg = document.createElement('div');
            msg.className = 'preview-message';
            msg.innerHTML = `PDF 無法內嵌預覽，將直接下載。<br/><br/><a class="primary" href="${url}" download="${escapeHtml(resolvedName)}">下載檔案</a>`;
            wrap.appendChild(msg);
        } else if (ct.startsWith('image/')) {
            // Use full-screen image viewer instead of basic modal
            closeModal?.();
            const onSendToChat = async (editedFile) => {
                const messageSending = this.deps.controllers?.messageSending;
                if (messageSending) {
                    await messageSending.handleComposerFileSelection({ target: { files: [editedFile] } });
                }
            };
            openImageViewer({
                url,
                blob,
                name: resolvedName,
                contentType: ct,
                source: 'chat',
                onSendToChat,
                onClose: () => {
                    try { URL.revokeObjectURL(url); } catch {}
                }
            });
            return;
        } else if (ct.startsWith('video/')) {
            const video = document.createElement('video');
            video.src = url;
            video.controls = true;
            video.playsInline = true;
            video.autoplay = true;
            wrap.appendChild(video);
            // Revoke blob URL when modal closes to free memory
            const videoCleanup = () => {
                try { URL.revokeObjectURL(url); } catch {}
                video.src = '';
                video.load();
            };
            const obs = new MutationObserver(() => {
                if (!modalEl.classList.contains('active') || modalEl.style.display === 'none') {
                    videoCleanup();
                    obs.disconnect();
                }
            });
            obs.observe(modalEl, { attributes: true, attributeFilter: ['class', 'style'] });
        } else if (ct.startsWith('audio/')) {
            const audio = document.createElement('audio');
            audio.src = url;
            audio.controls = true;
            wrap.appendChild(audio);
        } else if (ct.startsWith('text/')) {
            try {
                const textContent = await blob.text();
                const pre = document.createElement('pre');
                pre.textContent = textContent;
                wrap.appendChild(pre);
            } catch {
                const msg = document.createElement('div');
                msg.className = 'preview-message';
                msg.textContent = '無法顯示文字內容。';
                wrap.appendChild(msg);
            }
        } else {
            const message = document.createElement('div');
            message.style.textAlign = 'center';
            message.innerHTML = `無法預覽此類型（${escapeHtml(contentType || '未知')}）。<br/><br/>`;
            const link = document.createElement('a');
            link.href = url;
            link.download = resolvedName;
            link.textContent = '下載檔案';
            link.className = 'primary';
            message.appendChild(link);
            wrap.appendChild(message);
        }

        this.deps.openPreviewModal?.();
    }
}
