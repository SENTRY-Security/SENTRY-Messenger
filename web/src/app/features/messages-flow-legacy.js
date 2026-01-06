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
import { runLiveCatchupForConversation } from './messages-flow/live/coordinator.js';
import { createLiveLegacyAdapters } from './messages-flow/live/adapters/index.js';

const LEGACY_OPTION_LOG_CAP = 5;
const LIVE_ROUTE_LOG_CAP = 5;
const USE_MESSAGES_FLOW_SCROLL_FETCH = false;
const USE_MESSAGES_FLOW_LIVE = false;
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
const liveLegacyAdapters = createLiveLegacyAdapters();

function toConversationIdPrefix8(conversationId) {
  if (!conversationId) return null;
  const trimmed = String(conversationId).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 8);
}

function normalizeDigestOnly(value) {
  if (!value) return null;
  const raw = typeof value === 'string'
    ? value
    : (value?.peerAccountDigest || value?.peerDigest || value?.accountDigest || null);
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  return trimmed.split('::')[0] || null;
}

function resolveConversationId(event, ctx) {
  return event?.conversationId
    || event?.conversation_id
    || ctx?.conversationId
    || null;
}

function resolveTargetCounter(event) {
  const raw = event?.counter
    ?? event?.header?.counter
    ?? event?.header?.meta?.counter
    ?? event?.meta?.counter
    ?? event?.message?.counter
    ?? null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function resolveTokenB64(event, ctx) {
  return ctx?.tokenB64
    || event?.tokenB64
    || event?.token_b64
    || null;
}

function buildLiveCoordinatorParams({ event, ctx, triggerSource }) {
  const conversationId = resolveConversationId(event, ctx);
  return {
    conversationId,
    peerAccountDigest: normalizeDigestOnly(
      ctx?.peerAccountDigest
        || event?.peerAccountDigest
        || event?.senderAccountDigest
        || event?.sender_account_digest
        || null
    ),
    peerDeviceId: ctx?.peerDeviceId
      || event?.peerDeviceId
      || event?.senderDeviceId
      || event?.sender_device_id
      || null,
    tokenB64: resolveTokenB64(event, ctx),
    triggerSource: triggerSource || null,
    targetCounter: resolveTargetCounter(event),
    mode: 'ws_incoming'
  };
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
    onWsIncomingMessageNew(payloadOrEvent = {}, ctx = null) {
      const hasExplicitCtx = !!(ctx && typeof ctx === 'object');
      const isPayloadObject = !hasExplicitCtx && payloadOrEvent && typeof payloadOrEvent === 'object' && (
        Object.prototype.hasOwnProperty.call(payloadOrEvent, 'event')
        || Object.prototype.hasOwnProperty.call(payloadOrEvent, 'msg')
        || typeof payloadOrEvent.handleIncomingSecureMessage === 'function'
      );
      const event = isPayloadObject
        ? (payloadOrEvent?.event || payloadOrEvent?.msg || payloadOrEvent)
        : (payloadOrEvent || null);
      const handler = isPayloadObject
        ? payloadOrEvent?.handleIncomingSecureMessage
        : ctx?.handleIncomingSecureMessage;
      const triggerSource = (isPayloadObject
        ? (payloadOrEvent?.triggerSource || payloadOrEvent?.source)
        : ctx?.triggerSource) || 'ws_incoming';
      const conversationId = resolveConversationId(event, ctx);
      const decision = USE_MESSAGES_FLOW_LIVE ? 'dual_path' : 'legacy_only';
      logCapped('liveRouteTrace', {
        triggerSource,
        conversationIdPrefix8: toConversationIdPrefix8(conversationId),
        decision,
        flagState: USE_MESSAGES_FLOW_LIVE
      }, LIVE_ROUTE_LOG_CAP);

      if (USE_MESSAGES_FLOW_LIVE) {
        const params = buildLiveCoordinatorParams({ event, ctx, triggerSource });
        try {
          const livePromise = runLiveCatchupForConversation(params, { adapters: liveLegacyAdapters });
          if (livePromise && typeof livePromise.catch === 'function') {
            livePromise.catch(() => {});
          }
        } catch {}
      }

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
