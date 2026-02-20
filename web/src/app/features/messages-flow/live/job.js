// /app/features/messages-flow/live/job.js
// Live job structure + validation (no crypto/state/server dependencies).

export const LIVE_JOB_TYPES = Object.freeze({
  WS_INCOMING: 'WS_INCOMING'
});

const LIVE_JOB_REQUIRED_FIELDS = Object.freeze({
  [LIVE_JOB_TYPES.WS_INCOMING]: [
    'conversationId',
    'tokenB64',
    'peerAccountDigest',
    'peerDeviceId'
  ]
});

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeDigestOnly(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  return raw.split('::')[0] || null;
}

function normalizeMessageIdValue(value) {
  return normalizeString(value);
}

function resolveConversationId(event, ctx) {
  return normalizeString(
    event?.conversationId
    || event?.conversation_id
    || ctx?.conversationId
    || null
  );
}

function resolveTokenB64(event, ctx) {
  return normalizeString(
    ctx?.tokenB64
    || event?.tokenB64
    || event?.token_b64
    || null
  );
}

function resolveMessageId(event, ctx) {
  return normalizeMessageIdValue(
    event?.messageId
    || event?.message_id
    || event?.id
    || ctx?.messageId
    || ctx?.message_id
    || ctx?.id
    || null
  );
}

function resolveServerMessageId(event, ctx) {
  return normalizeMessageIdValue(
    event?.serverMessageId
    || event?.server_message_id
    || event?.serverMsgId
    || ctx?.serverMessageId
    || ctx?.server_message_id
    || ctx?.serverMsgId
    || null
  );
}

function resolvePeerAccountDigest(event, ctx) {
  return normalizeDigestOnly(
    ctx?.peerAccountDigest
    || event?.peerAccountDigest
    || event?.senderAccountDigest
    || event?.sender_account_digest
    || event?.senderDigest
    || event?.sender_digest
    || null
  );
}

function resolvePeerDeviceId(event, ctx) {
  return normalizeString(
    ctx?.peerDeviceId
    || event?.peerDeviceId
    || event?.senderDeviceId
    || event?.sender_device_id
    || null
  );
}

function resolveSourceTag(event, ctx) {
  return normalizeString(
    ctx?.sourceTag
    || ctx?.triggerSource
    || ctx?.source
    || event?.sourceTag
    || event?.source
    || null
  );
}

function resolveCreatedAt(event, ctx) {
  const candidates = [
    ctx?.createdAt,
    ctx?.created_at,
    event?.createdAt,
    event?.created_at,
    event?.ts,
    event?.timestamp
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return Date.now();
}

export function validateLiveJob(job = null) {
  if (!job || typeof job !== 'object') {
    return { ok: false, reason: 'INVALID_JOB', missing: null };
  }
  if (job.type !== LIVE_JOB_TYPES.WS_INCOMING) {
    return { ok: false, reason: 'UNSUPPORTED_TYPE', missing: null };
  }

  const missing = [];
  const required = LIVE_JOB_REQUIRED_FIELDS[LIVE_JOB_TYPES.WS_INCOMING] || [];
  for (const field of required) {
    if (!normalizeString(job[field])) missing.push(field);
  }

  const hasMessageId = !!normalizeMessageIdValue(job.messageId);
  const hasServerMessageId = !!normalizeMessageIdValue(job.serverMessageId);
  if (!hasMessageId && !hasServerMessageId) missing.push('messageId');

  if (missing.length) {
    return { ok: false, reason: 'MISSING_FIELDS', missing };
  }
  return { ok: true, reason: null, missing: null };
}

function resolveCounter(event, ctx) {
  const candidates = [
    event?.counter,
    ctx?.counter
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

export function createLiveJobFromWsEvent(event = null, ctx = null) {
  const job = {
    type: LIVE_JOB_TYPES.WS_INCOMING,
    conversationId: resolveConversationId(event, ctx),
    messageId: resolveMessageId(event, ctx),
    serverMessageId: resolveServerMessageId(event, ctx),
    peerAccountDigest: resolvePeerAccountDigest(event, ctx),
    peerDeviceId: resolvePeerDeviceId(event, ctx),
    tokenB64: resolveTokenB64(event, ctx),
    sourceTag: resolveSourceTag(event, ctx),
    createdAt: resolveCreatedAt(event, ctx),
    counter: resolveCounter(event, ctx)
  };
  const hasMessageId = !!normalizeMessageIdValue(job.messageId);
  const hasServerMessageId = !!normalizeMessageIdValue(job.serverMessageId);
  if (!hasMessageId && !hasServerMessageId) {
    return { job: null, reason: 'MISSING_MESSAGE_ID', missing: ['messageId'] };
  }
  const validation = validateLiveJob(job);
  if (!validation.ok) {
    return { job: null, reason: validation.reason, missing: validation.missing };
  }
  return { job, reason: null, missing: null };
}
