/**
 * SecureStatusController
 * Manages secure conversation status, caching, and UI modal display.
 */

import { BaseController } from './base-controller.js';
import { normalizePeerKey, isCoreVaultReady, resolveReadyContactCoreEntry } from '../contact-core-store.js';
import { getSecureConversationStatus, SECURE_CONVERSATION_STATUS } from '../../../features/secure-conversation-manager.js';
import { getMkRaw } from '../../../core/store.js';

export class SecureStatusController extends BaseController {
    constructor(deps) {
        super(deps);
        /** @type {Map<string, { status: string, error: string|null }>} */
        this.secureStatusCache = new Map();
        /** @type {string|null} */
        this.activeSecurityModalPeer = null;
        /** @type {string|null} */
        this.pendingSecureReadyPeer = null;
    }

    /**
     * Cache a secure status entry.
     * @param {string} peerAccountDigest
     * @param {string} status
     * @param {string|null} error
     * @returns {Object|null}
     */
    cacheSecureStatus(peerAccountDigest, status, error) {
        const key = normalizePeerKey(peerAccountDigest);
        if (!key) return null;
        const entry = {
            status: status || SECURE_CONVERSATION_STATUS.IDLE,
            error: error || null
        };
        this.secureStatusCache.set(key, entry);
        return entry;
    }

    /**
     * Get cached secure status for a peer.
     * @param {string} peerAccountDigest
     * @returns {Object|null}
     */
    getCachedSecureStatus(peerAccountDigest) {
        const key = normalizePeerKey(peerAccountDigest);
        if (!key) return null;
        const cached = this.secureStatusCache.get(key);
        if (cached) return cached;
        const managerStatus = getSecureConversationStatus(key);
        if (!managerStatus) return null;
        return this.cacheSecureStatus(key, managerStatus.status, managerStatus.error);
    }

    /**
     * Resolve secure status for UI display, handling vault bypass.
     * @param {string} peerKeyValue
     * @param {Object} statusInfo
     * @param {Object|null} stateOverride
     * @returns {{ status: string, statusInfo: Object, bypassed: boolean }}
     */
    resolveSecureStatusForUi(peerKeyValue, statusInfo, stateOverride = null) {
        const status = statusInfo?.status || null;
        if (status !== SECURE_CONVERSATION_STATUS.PENDING) {
            return { status, statusInfo, bypassed: false };
        }
        const state = stateOverride || this.getMessageState();
        const coreReady = isCoreVaultReady(peerKeyValue, state.activePeerDeviceId, state.conversationId);
        if (!coreReady) {
            return { status, statusInfo, bypassed: false };
        }
        return {
            status: SECURE_CONVERSATION_STATUS.READY,
            statusInfo: { ...statusInfo, status: SECURE_CONVERSATION_STATUS.READY, error: null },
            bypassed: true
        };
    }

    /**
     * Hide the security modal.
     */
    hideSecurityModal() {
        if (!this.activeSecurityModalPeer) return;
        this.deps.closePreviewModal?.();
        this.activeSecurityModalPeer = null;
    }

    /**
     * Update security modal for a specific peer.
     * @param {string} peerAccountDigest
     * @param {Object} statusInfo
     */
    updateSecurityModalForPeer(peerAccountDigest, statusInfo) {
        const showSecurityModal = this.deps.showSecurityModal;
        if (!showSecurityModal) return;

        const key = normalizePeerKey(peerAccountDigest);
        const state = this.getMessageState();
        const activePeerValue = state.activePeerDigest || null;
        const resolvedCore = resolveReadyContactCoreEntry(activePeerValue, state.activePeerDeviceId, state.conversationId);
        const resolvedPeerKey = resolvedCore.peerKey;
        const activeCoreEntry = resolvedCore.entry;

        // Rehydrate state from core entry if needed
        const canRehydrate = (!key || !resolvedPeerKey || key === resolvedPeerKey)
            && activeCoreEntry?.isReady
            && activeCoreEntry.conversationId
            && activeCoreEntry.conversationToken
            && (!state.conversationId || !state.conversationToken);

        if (canRehydrate) {
            const filledConversationId = !state.conversationId;
            const filledToken = !state.conversationToken;
            if (filledConversationId) state.conversationId = activeCoreEntry.conversationId;
            if (filledToken) state.conversationToken = activeCoreEntry.conversationToken;
            this.deps.logActivePeerStateRehydrateTrace?.({
                peerKey: resolvedPeerKey || activePeerValue || null,
                filledConversationIdPrefix8: filledConversationId ? String(activeCoreEntry.conversationId).slice(0, 8) : null,
                filledTokenLen: filledToken ? String(activeCoreEntry.conversationToken).length : null
            });
        }

        const statusResolution = this.resolveSecureStatusForUi(key || activePeerValue, statusInfo, state);
        const status = statusResolution.status;
        const mkReady = !!getMkRaw();
        const vaultGateReady = !!(state.conversationToken && state.conversationId && mkReady);

        this.deps.logSecureModalGateTrace?.({
            peerAccountDigest: key || null,
            conversationId: state.conversationId || null,
            hasToken: !!state.conversationToken,
            mkReady,
            vaultGateReady,
            status: statusInfo?.status || null,
            statusEffective: status,
            pendingBypassed: statusResolution.bypassed
        });

        const shouldShow = status === SECURE_CONVERSATION_STATUS.PENDING;
        if (shouldShow && vaultGateReady) {
            if (this.activeSecurityModalPeer === key) {
                this.hideSecurityModal();
            }
            return;
        }

        if (shouldShow) {
            if (this.activeSecurityModalPeer !== key) {
                showSecurityModal({
                    title: '建立安全對話',
                    message: '正在與好友建立安全對話，請稍候…'
                });
                this.activeSecurityModalPeer = key;
            }
            return;
        }

        if (this.activeSecurityModalPeer && this.activeSecurityModalPeer === key) {
            this.hideSecurityModal();
        } else if (this.activeSecurityModalPeer && !key) {
            this.hideSecurityModal();
        }
    }

    /**
     * Apply secure status for the currently active peer.
     * @param {string} peerAccountDigest
     * @param {Object} statusInfo
     */
    applySecureStatusForActivePeer(peerAccountDigest, statusInfo) {
        const state = this.getMessageState();
        const key = normalizePeerKey(peerAccountDigest);
        if (state.activePeerDigest !== key) {
            if (!state.activePeerDigest) this.hideSecurityModal();
            return;
        }

        const statusResolution = this.resolveSecureStatusForUi(key, statusInfo, state);
        const status = statusResolution.status;

        this.updateSecurityModalForPeer(key, statusInfo);

        if (status === SECURE_CONVERSATION_STATUS.PENDING) {
            this.deps.setMessagesStatus?.('正在建立安全對話…');
        } else if (status === SECURE_CONVERSATION_STATUS.FAILED) {
            const msg = statusInfo?.error
                ? `建立安全對話失敗：${statusInfo.error}`
                : '建立安全對話失敗，請稍後再試。';
            this.deps.setMessagesStatus?.(msg, true);
        } else if (status === SECURE_CONVERSATION_STATUS.READY) {
            this.deps.setMessagesStatus?.('');
        } else {
            this.deps.setMessagesStatus?.('');
        }

        this.deps.updateComposerAvailability?.();
    }

    /**
     * Handle secure status event from WebSocket.
     * @param {Object} event
     */
    handleSecureStatusEvent(event) {
        const key = normalizePeerKey(event?.peerAccountDigest);
        if (!key) return;

        const entry = this.cacheSecureStatus(key, event?.status, event?.error);
        if (!entry) return;

        const state = this.getMessageState();
        if (state.activePeerDigest === key) {
            this.applySecureStatusForActivePeer(key, entry);

            if (this.pendingSecureReadyPeer === key && entry.status === SECURE_CONVERSATION_STATUS.READY) {
                this.pendingSecureReadyPeer = null;
                this.deps.setMessagesStatus?.('');
                this.deps.updateComposerAvailability?.();
                this.deps.loadActiveConversationMessages?.({ append: false, replay: false })
                    .catch((err) => this.log({ secureReadyLoadError: err?.message || err }));
            }
        }
    }
}
