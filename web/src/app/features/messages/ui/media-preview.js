/**
 * Media Preview Module
 * Extracted from messages-pane.js - handles media preview modal display.
 */

import { downloadAndDecrypt } from '../../media.js';
import { renderPdfViewer, cleanupPdfViewer } from '../../../ui/mobile/viewers/pdf-viewer.js';
import { openImageViewer } from '../../../ui/mobile/viewers/image-viewer.js';
import { canPreviewMedia } from './renderer.js';
import { escapeHtml, fmtSize } from '../../../ui/mobile/ui-utils.js';

/**
 * Create media preview manager.
 * @param {Object} deps - Dependencies
 * @param {Function} deps.showToast - Toast notification function
 * @param {Function} deps.showModalLoading - Show loading modal function
 * @param {Function} deps.updateLoadingModal - Update loading modal function
 * @param {Function} deps.openPreviewModal - Open preview modal function
 * @param {Function} deps.closePreviewModal - Close preview modal function
 * @param {Function} deps.setModalObjectUrl - Set modal object URL function
 * @param {Function} deps.showConfirmModal - Show confirmation modal function
 * @returns {Object} Media preview manager methods
 */
export function createMediaPreviewManager(deps) {
    const {
        showToast,
        showModalLoading,
        updateLoadingModal,
        openPreviewModal,
        closePreviewModal,
        setModalObjectUrl,
        showConfirmModal
    } = deps;

    const toast = typeof showToast === 'function' ? showToast : null;

    /**
     * Open media preview for a media object.
     * @param {Object} media - Media object with objectKey, envelope, or localUrl
     */
    async function openMediaPreview(media) {
        if (!canPreviewMedia(media)) {
            toast?.('無法預覽附件：缺少封套或檔案資訊。');
            return;
        }
        if (!showModalLoading || !openPreviewModal || !setModalObjectUrl) {
            toast?.('預覽模組尚未就緒，請稍後再試。');
            return;
        }
        const displayName = media.name || '附件';
        try {
            let result = null;
            if (media.objectKey && media.envelope) {
                showModalLoading('下載加密檔案中…');
                result = await downloadAndDecrypt({
                    key: media.objectKey,
                    envelope: media.envelope,
                    messageKeyB64: media.messageKey_b64 || media.message_key_b64 || null,
                    onStatus: ({ stage, loaded, total }) => {
                        if (!updateLoadingModal) return;
                        if (stage === 'sign') {
                            updateLoadingModal({ percent: 5, text: '取得下載授權中…' });
                        } else if (stage === 'download-start') {
                            updateLoadingModal({ percent: 10, text: '下載加密檔案中…' });
                        } else if (stage === 'download') {
                            const pct = total && total > 0 ? Math.round((loaded / total) * 100) : null;
                            const percent = pct != null ? Math.min(95, Math.max(15, pct)) : 45;
                            const text = pct != null
                                ? `下載加密檔案中… ${pct}% (${fmtSize(loaded)} / ${fmtSize(total)})`
                                : `下載加密檔案中… (${fmtSize(loaded)})`;
                            updateLoadingModal({ percent, text });
                        } else if (stage === 'decrypt') {
                            updateLoadingModal({ percent: 98, text: '解密檔案中…' });
                        }
                    }
                });
            } else {
                showModalLoading(`準備 ${displayName}…`);
                const response = await fetch(media.localUrl);
                if (!response.ok) throw new Error('讀取本機預覽失敗');
                const blob = await response.blob();
                result = {
                    blob,
                    contentType: media.contentType || blob.type || 'application/octet-stream',
                    name: displayName
                };
            }
            await renderMediaPreviewModal({
                blob: result.blob,
                contentType: result.contentType || media.contentType || 'application/octet-stream',
                name: result.name || displayName
            });
        } catch (err) {
            closePreviewModal?.();
            toast?.(`附件預覽失敗：${err?.message || err}`);
        }
    }

    /**
     * Render media preview in modal.
     * @param {Object} options
     * @param {Blob} options.blob - Media blob
     * @param {string} options.contentType - MIME type
     * @param {string} options.name - Display name
     */
    async function renderMediaPreviewModal({ blob, contentType, name }) {
        const modalEl = document.getElementById('modal');
        const body = document.getElementById('modalBody');
        const title = document.getElementById('modalTitle');
        if (!modalEl || !body || !title) {
            closePreviewModal?.();
            toast?.('無法顯示附件預覽');
            return;
        }
        cleanupPdfViewer();
        modalEl.classList.remove(
            'loading-modal',
            'progress-modal',
            'folder-modal',
            'upload-modal',
            'confirm-modal',
            'nickname-modal',
            'avatar-modal',
            'avatar-preview-modal',
            'settings-modal'
        );

        body.innerHTML = '';
        const resolvedName = name || '附件';
        title.textContent = resolvedName;
        title.setAttribute('title', resolvedName);

        const url = URL.createObjectURL(blob);
        setModalObjectUrl?.(url);

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
        if (ct === 'application/pdf' || ct.startsWith('application/pdf')) {
            const handled = await renderPdfViewer({
                url,
                name: resolvedName,
                modalApi: { openModal: openPreviewModal, closeModal: closePreviewModal, showConfirmModal }
            });
            if (handled) return;
            const msg = document.createElement('div');
            msg.className = 'preview-message';
            msg.innerHTML = `PDF 無法內嵌預覽，將直接下載。<br/><br/><a class="primary" href="${url}" download="${escapeHtml(resolvedName)}">下載檔案</a>`;
            wrap.appendChild(msg);
        } else if (ct.startsWith('image/')) {
            // Use full-screen image viewer
            closePreviewModal?.();
            openImageViewer({
                url,
                blob,
                name: resolvedName,
                contentType: ct,
                source: 'chat',
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

        openPreviewModal?.();
    }

    return {
        openMediaPreview,
        renderMediaPreviewModal
    };
}
