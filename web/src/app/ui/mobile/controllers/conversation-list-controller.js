/**
 * ConversationListController
 * Manages conversation list rendering, pull-to-refresh, and interaction.
 */

import { BaseController } from './base-controller.js';

import { normalizePeerKey, splitPeerKey, resolveReadyContactCoreEntry, isCoreVaultReady, listReadyContacts, upsertContactCore } from '../contact-core-store.js';
import { normalizeAccountDigest, normalizePeerDeviceId } from '../../../core/store.js';
import { restorePendingInvites } from '../session-store.js';
import { escapeHtml } from '../ui-utils.js';
import { extractMessageTimestampMs, normalizeMsgTypeValue, deriveMessageDirectionFromEnvelopeMeta, normalizeTimelineMessageId } from '../../../features/messages/parser.js';
import { getLocalProcessedCounter } from '../../features/messages-flow/local-counter.js'; // [FIX] Import unread counter logic
import { listSecureMessages as apiListSecureMessages } from '../../../api/messages.js';

const CONV_PULL_THRESHOLD = 60;
const CONV_PULL_MAX = 100;

export class ConversationListController extends BaseController {
    constructor(deps) {
        super(deps);
        this.conversationPullDistance = 0;
        this.conversationPullTracking = false;
        this.conversationPullDecided = false;
        this.conversationPullStartY = 0;
        this.conversationPullStartX = 0;
        this.conversationPullInvalid = false;
        this.conversationsRefreshing = false;
    }

    /**
     * Ensure conversation index map exists and is restored from pending invites if needed.
     */
    ensureConversationIndex() {
        if (!(this.deps.sessionStore.conversationIndex instanceof Map)) {
            const entries = this.deps.sessionStore.conversationIndex && typeof this.deps.sessionStore.conversationIndex.entries === 'function'
                ? Array.from(this.deps.sessionStore.conversationIndex.entries())
                : [];
            this.deps.sessionStore.conversationIndex = new Map(entries);
        }
        // We might need to track if restored locally in the controller instance
        if (!this._conversationIndexRestored) {
            this._conversationIndexRestored = true;
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
                    const prev = this.deps.sessionStore.conversationIndex.get(conversationId) || {};
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
                    this.deps.sessionStore.conversationIndex.set(conversationId, next);
                    restoredCount += 1;
                    if (sampleConversationIdsPrefix8.length < 3) {
                        sampleConversationIdsPrefix8.push(conversationId.slice(0, 8));
                    }
                }
            }
            this.deps.logCapped?.('conversationIndexRestoredFromPending', {
                restoredCount,
                sampleConversationIdsPrefix8,
                source: 'pendingInvites'
            }, 5);
        }
        return this.deps.sessionStore.conversationIndex;
    }

    /**
     * Get conversation threads map.
     */
    getThreads() {
        if (!(this.deps.sessionStore.conversationThreads instanceof Map)) {
            const entries = this.deps.sessionStore.conversationThreads && typeof this.deps.sessionStore.conversationThreads.entries === 'function'
                ? Array.from(this.deps.sessionStore.conversationThreads.entries())
                : [];
            this.deps.sessionStore.conversationThreads = new Map(entries);
        }
        return this.deps.sessionStore.conversationThreads;
    }

    /**
     * Upsert a conversation thread entry.
     */
    upsertThread({ peerAccountDigest, peerDeviceId = null, conversationId, tokenB64, nickname, avatar, lastMsgType = null }) {
        const key = normalizePeerKey(peerAccountDigest);
        const convId = String(conversationId || '').trim();
        if (!key || !convId) return null;
        if (this.deps.sessionStore.deletedConversations?.has?.(convId)) return null;

        const threads = this.getThreads();
        const prev = threads.get(convId) || {};
        const { digest: digestFromKey, deviceId: deviceFromKey } = splitPeerKey(key);
        const resolvedPeerDeviceId = normalizePeerDeviceId(peerDeviceId || deviceFromKey || prev.peerDeviceId || null);
        const resolvedToken = tokenB64 || prev.conversationToken || null;

        if (!resolvedPeerDeviceId || !resolvedToken) {
            try { this.deps.log?.({ conversationThreadSkip: { convId, peerAccountDigest: key, reason: 'missing-core' } }); } catch { }
            return prev || null;
        }

        if (!digestFromKey) {
            // logContactCoreWriteSkip equivalent
            if (this.deps.contactCoreVerbose) {
                try {
                    console.warn('[contact-core] ui:write-skip ' + JSON.stringify({
                        reason: 'missing-digest',
                        callsite: 'messages-pane:thread-upsert',
                        conversationId: convId,
                        hasDeviceId: !!resolvedPeerDeviceId
                    }));
                } catch { }
            }
            return prev || null;
        }

        upsertContactCore({
            peerAccountDigest: digestFromKey,
            peerDeviceId: resolvedPeerDeviceId,
            conversationId: convId,
            conversationToken: resolvedToken,
            nickname: nickname || null,
            avatar: avatar || null
        }, 'messages-pane:thread-upsert');

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
            lastMsgType: lastMsgType || prev.lastMsgType || null,
            lastReadTs: typeof prev.lastReadTs === 'number' ? prev.lastReadTs : null,
            unreadCount: typeof prev.unreadCount === 'number' ? prev.unreadCount : 0,
            offlineUnreadCount: typeof prev.offlineUnreadCount === 'number' ? prev.offlineUnreadCount : 0,
            previewLoaded: !!prev.previewLoaded,
            needsRefresh: !!prev.needsRefresh
        };
        threads.set(convId, entry);
        return entry;
    }

    /**
     * Sync threads from ready contacts.
     */
    syncFromContacts() {
        const threads = this.getThreads();
        const contacts = Array.isArray(this.deps.sessionStore.contactState) ? this.deps.sessionStore.contactState : [];
        const seen = new Set();

        // Helper ensurePeerAccountDigest
        const ensurePeerAccountDigest = (source) => {
            if (!source || typeof source !== 'object') return null;
            let raw = source.peerAccountDigest;
            if (typeof raw === 'string') {
                if (raw.includes('::')) {
                    raw = raw.split('::')[0];
                }
                const digest = normalizeAccountDigest(raw);
                if (digest) {
                    source.peerAccountDigest = digest;
                    return digest;
                }
            }
            return null;
        };

        if (contacts.length > 0) {
            console.log('[ConvList] syncFromContacts', { count: contacts.length });
        }

        for (const contact of contacts) {
            const peerDigest = ensurePeerAccountDigest(contact);
            const conversationId = contact?.conversation?.conversation_id;
            const tokenB64 = contact?.conversation?.token_b64;
            const peerDeviceId = contact?.conversation?.peerDeviceId || null;

            if (!peerDigest || !conversationId || !tokenB64) {
                if (this.deps.contactCoreVerbose || true) { // Force log for debug
                    console.log('[ConvList] Skip contact', {
                        nick: contact.nickname,
                        hasDigest: !!peerDigest,
                        hasConvId: !!conversationId,
                        hasToken: !!tokenB64,
                        rawDigest: contact.peerAccountDigest
                    });
                }
                continue;
            }
            seen.add(conversationId);
            this.upsertThread({
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
     * Resolve target device ID for a conversation.
     */
    resolveTargetDevice(conversationId, peerAccountDigest = null) {
        const convId = String(conversationId || '').trim();
        if (!convId) return null;
        const threads = this.getThreads();
        const thread = threads.get(convId) || null;
        if (thread?.peerDeviceId) return thread.peerDeviceId;

        const convIndex = this.ensureConversationIndex();
        const convEntry = convIndex.get(convId) || null;
        if (convEntry?.peerDeviceId) return convEntry.peerDeviceId;

        if (convEntry?.peerAccountDigest && peerAccountDigest && convEntry.peerAccountDigest !== peerAccountDigest) {
            return null;
        }

        const state = this.getMessageState();
        if (state.activePeerDigest && (!peerAccountDigest || state.activePeerDigest === peerAccountDigest)) {
            if (state.activePeerDeviceId) return state.activePeerDeviceId;
        }
        return null;
    }

    /**
     * Refresh conversation previews by fetching latest messages.
     */
    async refreshPreviews({ force = false } = {}) {
        const threadsMap = this.getThreads();
        const threads = Array.from(threadsMap.values());

        // [FIX] Parallel Fetch Config (Batch size 5)
        const CHUNK_SIZE = 5;
        const threadChunks = [];
        for (let i = 0; i < threads.length; i += CHUNK_SIZE) {
            threadChunks.push(threads.slice(i, i + CHUNK_SIZE));
        }

        if (this.deps.contactCoreVerbose) {
            console.log(`[ConvList] refreshPreviews starting. Threads: ${threads.length}, Chunks: ${threadChunks.length}`);
        }
        console.time('[ConvList] refreshPreviews duration');

        for (const [chunkIdx, chunk] of threadChunks.entries()) {
            await Promise.all(chunk.map(async (thread) => {
                const peerDigest = this._threadPeer(thread);
                if (!thread?.conversationId || !thread?.conversationToken || !peerDigest || !thread?.peerDeviceId) {
                    if (!thread?.peerDeviceId) {
                        try { this.deps.log?.({ previewSkipMissingPeerDevice: thread?.conversationId || null }); } catch { }
                    }
                    return;
                }
                if (!force && thread.previewLoaded && !thread.needsRefresh) return;

                try {
                    // Assuming apiListSecureMessages is available (need to verify import)
                    if (typeof apiListSecureMessages !== 'function') {
                        console.warn('apiListSecureMessages not available');
                        return;
                    }

                    const result = await apiListSecureMessages({
                        conversationId: thread.conversationId,
                        limit: 20 // [FIX] Fetch more to find last valid content
                    });

                    const messages = result?.data?.items || [];
                    if (!messages.length) return;

                    // [FIX] Calculate Unread Count (Server Max - Local Read)
                    try {
                        // API returns DESC (Newest First). messages[0] is the latest.
                        const serverMax = messages[0]?.counter || 0;
                        const localRead = await getLocalProcessedCounter({ conversationId: thread.conversationId });
                        const unread = Math.max(0, serverMax - localRead);

                        // Update unread count immediately
                        const t = threadsMap.get(thread.conversationId);
                        if (t) {
                            t.unreadCount = unread;
                            // threadsMap.set(thread.conversationId, t); // Ref update
                        }
                    } catch (err) {
                        console.warn('[ConvList] Unread calc failed', err);
                    }

                    // [FIX] Preview Logic: Iterate Newest -> Oldest (Standard behavior)
                    // Do NOT reverse. API provides DESC. We want the first valid Match.

                    let previewMsg = null;
                    let isDeleted = false;
                    let skippedCount = 0;

                    for (const msg of messages) {
                        const payload = msg.payload || {};
                        // [FIX] Fallback for encrypted messages (payload missing)
                        let type = normalizeMsgTypeValue(payload.type);
                        if (!type && msg.header) {
                            // Try parsing header if string
                            let header = msg.header;
                            if (typeof header === 'string') {
                                try { header = JSON.parse(header); } catch { }
                            }
                            type = normalizeMsgTypeValue(header?.meta?.msgType || header?.meta?.msg_type);
                        }

                        if (type === 'conversation-deleted') {
                            isDeleted = true;
                            break;
                        }

                        // Skip control messages
                        const isControl = type === 'sys' || type === 'system' || type === 'control' ||
                            (type && ['profile-update', 'session-init', 'session-ack'].includes(type));

                        if (isControl) {
                            skippedCount++;
                            continue;
                        }

                        // Ensure it's content
                        if (type && ['text', 'media', 'call-log', 'call_log', 'contact-share'].includes(type)) {
                            previewMsg = msg;
                            break; // Found newest valid content
                        } else {
                            // If type is unknown/encrypted but has ciphertext, treat as text/encrypted preview
                            if (!type && msg.ciphertext_b64) {
                                previewMsg = msg; // Treat as encrypted content
                                break;
                            }
                            skippedCount++;
                        }
                    }

                    let text = '尚無訊息';
                    let type = null;
                    let ts = null;
                    let direction = null;

                    if (isDeleted) {
                        text = '尚無訊息';
                        type = 'conversation-deleted';
                        ts = extractMessageTimestampMs(messages[0] || {});
                    } else if (previewMsg) {
                        const payload = previewMsg.payload || {};
                        const meta = previewMsg.meta || {}; // Note: Valid even if encrypted if we parse header... wait meta is from PayloadWrapper usually.
                        // If encrypted, we construct meta from header
                        let header = previewMsg.header;
                        if (typeof header === 'string') { try { header = JSON.parse(header); } catch { } }

                        const effectiveMeta = meta.sender ? meta : (header?.meta || {});

                        // Resolve type again
                        type = normalizeMsgTypeValue(payload.type || effectiveMeta.msgType || effectiveMeta.msg_type || 'text'); // Default to text if encrypted
                        ts = extractMessageTimestampMs(previewMsg);

                        const sender = normalizePeerKey(effectiveMeta.sender || previewMsg.sender_device_id); // Fallback to device ID if sender missing? No, sender_account_digest usually available in row.
                        // Actually row has sender_account_digest.
                        const senderDigest = previewMsg.sender_account_digest;

                        direction = senderDigest === this.deps.sessionStore.activePeerDigest ? 'incoming' : 'outgoing';
                        // Wait, activePeerDigest is the OTHER person.
                        // sending to me -> Incoming.
                        // senderDigest == activePeerDigest -> Incoming.
                        // senderDigest == MY_DIGEST -> Outgoing.

                        if (type === 'text') {
                            text = payload.text || (previewMsg.ciphertext_b64 ? '🔒 加密訊息' : '文字訊息');
                        } else if (type === 'media') {
                            const mime = (payload.contentType || payload.mimeType || '').toLowerCase();
                            if (mime.startsWith('image/')) {
                                text = '[圖片]';
                            } else if (mime.startsWith('video/')) {
                                text = '[影片]';
                            } else {
                                text = `[檔案] ${payload.filename || payload.name || '附件'}`;
                            }
                        } else if (type === 'call_log' || type === 'call-log') {
                            text = '[通話紀錄]';
                        } else if (type === 'contact-share') {
                            text = '[系統] 您已與對方成為好友';
                        } else {
                            text = previewMsg.ciphertext_b64 ? '🔒 加密訊息' : '新訊息';
                        }
                    } else {
                        // Fallback logging
                    }

                    const currentThread = threadsMap.get(thread.conversationId);
                    if (!currentThread) return;

                    const currentTs = currentThread.lastMessageTs || 0;
                    const newTs = ts || 0;

                    // Update if newer OR if we never had a preview
                    if (newTs >= currentTs || !currentThread.previewLoaded) {
                        currentThread.lastMessageText = text;
                        currentThread.lastMessageTs = ts;
                        currentThread.lastMessageId = previewMsg ? normalizeTimelineMessageId(previewMsg) : null;
                        currentThread.lastDirection = direction;
                        currentThread.lastMsgType = type;
                        currentThread.previewLoaded = true;
                        currentThread.needsRefresh = false;

                        // Force re-render of this item? 
                        // The loop calls renderConversationList() at the end.
                    }
                } catch (err) {
                    console.error('Preview refresh failed', err);
                }
            }));

            // [FIX] Progressive Render: Update UI after each chunk so user sees progress
            this.renderConversationList();
        }

        console.timeEnd('[ConvList] refreshPreviews duration');
    }

    /**
     * Sync thread preview from active messages.
     */
    syncThreadFromActiveMessages() {
        const state = this.deps.getMessageState();
        if (!state.conversationId || !state.activePeerDigest) return;
        const timeline = state.messages || [];
        if (!timeline.length) return;

        const lastMsg = timeline[timeline.length - 1];
        const text = lastMsg.text || (lastMsg.media ? `[檔案] ${lastMsg.media.name || '附件'}` : '...');
        const msgType = lastMsg.msgType || lastMsg.subtype || 'text';
        const ts = lastMsg.ts || Date.now();

        this.upsertThread({
            peerAccountDigest: state.activePeerDigest,
            peerDeviceId: state.activePeerDeviceId,
            conversationId: state.conversationId,
            tokenB64: state.conversationToken,
            lastMsgType: msgType
        });

        // Upsert thread helper above doesn't set text automatically from args (it copies prev), 
        // so we must manually update it if we want to sync real-time content.
        // Or we can modify upsertThread to accept text/ts.
        // Actually, upsertThread defined above takes nick/avatar only.

        const threads = this.getThreads();
        const thread = threads.get(state.conversationId);
        if (thread) {
            thread.lastMessageText = msgType === 'conversation-deleted' ? '尚無訊息' : text;
            thread.lastMessageTs = ts;
            thread.lastMsgType = msgType;
            thread.lastDirection = lastMsg.direction;
            threads.set(state.conversationId, thread);
        }
    }

    /**
     * Refresh unread badges on contacts.
     */
    refreshUnreadBadges() {
        const contactState = this.deps.sessionStore.contactState;
        if (!Array.isArray(contactState) || !contactState.length) return;

        const threads = this.getThreads();
        for (const contact of contactState) {
            const key = this._contactPeerKey(contact);
            if (!key) continue;
            const thread = threads.get(contact?.conversation?.conversation_id || '') || null;
            const unread = thread?.unreadCount || 0;

            const contactEntry = this.deps.sessionStore.contactIndex?.get?.(key);
            if (contactEntry) {
                if (typeof contactEntry.unreadCount !== 'number') contactEntry.unreadCount = 0;
                contactEntry.unreadCount = unread;
            }
        }
    }

    /**
     * Get thread peer key.
     */
    /**
     * Get thread peer key.
     */
    _threadPeer(thread) {
        if (!thread) return null;
        if (thread.peerKey) return thread.peerKey;
        if (thread.peerAccountDigest && thread.peerDeviceId) {
            return `${thread.peerAccountDigest}::${thread.peerDeviceId}`;
        }
        return normalizePeerKey(thread.peerAccountDigest ?? thread);
    }

    /**
     * Get contact peer key.
     */
    _contactPeerKey(contact) {
        if (!contact) return null;
        return normalizePeerKey(contact.peerAccountDigest || contact.accountDigest || null);
    }

    /**
     * Get initials from name.
     */
    getInitials(name, fallback) {
        return this._initialsFromName(name, fallback);
    }

    /**
     * Generate initials from name (internal).
     */
    _initialsFromName(name, fallback) {
        if (!name) return (fallback || '?').slice(-2).toUpperCase();
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return name.slice(0, 2).toUpperCase();
    }

    /**
     * Format timestamp for conversation preview.
     */
    _formatConversationPreviewTime(ts) {
        if (!Number.isFinite(ts)) return '';
        const date = new Date(ts);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        if (isToday) {
            return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
        }
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) {
            return '昨天';
        }
        return date.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' });
    }

    /**
     * Build conversation snippet from text.
     */
    _buildConversationSnippet(text) {
        if (!text || typeof text !== 'string') return '';
        const cleaned = text.replace(/\n+/g, ' ').trim();
        return cleaned.length > 50 ? cleaned.slice(0, 50) + '…' : cleaned;
    }

    /**
     * Format thread preview text.
     */
    formatThreadPreview(thread) {
        // [FIX] Explicit handling if type is present
        if (thread.lastMsgType === 'conversation-deleted' || thread.lastMsgType === 'conversation_deleted') {
            return '尚無訊息';
        }

        const raw = thread.lastMessageText || '';
        const snippet = this._buildConversationSnippet(raw) || (thread.lastMessageTs ? '' : '尚無訊息');
        if (!snippet) return '';
        if (thread.lastDirection === 'outgoing') {
            return `你：${snippet}`;
        }
        return snippet;
    }

    /**
     * Apply pull transition animation.
     */
    applyConversationPullTransition(enable) {
        const transition = enable ? 'transform 120ms ease-out, opacity 120ms ease-out' : 'none';
        if (this.elements.conversationRefreshEl) {
            this.elements.conversationRefreshEl.style.transition = transition;
        }
        if (this.elements.conversationList) {
            this.elements.conversationList.style.transition = enable ? 'transform 120ms ease-out' : 'none';
        }
    }

    /**
     * Update pull-to-refresh visual state.
     */
    updateConversationPull(offset) {
        const clamped = Math.min(CONV_PULL_MAX, Math.max(0, offset));
        const progress = Math.min(1, clamped / CONV_PULL_THRESHOLD);
        if (this.elements.conversationRefreshEl) {
            const fadeStart = 5;
            const fadeRange = 25;
            const alpha = Math.min(1, Math.max(0, (clamped - fadeStart) / fadeRange));
            this.elements.conversationRefreshEl.style.opacity = String(alpha);
            this.elements.conversationRefreshEl.style.transform = 'translateY(0)';
            const spinner = this.elements.conversationRefreshEl.querySelector('.icon');
            const labelEl = this.elements.conversationRefreshLabelEl || this.elements.conversationRefreshEl.querySelector('.label');
            if (spinner && labelEl) {
                if (this.conversationsRefreshing) {
                    spinner.classList.add('spin');
                    labelEl.textContent = '刷新中…';
                } else {
                    spinner.classList.remove('spin');
                    labelEl.textContent = clamped >= CONV_PULL_THRESHOLD ? '鬆開更新對話列表' : '下拉更新對話';
                }
            }
        }
        if (this.elements.conversationList) {
            this.elements.conversationList.style.transform = `translateY(${clamped}px)`;
        }
    }

    /**
     * Reset pull-to-refresh state.
     */
    resetConversationPull({ animate = true } = {}) {
        this.conversationPullDistance = 0;
        this.applyConversationPullTransition(animate);
        this.updateConversationPull(0);
    }

    /**
     * Handle pull-to-refresh trigger.
     */
    async handleConversationRefresh() {
        if (this.conversationsRefreshing) return;
        this.conversationsRefreshing = true;
        this.updateConversationPull(CONV_PULL_THRESHOLD);
        try {
            this.deps.syncConversationThreadsFromContacts?.();
            await this.deps.refreshConversationPreviews?.({ force: true });
            this.renderConversationList();
        } catch (err) {
            this.log({ conversationPullRefreshError: err?.message || err });
        } finally {
            this.conversationsRefreshing = false;
            this.resetConversationPull({ animate: true });
        }
    }

    /**
     * Handle touch start for pull-to-refresh.
     */
    handleConversationPullStart(e) {
        if (!this.elements.conversationList) return;
        if (this.elements.conversationList.scrollTop > 0) {
            this.conversationPullInvalid = true;
            return;
        }
        this.conversationPullInvalid = false;
        if (e.touches?.length !== 1) return;
        this.conversationPullTracking = true;
        this.conversationPullDecided = false;
        this.conversationPullStartY = e.touches[0].clientY;
        this.conversationPullStartX = e.touches[0].clientX;
        this.conversationPullDistance = 0;
        this.applyConversationPullTransition(false);
    }

    /**
     * Handle touch move for pull-to-refresh.
     */
    handleConversationPullMove(e) {
        if (!this.conversationPullTracking || this.conversationPullInvalid || this.conversationsRefreshing) return;
        if (e.touches?.length !== 1) return;
        console.log('[ConvPull] move check', { y: e.touches[0].clientY, startY: this.conversationPullStartY, tracking: this.conversationPullTracking });
        const dy = e.touches[0].clientY - this.conversationPullStartY;
        const dx = Math.abs(e.touches[0].clientX - this.conversationPullStartX);
        if (!this.conversationPullDecided) {
            if (Math.abs(dy) < 8 && dx < 8) return;
            this.conversationPullDecided = true;
            if (dy <= 0 || dy < Math.abs(dx)) {
                this.conversationPullTracking = false;
                this.conversationPullInvalid = true;
                this.resetConversationPull({ animate: true });
                return;
            }
        }
        this.conversationPullDistance = dy;
        if (this.conversationPullDistance > 0) {
            e.preventDefault();
            this.updateConversationPull(this.conversationPullDistance);
        }
    }

    /**
     * Handle touch end for pull-to-refresh.
     */
    handleConversationPullEnd() {
        if (!this.conversationPullTracking) return;
        this.conversationPullTracking = false;
        if (this.conversationsRefreshing) return;
        if (this.conversationPullInvalid) {
            this.resetConversationPull({ animate: true });
            return;
        }
        if (this.conversationPullDistance >= CONV_PULL_THRESHOLD) {
            this.handleConversationRefresh();
        } else {
            this.resetConversationPull({ animate: true });
        }
    }

    /**
     * Render the conversation list.
     */
    renderConversationList() {
        if (!this.elements.conversationList) return;
        const openPeer = this.elements.conversationList.querySelector('.conversation-item.show-delete')?.dataset?.peer || null;
        const contacts = Array.isArray(this.sessionStore.contactState) ? [...this.sessionStore.contactState] : [];
        let state = this.getMessageState();

        // Handle active peer removed from contacts
        if (state.activePeerDigest) {
            const exists = contacts.some((c) => this._contactPeerKey(c) === state.activePeerDigest);
            if (!exists) {
                const { digest: activeDigest, deviceId: activeDeviceId } = splitPeerKey(state.activePeerDigest || null);
                const resolvedActiveDeviceId = activeDeviceId || state.activePeerDeviceId || null;
                const resolvedCore = resolveReadyContactCoreEntry(state.activePeerDigest, resolvedActiveDeviceId, state.conversationId);
                const activeCoreEntry = resolvedCore.entry;
                const hasCore = !!activeCoreEntry;
                const isCoreReady = !!activeCoreEntry?.isReady;
                const coreHasConversation = !!activeCoreEntry?.conversationId && !!activeCoreEntry?.conversationToken;
                const coreVaultReady = isCoreVaultReady(resolvedCore.peerKey || state.activePeerDigest, resolvedActiveDeviceId, state.conversationId);
                const shouldKeepActivePeer = (hasCore && isCoreReady && coreHasConversation) || coreVaultReady;
                const hasActiveConversation = !!(state.conversationId && state.conversationToken);
                const isViewingMessages = this.deps.isDesktopLayout?.() || state.viewMode === 'detail';
                const activationInFlight = state.loading || this.deps.pendingSecureReadyPeer === state.activePeerDigest;

                if (!shouldKeepActivePeer && (!hasActiveConversation || (!isViewingMessages && !activationInFlight))) {
                    this.deps.resetMessageStateWithPlaceholders?.();
                    state = this.getMessageState();
                    if (!this.deps.isDesktopLayout?.()) state.viewMode = 'list';
                    if (this.elements.peerName) this.elements.peerName.textContent = '選擇好友開始聊天';
                    this.deps.setMessagesStatus?.('');
                    this.deps.clearMessagesView?.();
                    this.deps.updateComposerAvailability?.();
                    this.deps.applyMessagesLayout?.();
                }
            }
        }

        // Use local sync method which has robust Digest/Key handling
        this.syncFromContacts();
        this.deps.refreshContactsUnreadBadges?.();
        this.elements.conversationList.innerHTML = '';

        const threads = this.deps.getConversationThreads?.() || new Map();
        const threadEntries = Array.from(threads.values())
            .filter((thread) => thread?.conversationId && this._threadPeer(thread))
            .sort((a, b) => (b.lastMessageTs || 0) - (a.lastMessageTs || 0));

        const totalUnread = threadEntries.reduce((sum, thread) => sum + Number(thread.unreadCount || 0) + Number(thread.offlineUnreadCount || 0), 0);
        this.deps.updateNavBadge?.('messages', totalUnread > 0 ? totalUnread : null);

        console.log('[ConvList] render', {
            threadsSize: threads.size,
            entriesCount: threadEntries.length,
            html: this.elements.conversationList ? 'exists' : 'missing'
        });

        if (!threadEntries.length) {
            const li = document.createElement('li');
            li.className = 'conversation-item disabled';
            li.innerHTML = `<div class="conversation-empty">尚未有任何訊息</div>`;
            this.elements.conversationList.appendChild(li);
            return;
        }

        for (const thread of threadEntries) {
            const peerDigest = this._threadPeer(thread);
            if (!peerDigest) continue;

            const li = document.createElement('li');
            li.className = 'conversation-item';
            li.style.touchAction = 'pan-y'; // Force browser to handle vertical only, JS horizontal
            li.dataset.peer = peerDigest;
            li.dataset.conversationId = thread.conversationId;
            if (thread.peerDeviceId) li.dataset.peerDeviceId = thread.peerDeviceId;

            const isActivePeer = state.activePeerDigest === peerDigest;
            const isActiveDevice = !state.activePeerDeviceId || !thread.peerDeviceId || state.activePeerDeviceId === thread.peerDeviceId;
            if (isActivePeer && isActiveDevice) li.classList.add('active');
            if (openPeer && openPeer === peerDigest) li.classList.add('show-delete');

            const nickname = thread.nickname || `好友 ${peerDigest.slice(-4)}`;
            const initials = this._initialsFromName(nickname, peerDigest);
            const avatarSrc = thread.avatar?.thumbDataUrl || thread.avatar?.previewDataUrl || thread.avatar?.url || null;
            const timeLabel = this._formatConversationPreviewTime(thread.lastMessageTs);
            const snippet = this.formatThreadPreview(thread);
            const offlineUnread = Number.isFinite(thread.offlineUnreadCount) ? thread.offlineUnreadCount : 0;
            const unread = (Number.isFinite(thread.unreadCount) ? thread.unreadCount : 0) + offlineUnread;

            li.innerHTML = `
        <div class="item-content conversation-item-content">
          <div class="conversation-avatar">${avatarSrc ? `<img src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(nickname)}" />` : `<span>${escapeHtml(initials)}</span>`}</div>
          <div class="conversation-content">
            <div class="conversation-row conversation-row-top">
              <span class="conversation-name">${escapeHtml(nickname)}</span>
              <span class="conversation-time">${escapeHtml(timeLabel)}</span>
            </div>
            <div class="conversation-row conversation-row-bottom">
              <span class="conversation-snippet">${escapeHtml(snippet || '尚無訊息')}</span>
              ${unread > 0 ? `<span class="conversation-badge conversation-badge-small ${offlineUnread > 0 ? 'badge-offline-gap' : ''}">${escapeHtml(unread > 99 ? '99+' : String(unread))}</span>` : ''}
            </div>
          </div>
        </div>
        <button type="button" class="item-delete" aria-label="刪除對話"><i class='bx bx-trash'></i></button>
      `;

            const deleteBtn = li.querySelector('.item-delete');
            deleteBtn?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.deps.handleConversationDelete?.({ conversationId: thread.conversationId, peerAccountDigest: peerDigest, element: li });
            });

            li.addEventListener('click', (e) => {
                if (li.classList.contains('show-delete')) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.deps.closeSwipe?.(li);
                    return;
                }
                const hasFn = !!this.deps.setActiveConversation;
                console.log('[ConversationList] item clicked', {
                    peerDigest,
                    hasFn,
                    target: e.target.className,
                    itemClasses: li.className
                });
                if (e.target.closest('.item-delete')) return;
                if (li.classList.contains('show-delete')) { this.deps.closeSwipe?.(li); return; }
                const threadKey = this._threadPeer(thread) || peerDigest;
                // [FIX] Pass conversationId and token to support direct opening without index lookup
                this.deps.setActiveConversation?.(threadKey, thread.conversationId, thread.conversationToken);
            });

            li.addEventListener('keydown', (e) => {
                const threadKey = this._threadPeer(thread) || peerDigest;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    // [FIX] Pass conversationId and token
                    this.deps.setActiveConversation?.(threadKey, thread.conversationId, thread.conversationToken);
                }
                if (e.key === 'Delete') {
                    e.preventDefault();
                    this.deps.handleConversationDelete?.({ conversationId: thread.conversationId, peerAccountDigest: peerDigest, element: li });
                }
            });

            this.deps.setupSwipe?.(li);
            this.elements.conversationList.appendChild(li);
        }
    }

    /**
     * Initialize touch event listeners for pull-to-refresh.
     */
    init() {
        super.init();
        if (this.elements.conversationList) {
            this.elements.conversationList.addEventListener('touchstart', (e) => this.handleConversationPullStart(e), { passive: true });
            this.elements.conversationList.addEventListener('touchmove', (e) => this.handleConversationPullMove(e), { passive: false });
            this.elements.conversationList.addEventListener('touchend', () => this.handleConversationPullEnd());
            this.elements.conversationList.addEventListener('touchcancel', () => this.handleConversationPullEnd());
        }
    }
}
