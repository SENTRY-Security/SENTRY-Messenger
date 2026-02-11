/**
 * CallLogController
 * Manages call log message creation, call state events, and thread updates.
 */

import { BaseController } from './base-controller.js';
import { normalizePeerKey } from '../contact-core-store.js';
import { getAccountDigest, normalizePeerDeviceId, normalizePeerIdentity } from '../../../core/store.js';
import {
    CALL_SESSION_STATUS,
    CALL_SESSION_DIRECTION,
    resolveCallPeerProfile
} from '../../../features/calls/state.js';
import { CALL_LOG_OUTCOME, describeCallLogForViewer, resolveViewerRole } from '../../../features/calls/call-log.js';
import { sendDrCallLog } from '../../../features/dr-session.js';
import { appendUserMessage } from '../../../features/timeline-store.js';

export class CallLogController extends BaseController {
    constructor(deps) {
        super(deps);
        /** @type {Set<string>} */
        this.sentCallLogIds = new Set();
        /** @type {Map<string, any>} */
        this.callLogPlaceholders = new Map();
    }

    /**
     * Create placeholder key for call log tracking.
     */
    _makeCallLogPlaceholderKey(peerDigest, callId) {
        return `${peerDigest || '?'}::${callId || '?'}`;
    }

    /**
     * Track a call log placeholder.
     */
    trackCallLogPlaceholder(peerDigest, callId, message) {
        const key = this._makeCallLogPlaceholderKey(peerDigest, callId);
        this.callLogPlaceholders.set(key, message);
    }

    /**
     * Resolve a call log placeholder.
     */
    resolveCallLogPlaceholder(peerDigest, callId) {
        const key = this._makeCallLogPlaceholderKey(peerDigest, callId);
        return this.callLogPlaceholders.get(key) || null;
    }

    /**
     * Release a call log placeholder.
     */
    releaseCallLogPlaceholder(peerDigest, callId) {
        const key = this._makeCallLogPlaceholderKey(peerDigest, callId);
        this.callLogPlaceholders.delete(key);
    }

    /**
     * Clear all call log placeholders.
     */
    clearCallLogPlaceholders() {
        this.callLogPlaceholders.clear();
    }

    /**
     * Check if a call log ID exists.
     */
    hasCallLog(callId) {
        if (!callId) return false;
        if (this.sentCallLogIds.has(callId)) return true;
        const state = this.getMessageState();
        const messages = state.messages || [];
        return messages.some((m) => m?.callLog?.callId === callId || m?.callId === callId);
    }

    /**
     * Get thread peer key.
     */
    _threadPeer(thread) {
        if (!thread) return null;
        return normalizePeerKey(thread.peerAccountDigest ?? thread);
    }

    /**
     * Ensure peer account digest from source.
     */
    _ensurePeerAccountDigest(source) {
        if (!source) return null;
        if (typeof source === 'string') return normalizePeerKey(source);
        return normalizePeerKey(source.peerAccountDigest || source.accountDigest || source.peerKey || null);
    }

    /**
     * Create a call log message object.
     */
    createCallLogMessage(entry, { messageDirection = 'outgoing' } = {}) {
        const callLog = {
            callId: entry.callId || null,
            outcome: entry.outcome,
            durationSeconds: entry.durationSeconds,
            authorRole: entry.direction || CALL_SESSION_DIRECTION.OUTGOING,
            reason: entry.reason || null
        };
        const viewerRole = resolveViewerRole(callLog.authorRole, messageDirection);
        const { label, subLabel } = describeCallLogForViewer(callLog, viewerRole);
        return {
            id: entry.id || null,
            ts: entry.ts,
            msgType: 'call-log',
            direction: messageDirection,
            text: label,
            callLog: {
                ...callLog,
                viewerRole,
                label,
                subLabel
            }
        };
    }

    /**
     * Update thread displays with call log info.
     */
    updateThreadsWithCallLogDisplay({ peerAccountDigest, label, ts, direction }) {
        const threads = this.deps.getConversationThreads?.() || new Map();
        let touched = false;
        for (const thread of threads.values()) {
            if (this._threadPeer(thread) === normalizePeerKey(peerAccountDigest)) {
                thread.lastMessageText = label;
                thread.lastMessageTs = ts;
                thread.lastDirection = direction;
                thread.lastReadTs = ts;
                thread.unreadCount = 0;
                thread.needsRefresh = true;
                touched = true;
            }
        }
        if (touched) {
            this.deps.renderConversationList?.();
        }
    }

    /**
     * Update thread avatar.
     */
    updateThreadAvatar(peerAccountDigest, avatarData) {
        const key = normalizePeerKey(peerAccountDigest);
        if (!key) return;
        const threads = this.deps.getConversationThreads?.() || new Map();
        let touched = false;
        for (const thread of threads.values()) {
            if (this._threadPeer(thread) === key) {
                thread.avatar = avatarData || null;
                touched = true;
            }
        }
        if (touched) {
            this.deps.renderConversationList?.();
        }
    }

    /**
     * Handle call state event (call ended/failed).
     */
    handleCallStateEvent(detail = {}) {
        const session = detail.session || null;
        if (!session) return;

        const status = session.status;
        if (![CALL_SESSION_STATUS.ENDED, CALL_SESSION_STATUS.FAILED].includes(status)) return;

        const peerProfile = resolveCallPeerProfile({
            peerAccountDigest: session.peerAccountDigest,
            peerDeviceId: session.peerDeviceId,
            peerKey: session.peerKey || null
        });

        const peerDigest = peerProfile.peerAccountDigest || this._ensurePeerAccountDigest(session);
        const peerDeviceId = peerProfile.peerDeviceId
            || normalizePeerDeviceId(session?.peerDeviceId || null)
            || normalizePeerIdentity(session?.peerKey || session)?.deviceId
            || null;

        const identifier = session.callId || session.traceId || `${peerDigest || 'unknown'}-${session.requestedAt || Date.now()}`;
        if (this.sentCallLogIds.has(identifier)) return;
        this.sentCallLogIds.add(identifier);

        if (!peerDigest || !peerDeviceId) {
            this.log({ callLogSkip: 'missing-peer', callId: session.callId || identifier });
            return;
        }

        const state = this.getMessageState();
        const conversationId = state.conversationId || peerProfile.conversationId || null;
        if (!conversationId) {
            this.log({ callLogSkip: 'missing-conversation', callId: session.callId || identifier });
            return;
        }

        const endedAtMs = session.endedAt || Date.now();
        const startedAtMs = session.connectedAt || session.requestedAt || null;
        const startedAt = startedAtMs || null;
        const endedAt = endedAtMs;

        const direction = (() => {
            if (session.direction === CALL_SESSION_DIRECTION.INCOMING || session.direction === CALL_SESSION_DIRECTION.OUTGOING) {
                return session.direction;
            }
            const myAcct = getAccountDigest?.() || null;
            const callerAcct = session.initiatorAccountDigest || session.callerAccountDigest || null;
            if (callerAcct && (!myAcct || String(callerAcct).toUpperCase() !== String(myAcct).toUpperCase())) {
                return CALL_SESSION_DIRECTION.INCOMING;
            }
            return CALL_SESSION_DIRECTION.OUTGOING;
        })();

        const durationSeconds = (session.connectedAt && endedAtMs)
            ? Math.max(0, Math.floor((endedAtMs - session.connectedAt) / 1000))
            : 0;
        const rawReason = detail.reason || session.lastError || '';
        const normalizedReason = typeof rawReason === 'string' ? rawReason : '';

        let outcome = CALL_LOG_OUTCOME.MISSED;
        if (session.connectedAt && status === CALL_SESSION_STATUS.ENDED) {
            outcome = CALL_LOG_OUTCOME.SUCCESS;
        } else if (/cancel/i.test(normalizedReason)) {
            outcome = CALL_LOG_OUTCOME.CANCELLED;
        } else if (/reject/i.test(normalizedReason)) {
            outcome = CALL_LOG_OUTCOME.FAILED;
        } else if (status === CALL_SESSION_STATUS.FAILED && normalizedReason) {
            outcome = CALL_LOG_OUTCOME.FAILED;
        } else {
            outcome = CALL_LOG_OUTCOME.MISSED;
        }

        const messageId = crypto.randomUUID();
        const entry = {
            id: messageId,
            callId: session.callId || identifier,
            ts: endedAt,
            peerAccountDigest: peerDigest,
            peerDeviceId,
            direction,
            durationSeconds,
            outcome,
            reason: normalizedReason || null,
            startedAt,
            endedAt
        };

        const isOutgoing = direction === CALL_SESSION_DIRECTION.OUTGOING;
        const isActive = state.activePeerDigest === peerDigest
            && (!state.activePeerDeviceId || state.activePeerDeviceId === peerDeviceId);
        const exists = this.hasCallLog(entry.callId);

        const viewerMessage = this.createCallLogMessage(entry, { messageDirection: isOutgoing ? 'outgoing' : 'incoming' });

        let localMessage = null;
        if (isActive && !exists) {
            localMessage = { ...viewerMessage };
            localMessage.id = localMessage.id || entry.id;
            localMessage.messageId = localMessage.id;
            localMessage.localId = localMessage.id;
            localMessage.serverMessageId = null;
            localMessage.status = 'pending';
            localMessage.pending = true;
            localMessage.failureReason = null;
            localMessage.failureCode = null;
            localMessage.msgType = 'call-log';
            localMessage.direction = isOutgoing ? 'outgoing' : 'incoming';
            localMessage.ts = localMessage.ts || entry.ts;
            localMessage.conversationId = conversationId;

            const appended = appendUserMessage(conversationId, localMessage);
            if (appended) {
                this.log({ event: 'timeline:append', conversationId, messageId: localMessage.id, msgType: 'call-log' });
            }

            this.deps.refreshTimelineState?.(conversationId);
            this.deps.updateMessagesUI?.({ scrollToEnd: outcome === CALL_LOG_OUTCOME.SUCCESS });
            this.trackCallLogPlaceholder(peerDigest, entry.callId, localMessage);
        }

        this.updateThreadsWithCallLogDisplay({
            peerAccountDigest: peerDigest,
            label: viewerMessage.text,
            ts: entry.ts,
            direction: isOutgoing ? 'outgoing' : 'incoming'
        });

        if (entry.id && !this.sentCallLogIds.has(entry.id) && !exists) {
            this.sentCallLogIds.add(entry.id);
            this._sendCallLog(entry, conversationId, peerDigest, peerDeviceId, outcome, durationSeconds, normalizedReason, startedAt, endedAt, localMessage);
        }

        this.releaseCallLogPlaceholder(peerDigest, entry.callId);
    }

    /**
     * Send call log to server.
     * @private
     */
    async _sendCallLog(entry, conversationId, peerDigest, peerDeviceId, outcome, durationSeconds, reason, startedAt, endedAt, localMessage) {
        try {
            const res = await sendDrCallLog({
                peerAccountDigest: peerDigest,
                peerDeviceId,
                callId: entry.callId,
                outcome,
                durationSeconds,
                direction: entry.direction,
                reason: reason || null,
                ts: entry.ts,
                startedAt,
                endedAt,
                conversation: { conversation_id: conversationId },
                messageId: entry.id
            });

            const replacementInfo = this.deps.getReplacementInfo?.(res);
            if (localMessage && replacementInfo) {
                this.deps.applyCounterTooLowReplaced?.(localMessage);
                this.deps.updateMessagesStatusUI?.();
                return;
            }
            if (localMessage && res?.queued) {
                this.deps.updateMessagesStatusUI?.();
                return;
            }
            if (localMessage) {
                try {
                    this.deps.applyOutgoingSent?.(localMessage, res, localMessage.ts || entry.ts);
                } catch (err) {
                    this.deps.applyOutgoingFailure?.(localMessage, err, '通話記錄傳送失敗');
                }
                this.deps.updateMessagesStatusUI?.();
            }
        } catch (err) {
            this.log({ callLogSendError: err?.message || err, peerAccountDigest: peerDigest });
            if (localMessage) {
                const replacementInfo = this.deps.getReplacementInfo?.(err);
                if (replacementInfo || this.deps.isCounterTooLowError?.(err)) {
                    this.deps.applyCounterTooLowReplaced?.(localMessage);
                } else {
                    this.deps.applyOutgoingFailure?.(localMessage, err, '通話記錄傳送失敗');
                }
                this.deps.updateMessagesStatusUI?.();
            }
        }
    }
}
