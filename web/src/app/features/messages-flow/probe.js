// /app/features/messages-flow/probe.js
// Event-driven max-counter probe (data-flow only).

import { logCapped } from '../../core/log.js';
import { fetchSecureMaxCounter as apiFetchSecureMaxCounter, getSecureMessageByCounter } from './server-api.js';
import { MessageKeyVault } from '../message-key-vault.js';
import { sessionStore } from '../../ui/mobile/session-store.js';
import { getLocalProcessedCounter } from './local-counter.js';

const MAX_COUNTER_PROBE_LOG_CAP = 5;

function slicePrefix(value, len = 8) {
  if (!value) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(0, len);
}

function sliceSuffix(value, len = 4) {
  if (!value) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(-len);
}

function normalizeCounter(value, { allowZero = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (!Number.isInteger(num)) return null;
  if (num < 0) return null;
  if (num === 0) return allowZero ? 0 : null;
  return num;
}

export function createMaxCounterProbe(deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  const fetchMaxCounter = typeof deps.fetchSecureMaxCounter === 'function'
    ? deps.fetchSecureMaxCounter
    : apiFetchSecureMaxCounter;
  const gapQueue = deps.gapQueue || null;
  const enqueueGapTask = typeof deps.enqueueGapTask === 'function'
    ? deps.enqueueGapTask
    : (gapQueue && typeof gapQueue.enqueue === 'function' ? gapQueue.enqueue : null);
  const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs : Date.now;

  return async function probeMaxCounter({ conversationId, senderDeviceId, source, lazy = false } = {}) {
    const convId = typeof conversationId === 'string' ? conversationId : null;
    const deviceId = typeof senderDeviceId === 'string' ? senderDeviceId : null;
    const sourceTag = typeof source === 'string' ? source : null;
    const conversationIdPrefix8 = slicePrefix(convId);
    const senderDeviceIdSuffix4 = sliceSuffix(deviceId);

    if (!convId) {
      logger('maxCounterProbeTrace', {
        source: sourceTag,
        conversationIdPrefix8: null,
        senderDeviceIdSuffix4,
        ok: false,
        reasonCode: 'MISSING_CONVERSATION_ID'
      }, MAX_COUNTER_PROBE_LOG_CAP);
      return { ok: false, reason: 'missing_conversation_id' };
    }
    if (!deviceId) {
      logger('maxCounterProbeTrace', {
        source: sourceTag,
        conversationIdPrefix8,
        senderDeviceIdSuffix4: null,
        ok: false,
        reasonCode: 'MISSING_SENDER_DEVICE_ID'
      }, MAX_COUNTER_PROBE_LOG_CAP);
      return { ok: false, reason: 'missing_sender_device_id' };
    }
    if (typeof fetchMaxCounter !== 'function') {
      logger('maxCounterProbeTrace', {
        source: sourceTag,
        conversationIdPrefix8,
        senderDeviceIdSuffix4,
        ok: false,
        reasonCode: 'FETCH_MISSING'
      }, MAX_COUNTER_PROBE_LOG_CAP);
      return { ok: false, reason: 'fetch_missing' };
    }

    let serverMaxCounter = null;
    try {
      const result = await fetchMaxCounter({ conversationId: convId, senderDeviceId: deviceId });
      serverMaxCounter = result?.maxCounter ?? null;
    } catch (err) {
      const errorMessage = err?.message || String(err);
      logger('maxCounterProbeTrace', {
        source: sourceTag,
        conversationIdPrefix8,
        senderDeviceIdSuffix4,
        ok: false,
        reasonCode: 'FETCH_FAILED',
        errorMessage
      }, MAX_COUNTER_PROBE_LOG_CAP);
      return { ok: false, reason: 'fetch_failed', errorMessage };
    }

    const targetCounter = normalizeCounter(serverMaxCounter, { allowZero: true });
    if (!Number.isFinite(targetCounter)) {
      logger('maxCounterProbeTrace', {
        source: sourceTag,
        conversationIdPrefix8,
        senderDeviceIdSuffix4,
        ok: false,
        reasonCode: 'INVALID_MAX_COUNTER',
        serverMaxCounter: serverMaxCounter ?? null
      }, MAX_COUNTER_PROBE_LOG_CAP);
      return { ok: false, reason: 'invalid_max_counter', serverMaxCounter };
    }

    if (targetCounter === 0) {
      logger('maxCounterProbeTrace', {
        source: sourceTag,
        conversationIdPrefix8,
        senderDeviceIdSuffix4,
        ok: true,
        reasonCode: 'NO_MESSAGES_YET',
        serverMaxCounter: 0
      }, MAX_COUNTER_PROBE_LOG_CAP);
      return { ok: true, serverMaxCounter: 0, enqueueResult: null, reason: 'no_messages_yet' };
    }

    // [LAZY-DECRYPT] Check Logic
    if (lazy) {
      let hasKey = false;
      try {
        const latestMsg = await getSecureMessageByCounter({
          conversationId: convId,
          counter: targetCounter
        });
        if (latestMsg) {
          const mid = latestMsg.id || latestMsg.messageId || latestMsg.message_id || null;
          const sender = latestMsg.sender || latestMsg.senderDeviceId || null;
          let sDevId = null;
          if (sender && sender.includes('::')) sDevId = sender.split('::')[1];
          else if (latestMsg.sender_device_id) sDevId = latestMsg.sender_device_id;

          if (mid && sDevId) {
            const vaultRes = await MessageKeyVault.getMessageKey({
              conversationId: convId,
              messageId: mid,
              senderDeviceId: sDevId
            });
            if (vaultRes.ok) hasKey = true;
          }
        }
      } catch (e) {
        hasKey = true; // Fallback to eager on error
      }

      if (!hasKey) {
        // Calculate Gap and Update Session
        const localMax = await getLocalProcessedCounter({ conversationId: convId });
        const gapSize = targetCounter - (localMax || 0);
        if (gapSize > 0) {
          const threads = sessionStore.conversationThreads;
          const thread = threads?.get?.(convId);
          if (thread) {
            thread.offlineUnreadCount = gapSize;
            threads.set(convId, { ...thread });
          }
        }
        logger('maxCounterProbeTrace', {
          source: sourceTag,
          conversationIdPrefix8,
          senderDeviceIdSuffix4,
          ok: true,
          reasonCode: 'LAZY_OFFLINE_DEFERRED',
          serverMaxCounter: targetCounter,
          gapSize
        }, MAX_COUNTER_PROBE_LOG_CAP);
        return { ok: true, serverMaxCounter: targetCounter, skippedLazy: true };
      }
    }

    logger('maxCounterProbeTrace', {
      source: sourceTag,
      conversationIdPrefix8,
      senderDeviceIdSuffix4,
      ok: true,
      serverMaxCounter: targetCounter
    }, MAX_COUNTER_PROBE_LOG_CAP);

    if (typeof enqueueGapTask !== 'function') {
      logger('maxCounterProbeEnqueueTrace', {
        source: sourceTag,
        conversationIdPrefix8,
        senderDeviceIdSuffix4,
        targetCounter,
        ok: false,
        reasonCode: 'QUEUE_UNAVAILABLE'
      }, MAX_COUNTER_PROBE_LOG_CAP);
      return { ok: false, reason: 'queue_unavailable', serverMaxCounter: targetCounter };
    }

    const enqueueResult = enqueueGapTask({
      conversationId: convId,
      targetCounter,
      createdAtMs: nowMs()
    });
    logger('maxCounterProbeEnqueueTrace', {
      source: sourceTag,
      conversationIdPrefix8,
      senderDeviceIdSuffix4,
      targetCounter,
      ok: enqueueResult?.ok === true,
      reasonCode: enqueueResult?.reason || null
    }, MAX_COUNTER_PROBE_LOG_CAP);

    return { ok: true, serverMaxCounter: targetCounter, enqueueResult };
  };
}
