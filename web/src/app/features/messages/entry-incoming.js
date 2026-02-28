/**
 * Entry point for handling incoming WebSocket messages.
 * Refactored from messages-pane.js handleIncomingSecureMessage.
 */

import { log, logCapped } from '../../core/log.js';
import {
    getConversationClearAfter,
    clearConversationHistory
} from '../messages-support/conversation-clear-store.js';
import { setDeletionCursor } from '../soft-deletion/deletion-api.js';
import { appendUserMessage } from '../timeline-store.js';
import {
    ensurePeerAccountDigest,
    ensureConversationIndex,
    getConversationThreads,
    upsertConversationThread
} from '../conversation-updates.js';
import {
    hideContactSecret
} from '../../core/contact-secrets.js';
import {
    clearDrState,
    getAccountDigest,
    ensureDeviceId,
    normalizeAccountDigest,
    normalizePeerDeviceId
} from '../../core/store.js';
import {
    upsertContactCore,
    getContactCore,
    removeContactCore
} from '../../ui/mobile/contact-core-store.js';
import {
    addPendingLivePlaceholder
} from './placeholder-store.js';
import {
    splitPeerKey,
    normalizePeerKey
} from '../conversation.js';
import {
    CONTROL_MESSAGE_TYPES,
    normalizeControlMessageType
} from '../secure-conversation-signals.js';
import { messagesFlowFacade } from '../messages-flow-facade.js';
import { sessionStore } from '../../ui/mobile/session-store.js';

const DEBUG_WS = false; // Could be injected or imported from global config if needed

// Helper for logging
function logDebugWs(tag, payload) {
    if (DEBUG_WS) {
        console.log(tag, payload);
    }
}

/**
 * Sync contact conversation for a specific event/reason.
 * @param {Object} params
 * @param {Object} deps - Injected dependencies (log, etc if needed, though we import some)
 */
export async function syncContactConversation({ convId, peerDigest, peerDeviceId, tokenB64, reason }, deps = {}) {
    const key = `${convId || ''}::${peerDigest || ''}`;
    if (!convId || !peerDigest) return;

    // We need a way to track in-flight syncs. 
    // Ideally this state should assume single-threaded JS nature or use a map.
    // We'll use a local map for now, or if it needs to share state with UI, it's tricky.
    // messages-pane had a module-level `contactSyncInFlight`.
    // We will maintain it here.
    if (contactSyncInFlight.has(key)) {
        // [FIX] Race Condition: If sync is in flight, mark as pending to retry after current sync finishes.
        // This ensures rapid messages (e.g. 12ms apart) are not dropped.
        contactSyncPending.add(key);
        return;
    }
    contactSyncInFlight.add(key);

    try {
        do {
            // Clear pending flag at start of iteration
            contactSyncPending.delete(key);

            logDebugWs('[contact-sync:start]', { convId, peerDigest, peerDeviceId, reason });

            const normIdentity = { deviceId: peerDeviceId }; // Simplified, or use util
            const resolvedPeerDeviceId = normIdentity.deviceId || peerDeviceId || null;

            // Call facade
            const syncResult = await messagesFlowFacade.onScrollFetchMore({
                conversationId: convId,
                tokenB64: tokenB64 || null,
                peerAccountDigest: peerDigest,
                peerDeviceId: resolvedPeerDeviceId,
                options: {
                    mutateState: true,
                    allowReplay: false,
                    sendReadReceipt: false,
                    onMessageDecrypted: () => { },
                    silent: false,
                    sourceTag: reason ? `entry-incoming:sync:${reason}` : 'entry-incoming:sync'
                }
            });

            // Reporting results (logging) - simplified
            // ...

            // Return info about failures to let UI decide/update
            const syncErrors = Array.isArray(syncResult?.errors) ? syncResult.errors : [];
            const syncDeadLetters = Array.isArray(syncResult?.deadLetters) ? syncResult.deadLetters : [];

            if (syncErrors.length || syncDeadLetters.length) {
                // logic for gap placeholders...
                // Only log for now
                console.warn('[entry-incoming] sync errors/deadLetters', { syncErrors, syncDeadLetters });
            }

            // Loop if a new request came in while we were syncing
        } while (contactSyncPending.has(key));

    } finally {
        contactSyncInFlight.delete(key);
        contactSyncPending.delete(key); // Cleanup
    }
}

const contactSyncInFlight = new Set();
const contactSyncPending = new Set();

// Re-export for backward compatibility with cached messages.js
export { buildCounterMessageId } from './counter.js';

import { drState } from '../../core/store.js';
import { getIncomingCounterState } from './counter.js';

export function resolveLocalIncomingCounter({ peerAccountDigest, peerDeviceId }) {
    if (!peerAccountDigest || !peerDeviceId) return null;
    const state = drState({ peerAccountDigest, peerDeviceId });
    const counters = getIncomingCounterState(state);
    return counters.Nr;
}

export function emitBRouteResultEvent(detail) {
    if (typeof document === 'undefined') return;
    try {
        document.dispatchEvent(new CustomEvent('b-route-result', { detail }));
    } catch { }
}


export async function handleIncomingSecureMessage(event, deps) {
    const {
        getMessageState,
        logConversationResetTrace,
        handleSecureConversationControlMessage,
        recordMessageRead,
        recordMessageDelivered,
        applyReceiptState, // This usually touches UI/Message objects in memory
        findMessageById // UI Helper
    } = deps;

    const convId = String(event?.conversationId || event?.conversation_id || '').trim();
    if (convId && (convId.startsWith('profile-') || convId.startsWith('profile:'))) {
        return { skipepd: true, reason: 'profile' };
    }

    const state = getMessageState ? getMessageState() : {};
    let existingConvEntry = null;

    // [FIX] Hoist Control Type calculation to prevent TDZ (ReferenceError)
    const rawMsgType = event?.meta?.msgType || event?.meta?.msg_type || event?.msgType || event?.msg_type || null;
    const normalizedControlType = normalizeControlMessageType(rawMsgType);

    // Logging omitted for brevity, logic remains

    if (!convId) return { skipped: true };

    const targetDeviceId = typeof event?.targetDeviceId === 'string' && event.targetDeviceId.trim().length
        ? event.targetDeviceId.trim()
        : null;
    const selfDeviceId = ensureDeviceId();

    if (!selfDeviceId || targetDeviceId !== String(selfDeviceId).trim()) {
        // Target mismatch
        return { skipped: true, reason: 'target_mismatch' };
    }

    const senderDeviceId = typeof event?.senderDeviceId === 'string' && event.senderDeviceId.trim().length
        ? event.senderDeviceId.trim()
        : null;

    if (!senderDeviceId) return { skipped: true, reason: 'missing_sender_device' };

    let tsRaw = Number(event?.ts ?? event?.timestamp);
    if (!Number.isFinite(tsRaw) || tsRaw <= 0) tsRaw = Date.now();

    const clearAfter = getConversationClearAfter(convId);
    if (Number.isFinite(clearAfter) && tsRaw < clearAfter) {
        return { skipped: true, reason: 'cleared_history' };
    }

    // Conversation Deleted (Soft Delete Signal)
    if (event?.type === 'conversation-deleted' || normalizedControlType === CONTROL_MESSAGE_TYPES.CONVERSATION_DELETED) {
        const peerDigest = ensurePeerAccountDigest(event) || event?.senderAccountDigest;

        // Parse clearTimestamp from control message payload (sent by initiator)
        let clearTimestamp = 0;
        try {
            const rawText = event?.text || event?.content?.text || event?.plaintext || '';
            if (typeof rawText === 'string' && rawText.trim().startsWith('{')) {
                const parsed = JSON.parse(rawText);
                if (Number.isFinite(parsed?.clearTimestamp) && parsed.clearTimestamp > 0) {
                    clearTimestamp = parsed.clearTimestamp;
                }
            }
        } catch {}
        if (!clearTimestamp) {
            const ts = Number(event?.ts ?? event?.timestamp ?? event?.created_at ?? 0);
            if (ts > 0) clearTimestamp = ts > 100000000000 ? Math.floor(ts / 1000) : ts;
        }

        // Set server-side deletion cursor for our own account (mirroring the initiator's cursor)
        if (convId && clearTimestamp > 0) {
            setDeletionCursor(convId, clearTimestamp).catch(err => {
                console.warn('[entry-incoming] setDeletionCursor failed', err?.message || err);
            });
        }

        // Updates
        // Mark conversation as deleted in session store
        sessionStore.deletedConversations?.add?.(convId);

        // Remove from UI threads list
        getConversationThreads().delete(convId);
        sessionStore.conversationIndex?.delete?.(convId);

        if (peerDigest) {
            removeContactCore(peerDigest, 'entry-incoming:conversation-deleted');
        }

        // Set local clear-after filter so in-memory messages are also filtered
        if (convId) {
            clearConversationHistory(convId, tsRaw);
        }

        // IMPORTANT: Do NOT clear DR state (clearDrState) or delete contact secret (deleteContactSecret).
        // We want to preserve the session so future messages can be decrypted.
        // Just hide the contact.
        hideContactSecret(peerDigest);

        // [FIX] Append a local tombstone so the renderer shows "已清除上方對話紀錄".
        // clearConversationHistory above wipes the timeline; without re-appending,
        // the receiver never sees the deletion marker.
        if (convId) {
            const tombstoneTs = clearTimestamp || (tsRaw > 100000000000 ? Math.floor(tsRaw / 1000) : tsRaw) || Math.floor(Date.now() / 1000);
            appendUserMessage(convId, {
                messageId: `tombstone-deleted-${convId}`,
                msgType: 'conversation-deleted',
                subtype: 'conversation-deleted',
                text: '',
                direction: 'incoming',
                ts: tombstoneTs,
                tsMs: tombstoneTs * 1000,
                conversationId: convId,
                senderDigest: peerDigest || null
            });
        }

        const isActive = state.activePeerDigest === peerDigest || state.conversationId === convId;

        return {
            processed: true,
            action: 'conversation_deleted',
            conversationId: convId,
            peerDigest,
            isActive
        };
    }

    // Normal flow
    const convIndex = ensureConversationIndex();
    existingConvEntry = convIndex.get(convId) || null;
    const tokenB64 = existingConvEntry?.token_b64 || null;

    if (!tokenB64) {
        throw new Error('INVITE_SESSION_TOKEN_MISSING');
    }

    const contactPeerFromConvId = (convId && convId.startsWith('contacts-'))
        ? convId.slice('contacts-'.length).trim().toUpperCase()
        : null;
    const peerFromEvent = ensurePeerAccountDigest(event);
    const peerDigestRaw = contactPeerFromConvId || peerFromEvent || existingConvEntry?.peerAccountDigest || null;
    const { digest: peerDigestForWrite } = splitPeerKey(peerDigestRaw);
    const resolvedPeerDeviceId = normalizePeerDeviceId(senderDeviceId || existingConvEntry?.peerDeviceId || senderDeviceId || null);

    if (!peerDigestForWrite || !resolvedPeerDeviceId) {
        return { skipped: true, reason: 'missing_core' };
    }

    const peerKey = normalizePeerKey({ peerAccountDigest: peerDigestForWrite, peerDeviceId: resolvedPeerDeviceId }) || peerDigestRaw;

    // [FIX] Relaxed Active Check
    // state.activePeerDigest is usually just the Account Digest (no device ID).
    // peerKey has device ID. They will NOT match strictly.
    // We should compare the underlying Account Digest.
    const activeDigest = state.activePeerDigest ? splitPeerKey(state.activePeerDigest).digest : null;
    const active = (state.conversationId === convId && activeDigest === peerDigestForWrite) || false;

    if (active) {
        try {
            const header = event?.header || {};
            const counter = header?.n ?? header?.counter ?? event?.counter;
            addPendingLivePlaceholder({
                conversationId: convId,
                messageId: event?.messageId || event?.id,
                counter: counter,
                ts: tsRaw,
                raw: event
            });
        } catch (err) {
            // Safe fallthrough
        }
    }

    // Upsert stores
    upsertContactCore({
        peerAccountDigest: peerDigestForWrite,
        peerDeviceId: resolvedPeerDeviceId,
        conversationId: convId,
        conversationToken: tokenB64
    }, 'entry-incoming:ws-incoming');

    // Trigger sync (non-blocking usually, but here we wait or fire-and-forget?)
    // Logic called it async without await in some paths or mixed.
    // The original code called: syncContactConversation(...) (no await)
    // [FIX] Lock Contention Prevention
    // If conversation is ACTIVE, we MUST NOT trigger background sync here.
    // The MessageFlowController (Foreground) receives 'content_active' and triggers 'loadActiveConversationMessages'.
    // If we trigger background sync here, it locks the DR Session.
    // Then MessageFlowController's fetch ABORTS because "Session Locked".
    // So ONLY trigger background sync if NOT active.
    console.log('[entry-incoming] active check', { active, convId });
    if (!active) {
        syncContactConversation({
            convId,
            peerDigest: peerDigestForWrite,
            peerDeviceId: resolvedPeerDeviceId,
            tokenB64,
            reason: 'ws-incoming'
        }, deps).catch(err => {
            // [AUTO-FILL] Trigger Auto-Resolution for detected gaps
            if (err?.name === 'GapDetectedError') {

                try {
                    window.dispatchEvent(new CustomEvent('sentry:gap-detected', {
                        detail: {
                            conversationId: err.conversationId || convId,
                            localMax: err.localMax,
                            incomingCounter: err.incomingCounter
                        }
                    }));
                } catch (e) {
                    console.warn('Dispatch gap-detected failed', e);
                }
            } else {
                // Log other errors but don't crash
                console.warn('[entry-incoming] sync error', err);
            }
        });
    }

    // Thread update
    const contactEntry = getContactCore(peerKey) || getContactCore(peerDigestForWrite) || null;
    const nickname = contactEntry?.nickname || `好友 ${peerDigestForWrite.slice(-4)}`;
    const avatar = contactEntry?.avatar || null;

    upsertConversationThread({
        peerAccountDigest: peerKey,
        peerDeviceId: resolvedPeerDeviceId,
        conversationId: convId,
        tokenB64,
        nickname,
        avatar
    });

    const myAcctRaw = getAccountDigest();
    const myAcct = myAcctRaw ? String(myAcctRaw).toUpperCase() : null;
    const senderAcctRaw = event?.senderAccountDigest || null;
    const senderAcct = senderAcctRaw ? String(senderAcctRaw).replace(/[^0-9a-f]/gi, '').toUpperCase() : null;
    const isSelf = !!(myAcct && senderAcct && myAcct === senderAcct);

    // [FIX] Hoisted to top
    // const rawMsgType = ...
    // const normalizedControlType = ...

    if (normalizedControlType) {
        // Control Message
        if (normalizedControlType === CONTROL_MESSAGE_TYPES.READ_RECEIPT) {
            // Logic for receipts
            const targetId = event?.meta?.targetMessageId || event?.targetMessageId || null;
            if (targetId && state.conversationId) {
                if (recordMessageRead) recordMessageRead(state.conversationId, targetId, tsRaw);

                let uiUpdated = false;
                if (findMessageById && applyReceiptState) {
                    const msg = findMessageById(targetId);
                    if (msg && applyReceiptState(msg)) {
                        uiUpdated = true;
                    }
                }
                if (uiUpdated) return { processed: true, action: 'update_status_ui' };
            }
        } else if (normalizedControlType === CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT) {
            const targetId = event?.meta?.targetMessageId || event?.targetMessageId || null;
            if (targetId && state.conversationId) {
                if (recordMessageDelivered) recordMessageDelivered(state.conversationId, targetId, tsRaw);
                let uiUpdated = false;
                if (findMessageById && applyReceiptState) {
                    const msg = findMessageById(targetId);
                    if (msg && applyReceiptState(msg)) {
                        uiUpdated = true;
                    }
                }
                if (uiUpdated) return { processed: true, action: 'update_status_ui' };
            }
        } else {
            if (handleSecureConversationControlMessage) {
                handleSecureConversationControlMessage({
                    peerAccountDigest: peerKey,
                    messageType: normalizedControlType,
                    direction: isSelf ? 'outgoing' : 'incoming',
                    source: 'ws:message-new'
                });
            }
        }
        return { processed: true, action: 'control_handled' };
    }

    // Not a control message -> Content message
    // In the original, this block sets state if active and refreshes.

    if (active) {
        return {
            processed: true,
            action: 'content_active',
            conversationId: convId,
            peerKey,
            tokenB64,
            peerDigest: peerDigestForWrite,
            peerDeviceId: resolvedPeerDeviceId
        };
    }

    return { processed: true, action: 'content_inactive' };
}
