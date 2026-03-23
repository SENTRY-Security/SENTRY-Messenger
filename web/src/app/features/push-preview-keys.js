// E2E push preview: fetch & cache recipient preview public keys
// Used by sender to encrypt push notification preview text per device.

import { fetchWithTimeout, jsonReq } from '../core/http.js';

// In-memory cache: accountDigest → { keys: [{deviceId, previewPublicKey}], ts }
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch preview public keys for a recipient account.
 * Returns an array of { deviceId, previewPublicKey } (may be empty if recipient
 * has no preview-enabled push subscriptions).
 * Results are cached for 5 minutes.
 */
export async function getPreviewKeys(recipientAccountDigest) {
  if (!recipientAccountDigest) return [];
  const key = recipientAccountDigest.toUpperCase();
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.keys;

  try {
    const r = await fetchWithTimeout('/d1/push/preview-keys', jsonReq({
      accountDigest: key
    }), 8000);
    if (!r.ok) return cached?.keys || [];
    const data = await r.json();
    const keys = Array.isArray(data?.keys) ? data.keys.filter(k => k.previewPublicKey) : [];
    _cache.set(key, { keys, ts: Date.now() });
    return keys;
  } catch {
    return cached?.keys || [];
  }
}

/** Clear cache for a specific account (e.g., on resubscribe). */
export function invalidatePreviewKeys(accountDigest) {
  if (accountDigest) _cache.delete(accountDigest.toUpperCase());
}
