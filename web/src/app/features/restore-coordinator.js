import { getAccountToken, getMkRaw, ensureDeviceId } from '../core/store.js';
import { restoreContactSecrets } from '../core/contact-secrets.js';
import { logCapped } from '../core/log.js';
import { RESTORE_PIPELINE_LOG_CAP } from './restore-policy.js';
import { fetchSecureMaxCounter } from './messages-flow/server-api.js';
import { hydrateContactSecretsFromBackup } from './contact-backup.js';
import { createGapQueue } from './messages-flow/gap-queue.js';
import { getLocalProcessedCounter } from './messages-flow/local-counter.js';
import { sessionStore } from '../ui/mobile/session-store.js';
import { hydrateDrStatesFromContactSecrets } from './dr-session.js';
import { flushPendingContactShares } from './contacts.js';

const STAGES = ['Stage0', 'Stage1', 'Stage2', 'Stage3', 'Stage4', 'Stage5'];
const restoreGapQueue = createGapQueue({
  getLocalProcessedCounter: (conversationId) => getLocalProcessedCounter({ conversationId })
});
import { getSecureMessageByCounter } from './messages-flow/server-api.js';
import { MessageKeyVault } from './message-key-vault.js';

const initialState = () => ({
  stage: null,
  stageIndex: -1,
  inFlight: false,
  startedAt: null,
  updatedAt: null,
  stages: {},
  trace: [],
  replayHandoff: []
});

const state = initialState();

function nowMs() {
  return Date.now();
}

function clampTrace(list, max) {
  const cap = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 5;
  if (!Array.isArray(list)) return [];
  if (list.length <= cap) return list;
  return list.slice(list.length - cap);
}

function normalizeCounter(value, { allowZero = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (!Number.isInteger(num)) return null;
  if (allowZero ? num < 0 : num <= 0) return null;
  return num;
}

function emitStageEvent(stage, ok, reasonCode, progress) {
  if (typeof document === 'undefined' || !document?.dispatchEvent) return;
  try {
    document.dispatchEvent(new CustomEvent('restore:pipeline', {
      detail: {
        stage,
        ok: !!ok,
        reasonCode: reasonCode || null,
        progress: progress || null
      }
    }));
  } catch { }
}

function logStageTrace(stage, ok, reasonCode, progress) {
  const payload = {
    stage,
    ok: !!ok,
    reasonCode: reasonCode || null,
    tsMs: nowMs()
  };
  if (progress && typeof progress === 'object') {
    payload.progress = progress;
  }
  logCapped('restorePipelineStageTrace', payload, RESTORE_PIPELINE_LOG_CAP);
  emitStageEvent(stage, ok, reasonCode, progress);
  return payload;
}

function recordStageResult(stage, { ok, reasonCode, progress } = {}) {
  const entry = {
    stage,
    ok: !!ok,
    reasonCode: reasonCode || null,
    tsMs: nowMs(),
    progress: progress || null
  };
  state.stages[stage] = entry;
  state.trace = clampTrace([...(state.trace || []), entry], RESTORE_PIPELINE_LOG_CAP);
  logStageTrace(stage, ok, reasonCode, progress);
}

function recordReplayHandoff({ conversationId, counter, maxCounter, reasonCode, source } = {}) {
  const entry = {
    conversationId: normalizeConversationId(conversationId),
    counter: normalizeCounter(counter),
    maxCounter: normalizeCounter(maxCounter),
    reasonCode: reasonCode || null,
    source: typeof source === 'string' ? source : null,
    tsMs: nowMs()
  };
  state.replayHandoff = clampTrace([...(state.replayHandoff || []), entry], RESTORE_PIPELINE_LOG_CAP);
  state.updatedAt = nowMs();
  return entry;
}

function setStage(stage) {
  state.stage = stage;
  state.stageIndex = STAGES.indexOf(stage);
  state.updatedAt = nowMs();
}

function buildSummary() {
  const summary = {
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    stage: state.stage,
    stageIndex: state.stageIndex,
    inFlight: state.inFlight,
    stages: {},
    trace: Array.isArray(state.trace) ? state.trace.slice() : [],
    replayHandoff: Array.isArray(state.replayHandoff) ? state.replayHandoff.slice() : []
  };
  for (const stage of STAGES) {
    summary.stages[stage] = state.stages[stage] || null;
  }
  return summary;
}

function logPipelineDone() {
  logCapped('restorePipelineDoneTrace', {
    stage: 'Stage5',
    ok: true,
    reasonCode: null,
    tsMs: nowMs()
  }, RESTORE_PIPELINE_LOG_CAP);
  emitStageEvent('Stage5', true, null, null);
}

function normalizeConversationId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function collectConversationIds() {
  const ids = new Set();
  const addId = (value) => {
    const normalized = normalizeConversationId(value);
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

export function getRestorePipelineState() {
  try {
    return JSON.parse(JSON.stringify(buildSummary()));
  } catch {
    return buildSummary();
  }
}

export function resetRestorePipelineState() {
  const reset = initialState();
  Object.keys(state).forEach((key) => {
    state[key] = reset[key];
  });
}

export function handoffReplayVaultMissing({
  conversationId,
  counter,
  maxCounter,
  reasonCode,
  source
} = {}) {
  const normalizedConversationId = normalizeConversationId(conversationId);
  const normalizedCounter = normalizeCounter(counter);
  const normalizedMaxCounter = normalizeCounter(maxCounter);
  const entry = recordReplayHandoff({
    conversationId: normalizedConversationId,
    counter: normalizedCounter,
    maxCounter: normalizedMaxCounter,
    reasonCode: reasonCode || 'vault_missing',
    source
  });
  const targetCounter = normalizedCounter ?? normalizedMaxCounter ?? null;
  if (!normalizedConversationId) {
    return { ok: false, reasonCode: 'MISSING_CONVERSATION_ID', handoff: entry };
  }
  if (!Number.isFinite(targetCounter)) {
    return { ok: false, reasonCode: 'INVALID_TARGET_COUNTER', handoff: entry };
  }
  const enqueueResult = restoreGapQueue.enqueue({
    conversationId: normalizedConversationId,
    targetCounter,
    createdAtMs: entry.tsMs
  });
  return {
    ok: enqueueResult?.ok === true,
    reasonCode: enqueueResult?.reason || null,
    targetCounter,
    handoff: entry
  };
}

export async function startRestorePipeline({ source } = {}) {
  void source;
  if (state.inFlight) {
    return { ok: false, stage: state.stage || 'Stage0', reasonCode: 'IN_FLIGHT' };
  }
  resetRestorePipelineState();
  state.inFlight = true;
  state.startedAt = nowMs();
  state.updatedAt = state.startedAt;

  let selfDeviceId = null;

  try {
    setStage('Stage0');
    const mk = getMkRaw();
    const token = getAccountToken();
    selfDeviceId = ensureDeviceId() || null;
    const hasMk = !!mk;
    const hasToken = !!token;
    const hasDeviceId = !!selfDeviceId;
    const ok = hasMk && hasToken && hasDeviceId;
    recordStageResult('Stage0', {
      ok,
      reasonCode: ok ? null : 'MISSING_CREDENTIALS',
      progress: {
        hasMk,
        hasAccountToken: hasToken,
        hasDeviceId
      }
    });
    if (!ok) {
      state.inFlight = false;
      return { ok: false, stage: 'Stage0', reasonCode: 'MISSING_CREDENTIALS' };
    }
  } catch (err) {
    recordStageResult('Stage0', {
      ok: false,
      reasonCode: 'CREDENTIALS_ERROR'
    });
    state.inFlight = false;
    return { ok: false, stage: 'Stage0', reasonCode: 'CREDENTIALS_ERROR' };
  }

  try {
    setStage('Stage1');
    const map = restoreContactSecrets();
    const entries = map instanceof Map ? map.size : 0;
    recordStageResult('Stage1', {
      ok: true,
      progress: { restoredEntries: entries }
    });
  } catch (err) {
    recordStageResult('Stage1', {
      ok: false,
      reasonCode: 'LOCAL_RESTORE_FAILED'
    });
    state.inFlight = false;
    return { ok: false, stage: 'Stage1', reasonCode: 'LOCAL_RESTORE_FAILED' };
  }

  setStage('Stage2');
  try {
    const mk = getMkRaw();
    const token = getAccountToken();
    const hasMk = !!mk;
    const hasToken = !!token;
    const hasDeviceId = !!selfDeviceId;
    if (!hasMk || !hasToken || !hasDeviceId) {
      recordStageResult('Stage2', {
        ok: true,
        reasonCode: !hasMk
          ? 'SKIPPED_MISSING_MK'
          : (!hasToken ? 'SKIPPED_MISSING_TOKEN' : 'SKIPPED_MISSING_DEVICE_ID'),
        progress: {
          hasMk,
          hasAccountToken: hasToken,
          hasDeviceId
        }
      });
    } else {
      const result = await hydrateContactSecretsFromBackup({ reason: 'restore-pipeline-stage2' });
      const status = result?.status ?? null;
      const entries = Number.isFinite(result?.entries) ? result.entries : 0;
      const corruptCount = Number.isFinite(result?.corruptCount) ? result.corruptCount : null;
      if (result?.ok) {
        recordStageResult('Stage2', {
          ok: true,
          reasonCode: null,
          progress: {
            entriesRestored: entries,
            source: 'remote_backup',
            status,
            corruptCount
          }
        });
      } else if (result?.noData || status === 404) {
        recordStageResult('Stage2', {
          ok: true,
          reasonCode: 'SKIPPED_NO_BACKUP',
          progress: {
            entriesRestored: entries,
            source: 'remote_backup',
            status,
            corruptCount,
            noData: true
          }
        });
      } else {
        recordStageResult('Stage2', {
          ok: false,
          reasonCode: 'REMOTE_HYDRATE_FAILED',
          progress: {
            entriesRestored: entries,
            source: 'remote_backup',
            status,
            corruptCount
          }
        });
      }
    }
  } catch (err) {
    recordStageResult('Stage2', {
      ok: false,
      reasonCode: 'REMOTE_HYDRATE_FAILED',
      progress: { source: 'remote_backup' }
    });
  }

  setStage('Stage3');
  try {
    const map = restoreContactSecrets();
    const entries = map instanceof Map ? map.size : 0;
    if (!entries) {
      recordStageResult('Stage3', {
        ok: true,
        reasonCode: 'SKIPPED_NO_CONTACT_SECRETS',
        progress: {
          restoredCount: 0,
          skippedCount: 0,
          errorCount: 0,
          source: 'contact_secrets',
          entries
        }
      });
    } else {
      const summary = hydrateDrStatesFromContactSecrets({ source: 'restore_pipeline_stage3' }) || {};
      const restoredCount = Number(summary.restoredCount || 0);
      const skippedCount = Number(summary.skippedCount || 0);
      const errorCount = Number(summary.errorCount || 0);
      const ok = errorCount === 0;
      recordStageResult('Stage3', {
        ok,
        reasonCode: ok ? null : 'DR_HYDRATE_FAILED',
        progress: {
          restoredCount,
          skippedCount,
          errorCount,
          source: 'contact_secrets',
          entries
        }
      });
    }
  } catch (err) {
    recordStageResult('Stage3', {
      ok: false,
      reasonCode: 'DR_HYDRATE_FAILED',
      progress: { source: 'contact_secrets' }
    });
  }

  try {
    await flushPendingContactShares({ mk: getMkRaw() });
  } catch { }

  try {
    setStage('Stage4');
    const conversationIds = collectConversationIds();
    if (!conversationIds.length) {
      recordStageResult('Stage4', {
        ok: true,
        reasonCode: 'SKIPPED_NO_CONVERSATIONS',
        progress: {
          scannedConversations: 0,
          sampledConversations: null,
          enqueuedConversations: 0,
          enqueuedJobs: 0,
          scheduledConversations: null,
          draining: null,
          localProcessedCounterMin: null,
          localProcessedCounterMax: null,
          serverMaxCounterMax: null,
          localCounterUnknownCount: 0,
          localCounterSource: null,
          localCounterUnknownReason: null
        }
      });
    } else if (!selfDeviceId) {
      recordStageResult('Stage4', {
        ok: false,
        reasonCode: 'MISSING_DEVICE_ID'
      });
      state.inFlight = false;
      return { ok: false, stage: 'Stage4', reasonCode: 'MISSING_DEVICE_ID' };
    } else {
      let localCounterUnknown = false;
      let localCounterUnknownCount = 0;
      let queuedJobs = 0;
      let queuedConversations = 0;
      let scannedConversations = conversationIds.length;
      let localProcessedCounterMin = null;
      let localProcessedCounterMax = null;
      let serverMaxCounterMax = null;
      let localCounterSourceSet = new Set();
      let localCounterUnknownReasonSet = new Set();
      for (const conversationId of conversationIds) {
        let localCounterKnown = true;
        let localCounterSource = 'drSessMap.NrTotal';
        let localCounterUnknownReason = null;
        let localProcessedCounter = await getLocalProcessedCounter({ conversationId }, {
          onUnknown: (payload = {}) => {
            localCounterUnknown = true;
            localCounterKnown = false;
            localCounterUnknownCount += 1;
            localCounterSource = typeof payload?.source === 'string' ? payload.source : 'unknown';
            localCounterUnknownReason = payload?.unknownReason || payload?.reasonCode || null;
          }
        });
        if (!Number.isFinite(localProcessedCounter)) {
          localProcessedCounter = 0;
          localCounterUnknown = true;
          if (localCounterKnown) {
            localCounterKnown = false;
            localCounterUnknownCount += 1;
          }
          localCounterSource = 'unknown';
        }
        if (typeof localCounterSource === 'string') {
          localCounterSourceSet.add(localCounterSource);
        }
        if (localCounterUnknownReason) {
          localCounterUnknownReasonSet.add(localCounterUnknownReason);
        }
        if (localCounterKnown) {
          localProcessedCounterMin = localProcessedCounterMin === null
            ? localProcessedCounter
            : Math.min(localProcessedCounterMin, localProcessedCounter);
          localProcessedCounterMax = localProcessedCounterMax === null
            ? localProcessedCounter
            : Math.max(localProcessedCounterMax, localProcessedCounter);
        }

        const { maxCounter } = await fetchSecureMaxCounter({
          conversationId,
          senderDeviceId: selfDeviceId
        });
        if (!Number.isFinite(maxCounter)) {
          recordStageResult('Stage4', {
            ok: false,
            reasonCode: 'MAX_COUNTER_UNKNOWN'
          });
          state.inFlight = false;
          return { ok: false, stage: 'Stage4', reasonCode: 'MAX_COUNTER_UNKNOWN' };
        }
        const serverMaxCounter = Number(maxCounter);
        serverMaxCounterMax = serverMaxCounterMax === null
          ? serverMaxCounter
          : Math.max(serverMaxCounterMax, serverMaxCounter);
        if (maxCounter > localProcessedCounter) {
          // [LAZY-DECRYPT] Check if we have the key for the LATEST message (maxCounter)
          // If we have the key, it's "History" -> Enqueue for decryption (Preview).
          // If we DO NOT have the key, it's "Offline" -> Calculate Gap, Show Bubble, Do NOT Enqueue.
          let hasKey = false;
          try {
            // 1. Fetch the actual message metadata to get senderDeviceId/messageId for Vault Query
            const latestMsg = await getSecureMessageByCounter({
              conversationId,
              counter: maxCounter
            });
            if (latestMsg) {
              const mid = latestMsg.id || latestMsg.messageId || latestMsg.message_id || null;
              const sender = latestMsg.sender || latestMsg.senderDeviceId || null; // API might return sender: "digest::device"
              let sDevId = null;
              if (sender && sender.includes('::')) sDevId = sender.split('::')[1];
              else if (latestMsg.sender_device_id) sDevId = latestMsg.sender_device_id;

              if (mid && sDevId) {
                // 2. Check Vault
                const vaultRes = await MessageKeyVault.getMessageKey({
                  conversationId,
                  messageId: mid,
                  senderDeviceId: sDevId,
                });
                if (vaultRes?.r?.ok) {
                  hasKey = true;
                }
              }
            }
          } catch (err) {
            // If fetch failed, assume we might need to repair? Or safe fallback to enqueue?
            // Fallback: Enqueue and let pipeline handle it.
            hasKey = true;
          }

          if (hasKey) {
            const result = restoreGapQueue.enqueue({
              conversationId,
              targetCounter: maxCounter
            });
            if (result?.ok) {
              queuedJobs += 1;
              queuedConversations += 1;
            }
          } else {
            // [LAZY-DECRYPT] Offline Gap Detected
            // [GAP-COUNT] Precise Calculation (Backend)
            // Use the efficient API to count "Incoming + No Key" messages.
            let gapCount = 0;
            try {
              const sessionParams = sessionStore.getParams() || {};
              const selfDigest = sessionParams.accountDigest;

              const countRes = await getSecureGapCount({
                conversationId,
                minCounter: localProcessedCounter,
                maxCounter: maxCounter,
                excludeSenderAccountDigest: selfDigest // Exclude my own sent messages
              });
              gapCount = countRes.count || 0;
            } catch (e) {
              // Fallback to estimation if API fails
              gapCount = Math.max(0, maxCounter - localProcessedCounter);
              console.warn('[Restore] Gap Count API failed, resizing to estimate:', e);
            }

            const threads = sessionStore.conversationThreads;
            if (threads && typeof threads.get === 'function') {
              const thread = threads.get(conversationId);
              if (thread) {
                // Store precise offline count.
                thread.offlineUnreadCount = gapCount;
                threads.set(conversationId, { ...thread });

                // Notify UI
                try {
                  const appState = require('../../ui/mobile/app-mobile').appState;
                  if (appState?.conversationListController) {
                    appState.conversationListController.debounceRender();
                  }
                } catch (uiErr) {
                  // Ignore UI notify error
                }
              }
            }
            recordStageResult('Stage4', {
              ok: true,
              reasonCode: 'LAZY_OFFLINE_DEFERRED',
              conversationId,
              gapSize: gapCount
            });
          }
        }
      }
      const stats = typeof restoreGapQueue?.getStats === 'function'
        ? restoreGapQueue.getStats()
        : null;
      const localCounterSource = localCounterSourceSet.size === 1
        ? Array.from(localCounterSourceSet)[0]
        : (localCounterSourceSet.size === 0 ? null : 'mixed');
      const localCounterUnknownReason = localCounterUnknownReasonSet.size === 1
        ? Array.from(localCounterUnknownReasonSet)[0]
        : (localCounterUnknownReasonSet.size === 0 ? null : 'mixed');
      recordStageResult('Stage4', {
        ok: true,
        reasonCode: localCounterUnknown ? 'LOCAL_COUNTER_UNKNOWN' : null,
        progress: {
          scannedConversations,
          sampledConversations: null,
          enqueuedConversations: stats?.queuedConversations ?? queuedConversations,
          enqueuedJobs: stats?.queuedJobs ?? queuedJobs,
          scheduledConversations: stats?.scheduledConversations ?? null,
          draining: stats?.draining ?? null,
          localProcessedCounterMin,
          localProcessedCounterMax,
          serverMaxCounterMax,
          localCounterUnknownCount,
          localCounterSource,
          localCounterUnknownReason: localCounterUnknown ? localCounterUnknownReason : null
        }
      });
    }
  } catch (err) {
    recordStageResult('Stage4', {
      ok: false,
      reasonCode: 'STAGE4_FAILED'
    });
    state.inFlight = false;
    return { ok: false, stage: 'Stage4', reasonCode: 'STAGE4_FAILED' };
  }

  setStage('Stage5');
  recordStageResult('Stage5', { ok: true });
  state.inFlight = false;
  logPipelineDone();
  return { ok: true };
}

export async function probeStage4Progress() {
  const conversationIds = collectConversationIds();
  const sampleIds = conversationIds.slice(0, 20);
  let localProcessedCounterMin = null;
  let localProcessedCounterMax = null;
  let localCounterUnknownCount = 0;
  for (const conversationId of sampleIds) {
    let localCounterKnown = true;
    const localProcessedCounter = await getLocalProcessedCounter({ conversationId }, {
      onUnknown: () => {
        localCounterKnown = false;
        localCounterUnknownCount += 1;
      }
    });
    if (!Number.isFinite(localProcessedCounter)) {
      if (localCounterKnown) {
        localCounterKnown = false;
        localCounterUnknownCount += 1;
      }
      continue;
    }
    if (localCounterKnown) {
      localProcessedCounterMin = localProcessedCounterMin === null
        ? localProcessedCounter
        : Math.min(localProcessedCounterMin, localProcessedCounter);
      localProcessedCounterMax = localProcessedCounterMax === null
        ? localProcessedCounter
        : Math.max(localProcessedCounterMax, localProcessedCounter);
    }
  }
  const stats = typeof restoreGapQueue?.getStats === 'function'
    ? restoreGapQueue.getStats()
    : null;
  logCapped('restorePipelineStageTrace', {
    stage: 'Stage4',
    ok: true,
    reasonCode: 'PROGRESS',
    progress: {
      scannedConversations: conversationIds.length,
      sampledConversations: sampleIds.length,
      enqueuedConversations: stats?.queuedConversations ?? null,
      enqueuedJobs: stats?.queuedJobs ?? null,
      scheduledConversations: stats?.scheduledConversations ?? null,
      draining: stats?.draining ?? null,
      localProcessedCounterMin,
      localProcessedCounterMax,
      serverMaxCounterMax: null,
      localCounterUnknownCount,
      localCounterSource: null,
      localCounterUnknownReason: null
    },
    tsMs: nowMs()
  }, RESTORE_PIPELINE_LOG_CAP);
}

export async function waitForStage4Convergence(opts = {}) {
  const maxIterations = Number.isFinite(opts.maxIterations)
    ? Math.max(1, Math.floor(opts.maxIterations))
    : 10;
  const intervalMs = Number.isFinite(opts.intervalMs)
    ? Math.max(0, Math.floor(opts.intervalMs))
    : 500;
  const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
  const readProgressSnapshot = async () => {
    const conversationIds = collectConversationIds();
    const sampleIds = conversationIds.slice(0, 20);
    let localProcessedCounterMin = null;
    let localProcessedCounterMax = null;
    let localCounterUnknownCount = 0;
    for (const conversationId of sampleIds) {
      let localCounterKnown = true;
      const localProcessedCounter = await getLocalProcessedCounter({ conversationId }, {
        onUnknown: () => {
          localCounterKnown = false;
          localCounterUnknownCount += 1;
        }
      });
      if (!Number.isFinite(localProcessedCounter)) {
        if (localCounterKnown) {
          localCounterKnown = false;
          localCounterUnknownCount += 1;
        }
        continue;
      }
      if (localCounterKnown) {
        localProcessedCounterMin = localProcessedCounterMin === null
          ? localProcessedCounter
          : Math.min(localProcessedCounterMin, localProcessedCounter);
        localProcessedCounterMax = localProcessedCounterMax === null
          ? localProcessedCounter
          : Math.max(localProcessedCounterMax, localProcessedCounter);
      }
    }
    const stats = typeof restoreGapQueue?.getStats === 'function'
      ? restoreGapQueue.getStats()
      : null;
    return {
      scannedConversations: conversationIds.length,
      sampledConversations: sampleIds.length,
      enqueuedConversations: stats?.queuedConversations ?? null,
      enqueuedJobs: stats?.queuedJobs ?? null,
      scheduledConversations: stats?.scheduledConversations ?? null,
      draining: stats?.draining ?? null,
      localProcessedCounterMin,
      localProcessedCounterMax,
      serverMaxCounterMax: null,
      localCounterUnknownCount,
      localCounterSource: null,
      localCounterUnknownReason: null
    };
  };

  let iterations = 0;
  let lastProgress = await readProgressSnapshot();
  let prevUnknownCount = Number.isFinite(lastProgress?.localCounterUnknownCount)
    ? lastProgress.localCounterUnknownCount
    : null;

  for (let i = 0; i < maxIterations; i += 1) {
    await sleep(intervalMs);
    await probeStage4Progress();
    lastProgress = await readProgressSnapshot();
    iterations = i + 1;
    const queueIdle = lastProgress?.enqueuedJobs === 0 && lastProgress?.draining === false;
    const unknownCount = Number.isFinite(lastProgress?.localCounterUnknownCount)
      ? lastProgress.localCounterUnknownCount
      : null;
    const unknownNotIncreasing = unknownCount === null || prevUnknownCount === null
      ? true
      : unknownCount <= prevUnknownCount;
    if (queueIdle && unknownNotIncreasing) {
      return {
        ok: true,
        reasonCode: 'CONVERGED',
        iterations,
        lastProgress
      };
    }
    if (unknownCount !== null) {
      prevUnknownCount = unknownCount;
    }
  }

  return {
    ok: false,
    reasonCode: 'TIMEOUT',
    iterations,
    lastProgress
  };
}
