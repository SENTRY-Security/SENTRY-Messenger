// Outbox queue for secure messages: per-conversation single-worker, single-shot (no retry/backoff).

import { createSecureMessage } from '../../api/messages.js';
import {
  getOutboxRecord,
  listOutboxRecords,
  putOutboxRecord
} from './db.js';
import { log, logCapped, logForensicsEvent } from '../../core/log.js';

const TYPE_MESSAGE = 'message';
const TYPE_RECEIPT = 'receipt';
const TYPE_MEDIA_UPLOAD = 'media-upload';
const TYPE_MEDIA_META = 'media-meta';

const STATE_QUEUED = 'queued';
const STATE_INFLIGHT = 'inflight';
const STATE_SENT = 'sent';
const STATE_DEAD = 'dead-letter';

const PROCESS_INTERVAL_MS = 4_000;

const convLocks = new Set();
const hooks = {
  onSent: new Set(),
  onFailed: new Set()
};

let processorTimer = null;
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

function safeParseHeader(headerJson) {
  if (!headerJson) return null;
  if (typeof headerJson === 'object') return headerJson;
  try {
    return JSON.parse(headerJson);
  } catch {
    return null;
  }
}

function scheduleProcessor(delay = PROCESS_INTERVAL_MS) {
  if (processorTimer) clearTimeout(processorTimer);
  processorTimer = setTimeout(processOutbox, delay);
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
  scheduleProcessor(50);
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
  return isReadyState;
}

async function fetchDueJobs() {
  const all = await listOutboxRecords();
  const filtered = all.filter((job) => job && isDue(job));
  filtered.sort((a, b) => {
    const aTs = Number(a.nextAttemptAt) || 0;
    const bTs = Number(b.nextAttemptAt) || 0;
    if (aTs !== bTs) return aTs - bTs;
    return (a.jobId || '').localeCompare(b.jobId || '');
  });
  return filtered;
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
  const next = await updateJob(job.jobId, {
    state: STATE_DEAD,
    retryCount: 0,
    nextAttemptAt: null,
    lastError: err?.message || err || 'send failed',
    lastStatus: Number.isFinite(err?.status) ? Number(err.status) : null
  });
  if (debug) {
    console.warn('[outbox]', { event: 'failed', jobId: job?.jobId, conv: job?.conversationId, status: next?.lastStatus || null, error: err?.message || err });
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

export async function processOutbox() {
  if (processing) return;
  processing = true;
  try {
    const dueJobs = await fetchDueJobs();
    for (const job of dueJobs) {
      // skip if another job of same conversation is inflight
      if (convLocks.has(job.conversationId)) {
        logOutboxJobTrace({
          job,
          stage: 'INFLIGHT_SKIP',
          ok: false,
          error: 'conversation_locked',
          reasonCode: 'OUTBOX_INFLIGHT_SKIP'
        });
        continue;
      }
      await processSingle(job);
    }
  } finally {
    processing = false;
    scheduleProcessor();
  }
}

export async function processOutboxJobNow(jobId) {
  const job = await getOutboxRecord(jobId);
  if (!job) return { ok: false, error: 'job not found' };
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
    return { ok, job: latest, data: latest?.lastResponse || null, status: latest?.lastStatus || null, error: latest?.lastError || null };
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
  const result = await processOutboxJobNow(jobId);
  return { ...result, jobId, job: existing };
}

export function startOutboxProcessor() {
  scheduleProcessor(100);
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
