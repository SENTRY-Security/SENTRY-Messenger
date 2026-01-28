import { verifyAccount, normalizeAccountDigest } from './account-verify.js';

export class AccountAuthError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.name = 'AccountAuthError';
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export async function resolveAccountAuth({ accountToken, accountDigest }) {
  const token = typeof accountToken === 'string' ? accountToken.trim() : '';
  const digestInput = normalizeAccountDigest(accountDigest);
  if (!token && !digestInput) {
    throw new AccountAuthError('accountToken or accountDigest required', 400);
  }
  const payload = {};
  if (token) payload.accountToken = token;
  if (digestInput) payload.accountDigest = digestInput;

  let verified;
  try {
    verified = await verifyAccount(payload);
  } catch (err) {
    throw new AccountAuthError(err?.message || 'verify request failed', 502);
  }

  if (!verified.ok) {
    const status = verified.status || 502;
    const details = verified.data || { error: 'VerifyFailed' };
    throw new AccountAuthError('verify rejected', status, details);
  }

  const resolvedDigest = normalizeAccountDigest(verified.data?.account_digest || verified.data?.accountDigest || payload.accountDigest);
  if (!resolvedDigest) {
    throw new AccountAuthError('account digest missing', 502);
  }

  return {
    accountDigest: resolvedDigest
  };
}
