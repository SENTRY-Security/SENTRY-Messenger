/**
 * Conversation Threads Management Module
 * Extracted from messages-pane.js - handles conversation list state and rendering.
 */

import { log, logCapped } from '../../core/log.js';
import { normalizeAccountDigest, normalizePeerDeviceId } from '../../core/store.js';
import {
    normalizePeerKey,
    splitPeerKey,
    upsertContactCore,
    isCoreVaultReady,
    resolveReadyContactCoreEntry
} from './contact-core-store.js';
import { restorePendingInvites } from './session-store.js';
import { timelineGetTimeline } from '../../features/timeline-store.js';
import { messagesFlowFacade } from '../../features/messages-flow-facade.js';
import { escapeHtml } from './ui-utils.js';

/**
 * Create conversation threads manager.
 * @param {Object} deps - Dependencies
 * @param {Object} deps.sessionStore - Session store reference
 * @param {Function} deps.getMessageState - Message state getter
 * @param {Function} deps.logContactCoreWriteSkip - Contact core logging helper
 * @param {Function} deps.logReplayCallsite - Replay callsite logger
 * @param {Function} deps.logReplayGateTrace - Replay gate trace logger
 * @param {Function} deps.logReplayFetchResult - Replay fetch result logger
 * @returns {Object} Thread manager methods
 */
export function createConversationThreadsManager(deps) {
    const {
        sessionStore,
        getMessageState,
        logContactCoreWriteSkip,
        logReplayCallsite,
        logReplayGateTrace,
        logReplayFetchResult
    } = deps;

    let conversationIndexRestoredFromPending = false;

    function ensurePeerAccountDigest(source) {
        if (!source || typeof source !== 'object') return null;
        if (source.peerAccountDigest) {
            source.peerAccountDigest = normalizePeerKey(source.peerAccountDigest);
            return source.peerAccountDigest || null;
        }
        return null;
    }

    function threadPeer(thread) {
        if (!thread) return null;
        return normalizePeerKey(thread.peerAccountDigest ?? thread);
    }

    function ensureConversationIndex() {
        if (!(sessionStore.conversationIndex instanceof Map)) {
            const entries = sessionStore.conversationIndex && typeof sessionStore.conversationIndex.entries === 'function'
                ? Array.from(sessionStore.conversationIndex.entries())
                : [];
            sessionStore.conversationIndex = new Map(entries);
        }
        if (!conversationIndexRestoredFromPending) {
            conversationIndexRestoredFromPending = true;
            const pendingInvites = restorePendingInvites();
            const nowSec = Date.now();
            let restoredCount = 0;
            const sampleConversationIdsPrefix8 = [];
            if (pendingInvites instanceof Map) {
                for (const entry of pendingInvites.values()) {
                    const expiresAt = Number(entry?.expiresAt || 0);
                    if (!Number.isFinite(expiresAt) || expiresAt <= nowSec) continue;
                    const conversationId = typeof entry?.conversationId === 'string' ? entry.conversationId.trim() : '';
                    const conversationToken = typeof entry?.conversationToken === 'string' ? entry.conversationToken.trim() : '';
                    if (!conversationId || !conversationToken) continue;
                    const ownerAccountDigest = normalizeAccountDigest(entry?.ownerAccountDigest || null);
                    const ownerDeviceId = normalizePeerDeviceId(entry?.ownerDeviceId || null);
                    const prev = sessionStore.conversationIndex.get(conversationId) || {};
                    const next = { ...prev };
                    let changed = false;
                    if (!prev.token_b64) {
                        next.token_b64 = conversationToken;
                        changed = true;
                    }
                    if (!prev.peerAccountDigest && ownerAccountDigest) {
                        next.peerAccountDigest = ownerAccountDigest;
                        changed = true;
                    }
                    if (!prev.peerDeviceId && ownerDeviceId) {
                        next.peerDeviceId = ownerDeviceId;
                        changed = true;
                    }
                    if (!changed) continue;
                    sessionStore.conversationIndex.set(conversationId, next);
                    restoredCount += 1;
                    if (sampleConversationIdsPrefix8.length < 3) {
                        sampleConversationIdsPrefix8.push(conversationId.slice(0, 8));
                    }
                }
            }
            logCapped('conversationIndexRestoredFromPending', {
                restoredCount,
                sampleConversationIdsPrefix8,
                source: 'pendingInvites'
            }, 5);
        }
        return sessionStore.conversationIndex;
    }

    function getConversationThreads() {
        if (!(sessionStore.conversationThreads instanceof Map)) {
            const entries = sessionStore.conversationThreads && typeof sessionStore.conversationThreads.entries === 'function'
                ? Array.from(sessionStore.conversationThreads.entries())
                : [];
            sessionStore.conversationThreads = new Map(entries);
        }
        return sessionStore.conversationThreads;
    }

    function upsertConversationThread({ peerAccountDigest, peerDeviceId = null, conversationId, tokenB64, nickname, avatar }) {
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
            try { log({ conversationThreadSkip: { convId, peerAccountDigest: key, reason: 'missing-core' } }); } catch { }
            return prev || null;
        }
        if (!digestFromKey) {
            logContactCoreWriteSkip?.({
                callsite: 'conversation-threads:thread-upsert',
                conversationId: convId,
                hasDeviceId: !!resolvedPeerDeviceId
            });
            return prev || null;
        }
        upsertContactCore({
            peerAccountDigest: digestFromKey,
            peerDeviceId: resolvedPeerDeviceId,
            conversationId: convId,
            conversationToken: resolvedToken,
            nickname: nickname || null,
            avatar: avatar || null
        }, 'conversation-threads:thread-upsert');
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
            lastMsgType: prev.lastMsgType || null,
            lastReadTs: typeof prev.lastReadTs === 'number' ? prev.lastReadTs : null,
            unreadCount: typeof prev.unreadCount === 'number' ? prev.unreadCount : 0,
            previewLoaded: !!prev.previewLoaded,
            needsRefresh: !!prev.needsRefresh
        };
        threads.set(convId, entry);
        return entry;
    }

    function resolveTargetDeviceForConv(conversationId, peerAccountDigest = null) {
        const convId = String(conversationId || '').trim();
        if (!convId) return null;
        const threads = getConversationThreads();
        const thread = threads.get(convId) || null;
        if (thread?.peerDeviceId) return thread.peerDeviceId;
        const convIndex = ensureConversationIndex();
        const convEntry = convIndex.get(convId) || null;
        if (convEntry?.peerDeviceId) return convEntry.peerDeviceId;
        if (convEntry?.peerAccountDigest && peerAccountDigest && convEntry.peerAccountDigest !== peerAccountDigest) {
            return null;
        }
        const state = getMessageState();
        if (state.activePeerDigest && (!peerAccountDigest || state.activePeerDigest === peerAccountDigest)) {
            if (state.activePeerDeviceId) return state.activePeerDeviceId;
        }
        return null;
    }

    function syncConversationThreadsFromContacts() {
        const threads = getConversationThreads();
        const contacts = Array.isArray(sessionStore.contactState) ? sessionStore.contactState : [];
        const seen = new Set();
        for (const contact of contacts) {
            const peerDigest = ensurePeerAccountDigest(contact);
            const conversationId = contact?.conversation?.conversation_id;
            const tokenB64 = contact?.conversation?.token_b64;
            const peerDeviceId = contact?.conversation?.peerDeviceId || null;
            if (!peerDigest || !conversationId || !tokenB64) continue;
            seen.add(conversationId);
            upsertConversationThread({
                peerAccountDigest: peerDigest,
                peerDeviceId,
                conversationId,
                tokenB64,
                nickname: contact.nickname,
                avatar: contact.avatar || null
            });
        }
        for (const convId of Array.from(threads.keys())) {
            if (!seen.has(convId)) threads.delete(convId);
        }
        return threads;
    }

    async function refreshConversationPreviews({ force = false, renderCallback } = {}) {
        const threadsMap = getConversationThreads();
        const threads = Array.from(threadsMap.values());
        const tasks = [];
        for (const thread of threads) {
            const peerDigest = threadPeer(thread);
            if (!thread?.conversationId || !thread?.conversationToken || !peerDigest || !thread?.peerDeviceId) {
                if (!thread?.peerDeviceId) {
                    try { log({ previewSkipMissingPeerDevice: thread?.conversationId || null }); } catch { }
                }
                continue;
            }
            if (!force && thread.previewLoaded && !thread.needsRefresh) continue;
            tasks.push((async () => {
                try {
                    logReplayCallsite?.('refreshConversationPreviews', {
                        conversationId: thread.conversationId,
                        replay: false,
                        allowReplay: false,
                        mutateState: false,
                        silent: true,
                        limit: 20,
                        cursorTs: null,
                        cursorId: null
                    });
                    logReplayGateTrace?.('conversation-threads:refreshConversationPreviews', {
                        conversationId: thread.conversationId,
                        allowReplay: false,
                        mutateState: false,
                        replay: false,
                        silent: true,
                        messageId: null,
                        serverMessageId: null
                    });
                    const previewResult = await messagesFlowFacade.onScrollFetchMore({
                        conversationId: thread.conversationId,
                        tokenB64: thread.conversationToken,
                        peerAccountDigest: peerDigest,
                        peerDeviceId: thread.peerDeviceId,
                        options: {
                            limit: 20,
                            mutateState: false,
                            sendReadReceipt: false,
                            onMessageDecrypted: null,
                            silent: true,
                            sourceTag: 'conversation-threads:refreshConversationPreviews'
                        }
                    });
                    logReplayFetchResult?.({
                        conversationId: thread.conversationId,
                        itemsLength: Array.isArray(previewResult?.items) ? previewResult.items.length : null,
                        serverItemCount: previewResult?.serverItemCount ?? null,
                        nextCursorTs: previewResult?.nextCursor?.ts ?? previewResult?.nextCursorTs ?? null,
                        nextCursorId: previewResult?.nextCursor?.id ?? null,
                        errorsLength: Array.isArray(previewResult?.errors) ? previewResult.errors.length : null
                    });
                    const timeline = timelineGetTimeline(thread.conversationId);
                    const list = Array.isArray(timeline) ? timeline : [];
                    if (!list.length) {
                        thread.lastMessageText = '';
                        thread.lastMessageTs = null;
                        thread.lastMessageId = null;
                        thread.lastMsgType = null;
                        thread.previewLoaded = true;
                        thread.unreadCount = 0;
                        if (thread.lastReadTs === null) thread.lastReadTs = null;
                        thread.needsRefresh = false;
                        return;
                    }
                    const latest = list[list.length - 1];
                    let text = typeof latest.text === 'string' && latest.text.trim() ? latest.text : (latest.error || '(無法解密)');
                    let type = latest.msgType || latest.subtype || 'text';

                    // [Fix] Handle CONTROL_SKIP and hidden messages
                    if (text === 'CONTROL_SKIP' || latest.error === 'CONTROL_SKIP') {
                        if (type === 'conversation-deleted') {
                            text = '尚無訊息';
                        } else {
                            text = '系統訊息';
                        }
                    } else if (type === 'conversation-deleted') {
                        text = '尚無訊息';
                    }

                    thread.lastMessageText = text;
                    thread.lastMessageTs = typeof latest.ts === 'number' ? latest.ts : null;
                    thread.lastMessageId = latest.id || latest.messageId || null;
                    thread.lastDirection = latest.direction || null;
                    thread.lastMsgType = type; // Capture type
                    thread.previewLoaded = true;
                    thread.needsRefresh = false;
                    if (thread.lastReadTs === null || thread.lastReadTs === undefined) {
                        thread.lastReadTs = thread.lastMessageTs ?? null;
                        thread.unreadCount = 0;
                    } else if (typeof thread.lastReadTs === 'number') {
                        const unread = list.filter((item) => typeof item?.ts === 'number' && item.ts > thread.lastReadTs && item.direction === 'incoming').length;
                        thread.unreadCount = unread;
                    } else {
                        thread.lastReadTs = thread.lastMessageTs ?? null;
                        thread.unreadCount = 0;
                    }
                } catch (err) {
                    thread.previewLoaded = true;
                    thread.lastMessageText = '(載入失敗)';
                    log({ conversationPreviewError: err?.message || err, conversationId: thread?.conversationId });
                } finally {
                    thread.needsRefresh = false;
                }
            })());
        }

        if (!tasks.length) {
            if (force) renderCallback?.();
            return;
        }

        await Promise.allSettled(tasks);
        renderCallback?.();
    }

    function formatThreadPreview(thread) {
        // [FIX] Handle Deleted Conversation Tombstone
        if (thread.lastMsgType === 'conversation-deleted') {
            return '尚無訊息';
        }

        const raw = thread.lastMessageText || '';
        const maxLen = 50;
        let text = raw.trim();
        if (text.length > maxLen) text = text.slice(0, maxLen) + '…';
        const snippet = text || (thread.lastMessageTs ? '' : '尚無訊息');
        if (!snippet) return '';
        if (thread.lastDirection === 'outgoing') {
            return `你：${snippet}`;
        }
        return snippet;
    }

    function getThreadsForRender() {
        return Array.from(getConversationThreads().values())
            .filter((thread) => thread?.conversationId && threadPeer(thread))
            .sort((a, b) => (b.lastMessageTs || 0) - (a.lastMessageTs || 0));
    }

    function computeTotalUnread() {
        return getThreadsForRender().reduce((sum, thread) => sum + Number(thread.unreadCount || 0), 0);
    }

    return {
        ensureConversationIndex,
        getConversationThreads,
        upsertConversationThread,
        resolveTargetDeviceForConv,
        syncConversationThreadsFromContacts,
        refreshConversationPreviews,
        formatThreadPreview,
        getThreadsForRender,
        computeTotalUnread,
        threadPeer,
        ensurePeerAccountDigest
    };
}
