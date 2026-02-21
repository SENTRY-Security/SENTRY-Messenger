// Outbox queue for secure messages: per-conversation single-worker with transient retry (network/5xx only).

import { createSecureMessage, atomicSend } from '../../api/messages.js';
import {
  deleteOutboxRecord,
  getOutboxRecord,
  listOutboxRecords,
  putOutboxRecord
} from './db.js';
import { getAccountDigest, getMkRaw } from '../../core/store.js'; // [FIX] Import
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../../crypto/aead.js';
import { log, logCapped, logForensicsEvent } from '../../core/log.js';
import { TRANSIENT_RETRY_MAX, TRANSIENT_RETRY_INTERVAL_MS } from './send-policy.js';

const OUTBOX_DR_INFO_TAG = 'outbox-dr/v1';

const TYPE_MESSAGE = 'message';
const TYPE_RECEIPT = 'receipt';
const TYPE_MEDIA_UPLOAD = 'media-upload';
const TYPE_MEDIA_META = 'media-meta';

const STATE_QUEUED = 'queued';
const STATE_INFLIGHT = 'inflight';
const STATE_SENT = 'sent';
const STATE_DEAD = 'dead-letter';

const COUNTER_TOO_LOW_CODE = 'CounterTooLow';
const OUTBOX_WAIT_LOWER_COUNTER = 'OUTBOX_WAIT_LOWER_COUNTER';
const OUTBOX_MISSING_COUNTER = 'OUTBOX_MISSING_COUNTER';
const OUTBOX_NOT_DUE = 'OUTBOX_NOT_DUE';

const convLocks = new Set();
const hooks = {
  onSent: new Set(),
  onFailed: new Set()
};

let nextDueTimer = null;
let nextDueAtMs = null;
let flushInFlight = false;
let flushPending = false;
let pendingSourceTag = null;
let processing = false;
let debug = false;

const nowMs = () => Date.now();

function logOutboxJobTrace({
  job,
  stage,
  ok = null,
  statusCode = null,
  error = null,
  reasonCode = null
} = {}) {
  if (!job) return;
  const conversationId = job.conversationId || null;
  const counter = getJobCounter(job);
  logCapped('outboxJobTrace', {
    conversationId,
    conversationIdPrefix8: conversationId ? String(conversationId).slice(0, 8) : null,
    messageId: job.messageId || null,
    jobId: job.jobId || null,
    counter: Number.isFinite(counter) ? counter : null,
    stage: stage || null,
    ok: typeof ok === 'boolean' ? ok : null,
    statusCode: Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
    error: error || null,
    reasonCode: reasonCode || null,
    hasVault: !!job.vault,
    hasBackup: !!job.backup
  }, 5);
}

function logOutboxFlushTriggerTrace({ sourceTag, queuedJobs, dueJobs, nextDueAtMs } = {}) {
  logCapped('outboxFlushTriggerTrace', {
    sourceTag: sourceTag || null,
    queuedJobs: Number.isFinite(Number(queuedJobs)) ? Number(queuedJobs) : 0,
    dueJobs: Number.isFinite(Number(dueJobs)) ? Number(dueJobs) : 0,
    nextDueAtMs: Number.isFinite(Number(nextDueAtMs)) ? Number(nextDueAtMs) : null
  }, 5);
}

function logOutboxScheduleTrace({ scheduled, runAtMs, reasonCode } = {}) {
  logCapped('outboxScheduleTrace', {
    scheduled: !!scheduled,
    runAtMs: Number.isFinite(Number(runAtMs)) ? Number(runAtMs) : null,
    reasonCode: reasonCode || null
  }, 5);
}

function logOutboxProcessSummary({ processed, sentOk, sentFail, skippedLocked, remainingDue } = {}) {
  logCapped('outboxProcessSummary', {
    processed: Number.isFinite(Number(processed)) ? Number(processed) : 0,
    sentOk: Number.isFinite(Number(sentOk)) ? Number(sentOk) : 0,
    sentFail: Number.isFinite(Number(sentFail)) ? Number(sentFail) : 0,
    skippedLocked: Number.isFinite(Number(skippedLocked)) ? Number(skippedLocked) : 0,
    remainingDue: Number.isFinite(Number(remainingDue)) ? Number(remainingDue) : 0
  }, 5);
}

function isReceiptJob(job = {}) {
  if (!job) return false;
  if (job.type === TYPE_RECEIPT) return true;
  const jobId = typeof job.jobId === 'string' ? job.jobId : '';
  return jobId.startsWith('receipt:') || jobId.startsWith(`${TYPE_RECEIPT}:`);
}

function safeParseHeader(headerJson) {
  if (!headerJson) return null;
  if (typeof headerJson === 'object') return headerJson;
  try {
    return JSON.parse(headerJson);
  } catch {
    return null;
  }
}

function normalizeCounter(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getJobCounter(job = {}) {
  const direct = normalizeCounter(job?.counter);
  if (direct != null) return direct;
  const header = job?.header || (job?.headerJson ? safeParseHeader(job.headerJson) : null);
  const headerCounter = normalizeCounter(header?.counter);
  return headerCounter;
}

function requiresCounter(job = {}) {
  if (!job) return false;
  if (isReceiptJob(job)) return false;
  if (job.type === TYPE_MEDIA_UPLOAD) return false;
  return true;
}

function scheduleNextDue(runAtMs, reasonCode) {
  const nextAt = Number.isFinite(Number(runAtMs)) ? Number(runAtMs) : null;
  const now = Date.now();
  if (!nextAt || nextAt <= now) {
    if (nextDueTimer) {
      clearTimeout(nextDueTimer);
      nextDueTimer = null;
      nextDueAtMs = null;
      logOutboxScheduleTrace({ scheduled: false, runAtMs: null, reasonCode: reasonCode || 'clear' });
    }
    return;
  }
  if (nextDueAtMs === nextAt && nextDueTimer) return;
  if (nextDueTimer) clearTimeout(nextDueTimer);
  nextDueAtMs = nextAt;
  nextDueTimer = setTimeout(() => {
    nextDueTimer = null;
    nextDueAtMs = null;
    flushOutbox({ sourceTag: 'next_due' }).catch(() => { });
  }, Math.max(0, nextAt - now));
  logOutboxScheduleTrace({ scheduled: true, runAtMs: nextDueAtMs, reasonCode: reasonCode || 'schedule' });
}

function normalizeJob(input = {}) {
  const messageId = typeof input.messageId === 'string' && input.messageId.trim().length
    ? input.messageId.trim()
    : null;
  if (!messageId) throw new Error('messageId required for outbox job');
  const conversationId = typeof input.conversationId === 'string' ? input.conversationId : null;
  const jobType = [TYPE_RECEIPT, TYPE_MEDIA_UPLOAD, TYPE_MEDIA_META].includes(input.type)
    ? input.type
    : TYPE_MESSAGE;
  if (!conversationId) throw new Error('conversationId required');
  if (jobType !== TYPE_MEDIA_UPLOAD) {
    if (!input.ciphertextB64) throw new Error('ciphertextB64 required');
    if (!input.headerJson && !input.header) throw new Error('headerJson/header required');
  }
  const headerObj = input.header || (input.headerJson ? safeParseHeader(input.headerJson) : null);
  const counter = Number.isFinite(Number(input.counter))
    ? Number(input.counter)
    : normalizeCounter(headerObj?.counter);
  const ts = Number.isFinite(Number(input.createdAt))
    ? Number(input.createdAt)
    : nowMs();
  const jobId = typeof input.jobId === 'string' && input.jobId.length
    ? input.jobId
    : `${jobType}:${conversationId}:${messageId}`;
  return {
    jobId,
    type: jobType,
    messageId,
    conversationId,
    // New Signal payload fields
    headerJson: input.headerJson || null,
    header: input.header || null,
    ciphertextB64: input.ciphertextB64 || null,
    counter,
    senderDeviceId: input.senderDeviceId || null,
    receiverAccountDigest: input.receiverAccountDigest || null,
    receiverDeviceId: input.receiverDeviceId || null,
    peerAccountDigest: input.peerAccountDigest || null,
    peerDeviceId: input.peerDeviceId || null,
    // Legacy fields kept for compatibility (media-upload no-op)
    payloadEnvelope: input.payloadEnvelope || null,
    createdAt: ts,
    retryCount: 0,
    nextAttemptAt: null,
    state: input.state || STATE_QUEUED,
    lastError: input.lastError || null,
    meta: input.meta || null,
    dr: input.dr || null,
    // Atomic Send Fields
    vault: input.vault || null,
    backup: input.backup || null,
    updatedAt: Date.now()
  };
}

export function setOutboxHooks(opts = {}) {
  if (typeof opts.onSent === 'function') hooks.onSent.add(opts.onSent);
  if (typeof opts.onFailed === 'function') hooks.onFailed.add(opts.onFailed);
}

export function setOutboxDebug(flag = true) {
  debug = !!flag;
}

/**
 * [SECURITY FIX HIGH-07] Encrypt DR snapshot payload before IndexedDB storage.
 * DR snapshots contain private keys (myRatchetPriv, rk, ckS, ckR) that must
 * never be stored as plaintext in IndexedDB.
 */
async function sealDrField(dr) {
  if (!dr) return null;
  const mk = getMkRaw();
  if (!mk) return null; // No MK → don't store plaintext; drop the field
  try {
    return await wrapWithMK_JSON(dr, mk, OUTBOX_DR_INFO_TAG);
  } catch {
    return null; // Encryption failed → drop rather than leak plaintext
  }
}

/**
 * [SECURITY FIX HIGH-07] Decrypt DR snapshot payload read from IndexedDB.
 * Handles backward compatibility: if the field is already a plain object
 * (pre-migration jobs), returns it as-is.
 */
export async function unsealOutboxDr(sealedDr) {
  if (!sealedDr) return null;
  // Backward compat: plain (unencrypted) DR objects have snapshotBefore/After
  if (sealedDr.snapshotBefore !== undefined || sealedDr.snapshotAfter !== undefined) return sealedDr;
  // Encrypted envelope
  if (sealedDr.aead !== 'aes-256-gcm') return null;
  const mk = getMkRaw();
  if (!mk) return null;
  try {
    return await unwrapWithMK_JSON(sealedDr, mk);
  } catch {
    return null;
  }
}

export async function enqueueOutboxJob(input = {}) {
  if (isReceiptJob(input)) {
    const jobId = typeof input?.jobId === 'string' ? input.jobId : null;
    if (jobId) {
      try { await deleteOutboxRecord(jobId); } catch { }
    }
    logCapped('outboxReceiptBlockedTrace', {
      conversationId: input?.conversationId || null,
      messageId: input?.messageId || null,
      jobId: input?.jobId || null,
      reasonCode: 'RECEIPT_BLOCKED'
    }, 5);
    return { ok: false, skipped: true, error: 'receipt outbox disabled' };
  }
  const job = normalizeJob(input);
  // [SECURITY FIX HIGH-07] Encrypt DR snapshots before writing to IndexedDB
  if (job.dr) {
    job.dr = await sealDrField(job.dr);
  }
  await putOutboxRecord(job);
  logOutboxJobTrace({
    job,
    stage: 'ENQUEUE',
    ok: true,
    reasonCode: 'OUTBOX_ENQUEUE'
  });
  flushOutbox({ sourceTag: 'enqueue' }).catch(() => { });
  return job;
}

async function updateJob(jobId, patch = {}) {
  const current = await getOutboxRecord(jobId);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await putOutboxRecord(next);
  return next;
}

function isDue(job) {
  if (!job) return false;
  const isReadyState = job.state === STATE_QUEUED || !job.state;
  if (!isReadyState) return false;
  const nextAttemptAt = Number(job.nextAttemptAt);
  if (Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now()) return false;
  return true;
}

function compareJobOrder(a, b) {
  const aCreated = Number(a?.createdAt) || 0;
  const bCreated = Number(b?.createdAt) || 0;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return String(a?.jobId || '').localeCompare(String(b?.jobId || ''));
}

function compareCounterOrder(a, b) {
  const aCounter = getJobCounter(a);
  const bCounter = getJobCounter(b);
  if (Number.isFinite(aCounter) && Number.isFinite(bCounter) && aCounter !== bCounter) return aCounter - bCounter;
  if (Number.isFinite(aCounter) && !Number.isFinite(bCounter)) return -1;
  if (!Number.isFinite(aCounter) && Number.isFinite(bCounter)) return 1;
  return compareJobOrder(a, b);
}

async function hardFailMissingCounter(job, {
  reasonCode = OUTBOX_MISSING_COUNTER,
  error = 'missing counter',
  stage = 'PROCESS_SINGLE'
} = {}) {
  if (!job?.jobId) return null;
  if (job?.state === STATE_DEAD || job?.state === STATE_SENT) return job;
  const next = await updateJob(job.jobId, {
    state: STATE_DEAD,
    retryCount: 0,
    nextAttemptAt: null,
    lastError: error,
    lastErrorCode: reasonCode,
    lastStatus: null
  });
  logOutboxJobTrace({
    job: next || job,
    stage,
    ok: false,
    error,
    reasonCode
  });
  return next || job;
}

async function sanitizeOutboxRecords(all = []) {
  if (!Array.isArray(all) || !all.length) return Array.isArray(all) ? all : [];
  const sanitized = [];
  for (const job of all) {
    if (!job || job.state === STATE_SENT || job.state === STATE_DEAD) {
      sanitized.push(job);
      continue;
    }
    if (!requiresCounter(job)) {
      sanitized.push(job);
      continue;
    }
    const counter = getJobCounter(job);
    if (!Number.isFinite(counter)) {
      await hardFailMissingCounter(job);
      continue;
    }
    if (!Number.isFinite(Number(job.counter))) {
      const next = await updateJob(job.jobId, { counter });
      sanitized.push(next || { ...job, counter });
      continue;
    }
    sanitized.push(job);
  }
  return sanitized;
}


function shouldRetryTransient({ errorCode, statusCode }) {
  // [FIX] Enabled transient retry on network errors or 5xx.
  // User requested explicit handling for "Network Interruption".
  if (!statusCode || statusCode === 0) return true; // Fetch failure (network)
  if (statusCode >= 500 && statusCode < 600) return true; // Server error
  if (errorCode === 'fetch_failed' || errorCode === 'network_error') return true;
  return false;
}

function computeOutboxState(all = []) {
  const pendingByConversation = new Map();
  let queuedJobs = 0;
  let nextDueAt = null;
  const now = Date.now();
  for (const job of all) {
    if (!job || job.state === STATE_SENT || job.state === STATE_DEAD) continue;
    const conversationId = job?.conversationId || null;
    if (!conversationId) continue;
    const isReadyState = job.state === STATE_QUEUED || !job.state;
    if (isReadyState) queuedJobs += 1;
    const list = pendingByConversation.get(conversationId) || [];
    list.push(job);
    pendingByConversation.set(conversationId, list);
  }
  const dueJobs = [];
  for (const jobs of pendingByConversation.values()) {
    const counterJobs = jobs.filter((job) => requiresCounter(job));
    let selected = null;
    if (counterJobs.length) {
      counterJobs.sort(compareCounterOrder);
      selected = counterJobs[0];
      logOutboxJobTrace({
        job: selected,
        stage: 'SELECT_NEXT',
        ok: null,
        reasonCode: 'OUTBOX_SELECT_MIN_COUNTER'
      });
      for (const skipped of counterJobs.slice(1)) {
        logOutboxJobTrace({
          job: skipped,
          stage: 'SKIP_HIGHER_COUNTER',
          ok: false,
          reasonCode: OUTBOX_WAIT_LOWER_COUNTER
        });
      }
    } else {
      const ordered = jobs.slice().sort(compareJobOrder);
      selected = ordered[0] || null;
      if (selected) {
        logOutboxJobTrace({
          job: selected,
          stage: 'SELECT_NEXT',
          ok: null,
          reasonCode: 'OUTBOX_SELECT_FALLBACK'
        });
      }
    }
    if (!selected) continue;
    if (isDue(selected)) {
      dueJobs.push(selected);
    } else {
      logOutboxJobTrace({
        job: selected,
        stage: 'NOT_DUE',
        ok: false,
        reasonCode: OUTBOX_NOT_DUE
      });
      const nextAttemptAt = Number(selected.nextAttemptAt);
      if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now) {
        if (!nextDueAt || nextAttemptAt < nextDueAt) nextDueAt = nextAttemptAt;
      }
    }
  }
  dueJobs.sort((a, b) => {
    const aTs = Number(a?.nextAttemptAt) || 0;
    const bTs = Number(b?.nextAttemptAt) || 0;
    if (aTs !== bTs) return aTs - bTs;
    return compareJobOrder(a, b);
  });
  return { dueJobs, queuedJobs, nextDueAtMs: nextDueAt };
}

async function collectOutboxState() {
  const all = await listOutboxRecords();
  const sanitized = await sanitizeOutboxRecords(all);
  return computeOutboxState(sanitized);
}

async function attemptSend(job) {
  // If job has 'vault' or 'backup' payload, use Atomic Send API
  if (job.vault) {
    const payload = {
      conversationId: job.conversationId,
      senderDeviceId: job.senderDeviceId,
      message: {
        id: job.messageId,
        conversation_id: job.conversationId,
        sender_account_digest: getAccountDigest(), // [FIX] Required by Worker
        sender_device_id: job.senderDeviceId,
        receiver_account_digest: job.receiverAccountDigest,
        receiver_device_id: job.receiverDeviceId,
        header_json: job.headerJson || (job.header ? JSON.stringify(job.header) : null),
        ciphertext_b64: job.ciphertextB64,
        counter: getJobCounter(job),
        created_at: job.createdAt
      },
      vault: job.vault,
      backup: job.backup || null
    };

    const { r, data } = await atomicSend(payload);

    if (r?.status === 409 && typeof data === 'object' && data?.error === 'CounterTooLow') {
      const meta = job.header?.meta || {};
      try {
        log({
          outboxCounterTooLow: {
            conversationId: job?.conversationId || null,
            counterSent: job?.counter ?? null,
            maxCounterFromServer: data?.maxCounter ?? null,
            senderDeviceId: job?.senderDeviceId || null,
            senderAccountDigest: meta?.senderDigest || meta?.sender_digest || null
          }
        });
      } catch { }
    }

    const ackOk = (r?.status >= 200 && r?.status < 300) && data && data.ok === true;
    const failureMessage = ackOk
      ? null
      : (typeof data?.message === 'string' ? data.message
        : typeof data?.error === 'string' ? data.error
          : `atomic send failed (status=${r?.status || 'unknown'})`);

    logOutboxJobTrace({
      job,
      stage: ackOk ? 'ATOMIC_ACK_OK' : 'ATOMIC_ACK_FAIL',
      ok: ackOk,
      statusCode: r?.status || null,
      error: failureMessage,
      reasonCode: ackOk ? 'OUTBOX_ATOMIC_OK' : 'OUTBOX_ATOMIC_FAIL'
    });

    if (!ackOk) {
      const err = new Error(failureMessage);
      err.status = r?.status;
      err.details = data || null;
      if (typeof data?.error === 'string') err.code = data.error;
      throw err;
    }
    try {
      logForensicsEvent('SEND_ACK_ATOMIC', {
        conversationId: job?.conversationId || null,
        messageId: job?.messageId || null,
        serverMessageId: data?.id || null,
        status: r?.status || null
      });
    } catch { }
    return { r, data };
  }

  const resolvedCounter = getJobCounter(job);
  const payload = {
    conversationId: job.conversationId,
    header: job.header || (job.headerJson ? safeParseHeader(job.headerJson) : null),
    headerJson: job.headerJson || null,
    ciphertextB64: job.ciphertextB64,
    counter: resolvedCounter,
    senderDeviceId: job.senderDeviceId,
    receiverAccountDigest: job.receiverAccountDigest,
    receiverDeviceId: job.receiverDeviceId,
    id: job.messageId,
    createdAt: job.createdAt
  };
  const { r, data } = await createSecureMessage(payload);
  if (r?.status === 409 && typeof data === 'object' && data?.error === 'CounterTooLow') {
    const meta = payload?.header?.meta || {};
    try {
      log({
        outboxCounterTooLow: {
          conversationId: job?.conversationId || null,
          counterSent: job?.counter ?? null,
          maxCounterFromServer: data?.maxCounter ?? null,
          senderDeviceId: job?.senderDeviceId || null,
          senderAccountDigest: meta?.senderDigest || meta?.sender_digest || null
        }
      });
    } catch { }
  }
  const ackOk = (r?.status >= 200 && r?.status < 300) && data && data.accepted === true && data.id;
  const failureMessage = ackOk
    ? null
    : (typeof data?.message === 'string' ? data.message
      : typeof data?.error === 'string' ? data.error
        : `ack failed (status=${r?.status || 'unknown'})`);
  logOutboxJobTrace({
    job,
    stage: ackOk ? 'ACK_OK' : 'ACK_FAIL',
    ok: ackOk,
    statusCode: r?.status || null,
    error: failureMessage,
    reasonCode: ackOk ? 'OUTBOX_ACK_OK' : 'OUTBOX_ACK_FAIL'
  });
  if (!ackOk) {
    const err = new Error(failureMessage);
    err.status = r?.status;
    err.details = data || null;
    if (typeof data?.error === 'string') err.code = data.error;
    throw err;
  }
  try {
    logForensicsEvent('SEND_ACK', {
      conversationId: job?.conversationId || null,
      messageId: job?.messageId || null,
      serverMessageId: data?.id || data?.serverMessageId || data?.server_message_id || null,
      status: r?.status || null
    });
  } catch { }
  return { r, data };
}

async function markFailure(job, err) {
  const errorMessage = err?.message || err || 'send failed';
  const errorCodeRaw = err?.code || err?.errorCode || err?.details?.error || err?.details?.code || null;
  const errorCode = errorCodeRaw ? String(errorCodeRaw) : null;
  const statusCode = Number.isFinite(err?.status) ? Number(err.status) : null;
  if (job?.type === TYPE_MESSAGE && shouldRetryTransient({ errorCode, statusCode })) {
    const retryCount = Number(job.retryCount) || 0;
    if (retryCount < TRANSIENT_RETRY_MAX) {
      const nextAttemptAt = Date.now() + TRANSIENT_RETRY_INTERVAL_MS;
      const next = await updateJob(job.jobId, {
        state: STATE_QUEUED,
        retryCount: retryCount + 1,
        nextAttemptAt,
        lastError: errorMessage,
        lastErrorCode: errorCode,
        lastStatus: statusCode
      });
      logOutboxJobTrace({
        job: next || job,
        stage: 'RETRY_SCHEDULED',
        ok: false,
        statusCode,
        error: errorMessage,
        reasonCode: 'TRANSIENT_RETRY'
      });
      return;
    }
  }
  const next = await updateJob(job.jobId, {
    state: STATE_DEAD,
    retryCount: 0,
    nextAttemptAt: null,
    lastError: errorMessage,
    lastErrorCode: errorCode,
    lastStatus: statusCode
  });

  if (debug) {
    console.warn('[outbox]', { event: 'failed', jobId: job?.jobId, conv: job?.conversationId, status: next?.lastStatus || null, error: errorMessage });
  }

  // [FIX] Fatal Modal Trigger
  // If we exhausted retries (implied here because we are in the DEAD block),
  // and it was a transient-capable error (network/5xx), trigger the fatal UI.
  if (shouldRetryTransient({ errorCode, statusCode })) {
    try {
      // Dispatch global event for UI (app.js / layout handler)
      const event = new CustomEvent('sentry:outbox-fatal', {
        detail: { error: errorMessage }
      });
      window.dispatchEvent(event);
    } catch (e) { console.error('Failed to dispatch fatal event', e); }
  }
  if (next?.state === STATE_DEAD && hooks.onFailed.size) {
    for (const hook of hooks.onFailed) {
      try { await hook(next, err); } catch { }
    }
  }
}

async function markSent(job, response) {
  const next = await updateJob(job.jobId, {
    state: STATE_SENT,
    nextAttemptAt: null,
    lastError: null,
    retryCount: Number(job.retryCount) || 0,
    sentAt: Date.now(),
    lastResponse: response?.data || null,
    lastStatus: response?.r?.status || null
  });
  if (debug) {
    console.log('[outbox]', { event: 'sent', jobId: job?.jobId, conv: job?.conversationId, status: response?.r?.status || null });
  }
  if (hooks.onSent.size) {
    for (const hook of hooks.onSent) {
      try { await hook(next, response); } catch { }
    }
  }
  return next;
}

async function processSingle(job) {
  if (!job) return false;
  if (isReceiptJob(job)) {
    logOutboxJobTrace({
      job,
      stage: 'RECEIPT_BLOCKED',
      ok: false,
      error: 'receipt outbox disabled',
      reasonCode: 'RECEIPT_BLOCKED'
    });
    log({ outboxReceiptBlocked: { conversationId: job?.conversationId || null, messageId: job?.messageId || null, jobId: job?.jobId || null } });
    try { await deleteOutboxRecord(job.jobId); } catch { }
    return false;
  }
  if (requiresCounter(job) && !Number.isFinite(getJobCounter(job))) {
    await hardFailMissingCounter(job);
    return false;
  }
  if (convLocks.has(job.conversationId)) {
    logOutboxJobTrace({
      job,
      stage: 'INFLIGHT_SKIP',
      ok: false,
      error: 'conversation_locked',
      reasonCode: 'OUTBOX_INFLIGHT_SKIP'
    });
    return false;
  }
  convLocks.add(job.conversationId);
  let updated = null;
  try {
    const counter = getJobCounter(job);
    const patch = { state: STATE_INFLIGHT, lastError: null };
    if (requiresCounter(job) && Number.isFinite(counter) && !Number.isFinite(Number(job?.counter))) {
      patch.counter = counter;
    }
    updated = await updateJob(job.jobId, patch);
    logOutboxJobTrace({
      job: updated || job,
      stage: 'PROCESS_SINGLE',
      ok: null,
      reasonCode: 'OUTBOX_PROCESS_SINGLE'
    });
    if (job.type === TYPE_MEDIA_UPLOAD) {
      await markSent(updated || job, { r: { status: 200 }, data: { ok: true, skipped: 'media-upload' } });
      return true;
    }
    const { r, data } = await attemptSend(updated || job);
    if (!r?.ok) {
      const error = new Error(typeof data === 'string' ? data : (data?.message || `send failed: ${r?.status}`));
      error.status = r?.status;
      throw error;
    }
    await markSent(updated || job, { r, data });
    return true;
  } catch (err) {
    await markFailure(updated || job, err);
    return false;
  } finally {
    convLocks.delete(job.conversationId);
  }
}

async function getConversationHeadJob(conversationId) {
  if (!conversationId) return { head: null, mode: 'empty' };
  const all = await listOutboxRecords();
  const counterJobs = [];
  const fallbackJobs = [];
  for (const job of all) {
    if (!job || job.state === STATE_SENT || job.state === STATE_DEAD) continue;
    if (job.conversationId !== conversationId) continue;
    if (!requiresCounter(job)) {
      fallbackJobs.push(job);
      continue;
    }
    const counter = getJobCounter(job);
    if (!Number.isFinite(counter)) {
      await hardFailMissingCounter(job);
      continue;
    }
    if (!Number.isFinite(Number(job.counter))) {
      const next = await updateJob(job.jobId, { counter });
      counterJobs.push(next || { ...job, counter });
      continue;
    }
    counterJobs.push(job);
  }
  if (counterJobs.length) {
    let head = counterJobs[0];
    for (const job of counterJobs.slice(1)) {
      if (compareCounterOrder(job, head) < 0) head = job;
    }
    return { head, mode: 'counter' };
  }
  if (fallbackJobs.length) {
    fallbackJobs.sort(compareJobOrder);
    return { head: fallbackJobs[0], mode: 'fallback' };
  }
  return { head: null, mode: 'empty' };
}

async function canProcessJob(job) {
  if (!job) {
    return {
      ok: false,
      reasonCode: 'OUTBOX_JOB_MISSING',
      stage: 'PROCESS_SINGLE',
      error: 'job missing',
      skipLog: true
    };
  }
  if (requiresCounter(job) && !Number.isFinite(getJobCounter(job))) {
    await hardFailMissingCounter(job);
    return {
      ok: false,
      reasonCode: OUTBOX_MISSING_COUNTER,
      stage: 'PROCESS_SINGLE',
      error: 'missing counter',
      skipLog: true
    };
  }
  const headInfo = await getConversationHeadJob(job.conversationId);
  if (headInfo?.head && headInfo.head.jobId !== job.jobId) {
    return {
      ok: false,
      reasonCode: OUTBOX_WAIT_LOWER_COUNTER,
      stage: 'SKIP_HIGHER_COUNTER',
      error: 'waiting for lower counter',
      headJobId: headInfo.head.jobId
    };
  }
  if (!isDue(job)) {
    return {
      ok: false,
      reasonCode: OUTBOX_NOT_DUE,
      stage: 'NOT_DUE',
      error: 'job not due'
    };
  }
  return { ok: true };
}

export async function flushOutbox({ sourceTag } = {}) {
  const tag = typeof sourceTag === 'string' && sourceTag.trim().length ? sourceTag.trim() : 'unknown';
  if (flushInFlight || processing) {
    flushPending = true;
    pendingSourceTag = tag;
    return;
  }
  flushInFlight = true;
  let handledPending = false;
  let followTag = null;
  try {
    while (true) {
      const state = await collectOutboxState();
      const cycleTag = handledPending ? (followTag || 'pending') : tag;
      logOutboxFlushTriggerTrace({
        sourceTag: cycleTag,
        queuedJobs: state.queuedJobs,
        dueJobs: state.dueJobs.length,
        nextDueAtMs: state.nextDueAtMs
      });
      scheduleNextDue(state.nextDueAtMs, handledPending ? 'flush_pending' : 'flush_trigger');
      if (state.dueJobs.length) {
        await processOutbox({ dueJobs: state.dueJobs });
      }
      if (flushPending && !handledPending) {
        flushPending = false;
        handledPending = true;
        followTag = pendingSourceTag || 'pending';
        pendingSourceTag = null;
        continue;
      }
      break;
    }
  } finally {
    flushInFlight = false;
    flushPending = false;
    pendingSourceTag = null;
  }
}

export async function processOutbox({ dueJobs } = {}) {
  if (processing) return;
  processing = true;
  let processed = 0;
  let sentOk = 0;
  let sentFail = 0;
  let skippedLocked = 0;
  try {
    let jobs = Array.isArray(dueJobs) ? dueJobs : null;
    while (true) {
      if (!jobs) {
        const state = await collectOutboxState();
        jobs = state.dueJobs;
      }
      if (!jobs.length) break;
      let progressed = false;
      for (const job of jobs) {
        // skip if another job of same conversation is inflight
        if (convLocks.has(job.conversationId)) {
          skippedLocked += 1;
          logOutboxJobTrace({
            job,
            stage: 'INFLIGHT_SKIP',
            ok: false,
            error: 'conversation_locked',
            reasonCode: 'OUTBOX_INFLIGHT_SKIP'
          });
          continue;
        }
        const gate = await canProcessJob(job);
        if (!gate.ok) {
          if (!gate.skipLog) {
            logOutboxJobTrace({
              job,
              stage: gate.stage,
              ok: false,
              error: gate.error || null,
              reasonCode: gate.reasonCode
            });
          }
          continue;
        }
        processed += 1;
        progressed = true;
        const ok = await processSingle(job);
        if (ok) sentOk += 1;
        else sentFail += 1;
      }
      if (!progressed) break;
      jobs = null;
    }
  } finally {
    processing = false;
  }
  const postState = await collectOutboxState();
  logOutboxProcessSummary({
    processed,
    sentOk,
    sentFail,
    skippedLocked,
    remainingDue: postState.dueJobs.length
  });
  scheduleNextDue(postState.nextDueAtMs, 'post_process');
}

export async function processOutboxJobNow(jobId) {
  const job = await getOutboxRecord(jobId);
  if (!job) return { ok: false, error: 'job not found' };
  const gate = await canProcessJob(job);
  if (!gate.ok) {
    const latest = await getOutboxRecord(jobId);
    if (!gate.skipLog) {
      logOutboxJobTrace({
        job: latest || job,
        stage: gate.stage,
        ok: false,
        error: gate.error || null,
        reasonCode: gate.reasonCode
      });
    }
    try {
      const postState = await collectOutboxState();
      scheduleNextDue(postState.nextDueAtMs, 'process_now');
    } catch { }
    return {
      ok: false,
      job: latest || job,
      error: gate.error || 'send blocked',
      errorCode: gate.reasonCode,
      reasonCode: gate.reasonCode
    };
  }
  try {
    await processSingle(job);
    const latest = await getOutboxRecord(jobId);
    const ok = latest?.state === STATE_SENT;
    logOutboxJobTrace({
      job: latest || job,
      stage: 'PROCESS_SINGLE',
      ok,
      statusCode: latest?.lastStatus ?? null,
      error: latest?.lastError || null,
      reasonCode: 'OUTBOX_PROCESS_NOW'
    });
    return {
      ok,
      job: latest,
      data: latest?.lastResponse || null,
      status: latest?.lastStatus || null,
      error: latest?.lastError || null,
      errorCode: latest?.lastErrorCode || null
    };
  } catch (err) {
    logOutboxJobTrace({
      job,
      stage: 'PROCESS_SINGLE',
      ok: false,
      statusCode: err?.status ?? null,
      error: err?.message || String(err),
      reasonCode: 'OUTBOX_PROCESS_NOW_ERROR'
    });
    return { ok: false, error: err?.message || String(err), status: Number.isFinite(err?.status) ? Number(err.status) : null };
  } finally {
    try {
      const postState = await collectOutboxState();
      scheduleNextDue(postState.nextDueAtMs, 'process_now');
    } catch { }
  }
}

export async function retryOutboxMessage({ conversationId, messageId } = {}) {
  const convId = typeof conversationId === 'string' ? conversationId.trim() : '';
  const msgId = typeof messageId === 'string' ? messageId.trim() : '';
  if (!convId || !msgId) {
    return { ok: false, error: 'conversationId and messageId required', errorCode: 'MissingParams' };
  }
  const jobId = `${TYPE_MESSAGE}:${convId}:${msgId}`;
  const existing = await getOutboxRecord(jobId);
  if (!existing || existing.type !== TYPE_MESSAGE) {
    return { ok: false, error: 'job not found', errorCode: 'OutboxJobMissing' };
  }
  if (existing.lastErrorCode === COUNTER_TOO_LOW_CODE) {
    return { ok: false, error: 'CounterTooLow requires replacement send', errorCode: 'COUNTER_TOO_LOW_REPLACED' };
  }
  if (existing.state === STATE_SENT) {
    return {
      ok: true,
      jobId,
      job: existing,
      alreadySent: true,
      status: existing?.lastStatus || 202,
      data: existing?.lastResponse || { accepted: true, id: msgId }
    };
  }
  if (existing.state === STATE_INFLIGHT) {
    return {
      ok: false,
      jobId,
      job: existing,
      error: 'send in progress',
      errorCode: 'OutboxInflight'
    };
  }
  if (convLocks.has(existing.conversationId)) {
    return {
      ok: false,
      jobId,
      job: existing,
      error: 'send in progress',
      errorCode: 'OutboxInflight'
    };
  }
  const result = await processOutboxJobNow(jobId);
  return { ...result, jobId, job: existing };
}

export function startOutboxProcessor() {
  flushOutbox({ sourceTag: 'startup' }).catch(() => { });
}

export function isConversationLocked(conversationId) {
  if (!conversationId) return false;
  return convLocks.has(conversationId);
}

export function snapshotOutboxState() {
  return listOutboxRecords();
}

export async function getOutboxStats() {
  const all = await listOutboxRecords();
  const summary = {
    total: all.length,
    byState: {},
    byConversation: {}
  };
  for (const job of all) {
    const state = job?.state || 'unknown';
    summary.byState[state] = (summary.byState[state] || 0) + 1;
    const conv = job?.conversationId || 'unknown';
    summary.byConversation[conv] = summary.byConversation[conv] || { total: 0 };
    summary.byConversation[conv].total += 1;
  }
  return summary;
}
