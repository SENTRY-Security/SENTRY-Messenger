import { getAccountDigest, getAccountToken, getMkRaw, ensureDeviceId } from '../core/store.js';
import { restoreContactSecrets } from '../core/contact-secrets.js';
import { hydrateContactSecretsFromBackup } from './contact-backup.js';
import { hydrateDrStatesFromContactSecrets } from './dr-session.js';
import { syncOfflineDecryptNow } from './messages.js';
import { logCapped } from '../core/log.js';
import { RESTORE_PIPELINE_LOG_CAP } from './restore-policy.js';

const STAGE_ORDER = [
  { key: 'stage0', name: 'stage0_credentials_ready' },
  { key: 'stage1', name: 'stage1_local_restore' },
  { key: 'stage2', name: 'stage2_remote_hydrate' },
  { key: 'stage3', name: 'stage3_hydrate_dr_holders' },
  { key: 'stage4', name: 'stage4_sync_offline_decrypt' },
  { key: 'stage5', name: 'stage5_done' }
];

const initialState = () => ({
  stage: null,
  stageIndex: -1,
  inFlight: false,
  source: null,
  startedAt: null,
  updatedAt: null,
  stages: {},
  trace: []
});

const state = initialState();

function clampTrace(list, max) {
  const cap = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 5;
  if (!Array.isArray(list)) return [];
  if (list.length <= cap) return list;
  return list.slice(list.length - cap);
}

function emitStageEvent(stageName, ok, metrics) {
  if (typeof document === 'undefined' || !document?.dispatchEvent) return;
  try {
    document.dispatchEvent(new CustomEvent('restore:pipeline', {
      detail: { stage: stageName, ok: !!ok, metrics: metrics || null }
    }));
  } catch {}
}

function recordStageTrace(stageName, ok, metrics, errorMessage) {
  const entry = {
    stageName,
    ok: !!ok,
    metrics: metrics || null,
    errorMessage: errorMessage || null,
    ts: Date.now()
  };
  state.trace = clampTrace([...(state.trace || []), entry], RESTORE_PIPELINE_LOG_CAP);
  logCapped('restorePipelineStageTrace', {
    stageName,
    ok: !!ok,
    metrics: metrics || null,
    errorMessage: errorMessage || null
  }, RESTORE_PIPELINE_LOG_CAP);
  emitStageEvent(stageName, ok, metrics);
}

function setStage(key) {
  const idx = STAGE_ORDER.findIndex((item) => item.key === key);
  state.stage = key;
  state.stageIndex = idx;
  state.updatedAt = Date.now();
}

function recordStageResult(key, { ok, metrics, errorMessage } = {}) {
  const stage = STAGE_ORDER.find((item) => item.key === key);
  if (!stage) return;
  const entry = {
    ok: !!ok,
    metrics: metrics || null,
    errorMessage: errorMessage || null,
    ts: Date.now()
  };
  state.stages[stage.key] = entry;
  recordStageTrace(stage.name, ok, metrics, errorMessage);
}

function buildSummary() {
  const summary = {
    source: state.source,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    stage: state.stage,
    stageIndex: state.stageIndex,
    inFlight: state.inFlight,
    stages: {},
    trace: Array.isArray(state.trace) ? state.trace.slice() : []
  };
  for (const item of STAGE_ORDER) {
    summary.stages[item.key] = state.stages[item.key] || null;
  }
  return summary;
}

function logPipelineDone() {
  const tookMs = Number.isFinite(state.startedAt) ? Math.max(0, Date.now() - state.startedAt) : null;
  const stageStats = {};
  for (const item of STAGE_ORDER) {
    const stageEntry = state.stages[item.key] || null;
    stageStats[item.name] = stageEntry
      ? {
          ok: !!stageEntry.ok,
          metrics: stageEntry.metrics || null,
          errorMessage: stageEntry.errorMessage || null
        }
      : null;
  }
  logCapped('restorePipelineDoneTrace', {
    tookMs,
    stages: stageStats,
    source: state.source || null
  }, RESTORE_PIPELINE_LOG_CAP);
  emitStageEvent('stage5_done', true, { tookMs });
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
  if (state.inFlight) return buildSummary();
  resetRestorePipelineState();
  state.inFlight = true;
  state.source = typeof source === 'string' ? source : null;
  state.startedAt = Date.now();
  state.updatedAt = state.startedAt;

  let hasMk = false;
  let hasAccountDigest = false;
  try {
    setStage('stage0');
    const mk = getMkRaw();
    const digest = getAccountDigest();
    const token = getAccountToken();
    const selfDeviceId = ensureDeviceId() || null;
    hasMk = !!mk;
    hasAccountDigest = !!digest;
    const ok = hasMk && hasAccountDigest;
    recordStageResult('stage0', {
      ok,
      metrics: {
        hasMk,
        hasAccountDigest,
        hasAccountToken: !!token,
        selfDeviceIdSuffix4: selfDeviceId ? String(selfDeviceId).slice(-4) : null
      },
      errorMessage: ok ? null : 'credentials-missing'
    });
  } catch (err) {
    recordStageResult('stage0', {
      ok: false,
      metrics: null,
      errorMessage: err?.message || String(err)
    });
  }

  try {
    setStage('stage1');
    const map = restoreContactSecrets();
    const entries = map instanceof Map ? map.size : 0;
    recordStageResult('stage1', {
      ok: true,
      metrics: { entries }
    });
  } catch (err) {
    recordStageResult('stage1', {
      ok: false,
      metrics: null,
      errorMessage: err?.message || String(err)
    });
  }

  try {
    setStage('stage2');
    if (!hasMk) {
      recordStageResult('stage2', {
        ok: false,
        metrics: { skipped: true, reason: 'mk-missing' },
        errorMessage: 'mk-missing'
      });
    } else {
      const result = await hydrateContactSecretsFromBackup({ reason: 'restore_pipeline' });
      recordStageResult('stage2', {
        ok: !!result?.ok,
        metrics: {
          ok: !!result?.ok,
          status: result?.status ?? null,
          entries: result?.entries ?? null,
          corruptCount: result?.corruptCount ?? null,
          snapshotVersion: result?.snapshotVersion || null
        },
        errorMessage: result?.ok ? null : (result?.corrupt ? 'corrupt-backup' : null)
      });
    }
  } catch (err) {
    recordStageResult('stage2', {
      ok: false,
      metrics: null,
      errorMessage: err?.message || String(err)
    });
  }

  try {
    setStage('stage3');
    const summary = hydrateDrStatesFromContactSecrets({ source: 'restore_pipeline' }) || {};
    recordStageResult('stage3', {
      ok: Number(summary?.errorCount || 0) === 0,
      metrics: {
        restoredCount: summary?.restoredCount ?? 0,
        skippedCount: summary?.skippedCount ?? 0,
        errorCount: summary?.errorCount ?? 0
      }
    });
  } catch (err) {
    recordStageResult('stage3', {
      ok: false,
      metrics: null,
      errorMessage: err?.message || String(err)
    });
  }

  try {
    setStage('stage4');
    if (!hasMk) {
      recordStageResult('stage4', {
        ok: false,
        metrics: { skipped: true, reason: 'mk-missing' },
        errorMessage: 'mk-missing'
      });
    } else {
      const result = await syncOfflineDecryptNow({ source: 'restore_pipeline' });
      const locked = Array.isArray(result?.lockedConversations) ? result.lockedConversations.length : 0;
      recordStageResult('stage4', {
        ok: Number(result?.failCount || 0) === 0,
        metrics: {
          plannedCount: result?.plannedCount ?? 0,
          attemptedCount: result?.attemptedCount ?? 0,
          successCount: result?.successCount ?? 0,
          failCount: result?.failCount ?? 0,
          lockedCount: locked
        }
      });
    }
  } catch (err) {
    recordStageResult('stage4', {
      ok: false,
      metrics: null,
      errorMessage: err?.message || String(err)
    });
  }

  setStage('stage5');
  state.inFlight = false;
  recordStageResult('stage5', {
    ok: true,
    metrics: { done: true }
  });
  logPipelineDone();
  return buildSummary();
}
