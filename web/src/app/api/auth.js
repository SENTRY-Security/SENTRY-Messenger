

// /app/api/auth.js
// Front-end API wrappers for authentication flows.
// ESM only; depends on core/http. No UI logic here.

import { fetchJSON } from '../core/http.js';

/**
 * SDM Exchange — verify NTAG424 SDM (server-side) and obtain one-time session.
 * @param {{uid:string, sdmmac:string, sdmcounter:string|number, nonce?:string}} p
 * @returns {Promise<{ r: Response, data: any }>} data typically { session, hasMK, wrapped_mk? }
 */
export async function sdmExchange({ uid, sdmmac, sdmcounter, nonce = 'n/a' }) {
  // Keep counter as string so backend can normalize hex/dec itself
  const payload = { uid: String(uid || ''), sdmmac: String(sdmmac || ''), sdmcounter: String(sdmcounter ?? ''), nonce };
  return await fetchJSON('/api/v1/auth/sdm/exchange', payload);
}

/**
 * 取得後端產生的 SDM 除錯資料（UID、Counter、CMAC）。
 * @param {{uidHex?:string}} [p]
 * @returns {Promise<{ r: Response, data: any }>}
 */
export async function sdmDebugKit({ uidHex } = {}) {
  const payload = {};
  if (uidHex) payload.uid_hex = uidHex;
  return await fetchJSON('/api/v1/auth/sdm/debug-kit', payload);
}

/**
 * MK Store — first-time initialization: store wrapped MK on server.
 * @param {{session?:string, wrapped_mk:object}} p
 * @returns {Promise<{ r: Response, data: any }>} r.status === 204 on success
 */
export async function mkStore({ session, accountToken, accountDigest, wrapped_mk }) {
  const body = { wrapped_mk };
  if (session && session.length >= 8) body.session = session; // optional; required only for first init
  if (accountToken) body.account_token = accountToken;
  if (accountDigest) body.account_digest = accountDigest;
  return await fetchJSON('/api/v1/mk/store', body);
}

/**
 * MK Update — change password after login by updating wrapped MK.
 * @param {{accountToken:string, accountDigest:string, wrapped_mk:object}} p
 * @returns {Promise<{ r: Response, data: any }>} r.status === 204 on success
 */
export async function mkUpdate({ accountToken, accountDigest, wrapped_mk }) {
  return await fetchJSON('/api/v1/mk/update', { account_token: accountToken, account_digest: accountDigest, wrapped_mk });
}
