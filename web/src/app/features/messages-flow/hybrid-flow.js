// /app/features/messages-flow/hybrid-flow.js
// Hybrid pipeline: Smart Fetch + Sequential Route A/B Decrypt.

import { MessageKeyVault } from '../message-key-vault.js';
import { fetchSecureMaxCounter, listSecureMessagesForReplay, getSecureMessageByCounter } from './server-api.js';
import { decryptReplayBatch } from './vault-replay.js';
import { consumeLiveJob } from './live/coordinator.js';
import { getLocalProcessedCounter } from './local-counter.js';
import { sessionStore } from '../../ui/mobile/session-store.js';
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

    // 4. Sequential Hybrid Processing
    // 4. Sequential Hybrid Processing
    for (const item of sortedItems) {
        const counter = Number(item.counter ?? item.n);

        // Check direction
        const rawSender = item.sender || item.sender_account_digest || item.senderAccountDigest;
        // Simple normalization
        const sender = rawSender ? (rawSender.includes('::') ? rawSender.split('::')[0] : rawSender) : null;
        const myDigest = selfDigest ? (selfDigest.includes('::') ? selfDigest.split('::')[0] : selfDigest) : null;

        let result = null;
        const isOutgoing = sender && myDigest && sender === myDigest;

        // Skip counter validation for Outgoing messages (Vault doesn't need it)
        if (!isOutgoing && !Number.isFinite(counter)) {
            const reason = 'INVALID_INCOMING_COUNTER';
            errors.push({ item, reason });
            // Return placeholder instead of dropping
            const ts = Number(item.ts || item.created_at || item.createdAt || Date.now() / 1000);
            decryptedItems.push({
                ...item,
                decrypted: false,
                reason,
                id: item.id || item.messageId,
                counter: 0, // Fallback
                ts: ts,
                tsMs: ts * 1000
            });
            continue;
        }

        // Determine Route (A vs B)
        // Always prefer Route A (Vault) first. 
        // If we are replaying history, the Vault likely has the keys (from other devices or previous sessions).
        // If Route A fails (key missing), we will fall back to Route B.
        // We do NOT use localMax to skip Route A, because localMax might be stale (e.g. after re-login).
        let useRouteA = true;

        console.warn(`[HybridVerify] Item ${item.id} (Counter: ${counter}) -> Route ${useRouteA ? 'A' : 'B'} (Outgoing: ${isOutgoing}, LocalMax: ${localMax})`);

        if (useRouteA) {
            // --- Route A (Vault) ---
            const { items: aItems, errors: aErrors } = await decryptReplayBatch({
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

            if (aItems.length) {
                result = { ok: true, item: aItems[0] };
                console.warn(`[HybridVerify] Route A Success item ${item.id}:`, {
                    decrypted: aItems[0].decrypted,
                    reason: aItems[0].reason,
                    hasText: !!aItems[0].text,
                    textLen: aItems[0].text?.length,
                    contentType: aItems[0].contentType
                });
            } else {
                // ... Route A fail ...
            }

            // [Shadow Advance]
            // If Route A succeeded, we must still try to advance the DR state (Ratchet)
            // so that subsequent messages falling back to Route B don't see a huge gap.
            if (result && result.ok && !isOutgoing) {
                try {
                    // Construct Shadow Dependencies
                    // We need to persist the DR State (Ratchet) but NOT the Timeline Entry (Duplicate).
                    // So we use real adapters for everything EXCEPT `appendTimelineBatch`.
                    const realAdapters = createLiveLegacyAdapters();
                    const shadowAdapters = {
                        ...realAdapters,
                        // Mock appendTimelineBatch to be a No-Op (Don't duplicate timeline entry)
                        appendTimelineBatch: async () => ({ ok: true, appended: 0 })
                    };

                    // Create State Access with Shadow Adapters
                    // This allows `persistAndAppendSingle` to run fully, including `persistDrSnapshot`,
                    // but `adapters.appendTimelineBatch` will do nothing.
                    const shadowStateAccess = createLiveStateAccess({ adapters: shadowAdapters });

                    console.warn(`[HybridVerify] Shadow Advance: Triggering for item ${item.id}`);
                    // We await this to ensure sequential ordering (State must update before next iteration)
                    await consumeLiveJob({
                        type: 'WS_INCOMING',
                        conversationId,
                        messageId: item.id,
                        serverMessageId: item.id,
                        tokenB64: context.tokenB64,
                        peerAccountDigest: context.peerAccountDigest,
                        peerDeviceId: context.peerDeviceId,
                        sourceTag: 'hybrid-shadow-advance'
                    }, {
                        fetchSecureMessageById: createNoOpFetcher(item),
                        stateAccess: shadowStateAccess // Inject mocked state access
                    }).catch(e => console.warn('[HybridVerify] Shadow Advance Fail:', e));
                } catch (e) { console.warn('[HybridVerify] Shadow Advance Exception:', e); }
            }
            if (!result || !result.ok) {
                // Route A failed (e.g. key missing).
                const routeAFailReason = aErrors.length ? (aErrors[0]?.reasonCode || aErrors[0]?.reason || 'ROUTE_A_FAIL') : 'CONTROL_SKIP';

                // Check if this is a "Gap Message" (Newer than local state).
                // If Route A skipped it (no content/errors), it's likely just missing from Vault.
                // We MUST fallback to Route B (Live) for these, otherwise they are lost.
                const isGapMessage = counter > localMax;
                const forceFallback = (routeAFailReason === 'CONTROL_SKIP' && isGapMessage && !isOutgoing);

                // If it was a control message skip (and NOT a forced fallback gap message), we are done.
                if (routeAFailReason === 'CONTROL_SKIP' && !forceFallback) {
                    result = { ok: false, reason: 'CONTROL_SKIP' };
                }
                // Fallback to Route B if eligible
                else if (!isOutgoing) {
                    console.warn(`[HybridVerify] Route A failed (${routeAFailReason}). Fallback to Route B for item ${item.id}...`);

                    // --- Route B (Live / Ratchet) ---
                    const job = {
                        type: 'WS_INCOMING',
                        conversationId,
                        messageId: item.id,
                        serverMessageId: item.id,
                        tokenB64: context.tokenB64,
                        peerAccountDigest: context.peerAccountDigest,
                        peerDeviceId: context.peerDeviceId,
                        sourceTag: 'hybrid-flow'
                    };

                    try {
                        const bResult = await consumeLiveJob(job, {
                            fetchSecureMessageById: createNoOpFetcher(item),
                            maybeSendVaultAckWs: deps?.maybeSendVaultAckWs,
                            getAccountDigest: deps?.getAccountDigest,
                            getDeviceId: deps?.getDeviceId,
                            // [HYBRID SAFETY]
                            // Disable Bootstrap for fallback replay.
                            // If this is an old message, it must NOT reset the session.
                            bootstrapDrFromGuestBundle: null
                        });

                        if (bResult.ok && bResult.decrypted) {
                            // Atomic Backup Check:
                            if (!bResult.vaultPut) {
                                console.warn(`[HybridVerify] Route B Success item ${item.id} BUT Vault Put Failed. Logging error and continuing...`);
                                const reason = 'ROUTE_B_VAULT_PUT_FAIL';
                                errors.push({ item, reason });
                                // NON-BLOCKING: Continue to next item
                            }

                            console.warn(`[HybridVerify] Route B Success item ${item.id}. Retrying Route A to fetch content...`);

                            // Route B succeeded, so Key should be in Vault now.
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
                                result = { ok: true, item: retryItems[0] };
                                console.warn(`[HybridVerify] Route B -> Route A Retry Success item ${item.id}:`, {
                                    decrypted: true,
                                    reason: 'RESTORED_VIA_ROUTE_B'
                                });
                            } else {
                                console.warn(`[HybridVerify] Route B Success BUT Route A Retry Failed for item ${item.id}. Logging error and continuing...`);
                                const reason = 'ROUTE_B_OK_BUT_VAULT_MISSING';
                                errors.push({ item, reason });
                                // NON-BLOCKING: Continue to next item
                            }
                        } else {
                            console.warn(`[HybridVerify] Route B Failed item ${item.id}:`, bResult.reasonCode);
                            result = { ok: false, reason: bResult.reasonCode || 'ROUTE_B_FAIL' };

                            // If Gap Message (Newer than local), log but DO NOT stop.
                            if (counter > localMax && result.reason !== 'CONTROL_SKIP') {
                                console.warn(`[HybridVerify] Gap Message Failed at item ${item.id}. Logging error and continuing to sequence...`);
                                errors.push({ item, reason: result.reason });
                                // NON-BLOCKING: Continue to next item
                            }
                        }
                    } catch (err) {
                        console.warn(`[HybridVerify] Route B Exception item ${item.id}:`, err);
                        result = { ok: false, reason: 'ROUTE_B_EXCEPTION' };

                        // If Gap Message, log but DO NOT stop.
                        if (counter > localMax) {
                            console.warn(`[HybridVerify] Gap Message Exception at item ${item.id}. Logging error and continuing to sequence...`);
                            errors.push({ item, reason: result.reason });
                            // NON-BLOCKING: Continue to next item
                        }
                    }
                }
            }
        }

        if (result && result.ok && result.item) {
            // [Fix Stuck Placeholder]
            // If the decrypted message turns out to be a CONTROL message (e.g. sender key, contact-share),
            // we must explicitly HIDE the placeholder.
            const rawType = result.item.msgType || result.item.type;
            const subtype = normalizeSemanticSubtype(rawType);

            const isControl = subtype && (
                subtype === 'control' ||
                (CONTROL_STATE_SUBTYPES.has(subtype) && subtype !== 'conversation-deleted') ||
                TRANSIENT_SIGNAL_SUBTYPES.has(subtype)
            );

            if (subtype === 'conversation-deleted') {
                console.log('[Decrypted Tombstone Payload] (Hybrid Route A)', result.item);
                // Ensure msgType is set so Controller keeps it
                result.item.msgType = 'conversation-deleted';
                // Retrospective cleanup removed as Pre-Render Barrier now handles it correctly.
            }

            if (isControl) {
                updateTimelineEntryStatusByCounter(conversationId, counter, 'hidden', { reason: 'CONTROL_MSG_DECRYPTED' });
                // We still push it to decryptedItems so it can be processed by listeners,
                // but visually it is hidden.
            }
            decryptedItems.push(result.item);
        } else {
            const errorReason = result?.reason || 'UNKNOWN_ERROR';

            // Filter out control messages
            if (errorReason === 'CONTROL_SKIP' || errorReason === 'CORRUPT_SKIP') {
                updateTimelineEntryStatusByCounter(conversationId, counter, 'hidden', { reason: errorReason });
                continue;
            }

            errors.push({ item, reason: errorReason });
            logHybridTrace('hybridFlowItemFail', {
                conversationId,
                messageId: item.id,
                counter,
                route: counter < localMax ? 'A' : 'B',
                reason: errorReason
            });

            // Return placeholder
            const ts = Number(item.ts || item.created_at || item.createdAt || Date.now() / 1000);
            decryptedItems.push({
                ...item,
                decrypted: false,
                reason: errorReason,
                id: item.id || item.messageId,
                counter: counter,
                ts: ts,
                tsMs: ts * 1000
            });
        }
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
