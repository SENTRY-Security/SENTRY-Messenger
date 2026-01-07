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

const STAGES = ['Stage0', 'Stage1', 'Stage2', 'Stage3', 'Stage4', 'Stage5'];
const restoreGapQueue = createGapQueue({
  getLocalProcessedCounter: (conversationId) => getLocalProcessedCounter({ conversationId })
});

const initialState = () => ({
  stage: null,
  stageIndex: -1,
  inFlight: false,
  startedAt: null,
  updatedAt: null,
  stages: {},
  trace: []
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
  } catch {}
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
    trace: Array.isArray(state.trace) ? state.trace.slice() : []
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
    setStage('Stage4');
    const conversationIds = collectConversationIds();
    if (!conversationIds.length) {
      recordStageResult('Stage4', {
        ok: true,
        reasonCode: 'SKIPPED_NO_CONVERSATIONS',
        progress: { queuedConversations: 0, queuedJobs: 0, localCounterSource: 'unknown', localCounterUnknownReason: null }
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
      let queuedJobs = 0;
      let queuedConversations = 0;
      let lastLocalProcessedCounter = 0;
      let lastServerMaxCounter = 0;
      let lastLocalCounterSource = 'unknown';
      let lastLocalCounterUnknownReason = null;
      for (const conversationId of conversationIds) {
        let localCounterSource = 'drSessMap.NrTotal';
        let localCounterUnknownReason = null;
        let localProcessedCounter = await getLocalProcessedCounter({ conversationId }, {
          onUnknown: (payload = {}) => {
            localCounterUnknown = true;
            localCounterSource = typeof payload?.source === 'string' ? payload.source : 'unknown';
            localCounterUnknownReason = payload?.unknownReason || payload?.reasonCode || null;
          }
        });
        if (!Number.isFinite(localProcessedCounter)) {
          localProcessedCounter = 0;
          localCounterUnknown = true;
          localCounterSource = 'unknown';
        }
        lastLocalProcessedCounter = localProcessedCounter;
        lastLocalCounterSource = localCounterSource;
        lastLocalCounterUnknownReason = localCounterUnknownReason;
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
        lastServerMaxCounter = Number(maxCounter);
        if (maxCounter > localProcessedCounter) {
          const result = restoreGapQueue.enqueue({
            conversationId,
            targetCounter: maxCounter
          });
          if (result?.ok) {
            queuedJobs += 1;
            queuedConversations += 1;
          }
        }
      }
      const stats = typeof restoreGapQueue?.getStats === 'function'
        ? restoreGapQueue.getStats()
        : null;
      recordStageResult('Stage4', {
        ok: true,
        reasonCode: localCounterUnknown ? 'LOCAL_COUNTER_UNKNOWN' : null,
        progress: {
          localProcessedCounter: lastLocalProcessedCounter,
          localCounterSource: lastLocalCounterSource,
          localCounterUnknownReason: localCounterUnknown ? lastLocalCounterUnknownReason : null,
          serverMaxCounter: lastServerMaxCounter,
          queuedConversations: stats?.queuedConversations ?? queuedConversations,
          queuedJobs: stats?.queuedJobs ?? queuedJobs
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
