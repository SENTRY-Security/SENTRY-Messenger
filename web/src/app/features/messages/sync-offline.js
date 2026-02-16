/**
 * Offline sync and restore logic for Messages V2.
 */

import { logCapped } from '../../core/log.js';
// Imports removed (slicePrefix, normalizeOfflineSyncSource) as they are defined locally or unused.

// Constants
export const OFFLINE_SYNC_LOG_CAP = 50;
export const OFFLINE_SYNC_PREFIX_LEN = 8;
export const OFFLINE_SYNC_SOURCES = new Set([
    'login',
    'restore_pipeline',
    'ws_reconnect',
    'pull_to_refresh',
    'enter_conversation',
    'visibility_resume',
    'pageshow_resume'
]);

// Helpers (previously local or imported, check definitions needed)
// normalizeOfflineSyncSource was used in messages.js, I need to check if it's imported or local (it looked local in grep but I didn't see definition).
// Actually, looking at usages, it seemed to be a function call.
// I'll assume they were local and I need to move them or redefine them.

// Re-implementing helpers here if they were local in messages.js (checking previous views, I didn't see explicit export or import for them in the snippets).
// I will implement basic versions or copy them if I can confirm.

function _slicePrefix(value) {
    return value ? String(value).slice(0, 8) : null;
}

export function normalizeOfflineSyncSource(source) {
    if (!source) return 'unknown';
    if (OFFLINE_SYNC_SOURCES.has(source)) return source;
    return 'unknown';
}

export function normalizeBRouteSourceLabel(tag) {
    return tag ? `b-route:${tag}` : 'b-route:unknown';
}

// Previously collectOfflineCatchupTargets was called. I need to move it here too.
// It seems it relies on sessionStore. 

import {
    restoreOfflineDecryptCursorStore,
    persistOfflineDecryptCursorStore
    // sessionStore usage?
} from '../../ui/mobile/session-store.js';

import {
    hydrateDrStatesFromContactSecrets
} from '../dr-session.js';

import {
    flushPendingVaultPutsNow
} from '../messages.js'; // Imported from parent features directory

// We will inject dependencies to avoid circular imports where possible.
// listSecureAndDecrypt is the big one.

export async function processOfflineSync({ source, reasonCode }, dependencies = {}) {
    const {
        listSecureAndDecrypt,
        collectOfflineCatchupTargets, // Moving this logic here or injecting? It accesses sessionStore.
        hydrateDrStatesFromContactSecrets,
        resolveCatchupFailReason,
        truncateErrorMessage,
        resolveErrorCode,
        emitBRouteResultEvent, // These were local in messages.js
        logBRouteResultTrace,
        logCatchupTrace,
        logDecryptUnableTrace,
        logBRouteTriggerTrace,
        flushPendingVaultPutsNow
    } = dependencies;

    const sourceTag = normalizeOfflineSyncSource(source);
    const sourceLabel = normalizeBRouteSourceLabel(sourceTag);

    try {
        if (typeof hydrateDrStatesFromContactSecrets === 'function') {
            hydrateDrStatesFromContactSecrets({ source: `syncOfflineDecryptNow:${sourceTag}` });
        }
    } catch { }

    const cursorStore = restoreOfflineDecryptCursorStore();
    const targets = collectOfflineCatchupTargets ? collectOfflineCatchupTargets() : [];
    const plannedCount = targets.length;
    // Use local _slicePrefix to avoid loop
    const conversationIds = targets.map((entry) => _slicePrefix(entry?.conversationId)).filter(Boolean).slice(0, OFFLINE_SYNC_LOG_CAP);

    const reasonRaw = typeof reasonCode === 'string' && reasonCode.trim() ? reasonCode.trim() : null;

    logCapped('offlineCatchupTargetsTrace', {
        source: sourceTag,
        plannedCount,
        sampleConvPrefix8: conversationIds
    }, OFFLINE_SYNC_LOG_CAP);

    if (logBRouteTriggerTrace) {
        logBRouteTriggerTrace({
            sourceLabel,
            plannedConvs: conversationIds,
            reasonCode: reasonRaw || (plannedCount > 0 ? 'PLANNED' : 'NO_TARGETS')
        });
    }

    let attemptedCount = 0;
    let successCount = 0;
    let failCount = 0;
    const failures = [];
    const results = [];
    const lockedConversations = [];

    for (const target of targets) {
        attemptedCount += 1;
        const convId = target?.conversationId || null;
        try {
            const cursorEntry = cursorStore instanceof Map ? cursorStore.get(String(convId)) : null;
            const cursorTs = cursorEntry?.cursorTs ?? null;
            const cursorId = cursorEntry?.cursorId ?? null;

            const result = await listSecureAndDecrypt({
                conversationId: convId,
                tokenB64: target?.tokenB64 || null,
                peerAccountDigest: target?.peerAccountDigest || null,
                peerDeviceId: target?.peerDeviceId || null,
                limit: 50, // OFFLINE_CATCHUP_MESSAGE_LIMIT
                cursorTs: cursorTs ?? null,
                cursorId: cursorId ?? null,
                mutateState: true,
                allowReplay: false,
                sendReadReceipt: false,
                silent: true,
                priority: 'live',
                sourceTag: `b-route:${sourceTag}`,
                bRoute: true
            });

            const lockInfo = result?.lockInfo || null;
            const errors = Array.isArray(result?.errors) ? result.errors : [];
            const stats = result?.replayStats || {};
            const itemsFetched = stats?.fetchedItems ?? result?.serverItemCount ?? result?.items?.length ?? 0;
            const decryptOkCount = stats?.decryptOk ?? 0;
            const vaultPutIncomingOkCount = stats?.vaultPutIncomingOk ?? 0;
            const nextCursor = result?.next_cursor
                || (result?.next_cursor_ts != null
                    ? { ts: result.next_cursor_ts, id: result?.next_cursor_id ?? null }
                    : null);

            if (result?.hasMoreAtCursor && nextCursor) {
                cursorStore.set(String(convId), {
                    cursorTs: nextCursor?.ts ?? null,
                    cursorId: nextCursor?.id ?? null,
                    hasMoreAtCursor: true,
                    updatedAt: Date.now()
                });
            } else if (cursorStore instanceof Map) {
                cursorStore.delete(String(convId));
            }

            const failReason = errors.length && resolveCatchupFailReason ? resolveCatchupFailReason({ errors, lockInfo }) : null;
            let errorMessage = errors.length && truncateErrorMessage ? truncateErrorMessage(errors[0]) : null;

            if (lockInfo?.holderOwner || lockInfo?.holderPriority) {
                const holderPriority = lockInfo?.holderPriority || 'unknown';
                const holderOwner = lockInfo?.holderOwner || null;
                errorMessage = `LOCKED:${holderPriority}${holderOwner ? `:${holderOwner}` : ''}`;
            }

            if (logBRouteResultTrace) {
                logBRouteResultTrace({
                    conversationId: convId,
                    itemsFetched,
                    decryptOkCount,
                    vaultPutIncomingOkCount,
                    errorMessage: errors.length ? errorMessage : null
                });
            }

            const resEntry = {
                conversationId: convId,
                itemsFetched,
                decryptOkCount,
                vaultPutIncomingOkCount,
                failReason: failReason || null,
                errorMessage: errorMessage || null,
                lockInfo: lockInfo
                    ? {
                        holderPriority: lockInfo?.holderPriority || null,
                        holderOwner: lockInfo?.holderOwner || null
                    }
                    : null
            };
            results.push(resEntry);

            if (emitBRouteResultEvent) {
                emitBRouteResultEvent({
                    conversationId: convId,
                    source: sourceLabel,
                    fetchedItems: itemsFetched,
                    decryptOk: decryptOkCount,
                    vaultPutIncomingOk: vaultPutIncomingOkCount,
                    failReason: failReason || null,
                    errorMessage: errorMessage || null,
                    lockInfo: lockInfo
                        ? {
                            holderPriority: lockInfo?.holderPriority || null,
                            holderOwner: lockInfo?.holderOwner || null
                        }
                        : null
                });
            }

            if (failReason === 'LOCKED') lockedConversations.push(convId);

            if (errors.length) {
                failCount += 1;
                if (logCatchupTrace) {
                    logCatchupTrace({
                        conversationId: convId,
                        sourceTag,
                        itemsFetched,
                        decryptOkCount,
                        vaultPutIncomingOkCount,
                        failReason
                    });
                }
                if (logDecryptUnableTrace) {
                    logDecryptUnableTrace({
                        conversationId: convId,
                        reasonCode: failReason,
                        errorMessage: errorMessage,
                        sourceTag
                    });
                }
                failures.push({
                    conversationId: _slicePrefix(convId),
                    errorMessage: errorMessage || 'listSecureAndDecrypt failed'
                });
            } else {
                successCount += 1;
                if (logCatchupTrace) {
                    logCatchupTrace({
                        conversationId: convId,
                        sourceTag,
                        itemsFetched,
                        decryptOkCount,
                        vaultPutIncomingOkCount,
                        failReason: null
                    });
                }
            }

        } catch (err) {
            failCount += 1;
            const errorCode = resolveErrorCode ? resolveErrorCode(err) : 'UNKNOWN';
            const errorMessage = (errorCode || !truncateErrorMessage) ? null : truncateErrorMessage(err?.message || err);
            const failReason = resolveCatchupFailReason ? resolveCatchupFailReason({ err }) : 'UNKNOWN';

            if (logCatchupTrace) {
                logCatchupTrace({
                    conversationId: convId,
                    sourceTag,
                    itemsFetched: 0,
                    decryptOkCount: 0,
                    vaultPutIncomingOkCount: 0,
                    failReason
                });
            }
            if (logDecryptUnableTrace) {
                logDecryptUnableTrace({
                    conversationId: convId,
                    reasonCode: failReason,
                    errorMessage: errorMessage || null,
                    sourceTag
                });
            }
            if (logBRouteResultTrace) {
                logBRouteResultTrace({
                    conversationId: convId,
                    itemsFetched: 0,
                    decryptOkCount: 0,
                    vaultPutIncomingOkCount: 0,
                    errorMessage: errorMessage || errorCode || 'listSecureAndDecrypt failed'
                });
            }

            results.push({
                conversationId: convId,
                itemsFetched: 0,
                decryptOkCount: 0,
                vaultPutIncomingOkCount: 0,
                failReason: failReason || null,
                errorMessage: errorMessage || null,
                errorCode: errorCode || null,
                lockInfo: null
            });

            if (emitBRouteResultEvent) {
                emitBRouteResultEvent({
                    conversationId: convId,
                    source: sourceLabel,
                    fetchedItems: 0,
                    decryptOk: 0,
                    vaultPutIncomingOk: 0,
                    failReason: failReason || null,
                    errorMessage: errorMessage || null,
                    errorCode: errorCode || null,
                    lockInfo: null
                });
            }

            failures.push({
                conversationId: _slicePrefix(convId),
                ...(errorCode ? { errorCode } : { errorMessage: errorMessage || 'listSecureAndDecrypt failed' })
            });
        }
    }

    persistOfflineDecryptCursorStore();

    logCapped('offlineDecryptFlushTrace', {
        source: sourceTag,
        conversationIds,
        plannedCount,
        attemptedCount,
        successCount,
        failCount,
        failures: failures.slice(0, OFFLINE_SYNC_LOG_CAP)
    }, OFFLINE_SYNC_LOG_CAP);

    if (flushPendingVaultPutsNow) {
        await flushPendingVaultPutsNow();
    }

    return { plannedCount, attemptedCount, successCount, failCount, results, lockedConversations };
}
