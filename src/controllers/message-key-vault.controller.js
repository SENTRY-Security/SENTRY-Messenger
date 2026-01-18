import { z } from 'zod';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { AccountDigestRegex } from '../utils/account-verify.js';
import { ensureCallWorkerConfig, callWorkerRequest } from '../services/call-worker.js';
import { logger } from '../utils/logger.js';

const VAULT_SERVER_LOG_LIMIT = 5;
let vaultPutLogCount = 0;
let vaultGetLogCount = 0;

function logMessageKeyVault(kind, payload) {
  if (kind === 'put' && vaultPutLogCount >= VAULT_SERVER_LOG_LIMIT) return;
  if (kind === 'get' && vaultGetLogCount >= VAULT_SERVER_LOG_LIMIT) return;
  if (kind === 'put') vaultPutLogCount += 1;
  if (kind === 'get') vaultGetLogCount += 1;
  const event = kind === 'put' ? 'messageKeyVaultPut' : 'messageKeyVaultGet';
  logger.info({ event, ...payload });
}

const PutSchema = z.object({
  conversationId: z.string().min(8),
  messageId: z.string().min(8),
  senderDeviceId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  direction: z.enum(['incoming', 'outgoing']),
  msgType: z.string().max(64).optional(),
  headerCounter: z.number().int().nonnegative().nullable().optional(),
  wrapped_mk: z.object({}).passthrough(),
  wrap_context: z.object({}).passthrough(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const GetSchema = z.object({
  conversationId: z.string().min(8),
  messageId: z.string().min(1),
  senderDeviceId: z.string().min(1),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

function respondAccountError(res, err, fallback = 'authorization failed') {
  if (err instanceof AccountAuthError) {
    const status = err.status || 400;
    if (err.details && typeof err.details === 'object') {
      return res.status(status).json(err.details);
    }
    return res.status(status).json({ error: 'AccountAuthFailed', message: err.message || fallback });
  }
  return res.status(500).json({ error: 'AccountAuthFailed', message: err?.message || fallback });
}

export const putMessageKeyVault = async (req, res) => {
  if (!ensureCallWorkerConfig(res)) return;

  let input;
  try {
    input = PutSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err.errors?.[0]?.message || 'invalid payload' });
  }

  let auth;
  try {
    // Authenticate the sender using their token.
    // We intentionally omit input.accountDigest here to avoid a mismatch error
    // if the sender is writing to a peer's vault.
    auth = await resolveAccountAuth({
      accountToken: input.accountToken
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const payload = {
    // Use the explicit target digest (Peer) if provided, otherwise default to authenticated user (Self).
    accountDigest: input.accountDigest || auth.accountDigest,
    conversationId: input.conversationId,
    messageId: input.messageId,
    senderDeviceId: input.senderDeviceId,
    targetDeviceId: input.targetDeviceId,
    direction: input.direction,
    msgType: input.msgType || null,
    headerCounter: input.headerCounter ?? null,
    wrapped_mk: input.wrapped_mk,
    wrap_context: input.wrap_context
  };

  try {
    const data = await callWorkerRequest('/d1/message-key-vault/put', {
      method: 'POST',
      body: payload
    });
    logMessageKeyVault('put', {
      accountDigestSuffix4: payload.accountDigest ? payload.accountDigest.slice(-4) : null,
      conversationIdPrefix8: input.conversationId.slice(0, 8),
      messageIdPrefix8: input.messageId.slice(0, 8),
      senderDeviceIdSuffix4: input.senderDeviceId.slice(-4),
      status: 200,
      errorCode: null
    });
    return res.json(data || { ok: true });
  } catch (err) {
    logger.error({
      event: 'messageKeyVault.put.failed',
      status: err?.status,
      error: err?.message || err
    });
    const status = err?.status || 502;
    const payloadErr = err?.payload && typeof err.payload === 'object'
      ? err.payload
      : { error: 'WorkerError', message: err?.message || 'worker request failed' };
    logMessageKeyVault('put', {
      accountDigestSuffix4: payload.accountDigest ? payload.accountDigest.slice(-4) : null,
      conversationIdPrefix8: input.conversationId.slice(0, 8),
      messageIdPrefix8: input.messageId.slice(0, 8),
      senderDeviceIdSuffix4: input.senderDeviceId.slice(-4),
      status,
      errorCode: payloadErr?.error || null
    });
    return res.status(status).json(payloadErr);
  }
};

export const getMessageKeyVault = async (req, res) => {
  if (!ensureCallWorkerConfig(res)) return;

  let input;
  try {
    input = GetSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err.errors?.[0]?.message || 'invalid payload' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const payload = {
    accountDigest: auth.accountDigest,
    conversationId: input.conversationId,
    messageId: input.messageId,
    senderDeviceId: input.senderDeviceId
  };

  try {
    const data = await callWorkerRequest('/d1/message-key-vault/get', {
      method: 'POST',
      body: payload
    });
    logMessageKeyVault('get', {
      accountDigestSuffix4: auth.accountDigest ? auth.accountDigest.slice(-4) : null,
      conversationIdPrefix8: input.conversationId.slice(0, 8),
      messageIdPrefix8: input.messageId.slice(0, 8),
      senderDeviceIdSuffix4: input.senderDeviceId.slice(-4),
      status: 200,
      errorCode: null
    });
    return res.json(data || { ok: true, wrapped_mk: null, wrap_context: null });
  } catch (err) {
    logger.error({
      event: 'messageKeyVault.get.failed',
      status: err?.status,
      error: err?.message || err
    });
    const status = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object'
      ? err.payload
      : { error: 'WorkerError', message: err?.message || 'worker request failed' };
    logMessageKeyVault('get', {
      accountDigestSuffix4: auth.accountDigest ? auth.accountDigest.slice(-4) : null,
      conversationIdPrefix8: input.conversationId.slice(0, 8),
      messageIdPrefix8: input.messageId.slice(0, 8),
      senderDeviceIdSuffix4: input.senderDeviceId.slice(-4),
      status,
      errorCode: payload?.error || null
    });
    return res.status(status).json(payload);
  }
};

const GetCountSchema = z.object({
  conversationId: z.string().min(8),
  messageId: z.string().min(1),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

export const getVaultPutCount = async (req, res) => {
  if (!ensureCallWorkerConfig(res)) return;

  let input;
  try {
    input = GetCountSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err.errors?.[0]?.message || 'invalid payload' });
  }

  try {
    // Just verify auth, we don't strictly need user info for counting but good practice
    await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const payload = {
    conversationId: input.conversationId,
    messageId: input.messageId
  };

  try {
    const data = await callWorkerRequest('/d1/message-key-vault/count', {
      method: 'POST',
      body: payload
    });
    return res.json(data || { ok: true, count: 0 });
  } catch (err) {
    logger.error({
      event: 'messageKeyVault.count.failed',
      status: err?.status,
      error: err?.message || err
    });
    const status = err?.status || 502;
    const payloadErr = err?.payload && typeof err.payload === 'object'
      ? err.payload
      : { error: 'WorkerError', message: err?.message || 'worker request failed' };
    return res.status(status).json(payloadErr);
  }
};
const DeleteSchema = z.object({
  conversationId: z.string().min(8),
  messageId: z.string().min(1),
  senderDeviceId: z.string().min(1),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

export const deleteMessageKeyVault = async (req, res) => {
  if (!ensureCallWorkerConfig(res)) return;

  let input;
  try {
    input = DeleteSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err.errors?.[0]?.message || 'invalid payload' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  // We only allow users to delete keys that belong to them (their own digest)
  // or keys they wrote (if we tracked authorship, but simplest is partition by accountDigest)
  // Since the vault is partitioned by accountDigest, the user can only delete from their own partition.
  const payload = {
    accountDigest: auth.accountDigest,
    conversationId: input.conversationId,
    messageId: input.messageId,
    senderDeviceId: input.senderDeviceId
  };

  try {
    const data = await callWorkerRequest('/d1/message-key-vault/delete', {
      method: 'POST',
      body: payload
    });
    logMessageKeyVault('put', { // Log as 'put' kind since it's a write op
      accountDigestSuffix4: auth.accountDigest.slice(-4),
      conversationIdPrefix8: input.conversationId.slice(0, 8),
      messageIdPrefix8: input.messageId.slice(0, 8),
      senderDeviceIdSuffix4: input.senderDeviceId.slice(-4),
      status: 200,
      deleted: data?.deleted,
      errorCode: null
    });
    return res.json(data || { ok: true, deleted: false });
  } catch (err) {
    logger.error({
      event: 'messageKeyVault.delete.failed',
      status: err?.status,
      error: err?.message || err
    });
    const status = err?.status || 502;
    const payloadErr = err?.payload && typeof err.payload === 'object'
      ? err.payload
      : { error: 'WorkerError', message: err?.message || 'worker request failed' };
    logMessageKeyVault('put', {
      accountDigestSuffix4: auth.accountDigest.slice(-4),
      conversationIdPrefix8: input.conversationId.slice(0, 8),
      messageIdPrefix8: input.messageId.slice(0, 8),
      senderDeviceIdSuffix4: input.senderDeviceId.slice(-4),
      status,
      errorCode: payloadErr?.error || null
    });
    return res.status(status).json(payloadErr);
  }
};

const GetLatestStateSchema = z.object({
  conversationId: z.string().min(8),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

export const getLatestStateVault = async (req, res) => {
  if (!ensureCallWorkerConfig(res)) return;

  let input;
  try {
    input = GetLatestStateSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err.errors?.[0]?.message || 'invalid payload' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      accountToken: input.accountToken,
      accountDigest: input.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const payload = {
    accountDigest: auth.accountDigest,
    conversationId: input.conversationId
  };

  try {
    const data = await callWorkerRequest('/d1/message-key-vault/latest-state', {
      method: 'POST',
      body: payload
    });
    if (data) {
      logMessageKeyVault('get', {
        accountDigestSuffix4: auth.accountDigest.slice(-4),
        conversationIdPrefix8: input.conversationId.slice(0, 8),
        status: 200,
        eventSubType: 'latest-state'
      });
    }
    return res.json(data || { ok: true, incoming: null, outgoing: null });
  } catch (err) {
    logger.error({
      event: 'messageKeyVault.getLatestState.failed',
      status: err?.status,
      error: err?.message || err
    });
    const status = err?.status || 502;
    const payloadErr = err?.payload && typeof err.payload === 'object'
      ? err.payload
      : { error: 'WorkerError', message: err?.message || 'worker request failed' };
    return res.status(status).json(payloadErr);
  }
};
