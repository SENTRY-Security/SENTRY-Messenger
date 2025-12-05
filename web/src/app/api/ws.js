import { fetchJSON } from '../core/http.js';

export async function requestWsToken({ uidHex, accountToken, accountDigest, sessionTs }) {
  const body = { uidHex };
  if (accountToken) body.accountToken = accountToken;
  if (accountDigest) body.accountDigest = accountDigest;
  if (Number.isFinite(sessionTs)) body.sessionTs = Math.floor(sessionTs);
  return await fetchJSON('/api/v1/ws/token', body);
}
