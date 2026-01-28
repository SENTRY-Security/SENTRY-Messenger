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
    if (items.length <= 1) return items.slice();

    // 1. Group by Stream (Direction + Sender + Device)
    const streams = new Map();
    const system = [];

    for (const msg of items) {
        // System / Control messages often lack direction/sender, treat as atoms
        if (msg.msgType === 'system' || msg.msgType === 'call-log' || !msg.direction) {
            system.push(msg);
            continue;
        }

        // Define Stream Key
        // Outgoing: 'OUT' (or 'OUT:<selfDevice>') - simplified to 'OUT' as self-consistency is usually fine globally or per device is too granular if sync matches.
        // Incoming: 'IN:<digest>:<device>'
        let key = 'SYS';
        if (msg.direction === 'outgoing') {
            key = 'OUT';
        } else {
            const digest = msg.senderDigest || msg.sender_digest || 'unknown';
            const device = msg.senderDeviceId || msg.peerDeviceId || 'unknown';
            key = `IN:${digest}:${device}`;
        }

        let list = streams.get(key);
        if (!list) {
            list = [];
            streams.set(key, list);
        }
        list.push(msg);
    }

    // 2. Sort Each Stream (Primary: Counter, Secondary: TS)
    const comparatorStream = (a, b) => {
        // Causal Order (Counter)
        const cA = resolveRenderEntryCounter(a);
        const cB = resolveRenderEntryCounter(b);
        if (cA !== null && cB !== null) {
            return cA - cB;
        }
        // Fallback: Time
        const tA = extractMessageTimestampMs(a) ?? 0;
        const tB = extractMessageTimestampMs(b) ?? 0;
        if (tA !== tB) return tA - tB;
        // Fallback: ID
        return (a.id || '').localeCompare(b.id || '');
    };

    for (const list of streams.values()) {
        list.sort(comparatorStream);
    }
    system.sort((a, b) => (extractMessageTimestampMs(a) ?? 0) - (extractMessageTimestampMs(b) ?? 0));

    // 3. Merge Streams (Primary: Timestamp)
    // Using a simple N-way merge or flattening and sorting is tricky because sorting the flattened list by TS might violate Causal Order we just established?
    // NO. If we flatten and sort by TS, we undo step 2.
    // We must merge while preserving Stream Order.
    // "Merge K Sorted Lists" algorithm based on TS of head.

    const result = [];
    const cursors = new Map(); // key -> index
    const keys = Array.from(streams.keys());
    if (system.length) keys.push('SYS'); // Treat system as a stream
    if (system.length) streams.set('SYS', system);

    for (const k of keys) cursors.set(k, 0);

    const total = items.length;
    while (result.length < total) {
        let candidateKey = null;
        let minTs = Infinity;
        let minCounter = Infinity; // Tie breaker? No, TS is primary for inter-stream.

        for (const k of keys) {
            const list = streams.get(k);
            const idx = cursors.get(k);
            if (idx >= list.length) continue;

            const msg = list[idx];
            const ts = extractMessageTimestampMs(msg) ?? 0;

            // Find oldest timestamp
            if (ts < minTs) {
                minTs = ts;
                candidateKey = k;
            } else if (ts === minTs) {
                // Tie breaker for same timestamp?
                // Prefer Outgoing? or ID?
                // Let's rely on ID for stability
                const currentMsg = streams.get(candidateKey)[cursors.get(candidateKey)];
                if ((msg.id || '') < (currentMsg.id || '')) {
                    candidateKey = k;
                }
            }
        }

        if (candidateKey) {
            const list = streams.get(candidateKey);
            const idx = cursors.get(candidateKey);
            result.push(list[idx]);
            cursors.set(candidateKey, idx + 1);
        } else {
            // Should not happen unless logic error
            break;
        }
    }

    return result;
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
