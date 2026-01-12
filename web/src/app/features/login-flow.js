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
import { fetchAccountEvidence } from '../api/account.js';
import { log } from '../core/log.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';
import {
  getSession, setSession,
  getHasMK, setHasMK,
  getWrappedMK, setWrappedMK,
  getMkRaw, setMkRaw,
  getDevicePriv, setDevicePriv,
  getAccountToken, setAccountToken,
  getAccountDigest, setAccountDigest,
  getOpaqueServerId, setOpaqueServerId,
  getDeviceId, setDeviceId
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
  const msg = e.message ? String(e.message) : '';
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
    try { console.warn('[login-flow] wrapped_dev parse failed', err?.message || err); } catch { }
    return null;
  }
}

function summarizeMkForLog(mkRaw) {
  const summary = { mkLen: mkRaw instanceof Uint8Array ? mkRaw.length : 0, mkHash12: null };
  if (!(mkRaw instanceof Uint8Array) || typeof crypto === 'undefined' || !crypto.subtle?.digest) return Promise.resolve(summary);
  return crypto.subtle.digest('SHA-256', mkRaw).then((digest) => {
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    summary.mkHash12 = hex.slice(0, 12);
    return summary;
  }).catch(() => summary);
}

let mkSetTraceLogged = false;
async function emitMkSetTrace(sourceTag, mkRaw) {
  if (mkSetTraceLogged) return;
  mkSetTraceLogged = true;
  try {
    const { mkLen, mkHash12 } = await summarizeMkForLog(mkRaw);
    log({
      mkSetTrace: {
        sourceTag,
        mkLen,
        mkHash12,
        accountDigestSuffix4: (getAccountDigest() || '').slice(-4) || null,
        deviceIdSuffix4: (getDeviceId() || '').slice(-4) || null
      }
    });
  } catch { }
}

let identityTraceCount = 0;
function emitIdentityTrace(payload) {
  if (!DEBUG.identityTrace || identityTraceCount >= 5) return;
  identityTraceCount += 1;
  try {
    log({ identityTrace: payload });
  } catch { }
}

function normalizeEvidencePayload(raw = {}) {
  const ev = raw?.evidence || {};
  const backupDeviceId = typeof ev.backupDeviceId === 'string' && ev.backupDeviceId.trim()
    ? ev.backupDeviceId.trim()
    : null;
  const backupDeviceLabel = typeof ev.backupDeviceLabel === 'string' && ev.backupDeviceLabel.trim()
    ? ev.backupDeviceLabel
    : null;
  return {
    backupExists: !!ev.backupExists,
    vaultExists: !!ev.vaultExists,
    messagesExists: !!ev.messagesExists,
    backupDeviceId,
    backupDeviceLabel,
    backupUpdatedAt: Number(ev.backupUpdatedAt) || null,
    registryDeviceId: typeof ev.registryDeviceId === 'string' && ev.registryDeviceId.trim() ? ev.registryDeviceId.trim() : null,
    registryDeviceLabel: typeof ev.registryDeviceLabel === 'string' && ev.registryDeviceLabel.trim() ? ev.registryDeviceLabel : null
  };
}

async function fetchServerEvidenceStrict({ accountToken, accountDigest }) {
  const { r, data } = await fetchAccountEvidence({ accountToken, accountDigest });
  if (!r?.ok) {
    throw new Error(`MK_EVIDENCE_FETCH_FAILED_HTTP_${r?.status ?? 'unknown'}`);
  }
  if (!data || data.error) {
    throw new Error(typeof data?.message === 'string' ? data.message : 'MK_EVIDENCE_FETCH_FAILED');
  }
  const evidence = normalizeEvidencePayload(data);
  const hasEvidence = !!(evidence.backupExists || evidence.vaultExists || evidence.messagesExists);
  return { evidence, hasEvidence, raw: data };
}

async function maybeRestoreDeviceIdFromEvidence(evidence) {
  if (getDeviceId()) return null;
  const preferred = (typeof evidence?.registryDeviceId === 'string' && evidence.registryDeviceId.trim())
    ? evidence.registryDeviceId.trim()
    : null;
  const candidate = preferred
    || (typeof evidence?.backupDeviceId === 'string' && evidence.backupDeviceId.trim() ? evidence.backupDeviceId.trim() : null);
  if (!candidate) return null;
  setDeviceId(candidate);
  try {
    const mkSummary = await summarizeMkForLog(getMkRaw());
    log({
      deviceIdRestoreTrace: {
        sourceTag: 'login:server-evidence',
        serverHasMK: getHasMK(),
        mkHash12: mkSummary.mkHash12,
        accountDigestSuffix4: (getAccountDigest() || '').slice(-4) || null,
        deviceIdSuffix4: candidate.slice(-4) || null,
        deviceIdSource: preferred ? 'registry' : 'backup',
        registryDeviceIdSuffix4: preferred ? preferred.slice(-4) : null,
        backupDeviceIdSuffix4: evidence?.backupDeviceId ? evidence.backupDeviceId.slice(-4) : null,
        evidence: {
          backup: !!evidence?.backupExists,
          vault: !!evidence?.vaultExists,
          messages: !!evidence?.messagesExists
        }
      }
    });
  } catch { }
  return candidate;
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

  setSession(data.session || null);
  setHasMK(!!data.hasMK);
  setWrappedMK(data.wrapped_mk || null);
  if (data.accountToken) setAccountToken(data.accountToken);
  if (data.account_token) setAccountToken(data.account_token);
  if (data.accountDigest) setAccountDigest(data.accountDigest);
  if (data.account_digest) setAccountDigest(data.account_digest);
  if (Object.prototype.hasOwnProperty.call(data, 'opaqueServerId') || Object.prototype.hasOwnProperty.call(data, 'opaque_server_id')) {
    setOpaqueServerId(data.opaqueServerId || data.opaque_server_id || null);
  } else {
    setOpaqueServerId(null);
  }

  emitIdentityTrace({
    sourceTag: 'sdm-exchange',
    uidHexSuffix4: uidHex ? uidHex.slice(-4) : null,
    uidDigestSuffix4: data?.uidDigest ? String(data.uidDigest).slice(-4) : null,
    accountDigestSuffix4: (getAccountDigest() || data.accountDigest || data.account_digest || '').slice(-4) || null,
    hasMK: !!data?.hasMK
  });

  return {
    session: getSession(),
    hasMK: getHasMK(),
    wrapped_mk: getWrappedMK() || undefined,
    accountToken: getAccountToken() || data.accountToken || data.account_token || null,
    accountDigest: getAccountDigest() || data.accountDigest || data.account_digest || null
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
  const initialSession = getSession();
  if (!initialSession) throw new Error('SDM exchange required');

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
  report('prekeys-sync', 'skip');

  const evidenceResult = await runStep('mk-evidence', async () => {
    try {
      return await fetchServerEvidenceStrict({ accountToken, accountDigest });
    } catch (err) {
      const mkSummary = await summarizeMkForLog(getMkRaw());
      log({
        mkHardblockTrace: {
          sourceTag: 'login:evidence-fetch',
          reason: 'evidence_fetch_failed',
          serverHasMK: getHasMK(),
          mkHash12: mkSummary.mkHash12,
          accountDigestSuffix4: (accountDigest || '').slice(-4) || null,
          deviceIdSuffix4: (getDeviceId() || '').slice(-4) || null,
          evidence: null,
          errorMessage: asMsg(err, 'evidence_fetch_failed')
        }
      });
      throw err;
    }
  });
  const evidence = evidenceResult?.evidence || {};
  const hasServerEvidence = !!evidenceResult?.hasEvidence;
  const evidenceDeviceId = evidence?.registryDeviceId || evidence?.backupDeviceId || null;
  await maybeRestoreDeviceIdFromEvidence(evidence);

  if (getHasMK()) {
    report('wrap-mk', 'skip');
    report('mk-store', 'skip');
    // unwrap existing MK
    try {
      const mk = await unwrapMKWithPasswordArgon2id(pwd, getWrappedMK());
      if (!mk) throw new Error('wrong password or envelope mismatch');
      setMkRaw(mk);
      emitMkSetTrace('login:unwrap-existing', mk);
      unlocked = true;
    } catch (e) {
      const mkSummary = await summarizeMkForLog(getMkRaw());
      log({
        mkUnwrapHardblockTrace: {
          sourceTag: 'login:unwrap-existing',
          reason: 'unwrap_failed',
          serverHasMK: true,
          mkHash12: mkSummary.mkHash12,
          accountDigestSuffix4: (accountDigest || '').slice(-4) || null,
          deviceIdSuffix4: (getDeviceId() || evidenceDeviceId || '').slice(-4) || null,
          evidence: {
            backup: !!evidence?.backupExists,
            vault: !!evidence?.vaultExists,
            messages: !!evidence?.messagesExists,
            registryDeviceIdSuffix4: evidence?.registryDeviceId ? evidence.registryDeviceId.slice(-4) : null,
            backupDeviceIdSuffix4: evidence?.backupDeviceId ? evidence.backupDeviceId.slice(-4) : null
          },
          errorMessage: asMsg(e, 'unwrap_failed')
        }
      });
      throw new Error('MK_UNWRAP_FAILED_HARDBLOCK');
    }
  } else {
    if (hasServerEvidence) {
      const mkSummary = await summarizeMkForLog(getMkRaw());
      log({
        mkHardblockTrace: {
          sourceTag: 'login:hasMK=false',
          reason: 'server_evidence_present',
          serverHasMK: false,
          mkHash12: mkSummary.mkHash12,
          accountDigestSuffix4: (accountDigest || '').slice(-4) || null,
          deviceIdSuffix4: (getDeviceId() || evidenceDeviceId || '').slice(-4) || null,
          evidence: {
            backup: !!evidence?.backupExists,
            vault: !!evidence?.vaultExists,
            messages: !!evidence?.messagesExists,
            registryDeviceIdSuffix4: evidence?.registryDeviceId ? evidence.registryDeviceId.slice(-4) : null,
            backupDeviceIdSuffix4: evidence?.backupDeviceId ? evidence.backupDeviceId.slice(-4) : null
          }
        }
      });
      throw new Error('MK_MISSING_HARDBLOCK');
    }
    // first-time init MK → wrap → /mk/store
    try {
      report('wrap-mk', 'start');
      const mk = crypto.getRandomValues(new Uint8Array(32));
      setMkRaw(mk);
      emitMkSetTrace('login:init-new', mk);
      const wrapped_mk = await wrapMKWithPasswordArgon2id(pwd, mk);
      report('wrap-mk', 'success');
      report('mk-store', 'start');
      const { r } = await mkStore({
        session: initialSession,
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

  // Hardblock if server evidence indicates existing data but MK is still missing
  if (hasServerEvidence && !getMkRaw()) {
    const mkSummary = await summarizeMkForLog(getMkRaw());
    log({
      mkHardblockTrace: {
        sourceTag: 'login:mk-missing-post-evidence',
        reason: 'mk_raw_missing_after_evidence',
        serverHasMK: getHasMK(),
        mkHash12: mkSummary.mkHash12,
        accountDigestSuffix4: (accountDigest || '').slice(-4) || null,
        deviceIdSuffix4: (getDeviceId() || evidenceDeviceId || '').slice(-4) || null,
        evidence: {
          backup: !!evidence?.backupExists,
          vault: !!evidence?.vaultExists,
          messages: !!evidence?.messagesExists,
          registryDeviceIdSuffix4: evidence?.registryDeviceId ? evidence.registryDeviceId.slice(-4) : null,
          backupDeviceIdSuffix4: evidence?.backupDeviceId ? evidence.backupDeviceId.slice(-4) : null
        }
      }
    });
    throw new Error('MK_MISSING_HARDBLOCK');
  }

  // Ensure device bundle / replenish OPKs
  const fetchDevkeys = async () => {
    const { r, data } = await devkeysFetch({ accountToken, accountDigest });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('devkeys.fetch failed');
    return data;
  };

  const publishBundle = async (bundlePub, { devicePriv = null, deviceId = null, allowFallback = true } = {}) => {
    const resolvedDeviceId = deviceId || getDeviceId() || devicePriv?.device_id || devicePriv?.deviceId || null;
    const resolvedSpk = bundlePub?.signedPrekey || (devicePriv ? {
      id: devicePriv.spk_id || devicePriv.spkId || 1,
      pub: devicePriv.spk_pub_b64,
      sig: devicePriv.spk_sig_b64,
      ik_pub: devicePriv.ik_pub_b64
    } : null);
    if (!resolvedDeviceId) throw new Error('deviceId missing for prekeys publish');
    if (!resolvedSpk) throw new Error('signedPrekey missing for prekeys publish');
    const send = async (payload) => {
      const { r, data } = await prekeysPublish({
        accountToken,
        accountDigest,
        deviceId: resolvedDeviceId,
        signedPrekey: payload.signedPrekey || resolvedSpk,
        opks: payload.opks || []
      });
      if (r.ok) return { ok: true };
      let detail = '';
      if (data && typeof data === 'object') {
        if (typeof data.details === 'string') {
          try {
            const parsed = JSON.parse(data.details);
            detail = parsed?.message || parsed?.error || data.details;
          } catch {
            detail = data.details;
          }
        }
        detail = detail || data.message || data.error || '';
      } else if (typeof data === 'string') {
        detail = data;
      }
      return { ok: false, status: r.status, message: detail || `HTTP ${r.status}` };
    };

    const attempt = await send(bundlePub);
    if (attempt.ok) return true;
    throw new Error(`keys.publish failed: ${attempt.message}`);
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
      try { console.warn('[login-flow] devkeys fallback store failed', err?.message || err); } catch { }
    }
  }
  if (hasExistingBackup) {
    wrappedDevEnvelope = existing.wrapped_dev;
  }
  if (!hasExistingBackup) {
    if (hadWrappedMK && !fallbackWrappedDev) {
      try { console.warn('[login-flow] device backup missing; regenerating bundle'); } catch { }
    }
    // full init path: generate bundle (+100), publish, store backup
    try {
      report('generate-bundle', 'start');
      const deviceId = getDeviceId() || crypto.randomUUID();
      setDeviceId(deviceId);
      try { console.log('[login-flow] deviceId:set:init', deviceId); } catch { }
      const { devicePriv, bundlePub } = await generateInitialBundle(1, 50);
      devicePriv.device_id = deviceId;
      devicePriv.deviceId = deviceId;
      report('generate-bundle', 'success', { opkCount: bundlePub?.opks?.length || 0 });
      setDevicePriv(devicePriv);
      await runStep('prekeys-publish', () => publishBundle(bundlePub, { devicePriv, deviceId }));
      const wrapped_dev = await runStep('wrap-device', () => wrapDevicePrivWithMK(devicePriv, getMkRaw()));
      await runStep('devkeys-store', () => storeDevkeys(initialSession, wrapped_dev));
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
      const restoredDeviceId = devicePriv.device_id || devicePriv.deviceId || getDeviceId() || null;
      if (!restoredDeviceId || (typeof restoredDeviceId !== 'string') || !restoredDeviceId.trim()) {
        throw new Error('deviceId missing in device backup; please reinitialize account');
      }
      const deviceId = restoredDeviceId.trim();
      devicePriv.device_id = deviceId;
      devicePriv.deviceId = deviceId;
      setDeviceId(deviceId);
      try { console.log('[login-flow] deviceId:set:replenish', deviceId); } catch { }
      await runStep('prekeys-sync', () => publishBundle({
        ik_pub: devicePriv.ik_pub_b64,
        spk_pub: devicePriv.spk_pub_b64,
        spk_sig: devicePriv.spk_sig_b64
      }, { devicePriv, deviceId, allowFallback: false }));
      const { opks, opkPrivMap, next } = await generateOpksFrom(devicePriv.next_opk_id || 1, 20);
      if (opks.length > 0) {
        report('generate-bundle', 'start');
        report('prekeys-publish', 'start');
        try {
          await publishBundle({ opks }, { devicePriv, deviceId });
        } catch (e) {
          report('prekeys-publish', 'error', e?.message || e);
          report('generate-bundle', 'error', e?.message || e);
          throw new Error('keys.publish (replenish) failed: ' + asMsg(e));
        }
        devicePriv.next_opk_id = next;
        devicePriv.device_id = deviceId;
        devicePriv.deviceId = deviceId;
        if (!devicePriv.opk_priv_map) devicePriv.opk_priv_map = {};
        Object.assign(devicePriv.opk_priv_map, opkPrivMap || {});
        report('generate-bundle', 'success', { opkCount: opks.length });
        report('prekeys-publish', 'success');
        replenished = true;
        nextId = next;
      } else {
        report('generate-bundle', 'skip');
        report('prekeys-publish', 'skip');
      }
      const wrapped_dev = await runStep('wrap-device', () => wrapDevicePrivWithMK(devicePriv, getMkRaw()));
      try {
        report('devkeys-store', 'start');
        await storeDevkeys(undefined, wrapped_dev);
        report('devkeys-store', 'success');
      } catch (e) {
        report('devkeys-store', 'error', e?.message || e);
        throw new Error('devkeys.store (replenish) failed: ' + asMsg(e));
      }
      wrappedDevEnvelope = wrapped_dev;
    } catch (e) {
      if (!replenished) report('generate-bundle', 'error', e?.message || e);
      throw new Error('Prekeys replenish failed: ' + asMsg(e));
    }
  }

  return {
    unlocked,
    initialized,
    replenished,
    next_opk_id: nextId,
    wrapped_dev: wrappedDevEnvelope,
    evidence
  };
}
