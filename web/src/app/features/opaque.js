// /app/features/opaque.js
// Front-end OPAQUE (client) glue using ESM CDN for @cloudflare/opaque-ts
// Provides helpers to register/login against server OPAQUE endpoints.

import { fetchJSON } from '../core/http.js';
import { importWithSRI } from '/shared/utils/sri.js';
import { CDN_SRI } from '/shared/utils/cdn-integrity.js';

// Lazy-load OPAQUE client from esm.sh (works on Cloudflare Pages without bundling)
let _opaque = null;
const OPAQUE_URL = 'https://esm.sh/@cloudflare/opaque-ts@0.7.5';
const OPAQUE_MSG_URL = 'https://esm.sh/@cloudflare/opaque-ts@0.7.5/lib/src/messages.js';

async function loadOpaque() {
  if (_opaque) return _opaque;
  // Pin version that matches server library — verified via SRI
  const mod = await importWithSRI(OPAQUE_URL, CDN_SRI[OPAQUE_URL]);
  _opaque = mod;
  return _opaque;
}

async function loadOpaqueMessages() {
  return importWithSRI(OPAQUE_MSG_URL, CDN_SRI[OPAQUE_MSG_URL]);
}

function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64ToU8(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function opaqueRegister({ password, accountDigest, clientIdentity, serverId }) {
  const { OpaqueClient, getOpaqueConfig, OpaqueID } = await loadOpaque();
  const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
  const client = new OpaqueClient(cfg);
  const reqObj = await client.registerInit(String(password || ''));
  if (reqObj instanceof Error) throw reqObj;
  const request_b64 = u8ToB64(new Uint8Array(reqObj.serialize()));
  const { r: r1, data: d1 } = await fetchJSON('/api/v1/auth/opaque/register-init', {
    account_digest: accountDigest,
    request_b64
  });
  if (!r1.ok || !d1?.response_b64) {
    const msg = typeof d1 === 'string' ? d1 : d1?.message || d1?.error || 'opaque register-init failed';
    throw new Error(msg);
  }
  const response = (await loadOpaqueMessages()).RegistrationResponse.deserialize(
    cfg,
    Array.from(b64ToU8(d1.response_b64))
  );
  const fin = await client.registerFinish(response, serverId || undefined, clientIdentity || undefined);
  if (fin instanceof Error) throw fin;
  const record_b64 = u8ToB64(new Uint8Array(fin.record.serialize()));
  const { r: r2, data: d2 } = await fetchJSON('/api/v1/auth/opaque/register-finish', {
    account_digest: accountDigest,
    record_b64,
    client_identity: clientIdentity || null
  });
  if (r2.status !== 204) {
    const msg = typeof d2 === 'string' ? d2 : d2?.message || d2?.error || 'opaque register-finish failed';
    throw new Error(msg);
  }
  return true;
}

export async function opaqueLogin({ password, accountDigest, context, serverId, clientIdentity }) {
  const { OpaqueClient, getOpaqueConfig, OpaqueID } = await loadOpaque();
  const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
  const client = new OpaqueClient(cfg);
  const ke1 = await client.authInit(String(password || ''));
  if (ke1 instanceof Error) throw ke1;
  const ke1_b64 = u8ToB64(new Uint8Array(ke1.serialize()));
  const { r: r1, data: d1 } = await fetchJSON('/api/v1/auth/opaque/login-init', {
    account_digest: accountDigest,
    ke1_b64
  });
  if (!r1.ok || !d1?.ke2_b64 || !d1?.opaque_session) {
    const msg = typeof d1 === 'string' ? d1 : d1?.message || d1?.error || 'opaque login-init failed';
    throw new Error(msg);
  }
  const KE2 = (await loadOpaqueMessages()).KE2;
  const ke2Obj = KE2.deserialize(cfg, Array.from(b64ToU8(d1.ke2_b64)));
  const fin = await client.authFinish(ke2Obj, serverId || undefined, clientIdentity || undefined, context || undefined);
  if (fin instanceof Error) throw fin;
  const ke3_b64 = u8ToB64(new Uint8Array(fin.ke3.serialize()));
  const { r: r2, data: d2 } = await fetchJSON('/api/v1/auth/opaque/login-finish', {
    opaque_session: d1.opaque_session,
    ke3_b64
  });
  if (!r2.ok || !d2?.ok || !d2?.session_key_b64) {
    const msg = typeof d2 === 'string' ? d2 : d2?.message || d2?.error || 'opaque login-finish failed';
    throw new Error(msg);
  }
  return { sessionKeyB64: d2.session_key_b64 };
}

export async function ensureOpaque({ password, accountDigest, serverId, clientIdentity }) {
  try {
    // try login; if record missing, server will 404 -> then register and retry login
    const ok = await opaqueLogin({ password, accountDigest, serverId, clientIdentity });
    return ok;
  } catch (e) {
    const msg = String(e?.message || e || '');
    // Treat common server/client decode issues as missing record → re-register path
    if (
      /RecordNotFound/i.test(msg) ||
      /404/.test(msg) ||
      /invalid\s+(request|record|ke1|ke3|expected)_b64/i.test(msg) ||
      /Array of byte-sized integers expected/i.test(msg) ||
      /EnvelopeRecoveryError/i.test(msg) ||
      /OpaqueLoginFinishFailed/i.test(msg)
    ) {
      await opaqueRegister({ password, accountDigest, serverId, clientIdentity });
      return await opaqueLogin({ password, accountDigest, serverId, clientIdentity });
    }
    throw e;
  }
}
