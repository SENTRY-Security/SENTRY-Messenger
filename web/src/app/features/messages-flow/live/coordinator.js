// /app/features/messages-flow/live/coordinator.js
// B-route live coordinator: orchestrates live decrypt MVP.

import { logCapped } from '../../../core/log.js';
import { createCommitNotifier } from '../notify.js';
import { createLiveLegacyAdapters } from './adapters/index.js';
import { createLiveStateAccess } from './state-live.js';
import { validateLiveJob } from './job.js';
import {
  fetchSecureMessageById,
  findItemByMessageId,
  listSecureMessagesLive
} from './server-api-live.js';
import { triggerContactSecretsBackup } from '../../../features/contact-backup.js';
import { REMOTE_BACKUP_TRIGGER_DECRYPT_OK_BATCH } from '../../../features/restore-policy.js';
import { getLocalProcessedCounter } from '../local-counter.js';
import { getSecureMessageByCounter } from '../../../api/messages.js';
import {
  updatePendingLivePlaceholderStatus,
  addPendingLivePlaceholder // [FIX] Import
} from '../../../features/messages/placeholder-store.js';

export class GapDetectedError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'GapDetectedError';
    this.context = context;
    this.conversationId = context.conversationId;
    this.localMax = context.localMax;
    this.incomingCounter = context.incomingCounter;
    this.gapSize = context.gapSize;
  }
}


let decryptOkSinceBackup = 0;

function maybeTriggerBackupAfterDecrypt({ sourceTag } = {}) {
  const batch = Number(REMOTE_BACKUP_TRIGGER_DECRYPT_OK_BATCH);
  if (!Number.isFinite(batch) || batch <= 0) return;
  decryptOkSinceBackup += 1;
  if (decryptOkSinceBackup < batch) return;
  decryptOkSinceBackup = 0;
  try {
    triggerContactSecretsBackup('recv-batch', {
      force: false,
      sourceTag: sourceTag || 'coordinator:decrypt-ok'
    }).catch(() => { });
  } catch { }
}

const LIVE_MVP_LOG_CAP = 5;
const LIVE_MVP_FETCH_LIMIT = 20;
const B_ROUTE_COMMIT_LOG_CAP = 5;
const PREFIX_LEN = 8;
const LIVE_MVP_REASONS = Object.freeze({
  MISSING_PARAMS: 'MISSING_PARAMS',
  ADAPTERS_UNAVAILABLE: 'ADAPTERS_UNAVAILABLE',
  SECURE_PENDING: 'SECURE_PENDING',
  SECURE_FAILED: 'SECURE_FAILED',
  DR_STATE_UNAVAILABLE: 'DR_STATE_UNAVAILABLE',
  READY_FAILED: 'READY_FAILED',
  MISSING_MESSAGE_ID: 'MISSING_MESSAGE_ID',
  NOT_FOUND: 'NOT_FOUND',
  DECRYPT_FAIL: 'DECRYPT_FAIL',
  CONTROL_SKIP: 'CONTROL_SKIP',
  MISSING_CIPHERTEXT: 'MISSING_CIPHERTEXT',
  MISSING_MESSAGE_KEY: 'MISSING_MESSAGE_KEY',
  MISSING_MESSAGE_FIELDS: 'MISSING_MESSAGE_FIELDS',
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
  vaultPutFailCount: 0,
  appendedCount: 0,
  fetchErrorsLength: 0
});

const defaultCommitNotifier = createCommitNotifier();

function slicePrefix(value, len = PREFIX_LEN) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(0, len);
}

function buildCommitEvent({
  conversationId = null,
  counter = null,
  messageId = null,
  ok = false,
  reasonCode = null,
  didVaultPut = false,
  sourceTag = null
} = {}) {
  return {
    conversationId,
    counter: Number.isFinite(counter) ? counter : null,
    messageId: messageId || null,
    ok: !!ok,
    reasonCode,
    didVaultPut: !!didVaultPut,
    sourceTag: sourceTag || null,
    tsMs: Date.now()
  };
}

function emitCommitEvent(onCommit, logger, event, trace) {
  if (typeof onCommit !== 'function') return;
  try {
    onCommit(event);
  } catch {
    logger('bRouteCommitEventTrace', {
      ...trace,
      onCommitError: true
    }, B_ROUTE_COMMIT_LOG_CAP);
  }
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

export async function commitBRouteCounter(params = {}, deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  const onCommitBase = typeof deps?.onCommit === 'function'
    ? deps.onCommit
    : (typeof deps?.emitCommit === 'function' ? deps.emitCommit : null);
  const handleCommitEvent = typeof deps?.handleCommitEvent === 'function'
    ? deps.handleCommitEvent
    : (typeof deps?.presentation?.handleCommitEvent === 'function'
      ? deps.presentation.handleCommitEvent
      : null);
  const commitNotifier = typeof deps?.commitNotifier === 'function'
    ? deps.commitNotifier
    : (typeof deps?.commitNotifier?.handleCommitEvent === 'function'
      ? deps.commitNotifier.handleCommitEvent
      : defaultCommitNotifier);
  const onCommit = (typeof commitNotifier === 'function'
    || typeof handleCommitEvent === 'function'
    || typeof onCommitBase === 'function')
    ? (event) => {
      if (typeof commitNotifier === 'function') {
        try {
          commitNotifier(event);
        } catch {
          const source = typeof event?.sourceTag === 'string'
            ? event.sourceTag
            : (typeof event?.source === 'string' ? event.source : null);
          const normalizedSource = source && String(source).trim()
            ? String(source).trim()
            : null;
          logger('commitNotifyTrace', {
            conversationIdPrefix8: slicePrefix(event?.conversationId, 8),
            counter: Number.isFinite(event?.counter) ? event.counter : null,
            ok: event?.ok === true,
            didVaultPut: event?.didVaultPut === true,
            deduped: false,
            reasonCode: 'NOTIFY_HANDLER_THROW',
            source: normalizedSource
          }, B_ROUTE_COMMIT_LOG_CAP);
        }
      }
      if (typeof handleCommitEvent === 'function') {
        handleCommitEvent(event);
      }
      if (typeof onCommitBase === 'function') {
        onCommitBase(event);
      }
    }
    : null;
  const adapters = deps?.adapters || createLiveLegacyAdapters();
  const stateAccess = deps?.stateAccess || createLiveStateAccess({ adapters });

  const conversationId = params?.conversationId || null;
  const tokenB64 = params?.tokenB64 || null;
  const peerAccountDigest = params?.peerAccountDigest || null;
  const peerDeviceId = params?.peerDeviceId || null;
  const raw = params?.item || params?.raw || null;
  const sourceTag = typeof params?.sourceTag === 'string'
    ? params.sourceTag.trim()
    : (typeof params?.source === 'string' ? params.source.trim() : null);

  const messageId =
    (raw && (raw.id || raw.message_id || raw.messageId))
    || params?.messageId
    || params?.serverMessageId
    || null;
  const counter = Number.isFinite(params?.counter)
    ? Number(params.counter)
    : (Number.isFinite(Number(raw?.counter)) ? Number(raw?.counter) : null);
  const conversationIdPrefix8 = slicePrefix(conversationId, 8);
  const messageIdPrefix8 = slicePrefix(messageId, 8);

  logger('bRouteDecryptAttemptTrace', {
    conversationIdPrefix8,
    counter: Number.isFinite(counter) ? counter : null,
    messageIdPrefix8,
    hasItem: !!raw
  }, B_ROUTE_COMMIT_LOG_CAP);

  let readyResult = { ok: false, reasonCode: 'READY_FAILED' };
  try {
    readyResult = await stateAccess.ensureLiveReady({
      conversationId,
      tokenB64,
      peerAccountDigest,
      peerDeviceId,
      item: raw
    });
  } catch (err) {
    readyResult = {
      ok: false,
      reasonCode: 'READY_FAILED',
      errorMessage: err?.message || String(err)
    };
  }

  if (!readyResult?.ok) {
    const reasonCode = readyResult?.reasonCode || 'READY_FAILED';
    const result = {
      ok: false,
      reasonCode,
      counter: Number.isFinite(counter) ? counter : null,
      messageId,
      decryptOk: false,
      vaultPutOk: false
    };
    logger('bRouteDecryptResultTrace', {
      conversationIdPrefix8,
      counter: result.counter,
      messageIdPrefix8,
      ok: false,
      reasonCode,
      decryptOk: false,
      vaultPutOk: false
    }, B_ROUTE_COMMIT_LOG_CAP);
    emitCommitEvent(onCommit, logger, buildCommitEvent({
      conversationId,
      counter: result.counter,
      messageId: result.messageId,
      ok: result.ok,
      reasonCode: result.reasonCode,
      didVaultPut: result.vaultPutOk,
      sourceTag
    }), {
      conversationIdPrefix8,
      counter: result.counter,
      messageIdPrefix8,
      ok: result.ok
    });
    return result;
  }

  // [STRICT SEQUENTIAL] Blocking Gap Fill
  // Ensure we process messages in strict order (1->2->3) instead of skipping (1->4).
  // This prevents "optimistic skipping" which creates gap keys that are hard to retrieve later.
  if (Number.isFinite(counter) && counter > 0 && conversationId) {
    try {
      const depsLocalCounter = typeof deps?.getLocalProcessedCounter === 'function' ? deps.getLocalProcessedCounter : getLocalProcessedCounter;
      const depsGetMsgByCounter = typeof deps?.getSecureMessageByCounter === 'function' ? deps.getSecureMessageByCounter : getSecureMessageByCounter;

      // Check Check local max (Vault Truth)
      // We assume simple sequential consistency.
      const localMax = await depsLocalCounter({ conversationId }); // Blocking check

      if (Number.isFinite(localMax) && counter > localMax + 1) {
        const gapSize = counter - (localMax + 1);
        logger('bRouteGapDetected', {
          conversationIdPrefix8,
          localMax,
          incomingCounter: counter,
          gapSize
        }, B_ROUTE_COMMIT_LOG_CAP);

        // Cap to prevent infinite hangs if gap is huge (sanity check)
        const FILL_CAP = 50;
        const start = localMax + 1;
        const end = Math.min(start + gapSize - 1, start + FILL_CAP);

        for (let c = start; c <= end; c++) {
          try {
            // Blocking Fetch: Get the missing data from server (Consistency Guarantee)
            const fetchRes = await depsGetMsgByCounter({
              conversationId,
              counter: c,
              senderDeviceId: peerDeviceId,
              senderAccountDigest: peerAccountDigest
            });

            const gapItem = fetchRes?.data?.item || fetchRes?.data?.message || null;
            if (gapItem) {
              // [GAP FILL SAFETY]
              // We must DISABLE 'bootstrapDrFromGuestBundle' for gap messages.
              // If a gap message is an old PreKey message (Type 3), it must NOT reset the current session.
              // We create a restricted adapter set that forces bootstrap to fail/skip.
              const safeGapAdapters = { ...deps, bootstrapDrFromGuestBundle: null };

              // Blocking Process: Decrypt & Advance State Sequentially
              await stateAccess.commitIncomingSingle({
                conversationId,
                tokenB64,
                peerAccountDigest,
                peerDeviceId,
                item: gapItem,
                counter: c
              }, safeGapAdapters);
              logger('bRouteGapFilled', { c, ok: true }, B_ROUTE_COMMIT_LOG_CAP);
            } else {
              // [FAIL CLOSE]
              // If we cannot find the gap message, we must NOT proceed to process the live message.
              // Proceeding would create a permanent gap in the ratchet state.
              // Throwing error triggers retry, hoping for eventual consistency.
              logger('bRouteGapFilled', { c, ok: false, reason: 'not_found' }, B_ROUTE_COMMIT_LOG_CAP);
              throw new Error(`Gap message ${c} not found. Aborting live process to preserve state sequence.`);
            }
          } catch (err) {
            logger('bRouteGapFillError', { c, error: err?.message }, B_ROUTE_COMMIT_LOG_CAP);
            throw err; // [FAIL CLOSE] Rethrow to abort outer live connection
          }
        }
      }
    } catch (err) {
      logger('bRouteGapCheckError', { error: err?.message }, B_ROUTE_COMMIT_LOG_CAP);
      throw err; // [FAIL CLOSE] Rethrow to trigger retry logic mechanism
    }
  }

  let commitResult = null;
  try {
    commitResult = await stateAccess.commitIncomingSingle({
      conversationId,
      tokenB64,
      peerAccountDigest,
      peerDeviceId,
      item: raw,
      counter,
      targetMessageId: messageId
    });
  } catch (err) {
    commitResult = {
      ok: false,
      reasonCode: 'COMMIT_FAILED',
      counter: Number.isFinite(counter) ? counter : null,
      messageId,
      decryptOk: false,
      vaultPutOk: false,
      errorMessage: err?.message || String(err)
    };
  }

  const resolvedCounter = Number.isFinite(commitResult?.counter)
    ? Number(commitResult.counter)
    : (Number.isFinite(counter) ? counter : null);
  const resolvedMessageId = commitResult?.messageId || messageId || null;
  const resolvedMessageIdPrefix8 = slicePrefix(resolvedMessageId, 8);

  const result = {
    ok: !!commitResult?.ok,
    reasonCode: commitResult?.reasonCode || null,
    counter: resolvedCounter,
    messageId: resolvedMessageId,
    decryptOk: !!commitResult?.decryptOk,
    vaultPutOk: !!commitResult?.vaultPutOk
  };

  logger('bRouteDecryptResultTrace', {
    conversationIdPrefix8,
    counter: result.counter,
    messageIdPrefix8: resolvedMessageIdPrefix8,
    ok: result.ok,
    reasonCode: result.reasonCode,
    decryptOk: result.decryptOk,
    vaultPutOk: result.vaultPutOk
  }, B_ROUTE_COMMIT_LOG_CAP);

  if (result.decryptOk) {
    logger('bRouteVaultPutTrace', {
      conversationIdPrefix8,
      counter: result.counter,
      messageIdPrefix8: resolvedMessageIdPrefix8,
      ok: result.vaultPutOk,
      reasonCode: result.vaultPutOk ? null : result.reasonCode
    }, B_ROUTE_COMMIT_LOG_CAP);
  }

  emitCommitEvent(onCommit, logger, buildCommitEvent({
    conversationId,
    counter: result.counter,
    messageId: result.messageId,
    ok: result.ok,
    reasonCode: result.reasonCode,
    didVaultPut: result.vaultPutOk,
    sourceTag
  }), {
    conversationIdPrefix8,
    counter: result.counter,
    messageIdPrefix8: resolvedMessageIdPrefix8,
    ok: result.ok
  });

  return result;
}

// Unified live coordinator entry (B-route).
export async function consumeLiveJob(job = null, deps = {}) {
  const startedAt = nowMs();
  const conversationId = job?.conversationId || null;
  const targetMessageId = job?.messageId || job?.serverMessageId || null;
  const baseResult = createLiveMvpResult({ conversationId, messageId: targetMessageId });
  const validation = validateLiveJob(job);
  if (!validation.ok) {
    return finalizeLiveMvpResult(baseResult, startedAt, LIVE_MVP_REASONS.MISSING_PARAMS);
  }
  return runLiveWsIncomingMvp(job, deps);
}

// MVP runner for ws incoming live decrypt (B-route).
async function runLiveWsIncomingMvp(job = {}, deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  const adapters = deps?.adapters || createLiveLegacyAdapters();
  const stateAccess = deps?.stateAccess || createLiveStateAccess({ adapters });
  const listFetcher = deps?.listSecureMessagesLive || listSecureMessagesLive;
  const fetchById = deps?.fetchSecureMessageById || fetchSecureMessageById;
  const findById = deps?.findItemByMessageId || findItemByMessageId;
  const maybeSendVaultAckWs = deps?.maybeSendVaultAckWs || null;
  const getAccountDigest = deps?.getAccountDigest || null;
  const getDeviceId = deps?.getDeviceId || null;

  const conversationId = job?.conversationId || null;
  const tokenB64 = job?.tokenB64 || null;
  const peerAccountDigest = job?.peerAccountDigest || null;
  const peerDeviceId = job?.peerDeviceId || null;
  const sourceTag = job?.sourceTag || null;
  const targetMessageId = job?.messageId || job?.serverMessageId || null;
  const conversationIdPrefix8 = slicePrefix(conversationId, 8);
  const targetMessageIdPrefix8 = slicePrefix(targetMessageId, 8);

  const startedAt = nowMs();
  const result = createLiveMvpResult({ conversationId, messageId: targetMessageId });
  let readyResult = { ok: false, reasonCode: LIVE_MVP_REASONS.READY_FAILED };
  let fetchResult = { items: [], errors: [], nextCursor: null };
  let decryptResult = { decryptedMessage: null, processedCount: 0, skippedCount: 0, okCount: 0, failCount: 0 };
  let persistResult = { vaultPutOk: 0, vaultPutFail: 0, appendOk: false, appendedCount: 0 };

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

  // [FIX] Self-Sent Message Guard (Fail-Close)
  // We MUST NOT process our own outgoing messages as "Incoming Live" jobs.
  // Doing so causes "Sender using Receiver Counter" corruption and false Gap Detection loops.
  if (selectionMatched && selectedItem) {
    try {
      // Normalize IDs
      const senderDeviceId = selectedItem.sender_device_id || selectedItem.senderDeviceId || null;
      const senderDigest = selectedItem.sender_account_digest || selectedItem.senderAccountDigest || null;

      const myDeviceId = getDeviceId ? getDeviceId() : null;
      // Account digest check is secondary, Device ID is the primary cryptographic identity for specific chains.

      if (myDeviceId && senderDeviceId === myDeviceId) {
        const myDigest = getAccountDigest ? getAccountDigest() : null;
        // If digest also matches (or is missing on item), it's definitely us.
        // Logic Matches hybrid-flow.js fix.
        const isOutgoing = (senderDigest && myDigest) ? (senderDigest === myDigest) : true;

        if (isOutgoing) {
          logger('liveMvpTrace', {
            conversationIdPrefix8,
            messageIdPrefix8: slicePrefix(targetMessageId, 8),
            action: 'ignore_outgoing',
            senderDeviceId: slicePrefix(senderDeviceId, 4),
            reason: 'SELF_SENT_ECHO'
          }, LIVE_MVP_LOG_CAP);

          const finalResult = finalizeLiveMvpResult(result, startedAt, 'IGNORE_OUTGOING');
          finalResult.ok = true; // Treated as "Success" (ignored safely)
          return finalResult;
        }
      }
    } catch (err) {
      console.warn('[LiveMvp] Outgoing check warning', err);
    }
  }

  result.metrics.fetchErrorsLength = Array.isArray(fetchErrors) ? fetchErrors.length : 0;
  result.metrics.fetchedCount = listItemsLength;
  result.fetched = selectionMatched;

  logger('liveMvpFetchTrace', {
    conversationIdPrefix8,
    itemsLength: listItemsLength,
    errorsLength: Array.isArray(fetchErrors) ? fetchErrors.length : 0,
    hasNextCursor: !!fetchNextCursor
  }, LIVE_MVP_LOG_CAP);

  if (!selectionMatched) {
    const finalResult = finalizeLiveMvpResult(result, startedAt, LIVE_MVP_REASONS.NOT_FOUND);
    logger('liveMvpSummaryTrace', {
      conversationIdPrefix8,
      sourceTag: sourceTag || null,
      tookMs: finalResult.tookMs,
      readyOk: false,
      reasonCode: finalResult.reasonCode,
      fetchedCount: finalResult.metrics.fetchedCount,
      decryptOk: 0,
      decryptFail: 0,
      decryptSkipped: 0,
      vaultPutOk: 0,
      appendedCount: 0
    }, LIVE_MVP_LOG_CAP);
    return finalResult;
  }

  try {
    readyResult = await stateAccess.ensureLiveReady({
      conversationId,
      tokenB64,
      peerAccountDigest,
      peerDeviceId,
      item: selectedItem
    });
  } catch (err) {
    readyResult = {
      ok: false,
      reasonCode: LIVE_MVP_REASONS.READY_FAILED,
      errorMessage: err?.message || String(err)
    };
  }

  const readyOk = !!readyResult?.ok;
  const readyReasonCode = readyResult?.reasonCode || LIVE_MVP_REASONS.READY_FAILED;
  result.ready = readyOk;

  logger('liveMvpReadyTrace', {
    conversationIdPrefix8,
    ok: readyOk,
    reasonCode: readyOk ? null : readyReasonCode
  }, LIVE_MVP_LOG_CAP);

  if (!readyOk) {
    const finalResult = finalizeLiveMvpResult(result, startedAt, readyReasonCode);
    logger('liveMvpSummaryTrace', {
      conversationIdPrefix8,
      sourceTag: sourceTag || null,
      tookMs: finalResult.tookMs,
      readyOk: false,
      reasonCode: finalResult.reasonCode,
      fetchedCount: listItemsLength,
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

  // [FIX] Blocking Gap Check (Fail-Close)
  // Ensure we do not process out-of-order Live messages (Shadow Advance).
  // If a gap exists, we MUST throw to trigger retry, giving Hybrid Flow time to fill history.
  // [EXCEPTION] Hybrid Flow (History Fill) passes `skipGapCheck: true` because it guarantees sequential processing.
  if (selectedItem && !job?.skipGapCheck) {
    try {
      const depsLocalCounter = typeof deps?.getLocalProcessedCounter === 'function' ? deps.getLocalProcessedCounter : getLocalProcessedCounter;

      // [FIX] Strict Counter Resolution
      // Prioritize `header.n` (Ratchet Counter) over `counter` (which might be Transport Key or DB ID).
      let counter = null;

      // Try resolving from header object or parsed JSON
      let headerObj = selectedItem.header;
      if (!headerObj && (selectedItem.header_json || selectedItem.headerJson)) {
        try {
          headerObj = JSON.parse(selectedItem.header_json || selectedItem.headerJson);
        } catch { }
      }

      if (headerObj && (headerObj.n !== undefined || headerObj.counter !== undefined)) {
        counter = Number(headerObj.n ?? headerObj.counter);
      }
      // [STRICT] No fallback to selectedItem.counter. 
      // If header.n is missing, we cannot advance the Ratchet anyway (so no Shadow Advance risk).
      // We must not block based on transport-layer counters to avoid false positives and manipulation.

      if (Number.isFinite(counter) && counter > 0 && conversationId) {
        // Blocking check against Vault/Local State
        const localMax = await depsLocalCounter({ conversationId });

        // If localMax is 0 (unhydrated) or less than counter-1, we have a gap.
        if (Number.isFinite(localMax) && counter > localMax + 1) {
          const gapSize = counter - (localMax + 1);
          logger('liveMvpGapDetected', {
            conversationIdPrefix8,
            localMax,
            incomingCounter: counter,
            gapSize,
            action: 'abort_retry'
          }, LIVE_MVP_LOG_CAP);

          // [FIX] Ensure Placeholder Exists
          // GapDetectedError aborts the flow, so we must manually ensure the placeholder IS created
          // before we can update its status to 'blocked' and show it to the user.
          try {
            addPendingLivePlaceholder({
              conversationId,
              messageId: targetMessageId,
              counter: counter,
              ts: Date.now(), // Estimate
              raw: selectedItem
            });
          } catch (e) { /* Ignore if already exists */ }

          updatePendingLivePlaceholderStatus(conversationId, {
            messageId: targetMessageId,
            status: 'pending' // [FIX] Show "Decrypting..." as we have Auto-Fill
          });

          throw new GapDetectedError(
            `Gap detected (Local: ${localMax}, Incoming: ${counter}). Aborting live process to wait for history fill.`,
            { conversationId, localMax, incomingCounter: counter, gapSize }
          );
        }
      }
    } catch (err) {
      // If check fails (e.g. DB error), we must also Abort (Fail Close)
      logger('liveMvpGapCheckError', { error: err?.message }, LIVE_MVP_LOG_CAP);
      const finalResult = finalizeLiveMvpResult(result, startedAt, 'GAP_CHECK_FAILED');
      // We throw to trigger upper-level retry logic (if available) or simply fail this job.
      // Throwing here ensures we don't proceed to decrypt.
      throw err;
    }
  }

  try {
    decryptResult = await stateAccess.decryptIncomingSingle({
      conversationId,
      tokenB64,
      peerAccountDigest,
      peerDeviceId,
      item: selectedItem,
      targetMessageId,
      skipIncomingLock: !!job?.skipIncomingLock
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

  // [Shadow Advance Fix]
  // If this is a Shadow Advance (State-Only) operation, we skip persistence (Vault/Timeline).
  // The key is already in the Vault (Route A), and we just want to advance the Ratchet State.
  const shouldPersist = sourceTag !== 'hybrid-shadow-advance';

  if (shouldPersist) {
    try {
      persistResult = await stateAccess.persistAndAppendSingle({
        conversationId,
        decryptedMessage: decryptResult?.decryptedMessage || null
      });
    } catch (err) {
      persistResult = {
        vaultPutOk: 0,
        vaultPutFail: 0,
        appendOk: false,
        appendedCount: 0,
        errorMessage: err?.message || String(err)
      };
    }
  } else {
    // Skipped persistence
    persistResult = {
      vaultPutOk: 0,
      vaultPutFail: 0,
      appendOk: true, // Treat as success for flow continuity
      appendedCount: 0,
      skipped: true
    };
  }

  logger('liveMvpPersistTrace', {
    conversationIdPrefix8,
    vaultPutOk: Number(persistResult?.vaultPutOk) || 0,
    appendOk: !!persistResult?.appendOk,
    appendedCount: Number(persistResult?.appendedCount) || 0
  }, LIVE_MVP_LOG_CAP);

  console.log('[coordinator] persistResult check', {
    vaultPutOk: persistResult?.vaultPutOk,
    hasFn: typeof maybeSendVaultAckWs === 'function'
  });

  if (persistResult?.vaultPutOk > 0 && typeof maybeSendVaultAckWs === 'function') {
    console.log('[coordinator] Ack check passed', {
      vaultPutOk: persistResult.vaultPutOk,
      hasFn: true
    });
    try {
      const senderAccountDigest = peerAccountDigest; // Incoming: peer is sender
      const senderDeviceId = peerDeviceId;
      const receiverAccountDigest = typeof getAccountDigest === 'function' ? getAccountDigest() : null;
      const receiverDeviceId = typeof getDeviceId === 'function' ? getDeviceId() : null;
      const c = Number(decryptResult?.counter ?? decryptResult?.decryptedMessage?.counter);
      const counter = Number.isFinite(c) ? c : null;

      if (senderAccountDigest && receiverAccountDigest && receiverDeviceId && counter !== null) {
        try {
          console.log('[coordinator] maybeSendVaultAckWs', { conv: conversationId, mid: targetMessageId, ctr: counter });
        } catch { }
        maybeSendVaultAckWs({
          conversationId,
          messageId: targetMessageId,
          senderAccountDigest,
          senderDeviceId,
          receiverAccountDigest,
          receiverDeviceId,
          counter
        });
      }
    } catch (err) {
      logger('bRouteAckTrace', {
        ok: false,
        error: String(err)
      }, LIVE_MVP_LOG_CAP);
    }
  }

  const decryptOkCount = Number(decryptResult?.okCount) || 0;
  const decryptFailCount = Number(decryptResult?.failCount) || 0;
  const decryptSkippedCount = Number(decryptResult?.skippedCount) || 0;
  const vaultPutOkCount = Number(persistResult?.vaultPutOk) || 0;
  const vaultPutFailCount = Number(persistResult?.vaultPutFail) || 0;
  const appendedCount = Number(persistResult?.appendedCount) || 0;
  const appendOk = !!persistResult?.appendOk;
  const hasDecryptedMessage = !!decryptResult?.decryptedMessage;

  result.decrypted = (decryptResult?.okCount > 0);
  result.vaultPut = hasDecryptedMessage ? vaultPutOkCount > 0 : false;
  result.appended = hasDecryptedMessage ? appendOk : false;
  result.metrics.decryptOkCount = decryptOkCount;
  result.metrics.decryptFailCount = decryptFailCount;
  result.metrics.decryptSkippedCount = decryptSkippedCount;
  result.metrics.vaultPutOkCount = vaultPutOkCount;
  result.metrics.vaultPutFailCount = vaultPutFailCount;
  result.metrics.vaultPutFailCount = vaultPutFailCount;
  result.metrics.appendedCount = appendedCount;

  if (vaultPutOkCount > 0) {
    maybeTriggerBackupAfterDecrypt({ sourceTag: 'coordinator:live-decrypt-ok' });
  }

  // [FIX] Expose Decrypted Message to Caller
  result.decryptedMessage = decryptResult?.decryptedMessage || null;

  const decryptReasonCode = decryptResult?.reasonCode || null;
  let reasonCode = LIVE_MVP_REASONS.OK;
  if (decryptReasonCode) {
    reasonCode = decryptReasonCode;
  } else if (!result.decrypted) {
    reasonCode = LIVE_MVP_REASONS.DECRYPT_FAIL;
  } else if (hasDecryptedMessage && vaultPutOkCount === 0) {
    reasonCode = LIVE_MVP_REASONS.VAULT_PUT_FAILED;
  } else if (hasDecryptedMessage && vaultPutOkCount > 0 && !appendOk) {
    reasonCode = LIVE_MVP_REASONS.APPEND_FAILED;
  } else {
    reasonCode = LIVE_MVP_REASONS.OK;
  }

  const finalResult = finalizeLiveMvpResult(result, startedAt, reasonCode);

  logger('liveMvpSummaryTrace', {
    conversationIdPrefix8,
    sourceTag: sourceTag || null,
    tookMs: finalResult.tookMs,
    readyOk: true,
    reasonCode: finalResult.reasonCode,
    fetchedCount: finalResult.metrics.fetchedCount,
    decryptOk: finalResult.metrics.decryptOkCount,
    decryptFail: finalResult.metrics.decryptFailCount,
    decryptSkipped: finalResult.metrics.decryptSkippedCount,
    vaultPutOk: finalResult.metrics.vaultPutOkCount,
    appendedCount: finalResult.metrics.appendedCount
  }, LIVE_MVP_LOG_CAP);

  return finalResult;
}
