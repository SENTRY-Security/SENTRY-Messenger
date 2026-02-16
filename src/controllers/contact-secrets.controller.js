import { z } from 'zod';
import { resolveAccountAuth, AccountAuthError } from '../utils/account-context.js';
import { AccountDigestRegex } from '../utils/account-verify.js';
import { ensureCallWorkerConfig, callWorkerRequest } from '../services/call-worker.js';
import { logger } from '../utils/logger.js';

const BackupRequestSchema = z.object({
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional(),
  payload: z.any(),
  checksum: z.string().max(128).optional(),
  snapshot_version: z.number().int().optional(),
  entries: z.number().int().optional(),
  updated_at: z.number().int().optional(),
  bytes: z.number().int().optional(),
  with_dr_state: z.number().int().optional(),
  device_label: z.string().max(120).optional(),
  device_id: z.string().max(120),
  reason: z.string().max(80).optional()
}).superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
  }
  if (!value.payload || typeof value.payload !== 'object') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'payload required' });
  }
});

function firstHeader(req, ...names) {
  for (const name of names) {
    const value = req.get(name);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function extractAccountFromHeaders(req) {
  const accountToken = firstHeader(req, 'x-account-token');
  const accountDigest = firstHeader(req, 'x-account-digest');
  return { accountToken, accountDigest };
}

function respondAccountError(res, err, fallback = 'authorization failed') {
  if (err instanceof AccountAuthError) {
    const status = err.status || 400;
    const payload = err.details && typeof err.details === 'object'
      ? err.details
      : { error: 'AccountAuthFailed', message: err.message || fallback };
    return res.status(status).json(payload);
  }
  return res.status(500).json({ error: 'AccountAuthFailed', message: err?.message || fallback });
}

export const backupContactSecrets = async (req, res) => {
  if (!ensureCallWorkerConfig(res)) return;

  let input;
  try {
    input = BackupRequestSchema.parse(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'BadRequest', message: err.errors?.[0]?.message || 'invalid payload' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      accountToken: input.account_token,
      accountDigest: input.account_digest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  if (!input.device_id) {
    return res.status(400).json({ error: 'BadRequest', message: 'device_id required' });
  }

  const workerPayload = {
    accountDigest: auth.accountDigest,
    payload: input.payload,
    checksum: input.checksum || null,
    snapshotVersion: input.snapshot_version ?? null,
    entries: input.entries ?? null,
    updatedAt: input.updated_at ?? Date.now(),
    bytes: input.bytes ?? null,
    withDrState: input.with_dr_state ?? null,
    deviceLabel: input.device_label ?? null,
    deviceId: input.device_id,
    reason: input.reason || 'auto'
  };

  try {
    const data = await callWorkerRequest('/d1/contact-secrets/backup', {
      method: 'POST',
      body: workerPayload
    });
    return res.json(data || { ok: true });
  } catch (err) {
    logger.error({
      event: 'contactSecrets.backup.failed',
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

export const fetchContactSecretsBackup = async (req, res) => {
  if (!ensureCallWorkerConfig(res)) return;

  const creds = extractAccountFromHeaders(req);
  if (!creds.accountToken && !creds.accountDigest) {
    return res.status(400).json({ error: 'BadRequest', message: 'X-Account-Token or X-Account-Digest required' });
  }

  let auth;
  try {
    auth = await resolveAccountAuth({
      accountToken: creds.accountToken,
      accountDigest: creds.accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const limitRaw = Number(req.query?.limit ?? 1);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 10) : 1;
  const versionRaw = Number(req.query?.version ?? 0);
  const params = new URLSearchParams();
  params.set('accountDigest', auth.accountDigest);
  if (limit) params.set('limit', String(limit));
  if (Number.isFinite(versionRaw) && versionRaw > 0) {
    params.set('version', String(Math.floor(versionRaw)));
  }

  const path = `/d1/contact-secrets/backup?${params.toString()}`;
  try {
    const data = await callWorkerRequest(path, { method: 'GET' });
    return res.json(data || { ok: true, backups: [] });
  } catch (err) {
    logger.error({
      event: 'contactSecrets.fetch.failed',
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
