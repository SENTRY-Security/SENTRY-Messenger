import { getAccountToken } from '../../core/store.js';
import { fetchWithTimeout, jsonReq } from '../../core/http.js';

export async function setDeletionCursor(conversationId, counter) {
    if (!conversationId) throw new Error('conversationId required');
    const token = getAccountToken();
    if (!token) throw new Error('Not logged in');

    const payload = {
        conversation_id: conversationId,
        min_counter: counter
    };

    const r = await fetchWithTimeout('/api/v1/deletion/cursor', jsonReq(payload, {
        'X-Account-Token': token
    }), 10000);

    if (!r.ok) {
        const text = await r.text();
        throw new Error(`Failed to set deletion cursor: ${r.status} ${text}`);
    }

    return true;
}

export async function setPeerDeletionCursor(conversationId, peerAccountDigest, counter) {
    return true;
}
