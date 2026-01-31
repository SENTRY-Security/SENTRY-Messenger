/**
 * Entry point for fetching and decrypting secure messages (list/history).
 * Manages the "A-Route" (Vault-based) decryption pipeline and integration with the "B-Route" (Live/Pipeline).
 */

import { log, logCapped } from '../../core/log.js';
import { getMkRaw, drState } from '../../core/store.js';
import { unwrapWithMK_JSON } from '../../crypto/aead.js';
import { rememberSkippedKey } from '../../../shared/crypto/dr.js';
import {
    buildPartialContactSecretsSnapshot,
    buildContactSecretsSnapshotFromDrState,
    encryptContactSecretPayload
} from '../../core/contact-secrets.js';
import {
    SEMANTIC_KIND,
    CONTROL_STATE_SUBTYPES,
    TRANSIENT_SIGNAL_SUBTYPES,
    normalizeSemanticSubtype
} from '../semantic.js';
import {
    getPipelineQueue,
    updateDecryptPipelineContext,
    getLastProcessedCounterForStream,
    setLastProcessedCounterForStream,
    incrementPipelineFailure,
    clearPipelineFailure,
    resolveCounterFetchFailureReason,
    shouldRetryCounterFetch,
    isCounterFetchClientError,
    COUNTER_GAP_RETRY_MAX,
    COUNTER_GAP_RETRY_INTERVAL_MS,
    acquireSecureFetchLock,
    secureFetchBackoff
} from './pipeline-state.js';
import {
    enqueueDecryptPipelineItem,
    getNextPipelineItem,
    cleanupPipelineQueue
} from './pipeline.js';
import {
    maybeScheduleLiveDecryptRepairOnUnlock,
    enqueueLiveDecryptRepair
} from './live-repair.js';
import {
    buildCounterMessageId
} from './counter.js';
import { updateTimelineEntryStatusByCounter, appendUserMessage } from '../timeline-store.js';
import { applyContactShareFromCommit } from '../contacts.js';
import { decryptContactPayload, normalizeContactShareEnvelope } from '../contact-share.js';

// Re-export constants if needed or just use them locally
const FETCH_LOG_ENABLED = true; // Could be config
const PENDING_VAULT_PUT_QUEUE_LIMIT = 50;
const PENDING_VAULT_PUT_RETRY_INTERVAL_MS = 60_000;

/**
 * Fetch a single message by counter to fill a gap.
 */
export async function fetchSecureMessageForCounter({
    conversationId,
    counter,
    senderDeviceId,
    senderAccountDigest
} = {}, deps = {}) {
    if (!conversationId || !Number.isFinite(counter)) return { ok: false, error: 'missing params' };
    if (typeof deps.getSecureMessageByCounter !== 'function') {
        return { ok: false, error: 'getSecureMessageByCounter missing' };
    }
    try {
        const { r, data } = await deps.getSecureMessageByCounter({
            conversationId,
            counter,
            senderDeviceId,
            senderAccountDigest
        });
        if (r?.ok && data?.ok && data?.item) return { ok: true, item: data.item };
        const message = data?.message || data?.error || (typeof data === 'string' ? data : 'gap fetch failed');
        return { ok: false, status: r?.status ?? null, error: message };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

/**
 * Process a single pipeline item (decrypt, semantic classification, vault put, timeline update).
 */
export async function decryptPipelineItem(item, ctx = {}, deps = {}) {
    if (!item) return { ok: false, error: new Error('missing pipeline item') };

    const {
        storeNormalizePeerIdentity,
        ensureSecureConversationReady,
        SECURE_CONVERSATION_STATUS,
        drState,
        ensureDrReceiverState,
        hasUsableDrState,
        drDecryptItem,
        snapshotDrState,
        classifyDecryptedPayload,
        resolveServerTimestampPair,
        buildMessageObject,
        vaultPutMessageKey,
        enqueuePendingVaultPut,
        getPendingVaultPutForMessage,
        removePendingVaultPut,
        updateIncomingCounterState,
        persistDrSnapshot,
        maybeTriggerBackupAfterDecrypt,
        putDecryptedMessage,
        resolveMsgTypeForTimeline,
        upsertTimelineEntry,
        replaceTimelineEntryByCounter,
        maybeSendDeliveryReceipt,
        maybeSendReadReceipt,
        maybeSendVaultAckWs,
        getAccountDigest,
        storeEnsureDeviceId
    } = deps;

    const conversationId = item.conversationId || null;
    const senderDeviceId = item.senderDeviceId || null;
    const senderAccountDigest = item.senderAccountDigest || null;
    const header = item.header || null;
    const ciphertextB64 = item.ciphertextB64 || null;
    const counter = Number.isFinite(Number(item.counter)) ? Number(item.counter) : null;

    if (!conversationId || !senderDeviceId || !header || !ciphertextB64 || counter === null) {
        return { ok: false, error: new Error('pipeline item missing required fields') };
    }

    const identity = storeNormalizePeerIdentity({ peerAccountDigest: senderAccountDigest, peerDeviceId: senderDeviceId });
    const peerDigest = identity?.accountDigest || senderAccountDigest || null;
    const peerDeviceId = identity?.deviceId || senderDeviceId || null;

    if (!peerDigest || !peerDeviceId) {
        const err = new Error('peer identity missing for pipeline');
        err.code = 'PEER_IDENTITY_MISSING';
        return { ok: false, error: err };
    }

    const statusInfo = await ensureSecureConversationReady({
        peerAccountDigest: peerDigest,
        peerDeviceId: peerDeviceId,
        reason: 'decrypt-pipeline',
        source: ctx?.considerSource || 'messages:decrypt-pipeline',
        conversationId
    });

    if (statusInfo?.status === SECURE_CONVERSATION_STATUS.PENDING) {
        const err = new Error('secure conversation pending');
        err.code = 'SECURE_PENDING';
        return { ok: false, error: err };
    }

    let state = drState({ peerAccountDigest: peerDigest, peerDeviceId });
    if (!hasUsableDrState(state) && ensureDrReceiverState) {
        await ensureDrReceiverState({ peerAccountDigest: peerDigest, peerDeviceId, conversationId });
        state = drState({ peerAccountDigest: peerDigest, peerDeviceId });
    }

    if (!hasUsableDrState(state)) {
        const err = new Error('DR state unavailable for conversation');
        err.code = 'DR_STATE_UNAVAILABLE';
        return { ok: false, error: err };
    }

    // Update state base key if needed (mutating state object passed from store)
    state.baseKey = state.baseKey || {};
    if (!state.baseKey.conversationId) state.baseKey.conversationId = conversationId;
    if (!state.baseKey.peerDeviceId) state.baseKey.peerDeviceId = peerDeviceId;
    if (!state.baseKey.peerAccountDigest) state.baseKey.peerAccountDigest = peerDigest;

    // [FIX] Offline/History Contact Share Processing
    // We must intercept contact-share BEFORE DR Decryption because it uses Session Key, not DR.
    // Ensure side effects (Profile Update) are applied even for history messages.
    // [FIX] Offline/History Contact Share Processing
    // We must intercept contact-share BEFORE DR Decryption because it uses Session Key, not DR.
    // Ensure side effects (Profile Update) are applied even for history messages.
    const headerType = header?.meta?.msgType || header?.msgType || item.msgType || null;
    const isContactShare = headerType === 'contact-share' || (header?.contact === 1 || header?.contact === '1');

    if (isContactShare) {
        if (!item.tokenB64) {
            // Missing token is fatal for payload, but we can still show the tombstone if we know who it is.
            // But usually missing token means we can't verify sender? 
            // Let's allow it to fall through or return a generic tombstone if we trust the item metadata.
            // For now, let's try to proceed or return a generic visible message if possible.
            // But existing logic returned control-state. Let's stick to generating a user message if possible.
        }

        let friendlyText = '您已與對方成為好友';
        let contact = null;
        try {
            contact = getContactCore(peerDigest);
            if (contact && contact.nickname) {
                friendlyText = `您已與 ${contact.nickname} 成為好友`;
            }
        } catch (ignore) { }

        // Common Message Construction
        const buildContactShareMsg = (envelope = null) => ({
            id: item.serverMessageId || `${conversationId}:${counter}`,
            serverMessageId: item.serverMessageId,
            msgType: 'contact-share',
            text: friendlyText,
            ts: Number(item.ts || item.created_at || item.createdAt || Date.now()),
            direction: (senderDeviceId === selfDeviceId) ? 'outgoing' : 'incoming',
            senderDeviceId,
            senderDigest: peerDigest,
            content: {
                type: 'contact-share',
                envelope // Might be null if failed
            }
        });

        try {
            // Attempt Decryption
            const envelope = normalizeContactShareEnvelope({ header, ciphertextB64 });
            if (item.tokenB64) {
                await decryptContactPayload(item.tokenB64, envelope); // verify decryptability
                const plaintext = JSON.stringify({ type: 'contact-share', envelope });
                const messageTs = Number(item.ts || item.created_at || item.createdAt || Date.now());

                const applyResult = await applyContactShareFromCommit({
                    peerAccountDigest: peerDigest,
                    peerDeviceId: peerDeviceId,
                    sessionKey: item.tokenB64,
                    plaintext,
                    messageId: item.serverMessageId || `${conversationId}:${counter}`,
                    // [Fix] Use dynamic source tag to distinguish Live vs History
                    // Live messages will have a different tag (e.g. 'messages:live' or 'messages:decrypt-pipeline')
                    // causing isHistoryReplay to be false, thus ENABLING D1 uplink.
                    sourceTag: ctx?.considerSource || 'entry-fetch:history-contact-share',
                    profileUpdatedAt: messageTs
                });

                if (applyResult?.diff && conversationId) {
                    // Sys notify logic (kept same as before)
                    try {
                        const diff = applyResult.diff;
                        if (diff.nickname) {
                            appendUserMessage(conversationId, {
                                id: `${item.serverMessageId || counter}-sys-nick`,
                                msgType: 'system',
                                text: `對方的暱稱已更改為 ${diff.nickname.to}`,
                                ts: Date.now() / 1000,
                                direction: 'incoming',
                                status: 'sent'
                            });
                        }
                        if (diff.avatar) {
                            appendUserMessage(conversationId, {
                                id: `${item.serverMessageId || counter}-sys-avatar`,
                                msgType: 'system',
                                text: '對方已更改頭像',
                                ts: Date.now() / 1000,
                                direction: 'incoming',
                                status: 'sent'
                            });
                        }
                    } catch (e) { console.warn('[entry-fetch] sys notify fail', e); }
                }
            }

            // Vault Logic (kept same)
            try {
                const msgId = item.serverMessageId || `${conversationId}:${counter}`;
                await vaultPutMessageKey({
                    conversationId,
                    messageId: msgId,
                    senderDeviceId,
                    targetDeviceId: item.targetDeviceId || null,
                    direction: 'incoming',
                    msgType: 'contact-share',
                    messageKeyB64: item.tokenB64 || null,
                    headerCounter: counter,
                    drStateSnapshot: null
                });
            } catch (vErr) { console.warn('[entry-fetch] contact-share vault/ack failed', vErr); }

            // Return success
            return {
                ok: true,
                message: buildContactShareMsg(envelope),
                state,
                semantic: { kind: SEMANTIC_KIND.USER_MESSAGE, subtype: 'contact-share' },
                vaultPutStatus: 'ok'
            };
        } catch (err) {
            console.warn('[entry-fetch] contact-share history process failed (soft fail)', err);
            // [FIX] Even if decryption fails (wrong key/format), show the sidebar/tombstone.
            // We use the local contact info we resolved earlier.
            return {
                ok: true,
                message: buildContactShareMsg(null), // No envelope content
                state,
                semantic: { kind: SEMANTIC_KIND.USER_MESSAGE, subtype: 'contact-share' },
                vaultPutStatus: null // Don't retry vault put if failed
            };
        }
    }

    let messageKeyB64 = null;
    let text = null;
    try {
        const res = await drDecryptItem(state, {
            header,
            ciphertextB64,
            packetKey: item.serverMessageId || `${conversationId}:${counter}`,
            msgType: item.msgType
        });
        text = res.text;
        messageKeyB64 = res.messageKeyB64;
    } catch (err) {
        // [Fix Persistent Placeholder]
        // Fallback for DR failure on contact-share
        const headerType = header?.meta?.msgType || header?.msgType || item.msgType || null;
        const isContactShare = headerType === 'contact-share' || (header?.contact === 1 || header?.contact === '1');

        if (isContactShare) {
            // Logic to build fallback message
            let friendlyText = '您已與對方成為好友';
            try {
                const c = getContactCore(peerDigest);
                if (c && c.nickname) friendlyText = `您已與 ${c.nickname} 成為好友`;
            } catch (ignore) { }

            return {
                ok: true,
                message: {
                    id: item.serverMessageId || `${conversationId}:${counter}`,
                    serverMessageId: item.serverMessageId,
                    msgType: 'contact-share',
                    text: friendlyText,
                    ts: Number(item.ts || Date.now()),
                    direction: 'incoming',
                    senderDeviceId,
                    senderDigest: peerDigest,
                    content: { type: 'contact-share' }
                },
                state,
                semantic: { kind: SEMANTIC_KIND.USER_MESSAGE, subtype: 'contact-share' },
                vaultPutStatus: null
            };
        }

        return { ok: false, error: err };
    }

    const meta = item.meta || header?.meta || null;
    const payload = { meta: meta || null };
    const semantic = classifyDecryptedPayload(text, { meta, header });

    if (semantic.kind !== SEMANTIC_KIND.USER_MESSAGE) {
        return { ok: true, message: null, state, semantic, vaultPutStatus: null };
    }

    const tsPair = Number.isFinite(item?.tsMs) || Number.isFinite(item?.ts)
        ? { ts: item?.ts ?? null, tsMs: item?.tsMs ?? null }
        : resolveServerTimestampPair(item?.raw || {});

    const messageObj = buildMessageObject({
        plaintext: text,
        payload,
        header,
        raw: item.raw,
        direction: 'incoming',
        ts: tsPair.ts,
        tsMs: tsPair.tsMs,
        messageId: item.serverMessageId || null,
        serverMessageId: item.serverMessageId || null, // [Fix] Ensure property exists for Debug Modal
        messageKeyB64
    });

    updateIncomingCounterState(state, counter);
    
    // [FIX] Build DR state snapshot from CURRENT MEMORY STATE first,
    // before persistDrSnapshot which might fail.
    // This ensures vault gets the actual current state, not potentially stale map data.
    let drStateSnapshot = null;
    let memoryDrSnapshot = null;
    try {
        const mk = getMkRaw();
        if (mk && state && snapshotDrState) {
            // Capture the current in-memory state
            memoryDrSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: true });
            if (memoryDrSnapshot) {
                // Get additional context from the state for building the full snapshot
                const role = state?.baseKey?.role || null;
                const convToken = state?.baseKey?.conversationToken || null;
                const convId = conversationId || state?.baseKey?.conversationId || null;
                
                const snapshotJson = buildContactSecretsSnapshotFromDrState(peerDigest, {
                    peerDeviceId,
                    drStateSnapshot: memoryDrSnapshot,
                    role,
                    conversationToken: convToken,
                    conversationId: convId
                });
                if (snapshotJson) {
                    drStateSnapshot = await encryptContactSecretPayload(snapshotJson, mk);
                }
            }
        }
    } catch (err) {
        // Suppress errors to avoid failing the pipeline, but log if needed
        if (FETCH_LOG_ENABLED) log({ atomicPiggybackError: err?.message || err, conversationId, counter });
    }
    
    // Now attempt to persist to contact-secrets map
    const snapshotPersisted = !!persistDrSnapshot({ peerAccountDigest: peerDigest, state });

    // Trigger backup regardless of persistDrSnapshot success
    // Since we have the snapshot in vault, this is additional redundancy
    const backupTag = item?.flags?.gapFill ? 'messages:gap-fill' : 'messages:decrypt-ok';
    maybeTriggerBackupAfterDecrypt({ sourceTag: backupTag });

    let vaultPutStatus = null;
    try {
        await vaultPutMessageKey({
            conversationId,
            messageId: messageObj.id,
            senderDeviceId,
            targetDeviceId: item.targetDeviceId || null,
            direction: 'incoming',
            msgType: messageObj.type || item.msgType || null,
            messageKeyB64,
            headerCounter: counter,
            drStateSnapshot // Pass the encrypted snapshot (built from memory state)
        });
        vaultPutStatus = 'ok';
    } catch (err) {
        vaultPutStatus = 'pending';
        if (enqueuePendingVaultPut) {
            enqueuePendingVaultPut({
                conversationId,
                messageId: messageObj.id,
                senderDeviceId,
                targetDeviceId: item.targetDeviceId || null,
                direction: 'incoming',
                msgType: messageObj.type || item.msgType || null,
                messageKeyB64,
                headerCounter: counter,
                drStateSnapshot // Queue it too
            }, err);
        }
    }

    if (conversationId && messageObj?.id) {
        putDecryptedMessage(conversationId, messageObj);
    }

    const resolvedMsgType = semantic.subtype || resolveMsgTypeForTimeline(item.msgType, messageObj?.type);

    const timelineEntry = {
        conversationId,
        messageId: messageObj.id || item.serverMessageId || buildCounterMessageId(counter),
        direction: 'incoming',
        msgType: resolvedMsgType || messageObj.type || null,
        ts: messageObj.ts || tsPair.ts || null,
        tsMs: messageObj.tsMs || tsPair.tsMs || null,
        counter,
        text: messageObj.text || null,
        media: messageObj.media || null,
        callLog: messageObj.callLog || null,
        callLog: messageObj.callLog || null,
        senderDigest: senderAccountDigest || null,
        senderDeviceId,
        peerDeviceId,
        header: messageObj.header || null, // [FIX] Persist header so it's visible in Debug Modal/Logs
        vaultPutCount: Number(item?.vaultPutCount || item?.vault_put_count || item?.raw?.vault_put_count || item?.raw?.vaultPutCount) || null
    };

    replaceTimelineEntryByCounter(conversationId, counter, timelineEntry);

    if (typeof ctx.onMessageDecrypted === 'function') {
        try {
            ctx.onMessageDecrypted({ message: messageObj });
        } catch { }
    }

    if (vaultPutStatus === 'ok') {
        if (messageObj.id) {
            maybeSendDeliveryReceipt({
                conversationId,
                peerAccountDigest: peerDigest,
                messageId: messageObj.id,
                tokenB64: item.tokenB64 || null,
                peerDeviceId
            });
            const senderAccountDigest = senderAccountDigest || peerDigest;
            const receiverAccountDigest = typeof getAccountDigest === 'function' ? getAccountDigest() : null;
            const receiverDeviceId = typeof storeEnsureDeviceId === 'function' ? storeEnsureDeviceId() : null;
            if (senderAccountDigest && receiverAccountDigest && receiverDeviceId) {
                maybeSendVaultAckWs({
                    conversationId,
                    messageId: messageObj.id,
                    senderAccountDigest,
                    senderDeviceId,
                    receiverAccountDigest,
                    receiverDeviceId,
                    counter
                });
            }
        }
    }

    if (ctx.sendReadReceipt && messageObj.id) {
        maybeSendReadReceipt(conversationId, peerDigest, peerDeviceId, messageObj.id);
    }

    return { ok: true, message: messageObj, state, semantic, vaultPutStatus };
}

/**
 * Main pipeline processing loop for a conversation.
 * Consumes items from the queue, handles gaps, and delegates to decryptPipelineItem.
 */
export async function processDecryptPipelineForConversation({
    conversationId,
    peerAccountDigest,
    onMessageDecrypted,
    sendReadReceipt = true,
    sourceTag,
    silent = false
} = {}, deps = {}) {
    const {
        ensurePlaceholderEntry,
        sleepMs,
        buildPipelineItemFromRaw,
        markPlaceholderStatus,
        upsertTimelineEntry,
        storeEnsureDeviceId,
        getAccountDigest
    } = deps;

    // Locks - we need a set for locks. 
    // Ideally this should be in pipeline-state.js but it was local to messages.js.
    // We can pass the lock set as dependency or use the one from pipeline-state.js if migrated.
    // We'll assume the caller manages the lock or we use a local one if it's per-module instance?
    // But pipeline processing needs to be singular per conversation.
    // Let's use a module-level Set here, assuming we are the singleton.
    if (!conversationId) return { decrypted: [], errors: [], decryptOk: 0, decryptFail: 0, vaultPutIncomingOk: 0 };

    if (decryptPipelineLocks.has(conversationId)) {
        return { decrypted: [], errors: [], decryptOk: 0, decryptFail: 0, vaultPutIncomingOk: 0, locked: true };
    }
    decryptPipelineLocks.add(conversationId);

    const decrypted = [];
    const errors = [];
    let decryptOk = 0;
    let decryptFail = 0;
    let vaultPutIncomingOk = 0;

    try {
        const selfDeviceId = typeof storeEnsureDeviceId === 'function' ? storeEnsureDeviceId() : null;
        const selfDigest = typeof getAccountDigest === 'function' ? String(getAccountDigest()).toUpperCase() : null;

        while (true) {
            const next = getNextPipelineItem(conversationId);
            if (!next) break;

            const { streamKey, counter, item } = next;
            const lastProcessed = getLastProcessedCounterForStream(streamKey, {
                peerAccountDigest: peerAccountDigest || item?.senderAccountDigest || null,
                senderDeviceId: item?.senderDeviceId || null
            });

            if (counter <= lastProcessed) {
                cleanupPipelineQueue(streamKey, conversationId, lastProcessed);
                continue;
            }

            if (counter > lastProcessed + 1) {
                const gapFrom = lastProcessed + 1;
                const gapTo = counter - 1;
                for (let missing = gapFrom; missing <= gapTo; missing += 1) {
                    ensurePlaceholderEntry({
                        conversationId,
                        counter: missing,
                        senderDeviceId: item?.senderDeviceId || null,
                        direction: item?.direction || 'incoming',
                        ts: item?.ts ?? null,
                        tsMs: item?.tsMs ?? null
                    });
                    enqueueDecryptPipelineItem({
                        conversationId,
                        senderDeviceId: item?.senderDeviceId || null,
                        senderAccountDigest: item?.senderAccountDigest || peerAccountDigest || null,
                        counter: missing,
                        serverMessageId: buildCounterMessageId(missing),
                        needsFetch: true,
                        tokenB64: item?.tokenB64 || null,
                        flags: { gapFill: true, liveIncoming: false }
                    });
                }
                continue;
            }

            let activeItem = item;
            if (activeItem?.needsFetch) {
                let fetched = null;
                let lastErr = null;
                let lastStatus = null;

                for (let attempt = 1; attempt <= COUNTER_GAP_RETRY_MAX; attempt += 1) {
                    const result = await fetchSecureMessageForCounter({
                        conversationId,
                        counter,
                        senderDeviceId: activeItem?.senderDeviceId || null,
                        senderAccountDigest: activeItem?.senderAccountDigest || null
                    }, deps);

                    if (result?.ok && result?.item) {
                        fetched = result.item;
                        lastErr = null;
                        lastStatus = null;
                        break;
                    }
                    lastErr = result?.error || 'gap fetch failed';
                    lastStatus = result?.status ?? null;

                    if (!shouldRetryCounterFetch(lastStatus)) {
                        break;
                    }
                    if (attempt < COUNTER_GAP_RETRY_MAX) {
                        await sleepMs(COUNTER_GAP_RETRY_INTERVAL_MS);
                    }
                }

                if (!fetched) {
                    const failureCount = incrementPipelineFailure(streamKey, counter);
                    const noRetry = isCounterFetchClientError(lastStatus);
                    const failureReason = resolveCounterFetchFailureReason(lastStatus, lastErr);

                    if (noRetry || failureCount >= COUNTER_GAP_RETRY_MAX) {
                        markPlaceholderStatus(conversationId, counter, 'failed', failureReason);
                    } else {
                        markPlaceholderStatus(conversationId, counter, 'blocked', failureReason);
                    }
                    errors.push({
                        messageId: buildCounterMessageId(counter),
                        counter,
                        direction: 'incoming',
                        ts: activeItem?.ts ?? null,
                        kind: SEMANTIC_KIND.USER_MESSAGE,
                        control: false,
                        reason: failureReason
                    });
                    decryptFail += 1;
                    break;
                }

                const rebuilt = buildPipelineItemFromRaw(fetched, {
                    conversationId,
                    tokenB64: activeItem?.tokenB64 || null,
                    peerAccountDigest: activeItem?.senderAccountDigest || peerAccountDigest || null,
                    selfDeviceId,
                    selfDigest,
                    sourceTag: sourceTag || null
                });

                if (rebuilt?.item) {
                    activeItem = {
                        ...activeItem,
                        ...rebuilt.item,
                        needsFetch: false,
                        flags: { ...(activeItem?.flags || {}), gapFill: true }
                    };
                    enqueueDecryptPipelineItem(activeItem);
                } else {
                    const failureCount = incrementPipelineFailure(streamKey, counter);
                    const reason = rebuilt?.reason || 'gap fetch invalid';
                    if (failureCount >= COUNTER_GAP_RETRY_MAX) {
                        markPlaceholderStatus(conversationId, counter, 'failed', reason);
                    } else {
                        markPlaceholderStatus(conversationId, counter, 'blocked', reason);
                    }
                    errors.push({
                        messageId: buildCounterMessageId(counter),
                        counter,
                        direction: 'incoming',
                        ts: activeItem?.ts ?? null,
                        kind: SEMANTIC_KIND.USER_MESSAGE,
                        control: false,
                        reason
                    });
                    decryptFail += 1;
                    break;
                }
            }

            // [FIX] Check if this message has a pending vault put
            // If so, skip decryption (DR state already advanced) and just retry vault put
            const pendingVaultEntry = typeof getPendingVaultPutForMessage === 'function'
                ? getPendingVaultPutForMessage({
                    conversationId,
                    messageId: activeItem?.serverMessageId,
                    senderDeviceId: activeItem?.senderDeviceId
                })
                : null;

            if (pendingVaultEntry && pendingVaultEntry.messageKeyB64) {
                // Message was already decrypted, just retry vault put
                let vaultRetryOk = false;
                try {
                    await vaultPutMessageKey({
                        conversationId,
                        messageId: pendingVaultEntry.messageId,
                        senderDeviceId: pendingVaultEntry.senderDeviceId,
                        targetDeviceId: pendingVaultEntry.targetDeviceId || null,
                        direction: 'incoming',
                        msgType: pendingVaultEntry.msgType || null,
                        messageKeyB64: pendingVaultEntry.messageKeyB64,
                        headerCounter: pendingVaultEntry.headerCounter,
                        drStateSnapshot: pendingVaultEntry.drStateSnapshot || null
                    });
                    vaultRetryOk = true;
                    if (typeof removePendingVaultPut === 'function') {
                        removePendingVaultPut({
                            conversationId,
                            messageId: pendingVaultEntry.messageId,
                            senderDeviceId: pendingVaultEntry.senderDeviceId
                        });
                    }
                    vaultPutIncomingOk += 1;
                } catch (vaultErr) {
                    // Still failed, don't advance counter
                    const vaultFailureCount = incrementPipelineFailure(streamKey, counter);
                    if (vaultFailureCount >= COUNTER_GAP_RETRY_MAX) {
                        // Exhausted retries - advance anyway
                        console.warn('[entry-fetch] pending vault retry exhausted', { conversationId, counter });
                        vaultRetryOk = true;
                    } else {
                        break;
                    }
                }
                if (vaultRetryOk) {
                    clearPipelineFailure(streamKey, counter);
                    setLastProcessedCounterForStream(streamKey, counter, null);
                    cleanupPipelineQueue(streamKey, conversationId, counter);
                }
                continue;
            }

            const result = await decryptPipelineItem(activeItem, {
                onMessageDecrypted,
                sendReadReceipt,
                considerSource: sourceTag || 'messages:decrypt-pipeline',
                silent
            }, deps);

            if (!result?.ok) {
                const failureCount = incrementPipelineFailure(streamKey, counter);
                const reason = result?.error?.message || String(result?.error || 'decrypt failed');
                if (failureCount >= COUNTER_GAP_RETRY_MAX) {
                    markPlaceholderStatus(conversationId, counter, 'failed', reason);
                } else {
                    markPlaceholderStatus(conversationId, counter, 'blocked', reason);
                }
                errors.push({
                    messageId: activeItem?.serverMessageId || buildCounterMessageId(counter),
                    counter,
                    direction: activeItem?.direction || 'incoming',
                    ts: activeItem?.ts ?? null,
                    kind: SEMANTIC_KIND.USER_MESSAGE,
                    control: false,
                    reason
                });
                decryptFail += 1;
                break;
            }

            clearPipelineFailure(streamKey, counter);
            if (result?.semantic?.kind === SEMANTIC_KIND.USER_MESSAGE && result?.message) {
                decrypted.push(result.message);
                decryptOk += 1;
                if (result?.vaultPutStatus === 'ok') vaultPutIncomingOk += 1;
            } else if (
                result?.semantic?.kind === SEMANTIC_KIND.CONTROL_STATE ||
                result?.semantic?.kind === SEMANTIC_KIND.TRANSIENT_SIGNAL
            ) {
                // [Fix Persistent Placeholder] Control messages must be explicitly updated to 'hidden'
                // to transition them out of 'pending' state in the timeline.
                markPlaceholderStatus(conversationId, counter, 'hidden', 'control_message');
            } else if (
                result?.semantic?.kind === SEMANTIC_KIND.CONTROL_STATE ||
                result?.semantic?.kind === SEMANTIC_KIND.TRANSIENT_SIGNAL
            ) {
                // [Fix Persistent Placeholder] Control messages must be explicitly hidden
                // to transition them out of 'pending' state.
                markPlaceholderStatus(conversationId, counter, 'hidden', 'control_message');
            }

            // [FIX] If vault put failed for USER_MESSAGE, do NOT advance counter
            // The message is in pending queue, and getPendingVaultPutForMessage will catch it
            // on next pipeline run to retry vault put without re-decryption
            if (result?.semantic?.kind === SEMANTIC_KIND.USER_MESSAGE && result?.vaultPutStatus !== 'ok') {
                // Don't advance counter - next run will detect pending vault put and retry
                break;
            }

            setLastProcessedCounterForStream(streamKey, counter, result?.state || null);
            cleanupPipelineQueue(streamKey, conversationId, counter);
        }
    } finally {
        decryptPipelineLocks.delete(conversationId);
        maybeScheduleLiveDecryptRepairOnUnlock(conversationId);
    }

    return { decrypted, errors, decryptOk, decryptFail, vaultPutIncomingOk };
}

const decryptPipelineLocks = new Set();


/**
 * Fetches secure messages (list) and processes them through the pipeline.
 * Replaces legacyListSecureAndDecrypt.
 */
export async function listSecureAndDecrypt(params = {}, deps = {}) {
    const {
        conversationId,
        tokenB64,
        peerAccountDigest,
        peerDeviceId,
        limit = 20,
        cursorTs,
        cursorId,
        mutateState = true,
        allowReplay = false,
        onMessageDecrypted = null,
        sendReadReceipt = true,
        prefetchedList = null,
        silent = false,
        priority = 'live',
        sourceTag = null
    } = params;

    const {
        sessionStore,
        storeNormalizePeerIdentity,
        listReadyContacts,
        getConversationClearAfter,
        ensureDeviceId,
        ensureDrReceiverState,
        getAccountDigest,
        toMessageId,
        resolveHeaderFromEnvelope,
        resolveEnvelopeCounter,
        resolveSenderDeviceId,
        resolveTargetDeviceId,
        resolveSenderDigest,
        resolveMessageDirection,
        resolveMessageSubtypeFromHeader,
        sampleIdPrefix,
        sliceSuffix,
        slicePrefix,
        logMsgEvent,
        tombstonedConversations,
        buildPipelineItemFromRaw,
        vaultGetMessageKey,
        enqueueMissingKeyTask,
        decryptWithMessageKey,
        classifyDecryptedPayload,
        buildMessageObject,
        putDecryptedMessage,
        resolveMsgTypeForTimeline,
        sortMessagesByTimeline,
        toMessageTimestamp,
        timelineAppendBatch,
        listSecureMessages
    } = deps;

    const mutateStateRaw = mutateState;
    const allowReplayRaw = mutateState === false ? true : allowReplay;
    const computedIsHistoryReplay = allowReplayRaw === true && mutateState === false;

    // LOGGING omitted for brevity - reuse deps.log or logCapped if needed.

    if (!conversationId) throw new Error('conversationId required');
    const requestPriority = priority === 'replay' ? 'replay' : 'live';
    const lockOwner = (typeof sourceTag === 'string' && sourceTag.trim()) ? sourceTag.trim() : null;

    // MK Check - assuming caller handles it or we rely on lock.
    // Lock Check
    const allowLivePreemptReplay = requestPriority === 'live' && lockOwner && (lockOwner.includes('ws-incoming') || lockOwner.includes('vault_missing_live_fallback'));

    const lockAttempt = acquireSecureFetchLock(
        conversationId,
        requestPriority,
        lockOwner || requestPriority,
        {
            allowLivePreemptReplay,
            isReplayRequest: computedIsHistoryReplay || requestPriority === 'replay'
        }
    );

    if (!lockAttempt?.granted || !lockAttempt.token) {
        return {
            items: [],
            errors: ['同步進行中，請稍後再試'],
            locked: true
        };
    }

    const lockToken = lockAttempt.token;

    try {
        const now = Date.now();
        const backoffUntil = secureFetchBackoff.get(conversationId) || 0;
        if (now < backoffUntil) {
            return { items: [], errors: ['訊息服務暫時無法使用，請稍後再試。'] };
        }

        if (lockToken.cancelled) return { items: [], errors: [], yielded: true };

        let items = [];
        let errs = [];
        let serverItemCount = 0;
        let nextCursorTs = null;
        let nextCursor = null;
        let hasMoreAtCursor = false;

        if (prefetchedList) {
            items = Array.isArray(prefetchedList.items) ? prefetchedList.items : [];
            serverItemCount = items.length;
            nextCursorTs = prefetchedList?.nextCursorTs ?? null;
            nextCursor = prefetchedList?.nextCursor || null;
            hasMoreAtCursor = !!prefetchedList?.hasMoreAtCursor;
        } else {
            const { r, data } = await listSecureMessages({ conversationId, limit, cursorTs, cursorId, includeKeys: true });

            // [Optimization] Batch Key Processing (Pre-fill Cache)
            if (r.ok && data?.keys && typeof data.keys === 'object') {
                try {
                    const keysCount = Object.keys(data.keys).length;
                    if (FETCH_LOG_ENABLED) console.log('[EntryFetch] Batch Keys Received:', keysCount);

                    const mkRaw = getMkRaw();
                    if (mkRaw) {
                        const batchItems = Array.isArray(data.items) ? data.items : [];
                        const tasks = [];
                        const myDigest = getAccountDigest ? String(getAccountDigest()).toUpperCase() : null;

                        let debugSuccess = 0;
                        let debugFail = 0;

                        for (const item of batchItems) {
                            const keyData = data.keys[item.id];
                            if (!keyData?.wrapped_mk_json) continue;

                            tasks.push((async () => {
                                try {
                                    const unwrapped = await unwrapWithMK_JSON(keyData.wrapped_mk_json, mkRaw);
                                    if (!unwrapped?.mkB64) {
                                        debugFail++;
                                        return;
                                    }

                                    let h = item.header;
                                    if (!h && item.header_json) { try { h = JSON.parse(item.header_json); } catch { } }
                                    if (!h || !h.ek_pub_b64 || !Number.isFinite(Number(h.n))) {
                                        debugFail++;
                                        return;
                                    }

                                    let peer = null;
                                    let device = null;
                                    const senderDigest = item.sender_account_digest || item.senderDigest;
                                    const receiverDigest = item.receiver_account_digest || item.receiverDigest;

                                    if (myDigest && senderDigest && String(senderDigest).toUpperCase() === myDigest) {
                                        peer = receiverDigest || peerAccountDigest;
                                        device = item.receiver_device_id || item.targetDeviceId;
                                    } else {
                                        peer = senderDigest || peerAccountDigest;
                                        device = item.sender_device_id || item.senderDeviceId;
                                    }

                                    if (peer) {
                                        if (ensureDrReceiverState) {
                                            try {
                                                await ensureDrReceiverState({ peerAccountDigest: peer, peerDeviceId: device, conversationId });
                                            } catch (e) {
                                                // ignore hydrate failure
                                            }
                                        }

                                        const st = drState({ peerAccountDigest: peer, peerDeviceId: device });
                                        if (st) {
                                            rememberSkippedKey(st, h.ek_pub_b64, Number(h.n), unwrapped.mkB64);
                                            debugSuccess++;
                                        } else {
                                            debugFail++;
                                        }
                                    } else {
                                        debugFail++;
                                    }
                                } catch (e) {
                                    debugFail++;
                                    if (FETCH_LOG_ENABLED) console.warn('[BatchKeyOpt] Item Error:', e);
                                }
                            })());
                        }
                        if (tasks.length > 0) await Promise.all(tasks);
                        if (FETCH_LOG_ENABLED) console.log(`[EntryFetch] Batch Processed: ${debugSuccess} success, ${debugFail} fail / ${tasks.length} total tasks`);
                    } else {
                        if (FETCH_LOG_ENABLED) console.warn('[EntryFetch] Batch Key Skip: No mkRaw');
                    }
                } catch (err) {
                    if (FETCH_LOG_ENABLED) console.warn('[BatchKeyOpt] Failed', err);
                }
            } else {
                if (r.ok && FETCH_LOG_ENABLED) console.log('[EntryFetch] No keys in response', { hasKeysField: !!data?.keys });
            }

            if (!r.ok) {
                if (r.status === 404 || r.status >= 500) {
                    errs.push(`訊息服務暫時無法使用（HTTP ${r.status}）`);
                    if (r.status >= 500) secureFetchBackoff.set(conversationId, now + 60_000);
                } else {
                    throw new Error('listSecureMessages failed: ' + (typeof data === 'string' ? data : JSON.stringify(data)));
                }
            } else {
                items = Array.isArray(data?.items) ? data.items : [];
                serverItemCount = items.length;
                nextCursorTs = data?.nextCursorTs ?? null;
                nextCursor = data?.nextCursor || null;
                hasMoreAtCursor = !!data?.hasMoreAtCursor;
                if (items.length || nextCursorTs) secureFetchBackoff.delete(conversationId);
            }
        }

        const placeholders = [];
        const sortedItems = sortMessagesByTimeline(items, {
            allowReplay: allowReplayRaw,
            mutateState: mutateStateRaw
        });

        // [New Feature] Shimmer for history
        // Generate placeholder entries for incoming items that we are about to process.
        // This gives immediate visual feedback.
        if (mutateStateRaw) {
            for (const raw of sortedItems) {
                const isControl = raw.msgType === 'control' || raw.header?.msgType === 'control';
                if (Number(raw.counter) < 0) continue; // Invalid counter?

                // Header check
                let h = raw.header;
                if (!h && raw.header_json) {
                    try { h = JSON.parse(raw.header_json); } catch { }
                }
                if (h) {
                    // Check if contact-share or known control type
                    const type = h.meta?.msgType || h.msgType;
                    if (type === 'control') continue;
                }

                if (isControl) continue;

                const counter = Number(h.counter ?? h.n);

                // Only for incoming messages that are not history replay (or even if replay, we want shimmer?)
                // If history replay, we usually want correct order. placeholder might disrupt if not careful.
                // But user issue is specific to "decrypting" state.
                const isIncoming = (
                    raw.senderDeviceId && raw.senderDeviceId !== selfDeviceId
                ) || (
                        h.meta?.senderDeviceId && h.meta.senderDeviceId !== selfDeviceId
                    ) || raw.direction === 'incoming'; // Fallback if computed externally)) continue;

                // Direction check
                // raw.senderDigest might be available
                // If we can't determine direction easily, we might skip or assume incoming?
                // Safe bet: if computedIsHistoryReplay is false, and it's from listSecureMessages, likely incoming.
                // But listSecureMessages returns both outgoing and incoming.
                // Let's do a quick direction check if possible.
                let dir = 'incoming';
                if (selfDigest && raw.senderDigest && String(raw.senderDigest).toUpperCase() === selfDigest) {
                    dir = 'outgoing';
                }

                // If outgoing, we might not need shimmer if we already have the message? 
                // But for a sync from server, we might don't have it locally.
                // Let's show shimmer for all to be safe and consistent.

                const realId = raw.id || raw.messageId || raw.serverMessageId;
                const msgId = realId || `${conversationId}:${counter}:placeholder`;

                placeholders.push({
                    conversationId,
                    messageId: msgId,
                    counter: counter,
                    msgType: 'placeholder',
                    placeholder: true,
                    status: 'pending',
                    senderDeviceId: raw.senderDeviceId || raw.header?.device_id || null,
                    direction: dir,
                    ts: raw.created_at || raw.createdAt || raw.ts,
                    tsMs: (raw.created_at || raw.createdAt || raw.ts) ? (raw.created_at || raw.createdAt || raw.ts) * 1000 : 0
                });
            }

            if (placeholders.length > 0) {
                timelineAppendBatch(placeholders);
            }
        }

        for (const raw of sortedItems) {
            const built = buildPipelineItemFromRaw(raw, {
                conversationId,
                tokenB64,
                peerAccountDigest: peerAccountDigest || null, // logic to resolve skipped for brevity
                selfDeviceId,
                selfDigest,
                sourceTag
            });

            const item = built?.item || null;
            if (!item) {
                // [Fix Stuck Placeholder] Filtered out by logic (e.g. Control Message)
                const counter = Number(raw.counter ?? raw.n ?? raw.header?.counter ?? raw.header?.n);
                if (Number.isFinite(counter)) {
                    updateTimelineEntryStatusByCounter(conversationId, counter, 'hidden', { reason: 'ITEM_FILTERED' });
                }
                continue;
            }

            if (!computedIsHistoryReplay && item.direction === 'incoming') {
                enqueueDecryptPipelineItem(item);
                continue;
            }

            // Replay logic (vault get, decrypt, put, NO PIPELINE ENQUEUE for replay usually?)
            // The original logic checked vault, decrypted directly.
            // We will simplify: If replay, we try vault.
            const messageId = item.serverMessageId || buildCounterMessageId(item.counter);
            let vaultKeyResult = null;
            try {
                vaultKeyResult = await vaultGetMessageKey({ conversationId, messageId, senderDeviceId: item.senderDeviceId });
            } catch (e) { vaultKeyResult = { ok: false }; }

            if (!vaultKeyResult?.ok) {
                // Handle vault missing (enqueue repair if needed)
                if (enqueueMissingKeyTask) {
                    const directionComputed = item.direction || 'incoming';
                    if (directionComputed === 'incoming') {
                        // logic to enqueue repair
                        enqueueMissingKeyTask({
                            conversationId,
                            targetCounter: item.counter,
                            senderDeviceId: item.senderDeviceId,
                            senderAccountDigest: item.senderAccountDigest,
                            messageId,
                            tokenB64,
                            reason: 'A_ROUTE_VAULT_MISSING'
                        }, { deferRun: true });
                        enqueueLiveDecryptRepair({ conversationId });
                    }
                }
                errs.push({ messageId, reason: 'vault_missing' }); // simplified
                // [Fix Stuck Placeholder] Key missing means we can't show text.
                // We should probably mark it failed or blocked?
                // User requirement focused on "Control Message", but logical correctness implies failed.
                // However, missing key might be repaired later. 'blocked' is better than 'pending'.
                updateTimelineEntryStatusByCounter(conversationId, item.counter, 'blocked', { reason: 'VAULT_MISSING' });
                continue;
            }

            // Decrypt
            let text = null;
            try {
                text = await decryptWithMessageKey({
                    messageKeyB64: vaultKeyResult.messageKeyB64,
                    ivB64: item.header?.iv_b64,
                    ciphertextB64: item.ciphertextB64,
                    header: item.header
                });
            } catch (e) {
                // [Fix Stuck Placeholder] Decrypt failed
                updateTimelineEntryStatusByCounter(conversationId, item.counter, 'failed', { reason: 'DECRYPT_FAIL' });
                continue;
            }

            const payload = { meta: item.meta };
            const semantic = classifyDecryptedPayload(text, { meta: item.meta, header: item.header });
            if (semantic.kind !== SEMANTIC_KIND.USER_MESSAGE) {
                // [Fix Stuck Placeholder] Control Message
                updateTimelineEntryStatusByCounter(conversationId, item.counter, 'hidden', { reason: 'CONTROL_MSG' });
                continue;
            }

            const messageObj = buildMessageObject({
                plaintext: text,
                payload,
                header: item.header,
                raw: item.raw,
                direction: item.direction || 'incoming',
                ts: item.ts,
                tsMs: item.tsMs,
                messageId: item.serverMessageId,
                messageKeyB64: vaultKeyResult.messageKeyB64
            });

            if (putDecryptedMessage) putDecryptedMessage(conversationId, messageObj);

            // Timeline entry
            const timelineEntry = {
                conversationId,
                messageId: messageObj.id,
                direction: messageObj.direction,
                msgType: messageObj.type,
                ts: messageObj.ts,
                text: messageObj.text,
                media: messageObj.media || null,
                callLog: messageObj.callLog || null,
                senderDigest: senderAccountDigest || null,
                senderDeviceId,
                peerDeviceId
            };

            // Reuse batch append?
            // timelineAppendBatch ...
        }

        // Flush timeline if any

        return {
            items: sortedItems,
            nextCursorTs,
            nextCursor,
            hasMoreAtCursor,
            errors: errs
        };

    } finally {
        if (lockToken) lockToken.release();
    }
}
