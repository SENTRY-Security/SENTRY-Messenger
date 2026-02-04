/**
 * Placeholder State Management
 * Extracted from messages-pane.js to centralize in-memory state for placeholders.
 */

import { logCapped } from '../../core/log.js';
import {
    normalizePlaceholderKey,
    normalizeCounterValue,
    buildPlaceholderCounterId,
    normalizePlaceholderCounter,
    normalizePlaceholderRawMessageId,
    normalizeMsgTypeValue,
    sliceConversationIdPrefix,
    sliceDeviceIdSuffix4
} from './parser.js';
import {
    getTimeline as timelineGetTimeline,
    updateTimelineEntryStatusByCounter
} from '../timeline-store.js';
import { PLACEHOLDER_SHIMMER_MAX_ACTIVE } from '../../ui/mobile/messages-ui-policy.js';

const placeholderReplayStateByConv = new Map();
const placeholderReplayRevealByConv = new Map();
const placeholderGapStateByConv = new Map();
const placeholderGapRevealByConv = new Map();
const placeholderPendingLiveStateByConv = new Map();

export function resolvePlaceholderMode({ replayMode, reason } = {}) {
    if (replayMode) return 'replay';
    const key = typeof reason === 'string' ? reason : '';
    if (key === 'ws-reconnect' || key === 'open' || key === 'enter_conversation' || key === 'login') return 'catchup';
    return 'live';
}

export function getReplayPlaceholderState(conversationId) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key) return null;
    return placeholderReplayStateByConv.get(key) || null;
}

export function getReplayPlaceholderEntries(conversationId) {
    const state = getReplayPlaceholderState(conversationId);
    return Array.isArray(state?.entries) ? state.entries : [];
}

export function listGapPlaceholderEntriesFromTimeline(conversationId) {
    if (!conversationId) return [];
    const timeline = timelineGetTimeline(conversationId);
    if (!Array.isArray(timeline) || !timeline.length) return [];
    return timeline.filter((entry) => {
        const msgType = normalizeMsgTypeValue(entry?.msgType || entry?.type || entry?.subtype || entry?.meta?.msgType || entry?.meta?.msg_type);
        return entry?.placeholder === true || msgType === 'placeholder';
    });
}

export function getGapPlaceholderState(conversationId) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key) return null;
    const existing = placeholderGapStateByConv.get(key);
    if (existing) return existing;
    const entries = listGapPlaceholderEntriesFromTimeline(key);
    const state = { count: entries.length, entries, createdAt: Date.now() };
    placeholderGapStateByConv.set(key, state);
    if (entries.length) {
        logCapped('placeholderGapTrace', {
            stage: 'sync',
            conversationId: key,
            placeholderCount: entries.length
        }, 5);
    }
    return state;
}

export function getGapPlaceholderEntries(conversationId) {
    const state = getGapPlaceholderState(conversationId);
    return Array.isArray(state?.entries) ? state.entries : [];
}

export function invalidateGapPlaceholderState(conversationId) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key) return;
    placeholderGapStateByConv.delete(key);
}

export function getPlaceholderCount(conversationId) {
    const replayEntries = getReplayPlaceholderEntries(conversationId);
    const gapEntries = getGapPlaceholderEntries(conversationId);
    const pendingLiveEntries = getPendingLivePlaceholderEntries(conversationId);
    const count = replayEntries.length + gapEntries.length + pendingLiveEntries.length;
    return count > 0 ? count : 0;
}

export function setReplayPlaceholderState({ conversationId, reason = null, source = null, entries = null, trace = null } = {}) {
    const key = normalizePlaceholderKey(conversationId);
    const safeEntries = Array.isArray(entries)
        ? entries.map((entry) => {
            const counter = normalizeCounterValue(entry?.counter);
            const messageIdRaw = typeof entry?.messageId === 'string' ? entry.messageId.trim() : null;
            const messageId = messageIdRaw || (counter !== null ? buildPlaceholderCounterId(counter) : null);
            const direction = entry?.direction === 'incoming' || entry?.direction === 'outgoing'
                ? entry.direction
                : null;
            const tsRaw = Number(entry?.ts);
            const tsValid = Number.isFinite(tsRaw) && Number.isInteger(tsRaw) && tsRaw > 0;
            const status = entry?.status === 'failed' ? 'failed' : 'pending';
            const directionKnown = entry?.directionKnown === true;
            if (!messageId || !direction || (!tsValid && counter === null)) return null;
            const tsMs = Number.isFinite(Number(entry?.tsMs)) ? Number(entry.tsMs) : null;
            const tsSeq = Number.isFinite(Number(entry?.tsSeq)) ? Number(entry.tsSeq) : null;
            return {
                messageId,
                counter,
                direction,
                status,
                directionKnown,
                ts: tsValid ? Math.floor(tsRaw) : null,
                tsMs,
                tsSeq
            };
        }).filter(Boolean)
        : [];
    const safeCount = safeEntries.length;
    if (!key || safeCount <= 0) return { state: null, addedCount: 0 };
    const mode = typeof trace?.mode === 'string' ? trace.mode : null;
    const existing = placeholderReplayStateByConv.get(key);
    if (existing) {
        const existingEntries = Array.isArray(existing.entries) ? existing.entries : [];
        const seen = new Set(existingEntries.map((entry) => entry?.messageId).filter(Boolean));
        const seenCounters = new Set(
            existingEntries
                .map((entry) => normalizeCounterValue(entry?.counter))
                .filter((val) => Number.isFinite(val))
        );
        let addedCount = 0;
        for (const entry of safeEntries) {
            if (!entry?.messageId || seen.has(entry.messageId)) continue;
            const entryCounter = normalizeCounterValue(entry?.counter);
            if (entryCounter !== null && seenCounters.has(entryCounter)) continue;
            seen.add(entry.messageId);
            if (entryCounter !== null) seenCounters.add(entryCounter);
            existingEntries.push(entry);
            addedCount += 1;
        }
        if (!addedCount) return { state: existing, addedCount: 0 };
        existing.entries = existingEntries;
        existing.count = existingEntries.length;
        existing.shimmerActive = Math.min(
            existing.count,
            Math.max(0, Number(PLACEHOLDER_SHIMMER_MAX_ACTIVE) || 0)
        );
        if (reason) existing.reason = reason;
        if (source) existing.source = source;
        const directionKnownCount = existingEntries.filter((entry) => entry?.directionKnown === true).length;
        logCapped('placeholderReplayTrace', {
            stage: 'batch',
            conversationId: key,
            conversationIdPrefix8: sliceConversationIdPrefix(key),
            mode,
            placeholderCount: existing.count,
            directionKnownCount,
            count: existing.count,
            shimmerActive: existing.shimmerActive,
            reason: reason || null,
            source: source || null
        }, 5);
        return { state: existing, addedCount };
    }
    const shimmerActive = Math.min(
        safeCount,
        Math.max(0, Number(PLACEHOLDER_SHIMMER_MAX_ACTIVE) || 0)
    );
    const state = { count: safeCount, shimmerActive, createdAt: Date.now(), reason, source, entries: safeEntries };
    placeholderReplayStateByConv.set(key, state);
    const directionKnownCount = Number.isFinite(trace?.directionKnownCount)
        ? Number(trace.directionKnownCount)
        : safeEntries.filter((entry) => entry?.directionKnown === true).length;
    logCapped('placeholderReplayTrace', {
        stage: 'batch',
        conversationId: key,
        conversationIdPrefix8: sliceConversationIdPrefix(key),
        mode,
        placeholderCount: safeCount,
        directionKnownCount,
        count: safeCount,
        shimmerActive,
        reason: reason || null,
        source: source || null
    }, 5);
    return { state, addedCount: safeCount };
}

export function clearReplayPlaceholderState(conversationId) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key) return;
    placeholderReplayStateByConv.delete(key);
}

export function markReplayPlaceholderFailures(conversationId, entries = []) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key || !Array.isArray(entries) || !entries.length) return { updated: 0, added: 0 };
    const state = placeholderReplayStateByConv.get(key) || { entries: [], count: 0, shimmerActive: 0 };
    const existingEntries = Array.isArray(state.entries) ? state.entries : [];
    const byMessageId = new Map();
    const byCounter = new Map();
    for (const entry of existingEntries) {
        const entryId = typeof entry?.messageId === 'string' ? entry.messageId.trim() : null;
        if (entryId) byMessageId.set(entryId, entry);
        const entryCounter = normalizeCounterValue(entry?.counter);
        if (entryCounter !== null) byCounter.set(entryCounter, entry);
    }
    let updated = 0;
    let added = 0;
    const normalizedEntries = entries.map((entry) => {
        const counter = normalizePlaceholderCounter(entry);
        const messageIdRaw = normalizePlaceholderRawMessageId(entry);
        const messageId = messageIdRaw || (counter !== null ? buildPlaceholderCounterId(counter) : null);
        const direction = entry?.direction === 'incoming' || entry?.direction === 'outgoing'
            ? entry.direction
            : null;
        const tsRaw = Number(entry?.ts);
        const tsValid = Number.isFinite(tsRaw) && Number.isInteger(tsRaw) && tsRaw > 0;
        if (!messageId || !direction || (!tsValid && counter === null)) return null;
        const tsMs = Number.isFinite(Number(entry?.tsMs)) ? Number(entry.tsMs) : null;
        const tsSeq = Number.isFinite(Number(entry?.tsSeq)) ? Number(entry.tsSeq) : null;
        return {
            messageId,
            counter,
            direction,
            status: 'failed',
            ts: tsValid ? Math.floor(tsRaw) : null,
            tsMs,
            tsSeq,
            reason: entry?.reason || entry?.error || 'vault_missing'
        };
    }).filter(Boolean);
    for (const entry of normalizedEntries) {
        const match = (entry.messageId && byMessageId.get(entry.messageId))
            || (entry.counter !== null ? byCounter.get(entry.counter) : null);
        if (match) {
            if (match.status !== 'failed') updated += 1;
            match.status = 'failed';
            if (entry.reason) match.reason = entry.reason;
            if (entry.ts !== null) match.ts = entry.ts;
            if (entry.tsMs !== null) match.tsMs = entry.tsMs;
            if (entry.tsSeq !== null) match.tsSeq = entry.tsSeq;
            continue;
        }
        existingEntries.push(entry);
        if (entry.messageId) byMessageId.set(entry.messageId, entry);
        if (entry.counter !== null) byCounter.set(entry.counter, entry);
        added += 1;
    }
    state.entries = existingEntries;
    state.count = existingEntries.length;
    state.shimmerActive = Math.min(
        state.count,
        Math.max(0, Number(PLACEHOLDER_SHIMMER_MAX_ACTIVE) || 0)
    );
    placeholderReplayStateByConv.set(key, state);
    if (updated > 0 || added > 0) {
        logCapped('placeholderReplayTrace', {
            stage: 'vault_missing',
            conversationId: key,
            updatedCount: updated,
            addedCount: added
        }, 5);
    }
    return { updated, added };
}

export function markGapPlaceholderFailures(conversationId, entries = []) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key || !Array.isArray(entries) || !entries.length) return { updated: 0, added: 0 };
    let updated = 0;
    for (const entry of entries) {
        const counter = normalizePlaceholderCounter(entry);
        if (counter === null) continue;
        const reason = entry?.reason || entry?.error || null;
        if (updateTimelineEntryStatusByCounter(key, counter, 'failed', { reason })) {
            updated += 1;
        }
    }
    if (updated > 0) {
        invalidateGapPlaceholderState(key);
        logCapped('placeholderGapTrace', {
            stage: 'stuck_to_error',
            conversationId: key,
            updatedCount: updated
        }, 5);
    }
    return { updated, added: 0 };
}

export function addReplayPlaceholderRevealId(conversationId, messageId) {
    const key = normalizePlaceholderKey(conversationId);
    const mid = typeof messageId === 'string' && messageId.trim() ? messageId.trim() : null;
    if (!key || !mid) return;
    let set = placeholderReplayRevealByConv.get(key);
    if (!set) {
        set = new Set();
        placeholderReplayRevealByConv.set(key, set);
    }
    set.add(mid);
    logCapped('placeholderRevealTrace', {
        conversationId: key,
        messageId: mid
    }, 5);
}

export function consumeReplayPlaceholderReveal(conversationId, messageId) {
    const key = normalizePlaceholderKey(conversationId);
    const mid = typeof messageId === 'string' && messageId.trim() ? messageId.trim() : null;
    if (!key || !mid) return false;
    const set = placeholderReplayRevealByConv.get(key);
    if (!set || !set.has(mid)) return false;
    set.delete(mid);
    if (!set.size) placeholderReplayRevealByConv.delete(key);
    return true;
}

export function consumeGapPlaceholderReveal(conversationId, messageId) {
    const key = normalizePlaceholderKey(conversationId);
    const mid = typeof messageId === 'string' && messageId.trim() ? messageId.trim() : null;
    if (!key || !mid) return false;
    const set = placeholderGapRevealByConv.get(key);
    if (!set || !set.has(mid)) return false;
    set.delete(mid);
    if (!set.size) placeholderGapRevealByConv.delete(key);
    return true;
}

export function consumeReplayPlaceholderBatch(conversationId, entries = []) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key) return false;
    const state = placeholderReplayStateByConv.get(key);
    if (!state || !Array.isArray(entries) || !entries.length) return false;
    const beforeCount = Array.isArray(state.entries) ? state.entries.length : 0;
    const removeCounts = new Map();
    const removeCounters = new Map();
    for (const entry of entries) {
        const messageId = normalizePlaceholderRawMessageId(entry);
        const counter = normalizePlaceholderCounter(entry);
        if (messageId) {
            addReplayPlaceholderRevealId(key, messageId);
            removeCounts.set(messageId, (removeCounts.get(messageId) || 0) + 1);
        }
        if (counter !== null) {
            removeCounters.set(counter, (removeCounters.get(counter) || 0) + 1);
        }
    }
    if (!Array.isArray(state.entries)) return false;
    const remaining = [];
    for (const placeholder of state.entries) {
        const messageId = placeholder?.messageId || null;
        const placeholderCounter = normalizeCounterValue(placeholder?.counter);
        const pendingId = messageId ? (removeCounts.get(messageId) || 0) : 0;
        const pendingCounter = placeholderCounter !== null ? (removeCounters.get(placeholderCounter) || 0) : 0;
        if (pendingId > 0) {
            removeCounts.set(messageId, pendingId - 1);
            continue;
        }
        if (pendingCounter > 0) {
            removeCounters.set(placeholderCounter, pendingCounter - 1);
            continue;
        }
        remaining.push(placeholder);
    }
    if (!remaining.length) {
        placeholderReplayStateByConv.delete(key);
    } else {
        state.entries = remaining;
        state.count = remaining.length;
        state.shimmerActive = Math.min(
            state.count,
            Math.max(0, Number(PLACEHOLDER_SHIMMER_MAX_ACTIVE) || 0)
        );
    }
    const removedCount = beforeCount > remaining.length ? beforeCount - remaining.length : 0;
    if (removedCount > 0) {
        logCapped('placeholderReplayTrace', {
            stage: 'reveal',
            conversationId: key,
            revealCount: removedCount
        }, 5);
    }
    return true;
}

export function updatePendingLivePlaceholderStatus(conversationId, { messageId, status }) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key || !messageId || !status) return false;
    const list = placeholderPendingLiveStateByConv.get(key);
    if (!Array.isArray(list)) return false;

    const entry = list.find(p => p.messageId === messageId);
    if (entry && entry.status !== status) {
        entry.status = status;
        return true;
    }
    return false;
}

export function getPendingLivePlaceholderEntries(conversationId) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key) return [];
    return placeholderPendingLiveStateByConv.get(key) || [];
}

export function addPendingLivePlaceholder({ conversationId, messageId, counter, ts, raw = null }) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key) return;
    let list = placeholderPendingLiveStateByConv.get(key);
    if (!list) {
        list = [];
        placeholderPendingLiveStateByConv.set(key, list);
    }
    // Avoid duplicates
    if (list.some(p => p.messageId === messageId)) return;

    const entry = {
        messageId,
        counter,
        ts,
        status: 'pending',
        isPendingLive: true,
        sourceTag: 'live-eager',
        createdAt: Date.now(),
        raw
    };
    list.push(entry);
    logCapped('placeholderPendingLiveTrace', {
        action: 'add',
        conversationId: key,
        messageId
    }, 5);
}

export function removePendingLivePlaceholder(conversationId, messageId) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key || !messageId) return;
    let list = placeholderPendingLiveStateByConv.get(key);
    if (!list) return;
    const initialLength = list.length;
    list = list.filter(p => p.messageId !== messageId);
    if (list.length !== initialLength) {
        if (list.length === 0) {
            placeholderPendingLiveStateByConv.delete(key);
        } else {
            placeholderPendingLiveStateByConv.set(key, list);
        }
    }
}

export function consumePendingLivePlaceholderBatch(conversationId, entries = []) {
    const key = normalizePlaceholderKey(conversationId);
    if (!key) return false;
    let list = placeholderPendingLiveStateByConv.get(key);
    if (!list || !list.length) return false;

    const idsToRemove = new Set(entries.map(e => e.messageId || e.id).filter(Boolean));
    const countersToRemove = new Set(entries.map(e => Number(e.counter)).filter(Number.isFinite));

    const initialCount = list.length;
    list = list.filter(p => !idsToRemove.has(p.messageId) && !countersToRemove.has(Number(p.counter)));

    if (list.length !== initialCount) {
        if (list.length === 0) {
            placeholderPendingLiveStateByConv.delete(key);
        } else {
            placeholderPendingLiveStateByConv.set(key, list);
        }
        return true;
    }
    return false;
}

export function resetPlaceholderState() {
    placeholderReplayStateByConv.clear();
    placeholderReplayRevealByConv.clear();
    placeholderGapStateByConv.clear();
    placeholderGapRevealByConv.clear();
    placeholderPendingLiveStateByConv.clear();
}
