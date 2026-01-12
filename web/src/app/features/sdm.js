

// /app/features/sdm.js
// Feature: Parse NTAG424 SDM parameters from URL and perform background exchange.
// This module has no UI code. It can be called from any page.

import { exchangeSDM } from './login-flow.js';
import {
  getSession, setSession,
  getHasMK, setHasMK,
  getWrappedMK, setWrappedMK,
  getAccountToken, getAccountDigest
} from '../core/store.js';

/** Normalize hex string (keep 0-9a-f, uppercased) */
export function normHex(s) {
  return String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/**
 * Parse SDM params from a URL or a given query-like object.
 * Accepted keys (case-insensitive): uid | UID, sdmmac | mac, sdmcounter | ctr, nonce
 * @param {string} [url] - optional full URL; defaults to location.href if available
 * @returns {{ uidHex:string, sdmmac:string, sdmcounter:string, nonce:string } | null}
 */
export function parseSdmParams(url) {
  try {
    const href = url || (typeof location !== 'undefined' ? location.href : '');
    if (!href) return null;
    const q = new URL(href).searchParams;
    const uid = normHex(q.get('uid') || q.get('UID'));
    const mac = normHex(q.get('sdmmac') || q.get('mac'));
    const ctr = (q.get('sdmcounter') || q.get('ctr') || '');
    const nonce = q.get('nonce') || 'n/a';
    if (!uid || uid.length < 14) return null;
    if (!mac || mac.length < 16) return null;
    if (!ctr && ctr !== '0') return null;
    return { uidHex: uid, sdmmac: mac, sdmcounter: String(ctr), nonce };
  } catch {
    return null;
  }
}

/**
 * Perform SDM exchange using params parsed from URL (if present).
 * Side effects:
 *  - Writes { uidHex, session, hasMK, wrapped_mk } to the centralized store
 * @param {string} [url]
 * @returns {Promise<{ performed:boolean, session?:string|null, hasMK?:boolean, wrapped?:boolean, uidHex?:string }>} 
 */
export async function exchangeFromURLIfPresent(url) {
  const p = parseSdmParams(url);
  if (!p) return { performed: false };
  const res = await exchangeSDM(p); // updates store internally
  return {
    performed: true,
    session: getSession(),
    hasMK: getHasMK(),
    wrapped: !!getWrappedMK(),
    uidHex: p.uidHex,
    accountToken: getAccountToken() || null,
    accountDigest: getAccountDigest() || null
  };
}

/**
 * Convenience function to inject params manually (non-URL flows), then do exchange.
 * @param {{ uidHex:string, sdmmac:string, sdmcounter:string|number, nonce?:string }} p
 * @returns {Promise<{ session:string|null, hasMK:boolean, wrapped:boolean }>} 
 */
export async function exchangeWithParams(p) {
  const payload = {
    uidHex: normHex(p.uidHex),
    sdmmac: normHex(p.sdmmac),
    sdmcounter: String(p.sdmcounter ?? ''),
    nonce: p.nonce || 'n/a'
  };
  const { uidHex } = payload;
  if (!uidHex || uidHex.length < 14) throw new Error('UID hex (14) required');
  if (!payload.sdmmac || payload.sdmmac.length < 16) throw new Error('SDM MAC (16) required');
  await exchangeSDM(payload); // updates store
  return {
    session: getSession(),
    hasMK: getHasMK(),
    wrapped: !!getWrappedMK(),
    accountToken: getAccountToken() || null,
    accountDigest: getAccountDigest() || null
  };
}
