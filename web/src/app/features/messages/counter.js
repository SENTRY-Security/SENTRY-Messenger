/**
 * Counter normalization and handling logic for Messages V2.
 */

export function normalizeHeaderCounter(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeTransportCounter(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

export function getIncomingCounterState(state) {
    return {
        Ns: normalizeTransportCounter(state?.Ns),
        Nr: normalizeTransportCounter(state?.Nr),
        PN: normalizeTransportCounter(state?.PN)
    };
}

export function updateIncomingCounterState(state, counter) {
    if (!state || typeof state !== 'object') return;
    const val = normalizeTransportCounter(counter);
    if (val !== null) state.Nr = val;
}

export function buildCounterMessageId(counter) {
    return `counter:${counter}`;
}

export function isCounterFetchClientError(status) {
    return Number.isFinite(status) && status >= 400 && status < 500;
}

export function shouldRetryCounterFetch(status) {
    if (!Number.isFinite(status)) return true;
    return status >= 500;
}

export function resolveCounterFetchFailureReason(status, error) {
    if (isCounterFetchClientError(status)) return 'unable_to_decrypt';
    return error || 'gap fetch failed';
}
