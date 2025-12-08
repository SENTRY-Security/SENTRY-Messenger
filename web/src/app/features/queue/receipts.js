// Receipt queue: delivery/read receipts as jobs with idempotency.

import { putOutboxRecord, getOutboxRecord, listOutboxRecords } from './db.js';

const STATE_QUEUED = 'queued';
const STATE_SENT = 'sent';

function normalizeReceiptJob(input = {}) {
  const conversationId = typeof input.conversationId === 'string' ? input.conversationId : null;
  const messageId = typeof input.messageId === 'string' ? input.messageId : null;
  const receiptType = input.receiptType === 'read' ? 'read' : 'delivered';
  if (!conversationId || !messageId) throw new Error('conversationId and messageId required');
  const jobId = `receipt:${receiptType}:${conversationId}:${messageId}`;
  return {
    jobId,
    conversationId,
    messageId,
    receiptType,
    state: STATE_QUEUED,
    createdAt: Date.now()
  };
}

export async function enqueueReceiptJob(input = {}) {
  const job = normalizeReceiptJob(input);
  const existing = await getOutboxRecord(job.jobId);
  if (existing && existing.state === STATE_SENT) return existing;
  await putOutboxRecord(job);
  return job;
}

export async function listPendingReceipts() {
  const all = await listOutboxRecords();
  return all.filter((job) => job?.jobId?.startsWith('receipt:') && job.state !== STATE_SENT);
}
