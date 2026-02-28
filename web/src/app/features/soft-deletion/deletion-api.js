import { getAccountToken, getDeviceId } from '../../core/store.js';
import { fetchWithTimeout, jsonReq } from '../../core/http.js';

export async function setDeletionCursor(conversationId, minTs) {
    if (!conversationId) throw new Error('conversationId required');
    if (!Number.isFinite(minTs) || minTs <= 0) throw new Error('minTs required');
    // [FIX] Normalize to seconds — the server compares normalized created_at
    // (seconds) against min_ts.  If min_ts is in milliseconds (e.g. from
    // Date.now()), the comparison `created_at_sec > min_ts_ms` is always false,
    // permanently hiding ALL messages for the conversation.
    const normalizedMinTs = minTs > 100000000000 ? Math.floor(minTs / 1000) : minTs;
    const token = getAccountToken();
    if (!token) throw new Error('Not logged in');

    const deviceId = getDeviceId();

    const payload = {
        conversation_id: conversationId,
        min_ts: normalizedMinTs
    };

    const headers = {
        'X-Account-Token': token
    };
    if (deviceId) {
        headers['X-Device-Id'] = deviceId;
    }

    const r = await fetchWithTimeout('/api/v1/deletion/cursor', jsonReq(payload, headers), 10000);

    if (!r.ok) {
        const text = await r.text();
        throw new Error(`Failed to set deletion cursor: ${r.status} ${text}`);
    }

    return true;
}

export async function setPeerDeletionCursor(conversationId, peerAccountDigest, counter) {
    return true;
}
