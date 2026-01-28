// /app/features/messages-flow/gap-queue.js
// Per-conversation gap queue for counter fetches (data-flow only).

import { logCapped } from '../../core/log.js';
import { getSecureMessageByCounter as apiGetSecureMessageByCounter } from './server-api.js';
import {
  GAP_QUEUE_RETRY_MAX,
  GAP_QUEUE_RETRY_INTERVAL_MS
} from './policy.js';
import { getMessagesFlowFlags } from './flags.js';
import { commitBRouteCounter as liveCommitBRouteCounter } from './live/coordinator.js';
import { sessionStore } from '../../ui/mobile/session-store.js';

const GAP_QUEUE_LOG_CAP = 5;
const GAP_QUEUE_LOG_KEYS = new Set([
  'gapQueueEnqueueTrace',
  'gapQueueProcessTrace'
]);

function logGapQueueTrace(logger, key, payload) {
  if (!GAP_QUEUE_LOG_KEYS.has(key)) return;
  logger(key, payload, GAP_QUEUE_LOG_CAP);
}

function slicePrefix(value, len = 8) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(0, len);
}

function normalizeCounter(value, { allowZero = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (!Number.isInteger(num)) return null;
  if (allowZero ? num < 0 : num <= 0) return null;
  return num;
}

function normalizeJob(input = {}) {
  const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : null;
  const targetCounter = normalizeCounter(input?.targetCounter);
  const createdAtMs = Number.isFinite(Number(input?.createdAtMs))
    ? Number(input.createdAtMs)
    : Date.now();
  return {
    conversationId,
    targetCounter,
    createdAtMs
  };
}

function resolveConversationContextFromStore(conversationId) {
  if (!conversationId) {
    return { tokenB64: null, peerAccountDigest: null, peerDeviceId: null };
  }
  const convIndex = sessionStore?.conversationIndex;
  const entry = convIndex && typeof convIndex.get === 'function'
    ? convIndex.get(conversationId)
    : null;
  const threads = sessionStore?.conversationThreads;
  const thread = threads && typeof threads.get === 'function'
    ? threads.get(conversationId)
    : null;
  const tokenB64 = entry?.token_b64
    || entry?.tokenB64
    || thread?.conversationToken
    || thread?.conversation?.token_b64
    || null;
  const peerAccountDigest = entry?.peerAccountDigest || thread?.peerAccountDigest || null;
  const peerDeviceId = entry?.peerDeviceId || thread?.peerDeviceId || null;
  return { tokenB64, peerAccountDigest, peerDeviceId };
}

function createQueueEntry(conversationId) {
  return {
    conversationId,
    jobs: [],
    blocked: false
  };
}

function insertJobSorted(entry, job) {
  const targetCounter = job.targetCounter;
  const list = entry.jobs;
  for (let i = 0; i < list.length; i += 1) {
    const existing = list[i];
    if (existing.targetCounter === targetCounter) {
      return { deduped: true };
    }
    if (existing.targetCounter > targetCounter) {
      list.splice(i, 0, job);
      return { deduped: false };
    }
  }
  list.push(job);
  return { deduped: false };
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readFlagBySuffix(flags, suffix) {
  if (!flags || typeof flags !== 'object') return null;
  const key = Object.keys(flags).find((flagKey) => flagKey.endsWith(suffix));
  return key ? flags[key] : null;
}

export function createGapQueue(deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  const fetchByCounter = typeof deps.getSecureMessageByCounter === 'function'
    ? deps.getSecureMessageByCounter
    : apiGetSecureMessageByCounter;
  const getLocalProcessedCounter = typeof deps.getLocalProcessedCounter === 'function'
    ? deps.getLocalProcessedCounter
    : null;
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : defaultSleep;

  const commitBRouteCounter = typeof deps.commitBRouteCounter === 'function'
    ? deps.commitBRouteCounter
    : liveCommitBRouteCounter;
  const onCommit = typeof deps?.onCommit === 'function'
    ? deps.onCommit
    : (typeof deps?.emitCommit === 'function' ? deps.emitCommit : null);
  const commitDeps = onCommit ? { onCommit } : {};
  const resolveConversationContext = typeof deps.resolveConversationContext === 'function'
    ? deps.resolveConversationContext
    : resolveConversationContextFromStore;
  const flags = getMessagesFlowFlags();
  const commitFlag = readFlagBySuffix(flags, 'B_ROUTE_COMMIT');
  const commitEnabled = commitFlag === true
    && typeof commitBRouteCounter === 'function'
    && typeof resolveConversationContext === 'function';

  const queuedByConversation = new Map();
  const scheduled = new Set();
  const runQueue = [];

  let draining = false;

  const getStats = () => {
    let queuedJobs = 0;
    for (const entry of queuedByConversation.values()) {
      queuedJobs += entry.jobs.length;
    }
    return {
      queuedConversations: queuedByConversation.size,
      queuedJobs,
      scheduledConversations: runQueue.length,
      draining
    };
  };

  const readLocalProcessedCounter = async (conversationId) => {
    if (!getLocalProcessedCounter) return 0;
    try {
      const value = await getLocalProcessedCounter(conversationId);
      const normalized = normalizeCounter(value, { allowZero: true });
      return normalized === null ? 0 : normalized;
    } catch {
      return 0;
    }
  };

  const scheduleConversation = (conversationId) => {
    if (!conversationId) return;
    if (scheduled.has(conversationId)) return;
    scheduled.add(conversationId);
    runQueue.push(conversationId);
  };

  const enqueue = (input = {}) => {
    const job = normalizeJob(input);
    const conversationId = job.conversationId;
    const targetCounter = job.targetCounter;
    const conversationIdPrefix8 = slicePrefix(conversationId);
    if (!conversationId) {
      logGapQueueTrace(logger, 'gapQueueEnqueueTrace', {
        conversationId: null,
        conversationIdPrefix8: null,
        targetCounter: targetCounter ?? null,
        ok: false,
        reasonCode: 'MISSING_CONVERSATION_ID',
        deduped: false,
        queuedConversations: queuedByConversation.size,
        queuedJobs: getStats().queuedJobs
      });
      return { ok: false, reason: 'missing_conversation_id', job };
    }
    if (!Number.isFinite(targetCounter)) {
      logGapQueueTrace(logger, 'gapQueueEnqueueTrace', {
        conversationId,
        conversationIdPrefix8,
        targetCounter: null,
        ok: false,
        reasonCode: 'INVALID_TARGET_COUNTER',
        deduped: false,
        queuedConversations: queuedByConversation.size,
        queuedJobs: getStats().queuedJobs
      });
      return { ok: false, reason: 'invalid_target_counter', job };
    }

    let entry = queuedByConversation.get(conversationId);
    if (!entry) {
      entry = createQueueEntry(conversationId);
      queuedByConversation.set(conversationId, entry);
    }
    entry.blocked = false;

    const { deduped } = insertJobSorted(entry, job);
    const result = { ok: !deduped, reason: deduped ? 'deduped' : null, job };

    logGapQueueTrace(logger, 'gapQueueEnqueueTrace', {
      conversationId,
      conversationIdPrefix8,
      targetCounter,
      ok: result.ok,
      reasonCode: result.reason,
      deduped,
      queuedConversations: queuedByConversation.size,
      queuedJobs: getStats().queuedJobs
    });

    scheduleConversation(conversationId);
    startDrain();

    return result;
  };

  const fetchWithRetry = async (conversationId, counter, conversationIdPrefix8) => {
    let lastError = null;
    for (let attempt = 1; attempt <= GAP_QUEUE_RETRY_MAX; attempt += 1) {
      try {
        const { item } = await fetchByCounter({ conversationId, counter });
        logGapQueueTrace(logger, 'gapQueueProcessTrace', {
          conversationIdPrefix8,
          stage: 'fetch_ok',
          counter,
          attempt,
          ok: true,
          messageIdPrefix8: slicePrefix(item?.id || item?.message_id || item?.messageId || null)
        });
        return { ok: true, item };
      } catch (err) {
        lastError = err?.message || String(err);
        if (attempt < GAP_QUEUE_RETRY_MAX) {
          await sleep(GAP_QUEUE_RETRY_INTERVAL_MS);
        }
      }
    }
    logGapQueueTrace(logger, 'gapQueueProcessTrace', {
      conversationIdPrefix8,
      stage: 'fetch_fail',
      counter,
      attempt: GAP_QUEUE_RETRY_MAX,
      ok: false,
      errorMessage: lastError || null
    });
    return { ok: false, errorMessage: lastError };
  };

  const processConversation = async (entry) => {
    const conversationId = entry.conversationId;
    const conversationIdPrefix8 = slicePrefix(conversationId);
    let localProcessedCounter = await readLocalProcessedCounter(conversationId);
    if (!Number.isFinite(localProcessedCounter)) localProcessedCounter = 0;

    logGapQueueTrace(logger, 'gapQueueProcessTrace', {
      conversationIdPrefix8,
      stage: 'start',
      localProcessedCounter,
      queuedJobs: entry.jobs.length
    });

    let cursor = localProcessedCounter;

    while (entry.jobs.length > 0) {
      const job = entry.jobs[0];
      const targetCounter = job.targetCounter;

      if (targetCounter <= cursor) {
        entry.jobs.shift();
        logGapQueueTrace(logger, 'gapQueueProcessTrace', {
          conversationIdPrefix8,
          stage: 'drop',
          targetCounter,
          localProcessedCounter: cursor
        });
        continue;
      }

      const startCounter = cursor + 1;
      let failed = false;
      for (let counter = startCounter; counter <= targetCounter; counter += 1) {
        const result = await fetchWithRetry(conversationId, counter, conversationIdPrefix8);
        if (!result.ok) {
          failed = true;
          break;
        }
        if (commitEnabled) {
          const context = resolveConversationContext(conversationId) || {};
          const commitResult = await commitBRouteCounter({
            conversationId,
            counter,
            item: result.item || null,
            tokenB64: context?.tokenB64 || null,
            peerAccountDigest: context?.peerAccountDigest || null,
            peerDeviceId: context?.peerDeviceId || null
          }, commitDeps);
          if (!commitResult?.ok) {
            failed = true;
            break;
          }
        }
        cursor = counter;
      }

      if (failed) {
        entry.blocked = true;
        entry.jobs.shift();
        logGapQueueTrace(logger, 'gapQueueProcessTrace', {
          conversationIdPrefix8,
          stage: 'job_failed',
          targetCounter,
          localProcessedCounter
        });
        break;
      }

      entry.jobs.shift();
      logGapQueueTrace(logger, 'gapQueueProcessTrace', {
        conversationIdPrefix8,
        stage: 'job_complete',
        targetCounter,
        localProcessedCounter: cursor
      });
    }
  };

  const drainQueue = async () => {
    while (runQueue.length > 0) {
      const conversationId = runQueue.shift();
      scheduled.delete(conversationId);
      const entry = queuedByConversation.get(conversationId);
      if (!entry) continue;
      if (entry.jobs.length === 0) {
        queuedByConversation.delete(conversationId);
        continue;
      }
      if (entry.blocked) {
        continue;
      }
      await processConversation(entry);
      if (entry.jobs.length === 0) {
        queuedByConversation.delete(conversationId);
      } else if (!entry.blocked) {
        scheduleConversation(conversationId);
      }
    }
  };

  const startDrain = () => {
    if (draining) return;
    draining = true;
    void drainQueue().finally(() => {
      draining = false;
      if (runQueue.length > 0) {
        startDrain();
      }
    });
  };

  return {
    enqueue,
    getStats
  };
}
