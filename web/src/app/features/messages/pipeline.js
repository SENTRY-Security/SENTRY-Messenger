/**
 * Pipeline queue management and execution logic for Messages V2.
 */

import { normalizeSemanticSubtype } from '../semantic.js';
import {
    decryptPipelineQueues,
    decryptPipelineStreams,
    decryptPipelineContexts
} from './pipeline-state.js';

export function buildStreamKey(conversationId, senderDeviceId) {
    if (!conversationId || !senderDeviceId) return null;
    return `${conversationId}::${senderDeviceId}`;
}

export function getPipelineQueue(streamKey) {
    if (!streamKey) return null;
    let queue = decryptPipelineQueues.get(streamKey);
    if (!queue) {
        queue = new Map();
        decryptPipelineQueues.set(streamKey, queue);
    }
    return queue;
}

export function getPipelineStreamSet(conversationId) {
    if (!conversationId) return null;
    let set = decryptPipelineStreams.get(conversationId);
    if (!set) {
        set = new Set();
        decryptPipelineStreams.set(conversationId, set);
    }
    return set;
}

export function updateDecryptPipelineContext(conversationId, patch = {}) {
    if (!conversationId) return;
    const existing = decryptPipelineContexts.get(conversationId) || {};
    decryptPipelineContexts.set(conversationId, { ...existing, ...patch });
}

export function getDecryptPipelineContext(conversationId) {
    return decryptPipelineContexts.get(conversationId) || null;
}

export function enqueueDecryptPipelineItem(item) {
    const normalizedMsgType = normalizeSemanticSubtype(item?.msgType || null);
    if (normalizedMsgType === 'contact-share') return false;
    const convId = item?.conversationId || null;
    const senderDeviceId = item?.senderDeviceId || null;
    const counter = Number.isFinite(Number(item?.counter)) ? Number(item.counter) : null;
    if (!convId || !senderDeviceId || counter === null) return false;
    const streamKey = buildStreamKey(convId, senderDeviceId);
    if (!streamKey) return false;
    const queue = getPipelineQueue(streamKey);
    if (!queue) return false;
    const existing = queue.get(counter);
    if (existing) {
        queue.set(counter, {
            ...existing,
            ...item,
            counter,
            flags: { ...(existing?.flags || {}), ...(item?.flags || {}) },
            needsFetch: item?.needsFetch === true ? true : existing?.needsFetch === true
        });
    } else {
        queue.set(counter, { ...item, counter });
    }
    const streamSet = getPipelineStreamSet(convId);
    if (streamSet) streamSet.add(streamKey);
    return true;
}

export function getNextPipelineItem(conversationId) {
    const streamSet = decryptPipelineStreams.get(conversationId);
    if (!streamSet || !streamSet.size) return null;
    let selected = null;
    for (const streamKey of streamSet) {
        const queue = decryptPipelineQueues.get(streamKey);
        if (!queue || !queue.size) {
            streamSet.delete(streamKey);
            continue;
        }
        let minCounter = null;
        let minItem = null;
        for (const [counter, item] of queue.entries()) {
            if (!Number.isFinite(counter)) continue;
            if (minCounter === null || counter < minCounter) {
                minCounter = counter;
                minItem = item;
            }
        }
        if (!minItem) continue;
        if (!selected || minCounter < selected.counter) {
            selected = { streamKey, counter: minCounter, item: minItem };
        }
    }
    if (!streamSet.size) decryptPipelineStreams.delete(conversationId);
    return selected;
}

export function cleanupPipelineQueue(streamKey, conversationId, lastProcessedCounter) {
    const queue = decryptPipelineQueues.get(streamKey);
    if (!queue) return;
    for (const counter of Array.from(queue.keys())) {
        if (Number.isFinite(counter) && counter <= lastProcessedCounter) {
            queue.delete(counter);
        }
    }
    if (!queue.size) {
        decryptPipelineQueues.delete(streamKey);
        const streamSet = decryptPipelineStreams.get(conversationId);
        if (streamSet) {
            streamSet.delete(streamKey);
            if (!streamSet.size) decryptPipelineStreams.delete(conversationId);
        }
    }
}
