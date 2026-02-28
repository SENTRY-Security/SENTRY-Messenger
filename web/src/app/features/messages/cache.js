/**
 * In-memory cache and tombstone state for Messages V2.
 */

import { clearConversation as clearTimelineConversation } from './../timeline-store.js';

const DECRYPTED_CACHE_MAX_PER_CONV = 100;

// State Maps/Sets
export const decryptedMessageStore = new Map(); // conversationId -> Map(messageId -> msgObj)
export const tombstonedConversations = new Set(); // conversationId
export const conversationClearAfter = new Map(); // conversationId -> unix ts
export const processedMessageCache = new Map(); // conversationId -> Set(messageId)
export const receiptStore = new Map(); // conversationId -> Map(messageId -> {read:bool, ts:number})
export const deliveredStore = new Map(); // conversationId -> Map(messageId -> {delivered:bool, ts:number})
export const vaultAckCounterStore = new Map(); // conversationId -> {counter:number, ts:number}
export const drFailureCounter = new Map(); // `${conversationId}::${peerKey}` -> count

// Utility Functions

function normalizeMessageId(messageObj) {
    if (!messageObj) return null;
    return messageObj.id || messageObj.messageId || messageObj.serverMessageId || messageObj.server_message_id || null;
}

export function clearDecryptedMessages(conversationId) {
    if (!conversationId) return;
    const key = String(conversationId);
    decryptedMessageStore.delete(key);
    // Note: clearTimelineConversation is imported from timeline-store.js
    clearTimelineConversation(key);
}

export function putDecryptedMessage(conversationId, messageObj, maxEntries = DECRYPTED_CACHE_MAX_PER_CONV) {
    if (!conversationId || !messageObj) return;
    const messageId = normalizeMessageId(messageObj);
    if (!messageId) return;
    const key = String(conversationId);
    let map = decryptedMessageStore.get(key);
    if (!map) {
        map = new Map();
        decryptedMessageStore.set(key, map);
    }
    map.set(messageId, messageObj);
    const limit = Math.max(50, Math.min(Number(maxEntries) || DECRYPTED_CACHE_MAX_PER_CONV, DECRYPTED_CACHE_MAX_PER_CONV));
    if (map.size > limit) {
        const overflow = map.size - limit;
        for (let i = 0; i < overflow; i += 1) {
            const first = map.keys().next();
            if (first.done) break;
            map.delete(first.value);
        }
    }
}

export function getDecryptedMessages(conversationId) {
    if (!conversationId) return [];
    const map = decryptedMessageStore.get(String(conversationId));
    if (!(map instanceof Map) || !map.size) return [];
    return Array.from(map.values())
        .filter(Boolean)
        .sort((a, b) => (Number(a?.ts) || 0) - (Number(b?.ts) || 0));
}

export function hasDecryptedMessage(conversationId, messageId) {
    if (!conversationId || !messageId) return false;
    const map = decryptedMessageStore.get(String(conversationId));
    return map instanceof Map && map.has(messageId);
}

export function markConversationTombstone(conversationId, lockWiper = null) {
    if (!conversationId) return;
    const key = String(conversationId);
    tombstonedConversations.add(key);

    // Clear related caches
    processedMessageCache.delete(key);
    receiptStore.delete(key);
    deliveredStore.delete(key);
    vaultAckCounterStore.delete(key);
    drFailureCounter.delete(key);
    clearDecryptedMessages(key);

    // Optimization: If a lock wiper callback is provided (to break circular deps), call it.
    if (typeof lockWiper === 'function') {
        lockWiper(key);
    }
}

export function isConversationTombstoned(conversationId) {
    if (!conversationId) return false;
    return tombstonedConversations.has(String(conversationId));
}

export function clearConversationTombstone(conversationId) {
    if (!conversationId) return;
    tombstonedConversations.delete(String(conversationId));
}

export function clearConversationHistory(conversationId, ts = null, lockWiper = null) {
    if (!conversationId) return;
    const key = String(conversationId);
    const nowSec = Math.floor(Date.now() / 1000);
    let stamp = Number.isFinite(Number(ts)) ? Number(ts) : nowSec;
    // [FIX] Normalize to seconds — callers may pass Date.now() (ms) or message
    // timestamps that are already in seconds.  The in-memory clearAfter is
    // compared against incoming tsRaw (seconds), so storing ms here would cause
    // ALL future messages to be silently dropped (seconds < ms → always true).
    if (stamp > 100000000000) stamp = Math.floor(stamp / 1000);
    conversationClearAfter.set(key, stamp);

    // Clear related caches
    processedMessageCache.delete(key);
    receiptStore.delete(key);
    deliveredStore.delete(key);
    vaultAckCounterStore.delete(key);
    drFailureCounter.delete(key);
    clearDecryptedMessages(key);

    if (typeof lockWiper === 'function') {
        lockWiper(key);
    }
}

export function getConversationClearAfter(conversationId) {
    if (!conversationId) return null;
    const ts = conversationClearAfter.get(String(conversationId));
    return Number.isFinite(ts) ? ts : null;
}

// Processed Message Helpers

const PROCESSED_CACHE_MAX_PER_CONV = 500;
const PROCESSED_CACHE_MAX_CONVS = 50;

export function wasMessageProcessed(conversationId, messageId) {
    if (!conversationId || !messageId) return false;
    const set = processedMessageCache.get(String(conversationId));
    return !!(set && set.has(messageId));
}

export function markMessageProcessed(conversationId, messageId, maxEntries = 200) {
    if (!conversationId || !messageId) return;
    const key = String(conversationId);
    let set = processedMessageCache.get(key);
    if (!set) {
        set = new Set();
        processedMessageCache.set(key, set);
        if (processedMessageCache.size > PROCESSED_CACHE_MAX_CONVS) {
            const firstKey = processedMessageCache.keys().next();
            if (!firstKey.done) processedMessageCache.delete(firstKey.value);
        }
    }
    set.add(messageId);
    const limit = Math.max(50, Math.min(Number(maxEntries) || PROCESSED_CACHE_MAX_PER_CONV, PROCESSED_CACHE_MAX_PER_CONV));
    if (set.size > limit) {
        const first = set.values().next();
        if (!first.done) set.delete(first.value);
    }
}

export function markMessagesProcessedForUi(conversationId, messageIds = [], maxEntries = 200) {
    if (!conversationId || !Array.isArray(messageIds)) return;
    for (const id of messageIds) {
        if (typeof id === 'string' && id.trim().length) {
            markMessageProcessed(conversationId, id.trim(), maxEntries);
        }
    }
}

export function resetProcessedMessages(conversationId) {
    if (!conversationId) return;
    processedMessageCache.delete(String(conversationId));
}

export function resetAllProcessedMessages() {
    processedMessageCache.clear();
}
