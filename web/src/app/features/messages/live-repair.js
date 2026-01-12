/**
 * Live decrypt repair logic for Messages V2.
 */

import {
    liveDecryptRepairQueue,
    liveDecryptRepairProcessing,
    liveDecryptRepairScheduled
} from './pipeline-state.js';

import {
    buildCounterMessageId
} from './counter.js'; // Assuming buildCounterMessageId is exported from counter.js

// Dependencies:
// fetchServerMaxCounter (api)
// resolveLocalIncomingCounter (store/helper)
// enqueueDecryptPipelineItem (pipeline)
// processDecryptPipelineForConversation (messages.js internal)
// emitBRouteResultEvent (messages.js internal)
// sessionStore (session-store.js)
// storeNormalizePeerIdentity (contact-secrets.js)

// We will inject most of these to avoid circularity, or import straightforward ones.

export function scheduleLiveDecryptRepair(conversationId) {
    const key = conversationId ? String(conversationId) : null;
    if (!key || liveDecryptRepairScheduled.has(key)) return;
    liveDecryptRepairScheduled.add(key);
    Promise.resolve().then(() => {
        liveDecryptRepairScheduled.delete(key);
        // We need a way to call runLiveDecryptRepair.
        // If we export runLiveDecryptRepair, we can call it?
        // But runLiveDecryptRepair needs dependencies.
        // This suggests we might need a singleton or a setup function.
        // Or we rely on the caller to provide dependencies, which is hard in a decoupled schedule.
        // Solution: The scheduler is usually internal.
        // But here, scheduleLiveDecryptRepair is called by enqueue.
        // We will expose a `setLiveRepairRunner` or similar, OR export runLiveDecryptRepair and have the main loop call it?
        // No, `Promise.resolve().then` implies it runs autonomously.
        // I will use a module-level variable to hold the runner (or dependencies) if initialized.
        if (_runner) {
            _runner(key).catch(() => { });
        }
    });
}

let _runner = null;

export function registerLiveRepairRunner(runner) {
    _runner = runner;
}

export function markLiveDecryptRepairPending(conversationId) {
    const key = conversationId ? String(conversationId) : null;
    if (!key) return;
    const job = liveDecryptRepairQueue.get(key);
    if (job) job.pendingOnUnlock = true;
}

export function maybeScheduleLiveDecryptRepairOnUnlock(conversationId) {
    const key = conversationId ? String(conversationId) : null;
    if (!key) return;
    const job = liveDecryptRepairQueue.get(key);
    if (!job || !job.pendingOnUnlock) return;
    job.pendingOnUnlock = false;
    scheduleLiveDecryptRepair(key);
}

export function enqueueLiveDecryptRepair(params = {}, opts = {}) {
    const convId = params?.conversationId ? String(params.conversationId) : null;
    const targetCounter = Number(params?.targetCounter);
    if (!convId || !Number.isFinite(targetCounter)) return { enqueued: false, reason: 'missing params' };

    const existing = liveDecryptRepairQueue.get(convId);
    const resolvedSenderDeviceId = params?.senderDeviceId || existing?.senderDeviceId || null;
    if (!resolvedSenderDeviceId) return { enqueued: false, reason: 'missing senderDeviceId' };

    const nextCounter = existing && Number.isFinite(existing?.targetCounter)
        ? Math.max(Number(existing.targetCounter), targetCounter)
        : targetCounter;

    const next = {
        conversationId: convId,
        targetCounter: nextCounter,
        senderDeviceId: resolvedSenderDeviceId,
        senderAccountDigest: params?.senderAccountDigest || existing?.senderAccountDigest || null,
        messageId: params?.messageId || existing?.messageId || null,
        tokenB64: params?.tokenB64 || existing?.tokenB64 || null,
        source: params?.source || existing?.source || null,
        pendingOnUnlock: existing?.pendingOnUnlock === true,
        updatedAt: Date.now(),
        version: (existing?.version || 0) + 1
    };

    liveDecryptRepairQueue.set(convId, next);
    if (!opts?.deferRun) scheduleLiveDecryptRepair(convId);

    return { enqueued: true, deduped: !!existing, conversationId: convId, targetCounter: nextCounter };
}

export async function runLiveDecryptRepair(conversationId, deps) {
    const convId = conversationId ? String(conversationId) : null;
    if (!convId || liveDecryptRepairProcessing.has(convId)) return;

    const job = liveDecryptRepairQueue.get(convId);
    if (!job) return;

    liveDecryptRepairProcessing.add(convId);

    const {
        logBRouteGapTaskTrace,
        sessionStore, // For fallback sender digest lookup
        storeNormalizePeerIdentity,
        resolveLocalIncomingCounter, // Helper
        fetchServerMaxCounter, // API
        enqueueDecryptPipelineItem,
        processDecryptPipelineForConversation,
        emitBRouteResultEvent,
        buildCounterMessageId
    } = deps;

    const jobVersion = job?.version || 0;
    const jobMessageId = job?.messageId || null;
    const jobSenderDeviceId = job?.senderDeviceId || null;
    const jobTargetCounter = Number(job?.targetCounter);
    const jobReason = job?.source || null;

    let keepJob = true;
    let reschedule = false;

    if (logBRouteGapTaskTrace) {
        logBRouteGapTaskTrace({
            stage: 'dequeue',
            conversationId: convId,
            targetCounter: jobTargetCounter,
            messageId: jobMessageId,
            senderDeviceId: jobSenderDeviceId,
            reason: jobReason
        });
    }

    try {
        const senderDeviceId = jobSenderDeviceId;
        const targetCounter = jobTargetCounter;

        if (!senderDeviceId || !Number.isFinite(targetCounter)) {
            keepJob = false;
            return;
        }

        let senderDigest = job?.senderAccountDigest || null;
        if (!senderDigest) {
            const thread = sessionStore?.conversationThreads?.get?.(convId) || null;
            senderDigest = thread?.peerAccountDigest || thread?.peerKey || null;
            if (!senderDigest) {
                const entry = sessionStore?.conversationIndex?.get?.(convId) || null;
                senderDigest = entry?.peerAccountDigest || entry?.peerKey || null;
            }
        }

        const normalized = storeNormalizePeerIdentity ? storeNormalizePeerIdentity({ peerAccountDigest: senderDigest, peerDeviceId: senderDeviceId }) : null;
        const peerDigest = normalized?.accountDigest || senderDigest || null;

        const localCounterRaw = resolveLocalIncomingCounter ? resolveLocalIncomingCounter({
            peerAccountDigest: peerDigest || senderDigest || null,
            peerDeviceId: senderDeviceId
        }) : 0;

        const localCounter = Number.isFinite(Number(localCounterRaw)) ? Number(localCounterRaw) : 0;

        const maxResult = await fetchServerMaxCounter({ conversationId: convId, senderDeviceId });
        if (!maxResult?.ok) return;

        const serverMaxCounter = Number.isFinite(Number(maxResult?.maxCounter)) ? Number(maxResult.maxCounter) : null;
        if (!Number.isFinite(serverMaxCounter)) return;

        const effectiveTarget = Math.min(targetCounter, serverMaxCounter);
        const fromCounter = Math.max(1, localCounter + 1);

        if (effectiveTarget < fromCounter) {
            keepJob = false;
            return;
        }

        for (let counter = fromCounter; counter <= effectiveTarget; counter += 1) {
            enqueueDecryptPipelineItem({
                conversationId: convId,
                senderDeviceId,
                senderAccountDigest: peerDigest || senderDigest || null,
                counter,
                serverMessageId: buildCounterMessageId(counter),
                needsFetch: true,
                tokenB64: job?.tokenB64 || null,
                flags: { gapFill: true, liveIncoming: false, repair: true }
            });
        }

        const result = await processDecryptPipelineForConversation({
            conversationId: convId,
            peerAccountDigest: peerDigest || senderDigest || null,
            sendReadReceipt: false,
            silent: true,
            sourceTag: `b-route:repair:${job?.source || 'unknown'}`
        });

        if (result?.locked) {
            markLiveDecryptRepairPending(convId);
            return;
        }

        if (Number(result?.decryptOk) > 0 || Number(result?.vaultPutIncomingOk) > 0) {
            if (emitBRouteResultEvent) {
                emitBRouteResultEvent({
                    conversationId: convId,
                    source: jobReason || 'missing_key',
                    fetchedItems: null,
                    decryptOk: Number(result?.decryptOk) || 0,
                    vaultPutIncomingOk: Number(result?.vaultPutIncomingOk) || 0,
                    failReason: null,
                    errorMessage: null
                });
            }
        }

        keepJob = false;

    } finally {
        liveDecryptRepairProcessing.delete(convId);
        const current = liveDecryptRepairQueue.get(convId);

        if (!keepJob && current && current.version === jobVersion) {
            liveDecryptRepairQueue.delete(convId);
        } else if (current && current.version !== jobVersion && !current.pendingOnUnlock) {
            reschedule = true;
        }

        if (reschedule) scheduleLiveDecryptRepair(convId);

        if (logBRouteGapTaskTrace) {
            logBRouteGapTaskTrace({
                stage: 'finish',
                conversationId: convId,
                targetCounter: jobTargetCounter,
                messageId: jobMessageId,
                senderDeviceId: jobSenderDeviceId,
                reason: jobReason,
                result: keepJob ? (reschedule ? 'reschedule' : 'pending') : 'done'
            });
        }
    }
}
