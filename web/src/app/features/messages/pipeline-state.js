/**
 * Pipeline state and locks for Messages V2.
 */

import {
    COUNTER_GAP_RETRY_MAX,
    COUNTER_GAP_RETRY_INTERVAL_MS
} from '../messages-sync-policy.js';

export {
    COUNTER_GAP_RETRY_MAX,
    COUNTER_GAP_RETRY_INTERVAL_MS
};

// State Maps/Sets
export const secureFetchBackoff = new Map();
export const secureFetchLocks = new Map(); // conversationId -> lock token

export const decryptPipelineQueues = new Map(); // streamKey -> Map(counter -> item)
export const decryptPipelineStreams = new Map(); // conversationId -> Set(streamKey)
export const decryptPipelineLocks = new Set(); // conversationId
export const decryptPipelinePending = new Set(); // conversationId
export const decryptPipelineFailureCounts = new Map(); // streamKey -> Map(counter -> count)
export const decryptPipelineLastProcessed = new Map(); // streamKey -> number
export const decryptPipelineContexts = new Map(); // conversationId -> context

export const decryptFailDedup = new Set(); // messageId -> failed once
export const decryptFailMessageCache = new Map(); // messageId -> stateKey

export const serverCatchupProcessing = new Set(); // conversationId
export const serverCatchupLastTriggerAt = new Map(); // conversationId -> tsMs

export const liveDecryptRepairQueue = new Map(); // conversationId -> job
export const liveDecryptRepairProcessing = new Set(); // conversationId
export const liveDecryptRepairScheduled = new Set(); // conversationId

// Helper Functions

export function createSecureFetchLockToken(priority, owner = null, opts = {}) {
    return {
        id: Symbol('secureFetchLock'),
        priority: priority === 'replay' ? 'replay' : 'live',
        owner: owner || null,
        cancelled: false,
        cancelReason: null,
        created: Date.now(),
        ...opts
    };
}

export function getPipelineQueue(streamKey) {
    if (!decryptPipelineQueues.has(streamKey)) {
        decryptPipelineQueues.set(streamKey, new Map());
    }
    return decryptPipelineQueues.get(streamKey);
}

export function updateDecryptPipelineContext(conversationId, context) {
    decryptPipelineContexts.set(conversationId, context);
}

export function getLastProcessedCounterForStream(streamKey) {
    return decryptPipelineLastProcessed.get(streamKey) || 0;
}

export function setLastProcessedCounterForStream(streamKey, counter) {
    decryptPipelineLastProcessed.set(streamKey, counter);
}

export function incrementPipelineFailure(streamKey, counter) {
    if (!decryptPipelineFailureCounts.has(streamKey)) {
        decryptPipelineFailureCounts.set(streamKey, new Map());
    }
    const map = decryptPipelineFailureCounts.get(streamKey);
    const count = (map.get(counter) || 0) + 1;
    map.set(counter, count);
    return count;
}

export function clearPipelineFailure(streamKey, counter) {
    const map = decryptPipelineFailureCounts.get(streamKey);
    if (map) {
        map.delete(counter);
    }
}

export function isCounterFetchClientError(status) {
    return status === 404 || status === 403 || status === 400;
}

export function shouldRetryCounterFetch(status) {
    // Don't retry on definite client errors
    if (isCounterFetchClientError(status)) return false;
    return true;
}

export function resolveCounterFetchFailureReason(status, error) {
    if (status === 404) return 'not_found';
    if (status === 403) return 'permission_denied';
    if (status === 400) return 'bad_request';
    if (status >= 500) return 'server_error';
    if (status === 0 || !status) return 'network_error';
    return error ? String(error) : 'unknown_error';
}

export function acquireSecureFetchLock(conversationId, priority = 'live') {
    // Simple lock implementation
    if (secureFetchLocks.has(conversationId)) {
        return null;
    }

    const token = createSecureFetchLockToken(priority, 'acquireSecureFetchLock');
    secureFetchLocks.set(conversationId, token);
    return token;
}
