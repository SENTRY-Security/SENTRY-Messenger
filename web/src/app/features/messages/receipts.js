/**
 * Receipts and delivery status management for Messages V2.
 */

import { log, logCapped } from '../../core/log.js';
import {
    receiptStore,
    deliveredStore,
    vaultAckCounterStore
} from './cache.js';
import {
    CONTROL_MESSAGE_TYPES
} from '../secure-conversation-signals.js';
import { updateTimelineEntriesAsDelivered, updateMessageVaultCount } from '../timeline-store.js';
import { getVaultPutCount } from '../../api/message-key-vault.js';

// Local State (Memory only, but synced to store maps)
const sentReadReceipts = new Set();
const sentDeliveryReceipts = new Set();
// We don't need 'receiptsLoaded' flags if we assume cache.js maps are the source of truth
// or if loading is handled by the caller/store.
// In messages.js, ensureReceiptsLoaded() checked sessionStore. 
// Ideally, the stores in cache.js should be populated from sessionStore on init outside of this module?
// Or we need to import sessionStore here to load them.

import {
    sessionStore
} from '../../ui/mobile/session-store.js';

import {
    ensureDeviceId as storeEnsureDeviceId,
    normalizePeerIdentity as storeNormalizePeerIdentity
} from '../../core/store.js';


export function resetReceiptStore() {
    receiptStore.clear();
    sentReadReceipts.clear();
    deliveredStore.clear();
    sentDeliveryReceipts.clear();
    vaultAckCounterStore.clear();
}

export function getMessageReceipt(conversationId, messageId) {
    if (!conversationId || !messageId) return null;
    // ensureReceiptsLoaded removed

    const map = receiptStore.get(conversationId);
    if (map instanceof Map) return map.get(messageId) || null;
    return null;
}

export function getMessageDelivery(conversationId, messageId) {
    return getDeliveredReceipt(conversationId, messageId);
}

export function getVaultAckCounter(conversationId) {
    if (!conversationId) return null;
    // ensureVaultAckLoaded removed

    const entry = vaultAckCounterStore.get(String(conversationId));
    const counter = Number(entry?.counter);
    return Number.isFinite(counter) ? counter : null;
}

export async function recordVaultAckCounter(conversationId, counter, ts = null, messageId = null) {
    // Only proceed if we have at least conversationId
    if (!conversationId) return false;

    // Legacy logic: if counter is present, we still persist it for backward compatibility / debug
    if (Number.isFinite(counter)) {
        const key = String(conversationId);
        const nextCounter = Number(counter);
        const existing = vaultAckCounterStore.get(key);
        const nextTs = Number.isFinite(Number(ts)) ? Number(ts) : (existing?.ts ?? null);
        vaultAckCounterStore.set(key, { counter: nextCounter, ts: nextTs });

        // Use legacy logic as fallback for bulk updates
        try {
            updateTimelineEntriesAsDelivered(conversationId, nextCounter);
        } catch { }
    }

    // New Logic: Fetch Authoritative Count
    if (messageId) {
        try {
            const result = await getVaultPutCount({ conversationId, messageId });
            if (result && result.ok && Number.isFinite(result.count)) {
                updateMessageVaultCount(conversationId, messageId, result.count);
                console.log('[receipts] updated vault count', { conversationId, messageId, count: result.count });
            }
        } catch (err) {
            console.warn('[receipts] failed to fetch vault count', err);
        }
    }

    return true;
}

function getDeliveredReceipt(conversationId, messageId) {
    if (!conversationId || !messageId) return null;
    // ensureDeliveredLoaded removed

    const map = deliveredStore.get(conversationId);
    if (map instanceof Map) return map.get(messageId) || null;
    return null;
}

export function recordMessageRead(conversationId, messageId, ts = null) {
    if (!conversationId || !messageId) return false;
    // ensureReceiptsLoaded removed

    let map = receiptStore.get(conversationId);
    if (!map) {
        map = new Map();
        receiptStore.set(conversationId, map);
    }
    const existing = map.get(messageId);
    if (existing?.read) return false;
    map.set(messageId, { read: true, ts: ts && Number.isFinite(ts) ? ts : null });
    // persistReceipts removed
    recordMessageDelivered(conversationId, messageId, ts);
    return true;
}

export function maybeSendReadReceipt(conversationId, peerAccountDigest, peerDeviceId, messageId, deps = {}) {
    if (!conversationId || !peerAccountDigest || !peerDeviceId || !messageId) return;
    if (typeof deps.wsSend !== 'function') return;
    // ensureSentReceiptsLoaded removed

    const dedupeKey = `${conversationId}:${messageId}`;
    if (sentReadReceipts.has(dedupeKey)) return;

    // We need storeEnsureDeviceId and storeNormalizePeerIdentity. 
    // If not injected, we try to use imports, but imports might cause circular deps if not careful.
    // messages.js passed deps.storeNormalizePeerIdentity.

    const normalizeIdentity = deps.storeNormalizePeerIdentity || storeNormalizePeerIdentity;
    const ensureDeviceId = deps.storeEnsureDeviceId || storeEnsureDeviceId;

    const identity = normalizeIdentity({ peerAccountDigest, peerDeviceId });
    const targetAccountDigest = identity?.accountDigest
        || (typeof peerAccountDigest === 'string' ? peerAccountDigest.split('::')[0] : null);

    let senderDeviceId = null;
    try {
        senderDeviceId = ensureDeviceId();
    } catch { }

    if (!targetAccountDigest || !senderDeviceId) return;
    const senderAccountDigest = typeof deps.getAccountDigest === 'function' ? deps.getAccountDigest() : null;

    const payload = {
        type: CONTROL_MESSAGE_TYPES.READ_RECEIPT,
        conversationId,
        messageId,
        senderAccountDigest: senderAccountDigest || null,
        senderDeviceId,
        targetAccountDigest,
        targetDeviceId: peerDeviceId,
        ts: Date.now()
    };
    sentReadReceipts.add(dedupeKey);
    try {
        const result = deps.wsSend(payload);
        if (result && typeof result.then === 'function') {
            result.catch(() => sentReadReceipts.delete(dedupeKey));
            return;
        }
        if (result === false) {
            sentReadReceipts.delete(dedupeKey);
            return;
        }
        // persistSentReceipts removed

    } catch {
        sentReadReceipts.delete(dedupeKey);
    }
}

export function recordMessageDelivered(conversationId, messageId, ts = null) {
    if (!conversationId || !messageId) return false;
    // ensureDeliveredLoaded removed

    let map = deliveredStore.get(conversationId);
    if (!map) {
        map = new Map();
        deliveredStore.set(conversationId, map);
    }
    const existing = map.get(messageId);
    if (existing?.delivered) return true;
    map.set(messageId, { delivered: true, ts: ts && Number.isFinite(ts) ? ts : null });
    // persistDelivered removed

    return true;
}

export function maybeSendDeliveryReceipt({ conversationId, peerAccountDigest, messageId, tokenB64, peerDeviceId, vaultPutStatus = null }, deps = {}) {
    if (!conversationId || !peerAccountDigest || !messageId) return;
    if (!peerDeviceId) return;
    if (typeof deps.wsSend !== 'function') return;

    const dedupeKey = `${conversationId}:${messageId}`;
    if (sentDeliveryReceipts.has(dedupeKey)) return;

    if (vaultPutStatus) {
        logCapped('receiverDeliveryReceiptTrace', {
            messageId,
            vaultPutStatus,
            receiptType: CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT
        });
    }

    try {
        const normalizeIdentity = deps.storeNormalizePeerIdentity || storeNormalizePeerIdentity;
        const ensureDeviceId = deps.storeEnsureDeviceId || storeEnsureDeviceId;

        const identity = normalizeIdentity({ peerAccountDigest, peerDeviceId });
        const targetAccountDigest = identity?.accountDigest
            || (typeof peerAccountDigest === 'string' ? peerAccountDigest.split('::')[0] : null);

        let senderDeviceId = null;
        try {
            senderDeviceId = ensureDeviceId();
        } catch { }

        if (!targetAccountDigest || !senderDeviceId) return;
        const senderAccountDigest = typeof deps.getAccountDigest === 'function' ? deps.getAccountDigest() : null;

        const payload = {
            type: CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT,
            conversationId,
            messageId,
            senderAccountDigest: senderAccountDigest || null,
            senderDeviceId,
            targetAccountDigest,
            targetDeviceId: peerDeviceId,
            ts: Date.now()
        };
        sentDeliveryReceipts.add(dedupeKey);
        const result = deps.wsSend(payload);
        if (result && typeof result.then === 'function') {
            result.then(() => {
                logCapped('deliveryAckTrace', {
                    stage: 'sent',
                    ackedMessageId: messageId,
                    conversationId
                });
            }).catch((err) => {
                sentDeliveryReceipts.delete(dedupeKey);
                log({ deliveryReceiptError: err?.message || err, conversationId, messageId });
            });
        } else if (result === false) {
            sentDeliveryReceipts.delete(dedupeKey);
        } else {
            logCapped('deliveryAckTrace', {
                stage: 'sent',
                ackedMessageId: messageId,
                conversationId
            });
        }
    } catch (err) {
        return;
    }
}

export function maybeSendVaultAckWs({
    conversationId,
    messageId,
    senderAccountDigest,
    senderDeviceId,
    receiverAccountDigest,
    receiverDeviceId,
    counter
}, deps = {}) {
    if (!conversationId || !messageId || !senderAccountDigest || !senderDeviceId || !receiverAccountDigest || !receiverDeviceId) return;
    if (typeof deps.wsSend !== 'function') return;
    const payload = {
        type: 'vault-ack',
        conversationId,
        messageId,
        senderAccountDigest,
        senderDeviceId,
        receiverAccountDigest,
        receiverDeviceId,
        targetAccountDigest: senderAccountDigest,
        targetDeviceId: senderDeviceId,
        ts: Date.now()
    };
    if (Number.isFinite(counter)) payload.counter = counter;
    try {
        deps.wsSend(payload);
        logCapped('vaultAckWsSentTrace', {
            conversationId,
            messageId,
            senderDigest: senderAccountDigest,
            receiverDigest: receiverAccountDigest
        }, 5);
    } catch { }
}
