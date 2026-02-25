/**
 * MediaHandlingController
 * Manages media preview interactions and modals.
 * Video playback uses MSE (ManagedMediaSource on iOS Safari 17.1+)
 * for streaming encrypted chunks without loading the entire video into memory.
 */

import { BaseController } from './base-controller.js';
import { downloadAndDecrypt } from '../../../features/media.js';
import { downloadChunkedManifest, streamChunks } from '../../../features/chunked-download.js';
import { isMseSupported, detectCodecFromInitSegment, createMsePlayer } from '../../../features/mse-player.js';
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

        // Open modal immediately so user sees the player right away
        this.deps.openPreviewModal?.();

        try {
            // Step 2: Download and decrypt manifest (user already sees the modal)
            media._videoProgress = 2;
            this._updateVideoOverlayUI(msgId, media);
            updateDownloadProgress(2);

            const manifest = await downloadChunkedManifest({
                baseKey: media.baseKey,
                manifestEnvelope: media.manifestEnvelope,
                abortSignal: downloadAbort.signal
            });

            media._videoProgress = 5;
            this._updateVideoOverlayUI(msgId, media);
            updateDownloadProgress(5);

            // Determine track layout from manifest (v3)
            const manifestTracks = manifest.tracks;
            const numTracks = manifestTracks.length;

            // Track labels for routing: 'video', 'audio', etc.
            const trackLabels = manifestTracks.map(t => t.type);

            // Create MSE player
            msePlayer = createMsePlayer({
                videoElement: video,
                onError: (err) => {
                    console.error('[mse-player] error during playback:', err?.message || err);
                }
            });
            await msePlayer.open();

            // Track which SourceBuffers have been created (by trackIndex)
            const sbCreated = new Set();
            // Count init segments received (one per track)
            let initSegmentsReceived = 0;
            let firstMediaAppended = false;

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
                // Determine which track this chunk belongs to
                const chunkMeta = manifest.chunks?.[index];
                const trackIndex = chunkMeta?.trackIndex ?? 0;
                const label = trackLabels[trackIndex] || 'muxed';
                const isInitSegment = index < numTracks;

                if (isInitSegment) {
                    // Init segment — detect codec and create SourceBuffer
                    const trackType = manifestTracks[trackIndex].type;
                    const mimeCodec = detectCodecFromInitSegment(data, trackType);

                    if (!mimeCodec) {
                        throw new Error(`無法偵測 ${trackType} 軌道編碼格式`);
                    }

                    if (!sbCreated.has(label)) {
                        msePlayer.addSourceBuffer(label, mimeCodec);
                        sbCreated.add(label);
                    }

                    await msePlayer.appendChunk(label, data);
                } else {
                    // Media segment — route to correct SourceBuffer
                    await msePlayer.appendChunk(label, data);

                    // Remove buffering overlay after first media segment
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
                msePlayer.endOfStream();
            }

            // Ensure overlay is removed
            if (bufOverlay.parentNode) {
                try { bufOverlay.remove(); } catch {}
            }

            endDownload();
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);

            // Cleanup MSE when modal closes
            const modalObserver = new MutationObserver(() => {
                if (!modalEl.classList.contains('active') || modalEl.style.display === 'none') {
                    if (msePlayer) {
                        msePlayer.destroy();
                        msePlayer = null;
                    }
                    video.src = '';
                    video.load();
                    modalObserver.disconnect();
                }
            });
            modalObserver.observe(modalEl, { attributes: true, attributeFilter: ['class', 'style'] });

        } catch (err) {
            endDownload();
            if (msePlayer) {
                try { msePlayer.destroy(); } catch {}
                msePlayer = null;
            }
            if (err?.name === 'AbortError' || (err instanceof DOMException && err.message === 'aborted')) {
                // If aborted, close the modal
                this.deps.closePreviewModal?.();
                return;
            }
            console.error('Video playback error', err);
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);
            // Close modal and show toast on error
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
