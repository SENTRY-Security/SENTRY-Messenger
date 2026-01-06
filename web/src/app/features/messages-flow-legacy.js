// /app/features/messages-flow-legacy.js
// Facade adapter for legacy message pipeline entry points.
// This file is the only place that calls legacy pipeline functions.

import { logCapped } from '../core/log.js';
import {
  listSecureAndDecrypt,
  syncOfflineDecryptNow,
  triggerServerCatchup,
  triggerServerCatchupForTargets
} from './messages.js';
import { startRestorePipeline } from './restore-coordinator.js';
import {
  OFFLINE_SYNC_LOG_CAP,
  OFFLINE_SYNC_TRIGGER_COALESCE_MS,
  SERVER_CATCHUP_TRIGGER_COALESCE_MS
} from './messages-sync-policy.js';
import { createMessagesFlowScrollFetch } from './messages-flow/scroll-fetch.js';

const LEGACY_OPTION_LOG_CAP = 5;
const USE_MESSAGES_FLOW_SCROLL_FETCH = false;
const LEGACY_LIST_SECURE_ALLOWLIST = new Set([
  'allowReplay',
  'cursorId',
  'cursorTs',
  'limit',
  'mutateState',
  'onMessageDecrypted',
  'prefetchedList',
  'priority',
  'sendReadReceipt',
  'silent',
  'sourceTag'
]);
const LEGACY_ENTER_CONVERSATION_ALLOWLIST = new Set(['silent']);
const messagesFlowScrollFetch = createMessagesFlowScrollFetch();

function toConversationIdPrefix8(conversationId) {
  if (!conversationId) return null;
  const trimmed = String(conversationId).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 8);
}

function pickLegacyOptions(options, allowlist, { source } = {}) {
  if (!options || typeof options !== 'object') return {};
  const allowed = {};
  const dropped = [];
  for (const key of Object.keys(options)) {
    if (allowlist.has(key)) {
      allowed[key] = options[key];
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length) {
    logCapped('legacyFlowOptionDrop', { source: source || null, dropped }, LEGACY_OPTION_LOG_CAP);
  }
  return allowed;
}

function runListSecureAndDecryptLegacy({
  conversationId,
  tokenB64,
  peerAccountDigest,
  peerDeviceId,
  options
} = {}) {
  const filteredOptions = pickLegacyOptions(options, LEGACY_LIST_SECURE_ALLOWLIST, {
    source: 'runListSecureAndDecryptLegacy'
  });
  return listSecureAndDecrypt({
    conversationId,
    tokenB64,
    peerAccountDigest,
    peerDeviceId,
    ...filteredOptions
  });
}

function runOfflineCatchupNow({
  source,
  reasonCode,
  debounceMs,
  onOfflineDecryptError,
  reconcileOutgoingStatus,
  runOfflineDecrypt = true,
  runServerCatchup = true
} = {}) {
  let offlinePromise = null;
  if (runOfflineDecrypt) {
    offlinePromise = syncOfflineDecryptNow({ source, reasonCode });
    if (offlinePromise && typeof offlinePromise.catch === 'function') {
      offlinePromise.catch((err) => {
        if (typeof onOfflineDecryptError === 'function') onOfflineDecryptError(err);
      });
    }
  }
  if (runServerCatchup) {
    triggerServerCatchupForTargets({ source, debounceMs });
  }
  if (typeof reconcileOutgoingStatus === 'function') {
    reconcileOutgoingStatus({ source });
  }
  return offlinePromise;
}

function reconcileOutgoingStatusForConversation({
  conversationId,
  peerAccountDigest,
  source,
  reconcileOutgoingStatusNow
} = {}) {
  if (typeof reconcileOutgoingStatusNow === 'function') {
    return reconcileOutgoingStatusNow({ conversationId, peerAccountDigest, source });
  }
  return null;
}

function createLegacyFacadeAdapter() {
  let offlineSyncTriggerLastAtMs = 0;

  return {
    // Event -> legacy pipeline only. Do not add new flow logic here.
    onLoginResume({
      source,
      runRestore = true,
      runOfflineCatchup = true,
      runOfflineDecrypt = true,
      runServerCatchup = true,
      onOfflineDecryptError,
      reconcileOutgoingStatus
    } = {}) {
      let restorePromise = null;
      if (runRestore) {
        restorePromise = startRestorePipeline({ source });
        if (restorePromise && typeof restorePromise.catch === 'function') {
          restorePromise.catch(() => {});
        }
      }
      if (runOfflineCatchup) {
        runOfflineCatchupNow({
          source,
          runOfflineDecrypt,
          runServerCatchup,
          onOfflineDecryptError,
          reconcileOutgoingStatus
        });
      }
      return restorePromise || null;
    },

    // Event -> legacy pipeline only. Do not add new flow logic here.
    onWsIncomingMessageNew(payload = {}) {
      const event = payload?.event || payload?.msg || payload || null;
      const handler = payload?.handleIncomingSecureMessage;
      if (typeof handler === 'function') {
        return handler(event);
      }
      return null;
    },

    // Event -> legacy pipeline only. Do not add new flow logic here.
    onEnterConversation({
      conversationId,
      peerKey,
      peerAccountDigest,
      peerDeviceId,
      loadActiveConversationMessages,
      replay,
      reason,
      loadOptions,
      runCatchup = true
    } = {}) {
      void peerKey;
      if (runCatchup && conversationId) {
        triggerServerCatchup({
          source: 'enter_conversation',
          conversationId,
          peerAccountDigest,
          peerDeviceId
        });
      }
      if (typeof loadActiveConversationMessages === 'function') {
        const params = {
          append: false,
          replay,
          reason
        };
        const filteredOptions = pickLegacyOptions(loadOptions, LEGACY_ENTER_CONVERSATION_ALLOWLIST, {
          source: 'onEnterConversation'
        });
        if (Object.prototype.hasOwnProperty.call(filteredOptions, 'silent')) {
          params.silent = filteredOptions.silent;
        }
        return loadActiveConversationMessages(params);
      }
      return null;
    },

    // Event -> legacy pipeline only. Do not add new flow logic here.
    onPullToRefreshContacts({
      loadInitialContacts,
      renderContacts,
      syncConversationThreadsFromContacts,
      refreshConversationPreviews,
      renderConversationList,
      onError,
      onFinally
    } = {}) {
      return (async () => {
        let errorMessage = null;
        try {
          if (typeof loadInitialContacts === 'function') {
            await loadInitialContacts();
          }
          if (typeof renderContacts === 'function') {
            renderContacts();
          }
          if (typeof syncConversationThreadsFromContacts === 'function') {
            syncConversationThreadsFromContacts();
          }
          if (typeof refreshConversationPreviews === 'function') {
            await refreshConversationPreviews({ force: true });
          }
          if (typeof renderConversationList === 'function') {
            renderConversationList();
          }
        } catch (err) {
          errorMessage = err?.message || String(err);
          if (typeof onError === 'function') {
            try {
              onError(err);
            } catch (onErrorErr) {
              if (!errorMessage) {
                errorMessage = onErrorErr?.message || String(onErrorErr);
              }
            }
          }
        } finally {
          if (typeof onFinally === 'function') onFinally();
        }
        if (errorMessage) return { ok: false, errorMessage };
        return { ok: true };
      })();
    },

    // Event -> legacy pipeline only. Do not add new flow logic here.
    onVisibilityResume({
      source,
      reconcileOutgoingStatus,
      onOfflineDecryptError
    } = {}) {
      const now = Date.now();
      const coalesced = offlineSyncTriggerLastAtMs
        && Number.isFinite(OFFLINE_SYNC_TRIGGER_COALESCE_MS)
        && (now - offlineSyncTriggerLastAtMs) < OFFLINE_SYNC_TRIGGER_COALESCE_MS;
      logCapped('offlineSyncTriggerTrace', {
        source: source || null,
        coalesced,
        tsMs: now
      }, OFFLINE_SYNC_LOG_CAP);
      if (coalesced) return null;
      offlineSyncTriggerLastAtMs = now;
      return runOfflineCatchupNow({
        source,
        debounceMs: SERVER_CATCHUP_TRIGGER_COALESCE_MS,
        onOfflineDecryptError,
        reconcileOutgoingStatus
      });
    },

    // Event -> legacy pipeline only. Do not add new flow logic here.
    onScrollFetchMore({
      conversationId,
      cursor,
      tokenB64,
      peerKey,
      peerAccountDigest,
      peerDeviceId,
      options
    } = {}) {
      void peerKey;
      const mergedOptions = { ...(options || {}) };
      if (cursor && (mergedOptions.cursorTs === undefined && mergedOptions.cursorId === undefined)) {
        if (typeof cursor === 'object' && cursor !== null) {
          mergedOptions.cursorTs = cursor.ts ?? cursor.cursorTs ?? null;
          mergedOptions.cursorId = cursor.id ?? cursor.cursorId ?? null;
        } else {
          mergedOptions.cursorTs = cursor;
        }
      }
      const limit = Number.isFinite(Number(mergedOptions.limit)) ? Number(mergedOptions.limit) : null;
      const hasCursor = mergedOptions.cursorTs !== undefined || mergedOptions.cursorId !== undefined;
      const isReplay = mergedOptions.mutateState === false;
      const useMessagesFlow = USE_MESSAGES_FLOW_SCROLL_FETCH && isReplay;
      const reasonCode = USE_MESSAGES_FLOW_SCROLL_FETCH
        ? (isReplay ? 'OK' : 'MUTATE_STATE_NOT_REPLAY')
        : 'FLAG_OFF';
      logCapped('scrollFetchRouteTrace', {
        conversationIdPrefix8: toConversationIdPrefix8(conversationId),
        route: useMessagesFlow ? 'messages-flow' : 'legacy',
        reasonCode,
        hasCursor,
        limit
      }, 5);
      if (useMessagesFlow) {
        const normalizedCursor = mergedOptions.cursorTs !== undefined || mergedOptions.cursorId !== undefined
          ? { ts: mergedOptions.cursorTs ?? null, id: mergedOptions.cursorId ?? null }
          : null;
        return messagesFlowScrollFetch({
          conversationId,
          cursor: normalizedCursor,
          limit: mergedOptions.limit,
          isReplay: true
        }).then((result) => ({
          items: Array.isArray(result?.items) ? result.items : [],
          errors: Array.isArray(result?.errors) ? result.errors : [],
          nextCursor: result?.nextCursor ?? null,
          nextCursorTs: result?.nextCursor?.ts ?? null,
          hasMoreAtCursor: !!result?.nextCursor
        }));
      }
      return runListSecureAndDecryptLegacy({
        conversationId,
        tokenB64,
        peerAccountDigest,
        peerDeviceId,
        options: mergedOptions
      });
    },

    // Event -> legacy pipeline only. Do not add new flow logic here.
    reconcileOutgoingStatusNow({
      conversationId,
      peerKey,
      peerAccountDigest,
      source,
      reconcileOutgoingStatusNow
    } = {}) {
      void peerKey;
      return reconcileOutgoingStatusForConversation({
        conversationId,
        peerAccountDigest,
        source,
        reconcileOutgoingStatusNow
      });
    }
  };
}

export const legacyFacade = createLegacyFacadeAdapter();
