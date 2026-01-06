// /app/features/messages-flow/live/coordinator.js
// B-route live coordinator: orchestrates live decrypt + catchup.

import { logCapped } from '../../core/log.js';
import { createLiveLegacyAdapters } from './adapters/index.js';
import { createLiveStateAccess } from './state-live.js';
import { listSecureMessagesLive } from './server-api-live.js';

const LIVE_COORDINATOR_LOG_CAP = 5;
const LIVE_MVP_LOG_CAP = 5;
const LIVE_MVP_FETCH_LIMIT = 20;
const PREFIX_LEN = 8;
const SUFFIX_LEN = 4;

function slicePrefix(value, len = PREFIX_LEN) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(0, len);
}

function sliceSuffix(value, len = SUFFIX_LEN) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(-len);
}

function normalizeCounter(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sanitizeParams(params = {}) {
  const conversationId = params?.conversationId || null;
  const peerAccountDigest = params?.peerAccountDigest || null;
  const peerDeviceId = params?.peerDeviceId || null;
  const tokenB64 = params?.tokenB64 || null;
  return {
    triggerSource: params?.triggerSource || null,
    mode: params?.mode || null,
    conversationIdPrefix8: slicePrefix(conversationId, 8),
    peerAccountDigestPrefix8: slicePrefix(peerAccountDigest, 8),
    peerAccountDigestSuffix4: sliceSuffix(peerAccountDigest, 4),
    peerDeviceIdSuffix4: sliceSuffix(peerDeviceId, 4),
    tokenPrefix4: slicePrefix(tokenB64, 4),
    tokenSuffix4: sliceSuffix(tokenB64, 4),
    tokenLen: tokenB64 ? String(tokenB64).length : 0,
    targetCounter: normalizeCounter(params?.targetCounter)
  };
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

// Main entry point for live catchup (B-route).
export async function runLiveCatchupForConversation(params = {}, deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  logger('liveCoordinatorTrace', sanitizeParams(params), LIVE_COORDINATOR_LOG_CAP);

  const adapters = deps?.adapters || null;

  // TODO: implement live catchup using adapters + gap-fill queue.
  // This stub intentionally does not change runtime behavior.
  return {
    ok: true,
    status: 'noop',
    adaptersReady: !!adapters
  };
}

// MVP entry point for ws incoming live decrypt (B-route).
export async function runLiveWsIncomingMvp(params = {}, deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  const adapters = deps?.adapters || createLiveLegacyAdapters();
  const stateAccess = deps?.stateAccess || createLiveStateAccess({ adapters });
  const fetcher = deps?.listSecureMessagesLive || listSecureMessagesLive;

  const conversationId = params?.conversationId || null;
  const tokenB64 = params?.tokenB64 || null;
  const peerAccountDigest = params?.peerAccountDigest || null;
  const peerDeviceId = params?.peerDeviceId || null;
  const sourceTag = params?.sourceTag || null;
  const conversationIdPrefix8 = slicePrefix(conversationId, 8);

  const startedAt = nowMs();
  let readyResult = { ok: false, reasonCode: 'UNKNOWN' };
  let fetchResult = { ok: false, status: null, items: [], errorsLength: 0 };
  let decryptResult = { decryptedMessages: [], processedCount: 0, skippedCount: 0, okCount: 0, failCount: 0 };
  let persistResult = { vaultPutOk: 0, appendOk: false, appendedCount: 0 };

  try {
    readyResult = await stateAccess.ensureLiveReady({
      conversationId,
      tokenB64,
      peerAccountDigest,
      peerDeviceId
    });
  } catch (err) {
    readyResult = {
      ok: false,
      reasonCode: 'READY_FAILED',
      errorMessage: err?.message || String(err)
    };
  }

  logger('liveMvpReadyTrace', {
    conversationIdPrefix8,
    ok: !!readyResult?.ok,
    reasonCode: readyResult?.reasonCode || null
  }, LIVE_MVP_LOG_CAP);

  if (!readyResult?.ok) {
    const tookMs = Math.max(0, Math.round(nowMs() - startedAt));
    logger('liveMvpSummaryTrace', {
      conversationIdPrefix8,
      sourceTag: sourceTag || null,
      tookMs,
      readyOk: false,
      reasonCode: readyResult?.reasonCode || null,
      fetchedCount: 0,
      decryptOk: 0,
      vaultPutOk: 0,
      appendedCount: 0
    }, LIVE_MVP_LOG_CAP);
    return { ok: false, reasonCode: readyResult?.reasonCode || 'READY_FAILED' };
  }

  try {
    fetchResult = await fetcher({
      conversationId,
      limit: LIVE_MVP_FETCH_LIMIT
    });
  } catch (err) {
    fetchResult = {
      ok: false,
      status: null,
      items: [],
      errorsLength: 1,
      errors: [err?.message || String(err)]
    };
  }

  logger('liveMvpFetchTrace', {
    conversationIdPrefix8,
    status: fetchResult?.status ?? null,
    itemsLength: Array.isArray(fetchResult?.items) ? fetchResult.items.length : 0,
    errorsLength: Number.isFinite(fetchResult?.errorsLength) ? fetchResult.errorsLength : 0
  }, LIVE_MVP_LOG_CAP);

  try {
    decryptResult = await stateAccess.decryptIncomingBatch({
      conversationId,
      tokenB64,
      peerAccountDigest,
      peerDeviceId,
      items: fetchResult?.items || []
    });
  } catch (err) {
    decryptResult = {
      decryptedMessages: [],
      processedCount: 0,
      skippedCount: 0,
      okCount: 0,
      failCount: 1,
      errorMessage: err?.message || String(err)
    };
  }

  logger('liveMvpDecryptTrace', {
    conversationIdPrefix8,
    processed: Number(decryptResult?.processedCount) || 0,
    skipped: Number(decryptResult?.skippedCount) || 0,
    ok: Number(decryptResult?.okCount) || 0,
    fail: Number(decryptResult?.failCount) || 0
  }, LIVE_MVP_LOG_CAP);

  try {
    persistResult = await stateAccess.persistAndAppendBatch({
      conversationId,
      decryptedMessages: decryptResult?.decryptedMessages || []
    });
  } catch (err) {
    persistResult = {
      vaultPutOk: 0,
      appendOk: false,
      appendedCount: 0,
      errorMessage: err?.message || String(err)
    };
  }

  logger('liveMvpPersistTrace', {
    conversationIdPrefix8,
    vaultPutOk: Number(persistResult?.vaultPutOk) || 0,
    appendOk: !!persistResult?.appendOk,
    appendedCount: Number(persistResult?.appendedCount) || 0
  }, LIVE_MVP_LOG_CAP);

  const tookMs = Math.max(0, Math.round(nowMs() - startedAt));
  logger('liveMvpSummaryTrace', {
    conversationIdPrefix8,
    sourceTag: sourceTag || null,
    tookMs,
    readyOk: true,
    fetchedCount: Array.isArray(fetchResult?.items) ? fetchResult.items.length : 0,
    decryptOk: Number(decryptResult?.okCount) || 0,
    decryptFail: Number(decryptResult?.failCount) || 0,
    decryptSkipped: Number(decryptResult?.skippedCount) || 0,
    vaultPutOk: Number(persistResult?.vaultPutOk) || 0,
    appendedCount: Number(persistResult?.appendedCount) || 0
  }, LIVE_MVP_LOG_CAP);

  return {
    ok: true,
    fetchedCount: Array.isArray(fetchResult?.items) ? fetchResult.items.length : 0,
    decryptOk: Number(decryptResult?.okCount) || 0,
    vaultPutOk: Number(persistResult?.vaultPutOk) || 0,
    appendedCount: Number(persistResult?.appendedCount) || 0
  };
}
