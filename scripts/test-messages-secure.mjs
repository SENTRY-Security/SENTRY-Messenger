#!/usr/bin/env node
// Test secure messages index via Node API -> Worker

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

async function jsonGet(path) {
  const url = path.startsWith('http') ? path : ORIGIN_API.replace(/\/$/, '') + path;
  const r = await fetch(url, { method: 'GET' });
  let data; try { data = await r.json(); } catch { data = await r.text(); }
  return { r, data };
}

async function sdmDebugKit() {
  const { r, data } = await jsonPost('/api/v1/auth/sdm/debug-kit', {});
  if (!r.ok) throw new Error('sdm.debug-kit failed: ' + JSON.stringify(data));
  return data;
}

async function sdmExchange(dbg) {
  const { r, data } = await jsonPost('/api/v1/auth/sdm/exchange', { uid: dbg.uidHex, sdmmac: dbg.sdmmac, sdmcounter: dbg.sdmcounter, nonce: dbg.nonce });
  if (!r.ok) throw new Error('sdm.exchange failed: ' + JSON.stringify(data));
  return data;
}

function fakeEnvelope() {
  return { v: 1, iv_b64: b64(rnd(12)), payload_b64: b64(rnd(64)) };
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  console.log('[1] exchange');
  const dbg = await sdmDebugKit();
  const ex = await sdmExchange(dbg);
  assert(ex.accountDigest, 'missing account');

  const convId = `contacts-${ex.accountDigest}`;
  const msgId = crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000);

  console.log('[2] create secure message');
  // Create secure message (Node expects conversation_id)
  const body = { conversation_id: convId, payload_envelope: fakeEnvelope(), created_at: ts };
  const { r: rc, data: dc } = await jsonPost('/api/v1/messages/secure', body);
  if (!rc.ok) throw new Error('create secure failed: ' + JSON.stringify(dc));
  console.log('    create ok, id =', dc?.id || '(n/a)');

  console.log('[3] list secure messages');
  const { r: rl, data: dl } = await jsonGet(`/api/v1/messages/secure?conversationId=${encodeURIComponent(convId)}`);
  if (!rl.ok) throw new Error('list secure failed: ' + JSON.stringify(dl));
  const items = dl?.items || [];
  assert(items.length >= 1, 'expected >= 1 item');
  console.log('    list ok, items =', items.length);

  console.log('\nALL OK');
}

main().catch((e) => { console.error('TEST FAILED:', e?.message || e); process.exit(1); });
