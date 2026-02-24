/**
 * MediaHandlingController
 * Manages media preview interactions and modals.
 */

import { BaseController } from './base-controller.js';
import { downloadAndDecrypt } from '../../../features/media.js';
import { downloadChunkedManifest, streamChunks, downloadAllChunks } from '../../../features/chunked-download.js';
import { isMseSupported, detectCodecFromFirstChunk, createMsePlayer } from '../../../features/mse-player.js';
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
     * Download a video file inline (on the chat bubble) with progress.
     * Routes to chunked or single-file download based on media.chunked flag.
     * Updates media._videoState through: idle → downloading → ready.
     * Only one download at a time (enforced by transfer-progress lock).
     */
    async downloadVideoInline(media, msgId) {
        // Route to chunked download if media is chunked
        if (media?.chunked && media.baseKey && media.manifestEnvelope) {
            return this.downloadChunkedVideoInline(media, msgId);
        }
        if (!media || !media.objectKey || !media.envelope) return;
        if (media._videoState === 'downloading' || media._videoState === 'ready') return;

        if (isDownloadBusy()) {
            this.deps.showToast?.('目前有檔案正在下載，請稍候再試');
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

        try {
            const result = await downloadAndDecrypt({
                key: media.objectKey,
                envelope: media.envelope,
                messageKeyB64: media.messageKey_b64 || media.message_key_b64 || null,
                abortSignal: downloadAbort.signal,
                onStatus: ({ stage, loaded, total }) => {
                    if (stage === 'sign') {
                        media._videoProgress = 2;
                    } else if (stage === 'download-start') {
                        media._videoProgress = 5;
                    } else if (stage === 'download') {
                        const pct = total && total > 0 ? Math.round((loaded / total) * 100) : null;
                        media._videoProgress = pct != null ? Math.min(95, Math.max(5, pct)) : 45;
                    } else if (stage === 'decrypt') {
                        media._videoProgress = 98;
                    }
                    this._updateVideoOverlayUI(msgId, media);
                    updateDownloadProgress(media._videoProgress);
                }
            });

            media._videoBlob = result.blob;
            media._videoDownloadedUrl = URL.createObjectURL(result.blob);
            // Also set localUrl so the blob survives re-renders (applyMediaMeta preserves localUrl)
            if (!media.localUrl) media.localUrl = media._videoDownloadedUrl;
            media._videoState = 'ready';
            media._videoProgress = 100;
            this._updateVideoOverlayUI(msgId, media);
            endDownload();
        } catch (err) {
            endDownload();
            if (err?.name === 'AbortError' || (err instanceof DOMException && err.message === 'aborted')) {
                return; // user cancelled
            }
            console.error('Video download error', err);
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);
            this.deps.showToast?.(`影片下載失敗：${err?.message || err}`);
        }
    }

    /**
     * Download a chunked video with MSE streaming playback (or fallback to blob).
     * Downloads manifest → detects codec → streams chunks via MSE or downloads all.
     */
    async downloadChunkedVideoInline(media, msgId) {
        if (!media || !media.baseKey || !media.manifestEnvelope) return;
        if (media._videoState === 'downloading' || media._videoState === 'ready') return;

        if (isDownloadBusy()) {
            this.deps.showToast?.('目前有檔案正在下載，請稍候再試');
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

        try {
            // Step 1: Download and decrypt manifest
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

            // Step 2: Try MSE streaming playback
            const useMse = isMseSupported() && (manifest.contentType === 'video/mp4' || manifest.contentType === 'video/webm');

            if (useMse) {
                const mseResult = await this._tryMsePlayback(media, msgId, manifest, downloadAbort);
                if (mseResult) {
                    endDownload();
                    return; // MSE playback started successfully
                }
                // MSE failed — fall through to blob fallback
            }

            // Step 3: Fallback — download all chunks and assemble blob
            const { blob, contentType, name } = await downloadAllChunks({
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
            });

            media._videoBlob = blob;
            media._videoDownloadedUrl = URL.createObjectURL(blob);
            if (!media.localUrl) media.localUrl = media._videoDownloadedUrl;
            media._videoState = 'ready';
            media._videoProgress = 100;
            this._updateVideoOverlayUI(msgId, media);
            endDownload();
        } catch (err) {
            endDownload();
            if (err?.name === 'AbortError' || (err instanceof DOMException && err.message === 'aborted')) {
                return;
            }
            console.error('Chunked video download error', err);
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);
            this.deps.showToast?.(`影片下載失敗：${err?.message || err}`);
        }
    }

    /**
     * Attempt MSE streaming playback. Returns true if successful, false if should fallback.
     * Downloads first chunk to detect codec, then streams remaining chunks.
     */
    async _tryMsePlayback(media, msgId, manifest, abortController) {
        try {
            const generator = streamChunks({
                baseKey: media.baseKey,
                manifest,
                manifestEnvelope: media.manifestEnvelope,
                abortSignal: abortController.signal,
                onProgress: ({ percent }) => {
                    const adjusted = 5 + Math.round(percent * 0.9);
                    media._videoProgress = Math.min(95, adjusted);
                    this._updateVideoOverlayUI(msgId, media);
                    updateDownloadProgress(media._videoProgress);
                }
            });

            // Get first chunk to detect codec
            const firstResult = await generator.next();
            if (firstResult.done) return false;
            const firstChunk = firstResult.value.data;

            const { mimeCodec, fragmented } = detectCodecFromFirstChunk(firstChunk, manifest.contentType);
            if (!mimeCodec || !fragmented) {
                // Not an MSE-compatible format — caller should use fallback
                // But we already consumed first chunk, so we need to continue downloading all
                // and assemble. Return false to signal fallback.
                return false;
            }

            // Pre-open modal with video element
            this._showModalLoading('串流播放中…');

            const modalBody = document.getElementById('modalBody');
            const modalTitle = document.getElementById('modalTitle');
            const modalEl = document.getElementById('modal');
            if (!modalBody || !modalEl) return false;

            // Clear modal loading state
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
            container.appendChild(wrap);
            modalBody.appendChild(container);

            const video = document.createElement('video');
            video.controls = true;
            video.playsInline = true;
            video.autoplay = true;
            wrap.appendChild(video);

            const msePlayer = createMsePlayer({
                videoElement: video,
                onError: (err) => {
                    console.warn('[mse-player] error during playback:', err?.message);
                }
            });

            // Store reference for cleanup
            media._msePlayer = msePlayer;

            await msePlayer.init(mimeCodec);

            this.deps.openPreviewModal?.();

            // Append first chunk
            await msePlayer.appendChunk(firstChunk);

            // Stream remaining chunks
            for await (const { data } of generator) {
                if (abortController.signal.aborted) {
                    msePlayer.destroy();
                    return true;
                }
                await msePlayer.appendChunk(data);
            }

            msePlayer.endOfStream();

            media._videoState = 'ready';
            media._videoProgress = 100;
            this._updateVideoOverlayUI(msgId, media);

            return true;
        } catch (err) {
            if (err?.name === 'AbortError') throw err; // re-throw abort
            console.warn('[mse-playback] failed, will fallback:', err?.message);
            return false;
        }
    }

    /**
     * Play an already-downloaded video in the preview modal.
     * Supports both server-downloaded blobs (_videoBlob) and local blobs (localUrl).
     */
    async playDownloadedVideo(media, msgId) {
        if (!media) return;
        try {
            let blob = media._videoBlob || null;
            const blobUrl = media._videoDownloadedUrl || media.localUrl || null;

            if (!blob && !blobUrl) {
                // No blob available — if chunked media, reset state so next click triggers download
                if (media.chunked && media.baseKey && media.manifestEnvelope) {
                    media._videoState = 'idle';
                    media.localUrl = null;
                    media._videoDownloadedUrl = null;
                    this._updateVideoOverlayUI(msgId, media);
                    return this.downloadChunkedVideoInline(media, msgId);
                }
                this.deps.showToast?.('影片尚未下載完成');
                return;
            }

            // Pre-open the modal in loading state (matches openMediaPreview flow)
            this._showModalLoading('準備播放…');

            if (!blob && blobUrl) {
                try {
                    const resp = await fetch(blobUrl);
                    if (!resp.ok) throw new Error('blob fetch failed');
                    blob = await resp.blob();
                } catch {
                    // Blob URL expired (e.g. after page lifecycle / memory pressure).
                    // For chunked media, fallback to re-download.
                    if (media.chunked && media.baseKey && media.manifestEnvelope) {
                        this.deps.closePreviewModal?.();
                        media._videoState = 'idle';
                        media._videoBlob = null;
                        media._videoDownloadedUrl = null;
                        media.localUrl = null;
                        this._updateVideoOverlayUI(msgId, media);
                        return this.downloadChunkedVideoInline(media, msgId);
                    }
                    // For single-file media, fallback to full download via downloadVideoInline
                    if (media.objectKey && media.envelope) {
                        this.deps.closePreviewModal?.();
                        media._videoState = 'idle';
                        media._videoBlob = null;
                        media._videoDownloadedUrl = null;
                        media.localUrl = null;
                        this._updateVideoOverlayUI(msgId, media);
                        return this.downloadVideoInline(media, msgId);
                    }
                    blob = null;
                }
            }

            if (!blob) {
                this.deps.closePreviewModal?.();
                this.deps.showToast?.('影片資料讀取失敗');
                return;
            }

            await this.renderMediaPreviewModal({
                blob,
                contentType: media.contentType || 'video/mp4',
                name: media.name || '影片'
            });
        } catch (err) {
            console.error('[playDownloadedVideo] error', err);
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
        // If we had a setModalObjectUrl dependency, use it. Otherwise ignore.
        // this.deps.setModalObjectUrl?.(url);

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
            wrap.appendChild(video);
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
