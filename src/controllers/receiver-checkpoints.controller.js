import { z } from 'zod';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { AccountDigestRegex } from '../utils/account-verify.js';
import { ensureCallWorkerConfig, callWorkerRequest } from '../services/call-worker.js';
import { logger } from '../utils/logger.js';

const PutSchema = z.object({
  conversationId: z.string().min(8),
  peerDeviceId: z.string().min(1),
  cursorMessageId: z.string().min(1).optional(),
  cursorServerMessageId: z.string().min(1).optional(),
  headerCounter: z.number().int().optional(),
  Nr: z.number().int(),
  Ns: z.number().int().optional(),
  PN: z.number().int().optional(),
  theirRatchetPubHash: z.string().min(8).max(128).optional(),
  ckRHash: z.string().min(8).max(128).optional(),
  skippedHash: z.string().min(8).max(128).optional(),
  skippedCount: z.number().int().optional(),
  wrapInfoTag: z.string().max(120).optional(),
  checkpointHash: z.string().max(256).optional(),
  wrapped_checkpoint: z.any(),
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
  peerDeviceId: z.string().min(1),
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

export const putReceiverCheckpoint = async (req, res) => {
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

  const payload = {
    accountDigest: auth.accountDigest,
    conversationId: input.conversationId,
    peerDeviceId: input.peerDeviceId,
    cursorMessageId: input.cursorMessageId || null,
    cursorServerMessageId: input.cursorServerMessageId || null,
    headerCounter: input.headerCounter ?? null,
    Nr: input.Nr,
    Ns: input.Ns ?? null,
    PN: input.PN ?? null,
    theirRatchetPubHash: input.theirRatchetPubHash || null,
    ckRHash: input.ckRHash || null,
    skippedHash: input.skippedHash || null,
    skippedCount: input.skippedCount ?? null,
    wrapInfoTag: input.wrapInfoTag || null,
    checkpointHash: input.checkpointHash || null,
    wrapped_checkpoint: input.wrapped_checkpoint,
    wrap_context: input.wrap_context || null,
    retentionLimit: input.retentionLimit ?? undefined
  };

  try {
    const data = await callWorkerRequest('/d1/receiver-checkpoints/put', {
      method: 'POST',
      body: payload
    });
    return res.json(data || { ok: true });
  } catch (err) {
    logger.error({
      event: 'receiverCheckpoint.put.failed',
      status: err?.status,
      error: err?.message || err
    });
    const status = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object'
      ? err.payload
      : { error: 'WorkerError', message: err?.message || 'worker request failed' };
    return res.status(status).json(payload);
  }
};

export const getLatestReceiverCheckpoint = async (req, res) => {
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
    peerDeviceId: input.peerDeviceId
  };

  try {
    const data = await callWorkerRequest('/d1/receiver-checkpoints/get-latest', {
      method: 'POST',
      body: payload
    });
    return res.json(data || { ok: true, checkpoint: null });
  } catch (err) {
    logger.error({
      event: 'receiverCheckpoint.get.failed',
      status: err?.status,
      error: err?.message || err
    });
    const status = err?.status || 502;
    const payload = err?.payload && typeof err.payload === 'object'
      ? err.payload
      : { error: 'WorkerError', message: err?.message || 'worker request failed' };
    return res.status(status).json(payload);
  }
};
