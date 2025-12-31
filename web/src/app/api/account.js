// Account-level evidence queries (presence-only).
import { fetchWithTimeout } from '../core/http.js';
import { getAccountToken, getAccountDigest } from '../core/store.js';

async function parseJsonResponse(r) {
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function fetchAccountEvidence(params = {}) {
  const accountToken = params.accountToken || getAccountToken();
  const accountDigest = params.accountDigest || getAccountDigest();
  if (!accountToken && !accountDigest) {
    throw new Error('accountToken or accountDigest required');
  }
  const headers = {};
  if (accountToken) headers['x-account-token'] = accountToken;
  if (accountDigest) headers['x-account-digest'] = accountDigest;
  const r = await fetchWithTimeout('/api/v1/account/evidence', { method: 'GET', headers }, 8000);
  return parseJsonResponse(r);
}
