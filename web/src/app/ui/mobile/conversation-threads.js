/**
 * Conversation Threads Management Module
 * Extracted from messages-pane.js - handles conversation list state and rendering.
 */

import { log, logCapped } from '../../core/log.js';
import { normalizeAccountDigest, normalizePeerDeviceId, getAccountDigest as storeGetAccountDigest, getDeviceId as storeGetDeviceId } from '../../core/store.js';
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
import { listSecureMessages } from '../../api/messages.js';
import { buildDrAadFromHeader } from '../../crypto/dr.js';
import { b64u8 } from '../../crypto/nacl.js';
import { toU8Strict } from '/shared/utils/u8-strict.js';

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

    /**
     * Decrypt a single message using a server-provided vault key.
     * Mirrors the logic in vault-replay.js decryptWithMessageKey.
     */
    async function _decryptPreviewMessage(messageKeyB64, ivB64, ciphertextB64, header) {
        if (!messageKeyB64 || !ivB64 || !ciphertextB64) return null;
        const keyU8 = toU8Strict(b64u8(messageKeyB64), 'conversation-threads:preview-decrypt');
        const ivU8 = b64u8(ivB64);
        const ctU8 = b64u8(ciphertextB64);
        const key = await crypto.subtle.importKey('raw', keyU8, 'AES-GCM', false, ['decrypt']);
        const aad = header && typeof buildDrAadFromHeader === 'function'
            ? buildDrAadFromHeader(header)
            : null;
        const params = aad
            ? { name: 'AES-GCM', iv: ivU8, additionalData: aad }
            : { name: 'AES-GCM', iv: ivU8 };
        const ptBuf = await crypto.subtle.decrypt(params, key, ctU8);
        return new TextDecoder().decode(ptBuf);
    }

    /**
     * Resolve direction of a message relative to self.
     */
    function _resolvePreviewDirection(item, header, selfDeviceId, selfDigest) {
        const senderDeviceId = item?.sender_device_id || item?.senderDeviceId || header?.device_id || header?.meta?.sender_device_id || null;
        const targetDeviceId = item?.receiver_device_id || item?.receiverDeviceId || header?.meta?.receiver_device_id || null;
        const senderDigestRaw = item?.sender_account_digest || item?.senderAccountDigest || header?.meta?.sender_digest || null;
        const senderDigest = senderDigestRaw ? String(senderDigestRaw).toUpperCase() : null;

        if (targetDeviceId && selfDeviceId && targetDeviceId === selfDeviceId) return 'incoming';
        if (senderDeviceId && selfDeviceId && senderDeviceId === selfDeviceId) return 'outgoing';
        if (senderDigest && selfDigest && senderDigest === selfDigest) return 'outgoing';
        return 'incoming';
    }

    async function refreshConversationPreviews({ force = false, renderCallback } = {}) {
        const threadsMap = getConversationThreads();
        const threads = Array.from(threadsMap.values());
        const selfDeviceId = storeGetDeviceId();
        const selfDigest = storeGetAccountDigest();
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
                    // Lightweight fetch: only 1 message with vault keys
                    const { r, data } = await listSecureMessages({
                        conversationId: thread.conversationId,
                        limit: 1,
                        includeKeys: true
                    });
                    if (!r?.ok) {
                        thread.previewLoaded = true;
                        thread.lastMessageText = '(載入失敗)';
                        thread.needsRefresh = false;
                        return;
                    }
                    const items = Array.isArray(data?.items) ? data.items : [];
                    if (!items.length) {
                        thread.lastMessageText = '';
                        thread.lastMessageTs = null;
                        thread.lastMessageId = null;
                        thread.lastMsgType = null;
                        thread.lastDirection = null;
                        thread.previewLoaded = true;
                        thread.unreadCount = 0;
                        thread.needsRefresh = false;
                        return;
                    }
                    const latest = items[0];
                    const serverKeys = data?.keys || null;
                    const messageId = latest.id || latest.messageId || latest.message_id || null;

                    // Parse header
                    let header = latest.header || null;
                    if (!header && typeof latest.header_json === 'string') {
                        try { header = JSON.parse(latest.header_json); } catch { }
                    }

                    // Resolve direction
                    const direction = _resolvePreviewDirection(latest, header, selfDeviceId, selfDigest);

                    // Resolve message type from header
                    const msgType = header?.meta?.msg_type || header?.meta?.msgType || 'text';

                    // Resolve timestamp
                    const tsRaw = latest.created_at ?? latest.createdAt ?? latest.ts ?? null;
                    const ts = Number.isFinite(Number(tsRaw)) ? Number(tsRaw) : null;

                    // Try to find vault key for this message
                    const vaultEntry = messageId && serverKeys ? serverKeys[messageId] : null;
                    const messageKeyB64 = vaultEntry?.message_key_b64 || vaultEntry?.messageKeyB64 || null;
                    const ciphertextB64 = latest.ciphertext_b64 || latest.ciphertextB64 || null;
                    const ivB64 = header?.iv_b64 || null;

                    let text = null;
                    if (messageKeyB64 && ciphertextB64 && ivB64) {
                        // Has key → attempt decrypt
                        try {
                            text = await _decryptPreviewMessage(messageKeyB64, ivB64, ciphertextB64, header);
                        } catch (err) {
                            log({ previewDecryptFailed: err?.message, conversationId: thread.conversationId });
                            text = null;
                        }
                    }

                    // Format preview text
                    if (text && typeof text === 'string' && text.trim()) {
                        // Handle conversation-deleted or control messages
                        if (msgType === 'conversation-deleted') {
                            text = '尚無訊息';
                        } else if (text === 'CONTROL_SKIP') {
                            text = '系統訊息';
                        } else if (text.startsWith('{') || text.startsWith('[')) {
                            // Detect raw JSON payloads (e.g. contact-share, media)
                            try {
                                const parsed = JSON.parse(text);
                                const innerType = parsed?.type || parsed?.msgType || null;
                                if (innerType === 'contact-share' || innerType === 'contact_share') text = '已建立安全連線';
                                else if (innerType === 'media') text = '傳送了媒體';
                                else text = '有新訊息';
                            } catch { /* not JSON, keep original text */ }
                        }
                    } else {
                        // No key or decrypt failed
                        text = '訊息尚未解密🔐';
                    }

                    // Guard: don't overwrite a good Live Flow preview with a degraded one.
                    // If the thread already has the same message decrypted correctly,
                    // or already has a newer message, skip this update.
                    const existingTs = Number(thread.lastMessageTs) || 0;
                    const newTs = Number(ts) || 0;
                    if (thread.previewLoaded && existingTs > 0) {
                        if (newTs < existingTs) {
                            // Server has older message — keep newer Live Flow preview
                            thread.needsRefresh = false;
                            return;
                        }
                        if (thread.lastMessageId === messageId
                            && thread.lastMessageText
                            && thread.lastMessageText !== '訊息尚未解密🔐'
                            && thread.lastMessageText !== '(載入失敗)'
                            && text === '訊息尚未解密🔐') {
                            // Same message already decrypted — don't overwrite with failed decrypt
                            thread.needsRefresh = false;
                            return;
                        }
                    }

                    thread.lastMessageText = text;
                    thread.lastMessageTs = ts;
                    thread.lastMessageId = messageId;
                    thread.lastDirection = direction;
                    thread.lastMsgType = msgType;
                    thread.previewLoaded = true;
                    thread.needsRefresh = false;

                    if (thread.lastReadTs === null || thread.lastReadTs === undefined) {
                        thread.lastReadTs = ts;
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
