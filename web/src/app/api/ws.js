import { fetchJSON } from '../core/http.js';

export async function requestWsToken({ accountToken, accountDigest, sessionTs }) {
  const body = {};
  if (accountToken) body.account_token = accountToken;
  if (accountDigest) body.account_digest = accountDigest;
  if (Number.isFinite(sessionTs)) body.session_ts = Math.floor(sessionTs);
  return await fetchJSON('/api/v1/ws/token', body);
}
