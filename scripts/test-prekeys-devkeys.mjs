#!/usr/bin/env node
// Test prekeys publish (IK/SPK/SPK_SIG + OPKs) and devkeys store/fetch via API

import crypto from 'node:crypto';

const ORIGIN_API = process.env.ORIGIN_API || 'http://127.0.0.1:3000';

function rnd(n) { return crypto.randomBytes(n); }
function b64(u8) { return Buffer.from(u8).toString('base64'); }

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

async function prekeysPublish({ uidHex, accountToken, accountDigest, count = 5 }) {
  const bundle = {
    ik_pub: b64(rnd(32)),
    spk_pub: b64(rnd(32)),
    spk_sig: b64(rnd(64)),
    opks: Array.from({ length: count }, (_, i) => ({ id: i + 1, pub: b64(rnd(32)) }))
  };
  const { r, data } = await jsonPost('/api/v1/keys/publish', { uidHex, accountToken, accountDigest, bundle });
  if (r.status !== 204) throw new Error('keys.publish failed: ' + JSON.stringify(data));
}

function fakeAeadEnvelope() {
  return { v: 1, aead: 'aes-256-gcm', salt_b64: b64(rnd(16)), iv_b64: b64(rnd(12)), ct_b64: b64(rnd(64)), info: 'devkeys/v1' };
}

async function devkeysStore({ accountToken, accountDigest }) {
  const wrapped_dev = fakeAeadEnvelope();
  const { r, data } = await jsonPost('/api/v1/devkeys/store', { accountToken, accountDigest, wrapped_dev });
  if (r.status !== 204) throw new Error('devkeys.store failed: ' + JSON.stringify(data));
}

async function devkeysFetch({ accountToken, accountDigest }) {
  const { r, data } = await jsonPost('/api/v1/devkeys/fetch', { accountToken, accountDigest });
  if (r.status === 404) throw new Error('devkeys.fetch not found');
  if (!r.ok) throw new Error('devkeys.fetch failed: ' + JSON.stringify(data));
  return data;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  console.log('[1] debug-kit + exchange');
  const dbg = await sdmDebugKit();
  const ex = await sdmExchange(dbg);
  const { uidDigest, accountToken, accountDigest } = ex;
  assert(accountToken && accountDigest, 'missing account creds');

  console.log('[2] prekeys publish');
  await prekeysPublish({ uidHex: dbg.uidHex, accountToken, accountDigest });
  console.log('    publish ok');

  console.log('[3] devkeys store');
  await devkeysStore({ accountToken, accountDigest });
  console.log('    store ok');

  console.log('[4] devkeys fetch');
  const fetched = await devkeysFetch({ accountToken, accountDigest });
  assert(!!fetched?.wrapped_dev, 'wrapped_dev missing');
  console.log('    fetch ok');

  console.log('\nALL OK');
}

main().catch((e) => { console.error('TEST FAILED:', e?.message || e); process.exit(1); });
