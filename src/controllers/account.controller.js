import { AccountAuthError, resolveAccountAuth } from '../utils/account-context.js';
import { AccountDigestRegex } from '../utils/account-verify.js';
import { ensureCallWorkerConfig, callWorkerRequest } from '../services/call-worker.js';
import { logger } from '../utils/logger.js';

function readHeader(req, name) {
  const value = req.get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

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

export const getAccountEvidence = async (req, res) => {
  if (!ensureCallWorkerConfig(res)) return;

  const accountToken = readHeader(req, 'x-account-token') || (typeof req.query?.accountToken === 'string' ? req.query.accountToken : null);
  const accountDigestHeader = readHeader(req, 'x-account-digest');
  const accountDigestQuery = typeof req.query?.accountDigest === 'string' ? req.query.accountDigest : null;
  const accountDigest = accountDigestHeader && AccountDigestRegex.test(accountDigestHeader)
    ? accountDigestHeader
    : (accountDigestQuery && AccountDigestRegex.test(accountDigestQuery) ? accountDigestQuery : null);

  let auth;
  try {
    auth = await resolveAccountAuth({
      accountToken,
      accountDigest
    });
  } catch (err) {
    return respondAccountError(res, err);
  }

  const params = new URLSearchParams();
  params.set('accountDigest', auth.accountDigest);

  try {
    const data = await callWorkerRequest(`/d1/account/evidence?${params.toString()}`, { method: 'GET' });
    return res.json(data || { ok: true, evidence: {} });
  } catch (err) {
    logger.error({
      event: 'accountEvidence.failed',
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
