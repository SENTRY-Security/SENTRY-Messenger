// /app/features/messages-flow/hybrid-flow.js
// Hybrid pipeline: Smart Fetch + Sequential Route A/B Decrypt.

import { MessageKeyVault } from '../message-key-vault.js';
import { fetchSecureMaxCounter, listSecureMessagesForReplay } from './server-api.js';
import { decryptReplayBatch } from './vault-replay.js';
import { consumeLiveJob } from './live/coordinator.js';
import { getLocalProcessedCounter } from './local-counter.js';
import { sessionStore } from '../../ui/mobile/session-store.js';
import { normalizePeerIdentity } from '../../core/store.js';

import {
    getAccountDigest as storeGetAccountDigest,
    getDeviceId as storeGetDeviceId,
    getMkRaw as storeGetMkRaw
} from '../../core/store.js';
import { buildDrAadFromHeader as cryptoBuildDrAadFromHeader } from '../../crypto/dr.js';
import { b64u8 as naclB64u8 } from '../../crypto/nacl.js';
import { logCapped } from '../../core/log.js';

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
} = {}) {
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
            // Get reliably processed local max
            localMax = await getLocalProcessedCounter({ conversationId });
            if (!Number.isFinite(localMax)) localMax = 0;

            // Get server max
            // CRITICAL: We need Peer's max counter (Incoming Chain).
            // Pass peerDeviceId if available. If not, we can't calculate gap reliably.
            let maxCounterVal = 0;
            if (context.peerDeviceId) {
                const { maxCounter } = await fetchSecureMaxCounter({ conversationId, senderDeviceId: context.peerDeviceId });
                maxCounterVal = maxCounter;
            }
            serverMax = Number.isFinite(maxCounterVal) ? maxCounterVal : 0;

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

    // 2. Fetch Items
    const { items: rawItems, nextCursor } = await listSecureMessagesForReplay({
        conversationId,
        limit: fetchLimit,
        cursorTs: cursor?.ts,
        cursorId: cursor?.id
    });
    console.warn('[HybridVerify] Raw Items Fetched:', rawItems.length);

    if (!rawItems.length) {
        return { items: [], errors: [], nextCursor };
    }

    // 3. Sort ASC for Sequential Processing
    // API returns DESC (Newest First). Reverse to process Oldest -> Newest.
    const sortedItems = [...rawItems].sort((a, b) => {
        return Number(a.counter) - Number(b.counter);
    });

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
                            fetchSecureMessageById: createNoOpFetcher(item)
                        });

                        if (bResult.ok && bResult.decrypted) {
                            console.warn(`[HybridVerify] Route B Success item ${item.id}. Retrying Route A to fetch content...`);

                            // Route B succeeded, so Key should be in Vault now.
                            // Retry Route A to get the formatted item.
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
                                console.warn(`[HybridVerify] Route B Success BUT Route A Retry Failed for item ${item.id}.`);
                                // This implies Vault Put failed or is lagging.
                                // We strictly fail here to avoid returning broken items.
                                result = { ok: false, reason: 'ROUTE_B_OK_BUT_VAULT_MISSING' };
                            }
                        } else {
                            console.warn(`[HybridVerify] Route B Failed item ${item.id}:`, bResult.reasonCode);
                            result = { ok: false, reason: bResult.reasonCode || 'ROUTE_B_FAIL' };
                        }
                    } catch (err) {
                        console.warn(`[HybridVerify] Route B Exception item ${item.id}:`, err);
                        result = { ok: false, reason: 'ROUTE_B_EXCEPTION' };
                    }
                }
            }

            if (result.ok && result.item) {
                decryptedItems.push(result.item);
            } else {
                const errorReason = result.reason || 'UNKNOWN_ERROR';

                // Filter out control messages that shouldn't be displayed
                if (errorReason === 'CONTROL_SKIP' || errorReason === 'CORRUPT_SKIP') {
                    // errors.push({ item, reason: errorReason }); // Optional: uncomment if debugging skips
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
                // Return placeholder so UI shows "Decryption Failed"
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
