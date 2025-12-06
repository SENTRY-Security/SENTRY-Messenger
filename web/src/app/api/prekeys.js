

// /app/api/prekeys.js
// Front-end API wrappers for prekeys (publish/bundle).
// ESM only; depends on core/http. No UI logic here.

import { fetchJSON } from '../core/http.js';
import { getAccountToken, getAccountDigest } from '../core/store.js';

const AccountDigestRegex = /^[0-9A-F]{64}$/;

function buildAccountPayload({ accountToken, accountDigest } = {}) {
  const payload = {};
  if (accountToken) payload.accountToken = accountToken;
  const digest = accountDigest || getAccountDigest();
  if (digest && AccountDigestRegex.test(String(digest).toUpperCase())) {
    payload.accountDigest = String(digest).toUpperCase();
  }
  if (!payload.accountToken && !payload.accountDigest) {
    throw new Error('accountToken or accountDigest required');
  }
  return payload;
}

/**
 * Publish prekeys bundle for the current user.
 * Supports both full bundle (ik_pub/spk_pub/spk_sig + opks[]) and OPKs-only (replenish).
 * @param {{ bundle: { ik_pub?: string, spk_pub?: string, spk_sig?: string, opks?: Array<{id:number, pub:string}> } }} p
 * @returns {Promise<{ r: Response, data: any }>} r.status === 204 on success
 */
export async function prekeysPublish({ accountToken, accountDigest, bundle } = {}) {
  const body = buildAccountPayload({ accountToken, accountDigest });
  body.bundle = bundle;
  return await fetchJSON('/api/v1/keys/publish', body);
}

/**
 * Fetch a peer's bundle to initiate X3DH (consumes one OPK if available).
 * @param {{ peer_accountDigest: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data: { ik_pub, spk_pub, spk_sig, opk? }
 */
export async function prekeysBundle({ peer_accountDigest } = {}) {
  const digest = peer_accountDigest || null;
  if (!digest || !AccountDigestRegex.test(String(digest).toUpperCase())) {
    throw new Error('peer_accountDigest required');
  }
  return await fetchJSON('/api/v1/keys/bundle', { peer_accountDigest: String(digest).toUpperCase() });
}
