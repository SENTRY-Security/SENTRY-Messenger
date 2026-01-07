// /app/features/messages-flow/live/coordinator.js
// B-route live coordinator: orchestrates live decrypt MVP.

import { logCapped } from '../../core/log.js';
import { createLiveLegacyAdapters } from './adapters/index.js';
import { createLiveStateAccess } from './state-live.js';
import {
  fetchSecureMessageById,
  findItemByMessageId,
  listSecureMessagesLive
} from './server-api-live.js';

const LIVE_MVP_LOG_CAP = 5;
const LIVE_MVP_FETCH_LIMIT = 20;
const PREFIX_LEN = 8;
const LIVE_MVP_REASONS = Object.freeze({
  READY_FAILED: 'READY_FAILED',
  MISSING_MESSAGE_ID: 'MISSING_MESSAGE_ID',
  NOT_FOUND: 'NOT_FOUND',
  DECRYPT_FAIL: 'DECRYPT_FAIL',
  CONTROL_SKIP: 'CONTROL_SKIP',
  VAULT_PUT_FAILED: 'VAULT_PUT_FAILED',
  APPEND_FAILED: 'APPEND_FAILED',
  OK: 'OK',
  MATCHED: 'MATCHED'
});
const LIVE_MVP_RESULT_METRICS_DEFAULTS = Object.freeze({
  fetchedCount: 0,
  decryptOkCount: 0,
  decryptFailCount: 0,
  decryptSkippedCount: 0,
  vaultPutOkCount: 0,
  appendedCount: 0
});

function slicePrefix(value, len = PREFIX_LEN) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(0, len);
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function createLiveMvpResult({ conversationId, messageId } = {}) {
  return {
    ok: false,
    reasonCode: null,
    conversationId: conversationId || null,
    messageId: messageId || null,
    ready: false,
    fetched: false,
    decrypted: false,
    vaultPut: false,
    appended: false,
    metrics: { ...LIVE_MVP_RESULT_METRICS_DEFAULTS },
    tookMs: 0
  };
}

function finalizeLiveMvpResult(result, startedAt, reasonCode) {
  const tookMs = Math.max(0, Math.round(nowMs() - startedAt));
  return {
    ...result,
    ok: reasonCode === LIVE_MVP_REASONS.OK,
    reasonCode,
    tookMs,
    metrics: { ...result.metrics }
  };
}

// MVP entry point for ws incoming live decrypt (B-route).
export async function runLiveWsIncomingMvp(params = {}, deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  const adapters = deps?.adapters || createLiveLegacyAdapters();
  const stateAccess = deps?.stateAccess || createLiveStateAccess({ adapters });
  const listFetcher = deps?.listSecureMessagesLive || listSecureMessagesLive;
  const fetchById = deps?.fetchSecureMessageById || fetchSecureMessageById;
  const findById = deps?.findItemByMessageId || findItemByMessageId;

  const conversationId = params?.conversationId || null;
  const tokenB64 = params?.tokenB64 || null;
  const peerAccountDigest = params?.peerAccountDigest || null;
  const peerDeviceId = params?.peerDeviceId || null;
  const sourceTag = params?.sourceTag || null;
  const targetMessageId = params?.messageId || params?.serverMessageId || null;
  const conversationIdPrefix8 = slicePrefix(conversationId, 8);
  const targetMessageIdPrefix8 = slicePrefix(targetMessageId, 8);

  const startedAt = nowMs();
  const result = createLiveMvpResult({ conversationId, messageId: targetMessageId });
  let readyResult = { ok: false, reasonCode: LIVE_MVP_REASONS.READY_FAILED };
  let fetchResult = { items: [], errors: [], nextCursor: null };
  let decryptResult = { decryptedMessage: null, processedCount: 0, skippedCount: 0, okCount: 0, failCount: 0 };
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
      reasonCode: LIVE_MVP_REASONS.READY_FAILED,
      errorMessage: err?.message || String(err)
    };
  }

  const readyOk = !!readyResult?.ok;
  result.ready = readyOk;

  logger('liveMvpReadyTrace', {
    conversationIdPrefix8,
    ok: readyOk,
    reasonCode: readyOk ? null : LIVE_MVP_REASONS.READY_FAILED
  }, LIVE_MVP_LOG_CAP);

  if (!readyOk) {
    const reasonCode = LIVE_MVP_REASONS.READY_FAILED;
    const finalResult = finalizeLiveMvpResult(result, startedAt, reasonCode);
    logger('liveMvpSummaryTrace', {
      conversationIdPrefix8,
      sourceTag: sourceTag || null,
      tookMs: finalResult.tookMs,
      readyOk: false,
      reasonCode,
      fetchedCount: 0,
      decryptOk: 0,
      decryptFail: 0,
      decryptSkipped: 0,
      vaultPutOk: 0,
      appendedCount: 0
    }, LIVE_MVP_LOG_CAP);
    return finalResult;
  }

  if (!targetMessageId) {
    logger('liveMvpSelectTrace', {
      conversationIdPrefix8,
      targetMessageIdPrefix8,
      listItemsLength: 0,
      matched: false,
      reasonCode: LIVE_MVP_REASONS.NOT_FOUND
    }, LIVE_MVP_LOG_CAP);

    const reasonCode = LIVE_MVP_REASONS.MISSING_MESSAGE_ID;
    const finalResult = finalizeLiveMvpResult(result, startedAt, reasonCode);
    logger('liveMvpSummaryTrace', {
      conversationIdPrefix8,
      sourceTag: sourceTag || null,
      tookMs: finalResult.tookMs,
      readyOk: true,
      reasonCode,
      fetchedCount: 0,
      decryptOk: 0,
      decryptFail: 0,
      decryptSkipped: 0,
      vaultPutOk: 0,
      appendedCount: 0
    }, LIVE_MVP_LOG_CAP);
    return finalResult;
  }

  let selectedItem = null;
  let listItemsLength = 0;
  let selectionMatched = false;
  let selectionReasonCode = LIVE_MVP_REASONS.NOT_FOUND;
  let fetchErrors = [];
  let fetchNextCursor = null;

  try {
    const byIdResult = await fetchById({
      conversationId,
      messageId: targetMessageId,
      getSecureMessageById: deps?.getSecureMessageById
    });
    if (byIdResult?.supported) {
      fetchErrors = Array.isArray(byIdResult?.errors) ? byIdResult.errors : [];
      if (byIdResult?.item) {
        selectedItem = byIdResult.item;
        listItemsLength = 1;
      }
    } else {
      fetchResult = await listFetcher({
        conversationId,
        limit: LIVE_MVP_FETCH_LIMIT,
        cursorTs: null,
        cursorId: null
      });
      const items = Array.isArray(fetchResult?.items) ? fetchResult.items : [];
      fetchErrors = Array.isArray(fetchResult?.errors) ? fetchResult.errors : [];
      fetchNextCursor = fetchResult?.nextCursor || null;
      listItemsLength = items.length;
      selectedItem = findById(items, targetMessageId);
    }
  } catch (err) {
    const msg = err?.message || String(err);
    fetchErrors = msg ? [msg] : [];
  }

  selectionMatched = !!selectedItem;
  selectionReasonCode = selectionMatched ? LIVE_MVP_REASONS.MATCHED : LIVE_MVP_REASONS.NOT_FOUND;

  logger('liveMvpFetchTrace', {
    conversationIdPrefix8,
    itemsLength: listItemsLength,
    errorsLength: Array.isArray(fetchErrors) ? fetchErrors.length : 0,
    hasNextCursor: !!fetchNextCursor
  }, LIVE_MVP_LOG_CAP);

  logger('liveMvpSelectTrace', {
    conversationIdPrefix8,
    targetMessageIdPrefix8,
    listItemsLength,
    matched: selectionMatched,
    reasonCode: selectionReasonCode
  }, LIVE_MVP_LOG_CAP);

  if (!selectionMatched) {
    const reasonCode = LIVE_MVP_REASONS.NOT_FOUND;
    const finalResult = finalizeLiveMvpResult(result, startedAt, reasonCode);
    logger('liveMvpSummaryTrace', {
      conversationIdPrefix8,
      sourceTag: sourceTag || null,
      tookMs: finalResult.tookMs,
      readyOk: true,
      reasonCode,
      fetchedCount: 0,
      decryptOk: 0,
      decryptFail: 0,
      decryptSkipped: 0,
      vaultPutOk: 0,
      appendedCount: 0
    }, LIVE_MVP_LOG_CAP);
    return finalResult;
  }

  fetchResult = {
    items: selectedItem ? [selectedItem] : [],
    errors: fetchErrors,
    nextCursor: fetchNextCursor
  };

  try {
    decryptResult = await stateAccess.decryptIncomingSingle({
      conversationId,
      tokenB64,
      peerAccountDigest,
      peerDeviceId,
      item: selectedItem,
      targetMessageId
    });
  } catch (err) {
    decryptResult = {
      decryptedMessage: null,
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
    persistResult = await stateAccess.persistAndAppendSingle({
      conversationId,
      decryptedMessage: decryptResult?.decryptedMessage || null
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

  const fetchedCount = Array.isArray(fetchResult?.items) ? fetchResult.items.length : 0;
  const decryptOkCount = Number(decryptResult?.okCount) || 0;
  const decryptFailCount = Number(decryptResult?.failCount) || 0;
  const decryptSkippedCount = Number(decryptResult?.skippedCount) || 0;
  const vaultPutOkCount = Number(persistResult?.vaultPutOk) || 0;
  const appendedCount = Number(persistResult?.appendedCount) || 0;
  const hasDecryptedMessage = !!decryptResult?.decryptedMessage;

  result.fetched = fetchedCount > 0;
  result.decrypted = !!decryptResult?.ok;
  result.vaultPut = hasDecryptedMessage ? vaultPutOkCount > 0 : false;
  result.appended = hasDecryptedMessage ? !!persistResult?.appendOk : false;
  result.metrics.fetchedCount = fetchedCount;
  result.metrics.decryptOkCount = decryptOkCount;
  result.metrics.decryptFailCount = decryptFailCount;
  result.metrics.decryptSkippedCount = decryptSkippedCount;
  result.metrics.vaultPutOkCount = vaultPutOkCount;
  result.metrics.appendedCount = appendedCount;

  let reasonCode = LIVE_MVP_REASONS.OK;
  if (!result.decrypted) {
    reasonCode = decryptResult?.reasonCode === LIVE_MVP_REASONS.CONTROL_SKIP
      ? LIVE_MVP_REASONS.CONTROL_SKIP
      : LIVE_MVP_REASONS.DECRYPT_FAIL;
  } else if (!result.vaultPut) {
    reasonCode = LIVE_MVP_REASONS.VAULT_PUT_FAILED;
  } else if (!result.appended) {
    reasonCode = LIVE_MVP_REASONS.APPEND_FAILED;
  }

  const finalResult = finalizeLiveMvpResult(result, startedAt, reasonCode);

  logger('liveMvpSummaryTrace', {
    conversationIdPrefix8,
    sourceTag: sourceTag || null,
    tookMs: finalResult.tookMs,
    readyOk: true,
    reasonCode,
    fetchedCount: finalResult.metrics.fetchedCount,
    decryptOk: finalResult.metrics.decryptOkCount,
    decryptFail: finalResult.metrics.decryptFailCount,
    decryptSkipped: finalResult.metrics.decryptSkippedCount,
    vaultPutOk: finalResult.metrics.vaultPutOkCount,
    appendedCount: finalResult.metrics.appendedCount
  }, LIVE_MVP_LOG_CAP);

  return finalResult;
}
