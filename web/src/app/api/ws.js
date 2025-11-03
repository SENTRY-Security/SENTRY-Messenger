import { fetchJSON } from '../core/http.js';

export async function requestWsToken({ uidHex, accountToken, accountDigest }) {
  const body = { uidHex };
  if (accountToken) body.accountToken = accountToken;
  if (accountDigest) body.accountDigest = accountDigest;
  return await fetchJSON('/api/v1/ws/token', body);
}
