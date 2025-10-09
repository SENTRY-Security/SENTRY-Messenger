#!/usr/bin/env node
// Simple end-to-end test for login flow (new user -> store MK -> old user)
// Usage:
//   ORIGIN_API=https://api.message.sentry.red node scripts/test-login-flow.mjs [--origin URL] [--uid UIDHEX]

import nodeCrypto from 'node:crypto';
import { OpaqueClient, getOpaqueConfig, OpaqueID } from '@cloudflare/opaque-ts/lib/src/index.js';
import { KE2, RegistrationResponse } from '@cloudflare/opaque-ts/lib/src/messages.js';
import { wrapMKWithPasswordArgon2id } from './lib/argon2-wrap.mjs';

if (!globalThis.crypto) {
  globalThis.crypto = nodeCrypto.webcrypto;
}

const args = process.argv.slice(2);
const findArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const ORIGIN_API = process.env.ORIGIN_API || findArg('--origin') || 'http://127.0.0.1:3000';
const FIXED_UID = findArg('--uid');
const SERVER_ID = process.env.OPAQUE_SERVER_ID || findArg('--server-id') || null;

function b64(u8) { return Buffer.from(u8).toString('base64'); }
function b64u8(s) { return Uint8Array.from(Buffer.from(String(s || ''), 'base64')); }
function rnd(n) { const u = new Uint8Array(n); globalThis.crypto.getRandomValues(u); return u; }

async function jsonPost(path, body) {
  const url = path.startsWith('http') ? path : ORIGIN_API.replace(/\/$/, '') + path;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data; try { data = await r.json(); } catch { data = await r.text(); }
  return { r, data };
}

async function sdmDebugKit(uidHex) {
  const payload = {}; if (uidHex) payload.uidHex = uidHex;
  const { r, data } = await jsonPost('/api/v1/auth/sdm/debug-kit', payload);
  if (!r.ok) throw new Error('sdm.debug-kit failed: ' + JSON.stringify(data));
  return data;
}

async function sdmExchange({ uidHex, sdmmac, sdmcounter, nonce }) {
  const { r, data } = await jsonPost('/api/v1/auth/sdm/exchange', { uid: uidHex, sdmmac, sdmcounter, nonce });
  if (!r.ok) throw new Error('sdm.exchange failed: ' + JSON.stringify(data));
  return data;
}

async function opaqueRegister({ password, accountDigest, serverId }) {
  const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
  const client = new OpaqueClient(cfg);
  const init = await client.registerInit(password);
  if (init instanceof Error) throw init;
  const request_b64 = b64(new Uint8Array(init.serialize()));
  const { r: r1, data: d1 } = await jsonPost('/api/v1/auth/opaque/register-init', { accountDigest, request_b64 });
  if (!r1.ok || !d1?.response_b64) throw new Error('register-init failed: ' + JSON.stringify(d1));
  const resp = RegistrationResponse.deserialize(cfg, Array.from(b64u8(d1.response_b64)));
  const fin = await client.registerFinish(resp, serverId || undefined, undefined);
  if (fin instanceof Error) throw fin;
  const record_b64 = b64(new Uint8Array(fin.record.serialize()));
  const { r: r2, data: d2 } = await jsonPost('/api/v1/auth/opaque/register-finish', { accountDigest, record_b64 });
  if (r2.status !== 204) throw new Error('register-finish failed: ' + JSON.stringify(d2));
  return true;
}

async function opaqueLogin({ password, accountDigest, serverId }) {
  const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
  const client = new OpaqueClient(cfg);
  const ke1 = await client.authInit(password);
  if (ke1 instanceof Error) throw ke1;
  const ke1_b64 = b64(new Uint8Array(ke1.serialize()));
  const { r: r1, data: d1 } = await jsonPost('/api/v1/auth/opaque/login-init', { accountDigest, ke1_b64 });
  if (!r1.ok || !d1?.ke2_b64 || !d1?.opaqueSession) throw new Error('login-init failed: ' + JSON.stringify(d1));
  const ke2 = KE2.deserialize(getOpaqueConfig(OpaqueID.OPAQUE_P256), Array.from(b64u8(d1.ke2_b64)));
  const fin = await client.authFinish(ke2, serverId || undefined, undefined, undefined);
  if (fin instanceof Error) throw fin;
  const ke3_b64 = b64(new Uint8Array(fin.ke3.serialize()));
  const { r: r2, data: d2 } = await jsonPost('/api/v1/auth/opaque/login-finish', { opaqueSession: d1.opaqueSession, ke3_b64 });
  if (!r2.ok || !d2?.ok) throw new Error('login-finish failed: ' + JSON.stringify(d2));
  return d2.session_key_b64;
}

async function mkStore({ session, uidHex, accountToken, accountDigest, wrapped_mk }) {
  const { r, data } = await jsonPost('/api/v1/mk/store', { session, uidHex, accountToken, accountDigest, wrapped_mk });
  if (r.status !== 204) throw new Error('mk.store failed: ' + JSON.stringify(data));
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  console.log('[1] SDM debug-kit');
  const dbg1 = await sdmDebugKit(FIXED_UID || undefined);
  console.log('    uidHex =', dbg1.uidHex);

  console.log('[2] SDM exchange');
  const ex1 = await sdmExchange(dbg1);
  console.log('    hasMK =', ex1.hasMK);
  assert(ex1.session && ex1.accountToken && ex1.accountDigest, 'exchange missing fields');

  const accountDigest = ex1.accountDigest;
  const uidHex = dbg1.uidHex;
  const password = 'test-' + Math.random().toString(36).slice(2, 10);

  console.log('[3] OPAQUE login (will register if needed)');
  try {
    await opaqueRegister({ password, accountDigest, serverId: SERVER_ID });
    console.log('    register: ok');
  } catch (e) {
    console.log('    register: skipped or failed:', e?.message || e);
  }
  const sessionKeyB64 = await opaqueLogin({ password, accountDigest, serverId: SERVER_ID });
  console.log('    login: ok, sessionKeyB64 len =', (sessionKeyB64 || '').length);

  if (!ex1.hasMK) {
    console.log('[4] MK store (first-time)');
    const mk = rnd(32);
    const wrapped_mk = await wrapMKWithPasswordArgon2id(password, mk);
    await mkStore({ session: ex1.session, uidHex, accountToken: ex1.accountToken, accountDigest, wrapped_mk });
    console.log('    mk.store: ok');
  }

  console.log('[5] SDM debug-kit (same uid)');
  const dbg2 = await sdmDebugKit(uidHex);
  console.log('[6] SDM exchange again (should have hasMK=true)');
  const ex2 = await sdmExchange(dbg2);
  console.log('    hasMK =', ex2.hasMK);
  assert(ex2.hasMK === true, 'expected hasMK=true on second exchange');
  console.log('    wrapped_mk present =', !!ex2.wrapped_mk);

  console.log('[7] OPAQUE login (existing)');
  const sessionKey2 = await opaqueLogin({ password, accountDigest, serverId: SERVER_ID });
  console.log('    login existing: ok, sessionKey len =', (sessionKey2 || '').length);

  console.log('\nALL OK');
}

main().catch((e) => { console.error('TEST FAILED:', e?.message || e); process.exit(1); });
