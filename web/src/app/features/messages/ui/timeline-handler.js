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

import { resolveRenderEntryCounter } from './renderer.js';

/**
 * Sort messages by timeline order (ascending by timestamp, sequence, then ID).
 * @param {Array} items - Array of message items
 * @returns {Array} Sorted array
 */
export function sortMessagesByTimelineLocal(items = []) {
    if (!Array.isArray(items)) return [];
    // Use a shallow copy to prevent mutating the original array
    return items.slice().sort((a, b) => {
        // 1. Primary: Counter (if available) - this handles numeric sorting for reliable ordering
        const cA = resolveRenderEntryCounter(a);
        const cB = resolveRenderEntryCounter(b);
        if (cA !== null && cB !== null) {
            return cA - cB;
        }

        // 2. Secondary: Timestamp - critical for placeholders which only have createdAt from headers
        const tA = extractMessageTimestampMs(a);
        const tB = extractMessageTimestampMs(b);
        if (tA !== tB) {
            // Handle potentially missing timestamps by pushing them to the start/end as needed
            if (tA === null) return -1;
            if (tB === null) return 1;
            return tA - tB;
        }

        // 3. Tertiary: ID fallback for stable sorting when timestamps match
        const idA = a.id || '';
        const idB = b.id || '';
        return idA.localeCompare(idB);
    });
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
