

// /app/api/devkeys.js
// Front-end API wrappers for device backup (wrapped_device_keys) endpoints.
// ESM only; depends on core/http. No UI logic here.

import { fetchJSON } from '../core/http.js';
import { getUidHex, getAccountToken, getAccountDigest } from '../core/store.js';

function buildPayload(base = {}) {
  const payload = { ...base };
  if (payload.uidHex == null) {
    const uid = getUidHex();
    if (uid) payload.uidHex = uid;
  }
  if (payload.uidHex != null) {
    const cleaned = String(payload.uidHex).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (cleaned) payload.uidHex = cleaned; else delete payload.uidHex;
  }
  if (payload.accountToken == null) {
    const token = getAccountToken();
    if (token) payload.accountToken = token;
  }
  if (payload.accountDigest == null) {
    const digest = getAccountDigest();
    if (digest) payload.accountDigest = digest;
  }
  if (payload.accountDigest != null) {
    const cleanedDigest = String(payload.accountDigest).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (cleanedDigest) payload.accountDigest = cleanedDigest; else delete payload.accountDigest;
  }
  return payload;
}

/**
 * Fetch wrapped device keys for a UID.
 * @param {{ uidHex: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data: { wrapped_dev } | { error:'NotFound' }
 */
export async function devkeysFetch({ uidHex, accountToken, accountDigest } = {}) {
  const body = buildPayload({ uidHex, accountToken, accountDigest });
  return await fetchJSON('/api/v1/devkeys/fetch', body);
}

/**
 * Store wrapped device keys for a UID.
 * `session` is optional (required only for first-time initialization); when present, it must be length ≥ 8.
 * @param {{ uidHex: string, wrapped_dev: object, session?: string }} p
 * @returns {Promise<{ r: Response, data: any }>} r.status === 204 on success
 */
export async function devkeysStore({ uidHex, accountToken, accountDigest, wrapped_dev, session } = {}) {
  const body = buildPayload({ uidHex, accountToken, accountDigest });
  body.wrapped_dev = wrapped_dev;
  if (session && session.length >= 8) body.session = session;
  return await fetchJSON('/api/v1/devkeys/store', body);
}
