import { setDeletionCursor as apiSetDeletionCursor, setPeerDeletionCursor as apiSetPeerDeletionCursor } from './deletion-api.js';

export async function setDeletionCursor(conversationId, minTs) {
    console.log('[deletion-store] setDeletionCursor', { conversationId, minTs });
    return apiSetDeletionCursor(conversationId, minTs);
}

export async function setPeerDeletionCursor(conversationId, peerAccountDigest, counter) {
    console.log('[deletion-store] setPeerDeletionCursor', { conversationId, peerAccountDigest, counter });
    return apiSetPeerDeletionCursor(conversationId, peerAccountDigest, counter);
}
