// Local job queue for messages-flow. No timers; drain is explicit.

export function createMessageJobQueue() {
  const items = [];
  const dedupeKeys = new Map();

  const normalizeJob = (job = {}) => {
    const createdAtMs = Number.isFinite(job.createdAtMs) ? job.createdAtMs : Date.now();
    const type = typeof job.type === 'string' ? job.type : null;
    const conversationId = job.conversationId || null;
    const key = job.key || (conversationId ? `${type}:${conversationId}` : type);
    return {
      type,
      conversationId,
      key,
      payload: job.payload || null,
      createdAtMs
    };
  };

  const enqueue = (job) => {
    const normalized = normalizeJob(job);
    if (!normalized.type) return { ok: false, reason: 'missing_type', job: normalized };
    if (normalized.key) {
      if (dedupeKeys.has(normalized.key)) {
        return { ok: false, reason: 'deduped', job: normalized };
      }
      dedupeKeys.set(normalized.key, normalized.createdAtMs);
    }
    items.push(normalized);
    return { ok: true, job: normalized };
  };

  const drain = () => {
    const drained = items.splice(0, items.length);
    for (const job of drained) {
      if (job.key && dedupeKeys.get(job.key) === job.createdAtMs) {
        dedupeKeys.delete(job.key);
      }
    }
    return drained;
  };

  const getStats = () => ({
    size: items.length,
    dedupeKeyCount: dedupeKeys.size
  });

  return {
    enqueue,
    drain,
    getStats
  };
}
