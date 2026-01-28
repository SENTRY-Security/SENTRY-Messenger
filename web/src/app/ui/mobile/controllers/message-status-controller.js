/**
 * MessageStatusController
 * Manages outgoing message status transitions, receipt handling, and failure states.
 */

import { BaseController } from './base-controller.js';
import { normalizeCounterValue } from '../../../features/messages/parser.js';
import { getVaultAckCounter } from '../../../features/messages/receipts.js';

export class MessageStatusController extends BaseController {
    constructor(deps) {
        super(deps);
        this._statusTraceLimit = 20;
        this._statusTraceCount = 0;
    }

    /**
     * Resolve message ID for status tracking.
     */
    _resolveOutgoingStatusMessageId(message) {
        return message?.id || message?.localId || message?.messageId || null;
    }

    /**
     * Log status transition trace.
     */
    _logOutgoingStatusTrace(message, fromStatus, toStatus, reasonCode) {
        if (this._statusTraceCount >= this._statusTraceLimit) return;
        this._statusTraceCount++;
        this.log({
            outgoingStatusTrace: {
                messageId: this._resolveOutgoingStatusMessageId(message),
                from: fromStatus,
                to: toStatus,
                reason: reasonCode
            }
        });
    }

    /**
     * Log UI status transition with additional context.
     */
    logOutgoingUiStatusTrace(data) {
        this._logOutgoingUiStatusTrace(data);
    }

    _logOutgoingUiStatusTrace({
        message,
        fromStatus,
        toStatus,
        reasonCode,
        stage,
        ok = null,
        statusCode = null,
        error = null,
        jobId = null
    } = {}) {
        this.logCapped('outgoingUiStatusTrace', {
            messageId: this._resolveOutgoingStatusMessageId(message),
            from: fromStatus,
            to: toStatus,
            reason: reasonCode,
            stage,
            ok,
            statusCode,
            error,
            jobId
        });
    }

    /**
     * Log status transition trace.
     */
    logOutgoingStatusTrace(message, fromStatus, toStatus, reasonCode) {
        this._logOutgoingStatusTrace(message, fromStatus, toStatus, reasonCode);
    }

    /**
     * Extract failure details from error.
     */
    extractFailureDetails(err, fallbackReason = 'send failed') {
        const reason = typeof err?.message === 'string'
            ? err.message
            : (typeof err === 'string' ? err : fallbackReason);
        let code = err?.code || err?.errorCode || err?.stage || null;
        if (!code && Number.isFinite(err?.status)) code = `HTTP_${Number(err.status)}`;
        if (!code) code = 'Unknown';
        if (code !== null && code !== undefined) code = String(code);
        return { reason, code };
    }

    /**
     * Check if error is CounterTooLow error.
     */
    isCounterTooLowError(err) {
        if (!err) return false;
        const code = err?.code || err?.errorCode || err?.details?.error || err?.details?.code || err?.error || null;
        if (code && String(code) === 'CounterTooLow') return true;
        const message = typeof err?.message === 'string' ? err.message : '';
        return message.includes('CounterTooLow');
    }

    /**
     * Apply receipt state to outgoing message based on vault ack counter.
     */
    applyReceiptState(message) {
        if (!message || message.direction !== 'outgoing') return false;
        const currentStatus = typeof message.status === 'string' ? message.status : null;
        if (currentStatus === 'failed') return false;

        const state = this.getMessageState();
        const convId = message.conversationId || state.conversationId || null;
        if (!convId) return false;

        const messageId = this._resolveOutgoingStatusMessageId(message);
        if (!messageId || !this.deps.isLatestOutgoingForStatus?.(convId, messageId)) return false;

        const counter = this.deps.resolveRenderEntryCounter?.(message);
        if (!Number.isFinite(counter)) return false;

        const ackCounter = getVaultAckCounter(convId);
        const delivered = Number.isFinite(ackCounter) && ackCounter >= counter;

        if (delivered) {
            const shouldUpdate = currentStatus !== 'delivered' || message.pending === true || message.read === true;
            if (shouldUpdate) {
                this._logOutgoingStatusTrace(message, currentStatus, 'delivered', 'VAULT_ACK_COUNTER');
                this._logOutgoingUiStatusTrace({
                    message,
                    fromStatus: currentStatus,
                    toStatus: 'delivered',
                    reasonCode: 'VAULT_ACK_COUNTER',
                    stage: 'applyReceiptState'
                });
            }
            message.read = false;
            message.status = 'delivered';
            message.pending = false;
            return shouldUpdate;
        }

        if (currentStatus === 'delivered') {
            message.read = false;
            message.status = 'sent';
            message.pending = false;
            this._logOutgoingUiStatusTrace({
                message,
                fromStatus: currentStatus,
                toStatus: 'sent',
                reasonCode: 'VAULT_ACK_MISSING',
                stage: 'applyReceiptState'
            });
            this._logOutgoingStatusTrace(message, currentStatus, 'sent', 'VAULT_ACK_MISSING');
            return true;
        }

        return false;
    }

    /**
     * Apply receipt state to a list of messages.
     */
    applyReceiptsToMessages(list) {
        if (!Array.isArray(list)) return false;
        let changed = false;
        for (const msg of list) {
            if (this.applyReceiptState(msg)) changed = true;
        }
        return changed;
    }

    /**
     * Apply sent status to outgoing message.
     */
    applyOutgoingSent(message, res, fallbackTs, reasonCode = 'ACK_202') {
        if (!message) return;
        console.log('[MessageStatus] applyOutgoingSent:entry', {
            id: message.id || message.messageId,
            status: message.status,
            pending: message.pending
        });

        const fromStatus = typeof message.status === 'string' ? message.status : null;
        if (fromStatus === 'failed' || fromStatus === 'delivered' || fromStatus === 'read') return;
        if (this.isCounterTooLowError(res)) return;

        const localId = message.localId || message.messageId || message.id || null;
        const serverId = res?.msg?.id || res?.id || res?.serverMessageId || res?.server_message_id || null;
        if (serverId && localId && serverId !== localId) {
            throw new Error('messageId mismatch from server');
        }

        const finalId = serverId || message.id || localId;
        if (finalId) message.id = finalId;
        message.serverMessageId = serverId || finalId;

        const resCounter = normalizeCounterValue(res?.msg?.counter ?? res?.msg?.headerCounter ?? res?.counter ?? res?.headerCounter);
        if (resCounter !== null) message.counter = resCounter;

        message.status = 'sent';
        message.pending = false;
        message.failureReason = null;
        message.failureCode = null;

        const ts = res?.msg?.ts || res?.created_at || res?.createdAt || fallbackTs;
        if (Number.isFinite(ts)) message.ts = ts;

        console.log('[MessageStatus] applyOutgoingSent:check', {
            id: message.id,
            status: message.status,
            pending: message.pending,
            counter: message.counter
        });

        this._logOutgoingUiStatusTrace({
            message,
            fromStatus,
            toStatus: 'sent',
            reasonCode,
            stage: 'applyOutgoingSent',
            ok: true,
            statusCode: res?.status ?? res?.r?.status ?? res?.statusCode ?? null,
            jobId: res?.jobId ?? res?.job?.jobId ?? null
        });
        this._logOutgoingStatusTrace(message, fromStatus, 'sent', reasonCode);
    }

    /**
     * Apply failure status to outgoing message.
     */
    applyOutgoingFailure(message, err, fallbackReason, reasonCode = 'SEND_FAIL') {
        if (!message) return;
        const fromStatus = typeof message.status === 'string' ? message.status : null;
        if (fromStatus === 'delivered' || fromStatus === 'read') return;

        const details = this.extractFailureDetails(err, fallbackReason);
        const statusCode = Number.isFinite(err?.status) ? Number(err.status) : null;
        const jobId = err?.jobId ?? err?.job?.jobId ?? null;
        const finalReasonCode = reasonCode || err?.stage || err?.code || 'SEND_FAIL';

        message.status = 'failed';
        message.pending = false;
        message.failureReason = details.reason || fallbackReason;
        message.failureCode = details.code || 'Unknown';

        this._logOutgoingUiStatusTrace({
            message,
            fromStatus,
            toStatus: 'failed',
            reasonCode: finalReasonCode,
            stage: 'applyOutgoingFailure',
            ok: false,
            statusCode,
            error: details.reason || fallbackReason || null,
            jobId
        });
        this._logOutgoingStatusTrace(message, fromStatus, 'failed', 'SEND_FAIL');
    }

    /**
     * Build a CounterTooLow replacement error.
     */
    buildCounterTooLowReplacementError() {
        const err = new Error('CounterTooLow replaced');
        err.code = 'COUNTER_TOO_LOW_REPLACED';
        return err;
    }

    /**
     * Apply CounterTooLow replaced failure status.
     */
    applyCounterTooLowReplaced(message, reasonCode = 'COUNTER_TOO_LOW_REPLACED') {
        if (!message) return;
        const err = this.buildCounterTooLowReplacementError();
        this.applyOutgoingFailure(message, err, '傳送失敗', reasonCode);
    }

    /**
     * Get replacement info from response payload.
     */
    getReplacementInfo(payload) {
        const info = payload?.replacement;
        if (!info || !info.newMessageId) return null;
        return info;
    }
}
