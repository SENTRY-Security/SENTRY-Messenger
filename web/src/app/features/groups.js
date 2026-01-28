/**
 * Groups Feature Module
 * Handles group creation business logic and local draft storage.
 */

import { createGroup as apiCreateGroup } from '../api/groups.js';
import { deriveConversationContextFromSecret } from './conversation.js';
import { ensureDeviceId } from '../core/store.js';

const LOCAL_GROUP_STORAGE_KEY = 'groups-drafts-v1';
let localGroupsCache = null;

function loadLocalGroups() {
    if (localGroupsCache) return localGroupsCache;
    try {
        const raw = sessionStorage.getItem(LOCAL_GROUP_STORAGE_KEY) || localStorage.getItem(LOCAL_GROUP_STORAGE_KEY);
        if (!raw) {
            localGroupsCache = [];
            return [];
        }
        const parsed = JSON.parse(raw);
        localGroupsCache = Array.isArray(parsed) ? parsed : [];
        return localGroupsCache;
    } catch {
        localGroupsCache = [];
        return [];
    }
}

function persistLocalGroups(groups) {
    localGroupsCache = groups;
    try {
        sessionStorage.setItem(LOCAL_GROUP_STORAGE_KEY, JSON.stringify(groups));
    } catch { }
    try {
        localStorage.setItem(LOCAL_GROUP_STORAGE_KEY, JSON.stringify(groups));
    } catch { }
}

export const LocalGroupStore = {
    list() {
        return loadLocalGroups();
    },
    add(draft) {
        const list = loadLocalGroups();
        const updated = [draft, ...list].slice(0, 20);
        persistLocalGroups(updated);
        return updated;
    }
};

function bytesToB64Url(bytes) {
    const bin = String.fromCharCode(...bytes);
    return btoa(bin)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Orchestrate group creation:
 * 1. Generate secrets and context
 * 2. Call API
 * 3. Store local draft
 */
export async function createGroupProcess({ name, members }) {
    const secret = new Uint8Array(32);
    crypto.getRandomValues(secret);
    const secretB64Url = bytesToB64Url(secret);

    // validation?
    if (!members || !Array.isArray(members)) {
        throw new Error('Invalid members list');
    }

    const { conversationId, tokenB64 } = await deriveConversationContextFromSecret(secretB64Url, { deviceId: ensureDeviceId() });
    const groupId = `grp-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

    const { r, data } = await apiCreateGroup({
        groupId,
        conversationId,
        name: name || null,
        members
    });

    if (!r.ok) {
        const msg = typeof data === 'string' ? data : data?.message || data?.error || '建立失敗';
        throw new Error(msg);
    }

    const draft = {
        groupId,
        name: name || `群組 ${groupId.slice(-4)}`,
        conversationId,
        tokenB64,
        secretB64Url,
        createdAt: Date.now()
    };
    LocalGroupStore.add(draft);

    return draft;
}
