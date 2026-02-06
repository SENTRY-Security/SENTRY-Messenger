/**
 * Protocol & Parsing Logic for Messages V2
 * Extracted from messages-pane.js to decouple UI from Protocol details.
 */

import { normalizeSemanticSubtype, MSG_SUBTYPE, CONTROL_STATE_SUBTYPES, TRANSIENT_SIGNAL_SUBTYPES } from '../semantic.js';
import { normalizePeerIdentity, normalizeAccountDigest, normalizePeerDeviceId } from '../../core/store.js';

const PLACEHOLDER_TRACE_PREFIX_LEN = 8;
// CONTROL_STATE_SUBTYPES and TRANSIENT_SIGNAL_SUBTYPES imported from semantic.js

export function normalizeTimelineMessageId(msg) {
    if (!msg) return null;
    const id = msg.id || msg.messageId || msg.serverMessageId || msg.server_message_id || null;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export function normalizeCounterValue(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

export function normalizeRawMessageId(raw) {
    if (!raw) return null;
    const candidates = [raw.id, raw.message_id, raw.messageId];
    for (const val of candidates) {
        if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return null;
}

export function hashMessageId(value) {
    if (!value) return 0;
    const str = String(value);
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return hash;
}

export function deriveMessageOffsetMs(messageId) {
    if (!messageId) return 0;
    return hashMessageId(messageId) % 1000;
}

export function extractMessageTimestamp(raw) {
    if (!raw) return null;
    // [STRICT SERIALIZATION] Single Source of Truth via Edge Normalization (server-api.js)
    // We expect 'ts' to be present and valid.
    // We retain 'created_at' / 'createdAt' support for non-normalized sources (e.g. websocket events before normalization),
    // but remove deep "guessing" like meta.ts or header.ts.
    // If strict mode fails, we do NOT fallback to 0. (User Requirement)
    const val = raw.ts ?? raw.created_at ?? raw.createdAt;
    const n = Number(val);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return null;
}

export function extractMessageTimestampMs(raw) {
    const ts = extractMessageTimestamp(raw);
    if (!Number.isFinite(ts)) return null;
    if (ts > 10_000_000_000) return Math.floor(ts);
    const messageId = normalizeRawMessageId(raw);
    return Math.floor(ts) * 1000 + deriveMessageOffsetMs(messageId);
}

export function extractMessageTimestampSeq(raw) {
    const messageId = normalizeRawMessageId(raw);
    return messageId ? hashMessageId(messageId) : null;
}

export function normalizeMsgTypeValue(value) {
    if (!value || typeof value !== 'string') return null;
    return value.trim().toLowerCase();
}

export function resolveDecryptUnableReason(err) {
    const rawCode = err?.code || err?.errorCode || err?.stage || null;
    const code = rawCode ? String(rawCode) : '';
    const message = typeof err?.message === 'string' ? err.message : '';
    if (code === 'DR_STATE_UNAVAILABLE' || message.includes('DR state unavailable')) return 'DR_STATE_UNAVAILABLE';
    if (code === 'DR_STATE_CONVERSATION_MISMATCH' || message.includes('DR state bound to different conversation')) {
        return 'DR_STATE_CONVERSATION_MISMATCH';
    }
    if (code === 'TARGET_DEVICE_MISSING' || message.includes('targetDeviceId missing')) return 'TARGET_DEVICE_MISSING';
    if (code === 'MK_MISSING_HARDBLOCK' || code === 'REPLAY_VAULT_MISSING' || message.includes('缺少訊息密鑰')) {
        return 'MK_MISSING';
    }
    return null;
}

export function buildPlaceholderCounterId(counter) {
    if (!Number.isFinite(counter)) return null;
    return `counter:${counter}`;
}

export function normalizePlaceholderCounter(entry) {
    if (!entry) return null;
    const direct = normalizeCounterValue(entry.counter ?? entry.n ?? entry.headerCounter ?? entry.header_counter);
    if (direct !== null) return direct;
    const header = entry?.header && typeof entry.header === 'object' ? entry.header : null;
    const headerCounter = normalizeCounterValue(header?.n ?? header?.counter);
    if (headerCounter !== null) return headerCounter;
    const headerJson = entry?.header_json || entry?.headerJson || null;
    if (typeof headerJson === 'string') {
        try {
            const parsed = JSON.parse(headerJson);
            return normalizeCounterValue(parsed?.n ?? parsed?.counter);
        } catch { }
    }
    return null;
}

export function normalizePlaceholderRawMessageId(raw) {
    if (!raw) return null;
    const candidates = [raw.id, raw.message_id, raw.messageId];
    for (const val of candidates) {
        if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return null;
}

export function normalizePlaceholderKey(value) {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    return str || null;
}

export function sliceConversationIdPrefix(value, len = PLACEHOLDER_TRACE_PREFIX_LEN) {
    if (value === null || value === undefined) return null;
    const str = String(value);
    if (!str) return null;
    return str.slice(0, len);
}

export function sliceDeviceIdSuffix4(value) {
    if (value === null || value === undefined) return null;
    const str = String(value);
    if (!str) return null;
    return str.length > 4 ? str.slice(-4) : str;
}

export function resolvePlaceholderSenderDeviceId(raw) {
    if (!raw) return null;
    const meta = raw?.meta || raw?.header?.meta || null;
    const header = raw?.header && typeof raw.header === 'object' ? raw.header : null;
    const senderDeviceId = meta?.sender_device_id
        || meta?.senderDeviceId
        || raw?.senderDeviceId
        || raw?.sender_device_id
        || header?.device_id
        || header?.deviceId
        || null;
    if (typeof senderDeviceId !== 'string') return null;
    const trimmed = senderDeviceId.trim();
    return trimmed || null;
}

export function deriveMessageDirectionFromEnvelopeMeta(item, selfDeviceId, selfDigest) {
    const selfId = typeof selfDeviceId === 'string' ? selfDeviceId.trim() : '';
    const selfAccount = normalizeAccountDigest(selfDigest || null);
    let header = item?.header && typeof item.header === 'object' ? item.header : null;
    if (!header) {
        const headerJson = item?.header_json || item?.headerJson || null;
        if (typeof headerJson === 'string') {
            try { header = JSON.parse(headerJson); } catch { }
        }
    }
    const meta = item?.meta || header?.meta || item?.header?.meta || null;
    const senderDeviceId = meta?.sender_device_id
        || meta?.senderDeviceId
        || item?.senderDeviceId
        || item?.sender_device_id
        || header?.device_id
        || header?.deviceId
        || null;
    const targetDeviceId = item?.targetDeviceId
        || item?.target_device_id
        || meta?.targetDeviceId
        || meta?.target_device_id
        || meta?.receiverDeviceId
        || meta?.receiver_device_id
        || item?.receiverDeviceId
        || item?.receiver_device_id
        || null;
    const senderDigest = normalizeAccountDigest(
        item?.senderAccountDigest
        || item?.sender_digest
        || meta?.senderDigest
        || meta?.sender_digest
        || null
    );
    const targetDigest = normalizeAccountDigest(
        item?.targetAccountDigest
        || item?.target_account_digest
        || meta?.targetAccountDigest
        || meta?.target_account_digest
        || meta?.receiverAccountDigest
        || meta?.receiver_account_digest
        || item?.receiverAccountDigest
        || item?.receiver_account_digest
        || null
    );
    const deviceMatchesSelf = !!(selfId && targetDeviceId && String(targetDeviceId).trim() === selfId);
    const digestMatchesSelf = !!(selfAccount && targetDigest && targetDigest === selfAccount);
    const senderMatchesSelfDevice = !!(selfId && senderDeviceId && String(senderDeviceId).trim() === selfId);
    const senderMatchesSelfDigest = !!(selfAccount && senderDigest && senderDigest === selfAccount);
    if (deviceMatchesSelf || digestMatchesSelf) {
        return { direction: 'incoming', known: true, reasonCode: null, senderDeviceId: senderDeviceId || null };
    }
    if (senderMatchesSelfDevice || senderMatchesSelfDigest) {
        return { direction: 'outgoing', known: true, reasonCode: null, senderDeviceId: senderDeviceId || null };
    }
    let reasonCode = 'no_self_match';
    if (!selfId && !selfAccount) {
        reasonCode = 'missing_self_identity';
    } else if (!senderDeviceId && !targetDeviceId && !senderDigest && !targetDigest) {
        reasonCode = 'missing_envelope_fields';
    }
    return { direction: 'incoming', known: false, reasonCode, senderDeviceId: senderDeviceId || null };
}

export function resolvePlaceholderSubtype(item) {
    let header = item?.header && typeof item.header === 'object' ? item.header : null;
    if (!header) {
        const headerJson = item?.header_json || item?.headerJson || null;
        if (typeof headerJson === 'string') {
            try { header = JSON.parse(headerJson); } catch { }
        }
    }
    const meta = item?.meta || header?.meta || item?.header?.meta || null;
    const rawType = meta?.msg_type
        || meta?.msgType
        || header?.meta?.msg_type
        || header?.meta?.msgType
        || item?.msg_type
        || item?.msgType
        || null;
    let subtype = normalizeSemanticSubtype(rawType);
    if (!subtype && (meta?.media || header?.meta?.media || item?.media)) subtype = MSG_SUBTYPE.MEDIA;
    if (!subtype) subtype = MSG_SUBTYPE.TEXT;
    return subtype;
}

export function buildPlaceholderEntriesFromRaw({ items, selfDeviceId, selfDigest, conversationId } = {}) {
    if (!Array.isArray(items) || !items.length) {
        return {
            entries: [],
            directionKnownCount: 0,
            excludedControlCount: 0,
            excludedNonUserCount: 0,
            excludedUnknownDirectionCount: 0,
            incomingCount: 0,
            outgoingCount: 0
        };
    }
    const entries = [];
    const seen = new Set();
    const seenCounters = new Set();
    let directionKnownCount = 0;
    let excludedControlCount = 0;
    let excludedNonUserCount = 0;
    let excludedUnknownDirectionCount = 0;
    let excludedMissingTsCount = 0;
    let incomingCount = 0;
    let outgoingCount = 0;
    const convPrefix = sliceConversationIdPrefix(conversationId);
    for (const item of items) {
        const counter = normalizePlaceholderCounter(item);
        let messageId = normalizePlaceholderRawMessageId(item);
        if (!messageId && counter !== null) {
            messageId = buildPlaceholderCounterId(counter);
        }
        if (!messageId || seen.has(messageId)) continue;
        if (counter !== null && seenCounters.has(counter)) continue;
        seen.add(messageId);
        if (counter !== null) seenCounters.add(counter);
        const subtype = resolvePlaceholderSubtype(item);
        const isControlSubtype = subtype
            ? (CONTROL_STATE_SUBTYPES.has(subtype) || TRANSIENT_SIGNAL_SUBTYPES.has(subtype))
            : false;

        if (isControlSubtype) {
            excludedControlCount += 1;
            continue;
        }
        if (!MSG_SUBTYPE.TEXT && !MSG_SUBTYPE.MEDIA) { // Simplified check as PLACEHOLDER_ALLOWED_TYPES is in UI
            // Actually, parser should know allowed types or we pass it in?
            // Or we just allow TEXT and MEDIA.
            // Original: if (!PLACEHOLDER_ALLOWED_TYPES.has(subtype))
            if (subtype !== MSG_SUBTYPE.TEXT && subtype !== MSG_SUBTYPE.MEDIA) {
                excludedNonUserCount += 1;
                continue;
            }
        } else {
            // PLACEHOLDER_ALLOWED_TYPES logic
            if (subtype !== MSG_SUBTYPE.TEXT && subtype !== MSG_SUBTYPE.MEDIA) {
                excludedNonUserCount += 1;
                continue;
            }
        }

        const derived = deriveMessageDirectionFromEnvelopeMeta(item, selfDeviceId, selfDigest);
        let direction = 'unknown';
        let directionKnown = false;
        if (derived?.known === true) {
            direction = derived?.direction === 'outgoing' ? 'outgoing' : 'incoming';
            directionKnown = true;
            directionKnownCount += 1;
            if (direction === 'outgoing') outgoingCount += 1;
            else incomingCount += 1;
            // Logging removed/moved or we keep it? 
            // The original had logCapped. Parser should probably be pure or use deps?
            // For now, I'll remove logging to keep it pure and simple.
        } else {
            excludedUnknownDirectionCount += 1;
        }
        if (!directionKnown) continue;
        const ts = extractMessageTimestamp(item);
        if (!Number.isFinite(ts)) {
            excludedMissingTsCount += 1;
            continue;
        }
        const tsMs = extractMessageTimestampMs(item);
        const tsSeq = extractMessageTimestampSeq(item);
        entries.push({
            messageId,
            counter,
            direction,
            directionKnown,
            status: 'pending',
            ts: Math.floor(ts),
            tsMs: Number.isFinite(tsMs) ? tsMs : null,
            tsSeq: Number.isFinite(tsSeq) ? tsSeq : null
        });
    }
    return {
        entries,
        directionKnownCount,
        excludedControlCount,
        excludedNonUserCount,
        excludedUnknownDirectionCount,
        incomingCount,
        outgoingCount
    };
}
