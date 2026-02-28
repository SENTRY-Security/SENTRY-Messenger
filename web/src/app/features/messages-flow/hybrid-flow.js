// /app/features/messages-flow/hybrid-flow.js
// Hybrid pipeline: Smart Fetch + Sequential Route A/B Decrypt.

import { MessageKeyVault } from '../message-key-vault.js';
import { listSecureMessagesForReplay } from './server-api.js';
import { decryptReplayBatch } from './vault-replay.js';
import { consumeLiveJob } from './live/coordinator.js';
import { sessionStore } from '../../ui/mobile/session-store.js';
import { enqueueDrIncomingOp } from '../dr-session.js';
import { normalizePeerIdentity } from '../../core/store.js';
import { appendBatch as timelineAppendBatch, updateTimelineEntryStatusByCounter } from '../timeline-store.js';
import { CONTROL_STATE_SUBTYPES, TRANSIENT_SIGNAL_SUBTYPES, normalizeSemanticSubtype } from '../semantic.js';
import { resolvePlaceholderSubtype } from '../messages/parser.js';

import {
    getAccountDigest as storeGetAccountDigest,
    getDeviceId as storeGetDeviceId,
    getMkRaw as storeGetMkRaw
} from '../../core/store.js';
import { buildDrAadFromHeader as cryptoBuildDrAadFromHeader } from '../../crypto/dr.js';
import { b64u8 as naclB64u8 } from '../../crypto/nacl.js';
import { logCapped } from '../../core/log.js';
import { createLiveStateAccess } from './live/state-live.js';
import { createLiveLegacyAdapters } from './live/adapters/index.js';
import { setDeletionCursor } from '../soft-deletion/deletion-api.js';
import { clearConversationHistory } from '../messages/cache.js';
import { applyContactShareFromCommit } from '../contacts.js';

const HYBRID_LOG_CAP = 5;
const DEBUG = { drVerbose: true }; // [FIX] Define DEBUG to prevent ReferenceError
const DEFAULT_LIMIT = 20;

function logHybridTrace(key, payload) {
    logCapped(key, payload, HYBRID_LOG_CAP);
}

function resolveConversationContext(conversationId) {
    if (!conversationId) {
        return { tokenB64: null, peerAccountDigest: null, peerDeviceId: null };
    }
    const convIndex = sessionStore?.conversationIndex;
    const entry = convIndex && typeof convIndex.get === 'function' ? convIndex.get(conversationId) : null;
    const threads = sessionStore?.conversationThreads;
    const thread = threads && typeof threads.get === 'function' ? threads.get(conversationId) : null;

    const tokenB64 = entry?.token_b64 || entry?.tokenB64 || thread?.conversationToken || thread?.conversation?.token_b64 || null;
    const peerAccountDigest = entry?.peerAccountDigest || thread?.peerAccountDigest || null;
    const peerDeviceId = entry?.peerDeviceId || thread?.peerDeviceId || null;

    return { tokenB64, peerAccountDigest, peerDeviceId };
}

// Custom injector to avoid re-fetching item in Route B
function createNoOpFetcher(item) {
    return async () => ({
        supported: true,
        item: item, // Pass the already fetched item
        errors: []
    });
}

export async function smartFetchMessages({
    conversationId,
    limit = DEFAULT_LIMIT,
    cursor = null
} = {}, deps = {}) {
    const { onStreamingUpdate } = deps;
    if (!conversationId) throw new Error('conversationId required');

    const selfDeviceId = storeGetDeviceId();
    const selfDigest = storeGetAccountDigest();
    const mkRaw = storeGetMkRaw();

    // Resolve context early for params
    const context = resolveConversationContext(conversationId);

    if (!mkRaw) throw new Error('MK missing');

    // 1. Fetch Items (with keys included)
    // Retry policy (Route A network):
    //   - Network disconnection: retry WITHOUT counting (wait for reconnect)
    //   - Other errors: count toward MAX_FETCH_RETRIES then throw
    //   - Key crypto failures: handled downstream in decryptReplayBatch (no retry)
    const isNetworkError = (err) => {
        if (!err) return false;
        if (err.name === 'TypeError' && /fetch|network/i.test(err.message || '')) return true;
        if (err.name === 'AbortError') return true;
        const status = typeof err.status === 'number' ? err.status : null;
        if (status === null || status === 0) {
            if (/fetch|network|timeout|abort|ECONNREFUSED|ENOTFOUND/i.test(err.message || '')) return true;
        }
        return false;
    };

    const MAX_FETCH_RETRIES = 3;
    const MAX_NETWORK_WAIT_MS = 5 * 60 * 1000; // 5 min cap for offline waits
    const fetchStartTime = Date.now();
    let fetchRetryCount = 0;
    let rawItems, nextCursor, fetchedKeys;

    while (true) {
        try {
            const result = await listSecureMessagesForReplay({
                conversationId,
                limit,
                cursorTs: cursor?.ts,
                cursorId: cursor?.id,
                includeKeys: true
            });
            rawItems = result.items;
            nextCursor = result.nextCursor;
            fetchedKeys = result.keys;
            break;
        } catch (err) {
            if (isNetworkError(err)) {
                if (Date.now() - fetchStartTime > MAX_NETWORK_WAIT_MS) {
                    throw new Error('Network unavailable too long during fetch');
                }
                console.warn('[HybridVerify] Fetch offline, waiting to retry...', err?.message);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            fetchRetryCount++;
            if (fetchRetryCount > MAX_FETCH_RETRIES) throw err;
            console.warn(`[HybridVerify] Fetch error (retry ${fetchRetryCount}/${MAX_FETCH_RETRIES})`, err?.message);
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, fetchRetryCount)));
        }
    }
    const serverKeys = fetchedKeys;

    if (!rawItems.length) {
        return { items: [], errors: [], nextCursor };
    }

    // 3. Sort ASC for Sequential Processing
    // API returns DESC (Newest First). Reverse to process Oldest -> Newest.
    const sortedItems = [...rawItems].sort((a, b) => {
        return Number(a.counter) - Number(b.counter);
    });

    // [Placeholder Injection]
    if (rawItems.length > 0) {
        // Sort specifically for UI Placeholders (Time-based ASC)
        // This ensures placeholders appear in correct time order, interleaved between senders.
        const placeholderItems = [...rawItems].sort((a, b) => {
            const tsA = Number(a.created_at || a.createdAt || a.ts || 0);
            const tsB = Number(b.created_at || b.createdAt || b.ts || 0);
            return tsA - tsB;
        });

        const placeholders = [];
        const now = Date.now();

        // [Pre-Scan] Barrier Check
        // If the batch contains a 'conversation-deleted' header, we must NOT inject placeholders
        // for messages prior to it. This satisfies "Clean up before render".
        let deletionBarrierCounter = -1;

        for (const raw of placeholderItems) {
            const h = raw.header || (raw.header_json ? JSON.parse(raw.header_json) : {});
            // Helper to get type from header OR meta
            // Fix: Include h.meta?.msgType as typically found in D1 header_json
            const typeCandidates = [
                h.msgType, h.msg_type, h.type, h.subtype,
                h.meta?.msgType, h.meta?.msg_type, h.meta?.type,
                raw.msgType, raw.subtype
            ];
            const type = typeCandidates.find(t => t);

            if (normalizeSemanticSubtype(type) === 'conversation-deleted') {
                const c = Number(raw.counter ?? raw.n ?? raw.header?.counter ?? raw.header?.n);
                if (Number.isFinite(c) && c > deletionBarrierCounter) {
                    deletionBarrierCounter = c;
                }
            }
        }

        for (const raw of placeholderItems) {
            // Fix: hybrid-flow items have counter at root, not necessarily in header object
            const counter = Number(raw.counter ?? raw.n ?? raw.header?.counter ?? raw.header?.n);
            if (!Number.isFinite(counter)) continue;

            // [Barrier Enforcement]
            if (deletionBarrierCounter > 0 && counter <= deletionBarrierCounter) {
                // Skip injection because it's historically deleted OR it is the deletion signal itself
                continue;
            }

            // [Strict Filter] Aggressively identify Control Messages in Hybrid Flow
            // 1. Resolve Header if missing
            let h = raw.header;
            if (!h && raw.header_json) {
                try { h = JSON.parse(raw.header_json); } catch { }
            }
            h = h || {};

            // 2. Resolve Contact Flag
            const isContactFlag = (h.contact === 1 || h.contact === '1' || h.contact === true);

            // 3. Resolve Type from all sources
            const resolveType = (obj) => obj?.msgType || obj?.msg_type || obj?.type || obj?.subtype || obj?.sub_type || null;
            const typeCandidates = [
                resolveType(h),
                resolveType(h?.meta),
                resolveType(raw),
                'text' // fallback for normalization check
            ];

            // 4. String Inspection Failsafe
            const jsonString = raw.header_json || '';
            const hasContactShareString = jsonString.includes('contact-share') || jsonString.includes('"contact":1');

            const normalizedType = typeCandidates.reduce((acc, val) => acc || normalizeSemanticSubtype(val), null);

            const isControl = isContactFlag || hasContactShareString || (normalizedType && (
                normalizedType === 'contact-share' ||
                normalizedType === 'control' ||
                CONTROL_STATE_SUBTYPES.has(normalizedType) ||
                TRANSIENT_SIGNAL_SUBTYPES.has(normalizedType)
            ));

            if (isControl) continue;

            let dir = 'incoming';
            // Quick direction check
            const rawSender = raw.sender || raw.sender_account_digest || raw.senderAccountDigest;
            const sender = rawSender ? (rawSender.includes('::') ? rawSender.split('::')[0] : rawSender) : null;
            const myDigest = selfDigest ? (selfDigest.includes('::') ? selfDigest.split('::')[0] : selfDigest) : null;
            if (sender && myDigest && sender === myDigest) {
                dir = 'outgoing';
            }

            const realId = raw.id || raw.messageId || raw.serverMessageId;
            const msgId = realId || `${conversationId}:${counter}:placeholder`;

            placeholders.push({
                conversationId,
                messageId: msgId,
                counter: counter,
                msgType: 'placeholder',
                placeholder: true,
                status: 'pending',
                senderDeviceId: raw.senderDeviceId || raw.sender_device_id || raw.header?.device_id || null,
                direction: dir,
                ts: raw.created_at || raw.createdAt || raw.ts,
                tsMs: (raw.created_at || raw.createdAt || raw.ts) ? (raw.created_at || raw.createdAt || raw.ts) * 1000 : 0
            });
        }
        if (placeholders.length > 0) {
            timelineAppendBatch(placeholders);
        }
    }

    const decryptedItems = [];
    const errors = [];

    // Resolve context once for the batch
    // context already defined above
    logHybridTrace('resolvedContextDebug', {
        conversationId,
        hasToken: !!context.tokenB64,
        hasPeerDigest: !!context.peerAccountDigest,
        hasPeerDevice: !!context.peerDeviceId,
        rawContext: context // Keep this small if possible, or pick fields
    });
    console.warn('[HybridVerify] Context:', {
        hasToken: !!context.tokenB64,
        peerDigest: context.peerAccountDigest,
        peerDevice: context.peerDeviceId,
        selfDigest,
        selfDeviceId
    });

    // 4. Sequential Hybrid Processing (Grouped by Device & Locked)
    // [FIX] We must Group By Device ID to effectively lock correctly.
    // If we lock using `context.peerDeviceId`, we might use a generic lock (Digest only) if context is incomplete.
    // But Live Messages use strict `Digest::DeviceID`.
    // This mismatch allows parallel execution, causing "State Overwrite" (History overwrites Live state, losing skipped keys).

    // Group items by sender unique ID (Digest::DeviceID)
    const deviceGroups = new Map(); // Key: `${digest}::${deviceId}`, Value: { digest, deviceId, items: [] }

    for (const item of sortedItems) {
        const rawSender = item.sender || item.sender_account_digest || item.senderAccountDigest;
        const sender = rawSender ? (rawSender.includes('::') ? rawSender.split('::')[0] : rawSender) : null;

        // Resolve Device ID from item
        // Note: item might not have top-level senderDeviceId if normalized from API?
        // API usually returns `sender_device_id`.
        const itemDeviceId = item.senderDeviceId || item.sender_device_id || item.header?.device_id || context.peerDeviceId;

        if (sender && itemDeviceId) {
            const key = `${sender}::${itemDeviceId}`;
            if (!deviceGroups.has(key)) {
                deviceGroups.set(key, { digest: sender, deviceId: itemDeviceId, items: [] });
            }
            deviceGroups.get(key).items.push(item);
        } else {
            // Fallback for items missing critical ID (unlikely in secure flow but possible for incomplete data)
            const fallbackKey = `fallback::${context.peerAccountDigest || 'unknown'}`;
            if (!deviceGroups.has(fallbackKey)) {
                deviceGroups.set(fallbackKey, { digest: context.peerAccountDigest, deviceId: context.peerDeviceId, items: [] });
            }
            deviceGroups.get(fallbackKey).items.push(item);
        }
    }


    // [FIX] Helper to converge ID lookup
    // [FIX] Helper to converge ID lookup
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = (val) => typeof val === 'string' && val.length === 36 && UUID_REGEX.test(val);

    const getCanonicalId = (item) => {
        // Priority 1: Normalized camelCase UUID
        if (isUuid(item.serverMessageId)) return item.serverMessageId;
        if (isUuid(item.messageId)) return item.messageId;

        // Priority 2: Raw snake_case UUID (Common in API responses)
        if (isUuid(item.message_id)) return item.message_id;
        if (isUuid(item.server_message_id)) return item.server_message_id;

        // Priority 3: 'id' field if it looks like a UUID (string, long)
        // Some endpoints map UUID to 'id'
        if (isUuid(item.id)) return item.id;

        // Fallback: D1 Numeric ID (stringify) - Only if nothing else matches
        // [STRICT] Do not fallback to numeric ID for authority lookup
        return null;
    };

    if (DEBUG.drVerbose) {
        console.warn(`[HybridVerify] Processing ${sortedItems.length} items in ${deviceGroups.size} device groups.`);
        // Debug ID Mismatch
        if (sortedItems.length > 0) {
            const sample = sortedItems[0];
            const sampleId = getCanonicalId(sample);
            const serverKeyList = serverKeys ? Object.keys(serverKeys) : [];
            // [DEBUG] Stringify to avoid console collapsing
            console.warn('[HybridVerify] ID Debug:', JSON.stringify({
                sampleCanonical: sampleId,
                sampleRaw: { id: sample.id, mid: sample.messageId, smid: sample.serverMessageId },
                serverKeysCount: serverKeyList.length,
                serverKeysSample: serverKeyList.slice(0, 5), // Show first 5 keys
                matchFound: serverKeys && sampleId && !!serverKeys[sampleId]
            }, null, 2));
        }
    }

    // [FIX] History First Strategy: Prioritize groups with Keys
    // We want to process "History" (Old, Has Key) before "Offline" (New, No Key).
    const sortedGroups = Array.from(deviceGroups.values()).sort((a, b) => {
        // Check if group has any key in serverKeys using Canonical ID
        const hasKeyA = a.items.some(item => {
            const id = getCanonicalId(item);
            return serverKeys && id && serverKeys[id];
        });
        const hasKeyB = b.items.some(item => {
            const id = getCanonicalId(item);
            return serverKeys && id && serverKeys[id];
        });

        if (hasKeyA && !hasKeyB) return -1; // A first
        if (!hasKeyA && hasKeyB) return 1;  // B first
        return 0; // Maintain existing order (Time based)
    });

    // Iterate Sorted Groups in Parallel
    // [OPTIMIZATION] Parallelize Independent Device Chains
    // Since each group locks on a unique `groupLockKey` (Digest::DeviceID), they are cryptographically independent.
    // Parallelizing this prevents a "Slow Group" (Route B churning) from blocking a "Fast Group" (Route A Ready).

    await Promise.all(sortedGroups.map(async (group) => {
        const groupDigest = group.digest;
        const groupDeviceId = group.deviceId;
        const groupItems = group.items;

        if (!groupItems.length) return;

        // Construct STRICT Lock Key
        // Must match Live Flow: `Digest::DeviceID`
        const groupLockKey = (groupDigest && groupDeviceId)
            ? `${groupDigest}::${groupDeviceId}`
            : groupDigest; // Fallback only if deviceId truly missing (risky but necessary)

        if (DEBUG.drVerbose) console.log(`[HybridVerify] Locking Group: ${groupLockKey} (${groupItems.length} items)`);

        // [PHASE 1] Priority Batch (Route A - Vault)
        // Decouple "Has Key" items from "No Key" items to prevent Head-of-Line Blocking.
        const priorityItems = [];
        const sequentialItems = [];

        for (const item of groupItems) {
            // Check if key exists in serverKeys
            const id = getCanonicalId(item);

            // [FIX] Guard against Invalid ID (Fundamental Fix)
            // If item has no identifiable ID, we MUST NOT attempt Vault operations.
            // This prevents 'missing_params' trace in MessageKeyVault.
            if (!id || id === 'null') {
                if (DEBUG.drVerbose) console.warn('[HybridVerify] Skipping item with invalid ID:', item);
                continue;
            }

            if (id && serverKeys && serverKeys[id]) {
                priorityItems.push(item);
            } else {
                sequentialItems.push(item);
            }
        }

        // Execute Priority Batch (Route A)
        // These are strictly stateless and can be processed immediately
        if (priorityItems.length > 0) {
            if (DEBUG.drVerbose) console.log(`[HybridVerify] Route A Priority Batch: ${priorityItems.length} items`);

            const { items: successItems, errors: priorityErrors } = await decryptReplayBatch({
                conversationId,
                items: priorityItems, // Batch
                selfDeviceId,
                selfDigest,
                mk: mkRaw,
                serverKeys,
                getMessageKey: MessageKeyVault.getMessageKey,
                buildDrAadFromHeader: cryptoBuildDrAadFromHeader,
                b64u8: naclB64u8
            });

            // Immediately push successes to result list
            for (const item of successItems) {
                const rawType = item.msgType || item.type;
                const subtype = normalizeSemanticSubtype(rawType);
                const isControl = subtype && (
                    subtype === 'control' ||
                    (CONTROL_STATE_SUBTYPES.has(subtype) && subtype !== 'conversation-deleted') ||
                    TRANSIENT_SIGNAL_SUBTYPES.has(subtype)
                );

                if (subtype === 'conversation-deleted') {
                    item.msgType = 'conversation-deleted';
                    // Set deletion cursor when encountering a conversation-deleted
                    // tombstone during history fetch (offline scenario).
                    let clearTimestamp = 0;
                    try {
                        const rawText = item.text || '';
                        if (typeof rawText === 'string' && rawText.trim().startsWith('{')) {
                            const parsed = JSON.parse(rawText);
                            if (Number.isFinite(parsed?.clearTimestamp) && parsed.clearTimestamp > 0) {
                                clearTimestamp = parsed.clearTimestamp;
                            }
                        }
                    } catch {}
                    if (!clearTimestamp) {
                        const ts = Number(item.ts ?? item.timestamp ?? item.created_at ?? 0);
                        if (ts > 0) clearTimestamp = ts > 100000000000 ? Math.floor(ts / 1000) : ts;
                    }
                    if (conversationId && clearTimestamp > 0) {
                        setDeletionCursor(conversationId, clearTimestamp).catch(err => {
                            console.warn('[hybrid-flow] setDeletionCursor for conversation-deleted failed', err?.message || err);
                        });
                        // [FIX] Use clearTimestamp (seconds) instead of Date.now() (ms)
                        // to prevent the in-memory clearAfter filter from blocking
                        // all future incoming messages.
                        clearConversationHistory(conversationId, clearTimestamp);
                    }
                }

                // [FIX] Apply contact-share profile updates (Route A was missing this)
                // Only apply for INCOMING — outgoing contact-shares have sender=self,
                // processing them overwrites the real contact with self's profile.
                if (subtype === 'contact-share' && item.text && item.direction === 'incoming') {
                    try {
                        const messageTs = Number(item.ts ?? item.timestamp ?? Date.now());
                        await applyContactShareFromCommit({
                            peerAccountDigest: groupDigest,
                            peerDeviceId: groupDeviceId,
                            sessionKey: context.tokenB64 || 'vault-replay',
                            plaintext: item.text,
                            messageId: item.messageId || item.serverMessageId || `${conversationId}:${item.counter}`,
                            sourceTag: 'hybrid-flow:contact-share-route-a',
                            profileUpdatedAt: messageTs
                        });
                    } catch (err) {
                        console.warn('[hybrid-flow] contact-share apply failed (Route A)', err);
                    }
                }

                const counter = Number(item.counter ?? item.n);
                if (isControl && Number.isFinite(counter)) {
                    updateTimelineEntryStatusByCounter(conversationId, counter, 'hidden', { reason: 'CONTROL_MSG_DECRYPTED' });
                }
                decryptedItems.push(item);
            }

            // Handle Failures: If Priority Item failed Route A (e.g. key corrupt), fallback to Sequential List
            if (priorityErrors && priorityErrors.length > 0) {
                const successIds = new Set(successItems.map(i => i.id || i.messageId));
                for (const original of priorityItems) {
                    const oid = original.id || original.messageId;
                    if (!successIds.has(oid)) {
                        // This item failed Route A, fallback to Route B (Sequential)
                        sequentialItems.push(original);
                    }
                }
            }
        }

        // [PHASE 2] Sequential Re-Sort & Route B (DR)
        // Merge original sequential items with any failed priority items,
        // then SORT by counter to maintain DR monotonicity.
        sequentialItems.sort((a, b) => {
            return Number(a.counter || 0) - Number(b.counter || 0);
        });

        if (sequentialItems.length > 0) {
            if (DEBUG.drVerbose) console.log(`[HybridVerify] Route B Sequential Loop: ${sequentialItems.length} items`);

            // [OPTIMIZATION] Fire-and-Forget for Route B
            // We do NOT block the main thread for these items.
            // 1. Push Placeholders immediately.
            // 2. Schedule background processing.

            // Prepare Background Queue
            const backgroundQueue = [];

            for (const item of sequentialItems) {
                const counter = Number(item.counter ?? item.n);
                // [FIX] Robust Outgoing Detection
                const itemDeviceId = item.senderDeviceId || item.sender_device_id || item.header?.device_id;
                const rawSender = item.sender || item.sender_account_digest || item.senderAccountDigest;
                const sender = rawSender ? (rawSender.includes('::') ? rawSender.split('::')[0] : rawSender) : null;
                const myDigest = selfDigest ? (selfDigest.includes('::') ? selfDigest.split('::')[0] : selfDigest) : null;

                let isOutgoing = false;
                if (selfDeviceId && itemDeviceId && selfDeviceId === itemDeviceId) {
                    isOutgoing = true;
                } else if (sender && myDigest && sender === myDigest) {
                    isOutgoing = true;
                }

                if (!isOutgoing && !Number.isFinite(counter)) {
                    const reason = 'INVALID_INCOMING_COUNTER';
                    errors.push({ item, reason });
                    // No placeholder needed for invalid counter, just skip
                    continue;
                }

                // [FIX] Hide Placeholders for Control/Transient messages
                // We identify them from header metadata (best effort).
                // If identified, we do NOT show a "Decrypting..." bubble (skip decryptedItems),
                // but we MUST still process them in background (add to backgroundQueue).
                const subtype = resolvePlaceholderSubtype(item);
                const isControl = subtype && (CONTROL_STATE_SUBTYPES.has(subtype) || TRANSIENT_SIGNAL_SUBTYPES.has(subtype));

                if (!isControl) {
                    // Create Placeholder (Only for Visible Messages)
                    const ts = Number(item.ts || item.created_at || item.createdAt || Date.now() / 1000);
                    const placeholder = {
                        ...item,
                        decrypted: false,
                        reason: 'PENDING_ROUTE_B',
                        id: item.id || item.messageId,
                        counter: Number.isFinite(counter) ? counter : 0,
                        msgType: 'placeholder',
                        status: 'decrypting', // Special status for "working on it"
                        error: null,
                        ts: ts,
                        tsMs: ts * 1000,
                        isPlaceholder: true // Explicit flag
                    };
                    decryptedItems.push(placeholder);
                }

                // Add to background queue if incoming
                if (!isOutgoing) {
                    backgroundQueue.push(item);
                } else {
                    errors.push({ item, reason: 'OUTGOING_IN_SEQ_SKIP' });
                }
            }

            // [Background] Process Route B Items Detached
            if (backgroundQueue.length > 0) {
                // We use a detached promise chain. We do NOT await it here.
                // It must acquire the lock itself.
                (async () => {
                    try {
                        // We must re-acquire the lock for the sequential group
                        await enqueueDrIncomingOp(groupLockKey, async () => {
                            for (const item of backgroundQueue) {
                                let bResult = null;

                                // Live decrypt is a deterministic cryptographic operation:
                                // same state + same ciphertext = same result every time.
                                // Retrying serves no purpose and only blocks the queue.
                                try {
                                    bResult = await consumeLiveJob({
                                        type: 'WS_INCOMING',
                                        conversationId,
                                        messageId: item.id,
                                        serverMessageId: item.id,
                                        tokenB64: context.tokenB64,
                                        peerAccountDigest: groupDigest,
                                        peerDeviceId: groupDeviceId,
                                        sourceTag: 'hybrid-replay-fallback-seq-bg',
                                        skipIncomingLock: true, // we held it via enqueue
                                        bootstrapDrFromGuestBundle: null,
                                        skipGapCheck: true
                                    }, {
                                        fetchSecureMessageById: createNoOpFetcher(item),
                                        stateAccess: createLiveStateAccess({ adapters: createLiveLegacyAdapters() })
                                    });
                                } catch (e) {
                                    console.warn('[HybridVerify] Route B decrypt exception', {
                                        messageId: item.id,
                                        error: e?.message || String(e),
                                        counter: item.counter
                                    });
                                    bResult = { ok: false, reasonCode: 'DECRYPT_FAIL' };
                                }

                                // Handle Result
                                if (bResult && bResult.ok && bResult.decrypted) {
                                    const realMessage = bResult.decryptedMessage;
                                    if (realMessage && onStreamingUpdate) {
                                        // Streaming Update to UI
                                        onStreamingUpdate([realMessage]);
                                    }
                                } else {
                                    // Failed - Update Placeholder to 'failed'
                                    if (onStreamingUpdate) {
                                        const failedUpdate = {
                                            ...item,
                                            id: item.id || item.messageId,
                                            msgType: 'placeholder',
                                            status: 'failed',
                                            error: bResult?.reasonCode || 'ROUTE_B_FAIL',
                                            decrypted: false
                                        };
                                        onStreamingUpdate([failedUpdate]);
                                    }
                                }
                            }
                        });
                    } catch (err) {
                        console.error('[HybridVerify] Background Route B Failed', err);
                    }
                })();
            }
        }
    }));

    // 5. Restore DESC order for Facade/UI
    decryptedItems.reverse();

    logHybridTrace('smartFetchDone', {
        conversationId,
        decrypted: decryptedItems.length,
        errors: errors.length
    });
    console.warn('[HybridVerify] Done. Total Decrypted:', decryptedItems.length);

    return { items: decryptedItems, errors, nextCursor };
}
