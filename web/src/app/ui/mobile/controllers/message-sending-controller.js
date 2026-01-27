/**
 * MessageSendingController
 * Manages outgoing messages, including local append, file selection, and upload progress.
 */

import { BaseController } from './base-controller.js';
import { appendUserMessage, getTimeline } from '../../../features/timeline-store.js';
import { sendDrMedia, sendDrText } from '../../../features/dr-session.js';
import { escapeSelector } from '../ui-utils.js';
import { normalizeCounterValue } from '../../../features/messages/parser.js';

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
     */
    removeLocalMessageById(id) {
        if (!id) return;
        const state = this.getMessageState();
        if (!state.conversationId) return;

        // This is a bit tricky since timeline-store might not expose a remove method easily.
        // In messages-pane.js it seems it wasn't implemented or relied on re-render?
        // Let's check the original implementation.
        // Original implementation in messages-pane.js line 1921:
        /*
          function removeLocalMessageById(id) {
            const state = getMessageState();
            const timeline = getTimeline(state.conversationId);
            const idx = timeline.findIndex(m => m.id === id);
            if (idx !== -1) {
              timeline.splice(idx, 1);
              updateMessagesUI({ preserveScroll: true });
            }
          }
        */
        const timeline = getTimeline(state.conversationId);
        const idx = timeline.findIndex(m => m.id === id);
        if (idx !== -1) {
            timeline.splice(idx, 1);
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

                const progressHandler = (progress) => {
                    const msg = this._findTimelineMessageById(state.conversationId, localMsg.id);
                    if (!msg) return;
                    const percent = Number.isFinite(progress?.percent)
                        ? progress.percent
                        : (progress?.loaded && progress?.total ? (progress.loaded / progress.total) * 100 : null);

                    this.applyUploadProgress(msg, { percent });
                    this.updateUploadOverlayUI(msg.id, msg.media);
                };

                const abortController = new AbortController();
                localMsg.abortController = abortController;

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
                        targetMsg.media = {
                            ...targetMsg.media,
                            ...payload?.msg?.media,
                            name: (payload?.msg?.media?.name || targetMsg.media.name || file.name || '附件'),
                            size: Number.isFinite(payload?.msg?.media?.size) ? payload.msg.media.size : (typeof file.size === 'number' ? file.size : targetMsg.media.size || null),
                            contentType: payload?.msg?.media?.contentType || targetMsg.media.contentType || file.type || 'application/octet-stream',
                            localUrl: targetMsg.media.localUrl || localUrl,
                            previewUrl: payload?.msg?.media?.previewUrl || targetMsg.media.previewUrl || targetMsg.media.localUrl || localUrl,
                            uploading: false,
                            progress: 100,
                            envelope: payload?.msg?.media?.envelope || targetMsg.media.envelope || null,
                            objectKey: payload?.msg?.media?.objectKey || targetMsg.media.objectKey || payload?.upload?.objectKey || null,
                            preview: payload?.msg?.media?.preview || targetMsg.media.preview || null
                        };
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
                    }

                } catch (err) {
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
