/**
 * Server catchup logic for Messages V2.
 */

import {
    serverCatchupProcessing,
    serverCatchupLastTriggerAt
} from './pipeline-state.js';

import {
    buildCounterMessageId
} from './counter.js'; // Assuming this was migrated to counter.js

// Local state for this module
const serverCatchupQueue = new Map(); // conversationId -> { targetCounter, peerDeviceId, peerAccountDigest, source }
const serverCatchupProbeInFlight = new Set(); // conversationId

const SERVER_CATCHUP_TRIGGER_COALESCE_MS = 2000;

function resolveLocalIncomingCounter(params, deps) {
    // This helper usually relies on getIncomingCounterState.
    // We'll require it to be passed or imported if possible.
    // For now, let's assume it's injected or we import it.
    // But wait, resolveLocalIncomingCounter is likely simple wrapper.
    // Let's rely on deps injection for complex state access if unsure.
    if (deps?.resolveLocalIncomingCounter) {
        return deps.resolveLocalIncomingCounter(params);
    }
    return null;
}

function logServerCatchupProbeTrace(params, deps) {
    if (deps?.logServerCatchupProbeTrace) {
        deps.logServerCatchupProbeTrace(params);
    }
}

function enqueueServerCatchupJob({
    source,
    conversationId,
    peerAccountDigest,
    peerDeviceId,
    targetCounter
}, deps) {
    const existing = serverCatchupQueue.get(conversationId);
    const target = Number(targetCounter);
    if (!Number.isFinite(target)) return { enqueued: false };
    if (existing && existing.targetCounter >= target) {
        if (deps?.logServerCatchupEnqueueTrace) {
            deps.logServerCatchupEnqueueTrace({ source, conversationId, targetCounter: target, deduped: true });
        }
        return { enqueued: false, deduped: true };
    }

    serverCatchupQueue.set(conversationId, {
        conversationId,
        targetCounter: target,
        peerAccountDigest,
        peerDeviceId,
        source
    });

    if (deps?.logServerCatchupEnqueueTrace) {
        deps.logServerCatchupEnqueueTrace({ source, conversationId, targetCounter: target, deduped: false });
    }

    runServerCatchupJob(conversationId, deps).catch(() => { });
    return { enqueued: true, deduped: false };
}

async function runServerCatchupJob(conversationId, deps) {
    if (!conversationId || serverCatchupProcessing.has(conversationId)) return;
    const job = serverCatchupQueue.get(conversationId);
    if (!job) return;

    serverCatchupProcessing.add(conversationId);
    serverCatchupQueue.delete(conversationId);

    try {
        const targetCounter = Number(job.targetCounter);
        if (!Number.isFinite(targetCounter)) return;

        // Dependencies
        const {
            enqueueDecryptPipelineItem,
            processDecryptPipelineForConversation,
            buildCounterMessageId
        } = deps;

        const enqueued = enqueueDecryptPipelineItem({
            conversationId: job.conversationId,
            senderDeviceId: job.peerDeviceId,
            senderAccountDigest: job.peerAccountDigest || null,
            counter: targetCounter,
            serverMessageId: buildCounterMessageId(targetCounter),
            needsFetch: true,
            flags: { gapFill: true, liveIncoming: false }
        });

        if (!enqueued) return;

        await processDecryptPipelineForConversation({
            conversationId: job.conversationId,
            peerAccountDigest: job.peerAccountDigest || null,
            sendReadReceipt: false,
            silent: true,
            silent: true,
            sourceTag: `server-catchup:${job.source || 'unknown'}`
        }, deps);

    } finally {
        serverCatchupProcessing.delete(conversationId);
        if (serverCatchupQueue.has(conversationId)) {
            runServerCatchupJob(conversationId, deps).catch(() => { });
        }
    }
}

export function normalizeCatchupSource(source) {
    // Simple normalization, similar to others
    return source || 'unknown';
}

export async function triggerServerCatchup({
    source,
    conversationId,
    peerAccountDigest,
    peerDeviceId
} = {}, deps = {}) {
    const convId = conversationId || null;
    const deviceId = peerDeviceId || null;

    if (!convId || !deviceId) return { ok: false, reason: 'missing params' };

    const sourceTag = normalizeCatchupSource(source);
    const now = Date.now();
    const lastTriggered = serverCatchupLastTriggerAt.get(convId) || 0;

    if (Number.isFinite(lastTriggered) && now - lastTriggered < SERVER_CATCHUP_TRIGGER_COALESCE_MS) {
        return { ok: false, reason: 'coalesced' };
    }

    serverCatchupLastTriggerAt.set(convId, now);

    // Extract deps
    const {
        resolveLocalIncomingCounter, // Function to get current max counter
        fetchServerMaxCounter,       // Function to call API
        logServerCatchupProbeTrace
    } = deps;

    const localCounter = resolveLocalIncomingCounter({ peerAccountDigest, peerDeviceId: deviceId }, deps);

    if (!Number.isFinite(localCounter)) {
        if (logServerCatchupProbeTrace) {
            logServerCatchupProbeTrace({
                source: sourceTag,
                conversationId: convId,
                localCounter: null,
                serverMaxCounter: null,
                decision: 'noop'
            });
        }
        return { ok: false, reason: 'local counter missing' };
    }

    if (serverCatchupProbeInFlight.has(convId)) {
        return { ok: false, reason: 'inflight' };
    }

    serverCatchupProbeInFlight.add(convId);
    let serverMaxCounter = null;
    let decision = 'noop';

    try {
        const result = await fetchServerMaxCounter({
            conversationId: convId,
            senderDeviceId: deviceId
        });

        if (!result?.ok) {
            decision = 'noop';
            return { ok: false, reason: 'api failed' };
        }

        serverMaxCounter = Number.isFinite(Number(result?.maxCounter)) ? Number(result.maxCounter) : 0;

        if (serverMaxCounter > localCounter) {
            decision = 'enqueue';
            enqueueServerCatchupJob({
                source: sourceTag,
                conversationId: convId,
                peerAccountDigest,
                peerDeviceId: deviceId,
                targetCounter: serverMaxCounter
            }, deps);
        } else {
            decision = 'noop';
        }

        if (logServerCatchupProbeTrace) {
            logServerCatchupProbeTrace({
                source: sourceTag,
                conversationId: convId,
                localCounter,
                serverMaxCounter,
                decision
            });
        }

        return { ok: true, decision };

    } finally {
        serverCatchupProbeInFlight.delete(convId);
    }
}
