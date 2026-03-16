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
import { t } from '/locales/index.js';

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
            this.elements.peerName.textContent = name || t('contacts.selectToChat');
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
        const nickname = contactEntry?.nickname || fallbackName || `${t('common.friend')} ${key.slice(-4)}`;
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
            const nickname = entry.nickname || `${t('common.friend')} ${peerKey.slice(-4)}`;
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
        const peerKey = normalizePeerKey(peerAccountDigest);
        if (!peerKey) {
            this.showToast(t('errors.invalidContact'));
            return;
        }

        // Clear ephemeral avatar styling (re-applied by _openEphemeralConversation if needed)
        document.getElementById('messagesList')?.classList.remove('ephemeral-active');
        document.getElementById('messagesPeerAvatar')?.classList.remove('ephemeral-active');
        this.deps.controllers?.ephemeral?.hideConvTimerBar?.();

        // Save draft for the conversation we're leaving
        this.deps.controllers?.composer?.saveDraft();

        const state = this.getMessageState();
        const contactEntry = this.sessionStore.contactIndex?.get?.(peerKey) || null;
        const convEntry = contactEntry?.conversation || null;

        // [RESOLVE ID] Prioritize passedId (from Toast) -> Contact Index -> null
        let targetConvId = passedId || contactEntry?.conversation_id || null;

        // [SPLIT-BRAIN CHECK]
        if (passedId && contactEntry?.conversation_id && passedId !== contactEntry.conversation_id) {
            migrateTimelineConversation(passedId, contactEntry.conversation_id);
            targetConvId = contactEntry.conversation_id;
        }

        // Update state
        state.activePeerDigest = peerKey;
        state.conversationId = targetConvId;
        state.conversationToken = passedToken || convEntry?.token_b64 || null;
        state.activePeerDeviceId = convEntry?.peerDeviceId || null;
        state.activeBizConv = false; // Clear biz-conv flag for 1-to-1
        state.viewMode = 'detail';
        state.loading = false;
        // [FIX] Reset Cursor State
        state.hasMore = true;
        state.nextCursor = null;
        state.nextCursorTs = null;

        // UI Reset
        this.clearMessagesView();

        // Navigation
        if (this.deps.getCurrentTab?.() !== 'messages') {
            this.deps.switchTab?.('messages');
        }

        // Refresh metadata
        const nickname = contactEntry?.nickname || `${t('common.friend')} ${peerKey.slice(-4)}`;
        const avatar = contactEntry?.avatar || null;
        this.updatePeerNameDisplay(nickname);
        this.updatePeerAvatar(avatar);
        // Clear biz-conv header click handler
        if (this.elements.peerName) {
            this.elements.peerName.style.cursor = '';
            this.elements.peerName.onclick = null;
        }
        // Hide biz-conv settings button for 1-to-1
        if (this.elements.bizConvSettingsBtn) {
            this.elements.bizConvSettingsBtn.classList.add('hidden');
            this.elements.bizConvSettingsBtn.onclick = null;
        }

        // Load messages if conversation exists (Token is optional for local load)
        if (state.conversationId) {
            // [FAST PATH] Restore DR State immediately
            MessageKeyVault.getLatestState({ conversationId: state.conversationId })
                .then((data) => {
                    const tasks = [];
                    if (data?.outgoing?.dr_state) {
                        tasks.push(importContactSecretsSnapshot(data.outgoing.dr_state, {
                            replace: false,
                            persist: true,
                            reason: 'fast-path-out'
                        }));
                    }
                    if (data?.incoming?.dr_state) {
                        tasks.push(importContactSecretsSnapshot(data.incoming.dr_state, {
                            replace: false,
                            persist: true,
                            reason: 'fast-path-in'
                        }));
                    }
                    return Promise.all(tasks);
                })
                .catch(() => { /* non-critical */ });

            // Non-blocking load to prevent UI freeze
            this.deps.loadActiveConversationMessages?.({ append: false })
                .catch((err) => {
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
                this.elements.messagesEmpty.textContent = t('messages.noMessages');
            }
            this.deps.updateMessagesStatusUI?.();
        }

        // Final UI sync
        try {
            this.deps.applyMessagesLayout?.();
            // Force UI update to trigger Double Tick logic + scroll to bottom on enter
            this.deps.updateMessagesUI?.({ scrollToEnd: true, forceFullRender: true });
        } catch { /* ignore */ }

        this.deps.updateComposerAvailability?.();
        // Restore draft for the conversation we're entering (or clear input)
        this.deps.controllers?.composer?.restoreDraft();
        // [UX] Auto-focus input when entering conversation
        this.deps.focusComposerInput?.();
    }

    /**
     * Set active business conversation (group chat).
     */
    async setActiveBizConv(conversationId) {
        if (!conversationId) return;

        // Save draft for the conversation we're leaving
        this.deps.controllers?.composer?.saveDraft();

        const state = this.getMessageState();
        const threads = this.deps.getConversationThreads?.() || new Map();
        const thread = threads.get(conversationId) || {};

        // Update state for biz-conv mode
        state.activePeerDigest = null;
        state.activePeerDeviceId = null;
        state.conversationId = conversationId;
        state.conversationToken = null;
        state.activeBizConv = true;
        state.viewMode = 'detail';
        state.loading = false;
        state.hasMore = true;
        state.nextCursor = null;
        state.nextCursorTs = null;

        // UI Reset
        this.clearMessagesView();

        // Navigation
        if (this.deps.getCurrentTab?.() !== 'messages') {
            this.deps.switchTab?.('messages');
        }

        // Display group info in header
        const groupName = thread.bizConvName || t('messages.bizConvDefault');
        const memberCount = thread.bizConvMemberCount || 0;
        this.updatePeerNameDisplay(memberCount > 0 ? `${groupName} (${memberCount})` : groupName);
        this.updatePeerAvatar({ initials: groupName.slice(0, 2).toUpperCase() });

        // Make header name clickable for group info
        if (this.elements.peerName) {
            this.elements.peerName.style.cursor = 'pointer';
            this.elements.peerName.onclick = () => {
                this.deps.openBizConvInfoModal?.(conversationId);
            };
        }
        // Show gear icon for group settings
        if (this.elements.bizConvSettingsBtn) {
            this.elements.bizConvSettingsBtn.classList.remove('hidden');
            this.elements.bizConvSettingsBtn.onclick = () => {
                this.deps.openBizConvInfoModal?.(conversationId);
            };
        }

        // Load messages from timeline
        if (conversationId) {
            this.deps.loadActiveConversationMessages?.({ append: false })
                .catch((err) => {
                    this.log({ loadBizConvMessagesError: err?.message || err, conversationId });
                })
                .finally(() => {
                    this.deps.updateComposerAvailability?.();
                });
        }

        // Final UI sync
        try {
            this.deps.applyMessagesLayout?.();
            this.deps.updateMessagesUI?.({ scrollToEnd: true, forceFullRender: true });
        } catch { /* ignore */ }

        this.deps.updateComposerAvailability?.();
        this.deps.controllers?.composer?.restoreDraft();
        this.deps.focusComposerInput?.();
    }

    /**
     * Handle contact open conversation event.
     */
    handleContactOpenConversation(detail) {
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

        if (!peerKey) return;

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
            this.showToast(t('errors.conversationNotFound'));
            return;
        }

        this.deps.handleConversationDelete?.({
            conversationId,
            peerAccountDigest: key,
            element: null
        });
    }
}
