import { z } from 'zod';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { AccountDigestRegex } from '../utils/account-verify.js';
import { ensureCallWorkerConfig, callWorkerRequest } from '../services/call-worker.js';
import { logger } from '../utils/logger.js';

const VAULT_SERVER_LOG_LIMIT = 5;
let vaultServerPutLogCount = 0;
let vaultServerGetLogCount = 0;

function logVaultServer(kind, payload) {
  if (kind === 'put' && vaultServerPutLogCount >= VAULT_SERVER_LOG_LIMIT) return;
  if (kind === 'get' && vaultServerGetLogCount >= VAULT_SERVER_LOG_LIMIT) return;
  if (kind === 'put') vaultServerPutLogCount += 1;
  if (kind === 'get') vaultServerGetLogCount += 1;
  const event = kind === 'put' ? 'vaultServerPut' : 'vaultServerGet';
  const normalized = {
    status: payload?.status ?? null,
    accountDigestSuffix4: payload?.accountDigestSuffix4 ?? payload?.accountDigest ?? null,
    conversationIdPrefix8: payload?.conversationIdPrefix8 ?? payload?.conversationId ?? null,
    messageIdPrefix8: payload?.messageIdPrefix8 ?? payload?.messageId ?? null,
    senderDeviceIdSuffix4: payload?.senderDeviceIdSuffix4 ?? null,
    errorCode: payload?.errorCode ?? null
  };
  logger.info({ event, ...normalized });
}

const PutSchema = z.object({
  conversationId: z.string().min(8),
  messageId: z.string().min(8),
  serverMessageId: z.string().min(8).optional(),
  senderDeviceId: z.string().min(1),
  targetDeviceId: z.string().min(1).optional(),
  headerCounter: z.number().int(),
  msgType: z.string().max(64).optional(),
  wrapped_mk: z.any(),
  wrap_context: z.any().optional(),
  retentionLimit: z.number().int().optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

const GetSchema = z.object({
  conversationId: z.string().min(8),
  messageId: z.string().min(1).optional(),
  serverMessageId: z.string().min(1).optional(),
  senderDeviceId: z.string().min(1).optional(),
  targetDeviceId: z.string().min(1).optional(),
  headerCounter: z.number().int().optional(),
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

export const putOutboundKey = async (req, res) => {
  if (!ensureCallWorkerConfig(res)) return;

  let input;
  try {
    input = PutSchema.parse(req.body || {});
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

  const headerDeviceId = req.get('x-device-id');
  if (headerDeviceId && input.senderDeviceId && headerDeviceId.trim() !== input.senderDeviceId) {
    return res.status(400).json({ error: 'BadRequest', message: 'senderDeviceId mismatch with X-Device-Id' });
  }

  const payload = {
    accountDigest: auth.accountDigest,
    conversationId: input.conversationId,
    messageId: input.messageId,
    serverMessageId: input.serverMessageId || null,
    senderDeviceId: input.senderDeviceId,
    targetDeviceId: input.targetDeviceId || null,
    headerCounter: input.headerCounter,
    msgType: input.msgType || null,
    wrapped_mk: input.wrapped_mk,
    wrap_context: input.wrap_context || null,
    retentionLimit: input.retentionLimit ?? undefined
  };

  try {
    const data = await callWorkerRequest('/d1/outbound-key-vault/put', {
      method: 'POST',
      body: payload
    });
    logVaultServer('put', {
      accountDigest: auth.accountDigest ? auth.accountDigest.slice(-4) : null,
      conversationId: input.conversationId.slice(0, 8),
      messageId: input.messageId.slice(0, 8),
      status: 200,
      errorCode: null
    });
    return res.json(data || { ok: true });
  } catch (err) {
    logger.error({
      event: 'outboundVault.put.failed',
      status: err?.status,
      error: err?.message || err
    });
    const status = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object'
      ? err.payload
      : { error: 'WorkerError', message: err?.message || 'worker request failed' };
    logVaultServer('put', {
      accountDigest: auth.accountDigest ? auth.accountDigest.slice(-4) : null,
      conversationId: input.conversationId.slice(0, 8),
      messageId: input.messageId.slice(0, 8),
      status,
      errorCode: payload?.error || null
    });
    return res.status(status).json(payload);
  }
};

export const getOutboundKey = async (req, res) => {
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
    messageId: input.messageId || null,
    serverMessageId: input.serverMessageId || null,
    senderDeviceId: input.senderDeviceId || null,
    targetDeviceId: input.targetDeviceId || null,
    headerCounter: input.headerCounter ?? null
  };

  try {
    const data = await callWorkerRequest('/d1/outbound-key-vault/get', {
      method: 'POST',
      body: payload
    });
    logVaultServer('get', {
      accountDigestSuffix4: auth.accountDigest ? auth.accountDigest.slice(-4) : null,
      conversationIdPrefix8: input.conversationId.slice(0, 8),
      messageIdPrefix8: input.messageId ? input.messageId.slice(0, 8) : null,
      senderDeviceIdSuffix4: input.senderDeviceId ? input.senderDeviceId.slice(-4) : null,
      status: 200,
      errorCode: null
    });
    return res.json(data || { ok: true, entry: null });
  } catch (err) {
    logger.error({
      event: 'outboundVault.get.failed',
      status: err?.status,
      error: err?.message || err
    });
    const status = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object'
      ? err.payload
      : { error: 'WorkerError', message: err?.message || 'worker request failed' };
    logVaultServer('get', {
      accountDigestSuffix4: auth.accountDigest ? auth.accountDigest.slice(-4) : null,
      conversationIdPrefix8: input.conversationId.slice(0, 8),
      messageIdPrefix8: input.messageId ? input.messageId.slice(0, 8) : null,
      senderDeviceIdSuffix4: input.senderDeviceId ? input.senderDeviceId.slice(-4) : null,
      status,
      errorCode: payload?.error || null
    });
    return res.status(status).json(payload);
  }
};
