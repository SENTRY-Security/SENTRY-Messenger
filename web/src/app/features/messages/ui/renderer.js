import { normalizeTimelineMessageId, normalizeCounterValue, normalizeRawMessageId, normalizeMsgTypeValue } from '../parser.js';
import { isNearBottom } from './interactions.js';
import { normalizeCallLogPayload, resolveViewerRole, describeCallLogForViewer } from '../../calls/call-log.js';
import { getVaultAckCounter } from '../../messages-support/vault-ack-store.js';
import { normalizeAccountDigest, getAccountDigest } from '../../../core/store.js';
import { getTimeline } from '../../timeline-store.js';
import { escapeHtml } from '../../../ui/mobile/ui-utils.js';
import { resolveContactAvatarUrl } from '../../../ui/mobile/contact-core-store.js';
import { downloadAndDecrypt } from '../../media.js';
import { renderPdfViewer, cleanupPdfViewer, getPdfJsLibrary } from '../../../ui/mobile/viewers/pdf-viewer.js';
import { logMsgEvent } from '../../../lib/logging.js';
import {
    consumeReplayPlaceholderReveal,
    consumeGapPlaceholderReveal
} from '../placeholder-store.js';
import {
    PLACEHOLDER_REVEAL_MS,
    PLACEHOLDER_TEXT,
    PLACEHOLDER_SHIMMER_MAX_ACTIVE
} from '../../../ui/mobile/messages-ui-policy.js';

const CALL_LOG_PHONE_ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.003 5.884l3.75-1.5a1 1 0 011.316.593l1.2 3.199a1 1 0 01-.232 1.036l-1.516 1.52a11.037 11.037 0 005.516 5.516l1.52-1.516a1 1 0 011.036-.232l3.2 1.2a1 1 0 01.593 1.316l-1.5 3.75a1 1 0 01-1.17.6c-2.944-.73-5.59-2.214-7.794-4.418-2.204-2.204-3.688-4.85-4.418-7.794a1 1 0 01.6-1.17z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

const PLACEHOLDER_FAILED_TEXT = '無法解密';
const PLACEHOLDER_BLOCKED_TEXT = '暫時無法解密';

export function formatTimestamp(ts) {
    if (!Number.isFinite(ts)) return '';
    try {
        const date = new Date(ts * 1000);
        const now = new Date();

        const startOfDay = (d) => {
            const copy = new Date(d);
            copy.setHours(0, 0, 0, 0);
            return copy;
        };

        const today = startOfDay(now);
        const msgDate = startOfDay(date);

        const diffTime = today - msgDate;
        const diffDays = diffTime / (1000 * 60 * 60 * 24);

        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');

        // Within 1 day (today)
        if (diffDays === 0) {
            return `今天 ${hours}:${minutes}`;
        }

        // Within 2 days (yesterday)
        if (diffDays === 1) {
            return `昨天 ${hours}:${minutes}`;
        }

        // Within 7 days
        if (diffDays < 7 && diffDays > 0) {
            const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
            return `週${weekdays[date.getDay()]} ${hours}:${minutes}`;
        }

        const month = date.getMonth() + 1;
        const dayOfMonth = date.getDate();
        return `${month}月${dayOfMonth}日 ${hours}:${minutes}`;
    } catch {
        return '';
    }
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    const display = Number(value.toFixed(precision));
    return `${display} ${units[unitIndex]}`;
}

export function formatFileMeta(media) {
    const parts = [];
    if (Number.isFinite(media?.size)) parts.push(formatBytes(media.size));
    if (media?.contentType) parts.push(media.contentType);
    return parts.join(' · ');
}

export function canPreviewMedia(media) {
    if (!media || typeof media !== 'object') return false;
    if (media.previewUrl) return true;
    if (media.preview?.localUrl) return true;
    if (media.preview?.objectKey && media.preview?.envelope) return true;
    if (media.localUrl) return true;
    if (media.objectKey && media.envelope) return true;
    return false;
}

export async function ensureMediaPreviewUrl(media) {
    if (!media) return null;
    if (media.previewUrl) return media.previewUrl;
    if (media.preview?.localUrl) {
        media.previewUrl = media.preview.localUrl;
        return media.previewUrl;
    }
    if (media.localUrl) {
        media.previewUrl = media.localUrl;
        return media.previewUrl;
    }
    const preferPreview = media.preview?.objectKey && media.preview?.envelope;
    const targetKey = preferPreview ? media.preview.objectKey : media.objectKey;
    const targetEnvelope = preferPreview ? media.preview.envelope : media.envelope;
    const targetMessageKey = media.messageKey_b64 || media.message_key_b64 || null;
    if (!targetKey || !targetEnvelope) return null;
    if (media.previewPromise) return media.previewPromise;
    media.previewPromise = downloadAndDecrypt({
        key: targetKey,
        envelope: targetEnvelope,
        messageKeyB64: targetMessageKey
    })
        .then((result) => {
            if (!result || !result.blob) return null;
            const url = URL.createObjectURL(result.blob);
            media.previewUrl = url;
            if (preferPreview && media.preview) {
                if (!media.preview.contentType && result.contentType) {
                    media.preview.contentType = result.contentType;
                }
            } else if (!preferPreview && !media.contentType && result.contentType) {
                media.contentType = result.contentType;
            }
            return url;
        })
        .catch((err) => {
            console.warn('Media preview error:', err);
            return null;
        })
        .finally(() => {
            media.previewPromise = null;
        });
    return media.previewPromise;
}

export function setPreviewSource(el, media) {
    if (!el || !media) return;
    const apply = (url) => {
        if (!url || typeof el.src !== 'string') return;
        el.src = url;
        if (el.tagName === 'VIDEO') {
            try { el.load(); } catch { }
        }
    };
    if (media.previewUrl) {
        apply(media.previewUrl);
        return;
    }
    if (media.localUrl) {
        media.previewUrl = media.localUrl;
        apply(media.previewUrl);
        return;
    }
    const hasRemotePreview = (media.preview?.objectKey && media.preview?.envelope) || (media.objectKey && media.envelope);
    if (!hasRemotePreview) return;
    ensureMediaPreviewUrl(media).then((url) => {
        if (url && typeof el.src === 'string' && !el.src) apply(url);
    }).catch(() => { });
}

export async function renderPdfThumbnail(media, canvas) {
    if (!canvas) return;
    canvas.dataset.previewState = 'loading';
    try {
        let buffer = null;
        const directUrl = media?.previewUrl || media?.preview?.localUrl || media?.localUrl || null;
        if (directUrl) {
            const res = await fetch(directUrl);
            if (!res.ok) throw new Error('preview fetch failed');
            buffer = await res.arrayBuffer();
        } else if (media?.objectKey && media?.envelope) {
            const { blob } = await downloadAndDecrypt({
                key: media.objectKey,
                envelope: media.envelope,
                messageKeyB64: media.messageKey_b64 || media.message_key_b64 || null
            });
            buffer = await blob.arrayBuffer();
        } else {
            canvas.dataset.previewState = 'error';
            return;
        }
        const pdfjsLib = await getPdfJsLibrary();
        const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const targetWidth = 220;
        const scale = Math.min(3, Math.max(0.5, targetWidth / viewport.width));
        const vp = page.getViewport({ scale });
        canvas.width = vp.width;
        canvas.height = vp.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        canvas.dataset.previewState = 'ready';
        try { doc.cleanup?.(); doc.destroy?.(); } catch { }
    } catch (err) {
        canvas.dataset.previewState = 'error';
        console.warn('PDF thumb error:', err);
    }
}

export function isUserTimelineMessage(msg) {
    if (!msg) return false;
    const type = msg.msgType || msg.subtype || 'text';
    // [FIX] Include 'call-log' as a user timeline message.
    // Previously call-log was excluded, preventing thread preview updates,
    // unread count increments, and notification triggers for call-log entries.
    return type !== 'control';
}

export function isOutgoingFromSelf(msg, selfDigest) {
    const senderDigest = normalizeAccountDigest(
        msg.senderDigest || msg.sender_digest || msg.meta?.senderDigest || msg.meta?.sender_digest || msg.header?.sender_digest || null
    );
    return senderDigest ? senderDigest === selfDigest : msg.direction === 'outgoing';
}

export function resolveLatestOutgoingMessage(timelineMessages, selfDigest) {
    const normalizedSelf = normalizeAccountDigest(selfDigest || null);
    if (!Array.isArray(timelineMessages) || !timelineMessages.length) return null;
    for (let i = timelineMessages.length - 1; i >= 0; i -= 1) {
        const msg = timelineMessages[i];
        if (!isUserTimelineMessage(msg)) continue;
        if (!isOutgoingFromSelf(msg, normalizedSelf)) continue;
        return msg;
    }
    return null;
}

export function resolveRenderEntryCounter(entry) {
    const direct = normalizeCounterValue(entry?.counter ?? entry?.headerCounter ?? entry?.header_counter);
    if (direct !== null) return direct;
    const header = entry?.header && typeof entry.header === 'object' ? entry.header : null;
    return normalizeCounterValue(header?.n ?? header?.counter);
}

export function computeStatusVisibility({ timelineMessages, conversationId, selfDigest } = {}) {
    const visibleStatusSet = new Set();
    const normalizedSelf = normalizeAccountDigest(selfDigest || null);

    if (!Array.isArray(timelineMessages) || !timelineMessages.length) {
        return { visibleStatusSet };
    }

    let foundDeliveredAnchor = false;

    // Traverse backwards from newest to oldest
    for (let i = timelineMessages.length - 1; i >= 0; i -= 1) {
        const msg = timelineMessages[i];
        if (!isUserTimelineMessage(msg)) continue;

        // Skip non-outgoing messages
        if (!isOutgoingFromSelf(msg, normalizedSelf)) continue;

        const messageId = msg.id || msg.messageId || msg.serverMessageId;
        if (!messageId) continue;

        // Determine effective status (Sent vs Delivered)
        // 1. Vault Count Check (Primary)
        const vaultCount = Number(msg.vaultPutCount);
        const countDelivered = Number.isFinite(vaultCount) && vaultCount >= 2;

        // 2. Legacy Ack Counter Check (Secondary)
        const msgCounter = resolveRenderEntryCounter(msg);
        const ackCounter = conversationId ? getVaultAckCounter(conversationId) : null;
        const legacyDelivered = Number.isFinite(msgCounter)
            && Number.isFinite(ackCounter)
            && ackCounter >= msgCounter;

        const isDelivered = countDelivered || legacyDelivered || msg.status === 'delivered' || msg.status === 'read';

        if (foundDeliveredAnchor) {
            // We already found the anchor (latest delivered message).
            // Any older message status is hidden.
            continue;
        }

        // If we haven't found the anchor yet, this message status should be visible.
        visibleStatusSet.add(messageId);

        if (isDelivered) {
            // This is the first "delivered" message we've seen going backwards.
            // It becomes the anchor.
            foundDeliveredAnchor = true;
        }
    }

    return { visibleStatusSet };
}

export function computeDoubleTickMessageId(params = {}) {
    // [DEPRECATED] Replaced by computeStatusVisibility
    return null;
}

export function resolveLatestOutgoingMessageIdForConversation(conversationId) {
    if (!conversationId) return null;
    const timeline = getTimeline(conversationId);
    let selfDigest = null;
    try { selfDigest = normalizeAccountDigest(getAccountDigest()); } catch { }
    const latest = resolveLatestOutgoingMessage(timeline, selfDigest);
    return latest?.id || latest?.messageId || latest?.serverMessageId || null;
}

export function isLatestOutgoingForStatus(conversationId, messageId) {
    if (!conversationId || !messageId) return false;
    const latestId = resolveLatestOutgoingMessageIdForConversation(conversationId);
    if (!latestId) return false;
    return latestId === messageId;
}

export function buildRenderEntries({ timelineMessages = [] } = {}) {
    const list = Array.isArray(timelineMessages) ? timelineMessages : [];
    const shimmerIds = new Set();
    const placeholders = list.filter((entry) => entry?.placeholder === true || entry?.msgType === 'placeholder');
    const pending = placeholders.filter((entry) => entry?.status !== 'failed' && entry?.status !== 'blocked');
    const shimmerMax = Math.max(0, Number(PLACEHOLDER_SHIMMER_MAX_ACTIVE) || 0);
    if (pending.length) {
        // User requested to ignore performance/limit for shimmer
        const start = 0; // Math.max(0, pending.length - shimmerMax);
        for (let i = start; i < pending.length; i += 1) {
            const id = pending[i]?.messageId || pending[i]?.id || null;
            if (id) shimmerIds.add(id);
        }
        console.log('[Renderer] Shimmer Debug', {
            pendingCount: pending.length,
            shimmerCount: shimmerIds.size,
            sampleId: pending[0]?.id
        });
    }
    return { entries: list, shimmerIds };
}

export class MessageRenderer {
    constructor({ messagesListEl, scrollEl, callbacks = {} }) {
        this.listEl = messagesListEl;
        this.scrollEl = scrollEl || null;
        this.callbacks = callbacks;
        this.shimmerIds = new Set();
    }

    /**
     * After media elements load, maintain scroll position if user was near bottom.
     * Prevents content from shifting away when images/videos finish loading.
     */
    _attachMediaLoadScrollGuard(el) {
        if (!el) return;
        const eventName = el.tagName === 'VIDEO' ? 'loadedmetadata' : 'load';
        el.addEventListener(eventName, () => {
            const scrollEl = this.scrollEl;
            if (!scrollEl) return;
            if (isNearBottom(scrollEl, 150)) {
                scrollEl.scrollTop = scrollEl.scrollHeight;
            }
        }, { once: true });
    }

    attachMediaPreview(container, media) {
        const type = (media?.contentType || '').toLowerCase();
        const previewType = (media?.preview?.contentType || '').toLowerCase();
        const hasPreviewImage = previewType.startsWith('image/') || (!!media?.preview && (!!media.preview.objectKey || !!media.preview.localUrl));
        const nameLower = (media?.name || '').toLowerCase();
        container.innerHTML = '';
        container.classList.add('message-file-preview');
        if (hasPreviewImage || type.startsWith('image/')) {
            const img = document.createElement('img');
            img.className = 'message-file-preview-image';
            img.alt = media?.name || 'image preview';
            img.decoding = 'async';
            container.appendChild(img);
            this._attachMediaLoadScrollGuard(img);
            setPreviewSource(img, media);
        } else if (type.startsWith('video/')) {
            const video = document.createElement('video');
            video.className = 'message-file-preview-video';
            video.controls = true;
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            container.appendChild(video);
            this._attachMediaLoadScrollGuard(video);
            setPreviewSource(video, media);
        } else if (type === 'application/pdf' || nameLower.endsWith('.pdf')) {
            const pdf = document.createElement('canvas');
            pdf.className = 'message-file-preview-pdf';
            pdf.setAttribute('aria-label', media?.name || 'PDF 預覽');
            pdf.dataset.previewState = 'loading';
            container.appendChild(pdf);
            renderPdfThumbnail(media, pdf);
        } else {
            const generic = document.createElement('div');
            generic.className = 'message-file-preview-generic';
            generic.textContent = '檔案';
            container.appendChild(generic);
        }
    }

    enableMediaPreviewInteraction(container, media) {
        if (!container || !canPreviewMedia(media)) return;
        container.classList.add('message-file-clickable');
        container.setAttribute('role', 'button');
        container.setAttribute('tabindex', '0');
        const handler = (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.callbacks.onPreviewMedia?.(media);
        };
        container.addEventListener('click', handler);
        container.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                handler(event);
            }
        });
    }

    renderUploadOverlay(wrapper, media, msgId) {
        if (!wrapper || !media) return;
        const target = wrapper.querySelector?.('.message-file-preview');
        if (!target) return;
        target.style.position = 'relative';
        const existing = target.querySelector('.message-file-overlay');
        const shouldShow = media.uploading || (Number.isFinite(media.progress) && media.progress < 100) || media.error;
        if (!shouldShow) {
            if (existing) existing.remove();
            return;
        }
        const overlay = existing || document.createElement('div');
        overlay.className = 'message-file-overlay';
        Object.assign(overlay.style, {
            position: 'absolute',
            inset: '0',
            background: media.error ? 'rgba(239,68,68,0.82)' : 'rgba(15,23,42,0.75)',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            borderRadius: '12px',
            pointerEvents: 'none',
            padding: '10px',
            textAlign: 'center'
        });
        const pct = Number.isFinite(media.progress) ? Math.min(100, Math.max(0, Math.round(media.progress))) : null;
        overlay.innerHTML = '';
        overlay.style.borderRadius = getComputedStyle(target).borderRadius || '12px';
        overlay.style.pointerEvents = 'auto';
        if (media.error) {
            const label = document.createElement('div');
            label.textContent = '上傳失敗';
            label.style.fontWeight = '600';
            overlay.appendChild(label);
            const detail = document.createElement('div');
            detail.textContent = String(media.error || '').slice(0, 80) || '請稍後再試';
            detail.style.fontSize = '12px';
            detail.style.opacity = '0.9';
            overlay.appendChild(detail);
        } else {
            const label = document.createElement('div');
            label.textContent = pct != null ? `上傳中… ${pct}%` : '準備上傳…';
            label.style.fontWeight = '600';
            overlay.appendChild(label);
            const barWrap = document.createElement('div');
            barWrap.style.width = '80%';
            barWrap.style.height = '6px';
            barWrap.style.borderRadius = '999px';
            barWrap.style.background = 'rgba(255,255,255,0.25)';
            const bar = document.createElement('div');
            bar.style.height = '100%';
            bar.style.borderRadius = '999px';
            bar.style.background = '#22d3ee';
            bar.style.width = `${pct != null ? pct : 10}%`;
            barWrap.appendChild(bar);
            overlay.appendChild(barWrap);
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = '取消上傳';
            cancelBtn.className = 'upload-cancel-btn';
            Object.assign(cancelBtn.style, {
                background: 'rgba(0,0,0,0.55)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.35)',
                padding: '8px 12px',
                borderRadius: '10px',
                cursor: 'pointer',
                fontSize: '13px'
            });
            overlay.appendChild(cancelBtn);
            cancelBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.callbacks.onCancelUpload?.(msgId, overlay);
            });
        }
        if (!existing) target.appendChild(overlay);
    }

    renderMediaBubble(bubble, msg) {
        const media = msg.media || {};
        bubble.classList.add('message-has-media');
        bubble.innerHTML = '';
        const wrapper = document.createElement('div');
        wrapper.className = 'message-file';
        const preview = document.createElement('div');
        const info = document.createElement('div');
        info.className = 'message-file-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'message-file-name';
        nameEl.textContent = media.name || '附件';
        const metaEl = document.createElement('div');
        metaEl.className = 'message-file-meta';
        metaEl.textContent = formatFileMeta(media);
        info.appendChild(nameEl);
        info.appendChild(metaEl);
        wrapper.appendChild(preview);
        wrapper.appendChild(info);
        this.enableMediaPreviewInteraction(wrapper, media);
        bubble.appendChild(wrapper);
        this.attachMediaPreview(preview, media);

        // Pass msg.id or normalized id for fallback
        const messageId = normalizeTimelineMessageId(msg);
        if (messageId) bubble.dataset.messageId = messageId;

        this.renderUploadOverlay(wrapper, media, messageId);
    }

    render(entries, { state, contacts, visibleStatusSet, shimmerIds, forceFullRender }) {
        if (!this.listEl) return;
        const { activePeerDigest, activePeerDeviceId, conversationId } = state;
        this.shimmerIds = shimmerIds || new Set();

        // Clear list
        const prevCount = this.listEl.childElementCount;
        this.listEl.innerHTML = '';

        let prevTs = null;
        let prevDateKey = null;

        for (let i = 0; i < entries.length; i += 1) {
            const msg = entries[i];
            const tsRaw = msg?.ts;
            let tsVal = Number.isFinite(Number(tsRaw)) ? Number(tsRaw) : null;

            // Normalize to seconds if input appears to be milliseconds
            if (tsVal && tsVal > 1e11) {
                tsVal = tsVal / 1000;
            }

            const hasTs = Number.isFinite(tsVal);
            const dateKey = hasTs ? new Date(tsVal * 1000).toDateString() : null;

            if (hasTs) {
                const needSeparator = prevTs === null
                    || prevDateKey !== dateKey
                    || (tsVal - prevTs) >= 300; // 5 minutes in seconds
                if (needSeparator) {
                    const sep = document.createElement('li');
                    sep.className = 'message-separator';
                    sep.textContent = formatTimestamp(tsVal);
                    this.listEl.appendChild(sep);
                }
                prevTs = tsVal;
                prevDateKey = dateKey;
            }

            const li = document.createElement('li');
            const messageType = msg.msgType || msg.subtype || (msg.media ? 'media' : 'text');
            if (!msg.msgType) msg.msgType = messageType;

            if (messageType === 'conversation-deleted') {
                const sep = document.createElement('li');
                sep.className = 'message-separator';
                sep.style.marginTop = '12px';
                sep.style.marginBottom = '12px';

                // Format: "XXXX 已於 YYYY-MM-DD HH:MM 清除上方對話紀錄"
                // Need to resolve sender name. 
                // We have 'msg.senderDigest' or 'msg.header.sender_digest'.
                const senderDigest = normalizeAccountDigest(msg.senderDigest || msg.header?.sender_digest);
                let senderName = '對方';
                if (isOutgoingFromSelf(msg, state.activePeerDigest)) { // Actually selfDigest not available in state directly? 
                    // Renderer doesn't know selfDigest easily without args.
                    // But `isOutgoingFromSelf` is exported. We need `selfDigest`. 
                    // It's not passed in render() options except maybe implicitly?
                    // Wait, render() has `contacts`.
                    // Let's use `msg.direction`.
                    if (msg.direction === 'outgoing') senderName = '你';
                    else {
                        const contact = contacts?.get(senderDigest);
                        if (contact?.nickname) senderName = contact.nickname;
                    }
                } else if (msg.direction === 'outgoing') {
                    senderName = '你';
                }

                // Timestamp
                const ts = msg.ts || msg.tsMs / 1000 || Date.now() / 1000;
                const timeStr = new Date(ts * 1000).toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

                sep.textContent = `${senderName} 已於 ${timeStr} 清除上方對話紀錄`;
                this.listEl.appendChild(sep);
                continue;
            }

            if (messageType === 'profile-update') {
                const sep = document.createElement('li');
                sep.className = 'message-separator';
                sep.style.marginTop = '12px';
                sep.style.marginBottom = '12px';
                sep.textContent = msg.text || msg.content?.text || '更新了個人檔案';
                this.listEl.appendChild(sep);
                continue;
            }

            if (messageType === 'contact-share') {
                const sep = document.createElement('li');
                sep.className = 'message-separator';
                sep.style.marginTop = '12px';
                sep.style.marginBottom = '12px';

                // Parse contact-share payload to determine reason
                let csPayload = null;
                try {
                  const rawText = msg?.text || '';
                  if (typeof rawText === 'string' && rawText.trim().startsWith('{')) {
                    csPayload = JSON.parse(rawText);
                  }
                } catch {}

                const csReason = csPayload?.reason || msg?.reason || 'invite-consume';
                const contact = typeof contacts?.get === 'function' ? contacts.get(activePeerDigest || '') : null;
                const name = escapeHtml(contact?.nickname || csPayload?.nickname || '對方');
                const isOutgoing = msg?.direction === 'outgoing';

                if (csReason === 'invite-consume' || csReason === 'invite-create') {
                  sep.textContent = `你已經與 ${name} 建立安全連線 🔐`;
                } else if (csReason === 'nickname') {
                  sep.textContent = isOutgoing ? '你已更新暱稱' : `${name} 已更新暱稱`;
                } else if (csReason === 'avatar') {
                  sep.textContent = isOutgoing ? '你已更新頭像' : `${name} 已更新頭像`;
                } else {
                  sep.textContent = isOutgoing ? '你已更新個人資料' : `${name} 已更新個人資料`;
                }
                this.listEl.appendChild(sep);
                continue;
            }

            // Placeholder
            if (msg.placeholder === true || messageType === 'placeholder') {
                li.className = 'message-placeholder-item';
                const row = document.createElement('div');
                row.className = 'message-row message-placeholder-row';
                const isOutgoing = msg.direction === 'outgoing';
                if (isOutgoing) row.style.justifyContent = 'flex-end';

                const bubble = document.createElement('div');
                const messageId = normalizeTimelineMessageId(msg);
                bubble.className = 'message-bubble message-placeholder';
                if (messageId) bubble.dataset.messageId = messageId;
                if (isOutgoing) bubble.classList.add('placeholder-outgoing');
                else bubble.classList.add('placeholder-incoming');

                const status = msg.status === 'failed'
                    ? 'failed'
                    : (msg.status === 'blocked' ? 'blocked' : 'pending');

                if (status === 'failed' || status === 'blocked') {
                    bubble.classList.add('placeholder-failed');
                } else if (messageId && this.shimmerIds.has(messageId)) {
                    bubble.classList.add('placeholder-shimmer');
                }

                bubble.textContent = status === 'failed'
                    ? PLACEHOLDER_FAILED_TEXT
                    : (status === 'blocked' ? PLACEHOLDER_BLOCKED_TEXT : (PLACEHOLDER_TEXT || ''));

                row.appendChild(bubble);
                li.appendChild(row);
                this.listEl.appendChild(li);
                try {
                    // Log append if logMsgEvent is accessible, but here I can't access closure logUiAppend
                    // I will assume logMsgEvent imported is sufficient or skip detailed log here
                } catch { }
                continue;
            }





            if (messageType === 'call-log') {
                // [FIX] Reconstruct callLog on-the-fly if missing.
                // Some code paths (vault-replay edge cases, offline sync) may store the
                // timeline entry with msgType='call-log' but without the pre-built callLog
                // object, causing the tombstone to silently fall through to standard text
                // rendering (invisible to the user).
                let callLogObj = msg.callLog || null;
                if (!callLogObj) {
                    try {
                        const raw = msg.text || '';
                        const parsed = (typeof raw === 'string' && raw.trim().startsWith('{'))
                            ? JSON.parse(raw) : {};
                        const normalized = normalizeCallLogPayload(parsed, msg.meta || {});
                        const vr = resolveViewerRole(normalized.authorRole, msg.direction || 'incoming');
                        const desc = describeCallLogForViewer(normalized, vr);
                        callLogObj = { ...normalized, viewerRole: vr, label: desc.label, subLabel: desc.subLabel };
                    } catch {
                        callLogObj = { outcome: 'missed', kind: 'voice', durationSeconds: 0, authorRole: 'outgoing' };
                    }
                }
                li.className = 'call-log-entry';
                const chip = document.createElement('div');
                const outcome = callLogObj.outcome || 'missed';
                chip.className = `call-log-chip ${outcome}`;

                const icon = document.createElement('span');
                icon.className = 'call-log-icon';
                icon.innerHTML = CALL_LOG_PHONE_ICON;
                chip.appendChild(icon);

                const textGroup = document.createElement('div');
                textGroup.className = 'call-log-text-group';

                const main = document.createElement('div');
                main.className = 'call-log-main';

                const viewerRole = callLogObj.viewerRole || resolveViewerRole(callLogObj.authorRole, msg.direction);
                const { label, subLabel } = describeCallLogForViewer(callLogObj, viewerRole);

                main.textContent = label || '語音通話';
                textGroup.appendChild(main);

                if (subLabel) {
                    const sub = document.createElement('div');
                    sub.className = 'call-log-sub';
                    sub.textContent = subLabel;
                    textGroup.appendChild(sub);
                }

                chip.appendChild(textGroup);
                li.appendChild(chip);
                this.listEl.appendChild(li);
                continue;
            }



            if (messageType === 'system') {
                li.className = 'message-separator';
                li.textContent = msg.text || msg.content?.text || '';
                this.listEl.appendChild(li);
                continue;
            }

            // Standard Message Row
            const row = document.createElement('div');
            row.className = 'message-row';
            if (msg.direction === 'outgoing') {
                row.style.justifyContent = 'flex-end';
            }

            if (msg.direction === 'incoming') {
                const avatar = document.createElement('div');
                avatar.className = 'message-avatar';
                // Resolve contact from passed-in map/function
                const contact = typeof contacts?.get === 'function'
                    ? contacts.get(activePeerDigest || '')
                    : null;

                const name = contact?.nickname || '';
                const initials = name ? name.slice(0, 1) : '好友';

                avatar.textContent = initials;
                const avatarUrl = resolveContactAvatarUrl(contact);
                if (avatarUrl) {
                    const img = document.createElement('img');
                    img.src = avatarUrl;
                    img.alt = name || 'avatar';
                    avatar.textContent = '';
                    avatar.appendChild(img);
                    avatar.classList.add('message-avatar-clickable');
                    avatar.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.callbacks.onAvatarClick?.({ avatarUrl, name });
                    });
                }
                row.appendChild(avatar);
            } else {
                row.style.gap = '0';
            }

            const bubble = document.createElement('div');
            const messageId = normalizeTimelineMessageId(msg);
            const isReplayEntry = msg?.isHistoryReplay === true;
            bubble.className = 'message-bubble ' + (msg.direction === 'outgoing' ? 'message-me' : 'message-peer');
            if (messageId) bubble.dataset.messageId = messageId;

            const shouldReveal = messageId
                && (isReplayEntry
                    ? consumeReplayPlaceholderReveal(conversationId, messageId)
                    : consumeGapPlaceholderReveal(conversationId, messageId));

            if (shouldReveal) {
                bubble.classList.add('message-reveal');
                if (Number.isFinite(PLACEHOLDER_REVEAL_MS)) {
                    bubble.style.animationDuration = `${PLACEHOLDER_REVEAL_MS}ms`;
                }
            }

            if (messageType === 'media' && msg.media) {
                this.renderMediaBubble(bubble, msg);
            } else {
                bubble.textContent = msg.text || msg.error || '(無法解密)';
            }

            row.appendChild(bubble);
            li.appendChild(row);

            // Meta Row
            const metaRow = document.createElement('div');
            metaRow.className = 'message-meta';
            const tsSpan = document.createElement('span');
            tsSpan.className = 'message-ts hidden';
            tsSpan.textContent = '';
            metaRow.appendChild(tsSpan);


            const RETRY_ICON = '<svg viewBox="0 0 24 24" fill="none" class="w-4 h-4" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>';

            if (messageType !== 'call-log') {
                const statusSpan = document.createElement('span');
                const status = typeof msg?.status === 'string' ? msg.status : null;
                const pending = status === 'pending' || msg.pending === true;
                const failed = status === 'failed';
                const statusMessageId = msg?.id || msg?.messageId || msg?.localId || null;
                const isOutgoing = msg.direction === 'outgoing';
                const showStatus = !!(statusMessageId && visibleStatusSet && visibleStatusSet.has(statusMessageId));

                // Determine delivery status locally for rendering icon
                const vaultCount = Number(msg.vaultPutCount);
                const countDelivered = Number.isFinite(vaultCount) && vaultCount >= 2;
                const msgCounter = resolveRenderEntryCounter(msg);
                const ackCounter = (conversationId && typeof getVaultAckCounter === 'function') ? getVaultAckCounter(conversationId) : null;
                const legacyDelivered = Number.isFinite(msgCounter) && Number.isFinite(ackCounter) && ackCounter >= msgCounter;

                const delivered = countDelivered || legacyDelivered || msg.status === 'delivered' || msg.status === 'read';

                if (statusMessageId) statusSpan.dataset.messageId = statusMessageId;

                // Helper to detect network errors
                const isNetworkError = (msg) => {
                    const code = msg?.failureCode || '';
                    const status = msg?.failureStatus || msg?.status || 0;
                    // Check for HTTP 5xx or specific network codes
                    if (Number(code) >= 500 && Number(code) < 600) return true;
                    if (String(code).startsWith('HTTP_5')) return true;
                    if (String(code).includes('Timeout')) return true;
                    if (String(code) === 'NetworkError') return true;
                    if (String(code) === 'FetchError') return true;
                    return false;
                };

                if (msg.direction === 'incoming') {
                    statusSpan.className = 'message-status peer';
                    statusSpan.textContent = '';
                } else if (failed) {
                    const retryable = isNetworkError(msg);
                    if (retryable) {
                        statusSpan.className = 'message-status failed retryable';
                        statusSpan.dataset.retry = 'true';
                        statusSpan.innerHTML = RETRY_ICON; // Use SVG
                        statusSpan.title = '網路傳送失敗，點擊重試';
                    } else {
                        statusSpan.className = 'message-status failed';
                        statusSpan.textContent = '!';
                        const failureTip = msg?.failureReason || msg?.failureCode || '';
                        if (failureTip) statusSpan.title = failureTip;
                    }
                } else if (!showStatus) {
                    statusSpan.className = 'message-status hidden';
                    statusSpan.textContent = '';
                } else if (pending) {
                    console.log('[Renderer] Render Pending:', {
                        id: msg.id,
                        status: msg.status,
                        pendingProp: msg.pending,
                        isPendingVar: pending,
                        direction: msg.direction
                    });
                    statusSpan.className = 'message-status pending';

                    statusSpan.innerHTML = '<span class="status-spinner"></span>';

                } else if (delivered) {
                    statusSpan.className = 'message-status delivered';
                    statusSpan.textContent = '✓✓';
                } else {
                    statusSpan.className = 'message-status sent';
                    statusSpan.textContent = '✓';
                }
                metaRow.appendChild(statusSpan);
            }
            li.appendChild(metaRow);
            this.listEl.appendChild(li);
        }
    }
}


