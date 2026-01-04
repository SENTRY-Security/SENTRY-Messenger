// Outbox queue for secure messages: per-conversation single-worker with transient retry (network/5xx only).

import { createSecureMessage } from '../../api/messages.js';
import {
  getOutboxRecord,
  listOutboxRecords,
  putOutboxRecord
} from './db.js';
import { log, logCapped, logForensicsEvent } from '../../core/log.js';
import { TRANSIENT_RETRY_MAX, TRANSIENT_RETRY_INTERVAL_MS } from './send-policy.js';

const TYPE_MESSAGE = 'message';
const TYPE_RECEIPT = 'receipt';
const TYPE_MEDIA_UPLOAD = 'media-upload';
const TYPE_MEDIA_META = 'media-meta';

const STATE_QUEUED = 'queued';
const STATE_INFLIGHT = 'inflight';
const STATE_SENT = 'sent';
const STATE_DEAD = 'dead-letter';

const COUNTER_TOO_LOW_CODE = 'CounterTooLow';

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

const nowSeconds = () => Math.floor(Date.now() / 1000);

function logOutboxJobTrace({
  job,
  stage,
  ok = null,
  statusCode = null,
  error = null,
  reasonCode = null
} = {}) {
  if (!job) return;
  logCapped('outboxJobTrace', {
    conversationId: job.conversationId || null,
    messageId: job.messageId || null,
    jobId: job.jobId || null,
    stage: stage || null,
    ok: typeof ok === 'boolean' ? ok : null,
    statusCode: Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
    error: error || null,
    reasonCode: reasonCode || null
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

function safeParseHeader(headerJson) {
  if (!headerJson) return null;
  if (typeof headerJson === 'object') return headerJson;
  try {
    return JSON.parse(headerJson);
  } catch {
    return null;
  }
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
    flushOutbox({ sourceTag: 'next_due' }).catch(() => {});
  }, Math.max(0, nextAt - now));
  logOutboxScheduleTrace({ scheduled: true, runAtMs: nextDueAtMs, reasonCode: reasonCode || 'schedule' });
}

function deferFlush(sourceTag) {
  const tag = sourceTag || 'deferred';
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(() => {
      flushOutbox({ sourceTag: tag }).catch(() => {});
    });
    return;
  }
  setTimeout(() => {
    flushOutbox({ sourceTag: tag }).catch(() => {});
  }, 0);
}

function requestFlush(sourceTag) {
  if (flushInFlight) {
    flushPending = true;
    if (sourceTag) pendingSourceTag = sourceTag;
    return;
  }
  deferFlush(sourceTag);
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
  const ts = Number.isFinite(Number(input.createdAt))
    ? Number(input.createdAt)
    : nowSeconds();
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
    counter: Number.isFinite(Number(input.counter)) ? Number(input.counter) : null,
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

export async function enqueueOutboxJob(input = {}) {
  const job = normalizeJob(input);
  await putOutboxRecord(job);
  logOutboxJobTrace({
    job,
    stage: 'ENQUEUE',
    ok: true,
    reasonCode: 'OUTBOX_ENQUEUE'
  });
  flushOutbox({ sourceTag: 'enqueue' }).catch(() => {});
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

function shouldRetryTransient({ errorCode, statusCode }) {
  if (errorCode === COUNTER_TOO_LOW_CODE) return false;
  if (Number.isFinite(statusCode)) return statusCode >= 500;
  return true;
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
    const nextAttemptAt = Number(job.nextAttemptAt);
    if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now) {
      if (!nextDueAt || nextAttemptAt < nextDueAt) nextDueAt = nextAttemptAt;
    }
    const current = pendingByConversation.get(conversationId);
    if (!current || compareJobOrder(job, current) < 0) {
      pendingByConversation.set(conversationId, job);
    }
  }
  const dueJobs = [];
  for (const job of pendingByConversation.values()) {
    if (isDue(job)) dueJobs.push(job);
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
  return computeOutboxState(all);
}

async function attemptSend(job) {
  const payload = {
    conversationId: job.conversationId,
    header: job.header || (job.headerJson ? safeParseHeader(job.headerJson) : null),
    headerJson: job.headerJson || null,
    ciphertextB64: job.ciphertextB64,
    counter: job.counter,
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
    } catch {}
  }
  const ackOk = r?.status === 202 && data && data.accepted === true && data.id;
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
  } catch {}
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
  if (next?.state === STATE_DEAD && hooks.onFailed.size) {
    for (const hook of hooks.onFailed) {
      try { await hook(next, err); } catch {}
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
      try { await hook(next, response); } catch {}
    }
  }
  return next;
}

async function processSingle(job) {
  if (!job) return false;
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
    updated = await updateJob(job.jobId, { state: STATE_INFLIGHT, lastError: null });
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

export async function flushOutbox({ sourceTag } = {}) {
  const tag = typeof sourceTag === 'string' && sourceTag.trim().length ? sourceTag.trim() : 'unknown';
  const state = await collectOutboxState();
  logOutboxFlushTriggerTrace({
    sourceTag: tag,
    queuedJobs: state.queuedJobs,
    dueJobs: state.dueJobs.length,
    nextDueAtMs: state.nextDueAtMs
  });
  scheduleNextDue(state.nextDueAtMs, 'flush_trigger');
  if (flushInFlight) {
    flushPending = true;
    pendingSourceTag = tag;
    return;
  }
  flushInFlight = true;
  try {
    if (processing) {
      flushPending = true;
      pendingSourceTag = tag;
      return;
    }
    if (state.dueJobs.length) {
      await processOutbox({ dueJobs: state.dueJobs });
    }
  } finally {
    flushInFlight = false;
    if (flushPending) {
      const followTag = pendingSourceTag || 'pending';
      flushPending = false;
      pendingSourceTag = null;
      deferFlush(followTag);
    }
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
    const jobs = Array.isArray(dueJobs) ? dueJobs : (await collectOutboxState()).dueJobs;
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
      processed += 1;
      const ok = await processSingle(job);
      if (ok) sentOk += 1;
      else sentFail += 1;
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
  if (processed > 0) requestFlush('job_complete');
}

export async function processOutboxJobNow(jobId) {
  const job = await getOutboxRecord(jobId);
  if (!job) return { ok: false, error: 'job not found' };
  let didAttempt = false;
  try {
    didAttempt = true;
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
    if (didAttempt) requestFlush('process_now');
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
  flushOutbox({ sourceTag: 'startup' }).catch(() => {});
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
