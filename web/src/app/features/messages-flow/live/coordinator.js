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
  let readyResult = { ok: false, reasonCode: 'UNKNOWN' };
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

  if (!targetMessageId) {
    logger('liveMvpSelectTrace', {
      conversationIdPrefix8,
      targetMessageIdPrefix8,
      listItemsLength: 0,
      matched: false,
      reasonCode: 'NOT_FOUND'
    }, LIVE_MVP_LOG_CAP);

    const tookMs = Math.max(0, Math.round(nowMs() - startedAt));
    logger('liveMvpSummaryTrace', {
      conversationIdPrefix8,
      sourceTag: sourceTag || null,
      tookMs,
      readyOk: true,
      reasonCode: 'MISSING_MESSAGE_ID',
      fetchedCount: 0,
      decryptOk: 0,
      decryptFail: 0,
      decryptSkipped: 0,
      vaultPutOk: 0,
      appendedCount: 0
    }, LIVE_MVP_LOG_CAP);
    return { ok: false, reasonCode: 'MISSING_MESSAGE_ID' };
  }

  let selectedItem = null;
  let listItemsLength = 0;
  let selectionMatched = false;
  let selectionReasonCode = 'NOT_FOUND';
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
  selectionReasonCode = selectionMatched ? 'MATCHED' : 'NOT_FOUND';

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
    const tookMs = Math.max(0, Math.round(nowMs() - startedAt));
    logger('liveMvpSummaryTrace', {
      conversationIdPrefix8,
      sourceTag: sourceTag || null,
      tookMs,
      readyOk: true,
      reasonCode: selectionReasonCode,
      fetchedCount: 0,
      decryptOk: 0,
      decryptFail: 0,
      decryptSkipped: 0,
      vaultPutOk: 0,
      appendedCount: 0
    }, LIVE_MVP_LOG_CAP);
    return { ok: false, reasonCode: selectionReasonCode };
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
