

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
  if (uidHex) payload.uidHex = uidHex;
  return await fetchJSON('/api/v1/auth/sdm/debug-kit', payload);
}

/**
 * MK Store — first-time initialization: store wrapped MK on server.
 * @param {{session?:string, uidHex:string, wrapped_mk:object}} p
 * @returns {Promise<{ r: Response, data: any }>} r.status === 204 on success
 */
export async function mkStore({ session, uidHex, accountToken, accountDigest, wrapped_mk }) {
  const body = { uidHex, wrapped_mk };
  if (session && session.length >= 8) body.session = session; // optional; required only for first init
  if (accountToken) body.accountToken = accountToken;
  if (accountDigest) body.accountDigest = accountDigest;
  return await fetchJSON('/api/v1/mk/store', body);
}
