/**
 * ActiveConversationController
 * Facade controller for conversation activation and peer management.
 * 
 * This controller provides a clean interface for conversation state management.
 * Due to deep coupling with closure state in messages-pane.js, the actual
 * setActiveConversation implementation is injected via deps.
 */

import { BaseController } from './base-controller.js';
import { normalizePeerKey, splitPeerKey } from '../contact-core-store.js';
import { normalizePeerIdentity } from '../../../core/store.js';
import { MessageKeyVault } from '../../../features/message-key-vault.js';
import { importContactSecretsSnapshot } from '../../../core/contact-secrets.js';
import { migrateTimelineConversation } from '../../../features/timeline-store.js';

export class ActiveConversationController extends BaseController {
    constructor(deps) {
        super(deps);
        this.pendingSecureReadyPeer = null;
    }

    /**
     * Normalize peer identity from various formats.
     */
    normalizePeerIdentity(input) {
        return normalizePeerIdentity(input);
    }

    /**
     * Split peer key into digest and device ID.
     */
    splitPeerKey(key) {
        return splitPeerKey(key);
    }

    /**
     * Clear messages view.
     */
    clearMessagesView() {
        if (this.elements.messagesList) this.elements.messagesList.innerHTML = '';
        if (this.elements.messagesPlaceholders) this.elements.messagesPlaceholders.innerHTML = '';
        if (this.elements.messagesEmpty) this.elements.messagesEmpty.style.display = 'none';
    }

    /**
     * Update peer name display.
     */
    updatePeerNameDisplay(name) {
        if (this.elements.peerName) {
            this.elements.peerName.textContent = name || '選擇好友開始聊天';
        }
    }

    /**
     * Update peer avatar display.
     */
    updatePeerAvatar(avatarData) {
        const avatarEl = this.elements.peerAvatar;
        if (!avatarEl) return;

        const src = avatarData?.thumbDataUrl || avatarData?.previewDataUrl || avatarData?.url || null;
        const img = avatarEl.querySelector('img');
        const placeholder = avatarEl.querySelector('.avatar-placeholder');

        let targetImg = img;
        let targetPlaceholder = placeholder;

        // Dynamic creation if missing (fixes empty container issue)
        if (!targetImg) {
            targetImg = document.createElement('img');
            targetImg.alt = 'Avatar';
            targetImg.style.display = 'none';
            avatarEl.appendChild(targetImg);
        }
        if (!targetPlaceholder) {
            targetPlaceholder = document.createElement('div');
            targetPlaceholder.className = 'avatar-placeholder';
            targetPlaceholder.style.display = 'none';
            avatarEl.appendChild(targetPlaceholder);
        }

        if (src) {
            if (targetImg) {
                targetImg.src = src;
                targetImg.style.display = '';
            }
            if (targetPlaceholder) targetPlaceholder.style.display = 'none';
        } else {
            if (targetImg) targetImg.style.display = 'none';
            if (targetPlaceholder) {
                targetPlaceholder.style.display = '';
                targetPlaceholder.textContent = (avatarData?.initials || '?').slice(0, 2);
            }
        }
    }

    /**
     * Refresh active peer metadata (name, avatar).
     */
    refreshActivePeerMetadata(peerAccountDigest, { fallbackName } = {}) {
        const key = normalizePeerKey(peerAccountDigest);
        if (!key) return;

        const contactEntry = this.sessionStore.contactIndex?.get?.(key) || null;
        const nickname = contactEntry?.nickname || fallbackName || `好友 ${key.slice(-4)}`;
        const avatar = contactEntry?.avatar || null;

        this.updatePeerNameDisplay(nickname);
        this.updatePeerAvatar(avatar);
        this.deps.updateThreadAvatar?.(key, avatar);
    }

    /**
     * Handle contact entry updated event.
     */
    handleContactEntryUpdated(detail = {}) {
        const peerKey = normalizePeerKey(detail.peerKey || detail.peerAccountDigest);
        if (!peerKey) return;

        const entry = detail.entry || this.sessionStore.contactIndex?.get?.(peerKey) || null;
        if (!entry) return;

        // Upsert thread if conversation details exist
        const hasConversation = entry.conversation?.conversation_id && entry.conversation?.token_b64;
        if (hasConversation) {
            this.deps.upsertConversationThread?.({
                peerAccountDigest: peerKey,
                conversationId: entry.conversation.conversation_id,
                tokenB64: entry.conversation.token_b64,
                nickname: entry.nickname,
                avatar: entry.avatar || null
            });
            this.deps.updateThreadAvatar?.(peerKey, entry.avatar || null);
        } else {
            // If conversation lost, refresh list
            this.deps.renderConversationList?.();
        }

        // Update active peer display if relevant
        const state = this.getMessageState();
        if (state.activePeerDigest === peerKey) {
            const nickname = entry.nickname || `好友 ${peerKey.slice(-4)}`;
            const avatar = entry.avatar || null;
            this.updatePeerNameDisplay(nickname);
            this.updatePeerAvatar(avatar);
        }
    }

    /**
     * Set active conversation for a peer.
     * This updates the global message state and triggers UI transition.
     */
    async setActiveConversation(peerAccountDigest, passedId = null, passedToken = null) {
        console.log('[ActiveConversationController] setActiveConversation: start', { peerAccountDigest, passedId, hasPassedToken: !!passedToken });
        const peerKey = normalizePeerKey(peerAccountDigest);
        if (!peerKey) {
            console.error('[ActiveConversationController] setActiveConversation: invalid peerKey');
            this.showToast('無效的聯絡人');
            return;
        }

        console.log('[ActiveConversationController] setActiveConversation: processing', peerKey);
        const state = this.getMessageState();
        const contactEntry = this.sessionStore.contactIndex?.get?.(peerKey) || null;
        const convEntry = contactEntry?.conversation || null;

        // [RESOLVE ID] Prioritize passedId (from Toast) -> Contact Index -> null
        let targetConvId = passedId || contactEntry?.conversation_id || null;

        // [SPLIT-BRAIN CHECK]
        if (passedId && contactEntry?.conversation_id && passedId !== contactEntry.conversation_id) {
            console.warn('[ActiveConversationController] Split-Brain detected. Migrating:', { from: passedId, to: contactEntry.conversation_id });
            migrateTimelineConversation(passedId, contactEntry.conversation_id);
            targetConvId = contactEntry.conversation_id;
        }

        // Update state
        state.activePeerDigest = peerKey;
        state.conversationId = targetConvId;
        state.conversationToken = passedToken || convEntry?.token_b64 || null;
        state.activePeerDeviceId = convEntry?.peerDeviceId || null;
        state.viewMode = 'detail';
        state.loading = false;
        // [FIX] Reset Cursor State
        state.hasMore = true;
        state.nextCursor = null;
        state.nextCursorTs = null;
        console.log('[ActiveConversationController] state updated', {
            activePeerDigest: state.activePeerDigest,
            conversationId: state.conversationId,
            passedId,
            contactEntryId: contactEntry?.conversation_id
        });

        // UI Reset
        this.clearMessagesView();
        console.log('[ActiveConversationController] UI cleared');

        // Navigation
        console.log('[ActiveConversationController] switching tab check', this.deps.getCurrentTab?.());
        if (this.deps.getCurrentTab?.() !== 'messages') {
            this.deps.switchTab?.('messages');
            console.log('[ActiveConversationController] switched to messages tab');
        }

        // Refresh metadata
        const nickname = contactEntry?.nickname || `好友 ${peerKey.slice(-4)}`;
        const avatar = contactEntry?.avatar || null;
        this.updatePeerNameDisplay(nickname);
        this.updatePeerAvatar(avatar);
        console.log('[ActiveConversationController] metadata refreshed', nickname);

        // Load messages if conversation exists (Token is optional for local load)
        if (state.conversationId) {
            // [FAST PATH] Restore DR State immediately
            console.log('[ActiveConversationController] fast-path state restore start');
            MessageKeyVault.getLatestState({ conversationId: state.conversationId })
                .then((data) => {
                    const tasks = [];
                    if (data?.outgoing?.dr_state) {
                        tasks.push(importContactSecretsSnapshot(data.outgoing.dr_state, {
                            replace: true,
                            persist: true,
                            reason: 'fast-path-out'
                        }));
                    }
                    if (data?.incoming?.dr_state) {
                        tasks.push(importContactSecretsSnapshot(data.incoming.dr_state, {
                            replace: true,
                            persist: true,
                            reason: 'fast-path-in'
                        }));
                    }
                    return Promise.all(tasks);
                })
                .then((results) => {
                    if (results.length) console.log('[ActiveConversationController] fast-path state restored', results.length);
                })
                .catch((err) => {
                    console.warn('[ActiveConversationController] fast-path failed (non-critical)', err);
                });

            console.log('[ActiveConversationController] loading messages (async)...');
            // Non-blocking load to prevent UI freeze
            this.deps.loadActiveConversationMessages?.({ append: false })
                .then(() => {
                    console.log('[ActiveConversationController] messages loaded');
                })
                .catch((err) => {
                    console.error('[ActiveConversationController] load messages error', err);
                    this.log({ loadMessagesError: err?.message || err, peerKey });
                })
                .finally(() => {
                    // Unlock composer when loading finishes
                    this.deps.updateComposerAvailability?.();
                });
        } else {
            // New or pending contact, ensure empty state shows
            if (this.elements.messagesEmpty) {
                this.elements.messagesEmpty.classList.remove('hidden');
                // Pre-set text for immediate feedback
                this.elements.messagesEmpty.textContent = '尚無訊息';
            }
            this.deps.updateMessagesStatusUI?.();
            console.log('[ActiveConversationController] new/pending conversation UI set');
        }

        // Final UI sync
        console.log('[ActiveConversationController] debug UI sync', {
            viewMode: state.viewMode,
            hasLayoutDep: !!this.deps.applyMessagesLayout,
            layoutControllerExists: !!this.deps.controllers?.layout // Check if we can access this
        });

        try {
            this.deps.applyMessagesLayout?.();
            console.log('[ActiveConversationController] applyMessagesLayout called');
            // Force UI update to trigger Double Tick logic + scroll to bottom on enter
            this.deps.updateMessagesUI?.({ scrollToEnd: true, forceFullRender: true });
        } catch (e) {
            console.error('[ActiveConversationController] applyMessagesLayout failed', e);
        }

        this.deps.updateComposerAvailability?.();
        // [UX] Auto-focus input when entering conversation
        this.deps.focusComposerInput?.();
        console.log('[ActiveConversationController] setActiveConversation: done');
    }

    /**
     * Handle contact open conversation event.
     */
    handleContactOpenConversation(detail) {
        console.log('[ActiveConversationController] handleContactOpenConversation', detail);

        // Try to resolve full key first using core store normalizer which handles {peerAccountDigest, peerDeviceId}
        let peerKey = null;
        if (detail?.peerAccountDigest && detail?.peerDeviceId) {
            const identity = normalizePeerIdentity(detail);
            peerKey = identity.key;
        }

        // Fallback to existing logic if full key not resolved
        if (!peerKey) {
            peerKey = normalizePeerKey(detail?.peerAccountDigest || detail?.peerKey);
        }

        if (!peerKey) {
            console.warn('[ActiveConversationController] handleContactOpenConversation: missing peerKey', detail);
            return;
        }

        // [FIX] Extract conversationId and token from detail
        // Support multiple structures:
        // 1. detail.conversationId (Direct)
        // 2. detail.entry.conversation.conversation_id (From Contact Entry)
        // 3. detail.conversation.conversation_id (From Contacts View Event)
        const conversationId = detail?.conversationId ||
            detail?.entry?.conversation?.conversation_id ||
            detail?.conversation?.conversation_id ||
            null;

        const tokenB64 = detail?.tokenB64 ||
            detail?.entry?.conversation?.token_b64 ||
            detail?.conversation?.token_b64 ||
            null;

        console.log('[ActiveConversationController] routing to conversation', { peerKey, conversationId, hasToken: !!tokenB64 });
        this.setActiveConversation(peerKey, conversationId, tokenB64);
    }

    /**
     * Open conversation from toast notification.
     */
    async openConversationFromToast({ peerAccountDigest, convId, tokenB64, peerDeviceId }) {
        const key = normalizePeerKey(peerAccountDigest);
        if (!key) return;

        // Switch to messages tab if not already there
        if (this.deps.getCurrentTab?.() !== 'messages') {
            this.deps.switchTab?.('messages');
        }

        console.log('[ActiveConversationController] deps check:', {
            hasApplyLayout: !!this.deps.applyMessagesLayout,
            hasNavbar: !!this.deps.navbarEl,
            hasMain: !!this.deps.mainContentEl
        });

        // Ensure thread exists
        if (convId && tokenB64) {
            this.deps.upsertConversationThread?.({
                peerAccountDigest: key,
                peerDeviceId,
                conversationId: convId,
                tokenB64
            });
        }

        await this.setActiveConversation(key, convId, tokenB64);
    }

    /**
     * Show delete confirmation for a peer.
     */
    showDeleteForPeer(peerAccountDigest) {
        const key = normalizePeerKey(peerAccountDigest);
        if (!key) return;

        const threads = this.deps.getConversationThreads?.() || new Map();
        let threadToDelete = null;
        let conversationId = null;

        for (const thread of threads.values()) {
            if (this.deps.threadPeer?.(thread) === key) {
                threadToDelete = thread;
                conversationId = thread.conversationId;
                break;
            }
        }

        if (!conversationId) {
            this.showToast('找不到對話');
            return;
        }

        this.deps.handleConversationDelete?.({
            conversationId,
            peerAccountDigest: key,
            element: null
        });
    }
}
