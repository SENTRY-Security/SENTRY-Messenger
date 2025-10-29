// /app/features/login-flow.js
// Login flows for SENTRY Message (front-end):
//  - exchangeSDM({ uidHex, sdmmac, sdmcounter, nonce })
//  - unlockAndInit({ password })
// This module updates the centralized in-memory store and calls backend APIs
// via core/http. It does not do any UI or redirection.

// core deps
import { sdmExchange, mkStore } from '../api/auth.js';
import { devkeysFetch, devkeysStore } from '../api/devkeys.js';
import { prekeysPublish } from '../api/prekeys.js';
import {
  getSession, setSession,
  getHasMK, setHasMK,
  getWrappedMK, setWrappedMK,
  getUidHex, setUidHex,
  getMkRaw, setMkRaw,
  getDevicePriv, setDevicePriv,
  getAccountToken, setAccountToken,
  getAccountDigest, setAccountDigest,
  getUidDigest, setUidDigest,
  getOpaqueServerId, setOpaqueServerId
} from '../core/store.js';

// crypto deps
import {
  wrapMKWithPasswordArgon2id,
  unwrapMKWithPasswordArgon2id
} from '../crypto/kdf.js';

import {
  wrapDevicePrivWithMK,
  unwrapDevicePrivWithMK,
  generateInitialBundle,
  generateOpksFrom
} from '../crypto/prekeys.js';
import { ensureOpaque } from './opaque.js';

/** Convert any error to a readable message */
function asMsg(e, fallback) {
  if (!e) return fallback || 'unknown error';
  if (typeof e === 'string') return e;
  const name = e.name ? String(e.name) : '';
  const msg  = e.message ? String(e.message) : '';
  if (msg) return msg;
  if (name) return name;
  try { return String(e); } catch { /* noop */ }
  return fallback || 'unknown error';
}

/**
 * Normalize hex helpers
 */
function normHex(s) { return String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase(); }

function peekWrappedDevHandoff() {
  let raw = null;
  if (typeof sessionStorage !== 'undefined') {
    try {
      raw = sessionStorage.getItem('wrapped_dev');
    } catch {
      raw = null;
    }
  }
  if (!raw && typeof localStorage !== 'undefined') {
    try {
      raw = localStorage.getItem('wrapped_dev_handoff');
    } catch {
      raw = null;
    }
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    try { console.warn('[login-flow] wrapped_dev parse failed', err?.message || err); } catch {}
    return null;
  }
}

/**
 * 1) SDM Exchange — call /api/v1/auth/sdm/exchange and update store
 * @param {{uidHex:string, sdmmac:string, sdmcounter:string|number, nonce?:string}} p
 * @returns {Promise<{session:string|null, hasMK:boolean, wrapped_mk?:object}>}
 */
export async function exchangeSDM(p) {
  const uidHex = normHex(p.uidHex);
  const sdmmac = normHex(p.sdmmac);
  const sdmcounter = (p.sdmcounter ?? '').toString(); // keep as string; backend will normalize hex/dec
  const nonce = p.nonce || 'n/a';

  if (!uidHex || uidHex.length < 14) throw new Error('UID hex (14) required');
  if (!sdmmac || sdmmac.length < 16) throw new Error('SDM MAC (16) required');

  const { r, data } = await sdmExchange({ uid: uidHex, sdmmac, sdmcounter, nonce });
  if (!r.ok) throw new Error(`sdm.exchange failed: ${typeof data === 'string' ? data : JSON.stringify(data)}`);

  setUidHex(uidHex);
  setSession(data.session || null);
  setHasMK(!!data.hasMK);
  setWrappedMK(data.wrapped_mk || null);
  if (data.accountToken) setAccountToken(data.accountToken);
  if (data.account_token) setAccountToken(data.account_token);
  if (data.accountDigest) setAccountDigest(data.accountDigest);
  if (data.account_digest) setAccountDigest(data.account_digest);
  if (data.uidDigest) setUidDigest(data.uidDigest);
  if (data.uid_digest) setUidDigest(data.uid_digest);
  if (Object.prototype.hasOwnProperty.call(data, 'opaqueServerId') || Object.prototype.hasOwnProperty.call(data, 'opaque_server_id')) {
    setOpaqueServerId(data.opaqueServerId || data.opaque_server_id || null);
  } else {
    setOpaqueServerId(null);
  }

  return {
    session: getSession(),
    hasMK: getHasMK(),
    wrapped_mk: getWrappedMK() || undefined,
    accountToken: getAccountToken() || data.accountToken || data.account_token || null,
    accountDigest: getAccountDigest() || data.accountDigest || data.account_digest || null,
    uidDigest: getUidDigest() || data.uidDigest || data.uid_digest || null
  };
}

/**
 * 2) Unlock & Init — derive KEK from password to unwrap MK (or first-time wrap & store),
 * then ensure device prekeys exist and are replenished. Returns a summary object.
 * @param {{password:string}} p
 * @returns {Promise<{unlocked:boolean, initialized:boolean, replenished:boolean, next_opk_id?:number}>}
 */
export async function unlockAndInit({ password, onProgress } = {}) {
  const pwd = String(password || '');
  if (!pwd) throw new Error('password required');
  if (!getSession()) throw new Error('SDM exchange required');

  const report = (step, status, detail) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress(step, status, detail);
      } catch {
        // ignore progress callback errors
      }
    }
  };

  const runStep = async (step, fn) => {
    report(step, 'start');
    try {
      const result = await fn();
      report(step, 'success');
      return result;
    } catch (err) {
      report(step, 'error', err?.message || err);
      throw err;
    }
  };

  const hadWrappedMK = getHasMK();
  const uidHex = getUidHex();
  if (!uidHex) throw new Error('uid not set');
  let accountToken = getAccountToken();
  let accountDigest = getAccountDigest();
  if (!accountToken || !accountDigest) throw new Error('Account info missing: please redo SDM exchange');

  // Enforce OPAQUE authentication (no fallback)
  const serverId = getOpaqueServerId();
  await runStep('opaque', () => ensureOpaque({ password: pwd, accountDigest, serverId }));
  // Refresh account credentials in case ensureOpaque updated them
  accountToken = getAccountToken();
  accountDigest = getAccountDigest();
  if (!accountToken || !accountDigest) {
    throw new Error('Account info missing: please redo SDM exchange');
  }

  let unlocked = false;
  let initialized = false;
  let replenished = false;
  let nextId;
  let wrappedDevEnvelope = null;

  if (getHasMK()) {
    report('wrap-mk', 'skip');
    report('mk-store', 'skip');
    // unwrap existing MK
    try {
      const mk = await unwrapMKWithPasswordArgon2id(pwd, getWrappedMK());
      if (!mk) throw new Error('wrong password or envelope mismatch');
      setMkRaw(mk);
      unlocked = true;
    } catch (e) {
      throw new Error('Unlock failed: ' + asMsg(e, 'wrong password or envelope mismatch'));
    }
  } else {
    // first-time init MK → wrap → /mk/store
    try {
      report('wrap-mk', 'start');
      const mk = crypto.getRandomValues(new Uint8Array(32));
      setMkRaw(mk);
      const wrapped_mk = await wrapMKWithPasswordArgon2id(pwd, mk);
      report('wrap-mk', 'success');
      report('mk-store', 'start');
      const { r } = await mkStore({
        session: getSession(),
        uidHex,
        accountToken,
        accountDigest,
        wrapped_mk
      });
      if (r.status !== 204) {
        report('mk-store', 'error', 'HTTP ' + r.status);
        throw new Error('mk.store failed (status ' + r.status + ')');
      }
      report('mk-store', 'success');
      setSession(null); setHasMK(true); setWrappedMK(wrapped_mk);
      unlocked = true; initialized = true;
    } catch (e) {
      if (!initialized) {
        const message = asMsg(e);
        if (String(message || '').includes('mk.store')) {
          report('mk-store', 'error', message);
        } else {
          report('wrap-mk', 'error', message);
        }
      }
      throw new Error('Initialize MK failed: ' + asMsg(e));
    }
  }

  // Ensure device bundle / replenish OPKs
  const fetchDevkeys = async () => {
    const { r, data } = await devkeysFetch({ accountToken, accountDigest });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('devkeys.fetch failed');
    return data;
  };

  const publishBundle = async (bundlePub) => {
    const { r } = await prekeysPublish({ uidHex, accountToken, accountDigest, bundle: bundlePub });
    if (r.status !== 204) throw new Error('keys.publish failed');
    return true;
  };

  const storeDevkeys = async (session, wrapped_dev) => {
    const { r } = await devkeysStore({ accountToken, accountDigest, wrapped_dev, session });
    if (r.status !== 204) throw new Error('devkeys.store failed');
    return true;
  };

  // Try existing backup
  report('devkeys-fetch', 'start');
  let existing = null;
  try {
    existing = await fetchDevkeys();
    if (!existing) {
      report('devkeys-fetch', 'info', '未找到裝置備份');
    } else {
      report('devkeys-fetch', 'success');
    }
  } catch (err) {
    report('devkeys-fetch', 'error', err?.message || err);
    throw err;
  }
  let hasExistingBackup = !!(existing && existing.wrapped_dev);
  const fallbackWrappedDev = hadWrappedMK ? peekWrappedDevHandoff() : null;
  if (!hasExistingBackup && fallbackWrappedDev) {
    try {
      report('devkeys-store', 'start');
      await storeDevkeys(undefined, fallbackWrappedDev);
      existing = { wrapped_dev: fallbackWrappedDev };
      hasExistingBackup = true;
      report('devkeys-store', 'success');
    } catch (err) {
      report('devkeys-store', 'error', err?.message || err);
      try { console.warn('[login-flow] devkeys fallback store failed', err?.message || err); } catch {}
    }
  }
  if (hasExistingBackup) {
    wrappedDevEnvelope = existing.wrapped_dev;
  }
  if (!hasExistingBackup) {
    if (hadWrappedMK && !fallbackWrappedDev) {
      try { console.warn('[login-flow] device backup missing; regenerating bundle'); } catch {}
    }
    // full init path: generate bundle (+100), publish, store backup
    try {
      report('generate-bundle', 'start');
      const { devicePriv, bundlePub } = await generateInitialBundle(1, 100);
      report('generate-bundle', 'success', { opkCount: bundlePub?.opks?.length || 0 });
      setDevicePriv(devicePriv);
      await runStep('prekeys-publish', () => publishBundle(bundlePub));
      const wrapped_dev = await runStep('wrap-device', () => wrapDevicePrivWithMK(devicePriv, getMkRaw()));
      await runStep('devkeys-store', () => storeDevkeys(getSession(), wrapped_dev));
      initialized = true;
      nextId = devicePriv.next_opk_id;
      wrappedDevEnvelope = wrapped_dev;
    } catch (e) {
      if (!initialized) report('generate-bundle', 'error', e?.message || e);
      throw new Error('Prekeys initialization failed: ' + asMsg(e));
    }
  } else {
    // replenish path — report step-specific errors，禁止自動重建
    try {
      let devicePriv;
      devicePriv = await runStep('wrap-device', async () => {
        try {
          return await unwrapDevicePrivWithMK(existing.wrapped_dev, getMkRaw());
        } catch (e) {
          throw new Error('Device backup unwrap failed: ' + asMsg(e));
        }
      });

      setDevicePriv(devicePriv);
      const { opks, next } = await generateOpksFrom(devicePriv.next_opk_id || 1, 20);
      if (opks.length > 0) {
        report('generate-bundle', 'start');
        report('prekeys-publish', 'start');
        try {
          await publishBundle({ opks });
        } catch (e) {
          report('prekeys-publish', 'error', e?.message || e);
          report('generate-bundle', 'error', e?.message || e);
          throw new Error('keys.publish (replenish) failed: ' + asMsg(e));
        }
        devicePriv.next_opk_id = next;
        report('generate-bundle', 'success', { opkCount: opks.length });
        report('prekeys-publish', 'success');
        const wrapped_dev = await runStep('wrap-device', () => wrapDevicePrivWithMK(devicePriv, getMkRaw()));
        try {
          report('devkeys-store', 'start');
          await storeDevkeys(undefined, wrapped_dev);
          report('devkeys-store', 'success');
        } catch (e) {
          report('devkeys-store', 'error', e?.message || e);
          throw new Error('devkeys.store (replenish) failed: ' + asMsg(e));
        }
        replenished = true;
        nextId = next;
        wrappedDevEnvelope = wrapped_dev;
      } else {
        report('generate-bundle', 'skip');
        report('prekeys-publish', 'skip');
        report('wrap-device', 'success');
        report('devkeys-store', 'skip');
      }
    } catch (e) {
      if (!replenished) report('generate-bundle', 'error', e?.message || e);
      throw new Error('Prekeys replenish failed: ' + asMsg(e));
    }
  }

  return { unlocked, initialized, replenished, next_opk_id: nextId, wrapped_dev: wrappedDevEnvelope };
}
