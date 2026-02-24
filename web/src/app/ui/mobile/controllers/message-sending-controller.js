/**
 * MessageSendingController
 * Manages outgoing messages, including local append, file selection, and upload progress.
 */

import { BaseController } from './base-controller.js';
import { appendUserMessage, getTimeline, removeMessagesMatching } from '../../../features/timeline-store.js';
import { sendDrMedia, sendDrText } from '../../../features/dr-session.js';
import { UnsupportedVideoFormatError } from '../../../features/media.js';
import { escapeSelector } from '../ui-utils.js';
import { normalizeCounterValue } from '../../../features/messages/parser.js';
import { isUploadBusy, startUpload, updateUploadProgress, endUpload } from '../../../features/transfer-progress.js';

export class MessageSendingController extends BaseController {
    constructor(deps) {
        super(deps);
    }

    /**
     * Helper to find a message in the current conversation timeline by ID.
     */
    _findTimelineMessageById(conversationId, messageId) {
        if (!conversationId || !messageId) return null;
        const timeline = getTimeline(conversationId);
        return timeline.find((m) => (m.id === messageId || m.messageId === messageId));
    }

    /**
     * Append a local outgoing message to the timeline.
     */
    appendLocalOutgoingMessage({ text, ts, tsMs = null, id, type = 'text', media = null, msgType = null }) {
        const state = this.getMessageState();

        if (!state.conversationId) {
            console.warn('[MessageSending] appendLocalOutgoingMessage aborted: no conversationId');
            return null;
        }

        const timestamp = Number.isFinite(ts) ? ts : Date.now();
        const resolvedId = id || crypto.randomUUID();
        // Fallback or explicit Type
        const resolvedType = msgType || type || 'text';

        const message = {
            id: resolvedId,
            messageId: resolvedId,
            text: text,
            ts: timestamp,
            status: 'pending',
            direction: 'outgoing',
            senderDigest: 'me',
            msgType: resolvedType,
            media: media || null,
            placeholder: false
        };

        if (state.conversationId) {
            appendUserMessage(state.conversationId, message);
        }

        this.updateMessagesUI({ scrollToEnd: true });
        this.deps.scrollMessagesToBottomSoon?.();

        return message;
    }

    /**
     * Remove a local message by ID (used for cancelling uploads etc.)
     * Also aborts any in-flight upload tied to this message.
     */
    removeLocalMessageById(id) {
        if (!id) return;
        const state = this.getMessageState();
        if (!state.conversationId) return;

        // Look up the message to abort any in-flight upload.
        // getTimeline() returns a snapshot array; the objects inside are the
        // same references stored in the underlying Map, so reading
        // msg.abortController is safe.
        const timeline = getTimeline(state.conversationId);
        const msg = timeline.find(m => m.id === id || m.messageId === id);
        if (msg?.abortController && typeof msg.abortController.abort === 'function') {
            try { msg.abortController.abort(); } catch { }
        }

        // [FIX] Use removeMessagesMatching to delete from the actual Map store.
        // Previously we spliced from the snapshot array returned by getTimeline(),
        // which had no effect on the underlying Map — the message would reappear
        // on the next render cycle, making the cancel button appear broken.
        const removed = removeMessagesMatching(state.conversationId, m => m.id === id || m.messageId === id);
        if (removed > 0) {
            this.updateMessagesUI({ preserveScroll: true });
        }
    }

    /**
     * Update upload overlay UI for a message.
     */
    updateUploadOverlayUI(messageId, media) {
        if (!this.elements.messagesList) return false;
        const selector = `.message-bubble[data-message-id="${escapeSelector(messageId)}"] .message-file`;
        const wrapper = this.elements.messagesList.querySelector(selector);
        if (!wrapper) return false;

        // Use the renderer if available, otherwise we can't render the overlay.
        const renderer = this.deps.getMessageRenderer?.();
        if (renderer && typeof renderer.renderUploadOverlay === 'function') {
            renderer.renderUploadOverlay(wrapper, media, messageId);
        }

        this.deps.scrollMessagesToBottomSoon?.();
        return true;
    }

    /**
     * Apply upload progress to a message object (mutates object).
     */
    applyUploadProgress(message, { percent, error }) {
        if (!message || !message.media) return;
        if (error) {
            message.media.uploading = false;
            message.media.error = error;
            message.media.progress = 0;
            message.status = 'failed';
        } else {
            message.media.uploading = true;
            message.media.progress = percent;
            message.media.error = null;
        }
    }

    /**
     * Handle file selection from the composer.
     */
    async handleComposerFileSelection(event) {
        if (!this.deps.requireSubscriptionActive?.()) return;

        const input = event?.target || event?.currentTarget || this.elements.fileInput;
        const files = input?.files ? Array.from(input.files).filter(Boolean) : [];
        if (!files.length) return;

        if (isUploadBusy()) {
            this.deps.showToast?.('目前有檔案正在上傳，請稍候再試');
            if (input) input.value = '';
            return;
        }

        const state = this.getMessageState();
        if (!state.activePeerDigest || !state.conversationToken) {
            this.deps.setMessagesStatus?.('請先選擇已建立安全對話的好友', true);
            return;
        }

        const contactEntry = this.sessionStore.contactIndex?.get?.(state.activePeerDigest) || null;
        const conversation = contactEntry?.conversation || null;

        try {
            for (const file of files) {
                const localUrl = URL.createObjectURL(file);
                const messageId = crypto.randomUUID();
                const previewText = `[檔案] ${file.name || '附件'}`;

                const localMsg = this.appendLocalOutgoingMessage({
                    text: previewText,
                    ts: Date.now(),
                    id: messageId,
                    msgType: 'media',
                    media: {
                        name: file.name || '附件',
                        size: typeof file.size === 'number' ? file.size : null,
                        contentType: file.type || 'application/octet-stream',
                        localUrl,
                        previewUrl: localUrl,
                        uploading: true,
                        progress: 0
                    }
                });

                const abortController = new AbortController();
                localMsg.abortController = abortController;

                // Show top progress bar
                const fileName = file.name || '附件';
                startUpload(fileName, () => {
                    try { abortController.abort(); } catch {}
                    this.removeLocalMessageById(localMsg.id);
                    endUpload();
                });

                const progressHandler = (progress) => {
                    const msg = this._findTimelineMessageById(state.conversationId, localMsg.id);
                    if (!msg) return;
                    const percent = Number.isFinite(progress?.percent)
                        ? progress.percent
                        : (progress?.loaded && progress?.total ? (progress.loaded / progress.total) * 100 : null);

                    this.applyUploadProgress(msg, { percent });
                    this.updateUploadOverlayUI(msg.id, msg.media);
                    if (Number.isFinite(percent)) updateUploadProgress(percent);
                };

                try {
                    const res = await sendDrMedia({
                        peerAccountDigest: state.activePeerDigest,
                        file,
                        conversation,
                        convId: state.conversationId,
                        dir: state.conversationId ? ['messages', state.conversationId] : 'messages',
                        onProgress: progressHandler,
                        abortSignal: abortController.signal,
                        messageId
                    });

                    if (res?.convId && !state.conversationId) {
                        state.conversationId = res.convId;
                    }

                    // Re-fetch msg to ensure we have latest ref
                    const msg = this._findTimelineMessageById(state.conversationId, localMsg.id);
                    const convId = res?.convId || state.conversationId;
                    // Usage of controllers.messageStatus needed
                    // We can access it via deps if we exposed it, or call it if we passed it.
                    // Ideally we should use deps.controllers if circular deps are handled, or deps provided.
                    // Currently deps usually doesn't include other controllers, except via facade.
                    // But here we need messageStatus controller methods: getReplacementInfo, applyCounterTooLowReplaced etc.
                    // We can add these to deps in messages-pane.js

                    const messageStatus = this.deps.messageStatus;
                    if (!messageStatus) {
                        console.error('MessageStatusController not available in deps');
                        continue;
                    }

                    const replacementInfo = messageStatus.getReplacementInfo(res);
                    let replacementMsg = null;

                    if (res?.convId && !state.conversationId) {
                        state.conversationId = res.convId;
                    }

                    const applyMediaMeta = (targetMsg, payload) => {
                        if (!targetMsg) return;
                        if (!targetMsg.media) targetMsg.media = {};
                        targetMsg.text = payload?.msg?.text || targetMsg.text;
                        const pm = payload?.msg?.media || {};
                        const tm = targetMsg.media;
                        targetMsg.media = {
                            ...tm,
                            ...pm,
                            name: (pm.name || tm.name || file.name || '附件'),
                            size: Number.isFinite(pm.size) ? pm.size : (typeof file.size === 'number' ? file.size : tm.size || null),
                            contentType: pm.contentType || tm.contentType || file.type || 'application/octet-stream',
                            localUrl: tm.localUrl || localUrl,
                            previewUrl: pm.previewUrl || tm.previewUrl || tm.localUrl || localUrl,
                            uploading: false,
                            progress: 100,
                            preview: pm.preview || tm.preview || null
                        };
                        // Single-file fields
                        if (!pm.chunked) {
                            targetMsg.media.envelope = pm.envelope || tm.envelope || null;
                            targetMsg.media.objectKey = pm.objectKey || tm.objectKey || payload?.upload?.objectKey || null;
                        }
                        // Chunked fields
                        if (pm.chunked) {
                            targetMsg.media.chunked = true;
                            targetMsg.media.baseKey = pm.baseKey || tm.baseKey || payload?.upload?.baseKey || null;
                            targetMsg.media.manifestEnvelope = pm.manifestEnvelope || tm.manifestEnvelope || null;
                            targetMsg.media.chunkCount = pm.chunkCount || tm.chunkCount || null;
                            targetMsg.media.totalSize = pm.totalSize || tm.totalSize || null;
                        }
                    };

                    if (replacementInfo && msg) {
                        messageStatus.applyCounterTooLowReplaced(msg);
                        const replacementTs = res?.msg?.ts || Date.now();
                        replacementMsg = convId ? this._findTimelineMessageById(convId, replacementInfo.newMessageId) : null;

                        if (!replacementMsg) {
                            const mediaClone = msg.media ? { ...msg.media } : null;
                            if (mediaClone) {
                                mediaClone.uploading = false;
                                mediaClone.progress = 100;
                            }
                            replacementMsg = this.appendLocalOutgoingMessage({
                                text: msg.text || previewText,
                                ts: replacementTs,
                                id: replacementInfo.newMessageId,
                                msgType: 'media',
                                media: mediaClone
                            });
                        }
                        applyMediaMeta(replacementMsg, res);

                        if (!res?.queued && replacementMsg) {
                            messageStatus.applyOutgoingSent(replacementMsg, res, replacementTs, 'COUNTER_TOO_LOW_REPLACED');
                        }
                        this.updateMessagesUI({ preserveScroll: true, forceFullRender: true });

                    } else if (res?.queued) {
                        applyMediaMeta(msg, res);
                        const queuedCounter = normalizeCounterValue(res?.msg?.counter ?? res?.counter ?? res?.headerCounter);
                        if (msg && queuedCounter !== null) {
                            msg.counter = queuedCounter;
                        }
                        this.updateMessagesUI({ preserveScroll: true, forceFullRender: true });
                    } else if (msg) {
                        messageStatus.applyOutgoingSent(msg, res, Date.now());
                        applyMediaMeta(msg, res);
                        this.updateMessagesUI({ preserveScroll: true });
                    }

                    endUpload();

                } catch (err) {
                    endUpload();

                    // Unsupported video format — show user-friendly modal and remove the local message
                    if (err instanceof UnsupportedVideoFormatError || err?.name === 'UnsupportedVideoFormatError') {
                        const msg = this._findTimelineMessageById(state.conversationId, localMsg.id);
                        if (msg) this.removeLocalMessageById(localMsg.id);
                        this.deps.showToast?.(err.message || '不支援此影片格式');
                        continue;
                    }

                    // [FIX] User-initiated cancel (AbortError) — the message was
                    // already removed from the timeline by removeLocalMessageById,
                    // so just silently continue to the next file.
                    if (err?.name === 'AbortError' || (err instanceof DOMException && err.message === 'aborted')) {
                        continue;
                    }

                    const messageStatus = this.deps.messageStatus;
                    const msg = this._findTimelineMessageById(state.conversationId, localMsg.id);

                    const replacementInfo = messageStatus?.getReplacementInfo(err);

                    if (replacementInfo && msg) {
                        messageStatus.applyCounterTooLowReplaced(msg);
                        const replacementTs = Date.now();
                        let replacementMsg = state.conversationId
                            ? this._findTimelineMessageById(state.conversationId, replacementInfo.newMessageId)
                            : null;

                        if (!replacementMsg) {
                            const mediaClone = msg.media ? { ...msg.media } : null;
                            if (mediaClone) {
                                mediaClone.uploading = false;
                                mediaClone.progress = 100;
                            }
                            replacementMsg = this.appendLocalOutgoingMessage({
                                text: msg.text || previewText,
                                ts: replacementTs,
                                id: replacementInfo.newMessageId,
                                msgType: 'media',
                                media: mediaClone
                            });
                        }

                        if (replacementMsg) {
                            messageStatus.applyOutgoingFailure(replacementMsg, err, '檔案傳送失敗', 'COUNTER_TOO_LOW_REPAIR_FAILED');
                            this.applyUploadProgress(replacementMsg, { percent: replacementMsg.media?.progress ?? 0, error: err?.message || err });
                        }
                        this.updateMessagesUI({ preserveScroll: true, forceFullRender: true });
                        return;
                    }

                    if (msg && messageStatus?.isCounterTooLowError(err)) {
                        messageStatus.applyCounterTooLowReplaced(msg);
                        this.updateMessagesUI({ preserveScroll: true, forceFullRender: true });
                        return;
                    }

                    if (msg) {
                        messageStatus?.applyOutgoingFailure(msg, err, '檔案傳送失敗');
                        this.applyUploadProgress(msg, { percent: 0, error: err?.message || err });
                        this.updateUploadOverlayUI(msg.id, msg.media);
                    }
                }
            } // end for loop
        } catch (err) {
            console.error('File selection error', err);
            this.deps.showToast?.('檔案處理失敗');
        } finally {
            if (input) input.value = '';
        }
    }

    /**
     * Retry sending a failed message used by Manual Retry UI.
     * Deletes the old failed message and sends a new one (new ID).
     */
    async retryMessage(id) {
        const state = this.getMessageState();
        if (!state.conversationId) throw new Error('No active conversation');

        const msg = this._findTimelineMessageById(state.conversationId, id);
        if (!msg) throw new Error('Message not found');

        // Only support text retry for now
        if (msg.msgType !== 'text') {
            throw new Error('目前僅支援文字訊息重試');
        }

        const text = msg.text;

        // 1. Remove old message (Visual replacement)
        this.removeLocalMessageById(id);

        // 2. Resend as new message
        const newId = crypto.randomUUID();
        const newMsg = this.appendLocalOutgoingMessage({
            text,
            ts: Date.now(),
            id: newId,
            msgType: 'text'
        });

        try {
            const res = await sendDrText({
                peerAccountDigest: state.activePeerDigest,
                text,
                convId: state.conversationId,
                messageId: newId
            });

            // 3. Update Status on Success
            if (this.deps.messageStatus && res?.msg) {
                this.deps.messageStatus.applyOutgoingSent(newMsg, res, Date.now());
                this.updateMessagesUI({ preserveScroll: true, forceFullRender: true });
            }
        } catch (err) {
            // 4. Handle Failure (again)
            if (this.deps.messageStatus) {
                this.deps.messageStatus.applyOutgoingFailure(newMsg, err, '重試失敗');
                this.updateMessagesUI({ preserveScroll: true, forceFullRender: true });
            }
            throw err;
        }
    }
}
