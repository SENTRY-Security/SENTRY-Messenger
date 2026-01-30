/**
 * ComposerController
 * Manages message composer input, availability states, and conversation actions.
 */

import { BaseController } from './base-controller.js';
import { normalizePeerKey, resolveContactAvatarUrl } from '../contact-core-store.js';
import { SECURE_CONVERSATION_STATUS } from '../../../features/secure-conversation-manager.js';
import {
    requestOutgoingCall,
    getCallSessionSnapshot,
    getCallCapability,
    CALL_REQUEST_KIND,
    CALL_SESSION_DIRECTION,
    getSelfProfileSummary
} from '../../../features/calls/state.js';
import { sendCallInviteSignal } from '../../../features/calls/signaling.js';
import { startOutgoingCallMedia } from '../../../features/calls/media-session.js';
import { prepareCallKeyEnvelope } from '../../../features/calls/key-manager.js';
import { buildCallPeerIdentity } from '../../../features/calls/identity.js';
import { getAccountDigest, normalizePeerIdentity } from '../../../core/store.js';
import { sendDrText } from '../../../features/dr-session.js';
import { getReplacementInfo } from '../../../features/messages/ui/outbox-hooks.js';
import { normalizeCounterValue, normalizeTimelineMessageId } from '../../../features/messages/parser.js';
import { getTimeline as timelineGetTimeline, upsertTimelineEntry } from '../../../features/timeline-store.js';

export class ComposerController extends BaseController {
    constructor(deps) {
        super(deps);
        this.pendingNewMessageHint = false;
        this.suppressInputBlurOnce = false;
    }

    /**
     * Check if subscription is active.
     */
    _isSubscriptionActive() {
        return this.deps.isSubscriptionActive?.() ?? true;
    }

    /**
     * Require subscription to be active, showing modal if not.
     */
    _requireSubscriptionActive() {
        return this.deps.requireSubscriptionActive?.() ?? true;
    }

    /**
     * Set messages status label.
     */
    setMessagesStatus(message, isError = false) {
        if (!this.elements.statusLabel) return;
        this.elements.statusLabel.textContent = message || '';
        this.elements.statusLabel.style.color = isError ? '#dc2626' : '#64748b';
        if (this.pendingNewMessageHint && message !== '有新訊息') {
            this.pendingNewMessageHint = false;
        }
    }

    /**
     * Suppress composer blur once (for button clicks that steal focus).
     */
    suppressComposerBlurOnce() {
        if (this.suppressInputBlurOnce) return;
        this.suppressInputBlurOnce = true;
        const clear = () => {
            this.suppressInputBlurOnce = false;
            document.removeEventListener('click', clear);
            document.removeEventListener('touchend', clear);
        };
        setTimeout(() => {
            document.addEventListener('click', clear, { once: true });
            document.addEventListener('touchend', clear, { once: true });
        }, 0);
        setTimeout(clear, 500);
    }

    /**
     * Update call/video button availability.
     */
    updateConversationActionsAvailability() {
        const state = this.getMessageState();
        const enabled = !!(state.activePeerDigest && state.conversationToken && this._isSubscriptionActive());
        const buttons = [this.elements.callBtn, this.elements.videoBtn];
        for (const btn of buttons) {
            if (!btn) continue;
            btn.disabled = !enabled;
            btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
        }
    }

    /**
     * Update composer input and send button availability.
     */
    updateComposerAvailability() {
        const state = this.getMessageState();
        if (!this.elements.input || !this.elements.sendBtn) {
            this.updateConversationActionsAvailability();
            return;
        }

        const subscriptionOk = this._isSubscriptionActive();
        const key = state.activePeerDigest ? String(state.activePeerDigest).toUpperCase() : null;
        const statusInfo = key ? this.deps.getCachedSecureStatus?.(key) : null;
        const statusResolution = key ? this.deps.resolveSecureStatusForUi?.(key, statusInfo, state) : { status: null };
        const status = statusResolution.status;

        const conversationReady = !!(state.conversationToken && state.activePeerDigest);
        const isLoading = !!state.loading;
        const blocked = !subscriptionOk || status === SECURE_CONVERSATION_STATUS.PENDING || status === SECURE_CONVERSATION_STATUS.FAILED || isLoading;
        const enabled = conversationReady && !blocked;

        this.elements.input.disabled = !conversationReady || blocked;
        this.elements.sendBtn.disabled = !conversationReady;
        this.elements.sendBtn.classList.toggle('disabled', !enabled);
        this.elements.sendBtn.setAttribute('aria-disabled', enabled ? 'false' : 'true');

        let placeholder = '輸入訊息…';
        if (isLoading) {
            placeholder = '正在同步歷史訊息…';
        } else if (!state.conversationToken || !state.activePeerDigest) {
            placeholder = '選擇好友開始聊天';
        } else if (!subscriptionOk) {
            placeholder = '帳號已到期，請儲值後再聊天';
        } else if (status === SECURE_CONVERSATION_STATUS.PENDING) {
            placeholder = '正在建立安全對話…';
        } else if (status === SECURE_CONVERSATION_STATUS.FAILED) {
            placeholder = statusInfo?.error ? `安全對話失敗：${statusInfo.error}` : '安全對話建立失敗，請稍後再試。';
        }
        this.elements.input.placeholder = placeholder;

        this.updateConversationActionsAvailability();
    }

    /**
     * Handle call/video button action.
     * @param {string} type - 'call' or 'video'
     */
    async handleConversationAction(type) {
        const state = this.getMessageState();
        const preconditionMissing = [];
        if (!state.activePeerDigest) preconditionMissing.push('activePeerDigest');
        if (!state.conversationToken) preconditionMissing.push('conversationToken');

        if (preconditionMissing.length) {
            return;
        }

        const actionType = type === 'video' ? 'voice' : type; // Video temporarily disabled
        const contactEntry = this.sessionStore.contactIndex?.get?.(state.activePeerDigest) || null;
        const fallbackName = `好友 ${state.activePeerDigest.slice(-4)}`;
        const displayName = contactEntry?.nickname || contactEntry?.profile?.nickname || fallbackName;
        const avatarUrl = resolveContactAvatarUrl(contactEntry);

        const peerIdentity = normalizePeerIdentity({
            peerAccountDigest: state.activePeerDigest,
            peerDeviceId: state.activePeerDeviceId || contactEntry?.conversation?.peerDeviceId || contactEntry?.peerDeviceId || null
        });
        const peerAccountDigest = peerIdentity.accountDigest || null;
        const peerDeviceId = peerIdentity.deviceId || null;

        if (!peerAccountDigest || !peerDeviceId) {
            if (!peerDeviceId) {
                this.showToast('缺少對端裝置資訊，請重新同步好友');
            } else {
                this.showToast('找不到通話對象');
            }
            return;
        }

        const { peerKey } = buildCallPeerIdentity({ peerAccountDigest, peerDeviceId });

        if (!this._requireSubscriptionActive()) return;

        let result;
        try {
            result = await requestOutgoingCall({
                peerDisplayName: displayName,
                peerAvatarUrl: avatarUrl,
                peerAccountDigest,
                peerDeviceId,
                kind: actionType === 'video' ? CALL_REQUEST_KIND.VIDEO : CALL_REQUEST_KIND.VOICE
            });
        } catch (err) {
            result = { ok: false, error: err?.message || 'call invite failed' };
        }

        if (!result?.ok) {
            if (result?.error === 'CALL_ALREADY_IN_PROGRESS') {
                this.showToast('已有進行中的通話');
            } else if (result?.error === 'MISSING_PEER') {
                this.showToast('找不到通話對象');
            } else {
                this.showToast(result?.error || '暫時無法啟動通話');
            }
            return;
        }

        const snapshot = getCallSessionSnapshot();
        const callId = result.callId || snapshot?.callId || null;
        if (!callId) {
            this.log({ callInviteSignalSkipped: true, reason: 'missing-call-id', peerAccountDigest: state.activePeerDigest });
            this.showToast('無法建立通話：缺少識別碼');
            return;
        }

        let envelope;
        try {
            envelope = await prepareCallKeyEnvelope({
                callId,
                peerAccountDigest,
                peerDeviceId,
                direction: CALL_SESSION_DIRECTION.OUTGOING
            });
        } catch (err) {
            this.log({ callKeyEnvelopeError: err?.message || err, peerAccountDigest: state.activePeerDigest });
            this.showToast('無法建立通話加密金鑰');
            return;
        }

        const traceId = snapshot?.traceId || result?.session?.metadata?.traceId || null;
        const capabilities = getCallCapability() || null;
        const callerSummary = getSelfProfileSummary() || {};
        const fallbackCallerName = (() => {
            const digest = getAccountDigest();
            return digest ? `好友 ${digest.slice(-4)}` : null;
        })();
        const callerDisplayName = callerSummary.displayName || fallbackCallerName || null;
        const callerAvatarUrl = callerSummary.avatarUrl || this.sessionStore.currentAvatarUrl || null;

        const metadata = {};
        if (callerDisplayName) {
            metadata.displayName = callerDisplayName;
            metadata.callerDisplayName = callerDisplayName;
        }
        if (callerAvatarUrl) {
            metadata.avatarUrl = callerAvatarUrl;
            metadata.callerAvatarUrl = callerAvatarUrl;
        }
        if (displayName) metadata.peerDisplayName = displayName;
        if (avatarUrl) metadata.peerAvatarUrl = avatarUrl;

        const sent = sendCallInviteSignal({
            callId,
            peerAccountDigest: peerAccountDigest || state.activePeerDigest,
            mode: actionType === 'video' ? 'video' : 'voice',
            metadata,
            capabilities,
            envelope,
            traceId
        });

        if (!sent) {
            this.log({ callInviteSignalFailed: true, callId, peerAccountDigest: state.activePeerDigest });
            this.showToast('通話信令傳送失敗');
            return;
        }

        try {
            await startOutgoingCallMedia({ callId, peerAccountDigest: state.activePeerDigest });
        } catch (err) {
            this.log({ callMediaStartError: err?.message || err });
            this.showToast('無法啟動通話媒體：' + (err?.message || err));
        }

        this.showToast('已發起語音通話');
    }

    /**
     * Helper to find a message in the timeline.
     */
    _findTimelineMessageById(conversationId, messageId) {
        if (!conversationId || !messageId) return null;
        const timeline = timelineGetTimeline(conversationId);
        return timeline.find((msg) => normalizeTimelineMessageId(msg) === messageId) || null;
    }

    /**
     * Handle composer submit event.
     */
    async handleComposerSubmit(event) {
        event.preventDefault();
        if (!this._requireSubscriptionActive()) {
            this.setMessagesStatus('帳號已到期，請先儲值', true);
            return;
        }

        const text = (this.elements.input?.value || '').trim();
        if (!text) return;

        const state = this.getMessageState();
        const contactEntryLog = state.activePeerDigest ? this.sessionStore.contactIndex?.get?.(state.activePeerDigest) : null;

        // UI Noise Logging
        if (this.deps.uiNoiseEnabled?.()) {
            this.log({
                messageComposerSubmit: {
                    peer: state.activePeerDigest,
                    hasToken: !!state.conversationToken,
                    contactHasToken: !!contactEntryLog?.conversation?.token_b64
                }
            });
        }

        if (!state.conversationToken || !state.activePeerDigest) {
            this.setMessagesStatus('請先選擇已建立安全對話的好友', true);
            return;
        }

        if (this.elements.sendBtn) this.elements.sendBtn.disabled = true;
        const ts = Date.now();
        const messageId = crypto.randomUUID();

        // 2. Append to local timeline immediately
        const localMsg = this.deps.appendLocalOutgoingMessage?.({ text, ts, id: messageId });

        if (this.elements.input) {
            this.elements.input.value = '';
            this.elements.input.focus();
        }

        try {
            const res = await sendDrText({
                peerAccountDigest: state.activePeerDigest,
                peerDeviceId: state.activePeerDeviceId || null,
                text,
                messageId
            });

            if (this.deps.uiNoiseEnabled?.()) {
                this.log({
                    messageComposerSent: {
                        peer: state.activePeerDigest,
                        convId: res?.convId || null,
                        msgId: res?.msg?.id || res?.id || null
                    }
                });
            }

            const replacementInfo = getReplacementInfo(res);
            const convId = res?.convId || state.conversationId;
            if (res?.convId) state.conversationId = res.convId;

            // [FIX] New Conversation: Retry local append if it failed initially (due to missing convId)
            let effectiveLocalMsg = localMsg;
            if (!effectiveLocalMsg && state.conversationId) {
                effectiveLocalMsg = this.deps.appendLocalOutgoingMessage?.({ text, ts, id: messageId });
                console.log('[Composer] Retroactive append for new conversation', { msgId: messageId, success: !!effectiveLocalMsg });
            }

            let replacementMsg = null;
            if (replacementInfo && effectiveLocalMsg) {
                this.deps.messageStatus?.applyCounterTooLowReplaced(effectiveLocalMsg);
                const replacementTs = res?.msg?.ts || ts;
                replacementMsg = convId ? this._findTimelineMessageById(convId, replacementInfo.newMessageId) : null;

                if (!replacementMsg) {
                    replacementMsg = this.deps.appendLocalOutgoingMessage?.({
                        text,
                        ts: replacementTs,
                        id: replacementInfo.newMessageId
                    });
                }

                if (!res?.queued && replacementMsg) {
                    this.deps.messageStatus?.applyOutgoingSent(replacementMsg, res, replacementTs, 'COUNTER_TOO_LOW_REPLACED');
                }
                this.deps.updateMessagesUI?.({ preserveScroll: true, forceFullRender: true });
            } else if (res?.queued) {
                const queuedCounter = normalizeCounterValue(res?.msg?.counter ?? res?.counter ?? res?.headerCounter);
                if (effectiveLocalMsg && queuedCounter !== null) {
                    effectiveLocalMsg.counter = queuedCounter;
                }
                this.deps.updateMessagesUI?.({ preserveScroll: true, forceFullRender: true });
            } else if (effectiveLocalMsg) {
                this.deps.messageStatus?.applyOutgoingSent(effectiveLocalMsg, res, ts);

                // [FIX] Double-ensure status update via direct store access
                upsertTimelineEntry(state.conversationId, {
                    messageId: effectiveLocalMsg.id,
                    status: 'sent',
                    pending: false,
                    error: null
                });

                this.deps.updateMessagesUI?.({ preserveScroll: true, forceFullRender: true });
            }
            this.setMessagesStatus('');
        } catch (err) {
            if (this.deps.uiNoiseEnabled?.()) {
                this.log({ messageComposerError: err?.message || err });
            }

            const replacementInfo = this.deps.messageStatus?.getReplacementInfo(err);
            if (replacementInfo && localMsg) {
                this.deps.messageStatus?.applyCounterTooLowReplaced(localMsg);
                const replacementTs = ts || Date.now();
                let replacementMsg = state.conversationId
                    ? this._findTimelineMessageById(state.conversationId, replacementInfo.newMessageId)
                    : null;

                if (!replacementMsg) {
                    replacementMsg = this.deps.appendLocalOutgoingMessage?.({
                        text,
                        ts: replacementTs,
                        id: replacementInfo.newMessageId
                    });
                }

                if (replacementMsg) {
                    this.deps.messageStatus?.applyOutgoingFailure(replacementMsg, err, '傳送失敗', 'COUNTER_TOO_LOW_REPAIR_FAILED');
                }
                this.deps.updateMessagesUI?.({ preserveScroll: true, forceFullRender: true });
                return;
            }

            if (localMsg && this.deps.messageStatus?.isCounterTooLowError(err)) {
                this.deps.messageStatus?.applyCounterTooLowReplaced(localMsg);
                this.deps.updateMessagesUI?.({ preserveScroll: true, forceFullRender: true });
                return;
            }

            this.setMessagesStatus('傳送失敗：' + (err?.message || err), true);
            if (localMsg) {
                this.deps.messageStatus?.applyOutgoingFailure(localMsg, err, '傳送失敗', 'UI_SEND_THROW');
                this.deps.updateMessagesUI?.({ preserveScroll: true, forceFullRender: true });
            }
        } finally {
            if (this.elements.sendBtn) this.elements.sendBtn.disabled = false;
        }
    }
}

