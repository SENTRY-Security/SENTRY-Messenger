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
import { openVideoViewer, cleanupVideoViewer } from '../viewers/video-viewer.js';
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
        let blobUrl = null; // For blob-URL fallback when MSE init fails

        // Step 1: Open fullscreen video viewer immediately
        const viewer = openVideoViewer({
            name: media.name || '影片',
            size: media.size,
            onClose: () => {
                // User closed the viewer — abort download and release resources
                try { downloadAbort.abort(); } catch {}
                if (msePlayer) {
                    try { msePlayer.destroy(); } catch {}
                    msePlayer = null;
                }
                if (blobUrl) {
                    try { URL.revokeObjectURL(blobUrl); } catch {}
                    blobUrl = null;
                }
                try { video.src = ''; video.load(); } catch {}
                endDownload();
                media._videoState = 'idle';
                media._videoProgress = 0;
                this._updateVideoOverlayUI(msgId, media);
            }
        });

        const video = viewer.video;

        let manifest = null;
        try {
            // Step 2: Download and decrypt manifest
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

            viewer.updateChunkStats({ total: manifest.totalChunks || 0 });

            // Non-segment-aligned manifests cannot use MSE streaming.
            if (!manifest.segment_aligned || !manifest.tracks) {
                throw new Error('此影片格式不支援串流播放（非分段對齊）');
            }

            // Segment-aligned fMP4 — use MSE streaming with single muxed SourceBuffer.
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
            viewer.setMsePlayer(msePlayer);
            await msePlayer.open();

            // Start playback early while the user-gesture context from the
            // click that opened the viewer may still be valid.  The browser
            // will wait for data and begin playing once enough is buffered.
            video.play().catch(() => {});

            let mseInitialized = false;
            let firstMediaAppended = false;
            let consecutiveErrors = 0;
            const MAX_CONSECUTIVE_ERRORS = 5;
            const initChunks = [];

            // Hide buffering overlay only when the video actually has frames
            // (not just when MSE accepts data — that doesn't guarantee decodability).
            video.addEventListener('canplay', () => {
                if (!firstMediaAppended) {
                    firstMediaAppended = true;
                    viewer.hideBuffering();
                    // Ensure playback starts — autoplay may have been blocked
                    if (video.paused) video.play().catch(() => {});
                }
            }, { once: true });

            const tryInitMse = async (initData, primaryMimeCodec) => {
                const codecs = [];
                const detected = detectCodecFromInitSegment(initData, 'muxed');
                if (detected) codecs.push(detected);
                if (primaryMimeCodec && !codecs.includes(primaryMimeCodec)) {
                    codecs.push(primaryMimeCodec);
                }
                // Standard fallback codecs — try broader profile/level combos
                const fallbackCodecs = [
                    'avc1.42E01E,mp4a.40.2',  // H.264 Baseline + AAC
                    'avc1.4D401E,mp4a.40.2',  // H.264 Main + AAC
                    'avc1.64001E,mp4a.40.2',  // H.264 High + AAC (lower level)
                    'avc1.42E01E',             // H.264 Baseline (video only)
                ];
                for (const cs of fallbackCodecs) {
                    const mime = buildMimeFromCodecString(cs);
                    if (mime && !codecs.includes(mime)) codecs.push(mime);
                }
                if (codecs.length === 0) {
                    throw new Error('無法偵測影片編碼格式');
                }

                for (let attempt = 0; attempt < codecs.length; attempt++) {
                    const codec = codecs[attempt];
                    try {
                        if (attempt > 0) {
                            console.warn(`[mse] init append failed with ${codecs[attempt - 1]}, retrying with ${codec}`);
                            try { msePlayer.destroy(); } catch {}
                            video.src = '';
                            video.load();
                            msePlayer = createPlayer();
                            viewer.setMsePlayer(msePlayer);
                            await msePlayer.open();
                        }
                        msePlayer.addSourceBuffer('muxed', codec);
                        await msePlayer.appendChunk('muxed', initData);
                        console.info(`[mse] init succeeded with ${codec}`);
                        return;
                    } catch (err) {
                        console.warn(`[mse] init attempt ${attempt + 1}/${codecs.length} failed (${codec}):`, err?.message);
                        if (attempt === codecs.length - 1) throw err;
                    }
                }
            };

            // Step 3: Stream chunks via MSE (with blob-URL fallback)
            // Downloads are decoupled from MSE appends — fire-and-forget with
            // backpressure prevents MMS endstreaming pause from blocking downloads.
            let chunksReceived = 0;
            let bytesReceived = 0;
            let useBlobFallback = false;
            const blobParts = []; // Collects ALL chunks when blob fallback is active

            const inflightAppends = new Set();
            const MAX_INFLIGHT = 15;
            let appendError = null;
            let mseAbandoned = false; // set when voluntarily switching to blob mid-stream

            // Buffer health check: save first few chunks so we can switch to
            // blob fallback if MSE accepts data but the decoder can't handle it
            // (e.g. wrong codec detected, HEVC on non-HEVC-MSE browser, etc.).
            const BUFFER_HEALTH_SEGMENTS = 4;
            const savedForFallback = [];
            let mediaSegmentsSent = 0;
            let bufferHealthPassed = false;

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
                // Check if a previous append triggered a fatal error
                if (appendError) throw appendError;

                chunksReceived++;
                bytesReceived += (data?.byteLength || 0);
                viewer.updateChunkStats({ received: chunksReceived, bytes: bytesReceived });

                // Blob fallback mode: collect all chunks for later concatenation
                if (useBlobFallback) {
                    blobParts.push(data);
                    continue;
                }

                const isInitSegment = index < numTracks;

                if (isInitSegment) {
                    let initData = data;
                    let primaryMime = null;

                    if (isLegacyMultiTrack) {
                        initChunks.push(data);
                        if (initChunks.length < numTracks) continue;
                        initData = mergeInitSegments(initChunks);
                        const manifestCodec = manifestTracks.map(t => t.codec).filter(Boolean).join(',');
                        primaryMime = manifestCodec ? buildMimeFromCodecString(manifestCodec) : null;
                    } else {
                        const track = manifestTracks[0];
                        primaryMime = track.codec ? buildMimeFromCodecString(track.codec) : null;
                    }

                    try {
                        await tryInitMse(initData, primaryMime);
                        mseInitialized = true;
                        savedForFallback.push(initData); // keep for potential blob fallback
                    } catch (initErr) {
                        // MSE init failed after all retries — switch to blob fallback
                        console.warn('[video] MSE init failed, switching to blob-URL fallback:', initErr?.message);
                        useBlobFallback = true;
                        blobParts.push(initData);
                        try { msePlayer.destroy(); } catch {}
                        msePlayer = null;
                        continue;
                    }
                } else {
                    if (!mseInitialized) continue;

                    // Save for potential blob fallback until health check passes
                    if (!bufferHealthPassed) {
                        savedForFallback.push(data);
                    }

                    // Fire-and-forget: don't block downloads waiting for MSE appends.
                    // This is critical for MMS (iOS Safari) where endstreaming pauses
                    // the append queue — blocking here would stall all chunk downloads.
                    const p = msePlayer.appendChunk('muxed', data).then(() => {
                        if (mseAbandoned) return;
                        consecutiveErrors = 0;
                    }, (appendErr) => {
                        if (mseAbandoned) return;
                        consecutiveErrors++;
                        console.warn(`[mse] segment ${index} append failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, appendErr?.message);
                        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            appendError = new Error('MSE 串流持續失敗');
                            try { downloadAbort.abort(); } catch {}
                        }
                    });
                    inflightAppends.add(p);
                    p.finally(() => inflightAppends.delete(p));
                    mediaSegmentsSent++;

                    // Buffer health check: after N segments, verify the video decoder
                    // is actually producing output. If MSE accepted data but the buffer
                    // is empty (codec mismatch, HEVC on non-HEVC browser, etc.),
                    // abandon MSE and switch to blob-URL fallback.
                    if (!bufferHealthPassed && mediaSegmentsSent === BUFFER_HEALTH_SEGMENTS) {
                        // Wait for pending appends to settle (with safety timeout)
                        if (inflightAppends.size > 0) {
                            const healthWait = new Promise(r => setTimeout(r, 8_000));
                            await Promise.race([Promise.allSettled([...inflightAppends]), healthWait]);
                        }
                        const hasBuffer = video.buffered?.length > 0;
                        const hasMeta = video.readyState >= 1;
                        if (!hasBuffer && !hasMeta) {
                            console.warn(`[video] MSE buffer empty after ${mediaSegmentsSent} segments `
                                + `(readyState=${video.readyState}), switching to blob fallback`);
                            mseAbandoned = true;
                            appendError = null;
                            consecutiveErrors = 0;
                            inflightAppends.clear();
                            blobParts.push(...savedForFallback);
                            savedForFallback.length = 0;
                            useBlobFallback = true;
                            try { msePlayer.destroy(); } catch {}
                            msePlayer = null;
                            mseInitialized = false;
                            continue;
                        } else {
                            bufferHealthPassed = true;
                            savedForFallback.length = 0; // free memory
                        }
                    }

                    // Backpressure: if too many appends in-flight, wait for one to settle.
                    // Safety timeout prevents permanent deadlock if all appends are stuck
                    // (e.g. eviction hang, MMS endstreaming pause with no resume).
                    if (inflightAppends.size >= MAX_INFLIGHT) {
                        const BACKPRESSURE_TIMEOUT = 20_000;
                        const timeout = new Promise(r => setTimeout(r, BACKPRESSURE_TIMEOUT));
                        await Promise.race([Promise.race(inflightAppends), timeout]);
                    }
                }
            }

            // Check for deferred append errors (skip if we voluntarily abandoned MSE)
            if (appendError && !mseAbandoned) throw appendError;

            if (useBlobFallback) {
                // All chunks collected — create blob URL and play natively
                console.info(`[video] blob fallback: ${blobParts.length} parts, ${bytesReceived} bytes`);
                const blob = new Blob(blobParts, { type: manifest.contentType || 'video/mp4' });
                blobParts.length = 0; // Release references

                blobUrl = URL.createObjectURL(blob);
                video.src = blobUrl;
                video.load();

                video.addEventListener('canplay', () => viewer.hideBuffering(), { once: true });
                try { await video.play(); } catch { /* autoplay may be blocked */ }
            } else if (msePlayer) {
                // Wait for all in-flight appends to settle before signaling EOS
                if (inflightAppends.size > 0) {
                    await Promise.allSettled(inflightAppends);
                }
                if (appendError) throw appendError;
                await msePlayer.endOfStream();
            }

            endDownload();
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);

        } catch (err) {
            // Release MSE resources
            if (msePlayer) {
                try { msePlayer.destroy(); } catch {}
                msePlayer = null;
            }
            if (blobUrl) {
                try { URL.revokeObjectURL(blobUrl); } catch {}
                blobUrl = null;
            }
            try { video.src = ''; video.load(); } catch {}

            if (err?.name === 'AbortError' || (err instanceof DOMException && err.message === 'aborted')) {
                endDownload();
                // Viewer was already closed by onClose callback or user action
                return;
            }

            console.error('[video] MSE playback failed:', err?.message);

            endDownload();
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);
            viewer.destroy();
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
