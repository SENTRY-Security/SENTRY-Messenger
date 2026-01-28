/**
 * Gap filling and server catchup logic for Messages V2.
 */

import { fetchSecureMaxCounter } from '../../api/messages.js';
import { logCapped } from '../../core/log.js';
const OFFLINE_SYNC_PREFIX_LEN = 8;

function slicePrefix(value, len = OFFLINE_SYNC_PREFIX_LEN) {
    if (typeof value !== 'string') return null;
    return value.slice(0, len);
}

export function logServerCatchupEnqueueTrace({ source, conversationId, targetCounter, deduped } = {}) {
    logCapped('serverCatchupEnqueueTrace', {
        source: source || null,
        conversationIdPrefix8: slicePrefix(conversationId),
        targetCounter: Number.isFinite(Number(targetCounter)) ? Number(targetCounter) : null,
        deduped: !!deduped
    }, 5);
}

export function logServerCatchupApiTrace({ endpoint, ok, status, errorCode } = {}) {
    logCapped('serverCatchupApiTrace', {
        endpoint: endpoint || null,
        ok: !!ok,
        status: Number.isFinite(Number(status)) ? Number(status) : null,
        errorCode: errorCode || null
    }, 5);
}

function resolveErrorCode(err) {
    if (!err) return null;
    if (typeof err?.code === 'string' || typeof err?.code === 'number') return String(err.code);
    if (typeof err?.errorCode === 'string' || typeof err?.errorCode === 'number') return String(err.errorCode);
    if (typeof err?.status === 'number') return String(err.status);
    return null;
}

export async function fetchServerMaxCounter({ conversationId, senderDeviceId } = {}) {
    const endpoint = '/api/v1/messages/secure/max-counter';
    // Note: we import fetchSecureMaxCounter directly, skipping 'deps' indirection
    try {
        const { r, data } = await fetchSecureMaxCounter({ conversationId, senderDeviceId });
        const ok = !!r?.ok;
        const status = typeof r?.status === 'number' ? r.status : null;
        const maxCounterRaw = data?.maxCounter ?? data?.max_counter ?? null;
        const maxCounter = Number.isFinite(Number(maxCounterRaw)) ? Number(maxCounterRaw) : null;
        const errorCode = ok
            ? null
            : (data?.errorCode || data?.error || data?.code || (typeof data === 'string' ? data : null));
        logServerCatchupApiTrace({ endpoint, ok, status, errorCode });
        return { ok, maxCounter };
    } catch (err) {
        const errorCode = resolveErrorCode(err);
        logServerCatchupApiTrace({ endpoint, ok: false, status: null, errorCode: errorCode || null });
        return { ok: false, maxCounter: null };
    }
}
