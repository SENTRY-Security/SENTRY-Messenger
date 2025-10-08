

// /app/api/prekeys.js
// Front-end API wrappers for prekeys (publish/bundle).
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
 * Publish prekeys bundle for the current user.
 * Supports both full bundle (ik_pub/spk_pub/spk_sig + opks[]) and OPKs-only (replenish).
 * @param {{ uidHex: string, bundle: { ik_pub?: string, spk_pub?: string, spk_sig?: string, opks?: Array<{id:number, pub:string}> } }} p
 * @returns {Promise<{ r: Response, data: any }>} r.status === 204 on success
 */
export async function prekeysPublish({ uidHex, accountToken, accountDigest, bundle } = {}) {
  const body = buildPayload({ uidHex, accountToken, accountDigest });
  body.bundle = bundle;
  return await fetchJSON('/api/v1/keys/publish', body);
}

/**
 * Fetch a peer's bundle to initiate X3DH (consumes one OPK if available).
 * @param {{ peer_uidHex: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data: { ik_pub, spk_pub, spk_sig, opk? }
 */
export async function prekeysBundle({ peer_uidHex, peer_accountDigest } = {}) {
  const body = {};
  if (peer_accountDigest) body.peer_accountDigest = peer_accountDigest;
  if (peer_uidHex) body.peer_uidHex = peer_uidHex;
  if (body.peer_uidHex != null) {
    const cleanedPeer = String(body.peer_uidHex).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (cleanedPeer) body.peer_uidHex = cleanedPeer; else delete body.peer_uidHex;
  }
  if (body.peer_accountDigest != null) {
    const cleanedPeerDigest = String(body.peer_accountDigest).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (cleanedPeerDigest) body.peer_accountDigest = cleanedPeerDigest; else delete body.peer_accountDigest;
  }
  return await fetchJSON('/api/v1/keys/bundle', body);
}
