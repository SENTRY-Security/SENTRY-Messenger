/**
 * MessageFlowController
 * Facade controller for message loading and timeline operations.
 * 
 * This controller provides a clean interface for message flow operations.
 * Due to deep coupling with closure state in messages-pane.js, the actual
 * implementations are injected via deps rather than being fully extracted.
 */

import { BaseController } from './base-controller.js';
import { isDrSessionLocked } from '../../../features/dr-session.js';
import {
    sortMessagesByTimelineLocal,
    latestKeyFromTimeline,
    latestKeyFromRaw,
    latestKeysEqual,
    collectTimelineIdSet
} from '../../../features/messages/ui/timeline-handler.js';
import {
    MessageRenderer,
    buildRenderEntries,
    computeStatusVisibility
} from '../../../features/messages/ui/renderer.js';
import {
    getReplayPlaceholderEntries,
    getGapPlaceholderEntries,
    getPendingLivePlaceholderEntries
} from '../../../features/messages/placeholder-store.js?v=fix_placeholder';
import {
    normalizeTimelineMessageId,
    sliceConversationIdPrefix
} from '../../../features/messages/parser.js';
import {
    scrollToBottomSoon,
    captureScrollAnchor,
    restoreScrollFromAnchor,
    updateScrollOverflow
} from '../../../features/messages/ui/interactions.js';
import { getTimeline as timelineGetTimeline, appendBatch } from '../../../features/timeline-store.js';
import { getAccountDigest, normalizeAccountDigest } from '../../../core/store.js';
import { log, logCapped } from '../../../core/log.js';
import {
    formatTimestamp,
    isUserTimelineMessage,
    resolveRenderEntryCounter,
    resolveLatestOutgoingMessage
} from '../../../features/messages/ui/renderer.js';
import {
    consumeReplayPlaceholderBatch,
    consumePendingLivePlaceholderBatch,
    invalidateGapPlaceholderState,
    markGapPlaceholderFailures
} from '../../../features/messages/placeholder-store.js';
import { buildConversationSnippet, shouldNotifyForMessage, escapeHtml } from '../ui-utils.js';
import { messagesFlowFacade } from '../../../features/messages-flow-facade.js';
import { recordMessageRead, recordMessageDelivered } from '../../../features/messages-support/receipt-store.js';
import { handleSecureConversationControlMessage } from '../../../features/secure-conversation-manager.js';
import { recordVaultAckCounter } from '../../../features/messages-support/vault-ack-store.js';
import { normalizePeerIdentity } from '../../../core/store.js';
import { normalizeCounterValue, resolvePlaceholderSubtype } from '../../../features/messages/parser.js';
import { CONTROL_STATE_SUBTYPES, TRANSIENT_SIGNAL_SUBTYPES } from '../../../features/semantic.js';
import { DEBUG } from '../debug-flags.js';

export class MessageFlowController extends BaseController {
    constructor(deps) {
        super(deps);
        this.pendingWsRefresh = 0;
        this.receiptRenderPending = false;

        // [AUTO-FILL] Bind Gap Detection Event
        // Decoupled from entry-incoming.js via window event
        this.handleBodyGapDetected = (e) => {
            if (e && e.detail) {
                this.resolveGap(e.detail.conversationId, e.detail.localMax, e.detail.incomingCounter);
            }
        };
        window.addEventListener('sentry:gap-detected', this.handleBodyGapDetected);
    }

    /**
     * Check if near bottom of messages scroll.
     */
    isNearMessagesBottom(threshold = 32) {
        const scrollEl = this.elements.scrollEl;
        if (!scrollEl) return true;
        const distFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        return distFromBottom <= threshold;
    }

    /**
     * Set new message hint visibility.
     */
    setNewMessageHint(active) {
        const el = this.elements.newMessageHint;
        if (!el) return;
        if (active) {
            el.classList.remove('hidden');
            el.setAttribute('aria-hidden', 'false');
        } else {
            el.classList.add('hidden');
            el.setAttribute('aria-hidden', 'true');
        }
    }

    /**
     * Update load more button state.
     */
    setLoadMoreState(next) {
        if (!this.elements.loadMoreBtn) return;
        if (this._loadMoreState === next) return;
        this._loadMoreState = next;

        if (next === 'hidden') {
            this.elements.loadMoreBtn.classList.add('hidden');
            this.elements.loadMoreBtn.classList.remove('loading');
            if (this.elements.loadMoreLabel) this.elements.loadMoreLabel.textContent = '載入更多';
            return;
        }

        this.elements.loadMoreBtn.classList.remove('hidden');
        if (next === 'loading') {
            this.elements.loadMoreBtn.classList.add('loading');
            if (this.elements.loadMoreLabel) this.elements.loadMoreLabel.textContent = '載入中…';
        } else if (next === 'armed') {
            this.elements.loadMoreBtn.classList.remove('loading');
            if (this.elements.loadMoreLabel) this.elements.loadMoreLabel.textContent = '載入更多';
        }
    }

    /**
     * Check if entry is control banner.
     */
    _isControlBannerEntry(entry) {
        if (!entry) return true;
        if (entry.kind === 'USER_MESSAGE') return false; // Basic check, assuming SEMANTIC_KIND.USER_MESSAGE const content
        if (entry.kind) return true;
        if (entry.control === true) return true;
        return true;
    }

    /**
     * Find message by ID (active state).
     */
    _findMessageById(id) {
        const state = this.getMessageState();
        return state.messages.find((msg) => msg.id === id) || null;
    }

    /**
     * Find message by ID (active or timeline).
     */
    _findAnyMessageById(conversationId, messageId) {
        if (!conversationId) return null;
        let msg = this._findMessageById(messageId);
        if (msg) return msg;
        const timeline = timelineGetTimeline(conversationId);
        return timeline.find((m) => normalizeTimelineMessageId(m) === messageId) || null;
    }

    /**
     * Sync contact conversation logic.
     */
    async syncContactConversation({ convId, peerDigest, peerDeviceId, tokenB64, reason }) {
        const key = `${convId || ''}::${peerDigest || ''}`;
        if (!convId || !peerDigest) return;

        if (!this.contactSyncInFlight) this.contactSyncInFlight = new Set();
        if (this.contactSyncInFlight.has(key)) {
            try { log({ contactSyncSkip: { convId, peerDigest, reason: reason || null, cause: 'in-flight' } }); } catch { }
            return;
        }
        this.contactSyncInFlight.add(key);

        try {
            if (DEBUG.ws) {
                console.log('[contact-sync:start]', { convId, peerDigest, peerDeviceId, reason: reason || null });
            }
            const normIdentity = normalizePeerIdentity({ peerAccountDigest: peerDigest, peerDeviceId: peerDeviceId });
            const resolvedPeerDeviceId = normIdentity.deviceId || peerDeviceId || null;

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
                    sourceTag: reason
                        ? `messages-pane:syncContactConversation:${reason}`
                        : 'messages-pane:syncContactConversation'
                }
            });

            const syncErrors = Array.isArray(syncResult?.errors) ? syncResult.errors : [];
            const syncDeadLetters = Array.isArray(syncResult?.deadLetters) ? syncResult.deadLetters : [];
            const placeholderFailures = syncErrors.concat(syncDeadLetters).filter((entry) => !this._isControlBannerEntry(entry));

            if (placeholderFailures.length) {
                const failureResult = markGapPlaceholderFailures(convId, placeholderFailures);
                if ((failureResult?.updated || 0) > 0 || (failureResult?.added || 0) > 0) {
                    const state = this.getMessageState();
                    if (state.conversationId === convId) {
                        this.updateMessagesUI({ preserveScroll: true, forceFullRender: true });
                    }
                }
            }
            if (DEBUG.ws) {
                console.log('[contact-sync:done]', { convId, peerDigest, reason: reason || null });
            }
        } catch (err) {
            log({ contactSyncError: err?.message || err, convId, peerDigest, reason: reason || null });
        } finally {
            this.contactSyncInFlight.delete(key);
        }
    }

    /**
     * Handle incoming secure message.
     */
    async handleIncomingSecureMessage(event) {
        try {
            const deps = {
                getMessageState: () => this.getMessageState(),
                // Simplified logging trace
                logConversationResetTrace: (p) => log({ conversationResetTrace: p }),
                handleSecureConversationControlMessage,
                recordMessageRead,
                recordMessageDelivered,
                applyReceiptState: (msg) => this.deps.controllers?.messageStatus?.applyReceiptState(msg),
                findMessageById: (id) => this._findMessageById(id)
            };

            const { handleIncomingSecureMessage: processIncoming } = await import('../../../features/messages/entry-incoming.js');
            const result = await processIncoming(event, deps);

            if (result?.skipped) return;

            if (result?.action === 'conversation_deleted') {
                if (result.isActive) {
                    // Do NOT clear messages. 
                    // Let updateMessagesUI handled the hard-cutoff rendering.
                    // Just force a UI update.
                    this.updateMessagesUI({ forceFullRender: true });
                }
                this.deps.controllers?.conversationList?.syncFromContacts();
                this.deps.refreshContactsUnreadBadges?.();
                this.deps.renderConversationList?.();
                return;
            }

            if (result?.action === 'update_status_ui') {
                this.updateMessagesUI({ preserveScroll: true, forceFullRender: true });
                return;
            }

            if (result?.action === 'content_active') {
                const state = this.getMessageState();
                if (!state.conversationId && result.conversationId) state.conversationId = result.conversationId;
                if (!state.conversationToken && result.tokenB64) state.conversationToken = result.tokenB64;
                if (!state.activePeerDigest && result.peerDigest) state.activePeerDigest = result.peerDigest;
                if (result.peerDeviceId && !state.activePeerDeviceId) state.activePeerDeviceId = result.peerDeviceId;

                this.pendingWsRefresh = (this.pendingWsRefresh || 0) + 1;
                if (!state.loading) {
                    this.pendingWsRefresh = 0;
                    this.loadActiveConversationMessages({ append: false })
                        .then(() => scrollToBottomSoon(this.elements.scrollEl))
                        .catch((err) => log({ wsMessageSyncError: err?.message || err }))
                        .finally(() => { this.pendingWsRefresh = 0; });
                }
            }

        } catch (err) {
            const errMsg = err?.message || String(err);
            if (err?.code === 'INVITE_SESSION_TOKEN_MISSING' || errMsg === 'INVITE_SESSION_TOKEN_MISSING') {
                logCapped('inviteSessionTokenMissingDropped', { error: errMsg }, 5);
                return;
            }

            // [FIX] Gap Recovery Trigger
            // If Live Flow aborted due to a detected gap (Fail-Close), we must trigger a fetch immediately
            // to fill the gap/history, instead of waiting for the user to re-enter.
            if (errMsg.includes('Gap detected')) {
                console.warn('[MessageFlow] Gap detected in Live Flow. Triggering immediate history fetch/healing...');
                log('gapDetectedTriggeringFetch', { convId: this.getMessageState().conversationId });

                // Debounce/Throttle might be good here, but for now immediate recovery is prioritized.
                // We restart the load cycle which uses Smart Fetch to heal the gap.
                this.loadActiveConversationMessages({ append: false }).catch(e => console.error('[GapRecovery] Failed', e));
                return;
            }

            console.error('[secure-message] handler error', err);
            log({ secureMessageHandlerError: { error: errMsg } });
        }
    }

    /**
     * Handle vault ack event.
     */
    handleVaultAckEvent(event) {
        const convId = String(event?.conversationId || event?.conversation_id || '').trim();
        const messageId = String(event?.messageId || event?.message_id || '').trim();
        if (!convId) return;

        let tsRaw = Number(event?.ts ?? event?.timestamp);
        if (Number.isFinite(tsRaw) && tsRaw > 10_000_000_000) {
            tsRaw = Math.floor(tsRaw / 1000);
        }
        if (!Number.isFinite(tsRaw) || tsRaw <= 0) tsRaw = Date.now();

        let ackCounter = normalizeCounterValue(event?.counter ?? event?.headerCounter ?? event?.header_counter);
        const localMessage = messageId ? this._findAnyMessageById(convId, messageId) : null;

        if (ackCounter === null && localMessage) {
            ackCounter = resolveRenderEntryCounter(localMessage);
        }
        if (!Number.isFinite(ackCounter)) return;

        if (localMessage && !Number.isFinite(resolveRenderEntryCounter(localMessage))) {
            localMessage.counter = ackCounter;
        }

        recordVaultAckCounter(convId, ackCounter, tsRaw);
        logCapped('vaultAckWsRecvTrace', {
            conversationId: convId || null,
            messageId: messageId || null,
            counter: ackCounter
        }, 5);

        const state = this.getMessageState();
        if (state.conversationId !== convId) return;

        let selfDigest = null;
        try { selfDigest = normalizeAccountDigest(getAccountDigest()); } catch { }
        const latestOutgoing = resolveLatestOutgoingMessage(timelineGetTimeline(convId), selfDigest);

        if (latestOutgoing && this.deps.controllers?.messageStatus?.applyReceiptState(latestOutgoing)) {
            this.updateMessagesUI({ preserveScroll: true, forceFullRender: true });
        }
    }

    /**
     * Handle message decrypted event.
     */
    handleMessageDecrypted({ message, allowReceipts = true } = {}) {
        if (!message) return;
        if (message.direction === 'incoming') {
            if (allowReceipts) {
                this.deps.controllers?.messageStatus?.sendReadReceiptForMessage(message);
            }
            // [FIX] Update UI to show decrypted content
            this.updateMessagesUI({ preserveScroll: true });
        } else if (message.direction === 'outgoing') {
            if (this.deps.controllers?.messageStatus?.applyReceiptState(message)) {
                this.receiptRenderPending = true;
            }
        }
    }

    /**
     * Update load more button visibility based on state.
     */
    updateLoadMoreVisibility() {
        const state = this.getMessageState();
        if (state.hasMore && state.nextCursor) {
            this.setLoadMoreState('armed');
        } else {
            this.setLoadMoreState('hidden');
        }
    }

    /**
     * Handle messages scroll event.
     */
    handleMessagesScroll() {
        this.deps.updateMessagesScrollOverflow?.();
        this.deps.syncMessagesWsIndicator?.();

        if (this.isNearMessagesBottom()) {
            this.setNewMessageHint(false);
        }
    }

    /**
     * Handle touch end on messages - trigger auto load if at top.
     */
    handleMessagesTouchEnd() {
        this.triggerAutoLoadOlder();
    }

    /**
     * Resolve peer for a conversation.
     */
    resolvePeerForConversation(convId, fallbackPeer = null) {
        const threads = this.deps.getConversationThreads?.() || new Map();
        const thread = convId ? threads.get(convId) : null;
        const convIndex = this.deps.ensureConversationIndex?.() || new Map();
        const entry = convId ? convIndex.get(convId) : null;

        return this.deps.normalizePeerKey?.(
            this.deps.threadPeer?.(thread) ||
            entry?.peerAccountDigest ||
            fallbackPeer
        );
    }

    /**
     * Load active conversation messages.
     * Facade: delegates to deps.
     */
    /**
     * Load active conversation messages with Placeholder First strategy.
     */
    async loadActiveConversationMessages({ append = false } = {}) {
        const state = this.getMessageState();
        if (!state.conversationId) return;

        state.loading = true;
        this.updateLoadMoreVisibility();

        // [FIX] Notify composer to show "Syncing history..."
        this.deps.updateComposerAvailability?.();

        // [MUTEX] Check if session is locked (Decryption/Encryption in progress)
        // If locked, we prevent loading more history to avoid race conditions and UI jitter.
        const peerKey = state.activePeerDigest; // Primary key is digest
        // Detailed check requires Device ID (which we might not have trivially here, but state has it)
        const peerDevice = state.activePeerDeviceId;
        const lockKey = peerDevice ? `${peerKey}::${peerDevice}` : peerKey;
        if (isDrSessionLocked(lockKey)) {
            console.warn('[MessageFlow] Load aborted: Session Locked (Decryption in Progress)', lockKey);
            this.deps.showToast?.('尚有訊息解密中，請稍候', { type: 'info', duration: 2000 });

            // Allow retry after short delay but abort current fetch
            state.loading = false;
            this.updateLoadMoreVisibility();
            this.setLoadMoreState('hidden'); // Or show "Decrypting..."
            if (this.elements.loadMoreLabel) this.elements.loadMoreLabel.textContent = '解密中...';
            this.deps.updateComposerAvailability?.();
            return;
        }

        try {
            // [Hybrid] Smart Fetch Strategy via Facade
            const result = await messagesFlowFacade.onScrollFetchMore({
                conversationId: state.conversationId,
                cursor: append ? state.nextCursor : null,
                options: {
                    limit: 20,
                    sourceTag: 'load_active_conversation'
                }
            });

            if (result.items && result.items.length) {
                appendBatch(result.items, { directionalOrder: 'history' });
            }
            // Additional Facade handling is implicit (state mutation option is true)
        } catch (e) {
            console.error('[MessageFlow] Load active conversation failed', e);
        } finally {
            state.loading = false;
            this.updateLoadMoreVisibility();
        }
    }

    /**
     * [AUTO-FILL] Resolve a detected gap by actively fetching the missing range.
     * Triggered by GapDetectedError from coordinator via event.
     */
    async resolveGap(conversationId, localMax, incomingCounter) {
        if (!conversationId || !incomingCounter) return;

        // Prevent concurrent gap fills for the same conversation
        if (this.gapFillInProgress?.has(conversationId)) return;
        this.gapFillInProgress = this.gapFillInProgress || new Set();
        this.gapFillInProgress.add(conversationId);

        console.log(`[MessageFlow] Auto-Resolving Gap: Local=${localMax} -> Incoming=${incomingCounter}`);
        this.deps.showToast?.('正在補齊歷史訊息...', { type: 'loading', duration: 2000 });

        try {
            // Calculate limit: (Incoming - LocalMax) + padding
            const gapSize = incomingCounter - (localMax || 0);
            const limit = Math.ceil(gapSize + 5);

            await messagesFlowFacade.onScrollFetchMore({
                conversationId,
                // Facade fetch usually goes backwards from Latest or Cursor.
                // To fill a gap at the "top" of history (newest), fetching latest is usually correct
                // if the gap is small and recent.
                options: {
                    limit: Math.min(limit, 50),
                    sourceTag: 'gap_autofill'
                }
            });
            console.log('[MessageFlow] Gap Auto-Fill Completed');
        } catch (err) {
            console.warn('[MessageFlow] Gap Auto-Fill Failed', err);
        } finally {
            this.gapFillInProgress.delete(conversationId);
        }
    }

    /**
     * [AUTO-FILL] Resolve a detected gap by actively fetching the missing range.
     * Triggered by GapDetectedError from coordinator.
     */
    async resolveGap(conversationId, localMax, incomingCounter) {
        if (!conversationId || !incomingCounter) return;

        // Prevent concurrent gap fills for the same conversation
        if (this.gapFillInProgress?.has(conversationId)) return;
        this.gapFillInProgress = this.gapFillInProgress || new Set();
        this.gapFillInProgress.add(conversationId);

        console.log(`[MessageFlow] Auto-Resolving Gap: Local=${localMax} -> Incoming=${incomingCounter}`);
        this.deps.showToast?.('正在補齊歷史訊息...', { type: 'loading', duration: 2000 });

        try {
            // Calculate limit: (Incoming - LocalMax) + padding
            const gapSize = incomingCounter - (localMax || 0);
            const limit = Math.ceil(gapSize + 5); // Fetch slightly more to be safe

            await messagesFlowFacade.onScrollFetchMore({
                conversationId,
                // We don't have a cursor for specific range yet in this API, 
                // but standard fetch goes backwards from Latest (or uses Time).
                // If we are "Live", we usually want to fetch "Latest" to fill the top.
                // Assuming standard fetch handles "filling holes" or "fetching latest" correctly.
                options: {
                    limit: Math.min(limit, 50), // Cap at 50
                    sourceTag: 'gap_autofill'
                }
            });
            console.log('[MessageFlow] Gap Auto-Fill Completed');
        } catch (err) {
            console.warn('[MessageFlow] Gap Auto-Fill Failed', err);
        } finally {
            this.gapFillInProgress.delete(conversationId);
        }
    }






    /**
     * Handle timeline append event.
     */
    handleTimelineAppend({ conversationId, entry, entries, directionalOrder } = {}) {
        try {
            const convId = String(conversationId || '').trim();
            const batchEntries = Array.isArray(entries) && entries.length ? entries : (entry ? [entry] : []);

            console.log('[MessageFlow] handleTimelineAppend:entry', {
                conversationId: convId,
                batchSize: batchEntries.length,
                directionalOrder
            });

            if (!convId || !batchEntries.length) {
                console.warn('[MessageFlow] handleTimelineAppend:dropped:empty', { convId, count: batchEntries.length });
                return;
            }

            const replayEntries = batchEntries.filter((item) => item?.isHistoryReplay === true);
            if (replayEntries.length) {
                consumeReplayPlaceholderBatch(convId, replayEntries);
            }
            const hasLiveEntries = batchEntries.some((item) => item?.isHistoryReplay !== true);
            if (hasLiveEntries) {
                consumePendingLivePlaceholderBatch(convId, batchEntries);
                invalidateGapPlaceholderState(convId);
            }

            const state = this.getMessageState();
            // Define active status early for fallback token usage
            const isActiveConversationId = state.conversationId === convId;

            const convIndex = this.deps.ensureConversationIndex?.();
            const convEntry = convIndex?.get?.(convId) || null;
            const threads = this.deps.getConversationThreads?.();
            const existingThread = threads?.get?.(convId) || null;
            const lastEntry = batchEntries[batchEntries.length - 1] || null;
            const peerDigest = this.resolvePeerForConversation(convId, lastEntry?.peerAccountDigest || lastEntry?.senderDigest || null);

            const contactEntry = peerDigest ? this.sessionStore.contactIndex?.get?.(peerDigest) || null : null;
            const nickname = contactEntry?.nickname || existingThread?.nickname || (peerDigest ? `好友 ${peerDigest.slice(-4)}` : '好友');
            const avatar = contactEntry?.avatar || existingThread?.avatar || null;
            const peerDevice = existingThread?.peerDeviceId || convEntry?.peerDeviceId || lastEntry?.peerDeviceId || lastEntry?.senderDeviceId || null;

            // Use state.conversationToken as fallback if active
            const validToken = convEntry?.token_b64 || existingThread?.conversationToken || (isActiveConversationId ? state.conversationToken : null) || null;
            const tokenB64 = validToken;

            const thread = this.deps.upsertConversationThread?.({
                peerAccountDigest: peerDigest || existingThread?.peerAccountDigest || null,
                peerDeviceId: peerDevice,
                conversationId: convId,
                tokenB64,
                nickname,
                avatar
            }) || (threads && threads.get(convId));

            if (!thread) {
                if (isActiveConversationId) {
                    console.warn('[MessageFlow] handleTimelineAppend:orphaned_active_message', { convId });
                    // Create a transient thread object to allow rendering to proceed
                    const dummyThread = {
                        conversationId: convId,
                        peerAccountDigest: peerDigest || state.activePeerDigest,
                        nickname: nickname || '未知',
                        unreadCount: 0
                    };
                    this._proceedWithAppend(batchEntries, dummyThread, state, isActiveConversationId, convId, peerDigest, directionalOrder);
                    return;
                }
                console.error('[MessageFlow] handleTimelineAppend:dropped:no_thread', { convId });
                return;
            }

            this._proceedWithAppend(batchEntries, thread, state, isActiveConversationId, convId, peerDigest, directionalOrder);
        } catch (err) {
            console.error('[MessageFlow] handleTimelineAppend CRITICAL ERROR', err);
            log({ handleTimelineAppendError: err?.message || String(err) });
        }
    }

    _proceedWithAppend(batchEntries, thread, state, isActiveConversationId, convId, peerDigest, directionalOrder) {
        let incomingCount = 0;
        let playedSound = false;

        for (const item of batchEntries) {
            if (!isUserTimelineMessage(item)) continue;
            thread.lastMessageText = item.text || item.error || '';
            thread.lastMessageTs = typeof item.ts === 'number' ? item.ts : thread.lastMessageTs || null;
            thread.lastMessageId = item.messageId || item.id || thread.lastMessageId || null;
            thread.lastDirection = item.direction || thread.lastDirection || null;
            if (item.direction === 'incoming') incomingCount += 1;
        }

        const isActivePeer = !peerDigest || state.activePeerDigest === peerDigest;

        console.log('[MessageFlow] handleTimelineAppend:decision', {
            convId,
            stateConvId: state.conversationId,
            peerDigest,
            activePeerDigest: state.activePeerDigest,
            isActivePeer,
            isActiveConversationId,
            batchSize: batchEntries.length,
            incomingCount
        });

        const isActive = isActiveConversationId;

        const shouldLogBatchRender = true;
        const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();
        const renderStart = shouldLogBatchRender ? nowMs() : null;

        if (isActive) {
            thread.unreadCount = 0;
            thread.lastReadTs = thread.lastMessageTs || thread.lastReadTs || null;
            this.refreshTimelineState(convId);
            this.deps.messageStatus?.applyReceiptsToMessages(state.messages);

            // [FIX] Scroll to Top for history loading (to show oldest of new batch)
            const isHistory = directionalOrder === 'history';
            this.updateMessagesUI({
                scrollToEnd: !isHistory,
                scrollToTop: isHistory,
                preserveScroll: false
            });

            this.syncThreadFromActiveMessages(); // Update header (peerName/avatar)
            this.deps.controllers?.conversationList?.syncThreadFromActiveMessages?.(); // Update list thread if needed
        } else if (incomingCount > 0) {
            thread.unreadCount = Math.max(0, Number(thread.unreadCount) || 0) + incomingCount;
        }
        this.deps.refreshContactsUnreadBadges?.();
        this.deps.renderConversationList?.();

        const renderReason = directionalOrder
            ? `timeline-batch-append:${directionalOrder}`
            : 'timeline-batch-append';

        if (shouldLogBatchRender && renderStart !== null) {
            const renderTookMs = Math.max(0, Math.round(nowMs() - renderStart));
            logCapped('batchRenderTrace', {
                conversationId: convId || null,
                reason: renderReason,
                tookMs: renderTookMs
            }, 5);
        }

        if (!isActive) {
            for (const item of batchEntries) {
                if (!isUserTimelineMessage(item)) continue;
                if (item.direction !== 'incoming') continue;
                const shouldNotify = shouldNotifyForMessage({
                    computedIsHistoryReplay: !!item?.isHistoryReplay,
                    silent: !!item?.silent
                });
                if (shouldNotify) {
                    this.deps.playNotificationSound?.();
                    playedSound = true;

                    const contactEntry = peerDigest ? this.sessionStore.contactIndex?.get?.(peerDigest) || null : null;
                    // Re-resolve nickname/avatar for toast if needed, or pass from caller?
                    // Simplified for now, using thread data or defaults
                    const nickname = thread.nickname || '新訊息';
                    const previewText = buildConversationSnippet(item.text || '') || item.text || '有新訊息';
                    const avatarUrlToast = thread.avatar?.thumbDataUrl || thread.avatar?.previewDataUrl || thread.avatar?.url || null;
                    const initialsToast = this.deps.controllers?.conversationList?.getInitials(nickname, peerDigest || '').slice(0, 2);
                    const toastPeerDeviceId = thread?.peerDeviceId || null;

                    this.deps.showToast?.(`${nickname}：${previewText}`, {
                        onClick: () => this.deps.controllers?.activeConversation?.openConversationFromToast({
                            peerAccountDigest: peerDigest,
                            convId,
                            tokenB64: thread.conversationToken || null, // fallback
                            peerDeviceId: toastPeerDeviceId
                        }),
                        avatarUrl: avatarUrlToast,
                        avatarInitials: initialsToast,
                        subtitle: item.ts ? formatTimestamp(item.ts) : ''
                    });
                }
            }
        }
        logCapped('notificationTrace', {
            conversationIdPrefix8: sliceConversationIdPrefix(convId),
            isActiveConversation: isActive,
            playedSound,
            unreadDelta: isActive ? 0 : incomingCount
        }, 5);
    }

    /**
     * Handle wheel on messages - trigger auto load if at top.
     */
    handleMessagesWheel() {
        this.triggerAutoLoadOlder();
    }

    /**
     * Trigger auto load of older messages if at top of scroll.
     */
    triggerAutoLoadOlder() {
        const scrollEl = this.elements.scrollEl;
        if (!scrollEl) return;
        if (scrollEl.scrollTop > 50) return;

        const state = this.getMessageState();
        if (!state.hasMore || !state.nextCursor || state.loading) return;

        this.deps.loadActiveConversationMessages?.({ append: true });
    }

    /**
     * Sync thread from active messages.
     */
    syncThreadFromActiveMessages() {
        const state = this.getMessageState();
        if (!state.conversationId || !state.activePeerDigest) return;

        const timelineMessages = this.deps.refreshTimelineState?.(state.conversationId);
        const contactEntry = this.sessionStore.contactIndex?.get?.(state.activePeerDigest) || null;
        const nickname = contactEntry?.nickname || `好友 ${state.activePeerDigest.slice(-4)}`;
        const avatar = contactEntry?.avatar || null;
        const tokenB64 = state.conversationToken || contactEntry?.conversation?.token_b64 || null;

        const thread = this.deps.upsertConversationThread?.({
            peerAccountDigest: state.activePeerDigest,
            conversationId: state.conversationId,
            tokenB64,
            nickname,
            avatar
        });

        // Fix: Update DOM elements immediately to reflect profile changes
        console.log('[MessageFlow] syncThreadFromActiveMessages:update_dom', {
            nickname,
            hasAvatar: !!avatar,
            peerNameConnected: this.elements.peerName?.isConnected,
            peerAvatarConnected: this.elements.peerAvatar?.isConnected
        });

        if (this.elements.peerName) {
            this.elements.peerName.textContent = nickname;
        }
        if (this.elements.peerAvatar) {
            const img = this.elements.peerAvatar.tagName === 'IMG'
                ? this.elements.peerAvatar
                : this.elements.peerAvatar.querySelector('img');

            const avatarUrl = avatar?.thumbDataUrl || avatar?.previewDataUrl || avatar?.url || null;
            if (img) {
                if (avatarUrl) {
                    img.src = avatarUrl;
                } else {
                    // Transparent placeholder or default icon
                    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                }
            }
        }

        if (!thread) return;
        thread.previewLoaded = true;

        if (Array.isArray(timelineMessages) && timelineMessages.length) {
            const sortedMsgs = sortMessagesByTimelineLocal(timelineMessages);
            const lastUserMsg = [...sortedMsgs].reverse().find((m) =>
                m?.direction === 'outgoing' || m?.direction === 'incoming'
            );
            if (lastUserMsg) {
                thread.lastMessageText = lastUserMsg.text || '';
                thread.lastMessageTs = lastUserMsg.ts || null;
                thread.lastDirection = lastUserMsg.direction || null;
                thread.lastMessageId = lastUserMsg.id || lastUserMsg.messageId || null;
            }
        }

        thread.unreadCount = 0;
        thread.lastReadTs = thread.lastMessageTs || null;
    }

    /**
     * Refresh timeline state for conversation.
     */
    refreshTimelineState(conversationId = null) {
        const state = this.getMessageState();
        const convId = conversationId || state.conversationId || null;
        if (!convId) {
            state.messages = [];
            return state.messages;
        }
        const timeline = timelineGetTimeline(convId);
        state.messages = timeline;
        return timeline;
    }

    /**
     * Capture scroll anchor.
     */
    captureScrollAnchor() {
        return captureScrollAnchor(this.elements.scrollEl);
    }

    /**
     * Restore scroll from anchor.
     */
    restoreScrollFromAnchor(anchor) {
        return restoreScrollFromAnchor(this.elements.scrollEl, anchor);
    }

    /**
     * Update scroll overflow.
     */
    updateMessagesScrollOverflow() {
        updateScrollOverflow(this.elements.scrollEl);
    }

    /**
     * Update messages UI (Main Rendering Logic).
     */
    /**
     * Update messages UI (Main Rendering Logic).
     */
    updateMessagesUI({ scrollToEnd = false, scrollToTop = false, preserveScroll = false, newMessageIds = null, forceFullRender = false } = {}) {
        if (!this.elements.messagesList) return;
        const state = this.getMessageState();
        const timelineMessages = this.refreshTimelineState(state.conversationId);

        // Initialize Renderer if needed
        if (!this.messageRenderer && this.elements.messagesList) {
            this.messageRenderer = new MessageRenderer({
                messagesListEl: this.elements.messagesList,
                messagesPlaceholdersEl: this.elements.messagesPlaceholders,
                callbacks: {
                    onPreviewMedia: (m) => this.deps.controllers?.mediaHandling?.openMediaPreview(m),
                    onCancelUpload: (msgId, overlay) => {
                        if (msgId) {
                            // abort logic if needed, usually handled by store/controller
                            this.deps.controllers?.messageSending?.removeLocalMessageById(msgId);
                        }
                    }
                }
            });
        }

        // Check for stale DOM refs
        if (this.messageRenderer) {
            const currentListEl = this.elements.messagesList;
            const rendererListEl = this.messageRenderer.listEl;

            const isStale = rendererListEl !== currentListEl || (rendererListEl && !rendererListEl.isConnected);

            if (isStale) {
                console.warn('[MessageFlow] MessageRenderer has stale DOM ref. Updating...', {
                    hasCurrent: !!currentListEl,
                    currentConnected: currentListEl?.isConnected,
                    rendererHas: !!rendererListEl,
                    rendererConnected: rendererListEl?.isConnected
                });
                if (currentListEl) this.messageRenderer.listEl = currentListEl;
                // Placeholders are now inline, so we don't update placeholdersEl
            }
        }

        // Merge and Sort Entries
        // 1. Timeline Messages
        // 2. Replay Placeholders
        // 3. Gap Placeholders
        const replayPlaceholderEntries = getReplayPlaceholderEntries(state.conversationId);
        const gapPlaceholderEntries = getGapPlaceholderEntries(state.conversationId);
        const pendingLiveEntries = getPendingLivePlaceholderEntries(state.conversationId);
        const mergedRaw = [
            ...timelineMessages,
            ...replayPlaceholderEntries,
            ...gapPlaceholderEntries,
            ...pendingLiveEntries
        ];

        const placeholderCount = replayPlaceholderEntries.length + gapPlaceholderEntries.length + pendingLiveEntries.length;

        // Sort first to ensure chronological order
        // Sort first to ensure chronological order
        let sortedMessages = sortMessagesByTimelineLocal(mergedRaw);

        console.log('[MessageFlow] Debug Render: Pre-Filter', {
            stateConvId: state.conversationId,
            timelineCount: timelineMessages.length,
            placeholderCount,
            mergedCount: sortedMessages.length,
            ids: sortedMessages.map(m => m.id),
            types: sortedMessages.map(m => m.msgType),
            sample: sortedMessages.slice(-3).map(m => ({ id: m.id, type: m.msgType }))
        });

        // Filter / Cutoff Logic for Deletion Tombstone
        // Find the LATEST conversation-deleted message (if multiple, the latest one is the effective barrier)
        let deletionTombstoneIndex = -1;
        for (let i = sortedMessages.length - 1; i >= 0; i--) {
            const msg = sortedMessages[i];
            const type = msg.msgType || msg.subtype || 'text';
            if (type === 'conversation-deleted') {
                deletionTombstoneIndex = i;
                break;
            }
        }

        // Apply Hard Cutoff: Keep the tombstone and everything AFTER it.
        if (deletionTombstoneIndex !== -1) {
            console.log('[MessageFlow] Debug Render: Tombstone Found', { index: deletionTombstoneIndex, total: sortedMessages.length });
            // Check if there are messages BEFORE it (index < deletionTombstoneIndex)
            // If so, slice!
            // slice(startIndex) -> returns new array from Start to End.
            // We want [Tombstone, ...NewerMessages]
            sortedMessages = sortedMessages.slice(deletionTombstoneIndex);
        }

        // Normal filtering for other control messages


        const { entries: renderEntries, shimmerIds } = buildRenderEntries({
            timelineMessages: sortedMessages
        });

        const anchorNeeded = preserveScroll || (!scrollToEnd && !this.isNearMessagesBottom());
        const anchor = anchorNeeded ? this.captureScrollAnchor() : null;

        const selfDigest = (() => {
            try { return normalizeAccountDigest(getAccountDigest()); } catch { return null; }
        })();

        console.log('[MessageFlow] Debug DoubleTick Pre-Compute', {
            conversationId: state.conversationId,
            selfDigest,
            msgCount: timelineMessages.length
        });

        const { visibleStatusSet } = computeStatusVisibility({
            timelineMessages,
            conversationId: state.conversationId || null,
            selfDigest
        });

        console.log('[MessageFlow] Debug StatusVisibility', {
            visibleCount: visibleStatusSet.size,
            sample: Array.from(visibleStatusSet).slice(-3)
        });

        // Render Main List (Unified)
        if (this.messageRenderer) {
            this.messageRenderer.render(renderEntries, {
                state: { ...state, activePeerDigest: state.activePeerDigest, activePeerDeviceId: state.activePeerDeviceId, conversationId: state.conversationId },
                contacts: this.sessionStore.contactIndex,
                visibleStatusSet,
                shimmerIds,
                forceFullRender // [FIX] Pass flag to renderer
            });
        }

        // Placeholders container is no longer used
        if (this.elements.messagesPlaceholders) {
            this.elements.messagesPlaceholders.innerHTML = '';
            this.elements.messagesPlaceholders.style.display = 'none';
        }

        // Update Empty State
        if (renderEntries.length) {
            this.elements.messagesEmpty?.classList.add('hidden');
        } else {
            this.elements.messagesEmpty?.classList.remove('hidden');
            if (this.elements.messagesEmpty) {
                // [FIX] Dynamic Empty State Text
                // If we have an active peer but no messages, it means "No messages yet".
                // If we have no active peer, it means "No conversation selected".
                if (state.activePeerDigest) {
                    this.elements.messagesEmpty.textContent = '尚無訊息';
                } else {
                    this.elements.messagesEmpty.textContent = '尚未選擇任何對話';
                }
            }
        }

        this.renderedIds = renderEntries.map(m => normalizeTimelineMessageId(m));
        this.renderConversationId = state.conversationId || null;
        this.renderPlaceholderCount = placeholderCount;

        this.updateLoadMoreVisibility();
        this.updateMessagesScrollOverflow();

        if (!scrollToEnd && !scrollToTop && anchor) {
            this.restoreScrollFromAnchor(anchor);
        } else if (scrollToEnd) {
            scrollToBottomSoon(this.elements.scrollEl);
            this.setNewMessageHint(false);
        } else if (scrollToTop) {
            // [FIX] Scroll to Top with 50px offset
            // Threshold is 20px (messages-pane.js), so we must be > 20px to avoid infinite loop.
            if (this.elements.scrollEl) this.elements.scrollEl.scrollTop = 50;
        }
    }

    /**
     * Initialize scroll event listeners.
     */
    init() {
        super.init();

        if (this.elements.scrollEl) {
            this.elements.scrollEl.addEventListener('scroll', () => this.handleMessagesScroll());
            this.elements.scrollEl.addEventListener('touchend', () => this.handleMessagesTouchEnd());
            this.elements.scrollEl.addEventListener('wheel', () => this.handleMessagesWheel(), { passive: true });
        }
    }
}
