import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload } from '../core/store.js';
import { log } from '../core/log.js';

function buildAccountHeaders() {
  const payload = buildAccountPayload();
  const headers = {};
  if (payload.accountToken) headers['X-Account-Token'] = payload.accountToken;
  if (payload.accountDigest) headers['X-Account-Digest'] = payload.accountDigest;
  return headers;
}

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function uploadContactSecretsBackup({
  payload,
  checksum,
  snapshotVersion,
  entries,
  updatedAt,
  bytes,
  withDrState,
  deviceLabel,
  deviceId,
  reason
} = {}, fetchOptions = {}) {
  const overrides = { payload, reason: reason || 'auto' };
  if (checksum != null) overrides.checksum = checksum;
  if (snapshotVersion != null) overrides.snapshotVersion = snapshotVersion;
  if (Number.isFinite(entries)) overrides.entries = entries;
  if (Number.isFinite(updatedAt)) overrides.updatedAt = updatedAt;
  if (Number.isFinite(bytes)) overrides.bytes = bytes;
  if (Number.isFinite(withDrState)) overrides.withDrState = withDrState;
  if (deviceLabel) overrides.deviceLabel = deviceLabel;
  if (deviceId) overrides.deviceId = deviceId;
  const body = buildAccountPayload({ overrides });
  const request = jsonReq(body);
  const merged = { ...request, ...fetchOptions };
  const r = await fetchWithTimeout('/api/v1/contact-secrets/backup', merged, 20000);
  const data = safeParse(await r.text());
  log({ contactSecretsBackupUpload: { status: r.status, ok: r.ok } });
  return { r, data };
}

export async function fetchContactSecretsBackup({ limit = 1, version } = {}) {
  const headers = buildAccountHeaders();
  const qs = new URLSearchParams();
  if (limit) qs.set('limit', String(limit));
  if (version) qs.set('version', String(version));
  const url = `/api/v1/contact-secrets/backup?${qs.toString()}`;
  const r = await fetchWithTimeout(url, { method: 'GET', headers }, 20000);
  const data = safeParse(await r.text());
  log({ contactSecretsBackupFetch: { status: r.status, ok: r.ok } });
  return { r, data };
}
