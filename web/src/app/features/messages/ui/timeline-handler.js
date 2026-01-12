/**
 * Timeline Handler Utilities
 * Extracted from messages-pane.js - pure functions for timeline sorting and comparison.
 */

import {
    normalizeTimelineMessageId,
    normalizeRawMessageId,
    extractMessageTimestamp,
    extractMessageTimestampMs,
    extractMessageTimestampSeq
} from '../parser.js';

/**
 * Sort messages by timeline order (ascending by timestamp, sequence, then ID).
 * @param {Array} items - Array of message items
 * @returns {Array} Sorted array
 */
export function sortMessagesByTimelineLocal(items = []) {
    if (!Array.isArray(items) || items.length <= 1) return Array.isArray(items) ? items : [];
    const enriched = items.map((item) => ({
        raw: item,
        tsMs: extractMessageTimestampMs(item),
        seq: extractMessageTimestampSeq(item),
        id: normalizeRawMessageId(item)
    }));
    enriched.sort((a, b) => {
        const aHasTs = Number.isFinite(a.tsMs);
        const bHasTs = Number.isFinite(b.tsMs);
        if (aHasTs && bHasTs && a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
        if (aHasTs && !bHasTs) return 1;
        if (!aHasTs && bHasTs) return -1;
        const aHasSeq = Number.isFinite(a.seq);
        const bHasSeq = Number.isFinite(b.seq);
        if (aHasSeq && bHasSeq && a.seq !== b.seq) return a.seq - b.seq;
        if (a.id && b.id && a.id !== b.id) return a.id.localeCompare(b.id);
        if (a.id && !b.id) return 1;
        if (!a.id && b.id) return -1;
        return 0;
    });
    return enriched.map((entry) => entry.raw);
}

/**
 * Get the latest key (id + ts) from a timeline message array.
 * @param {Array} messages - Timeline messages
 * @returns {{ id: string|null, ts: number|null }|null}
 */
export function latestKeyFromTimeline(messages = []) {
    if (!Array.isArray(messages) || !messages.length) return null;
    const last = messages[messages.length - 1];
    const id = normalizeTimelineMessageId(last);
    const tsVal = Number(last?.ts ?? null);
    const ts = Number.isFinite(tsVal) ? tsVal : null;
    if (!id && !Number.isFinite(ts)) return null;
    return { id, ts };
}

/**
 * Get the latest key from raw items (sorted first).
 * @param {Array} items - Raw message items
 * @returns {{ id: string|null, ts: number|null }|null}
 */
export function latestKeyFromRaw(items = []) {
    const sorted = sortMessagesByTimelineLocal(items);
    if (!sorted.length) return null;
    const last = sorted[sorted.length - 1];
    const id = normalizeRawMessageId(last);
    const tsVal = extractMessageTimestamp(last);
    const ts = Number.isFinite(tsVal) ? tsVal : null;
    if (!id && !Number.isFinite(ts)) return null;
    return { id, ts };
}

/**
 * Check if two latest keys are equal.
 * @param {{ id: string|null, ts: number|null }|null} a
 * @param {{ id: string|null, ts: number|null }|null} b
 * @returns {boolean}
 */
export function latestKeysEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (a.id || null) === (b.id || null) && (a.ts || null) === (b.ts || null);
}

/**
 * Collect all message IDs from a timeline into a Set.
 * @param {Array} messages - Timeline messages
 * @returns {Set<string>}
 */
export function collectTimelineIdSet(messages = []) {
    const set = new Set();
    if (!Array.isArray(messages)) return set;
    for (const msg of messages) {
        const mid = normalizeTimelineMessageId(msg);
        if (mid) set.add(mid);
    }
    return set;
}
