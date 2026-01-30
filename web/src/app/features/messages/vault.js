/**
 * Vault items wrapper for Messages V2.
 */

import { getMkRaw } from '../../core/store.js';
import { MessageKeyVault } from '../message-key-vault.js';
import {
    sessionStore,
    restorePendingVaultPuts,
    persistPendingVaultPuts
} from '../../ui/mobile/session-store.js';
import { logCapped } from '../../core/log.js';

const PENDING_VAULT_PUT_QUEUE_LIMIT = 50;
const PENDING_VAULT_PUT_RETRY_INTERVAL_MS = 60_000;
const PENDING_VAULT_PUT_RETRY_MAX = 5;
const OFFLINE_SYNC_LOG_CAP = 100;
const OFFLINE_SYNC_PREFIX_LEN = 8;
const OFFLINE_SYNC_SUFFIX_LEN = 4;

function slicePrefix(value, len = OFFLINE_SYNC_PREFIX_LEN) {
    if (typeof value !== 'string') return null;
    return value.slice(0, len);
}

function sliceSuffix(value, len = OFFLINE_SYNC_SUFFIX_LEN) {
    if (typeof value !== 'string') return null;
    return value.slice(-len);
}

function resolveErrorCode(err) {
    if (!err) return null;
    return err.code || err.errorCode || err.name || null;
}

function normalizeHeaderCounter(val) {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
}

export async function vaultPutMessageKey(params = {}) {
    const mkRaw = getMkRaw();
    return MessageKeyVault.putMessageKey({
        ...params,
        mkRaw
    });
}

export async function vaultGetMessageKey(params = {}) {
    const mkRaw = getMkRaw();
    return MessageKeyVault.getMessageKey({
        ...params,
        mkRaw
    });
}

function buildPendingVaultPutKey({ conversationId, messageId, senderDeviceId } = {}) {
    return `${conversationId || 'unknown'}::${messageId || 'unknown'}::${senderDeviceId || 'unknown'}`;
}

function buildPendingTracePayload(item, action, attemptCount, errorCode = null, status = null) {
    const attempt = Number.isFinite(Number(attemptCount)) ? Number(attemptCount) : 0;
    const payload = {
        action,
        conversationId: slicePrefix(item?.conversationId),
        messageId: item?.messageId || null,
        senderDeviceId: sliceSuffix(item?.senderDeviceId),
        attemptCount: attempt
    };
    if (errorCode) payload.errorCode = errorCode;
    if (Number.isFinite(Number(status))) payload.status = Number(status);
    return payload;
}

function buildRetryTracePayload(item, attemptCount, result, errorCode = null, status = null) {
    const attempt = Number.isFinite(Number(attemptCount)) ? Number(attemptCount) : 0;
    const payload = {
        conversationId: slicePrefix(item?.conversationId),
        messageId: item?.messageId || null,
        attemptCount: attempt,
        result
    };
    if (Number.isFinite(Number(status))) payload.status = Number(status);
    if (errorCode) payload.errorCode = errorCode;
    return payload;
}

/**
 * Check if a message has a pending vault put entry.
 * Used to detect if we should skip re-decryption and just retry vault put.
 */
export function getPendingVaultPutForMessage({ conversationId, messageId, senderDeviceId }) {
    if (!conversationId || !messageId || !senderDeviceId) return null;
    const queue = restorePendingVaultPuts();
    if (!Array.isArray(queue)) return null;
    const key = buildPendingVaultPutKey({ conversationId, messageId, senderDeviceId });
    return queue.find((entry) => buildPendingVaultPutKey(entry) === key) || null;
}

/**
 * Remove a pending vault put entry after successful vault put.
 */
export function removePendingVaultPut({ conversationId, messageId, senderDeviceId }) {
    if (!conversationId || !messageId || !senderDeviceId) return false;
    const queue = restorePendingVaultPuts();
    if (!Array.isArray(queue)) return false;
    const key = buildPendingVaultPutKey({ conversationId, messageId, senderDeviceId });
    const idx = queue.findIndex((entry) => buildPendingVaultPutKey(entry) === key);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    persistPendingVaultPuts();
    return true;
}

export function enqueuePendingVaultPut(params = {}, err = null) {
    const conversationId = params?.conversationId || null;
    const messageId = params?.messageId || null;
    const senderDeviceId = params?.senderDeviceId || null;
    const targetDeviceId = params?.targetDeviceId || null;
    const direction = params?.direction || null;
    const msgType = params?.msgType || null;
    const messageKeyB64 = params?.messageKeyB64 || null;
    const headerCounter = normalizeHeaderCounter(params?.headerCounter);
    const accountDigest = params?.accountDigest || null;
    if (!conversationId || !messageId || !senderDeviceId || !messageKeyB64) return false;
    if (direction !== 'incoming') return false;
    const queue = restorePendingVaultPuts();
    const key = buildPendingVaultPutKey({ conversationId, messageId, senderDeviceId });
    const existing = Array.isArray(queue)
        ? queue.find((entry) => buildPendingVaultPutKey(entry) === key)
        : null;
    const errorCode = resolveErrorCode(err);
    const status = typeof err?.status === 'number' ? err.status : null;
    if (existing) {
        existing.messageKeyB64 = messageKeyB64 || existing.messageKeyB64;
        existing.targetDeviceId = targetDeviceId || existing.targetDeviceId;
        existing.direction = direction || existing.direction;
        existing.msgType = msgType || existing.msgType;
        existing.headerCounter = headerCounter ?? existing.headerCounter ?? null;
        existing.accountDigest = accountDigest || existing.accountDigest || null;
        existing.lastError = err?.message || existing.lastError || null;
        existing.lastErrorCode = errorCode || existing.lastErrorCode || null;
        existing.lastStatus = Number.isFinite(Number(status)) ? Number(status) : existing.lastStatus ?? null;
        existing.updatedAt = Date.now();
        if (!Number.isFinite(Number(existing.nextAttemptAt))) {
            existing.nextAttemptAt = Date.now() + PENDING_VAULT_PUT_RETRY_INTERVAL_MS;
        }
        persistPendingVaultPuts();
        return false;
    }
    if (queue.length >= PENDING_VAULT_PUT_QUEUE_LIMIT) {
        const dropped = queue.shift();
        if (dropped) {
            logCapped('vaultPutPendingTrace', buildPendingTracePayload(
                dropped,
                'drop_oldest',
                dropped?.attemptCount ?? 0,
                dropped?.lastErrorCode ?? null,
                dropped?.lastStatus ?? null
            ), OFFLINE_SYNC_LOG_CAP);
        }
    }
    const now = Date.now();
    const item = {
        conversationId,
        messageId,
        senderDeviceId,
        targetDeviceId: targetDeviceId || null,
        direction,
        msgType,
        messageKeyB64,
        headerCounter,
        accountDigest: accountDigest || null,
        attemptCount: 0,
        nextAttemptAt: now + PENDING_VAULT_PUT_RETRY_INTERVAL_MS,
        lastError: err?.message || (err ? String(err) : null),
        lastErrorCode: errorCode || null,
        lastStatus: Number.isFinite(Number(status)) ? Number(status) : null,
        exhausted: false,
        enqueuedAt: now,
        updatedAt: now
    };
    queue.push(item);
    logCapped('vaultPutPendingTrace', buildPendingTracePayload(
        item,
        'enqueue',
        0,
        errorCode || null,
        status
    ), OFFLINE_SYNC_LOG_CAP);
    persistPendingVaultPuts();
    return true;
}

export async function flushPendingVaultPutsNow() {
    const queue = restorePendingVaultPuts();
    if (!Array.isArray(queue) || !queue.length) return { attempted: 0, success: 0, failed: 0 };
    const mkRaw = getMkRaw();
    if (!mkRaw) return { attempted: 0, success: 0, failed: 0 };
    const now = Date.now();
    const nextQueue = [];
    let attempted = 0;
    let success = 0;
    let failed = 0;
    for (const item of queue) {
        if (!item || item.exhausted === true) {
            nextQueue.push(item);
            continue;
        }
        if (!item.conversationId || !item.messageId || !item.senderDeviceId || !item.messageKeyB64) {
            nextQueue.push(item);
            continue;
        }
        const nextAttemptAt = Number(item.nextAttemptAt) || 0;
        if (nextAttemptAt > now) {
            nextQueue.push(item);
            continue;
        }
        const baseAttemptCount = Number(item.attemptCount) || 0;
        if (baseAttemptCount >= PENDING_VAULT_PUT_RETRY_MAX) {
            if (!item.exhausted) {
                item.exhausted = true;
                logCapped('vaultPutPendingTrace', buildPendingTracePayload(
                    item,
                    'exhausted',
                    baseAttemptCount,
                    item.lastErrorCode ?? null,
                    item.lastStatus ?? null
                ), OFFLINE_SYNC_LOG_CAP);
            }
            nextQueue.push(item);
            continue;
        }
        const attemptCount = baseAttemptCount + 1;
        attempted += 1;
        logCapped('vaultPutPendingTrace', buildPendingTracePayload(
            item,
            'retry',
            attemptCount,
            item.lastErrorCode ?? null,
            item.lastStatus ?? null
        ), OFFLINE_SYNC_LOG_CAP);
        try {
            await MessageKeyVault.putMessageKey({
                conversationId: item.conversationId,
                messageId: item.messageId,
                senderDeviceId: item.senderDeviceId,
                targetDeviceId: item.targetDeviceId || null,
                direction: item.direction || 'incoming',
                msgType: item.msgType || null,
                messageKeyB64: item.messageKeyB64,
                headerCounter: normalizeHeaderCounter(item.headerCounter),
                accountDigest: item.accountDigest || null,
                mkRaw
            });
            success += 1;
            logCapped('vaultPutRetryTrace', buildRetryTracePayload(
                item,
                attemptCount,
                'ok',
                null,
                null
            ), OFFLINE_SYNC_LOG_CAP);
            logCapped('vaultPutPendingTrace', buildPendingTracePayload(
                item,
                'success',
                attemptCount,
                null,
                null
            ), OFFLINE_SYNC_LOG_CAP);
            continue;
        } catch (err) {
            failed += 1;
            const errorCode = resolveErrorCode(err);
            const status = typeof err?.status === 'number' ? err.status : null;
            const updated = {
                ...item,
                attemptCount,
                nextAttemptAt: Date.now() + PENDING_VAULT_PUT_RETRY_INTERVAL_MS,
                lastError: err?.message || (err ? String(err) : null),
                lastErrorCode: errorCode || null,
                lastStatus: Number.isFinite(Number(status)) ? Number(status) : null,
                updatedAt: Date.now()
            };
            logCapped('vaultPutRetryTrace', buildRetryTracePayload(
                item,
                attemptCount,
                'failed',
                errorCode || null,
                status
            ), OFFLINE_SYNC_LOG_CAP);
            if (attemptCount >= PENDING_VAULT_PUT_RETRY_MAX) {
                updated.exhausted = true;
                logCapped('vaultPutPendingTrace', buildPendingTracePayload(
                    updated,
                    'exhausted',
                    attemptCount,
                    errorCode || null,
                    status
                ), OFFLINE_SYNC_LOG_CAP);
            }
            nextQueue.push(updated);
        }
    }
    sessionStore.pendingVaultPuts = nextQueue;
    persistPendingVaultPuts();
    return { attempted, success, failed };
}
