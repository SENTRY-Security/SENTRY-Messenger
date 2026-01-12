// Inbox queue: store incoming secure messages and process per conversation sequentially.

import {
  deleteInboxRecord,
  getInboxRecord,
  listInboxRecords,
  putInboxRecord
} from './db.js';
import { log } from '../../core/log.js';
import { DEBUG } from '../../ui/mobile/debug-flags.js';

const STATE_QUEUED = 'queued';
const STATE_INFLIGHT = 'inflight';
const STATE_FAILED = 'failed';
const STATE_DEAD = 'dead-letter';

const BASE_BACKOFF_MS = 1_500;
const BACKOFF_CAP_MS = 30_000;
// Isolation round: disable inbox retries to avoid repeated decrypt attempts.
const MAX_RETRIES = 0;
const MAX_DEAD = 50;

const convLocks = new Set();
let debug = false;

const nowMs = () => Date.now();

function computeBackoff(retryCount = 0) {
  const delay = BASE_BACKOFF_MS * Math.pow(2, retryCount);
  return Math.min(BACKOFF_CAP_MS, delay);
}

function normalizeJob(input = {}) {
  const conversationId = typeof input.conversationId === 'string' ? input.conversationId : null;
  const payloadEnvelope = input.payloadEnvelope || null;
  if (!conversationId || !payloadEnvelope) throw new Error('conversationId and payloadEnvelope required');
  const messageId = typeof input.messageId === 'string' && input.messageId.trim().length
    ? input.messageId.trim()
    : null;
  if (!messageId) throw new Error('messageId required for inbox job');
  const ts = Number.isFinite(Number(input.createdAt))
    ? Number(input.createdAt)
    : nowMs();
  const jobId = typeof input.jobId === 'string' && input.jobId.length
    ? input.jobId
    : `${conversationId}:${messageId}`;
  return {
    jobId,
    messageId,
    conversationId,
    payloadEnvelope,
    tokenB64: input.tokenB64 || input.token_b64 || null,
    peerAccountDigest: input.peerAccountDigest || null,
    raw: input.raw || null,
    createdAt: ts,
    cursorTs: input.cursorTs ?? null,
    retryCount: Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0,
    nextAttemptAt: Number.isFinite(Number(input.nextAttemptAt)) ? Number(input.nextAttemptAt) : Date.now(),
    state: input.state || STATE_QUEUED,
    lastError: input.lastError || null,
    meta: input.meta || null,
    updatedAt: Date.now()
  };
}

export function setInboxDebug(flag = true) {
  debug = !!flag;
}

export async function enqueueInboxJob(input = {}) {
  const job = normalizeJob(input);
  await putInboxRecord(job);
  return job;
}

async function updateJob(jobId, patch = {}) {
  const current = await getInboxRecord(jobId);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await putInboxRecord(next);
  return next;
}

function isDue(job) {
  if (!job) return false;
  const dueAt = Number(job.nextAttemptAt) || 0;
  const isReadyState = job.state === STATE_QUEUED || job.state === STATE_FAILED || !job.state;
  return isReadyState && dueAt <= Date.now();
}

export async function listInboxByConversation(conversationId) {
  const all = await listInboxRecords();
  return all.filter((job) => job?.conversationId === conversationId);
}

async function fetchDueJobs(conversationId) {
  const all = await listInboxRecords();
  const filtered = all.filter((job) => job && job.conversationId === conversationId && isDue(job));
  filtered.sort((a, b) => {
    const aTs = Number(a.createdAt) || 0;
    const bTs = Number(b.createdAt) || 0;
    if (aTs !== bTs) return aTs - bTs;
    const aId = a.messageId || a.jobId || '';
    const bId = b.messageId || b.jobId || '';
    return aId.localeCompare(bId);
  });
  return filtered;
}

async function markFailure(job, err) {
  const retryCount = Number(job.retryCount) || 0;
  const nextDelay = computeBackoff(retryCount);
  const newState = retryCount >= MAX_RETRIES ? STATE_DEAD : STATE_FAILED;
  await updateJob(job.jobId, {
    state: newState,
    retryCount: retryCount + 1,
    nextAttemptAt: Date.now() + nextDelay,
    lastError: err?.message || err || 'inbox process failed'
  });
  if (debug) {
    console.warn('[inbox]', { event: 'failed', jobId: job?.jobId, conv: job?.conversationId, retryCount, nextDelay, error: err?.message || err });
  }
  if (newState === STATE_DEAD) {
    // trim dead-letter per conversation to avoid unbounded growth
    const deadJobs = (await listInboxRecords()).filter((j) => j?.state === STATE_DEAD && j.conversationId === job.conversationId);
    if (deadJobs.length > MAX_DEAD) {
      deadJobs.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      const prune = deadJobs.slice(0, deadJobs.length - MAX_DEAD);
      for (const dj of prune) {
        try { await deleteInboxRecord(dj.jobId); } catch { }
      }
    }
  }
}

async function processSingle(job, handler) {
  if (!job || typeof handler !== 'function') return { processed: false, yielded: false };
  if (convLocks.has(job.conversationId)) return { processed: false, yielded: false };
  convLocks.add(job.conversationId);
  let updated = null;
  try {
    updated = await updateJob(job.jobId, { state: STATE_INFLIGHT, lastError: null });
    await handler(updated || job);
    await deleteInboxRecord(job.jobId);
    if (debug) {
      console.log('[inbox]', { event: 'processed', jobId: job?.jobId, conv: job?.conversationId, messageId: job?.messageId });
    }
    return { processed: true, yielded: false };
  } catch (err) {
    if (err && err.__yieldToReplay) {
      await updateJob(job.jobId, { state: STATE_QUEUED, nextAttemptAt: Date.now(), lastError: null });
      return { processed: false, yielded: true };
    }
    await markFailure(updated || job, err);
    return { processed: false, yielded: false };
  } finally {
    convLocks.delete(job.conversationId);
  }
}

export async function processInboxForConversation({ conversationId, handler, allowReplay = false, mutateState = true }) {
  if (!conversationId || typeof handler !== 'function') return { processed: 0 };
  const computedIsHistoryReplay = allowReplay === true && mutateState === false;
  const replayCtx = {
    allowReplay,
    mutateState,
    computedIsHistoryReplay
  };
  if (DEBUG.replay) {
    try {
      log({
        replayGateTrace: {
          where: 'queue:processInboxForConversation:enter',
          conversationId: conversationId || null,
          messageId: null,
          serverMessageId: null,
          allowReplayRaw: allowReplay,
          mutateStateRaw: mutateState,
          computedIsHistoryReplay
        }
      });
    } catch { }
  }
  const due = await fetchDueJobs(conversationId);
  const handlerWithCtx = (job) => handler(job, replayCtx);
  let processed = 0;
  for (const job of due) {
    const result = await processSingle(job, handlerWithCtx);
    processed += 1;
    if (result?.yielded) break;
    if (processed >= 50) break; // avoid starving other conversations
  }
  return { processed };
}

export async function processInboxNow(handler) {
  if (typeof handler !== 'function') return { processed: 0 };
  const all = await listInboxRecords();
  const grouped = new Map();
  for (const job of all) {
    if (!job || !isDue(job)) continue;
    const list = grouped.get(job.conversationId) || [];
    list.push(job);
    grouped.set(job.conversationId, list);
  }
  let processed = 0;
  for (const [convId, jobs] of grouped.entries()) {
    jobs.sort((a, b) => {
      const aTs = Number(a.createdAt) || 0;
      const bTs = Number(b.createdAt) || 0;
      if (aTs !== bTs) return aTs - bTs;
      return (a.messageId || '').localeCompare(b.messageId || '');
    });
    for (const job of jobs) {
      const result = await processSingle(job, handler);
      processed += 1;
      if (result?.yielded) break;
    }
  }
  return { processed };
}

export async function getInboxStats() {
  const all = await listInboxRecords();
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
