import { setDeletionCursor as apiSetDeletionCursor, setPeerDeletionCursor as apiSetPeerDeletionCursor } from './deletion-api.js';

export async function setDeletionCursor(conversationId, counter, opts) {
    console.log('[deletion-store] setDeletionCursor', { conversationId, counter, minTs: opts?.minTs });
    return apiSetDeletionCursor(conversationId, counter, opts);
}

export async function setPeerDeletionCursor(conversationId, peerAccountDigest, counter) {
    console.log('[deletion-store] setPeerDeletionCursor', { conversationId, peerAccountDigest, counter });
    return apiSetPeerDeletionCursor(conversationId, peerAccountDigest, counter);
}
