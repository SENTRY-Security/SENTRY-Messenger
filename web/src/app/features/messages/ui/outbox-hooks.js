/**
 * Outbox Hooks and Message Status Utilities
 * Extracted from messages-pane.js - handles outgoing message status management.
 */

import { normalizeCounterValue } from '../parser.js';

/**
 * Check if an error indicates CounterTooLow.
 * @param {Error|Object} err - Error object
 * @returns {boolean}
 */
export function isCounterTooLowError(err) {
    if (!err) return false;
    const code = err?.code || err?.errorCode || err?.details?.error || err?.details?.code || err?.error || null;
    if (code && String(code) === 'CounterTooLow') return true;
    const message = typeof err?.message === 'string' ? err.message : '';
    return message.includes('CounterTooLow');
}

/**
 * Build a CounterTooLow replacement error.
 * @returns {Error}
 */
export function buildCounterTooLowReplacementError() {
    const err = new Error('CounterTooLow replaced');
    err.code = 'COUNTER_TOO_LOW_REPLACED';
    return err;
}

/**
 * Extract failure details from an error.
 * @param {Error|Object} err - Error object
 * @param {string} fallbackReason - Fallback reason string
 * @returns {{ reason: string, code: string }}
 */
export function extractFailureDetails(err, fallbackReason = 'send failed') {
    const reason = err?.message || err?.error || fallbackReason;
    const code = err?.code || err?.errorCode || err?.details?.code || 'Unknown';
    return { reason, code };
}

/**
 * Get replacement info from a response payload.
 * @param {Object} payload - Response payload
 * @returns {Object|null} Replacement info or null
 */
export function getReplacementInfo(payload) {
    const info = payload?.replacement;
    if (!info || !info.newMessageId) return null;
    return info;
}

/**
 * Create outbox status manager.
 * @param {Object} deps - Dependencies
 * @param {Function} deps.logOutgoingStatusTrace - Status trace logger
 * @param {Function} deps.logOutgoingUiStatusTrace - UI status trace logger
 * @returns {Object} Status manager methods
 */
export function createOutboxStatusManager(deps) {
    const { logOutgoingStatusTrace, logOutgoingUiStatusTrace } = deps;

    /**
     * Apply "sent" status to an outgoing message.
     * @param {Object} message - Message object to update
     * @param {Object} res - Server response
     * @param {number} fallbackTs - Fallback timestamp
     * @param {string} reasonCode - Reason code for logging
     */
    function applyOutgoingSent(message, res, fallbackTs, reasonCode = 'ACK_202') {
        if (!message) return;
        const fromStatus = typeof message.status === 'string' ? message.status : null;
        if (fromStatus === 'failed' || fromStatus === 'delivered' || fromStatus === 'read') return;
        if (isCounterTooLowError(res)) return;
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
        logOutgoingUiStatusTrace?.({
            message,
            fromStatus,
            toStatus: 'sent',
            reasonCode,
            stage: 'applyOutgoingSent',
            ok: true,
            statusCode: res?.status ?? res?.r?.status ?? res?.statusCode ?? null,
            jobId: res?.jobId ?? res?.job?.jobId ?? null
        });
        logOutgoingStatusTrace?.(message, fromStatus, 'sent', reasonCode);
    }

    /**
     * Apply "failed" status to an outgoing message.
     * @param {Object} message - Message object to update
     * @param {Error|Object} err - Error object
     * @param {string} fallbackReason - Fallback reason
     * @param {string} reasonCode - Reason code for logging
     */
    function applyOutgoingFailure(message, err, fallbackReason, reasonCode = 'SEND_FAIL') {
        if (!message) return;
        const fromStatus = typeof message.status === 'string' ? message.status : null;
        if (fromStatus === 'delivered' || fromStatus === 'read') return;
        const details = extractFailureDetails(err, fallbackReason);
        const statusCode = Number.isFinite(err?.status) ? Number(err.status) : null;
        const jobId = err?.jobId ?? err?.job?.jobId ?? null;
        const finalReasonCode = reasonCode || err?.stage || err?.code || 'SEND_FAIL';
        message.status = 'failed';
        message.pending = false;
        message.failureReason = details.reason || fallbackReason;
        message.failureCode = details.code || 'Unknown';
        logOutgoingUiStatusTrace?.({
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
        logOutgoingStatusTrace?.(message, fromStatus, 'failed', 'SEND_FAIL');
    }

    /**
     * Apply CounterTooLow replacement failure to a message.
     * @param {Object} message - Message object
     * @param {string} reasonCode - Reason code
     */
    function applyCounterTooLowReplaced(message, reasonCode = 'COUNTER_TOO_LOW_REPLACED') {
        if (!message) return;
        const err = buildCounterTooLowReplacementError();
        applyOutgoingFailure(message, err, '傳送失敗', reasonCode);
    }

    return {
        applyOutgoingSent,
        applyOutgoingFailure,
        applyCounterTooLowReplaced
    };
}
