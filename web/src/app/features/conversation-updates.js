/**
 * Conversation Updates Module
 * 
 * Provides centralized logic for updating conversation indices and threads in sessionStore.
 * Used by entry-incoming and potentially other flow handlers.
 */

import { sessionStore } from '../ui/mobile/session-store.js';
import { normalizePeerKey, splitPeerKey } from '../features/conversation.js';
import { normalizeAccountDigest, normalizePeerDeviceId } from '../core/store.js';
import { upsertContactCore } from '../ui/mobile/contact-core-store.js';

/**
 * Ensure peer account digest is normalized.
 * @param {string|Object} source 
 */
export function ensurePeerAccountDigest(source) {
    if (!source || typeof source !== 'object') {
        if (typeof source === 'string') return normalizeAccountDigest(source);
        return null;
    }
    const raw = source.peerAccountDigest || source.accountDigest || source.senderAccountDigest || null;
    return normalizeAccountDigest(raw);
}

/**
 * Ensure conversation index map exists.
 * @returns {Map}
 */
export function ensureConversationIndex() {
    if (!(sessionStore.conversationIndex instanceof Map)) {
        const entries = sessionStore.conversationIndex && typeof sessionStore.conversationIndex.entries === 'function'
            ? Array.from(sessionStore.conversationIndex.entries())
            : [];
        sessionStore.conversationIndex = new Map(entries);
    }
    return sessionStore.conversationIndex;
}

/**
 * Get conversation threads map.
 * @returns {Map}
 */
export function getConversationThreads() {
    if (!(sessionStore.conversationThreads instanceof Map)) {
        const entries = sessionStore.conversationThreads && typeof sessionStore.conversationThreads.entries === 'function'
            ? Array.from(sessionStore.conversationThreads.entries())
            : [];
        sessionStore.conversationThreads = new Map(entries);
    }
    return sessionStore.conversationThreads;
}

/**
 * Upsert a conversation thread entry.
 * Logic mirrored from ConversationListController.upsertThread but pure functional.
 */
export function upsertConversationThread({ peerAccountDigest, peerDeviceId = null, conversationId, tokenB64, nickname, avatar }) {
    const key = normalizePeerKey(peerAccountDigest);
    const convId = String(conversationId || '').trim();
    if (!key || !convId) return null;
    if (sessionStore.deletedConversations?.has?.(convId)) return null;

    const threads = getConversationThreads();
    const prev = threads.get(convId) || {};
    const { digest: digestFromKey, deviceId: deviceFromKey } = splitPeerKey(key);
    const resolvedPeerDeviceId = normalizePeerDeviceId(peerDeviceId || deviceFromKey || prev.peerDeviceId || null);
    const resolvedToken = tokenB64 || prev.conversationToken || null;

    if (!resolvedPeerDeviceId || !resolvedToken) {
        return prev || null;
    }

    if (!digestFromKey) {
        return prev || null;
    }

    // Note: We skip calling upsertContactCore here to avoid circular dependencies if contact-core depends on this.
    // Callers like entry-incoming usually call upsertContactCore separately.

    const entry = {
        ...prev,
        peerAccountDigest: key,
        peerDeviceId: resolvedPeerDeviceId,
        conversationId: convId,
        conversationToken: resolvedToken,
        nickname: nickname || prev.nickname || null,
        avatar: avatar || prev.avatar || null,
        lastMessageText: typeof prev.lastMessageText === 'string' ? prev.lastMessageText : '',
        lastMessageTs: typeof prev.lastMessageTs === 'number' ? prev.lastMessageTs : null,
        lastMessageId: prev.lastMessageId || null,
        lastReadTs: typeof prev.lastReadTs === 'number' ? prev.lastReadTs : null,
        unreadCount: typeof prev.unreadCount === 'number' ? prev.unreadCount : 0,
        previewLoaded: !!prev.previewLoaded,
        needsRefresh: !!prev.needsRefresh
    };
    threads.set(convId, entry);
    return entry;
}
