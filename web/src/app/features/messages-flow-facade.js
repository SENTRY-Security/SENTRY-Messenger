// /app/features/messages-flow-facade.js
// Facade adapter for message flow entry points.
// Pipeline calls are retired; facade only routes to messages-flow or no-ops.

import { logCapped } from '../core/log.js';
import { getDeviceId as storeGetDeviceId, getAccountDigest as storeGetAccountDigest } from '../core/store.js';
import { maybeSendVaultAckWs, recordVaultAckCounter } from './messages/receipts.js';
import { sessionStore } from '../ui/mobile/session-store.js';
import { startRestorePipeline } from './restore-coordinator.js';
import { createMessagesFlowScrollFetch } from './messages-flow/scroll-fetch.js';
import { smartFetchMessages } from './messages-flow/hybrid-flow.js';
import { createGapQueue } from './messages-flow/gap-queue.js';
import { createMaxCounterProbe } from './messages-flow/probe.js';
import { consumeLiveJob } from './messages-flow/live/coordinator.js';
import { createLiveJobFromWsEvent } from './messages-flow/live/job.js';
import { createLiveLegacyAdapters } from './messages-flow/live/adapters/index.js';
import { decideNextAction } from './messages-flow/reconcile/decision.js';
import { getMessagesFlowFlags } from './messages-flow/flags.js';
import { decryptReplayBatch } from './messages-flow/vault-replay.js';
import { normalizeReplayItems } from './messages-flow/normalize.js';
import { handoffReplayVaultMissing } from './restore-coordinator.js';
import { appendBatch } from './timeline-store.js';
import { b64u8 as naclB64u8 } from '../crypto/nacl.js';
import { MessageKeyVault } from './message-key-vault.js';
import { buildDrAadFromHeader as cryptoBuildDrAadFromHeader } from '../crypto/dr.js';
import { getMkRaw as storeGetMkRaw } from '../core/store.js';
import { getLocalProcessedCounter } from './messages-flow/local-counter.js';
const LIVE_ROUTE_LOG_CAP = 5;
const LIVE_MVP_RESULT_LOG_CAP = 5;
let facadeWsSend = null;
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
const messagesFlowScrollFetch = createMessagesFlowScrollFetch();
const maxCounterProbeQueue = createGapQueue({
  getLocalProcessedCounter: (conversationId) => getLocalProcessedCounter({ conversationId })
});
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

function resolvePeerDeviceIdFromConversationId(conversationId) {
  const convId = normalizeConversationIdValue(conversationId);
  if (!convId) return null;
  const convIndex = sessionStore?.conversationIndex;
  if (convIndex && typeof convIndex.get === 'function') {
    const entry = convIndex.get(convId);
    const deviceId = entry?.peerDeviceId || entry?.peer_device_id || null;
    if (deviceId) return deviceId;
  }
  const threads = sessionStore?.conversationThreads;
  if (threads && typeof threads.get === 'function') {
    const entry = threads.get(convId);
    const deviceId = entry?.peerDeviceId || entry?.peer_device_id || null;
    if (deviceId) return deviceId;
  }
  return null;
}

function triggerMaxCounterProbeForActiveConversations({ source } = {}) {
  const flags = getMessagesFlowFlags();
  if (!flags.USE_MESSAGES_FLOW_MAX_COUNTER_PROBE) return;
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

function createMessagesFlowFacade() {
  return {
    // Event -> facade-only handler. Do not add new flow logic here.
    onLoginResume({
      source,
      runRestore = true,
      runOfflineCatchup = true,
      runOfflineDecrypt = true,
      runServerCatchup = true
    } = {}) {
      void runRestore;
      void runOfflineCatchup;
      void runOfflineDecrypt;
      void runServerCatchup;
      const restorePromise = startRestorePipeline({ source });
      if (restorePromise && typeof restorePromise.catch === 'function') {
        restorePromise.catch(() => { });
      }
      return restorePromise || null;
    },

    // Event -> facade-only handler. Do not add new flow logic here.
    onWsIncomingMessageNew(payloadOrEvent = {}, ctx = null) {
      const flags = getMessagesFlowFlags();
      const hasExplicitCtx = !!(ctx && typeof ctx === 'object');
      const isPayloadObject = !hasExplicitCtx && payloadOrEvent && typeof payloadOrEvent === 'object' && (
        Object.prototype.hasOwnProperty.call(payloadOrEvent, 'event')
        || Object.prototype.hasOwnProperty.call(payloadOrEvent, 'msg')
        || typeof payloadOrEvent.handleIncomingSecureMessage === 'function'
      );
      const event = isPayloadObject
        ? (payloadOrEvent?.event || payloadOrEvent?.msg || payloadOrEvent)
        : (payloadOrEvent || null);
      const triggerSource = (isPayloadObject
        ? (payloadOrEvent?.triggerSource || payloadOrEvent?.source)
        : ctx?.triggerSource) || 'ws_incoming';

      // Handler for Vault Ack (Double Tick)
      if (event?.type === 'vault-ack') {
        try {
          console.log('[facade] recv vault-ack', { conv: event.conversationId, mid: event.messageId, ctr: event.counter, ts: event.ts });
        } catch { }
        // Pass messageId to trigger server count fetch
        recordVaultAckCounter(event.conversationId, event.counter, event.ts, event.messageId);
        // We can return early as this is a control signal, not a content message
        // [FIX] Legacy Handler for Vault Ack?
        // Usually vault-ack is handled by messagesPane separate listener... 
        // messagesPane.handleVaultAckEvent is called by app-mobile directly.
        // So we don't need to call handleIncomingSecureMessage here.
        return;
      }

      // [FIX] Legacy Handler Restoration
      // The Facade was swallowing the legacy `handleIncomingSecureMessage` call.
      // This prevented the UI Controller (MessageFlowController) from:
      // 1. Showing Placeholders (addPendingLivePlaceholder)
      // 2. Handling Control Messages (Receipts)
      // 3. Triggering Auto-Sync (loadActiveConversationMessages)
      // 4. Executing the "Tail Loop" logic
      // We must call it here to ensure the UI stays in sync, even if B-Route (Live MVP) runs in parallel.
      const legacyHandler = isPayloadObject ? payloadOrEvent.handleIncomingSecureMessage : null;
      if (typeof legacyHandler === 'function') {
        // We run this "Fire and Forget" or await? 
        // app-mobile didn't await it. We shouldn't block B-Route decision on it.
        // But we should catch errors.
        try {
          console.log('[facade] Calling legacy legacyHandler', { mid: event?.messageId || event?.id });
          const res = legacyHandler(event);
          console.log('[facade] legacyHandler result:', res);
        } catch (e) {
          console.error('[facade] legacy handler failed', e);
        }
      }

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
      const liveJobCounter = Number.isFinite(Number(liveJob?.counter)) ? Number(liveJob?.counter) : null;
      const liveJobConversationId = liveJob?.conversationId || resolveWsConversationId(event, hasExplicitCtx ? ctx : null);

      const isOnline = typeof ctx?.isOnline === 'boolean'
        ? ctx.isOnline
        : (typeof payloadOrEvent?.isOnline === 'boolean' ? payloadOrEvent.isOnline : true);

      return (async () => {
        let isGap = false;
        if (liveJobCounter !== null && liveJobConversationId) {
          try {
            const localMax = await getLocalProcessedCounter({ conversationId: liveJobConversationId });
            // Strict Sequential: If incoming > local + 1, it's a gap (unless localMax is 0 and incoming is 1?)
            // Actually, if localMax is 0, we expect 1. If we receive 3, gap size is 2.
            if (liveJobCounter > localMax + 1) {
              isGap = true;
              console.warn('[messages-flow] Gap Detected:', { conversationId: liveJobConversationId, incoming: liveJobCounter, localMax });
            }
          } catch (e) {
            console.warn('[messages-flow] Local counter check failed', e);
          }
        }

        const decisionContext = {
          eventType: 'ws_incoming',
          flags: {
            liveEnabled: flags.USE_MESSAGES_FLOW_LIVE,
            hasLiveJob: !!liveJob,
            isOnline,
            isGap
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
          flagState: flags.USE_MESSAGES_FLOW_LIVE
        }, LIVE_ROUTE_LOG_CAP);

        logCapped('decisionTrace', {
          eventType: decisionContext.eventType,
          action: decisionResult?.action || null,
          reason: decisionResult?.reason || null,
          ...liveJobSummary,
          jobReason: liveJobReason || null
        }, DECISION_TRACE_LOG_CAP);

        const shouldTriggerLive = decisionResult?.action === 'TRIGGER_LIVE_MVP';
        const missingMessageId = liveJobReason === 'MISSING_MESSAGE_ID';
        const isGapDetected = decisionResult?.reason === 'GAP_DETECTED';

        if (isGapDetected) {
          logCapped('liveMvpResultTrace', {
            planned: false,
            ...liveJobSummary,
            ok: null,
            reasonCode: 'GAP_DETECTED',
            tookMs: 0,
            metrics: summarizeLiveMvpMetrics(null)
          }, LIVE_MVP_RESULT_LOG_CAP);

          // Trigger GAP Fetch (Max Counter Probe)
          const peerDeviceId = liveJob?.peerDeviceId
            || liveJobCtx?.peerDeviceId
            || resolvePeerDeviceIdFromConversationId(summaryConversationId);

          if (peerDeviceId) {
            void maxCounterProbe({
              conversationId: summaryConversationId,
              senderDeviceId: peerDeviceId,
              source: 'gap_detected_ws'
            });
          }
          return { ok: false, reasonCode: 'GAP_DETECTED' };
        }

        if (!shouldTriggerLive) {
          if (flags.USE_MESSAGES_FLOW_LIVE) {
            logCapped('liveMvpResultTrace', {
              planned: false,
              ...liveJobSummary,
              ok: null,
              reasonCode: decisionResult?.reason || liveJobReason || null,
              tookMs: 0,
              metrics: summarizeLiveMvpMetrics(null)
            }, LIVE_MVP_RESULT_LOG_CAP);
          }
          if (missingMessageId) {
            const sourceTag = 'ws_missing_message_id';
            const peerDeviceId = (hasExplicitCtx ? ctx?.peerDeviceId : null)
              || liveJobCtx?.peerDeviceId
              || liveJob?.peerDeviceId
              || resolvePeerDeviceIdFromConversationId(summaryConversationId);
            if (!peerDeviceId) {
              logCapped('maxCounterProbeTrace', {
                source: sourceTag,
                conversationIdPrefix8: toConversationIdPrefix8(summaryConversationId),
                senderDeviceIdSuffix4: null,
                ok: false,
                reasonCode: 'MISSING_PEER_DEVICE_ID'
              }, 5);
              return { ok: false, reasonCode: 'MISSING_MESSAGE_ID_PEER_DEVICE_MISSING' };
            }
            void maxCounterProbe({
              conversationId: summaryConversationId,
              senderDeviceId: peerDeviceId,
              source: sourceTag
            });
            return { ok: false, reasonCode: 'MISSING_MESSAGE_ID_ENQUEUE_REQUESTED' };
          }
          return { ok: false, reasonCode: decisionResult?.reason || liveJobReason || 'NO_OP' };
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
          return { ok: false, reasonCode: liveJobReason || 'MISSING_PARAMS' };
        }

        try {
          const liveMvpResultMeta = { ...liveJobSummary };
          const liveCtx = {
            adapters: liveLegacyAdapters,
            maybeSendVaultAckWs: (params) => {
              return maybeSendVaultAckWs(params, { wsSend: facadeWsSend });
            },
            getAccountDigest: storeGetAccountDigest,
            getDeviceId: storeGetDeviceId
          };
          try {
            console.log('[facade] consumeLiveJob deps', {
              hasAck: typeof maybeSendVaultAckWs === 'function',
              hasGetAccount: typeof storeGetAccountDigest === 'function',
              hasGetDevice: typeof storeGetDeviceId === 'function'
            });
          } catch { }

          const livePromise = consumeLiveJob(liveJob, liveCtx);
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
          return livePromise || { ok: false, reasonCode: 'LIVE_JOB_NOT_STARTED' };
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
          return { ok: false, reasonCode: err?.reasonCode || 'LIVE_JOB_FAILED' };
        }
      })();
    },

    // Event -> facade-only handler. Do not add new flow logic here.
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
      void runCatchup;
      void peerAccountDigest;
      void peerDeviceId;
      void replay;
      void reason;
      void loadOptions;
      const flags = getMessagesFlowFlags();
      if (flags.USE_MESSAGES_FLOW_MAX_COUNTER_PROBE) {
        const selfDeviceId = storeGetDeviceId();
        if (!selfDeviceId) {
          logCapped('maxCounterProbeTrace', {
            source: 'enter_conversation',
            conversationIdPrefix8: toConversationIdPrefix8(conversationId),
            senderDeviceIdSuffix4: null,
            ok: false,
            reasonCode: 'MISSING_SENDER_DEVICE_ID'
          }, 5);
        } else if (conversationId) {
          void maxCounterProbe({
            conversationId,
            senderDeviceId: selfDeviceId,
            source: 'enter_conversation'
          });
        }
      }
      if (typeof loadActiveConversationMessages === 'function') {
        const mergedLoadOptions = { ...(loadOptions || {}) };
        if (replay !== undefined) mergedLoadOptions.replay = replay;
        if (reason !== undefined) mergedLoadOptions.reason = reason;
        loadActiveConversationMessages(mergedLoadOptions);
      }
      return { ok: true, reasonCode: flags.USE_MESSAGES_FLOW_MAX_COUNTER_PROBE ? null : 'SKIPPED_FLAG_OFF' };
    },

    // Event -> facade-only handler. Do not add new flow logic here.
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
        try {
          const contacts = typeof loadInitialContacts === 'function'
            ? await loadInitialContacts()
            : null;
          if (typeof renderContacts === 'function') {
            await renderContacts(contacts);
          }
          if (typeof syncConversationThreadsFromContacts === 'function') {
            await syncConversationThreadsFromContacts(contacts);
          }
          if (typeof refreshConversationPreviews === 'function') {
            await refreshConversationPreviews();
          }
          if (typeof renderConversationList === 'function') {
            await renderConversationList();
          }
          return { ok: true };
        } catch (err) {
          if (typeof onError === 'function') {
            onError(err);
          }
          return { ok: false, errorMessage: err?.message || String(err) };
        } finally {
          if (typeof onFinally === 'function') {
            onFinally();
          }
        }
      })();
    },

    // Event -> facade-only handler. Do not add new flow logic here.
    onVisibilityResume({
      source,
      reconcileOutgoingStatus,
      onOfflineDecryptError
    } = {}) {
      void reconcileOutgoingStatus;
      void onOfflineDecryptError;
      const restorePromise = startRestorePipeline({
        source: normalizeSourceTag(source, 'visibility_resume')
      });
      if (restorePromise && typeof restorePromise.catch === 'function') {
        restorePromise.catch(() => { });
      }
      triggerMaxCounterProbeForActiveConversations({
        source: normalizeSourceTag(source, 'visibility_resume')
      });
      return { ok: true, reasonCode: null };
    },

    // Event -> facade-only handler. Do not add new flow logic here.
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
      void tokenB64;
      void peerAccountDigest;
      void peerDeviceId;
      const mergedOptions = { ...(options || {}) };
      if (cursor && (mergedOptions.cursorTs === undefined && mergedOptions.cursorId === undefined)) {
        if (typeof cursor === 'object' && cursor !== null) {
          mergedOptions.cursorTs = cursor.ts ?? cursor.cursorTs ?? null;
          mergedOptions.cursorId = cursor.id ?? cursor.cursorId ?? null;
        } else {
          mergedOptions.cursorTs = cursor;
        }
      }
      const flags = getMessagesFlowFlags();
      const limit = Number.isFinite(Number(mergedOptions.limit)) ? Number(mergedOptions.limit) : null;
      const hasCursor = mergedOptions.cursorTs !== undefined || mergedOptions.cursorId !== undefined;
      const allowReplay = mergedOptions.allowReplay === true;
      const isReplay = allowReplay && mergedOptions.mutateState === false;
      const reasonCode = flags.USE_MESSAGES_FLOW_SCROLL_FETCH
        ? (isReplay ? 'OK' : (allowReplay ? 'MUTATE_STATE_NOT_REPLAY' : 'ALLOW_REPLAY_OFF'))
        : 'FORCED_MESSAGES_FLOW';
      logCapped('scrollFetchRouteTrace', {
        conversationIdPrefix8: toConversationIdPrefix8(conversationId),
        route: 'messages-flow',
        reasonCode,
        hasCursor,
        limit
      }, 5);
      const normalizedCursor = mergedOptions.cursorTs !== undefined || mergedOptions.cursorId !== undefined
        ? { ts: mergedOptions.cursorTs ?? null, id: mergedOptions.cursorId ?? null }
        : null;
      return smartFetchMessages({
        conversationId,
        cursor: normalizedCursor,
        limit: mergedOptions.limit
      }, {
        maybeSendVaultAckWs: (params) => {
          return maybeSendVaultAckWs(params, { wsSend: facadeWsSend });
        },
        getAccountDigest: storeGetAccountDigest,
        getDeviceId: storeGetDeviceId
      }).then((result) => ({
        items: Array.isArray(result?.items) ? result.items : [],
        errors: Array.isArray(result?.errors) ? result.errors : [],
        nextCursor: result?.nextCursor ?? null,
        nextCursorTs: result?.nextCursor?.ts ?? null,
        hasMoreAtCursor: !!result?.nextCursor
      }));
    },

    // Event -> facade-only handler. Do not add new flow logic here.
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
    },

    // Facade method for Placeholder First strategy
    async triggerBatchDecryption({ conversationId, messages = [] } = {}) {
      if (!messages.length) return { ok: true, count: 0 };

      try {
        const selfDeviceId = storeGetDeviceId();
        const selfDigest = storeGetAccountDigest();
        const mkRaw = typeof storeGetMkRaw === 'function' ? storeGetMkRaw() : null;

        if (!selfDeviceId || !mkRaw) {
          console.error('[facade] triggerBatchDecryption missing keys');
          return { ok: false, reason: 'MISSING_KEYS' };
        }

        // Execute Route A Decryption
        const { items: decryptedItems, errors } = await decryptReplayBatch({
          conversationId,
          items: messages,
          selfDeviceId,
          selfDigest,
          mk: mkRaw,
          getMessageKey: MessageKeyVault.getMessageKey,
          buildDrAadFromHeader: cryptoBuildDrAadFromHeader,
          b64u8: naclB64u8
        });

        // Normalize results
        const normalized = normalizeReplayItems({
          items: decryptedItems,
          errors
        });

        // Commit successes to Store (Replaces Placeholders)
        if (normalized.items.length > 0) {
          appendBatch(normalized.items);
        }

        // Handle Failures (Route A -> Route B Fallback)
        const missingHandoff = (() => {
          // Inline logic similar to scroll-fetch generic handler
          const list = Array.isArray(normalized.errors) ? normalized.errors : [];
          let maxCounter = null;
          let reasonCode = null;
          for (const entry of list) {
            const entryReason = entry?.reasonCode || entry?.reason || null;
            if (entryReason !== 'vault_missing' && entryReason !== 'MISSING_MESSAGE_KEY' && entryReason !== 'DECRYPT_FAIL') continue;
            const counter = Number(entry?.counter);
            if (Number.isFinite(counter)) {
              maxCounter = maxCounter === null ? counter : Math.max(maxCounter, counter);
            }
            if (!reasonCode) reasonCode = entryReason;
          }
          return { hasMissing: reasonCode !== null, maxCounter, reasonCode };
        })();

        if (missingHandoff.hasMissing) {
          console.log('[facade] triggerBatchDecryption handoff', missingHandoff);
          // Route B fallback
          // We use handoffReplayVaultMissing for vault_missing/missing_keys
          // We use handoffReplayDecryptionFailure for general failures
          // Currently reusing vault missing handoff as it drives the gap queue.
          handoffReplayVaultMissing({
            conversationId,
            maxCounter: missingHandoff.maxCounter,
            reasonCode: missingHandoff.reasonCode || 'batch_decrypt_fail',
            source: 'trigger_batch_decryption'
          });
        }

        return { ok: true, count: normalized.items.length, errors: normalized.errors.length };

      } catch (err) {
        console.error('[facade] triggerBatchDecryption fatal', err);
        return { ok: false, error: err };
      }
    }
  };
}

export const messagesFlowFacade = createMessagesFlowFacade();

export function setMessagesFlowFacadeWsSend(fn) {
  facadeWsSend = typeof fn === 'function' ? fn : null;
}
