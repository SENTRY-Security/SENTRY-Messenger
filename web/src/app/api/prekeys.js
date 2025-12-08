

// /app/api/prekeys.js
// Front-end API wrappers for prekeys (publish/bundle).
// ESM only; depends on core/http. No UI logic here.

import { fetchJSON } from '../core/http.js';
import { getAccountToken, getAccountDigest, getDeviceId } from '../core/store.js';

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
 * @param {{ deviceId?:string, signedPrekey:{id:number,pub:string,sig:string}, opks?: Array<{id:number, pub:string}> }} p
 * @returns {Promise<{ r: Response, data: any }>} data.ok === true on success
 */
export async function prekeysPublish({ accountToken, accountDigest, deviceId, signedPrekey, opks } = {}) {
  const body = buildAccountPayload({ accountToken, accountDigest });
  const device = deviceId || getDeviceId();
  if (device) body.deviceId = device;
  if (signedPrekey) body.signedPrekey = signedPrekey;
  if (Array.isArray(opks)) body.opks = opks;
  return await fetchJSON('/api/v1/keys/publish', body);
}

/**
 * Fetch a peer's bundle to initiate X3DH (consumes one OPK if available).
 * @param {{ peer_accountDigest: string, peer_deviceId?: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data: { deviceId, signedPrekey, opk }
 */
export async function prekeysBundle({ peer_accountDigest, peer_deviceId } = {}) {
  const digest = peer_accountDigest || null;
  if (!digest || !AccountDigestRegex.test(String(digest).toUpperCase())) {
    throw new Error('peer_accountDigest required');
  }
  const body = { peer_accountDigest: String(digest).toUpperCase() };
  if (peer_deviceId) body.peer_deviceId = String(peer_deviceId).trim();
  return await fetchJSON('/api/v1/keys/bundle', body);
}
