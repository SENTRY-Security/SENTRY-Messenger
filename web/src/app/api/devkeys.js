

// /app/api/devkeys.js
// Front-end API wrappers for device backup (wrapped_device_keys) endpoints.
// ESM only; depends on core/http. No UI logic here.

import { fetchJSON } from '../core/http.js';
import { getAccountToken, getAccountDigest } from '../core/store.js';

function buildPayload(base = {}) {
  const payload = {};
  const token = base.accountToken ?? getAccountToken();
  if (token) payload.account_token = String(token).trim();
  const digestInput = base.accountDigest ?? getAccountDigest();
  if (digestInput) {
    const cleaned = String(digestInput).replace(/[^0-9A-F]/gi, '').toUpperCase();
    if (cleaned) payload.account_digest = cleaned;
  }
  return payload;
}

/**
 * Fetch wrapped device keys for a UID.
 * @returns {Promise<{ r: Response, data: any }>} data: { wrapped_dev } | { error:'NotFound' }
 */
export async function devkeysFetch({ accountToken, accountDigest } = {}) {
  const body = buildPayload({ accountToken, accountDigest });
  return await fetchJSON('/api/v1/devkeys/fetch', body);
}

/**
 * Store wrapped device keys for a UID.
 * `session` is optional (required only for first-time initialization); when present, it must be length ≥ 8.
 * @param {{ wrapped_dev: object, session?: string }} p
 * @returns {Promise<{ r: Response, data: any }>} r.status === 204 on success
 */
export async function devkeysStore({ accountToken, accountDigest, wrapped_dev, session } = {}) {
  const body = buildPayload({ accountToken, accountDigest });
  body.wrapped_dev = wrapped_dev;
  if (session && session.length >= 8) body.session = session;
  return await fetchJSON('/api/v1/devkeys/store', body);
}
