import { fetchWithTimeout } from '../core/http.js';
import { buildAccountPayload } from '../core/store.js';

function buildHeaders() {
  const payload = buildAccountPayload();
  const headers = { 'content-type': 'application/json' };
  if (payload.account_token) headers['X-Account-Token'] = payload.account_token;
  if (payload.account_digest) headers['X-Account-Digest'] = payload.account_digest;
  return headers;
}

/** Fetch the whitelist app catalog. */
export async function getAppCatalog() {
  const r = await fetchWithTimeout('/api/v1/apps/catalog', { headers: buildHeaders() }, 10000);
  return r.json();
}

/** Start (or reuse) an Android instance for the current user. */
export async function startInstance() {
  const r = await fetchWithTimeout('/api/v1/apps/instance/start', {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({}),
  }, 30000);
  return r.json();
}

/** Poll instance status and get WebRTC stream info. */
export async function getInstanceStatus() {
  const r = await fetchWithTimeout('/api/v1/apps/instance/status', { headers: buildHeaders() }, 15000);
  return r.json();
}

/** Stop and destroy the current user's Android instance. */
export async function stopInstance() {
  const r = await fetchWithTimeout('/api/v1/apps/instance/stop', {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({}),
  }, 15000);
  return r.json();
}

/** Snapshot instance state for persistence. */
export async function saveInstance() {
  const r = await fetchWithTimeout('/api/v1/apps/instance/save', {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({}),
  }, 30000);
  return r.json();
}
