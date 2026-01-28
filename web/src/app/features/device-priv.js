// /app/features/device-priv.js
// Shared helpers for ensuring the device private bundle (IK/SPK/OPKs) is loaded in-memory.
// Removes legacy fallback that refetched devkeys from the API; we now rely on login handoff.

import {
  getDevicePriv,
  setDevicePriv,
  getMkRaw,
  waitForDevicePriv
} from '../core/store.js';
import { unwrapDevicePrivWithMK } from '../crypto/prekeys.js';

let restoreInFlight = null;

async function attemptRestoreFromSession() {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem('wrapped_dev');
  if (!raw) return null;
  const mk = getMkRaw();
  if (!mk || !(mk instanceof Uint8Array) || mk.length === 0) {
    // MK 還沒解鎖，保留 wrapped_dev 讓後續流程再嘗試。
    return null;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[device-priv] wrapped_dev parse failed', err);
    sessionStorage.removeItem('wrapped_dev');
    return null;
  }
  try {
    const priv = await unwrapDevicePrivWithMK(parsed, mk);
    if (priv) {
      setDevicePriv(priv);
      sessionStorage.removeItem('wrapped_dev');
      return priv;
    }
  } catch (err) {
    console.warn('[device-priv] unwrap failed', err);
    sessionStorage.removeItem('wrapped_dev');
  }
  return null;
}

async function restoreDevicePrivFromSession() {
  if (restoreInFlight) return restoreInFlight;
  restoreInFlight = attemptRestoreFromSession()
    .catch(() => null)
    .finally(() => {
      restoreInFlight = null;
    });
  return restoreInFlight;
}

/**
 * Ensure device private bundle is ready in memory.
 * - Returns immediately if store already has a bundle.
 * - Otherwise waits for any ongoing restoration, tries sessionStorage once, then waits for setters.
 * - Throws a descriptive error instead of silently reinitializing or fetching from API.
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function ensureDevicePrivAvailable({ timeoutMs = 4000 } = {}) {
  const existing = getDevicePriv();
  if (existing) return existing;

  const restored = await restoreDevicePrivFromSession();
  if (restored) return restored;

  const awaited = await waitForDevicePriv({ timeoutMs }).catch(() => null);
  if (awaited) return awaited;

  const mk = getMkRaw();
  if (!mk || !(mk instanceof Uint8Array) || mk.length === 0) {
    throw new Error('尚未解鎖主金鑰，請重新登入完成初始化');
  }
  throw new Error('找不到裝置金鑰，請重新登入完成初始化');
}
