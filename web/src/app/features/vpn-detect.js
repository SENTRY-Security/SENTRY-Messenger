// VPN/Proxy detection via free external APIs (HTTPS)
// Strategy: try multiple free APIs in order, return first successful result.

import { log } from '../core/log.js';

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Detect whether the current connection uses a VPN/Proxy.
 * Tries multiple HTTPS-compatible free APIs in order.
 * @returns {Promise<{ vpn: boolean, ip: string, isp: string, country: string } | null>}
 */
export async function detectVpn() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL) return _cache;

  // Try providers in order — first success wins
  const providers = [tryIpwhoIs, tryIpapiCo];

  for (const provider of providers) {
    try {
      const result = await provider();
      if (result) {
        _cache = result;
        _cacheTs = Date.now();
        log({ vpnDetected: result.vpn, provider: result._provider });
        return result;
      }
    } catch (err) {
      log({ vpnProviderError: err?.message || err });
    }
  }

  log({ vpnDetect: 'all providers failed' });
  return null;
}

/**
 * Provider 1: ipwho.is — free, no key, HTTPS, no hard rate limit
 * Docs: https://ipwho.is/
 */
async function tryIpwhoIs() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch('https://ipwho.is/', {
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.success && data.success !== undefined) return null;

    return {
      vpn: Boolean(data.security?.vpn || data.security?.proxy || data.security?.tor),
      ip: data.ip || '',
      isp: data.connection?.isp || '',
      country: data.country || '',
      _provider: 'ipwho.is'
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Provider 2: ipapi.co — free tier 1000 req/day, HTTPS
 * Docs: https://ipapi.co/api/
 */
async function tryIpapiCo() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch('https://ipapi.co/json/', {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const data = await res.json();
    if (data.error) return null;

    // ipapi.co doesn't have direct VPN field — infer from org/asn
    // Hosting/datacenter ASNs are a proxy signal
    const orgLower = (data.org || '').toLowerCase();
    const isHosting = /cloudflare|amazon|google|microsoft|digitalocean|linode|vultr|hetzner|ovh|datacenter/i.test(orgLower);

    return {
      vpn: isHosting,
      ip: data.ip || '',
      isp: data.org || '',
      country: data.country_name || '',
      _provider: 'ipapi.co'
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/** Clear cached VPN detection result. */
export function clearVpnCache() {
  _cache = null;
  _cacheTs = 0;
}
