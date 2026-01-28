// Media job helper: separate media upload and metadata message jobs.

import { enqueueOutboxJob } from './outbox.js';

export async function enqueueMediaUploadJob({ conversationId, messageId, payloadEnvelope, meta }) {
  if (!conversationId || !payloadEnvelope) throw new Error('conversationId and payloadEnvelope required');
  if (!messageId) throw new Error('messageId required for media upload job');
  return enqueueOutboxJob({
    type: 'media-upload',
    conversationId,
    messageId,
    payloadEnvelope,
    meta: { ...(meta || {}), kind: 'upload' }
  });
}

export async function enqueueMediaMetaJob({
  conversationId,
  messageId,
  headerJson,
  header,
  ciphertextB64,
  counter,
  senderDeviceId,
  receiverAccountDigest,
  receiverDeviceId,
  createdAt,
  meta
}) {
  if (!conversationId || !ciphertextB64 || !headerJson) throw new Error('conversationId, headerJson, ciphertextB64 required');
  if (!messageId) throw new Error('messageId required for media meta job');
  return enqueueOutboxJob({
    type: 'media-meta',
    conversationId,
    messageId,
    headerJson,
    header,
    ciphertextB64,
    counter,
    senderDeviceId,
    receiverAccountDigest,
    receiverDeviceId,
    createdAt,
    meta: { ...(meta || {}), kind: 'meta' }
  });
}
