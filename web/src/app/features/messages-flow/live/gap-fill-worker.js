// /app/features/messages-flow/live/gap-fill-worker.js
// Gap-fill worker for live (B-route) flow. Stub only.

import { dequeueNextGapFillJob as defaultDequeue } from './gap-fill-queue.js';

export function createGapFillWorker(deps = {}) {
  const dequeueNextGapFillJob = typeof deps.dequeueNextGapFillJob === 'function'
    ? deps.dequeueNextGapFillJob
    : defaultDequeue;
  const adapters = deps?.adapters || null;

  return {
    async runNextGapFillJob(conversationId) {
      const job = dequeueNextGapFillJob(conversationId);
      if (!job) return { ok: false, reason: 'queue_empty' };

      // TODO: implement live gap-fill using adapters + server/state access.
      return {
        ok: true,
        status: 'noop',
        adaptersReady: !!adapters,
        job
      };
    }
  };
}
