import { fetchWithTimeout } from '../core/http.js';
import { buildAccountPayload } from '../core/store.js';

function buildHeaders() {
  const payload = buildAccountPayload();
  const headers = {};
  if (payload.accountToken) headers['X-Account-Token'] = payload.accountToken;
  if (payload.accountDigest) headers['X-Account-Digest'] = payload.accountDigest;
  return headers;
}

export async function redeemSubscription({ token, dryRun = false } = {}) {
  if (!token) throw new Error('token required');
  const payload = buildAccountPayload();
  const body = {
    token,
    dryRun,
    accountToken: payload.accountToken || undefined,
    accountDigest: payload.accountDigest || undefined
  };
  const r = await fetchWithTimeout('/api/v1/subscription/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...buildHeaders() },
    body: JSON.stringify(body)
  }, 15000);
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { r, data };
}

export async function uploadSubscriptionQr({ file } = {}) {
  if (!file) throw new Error('file required');
  const payload = buildAccountPayload();
  const headers = buildHeaders();
  const form = new FormData();
  form.append('file', file);
  const r = await fetchWithTimeout('/api/v1/subscription/scan-upload', {
    method: 'POST',
    headers,
    body: form
  }, 20000);
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { r, data };
}

export async function subscriptionStatus() {
  const headers = buildHeaders();
  const payload = buildAccountPayload();
  const params = new URLSearchParams();
  if (payload.accountDigest) params.set('digest', payload.accountDigest);
  params.set('limit', '200');
  const r = await fetchWithTimeout(`/api/v1/subscription/status?${params.toString()}`, { headers }, 10000);
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { r, data };
}

export async function voucherStatus(tokenId) {
  if (!tokenId) throw new Error('tokenId required');
  const headers = buildHeaders();
  const url = `/api/v1/subscription/token-status?tokenId=${encodeURIComponent(tokenId)}`;
  const r = await fetchWithTimeout(url, { headers }, 10000);
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { r, data };
}
