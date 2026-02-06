// /app/features/messages-flow/hybrid-flow.js
// Hybrid pipeline: Smart Fetch + Sequential Route A/B Decrypt.

import { MessageKeyVault } from '../message-key-vault.js';
import { fetchSecureMaxCounter, listSecureMessagesForReplay, getSecureMessageByCounter } from './server-api.js';
import { decryptReplayBatch } from './vault-replay.js';
import { consumeLiveJob } from './live/coordinator.js';
import { getLocalProcessedCounter } from './local-counter.js';
import { sessionStore } from '../../ui/mobile/session-store.js';
import { enqueueDrIncomingOp } from '../dr-session.js';
import { normalizePeerIdentity } from '../../core/store.js';
import { appendBatch as timelineAppendBatch, updateTimelineEntryStatusByCounter } from '../timeline-store.js';
import { CONTROL_STATE_SUBTYPES, TRANSIENT_SIGNAL_SUBTYPES, normalizeSemanticSubtype } from '../semantic.js';

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

const HYBRID_LOG_CAP = 5;
const DEBUG = { drVerbose: true }; // [FIX] Define DEBUG to prevent ReferenceError
const SMART_FETCH_BUFFER = 5;
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
    if (!conversationId) throw new Error('conversationId required');

    const selfDeviceId = storeGetDeviceId();
    const selfDigest = storeGetAccountDigest();
    const mkRaw = storeGetMkRaw();

    // Resolve context early for params
    const context = resolveConversationContext(conversationId);

    if (!mkRaw) throw new Error('MK missing');

    // 1. Calculate Limits (Smart Fetch)
    let fetchLimit = limit;
    let gapSize = 0;
    let localMax = -1;
    let serverMax = -1;
    let isGapFetch = false;

    // Only perform smart gap check on initial load (no cursor)
    if (!cursor) {
        try {
            // Get server max FIRST so we can use it as a hint for localMax
            // CRITICAL: We need Peer's max counter (Incoming Chain).
            // Pass peerDeviceId if available. If not, we can't calculate gap reliably.
            let maxCounterVal = 0;
            if (context.peerDeviceId) {
                const { maxCounter } = await fetchSecureMaxCounter({ conversationId, senderDeviceId: context.peerDeviceId });
                maxCounterVal = maxCounter;
            }
            serverMax = Number.isFinite(maxCounterVal) ? maxCounterVal : 0;

            // Get reliably processed local max
            localMax = await getLocalProcessedCounter({ conversationId }, { serverMax });
            if (!Number.isFinite(localMax)) localMax = 0;

            // Calculate Gap
            gapSize = serverMax - localMax;

            // If gap is positive, we must fetch enough to cover it
            if (gapSize > 0) {
                fetchLimit = Math.max(limit, gapSize + SMART_FETCH_BUFFER);
                isGapFetch = true;
            }
        } catch (err) {
            logHybridTrace('smartFetchCalcError', { conversationId, error: err.message });
        }
    }

    logHybridTrace('smartFetchPlan', {
        conversationId,
        cursor,
        localMax,
        serverMax,
        gapSize,
        fetchLimit,
        isGapFetch
    });
    console.warn('[HybridVerify] Plan:', { conversationId, localMax, serverMax, gapSize, fetchLimit });

    // 2. Fetch Items (with keys included)
    const { items: rawItems, nextCursor, keys: serverKeys } = await listSecureMessagesForReplay({
        conversationId,
        limit: fetchLimit,
        cursorTs: cursor?.ts,
        cursorId: cursor?.id,
        includeKeys: true
    });
    console.warn('[HybridVerify] Raw Items Fetched:', rawItems.length, 'Keys:', serverKeys ? Object.keys(serverKeys).length : 0);

    // --- GAP FILLING LOGIC ---
    // If we tried to cover a gap (isGapFetch) but the time-based API returned non-contiguous counters,
    // we must explicitly fetch the missing ones.
    if (isGapFetch && rawItems.length > 0) {
        try {
            // 1. Find the lowest counter we fetched
            let minFetched = Number.MAX_SAFE_INTEGER;
            for (const item of rawItems) {
                const c = Number(item.counter ?? item.n);
                if (Number.isFinite(c) && c < minFetched) minFetched = c;
            }

            // 2. Determine missing range: (localMax, minFetched)
            const missingStart = localMax + 1;
            const missingEnd = minFetched - 1;

            if (minFetched !== Number.MAX_SAFE_INTEGER && missingEnd >= missingStart) {
                const missingCount = missingEnd - missingStart + 1;
                console.warn(`[HybridVerify] Gap Detected! localMax=${localMax}, minFetched=${minFetched}. Missing ${missingCount} items (${missingStart}-${missingEnd}). Filling...`);

                // Cap to avoid specific performance issues
                const GAP_FILL_CAP = 50;
                const end = Math.min(missingEnd, missingStart + GAP_FILL_CAP - 1);

                const fetchPromises = [];
                for (let c = missingStart; c <= end; c++) {
                    fetchPromises.push(
                        getSecureMessageByCounter({ conversationId, counter: c, senderDeviceId: context.peerDeviceId })
                            .then(res => res.item)
                            .catch(e => {
                                console.warn(`[HybridVerify] Failed to fill gap counter ${c}:`, e);
                                return null;
                            })
                    );
                }

                if (fetchPromises.length > 0) {
                    const filledItems = await Promise.all(fetchPromises);
                    const validFilled = filledItems.filter(Boolean);

                    if (validFilled.length > 0) {
                        console.warn(`[HybridVerify] Filled ${validFilled.length} missing items.`);

                        // Merge and Dedupe
                        const existingIds = new Set(rawItems.map(i => i.id || i.messageId));
                        for (const item of validFilled) {
                            const id = item.id || item.messageId;
                            if (id && !existingIds.has(id)) {
                                rawItems.push(item);
                                existingIds.add(id);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('[HybridVerify] Gap Fill Error:', err);
        }
    }

    if (!rawItems.length && !isGapFetch) {
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


    if (DEBUG.drVerbose) console.warn(`[HybridVerify] Processing ${sortedItems.length} items in ${deviceGroups.size} device groups.`);

    // [FIX] History First Strategy: Prioritize groups with Keys
    // We want to process "History" (Old, Has Key) before "Offline" (New, No Key).
    const sortedGroups = Array.from(deviceGroups.values()).sort((a, b) => {
        // Check if group has any key in serverKeys
        const hasKeyA = a.items.some(item => {
            const id = item.id || item.messageId || item.serverMessageId;
            return serverKeys && id && serverKeys[id];
        });
        const hasKeyB = b.items.some(item => {
            const id = item.id || item.messageId || item.serverMessageId;
            return serverKeys && id && serverKeys[id];
        });

        if (hasKeyA && !hasKeyB) return -1; // A first
        if (!hasKeyA && hasKeyB) return 1;  // B first
        return 0; // Maintain existing order (Time based)
    });

    // Iterate Sorted Groups Sequentially
    for (const group of sortedGroups) {
        const groupDigest = group.digest;
        const groupDeviceId = group.deviceId;
        const groupItems = group.items;

        if (!groupItems.length) continue;

        // Construct STRICT Lock Key
        // Must match Live Flow: `Digest::DeviceID`
        const groupLockKey = (groupDigest && groupDeviceId)
            ? `${groupDigest}::${groupDeviceId}`
            : groupDigest; // Fallback only if deviceId truly missing (risky but necessary)

        if (DEBUG.drVerbose) console.log(`[HybridVerify] Locking Group: ${groupLockKey} (${groupItems.length} items)`);

        await enqueueDrIncomingOp(groupLockKey, async () => {
            for (const item of groupItems) {
                const counter = Number(item.counter ?? item.n);

                // [FIX] Robust Outgoing Detection
                // Explicitly check Device ID first. If it matches Self, it IS outgoing.
                // This prevents "Route B" (Live Fallback) from processing self-messages as incoming
                // which would corrupt the Receiver Chain (Nr) with Sender Counter (Ns) values.
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

                // Skip counter validation for Outgoing messages (Vault doesn't need it)
                if (!isOutgoing && !Number.isFinite(counter)) {
                    const reason = 'INVALID_INCOMING_COUNTER';
                    errors.push({ item, reason });
                    // Return placeholder and log error but don't break batch
                    const ts = Number(item.ts || item.created_at || item.createdAt || Date.now() / 1000);
                    decryptedItems.push({
                        ...item,
                        decrypted: false,
                        reason,
                        id: item.id || item.messageId,
                        counter: 0,
                        ts: ts,
                        tsMs: ts * 1000
                    });
                    continue;
                }

                let result = null;
                let useRouteA = true;
                const aErrors = [];

                if (useRouteA) {
                    // --- Route A (Vault) ---
                    const { items: aItems, errors: errs } = await decryptReplayBatch({
                        conversationId,
                        items: [item],
                        selfDeviceId,
                        selfDigest,
                        mk: mkRaw,
                        serverKeys,
                        getMessageKey: MessageKeyVault.getMessageKey,
                        buildDrAadFromHeader: cryptoBuildDrAadFromHeader,
                        b64u8: naclB64u8
                    });

                    if (errs) aErrors.push(...errs);

                    if (aItems.length) {
                        result = { ok: true, item: aItems[0] };
                    }

                    // [Shadow Advance REMOVED]
                    // We removed the optimistic "Shadow Advance" logic here.
                    // Reason: It causes race conditions with Live Message "Gap Filling".
                    // Live Flow (coordinator.js) is responsible for detecting gaps and filling them sequentially.
                    // Hybrid Flow should only decrypt what it has, without side-effects on the Ratchet State for future messages.
                }

                // If Route A (Vault) succeeded, save the result
                if (result && result.ok && result.item) {
                    // Check for Control messages to hide them
                    const rawType = result.item.msgType || result.item.type;
                    const subtype = normalizeSemanticSubtype(rawType);
                    const isControl = subtype && (
                        subtype === 'control' ||
                        (CONTROL_STATE_SUBTYPES.has(subtype) && subtype !== 'conversation-deleted') ||
                        TRANSIENT_SIGNAL_SUBTYPES.has(subtype)
                    );

                    if (subtype === 'conversation-deleted') {
                        result.item.msgType = 'conversation-deleted';
                    }

                    if (isControl) {
                        updateTimelineEntryStatusByCounter(conversationId, counter, 'hidden', { reason: 'CONTROL_MSG_DECRYPTED' });
                    }
                    decryptedItems.push(result.item);
                } else {
                    // --- Route B (Live Fallback) ---
                    // Route A failed (e.g. key missing).
                    const routeAFailReason = aErrors.length ? (aErrors[0]?.reasonCode || aErrors[0]?.reason || 'ROUTE_A_FAIL') : 'CONTROL_SKIP';
                    const isGapMessage = counter > localMax;
                    const forceFallback = (routeAFailReason === 'CONTROL_SKIP' && isGapMessage && !isOutgoing);

                    // Optimization: If Control Skip (irrelevant message) and NOT forced, skip Route B
                    if (routeAFailReason === 'CONTROL_SKIP' && !forceFallback) {
                        // silently skip
                        updateTimelineEntryStatusByCounter(conversationId, counter, 'hidden', { reason: 'CONTROL_SKIP' });
                    } else if (!isOutgoing) {
                        // Attempt Route B
                        if (DEBUG.drVerbose) console.warn(`[HybridVerify] Route A failed (${routeAFailReason}). Fallback to Route B for item ${item.id}...`);

                        const MAX_RETRIES = 5;
                        let retries = 0;
                        let bResult = null;

                        // Blocking Retry Loop to ensure Vault persistence
                        while (retries <= MAX_RETRIES) {
                            try {
                                bResult = await consumeLiveJob({
                                    type: 'WS_INCOMING',
                                    conversationId,
                                    messageId: item.id,
                                    serverMessageId: item.id,
                                    tokenB64: context.tokenB64,
                                    peerAccountDigest: groupDigest,
                                    peerDeviceId: groupDeviceId,
                                    sourceTag: 'hybrid-replay-fallback',
                                    skipIncomingLock: true, // [MUTEX] Held
                                    bootstrapDrFromGuestBundle: null, // [FIX] Disable Reset
                                    skipGapCheck: true // [FIX] Hybrid Flow is sequential; skip blocking check
                                }, {
                                    fetchSecureMessageById: createNoOpFetcher(item),
                                    stateAccess: createLiveStateAccess({ adapters: createLiveLegacyAdapters() })
                                });

                                // Success if decrypted, regardless of vault put (though we prefer it)
                                // Actually, we retry strictly for vault put to prevent gaps.
                                if (bResult.ok && bResult.decrypted && bResult.vaultPut) {
                                    break;
                                }
                                if (!bResult.ok || !bResult.decrypted) {
                                    break;
                                }

                                retries++;
                                if (retries <= MAX_RETRIES) {
                                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries)));
                                }
                            } catch (e) {
                                retries++;
                                if (retries <= MAX_RETRIES) {
                                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries)));
                                } else {
                                    bResult = { ok: false, reason: 'ROUTE_B_EXCEPTION' };
                                }
                            }
                        }

                        // Check B Result
                        if (bResult && bResult.ok && bResult.decrypted) {
                            if (!bResult.vaultPut) {
                                // Circuit Breaker: If we can't persist to Vault, stop batch to avoid gaps
                                console.error(`[HybridVerify] CRITICAL: Route B Vault Put Persistently Failed for item ${item.id}. Aborting Batch!!!`);
                                errors.push({ item, reason: 'ROUTE_B_VAULT_PUT_FAIL_ABORT' });
                                // We really should break the inner loop here to stop processing this device group
                                // because we might have a gap now.
                                // But technically if we continue, we just create more gaps. Aborting is safer.
                                // However, `break` inside `enqueueDrIncomingOp` breaks the `for` loop of items.
                                break;
                            }

                            // B Succeeded.
                            const directDecrypted = bResult.decryptedMessage; // [FIX] Use direct result

                            if (directDecrypted) {
                                decryptedItems.push(directDecrypted);
                            } else {
                                // Fallback: Re-fetch via Route A logic (Race Condition Prone)
                                // Only do this if coordinator didn't return the payload for some reason
                                const { items: retryItems } = await decryptReplayBatch({
                                    conversationId,
                                    items: [item],
                                    selfDeviceId,
                                    selfDigest,
                                    mk: mkRaw,
                                    getMessageKey: MessageKeyVault.getMessageKey,
                                    buildDrAadFromHeader: cryptoBuildDrAadFromHeader,
                                    b64u8: naclB64u8
                                });
                                if (retryItems.length) {
                                    decryptedItems.push(retryItems[0]);
                                } else {
                                    errors.push({ item, reason: 'ROUTE_B_OK_BUT_VAULT_MISSING' });
                                }
                            }
                        } else {
                            errors.push({ item, reason: bResult?.reasonCode || 'ROUTE_B_FAIL' });
                            logHybridTrace('hybridFlowItemFail', { conversationId, messageId: item.id, reason: bResult?.reasonCode });
                        }

                    } else {
                        // Outgoing failure or other control skip
                        errors.push({ item, reason: routeAFailReason });
                    }
                }
            }
        });
    }

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
