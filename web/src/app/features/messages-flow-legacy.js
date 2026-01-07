// /app/features/messages-flow-legacy.js
// Facade adapter for legacy message pipeline entry points.
// This file is the only place that calls legacy pipeline functions.

import { logCapped } from '../core/log.js';
import { getDeviceId as storeGetDeviceId } from '../core/store.js';
import { sessionStore } from '../ui/mobile/session-store.js';
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
import { createGapQueue } from './messages-flow/gap-queue.js';
import { createMaxCounterProbe } from './messages-flow/probe.js';
import { consumeLiveJob } from './messages-flow/live/coordinator.js';
import { createLiveJobFromWsEvent } from './messages-flow/live/job.js';
import { createLiveLegacyAdapters } from './messages-flow/live/adapters/index.js';
import { decideNextAction } from './messages-flow/reconcile/decision.js';

const LEGACY_OPTION_LOG_CAP = 5;
const LIVE_ROUTE_LOG_CAP = 5;
const LIVE_MVP_RESULT_LOG_CAP = 5;
const LIVE_MVP_RESULT_METRICS_DEFAULTS = Object.freeze({
  fetchedCount: 0,
  decryptOkCount: 0,
  decryptFailCount: 0,
  decryptSkippedCount: 0,
  vaultPutOkCount: 0,
  vaultPutFailCount: 0,
  appendedCount: 0,
  fetchErrorsLength: 0
});
const DECISION_TRACE_LOG_CAP = 5;
const USE_MESSAGES_FLOW_SCROLL_FETCH = false;
const USE_MESSAGES_FLOW_LIVE = false;
const USE_MESSAGES_FLOW_MAX_COUNTER_PROBE = false;
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
const maxCounterProbeQueue = createGapQueue();
const maxCounterProbe = createMaxCounterProbe({ gapQueue: maxCounterProbeQueue });
const liveLegacyAdapters = createLiveLegacyAdapters();

function toConversationIdPrefix8(conversationId) {
  if (!conversationId) return null;
  const trimmed = String(conversationId).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 8);
}

function toMessageIdPrefix8(messageId) {
  if (!messageId) return null;
  const trimmed = String(messageId).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 8);
}

function normalizeMessageIdValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeConversationIdValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeSourceTag(value, fallback) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  if (typeof fallback === 'string') {
    const trimmed = fallback.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function toDeviceIdSuffix4(deviceId) {
  if (!deviceId) return null;
  const trimmed = String(deviceId).trim();
  if (!trimmed) return null;
  return trimmed.slice(-4);
}

function collectActiveConversationIds() {
  const ids = new Set();
  const addId = (value) => {
    const normalized = normalizeConversationIdValue(value);
    if (normalized) ids.add(normalized);
  };
  addId(sessionStore?.messageState?.conversationId || null);
  const convIndex = sessionStore?.conversationIndex;
  if (convIndex && typeof convIndex.keys === 'function') {
    for (const key of convIndex.keys()) {
      addId(key);
    }
  }
  const threads = sessionStore?.conversationThreads;
  if (threads && typeof threads.keys === 'function') {
    for (const key of threads.keys()) {
      addId(key);
    }
  }
  return Array.from(ids);
}

function triggerMaxCounterProbeForActiveConversations({ source } = {}) {
  if (!USE_MESSAGES_FLOW_MAX_COUNTER_PROBE) return;
  const senderDeviceId = storeGetDeviceId();
  const senderDeviceIdSuffix4 = toDeviceIdSuffix4(senderDeviceId);
  const sourceTag = normalizeSourceTag(source, null);
  if (!senderDeviceId) {
    logCapped('maxCounterProbeTrace', {
      source: sourceTag,
      conversationIdPrefix8: null,
      senderDeviceIdSuffix4: null,
      ok: false,
      reasonCode: 'MISSING_SENDER_DEVICE_ID'
    }, 5);
    return;
  }
  const conversationIds = collectActiveConversationIds();
  if (!conversationIds.length) {
    logCapped('maxCounterProbeTrace', {
      source: sourceTag,
      conversationIdPrefix8: null,
      senderDeviceIdSuffix4,
      ok: false,
      reasonCode: 'MISSING_CONVERSATION_ID'
    }, 5);
    return;
  }
  for (const conversationId of conversationIds) {
    void maxCounterProbe({
      conversationId,
      senderDeviceId,
      source: sourceTag
    });
  }
}

function resolveWsConversationId(event, ctx) {
  return event?.conversationId
    || event?.conversation_id
    || ctx?.conversationId
    || null;
}

function resolveWsMessageId(event, ctx) {
  return normalizeMessageIdValue(
    event?.messageId
      || event?.message_id
      || event?.id
      || event?.serverMessageId
      || event?.server_message_id
      || event?.serverMsgId
      || ctx?.messageId
      || ctx?.message_id
      || ctx?.id
      || ctx?.serverMessageId
      || ctx?.server_message_id
      || ctx?.serverMsgId
      || null
  );
}

function summarizeLiveMvpMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') {
    return { ...LIVE_MVP_RESULT_METRICS_DEFAULTS };
  }
  const toNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  };
  return {
    fetchedCount: toNumber(metrics.fetchedCount),
    decryptOkCount: toNumber(metrics.decryptOkCount),
    decryptFailCount: toNumber(metrics.decryptFailCount),
    decryptSkippedCount: toNumber(metrics.decryptSkippedCount),
    vaultPutOkCount: toNumber(metrics.vaultPutOkCount),
    vaultPutFailCount: toNumber(metrics.vaultPutFailCount),
    appendedCount: toNumber(metrics.appendedCount),
    fetchErrorsLength: toNumber(metrics.fetchErrorsLength)
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
      triggerMaxCounterProbeForActiveConversations({
        source: normalizeSourceTag(source, 'login_resume')
      });
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
      const liveJobCtx = hasExplicitCtx
        ? {
          conversationId: ctx?.conversationId,
          tokenB64: ctx?.tokenB64,
          messageId: ctx?.messageId,
          message_id: ctx?.message_id,
          id: ctx?.id,
          serverMessageId: ctx?.serverMessageId,
          server_message_id: ctx?.server_message_id,
          serverMsgId: ctx?.serverMsgId,
          peerAccountDigest: ctx?.peerAccountDigest,
          peerDeviceId: ctx?.peerDeviceId,
          sourceTag: triggerSource
        }
        : { sourceTag: triggerSource };
      const liveJobResult = createLiveJobFromWsEvent(event, liveJobCtx);
      const liveJob = liveJobResult?.job || null;
      const liveJobReason = liveJobResult?.reason || null;
      const liveJobMessageId = liveJob?.messageId || liveJob?.serverMessageId || null;

      const isOnline = typeof ctx?.isOnline === 'boolean'
        ? ctx.isOnline
        : (typeof payloadOrEvent?.isOnline === 'boolean' ? payloadOrEvent.isOnline : true);
      const decisionContext = {
        eventType: 'ws_incoming',
        flags: {
          liveEnabled: USE_MESSAGES_FLOW_LIVE,
          hasLiveJob: !!liveJob,
          isOnline
        },
        observedState: {
          liveJobReason: liveJobReason || null
        }
      };
      const decisionResult = decideNextAction(decisionContext);
      const summaryConversationId = liveJob?.conversationId
        || resolveWsConversationId(event, hasExplicitCtx ? ctx : null);
      const summaryMessageId = liveJobMessageId
        || resolveWsMessageId(event, hasExplicitCtx ? ctx : null);
      const liveJobSummary = {
        conversationIdPrefix8: toConversationIdPrefix8(summaryConversationId),
        messageIdPrefix8: toMessageIdPrefix8(summaryMessageId)
      };

      logCapped('liveMvpRouteTrace', {
        sourceTag: triggerSource || null,
        ...liveJobSummary,
        decision: decisionResult?.action || null,
        reasonCode: decisionResult?.reason || null,
        jobReason: liveJobReason || null,
        flagState: USE_MESSAGES_FLOW_LIVE
      }, LIVE_ROUTE_LOG_CAP);

      logCapped('decisionTrace', {
        eventType: decisionContext.eventType,
        action: decisionResult?.action || null,
        reason: decisionResult?.reason || null,
        ...liveJobSummary,
        jobReason: liveJobReason || null
      }, DECISION_TRACE_LOG_CAP);

      const legacyResult = typeof handler === 'function' ? handler(event) : null;
      const shouldTriggerLive = decisionResult?.action === 'TRIGGER_LIVE_MVP';

      if (!USE_MESSAGES_FLOW_LIVE) {
        logCapped('liveMvpResultTrace', {
          planned: false,
          ...liveJobSummary,
          ok: null,
          reasonCode: null,
          tookMs: 0,
          metrics: summarizeLiveMvpMetrics(null)
        }, LIVE_MVP_RESULT_LOG_CAP);
      }

      if (!shouldTriggerLive) {
        if (USE_MESSAGES_FLOW_LIVE) {
          logCapped('liveMvpResultTrace', {
            planned: false,
            ...liveJobSummary,
            ok: null,
            reasonCode: decisionResult?.reason || liveJobReason || null,
            tookMs: 0,
            metrics: summarizeLiveMvpMetrics(null)
          }, LIVE_MVP_RESULT_LOG_CAP);
        }
        return legacyResult;
      }

      if (!USE_MESSAGES_FLOW_LIVE) {
        return legacyResult;
      }

      if (!liveJob) {
        logCapped('liveMvpResultTrace', {
          planned: false,
          ...liveJobSummary,
          ok: null,
          reasonCode: liveJobReason || 'MISSING_PARAMS',
          tookMs: 0,
          metrics: summarizeLiveMvpMetrics(null)
        }, LIVE_MVP_RESULT_LOG_CAP);
        return legacyResult;
      }

      try {
        const liveMvpResultMeta = { ...liveJobSummary };
        const livePromise = consumeLiveJob(liveJob, { adapters: liveLegacyAdapters });
        if (livePromise && typeof livePromise.then === 'function') {
          livePromise
            .then((liveResult) => {
              const resultConversationIdPrefix8 = toConversationIdPrefix8(liveResult?.conversationId)
                || liveMvpResultMeta.conversationIdPrefix8;
              const resultMessageIdPrefix8 = toMessageIdPrefix8(liveResult?.messageId)
                || liveMvpResultMeta.messageIdPrefix8;
              logCapped('liveMvpResultTrace', {
                planned: true,
                ok: !!liveResult?.ok,
                reasonCode: liveResult?.reasonCode || null,
                conversationIdPrefix8: resultConversationIdPrefix8,
                messageIdPrefix8: resultMessageIdPrefix8,
                tookMs: Number.isFinite(Number(liveResult?.tookMs)) ? Number(liveResult?.tookMs) : 0,
                metrics: summarizeLiveMvpMetrics(liveResult?.metrics)
              }, LIVE_MVP_RESULT_LOG_CAP);
            })
            .catch((err) => {
              logCapped('liveMvpResultTrace', {
                planned: true,
                ok: false,
                reasonCode: err?.reasonCode || null,
                conversationIdPrefix8: liveMvpResultMeta.conversationIdPrefix8,
                messageIdPrefix8: liveMvpResultMeta.messageIdPrefix8,
                tookMs: Number.isFinite(Number(err?.tookMs)) ? Number(err?.tookMs) : 0,
                metrics: summarizeLiveMvpMetrics(null),
              }, LIVE_MVP_RESULT_LOG_CAP);
            });
        } else if (livePromise && typeof livePromise.catch === 'function') {
          livePromise.catch((err) => {
            logCapped('liveMvpResultTrace', {
              planned: true,
              ok: false,
              reasonCode: err?.reasonCode || null,
              conversationIdPrefix8: liveMvpResultMeta.conversationIdPrefix8,
              messageIdPrefix8: liveMvpResultMeta.messageIdPrefix8,
              tookMs: Number.isFinite(Number(err?.tookMs)) ? Number(err?.tookMs) : 0,
              metrics: summarizeLiveMvpMetrics(null),
            }, LIVE_MVP_RESULT_LOG_CAP);
          });
        }
      } catch (err) {
        logCapped('liveMvpResultTrace', {
          planned: true,
          ok: false,
          reasonCode: err?.reasonCode || null,
          conversationIdPrefix8: liveJobSummary.conversationIdPrefix8,
          messageIdPrefix8: liveJobSummary.messageIdPrefix8,
          tookMs: 0,
          metrics: summarizeLiveMvpMetrics(null),
        }, LIVE_MVP_RESULT_LOG_CAP);
      }

      return legacyResult;
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
      if (USE_MESSAGES_FLOW_MAX_COUNTER_PROBE) {
        const selfDeviceId = storeGetDeviceId();
        if (!selfDeviceId) {
          logCapped('maxCounterProbeTrace', {
            source: 'enter_conversation',
            conversationIdPrefix8: toConversationIdPrefix8(conversationId),
            senderDeviceIdSuffix4: null,
            ok: false,
            reasonCode: 'MISSING_SENDER_DEVICE_ID'
          }, 5);
        } else {
          void maxCounterProbe({
            conversationId,
            senderDeviceId: selfDeviceId,
            source: 'enter_conversation'
          });
        }
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
      source,
      loadInitialContacts,
      renderContacts,
      syncConversationThreadsFromContacts,
      refreshConversationPreviews,
      renderConversationList,
      onError,
      onFinally
    } = {}) {
      triggerMaxCounterProbeForActiveConversations({
        source: normalizeSourceTag(source, 'pull_to_refresh')
      });
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
      triggerMaxCounterProbeForActiveConversations({
        source: normalizeSourceTag(source, 'visibility_resume')
      });
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
      const allowReplay = mergedOptions.allowReplay === true;
      const isReplay = allowReplay && mergedOptions.mutateState === false;
      const useMessagesFlow = USE_MESSAGES_FLOW_SCROLL_FETCH && isReplay;
      const reasonCode = USE_MESSAGES_FLOW_SCROLL_FETCH
        ? (isReplay ? 'OK' : (allowReplay ? 'MUTATE_STATE_NOT_REPLAY' : 'ALLOW_REPLAY_OFF'))
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
