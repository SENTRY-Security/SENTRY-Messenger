// /app/features/messages-flow/live/gap-fill-queue.js
// In-memory gap-fill queue. No timers; dequeue is explicit.

import { logCapped } from '../../core/log.js';

const GAP_FILL_LOG_CAP = 5;
const queueByConversation = new Map();
const dedupeByConversation = new Map();

function slicePrefix(value, len = 8) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (!str) return null;
  return str.slice(0, len);
}

function normalizeCounter(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getQueue(conversationId) {
  const key = conversationId || null;
  if (!key) return null;
  if (!queueByConversation.has(key)) queueByConversation.set(key, []);
  return queueByConversation.get(key);
}

function getDedupeSet(conversationId) {
  const key = conversationId || null;
  if (!key) return null;
  if (!dedupeByConversation.has(key)) dedupeByConversation.set(key, new Set());
  return dedupeByConversation.get(key);
}

function normalizeRange(fromCounter, toCounter) {
  const from = normalizeCounter(fromCounter);
  const to = normalizeCounter(toCounter);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { from: null, to: null };
  if (from <= to) return { from, to };
  return { from: to, to: from };
}

function buildJob(params = {}) {
  const conversationId = params?.conversationId || null;
  if (!conversationId) return { ok: false, reason: 'missing_conversation', job: null };
  const { from, to } = normalizeRange(params?.fromCounter, params?.toCounter);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { ok: false, reason: 'missing_counter', job: null };
  }
  return {
    ok: true,
    job: {
      conversationId,
      fromCounter: from,
      toCounter: to,
      reason: params?.reason || null,
      peerAccountDigest: params?.peerAccountDigest || null,
      peerDeviceId: params?.peerDeviceId || null,
      tokenB64: params?.tokenB64 || null,
      createdAtMs: Date.now()
    }
  };
}

export function enqueueGapFillJob(params = {}) {
  const built = buildJob(params);
  if (!built.ok) return { ok: false, reason: built.reason };

  const job = built.job;
  const queue = getQueue(job.conversationId);
  const dedupeSet = getDedupeSet(job.conversationId);
  if (!queue || !dedupeSet) return { ok: false, reason: 'queue_unavailable' };

  let hasNewCounter = false;
  for (let counter = job.fromCounter; counter <= job.toCounter; counter += 1) {
    const key = `${job.conversationId}:${counter}`;
    if (!dedupeSet.has(key)) {
      hasNewCounter = true;
      dedupeSet.add(key);
    }
  }

  if (!hasNewCounter) {
    logCapped('gapFillQueueTrace', {
      action: 'dedupe',
      conversationIdPrefix8: slicePrefix(job.conversationId),
      fromCounter: job.fromCounter,
      toCounter: job.toCounter,
      reason: job.reason || null
    }, GAP_FILL_LOG_CAP);
    return { ok: false, deduped: true };
  }

  queue.push(job);
  logCapped('gapFillQueueTrace', {
    action: 'enqueue',
    conversationIdPrefix8: slicePrefix(job.conversationId),
    fromCounter: job.fromCounter,
    toCounter: job.toCounter,
    reason: job.reason || null
  }, GAP_FILL_LOG_CAP);
  return { ok: true, job };
}

export function dequeueNextGapFillJob(conversationId) {
  const convId = conversationId || null;
  const queue = queueByConversation.get(convId);
  if (!queue || !queue.length) return null;

  const job = queue.shift();
  const dedupeSet = dedupeByConversation.get(convId);
  if (dedupeSet && job) {
    for (let counter = job.fromCounter; counter <= job.toCounter; counter += 1) {
      const key = `${job.conversationId}:${counter}`;
      dedupeSet.delete(key);
    }
    if (!dedupeSet.size) dedupeByConversation.delete(convId);
  }
  if (!queue.length) queueByConversation.delete(convId);

  logCapped('gapFillQueueTrace', {
    action: 'dequeue',
    conversationIdPrefix8: slicePrefix(job?.conversationId),
    fromCounter: job?.fromCounter ?? null,
    toCounter: job?.toCounter ?? null,
    reason: job?.reason || null
  }, GAP_FILL_LOG_CAP);

  return job;
}
