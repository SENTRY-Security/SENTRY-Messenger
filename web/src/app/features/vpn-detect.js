// VPN/Proxy detection via free external API (ip-api.com)
// Returns { vpn: boolean, ip: string, isp: string, country: string } or null on failure.

import { log } from '../core/log.js';

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Detect whether the current connection uses a VPN/Proxy.
 * Uses ip-api.com free tier (45 req/min, HTTP only for free).
 * @returns {Promise<{ vpn: boolean, hosting: boolean, ip: string, isp: string, country: string } | null>}
 */
export async function detectVpn() {
  // Return cached result if fresh
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL) return _cache;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    // ip-api.com free tier requires HTTP (not HTTPS) — fields param limits response
    const res = await fetch(
      'http://ip-api.com/json/?fields=status,query,isp,country,proxy,hosting',
      { signal: controller.signal, cache: 'no-store' }
    );
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'success') return null;

    const result = {
      vpn: Boolean(data.proxy || data.hosting),
      hosting: Boolean(data.hosting),
      ip: data.query || '',
      isp: data.isp || '',
      country: data.country || ''
    };

    _cache = result;
    _cacheTs = Date.now();
    return result;
  } catch (err) {
    log({ vpnDetectError: err?.message || err });
    return null;
  }
}

/** Clear cached VPN detection result. */
export function clearVpnCache() {
  _cache = null;
  _cacheTs = 0;
}
