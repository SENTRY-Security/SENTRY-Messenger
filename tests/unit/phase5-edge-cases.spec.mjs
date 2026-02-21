#!/usr/bin/env node
/**
 * Phase 5 — Edge Cases & Error Handling Verification Tests
 *
 * Validates that:
 *   5.1 — Ratchet mid-kick recovery: deterministic re-ratchet after state loss
 *   5.2 — Send-side ratchet crash recovery: pendingSendRatchet + ckS=null
 *   5.4 — send-state HMAC verification (tested at unit level via signResponseBody parity)
 *
 * Usage: node --test tests/unit/phase5-edge-cases.spec.mjs
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';

// ── Shim browser globals ────────────────────────────────────
function setupGlobals() {
  if (typeof globalThis.crypto === 'undefined') {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  }
  if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder;
  if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder;
  if (typeof globalThis.atob === 'undefined') globalThis.atob = (b) => Buffer.from(String(b), 'base64').toString('binary');
  if (typeof globalThis.btoa === 'undefined') globalThis.btoa = (b) => Buffer.from(String(b), 'binary').toString('base64');
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  const makeStore = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), get length() { return m.size; } };
  };
  if (typeof globalThis.sessionStorage === 'undefined') globalThis.sessionStorage = makeStore();
  if (typeof globalThis.localStorage === 'undefined') globalThis.localStorage = makeStore();
}

setupGlobals();

const { x3dhInitiate, x3dhRespond, drEncryptText, drDecryptText, drRatchet } = await import('../../web/src/shared/crypto/dr.js');
const { generateInitialBundle } = await import('../../web/src/shared/crypto/prekeys.js');

function b64(u8) { return Buffer.from(u8).toString('base64'); }
function b64u8(b) { return new Uint8Array(Buffer.from(b, 'base64')); }

function takeSnapshot(st) {
  return {
    rk_b64: st.rk ? b64(st.rk) : null,
    ckS_b64: st.ckS ? b64(st.ckS) : null,
    ckR_b64: st.ckR ? b64(st.ckR) : null,
    Ns: st.Ns,
    Nr: st.Nr,
    PN: st.PN,
    NsTotal: st.NsTotal,
    NrTotal: st.NrTotal,
    myRatchetPriv_b64: st.myRatchetPriv ? b64(st.myRatchetPriv) : null,
    myRatchetPub_b64: st.myRatchetPub ? b64(st.myRatchetPub) : null,
    theirRatchetPub_b64: st.theirRatchetPub ? b64(st.theirRatchetPub) : null,
    pendingSendRatchet: !!st.pendingSendRatchet
  };
}

function restoreSnapshot(st, snap) {
  st.rk = snap.rk_b64 ? b64u8(snap.rk_b64) : null;
  st.ckS = snap.ckS_b64 ? b64u8(snap.ckS_b64) : null;
  st.ckR = snap.ckR_b64 ? b64u8(snap.ckR_b64) : null;
  st.Ns = snap.Ns;
  st.Nr = snap.Nr;
  st.PN = snap.PN;
  st.NsTotal = snap.NsTotal;
  st.NrTotal = snap.NrTotal;
  st.myRatchetPriv = snap.myRatchetPriv_b64 ? b64u8(snap.myRatchetPriv_b64) : null;
  st.myRatchetPub = snap.myRatchetPub_b64 ? b64u8(snap.myRatchetPub_b64) : null;
  st.theirRatchetPub = snap.theirRatchetPub_b64 ? b64u8(snap.theirRatchetPub_b64) : null;
  st.pendingSendRatchet = snap.pendingSendRatchet;
}

async function bootstrapSession() {
  const { devicePriv: privA, bundlePub: bundleA } = await generateInitialBundle(1001, 4);
  const { devicePriv: privB, bundlePub: bundleB } = await generateInitialBundle(1, 4);
  privA.device_id = 'dev-A'; privA.deviceId = 'dev-A';
  privB.device_id = 'dev-B'; privB.deviceId = 'dev-B';
  const bobOpk = bundleB.opks[0];
  const alice = await x3dhInitiate(privA, { ik_pub: bundleB.ik_pub, spk_pub: bundleB.spk_pub, spk_sig: bundleB.spk_sig, opk: bobOpk });
  alice.skippedKeys = new Map();
  const bob = await x3dhRespond(privB, { ik_pub: privA.ik_pub_b64, spk_pub: privA.spk_pub_b64, spk_sig: privA.spk_sig_b64, ek_pub: b64(alice.myRatchetPub), opk_id: bobOpk.id });
  bob.skippedKeys = new Map();
  return { alice, bob };
}

async function sendAndDeliver(sender, receiver, text, senderDeviceId) {
  const pkt = await drEncryptText(sender, text, { deviceId: senderDeviceId, version: 1 });
  const header = JSON.parse(JSON.stringify(pkt.header));
  const plain = await drDecryptText(
    receiver,
    { header, ciphertext_b64: pkt.ciphertext_b64, iv_b64: pkt.iv_b64 },
    { packetKey: null, msgType: 'text' }
  );
  return { pkt, plain, header };
}

// ═══════════════════════════════════════════════════════════════
// Phase 5.1 — Ratchet Mid-Kick Recovery
// ═══════════════════════════════════════════════════════════════

describe('Phase 5.1 — Ratchet mid-kick recovery: deterministic re-ratchet', () => {
  it('receiver ratchet is deterministic — same inputs produce same ckR', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice sends 3 messages
    await sendAndDeliver(alice, bob, 'msg-1', 'dev-A');
    await sendAndDeliver(alice, bob, 'msg-2', 'dev-A');
    await sendAndDeliver(alice, bob, 'msg-3', 'dev-A');

    // Bob replies (triggers ratchet on Bob, generates new ek)
    const r1 = await sendAndDeliver(bob, alice, 'reply-1', 'dev-B');

    // Snapshot Alice's state BEFORE she processes the ratchet message
    // (Simulates: Alice was already forced-kicked before vaultPut)
    // Alice already processed r1 above, so we need a fresh setup:
    const { alice: alice2, bob: bob2 } = await bootstrapSession();

    // Replay same exchange
    await sendAndDeliver(alice2, bob2, 'msg-1', 'dev-A');
    await sendAndDeliver(alice2, bob2, 'msg-2', 'dev-A');
    await sendAndDeliver(alice2, bob2, 'msg-3', 'dev-A');

    // Snapshot Alice2 before she receives Bob2's ratchet reply
    const preRatchetSnap = takeSnapshot(alice2);

    // Bob2 replies
    const r2 = await sendAndDeliver(bob2, alice2, 'reply-1', 'dev-B');

    // Snapshot after ratchet
    const postRatchetSnap = takeSnapshot(alice2);

    // "Crash" — restore to pre-ratchet state
    restoreSnapshot(alice2, preRatchetSnap);
    alice2.skippedKeys = new Map();

    // Re-ratchet by re-processing Bob2's message
    const rePlain = await drDecryptText(
      alice2,
      { header: r2.header, ciphertext_b64: r2.pkt.ciphertext_b64, iv_b64: r2.pkt.iv_b64 },
      { packetKey: null, msgType: 'text' }
    );

    assert.strictEqual(rePlain, 'reply-1', 'Re-ratchet should decrypt same plaintext');

    // The ckR derivation is deterministic: same myRatchetPriv + same theirRatchetPub → same ckR
    // After re-ratchet, key state should allow continued communication
    const postReRatchetSnap = takeSnapshot(alice2);
    assert.strictEqual(postReRatchetSnap.ckR_b64, postRatchetSnap.ckR_b64,
      'ckR must be identical after deterministic re-ratchet');
    assert.strictEqual(postReRatchetSnap.rk_b64, postRatchetSnap.rk_b64,
      'Root key must be identical after deterministic re-ratchet');
  });

  it('conversation continues normally after mid-kick recovery', async () => {
    const { alice, bob } = await bootstrapSession();

    // Establish some state
    await sendAndDeliver(alice, bob, 'a1', 'dev-A');
    await sendAndDeliver(alice, bob, 'a2', 'dev-A');

    // Bob replies (triggers ratchet on Alice's side)
    const bobReply = await drEncryptText(bob, 'b1', { deviceId: 'dev-B', version: 1 });
    const bobHeader = JSON.parse(JSON.stringify(bobReply.header));

    // Snapshot Alice before ratchet (simulates stale backup)
    const preSnap = takeSnapshot(alice);

    // Alice processes the ratchet message
    await drDecryptText(
      alice,
      { header: bobHeader, ciphertext_b64: bobReply.ciphertext_b64, iv_b64: bobReply.iv_b64 },
      { packetKey: null, msgType: 'text' }
    );

    // "Force-kick" — Alice loses in-memory state, restores from stale backup
    restoreSnapshot(alice, preSnap);
    alice.skippedKeys = new Map();

    // Alice re-processes Bob's ratchet message (gap-queue replay)
    const recovered = await drDecryptText(
      alice,
      { header: bobHeader, ciphertext_b64: bobReply.ciphertext_b64, iv_b64: bobReply.iv_b64 },
      { packetKey: null, msgType: 'text' }
    );
    assert.strictEqual(recovered, 'b1');

    // Alice can now send messages (send-side ratchet generates new random keypair)
    const r3 = await sendAndDeliver(alice, bob, 'a3-after-recovery', 'dev-A');
    assert.strictEqual(r3.plain, 'a3-after-recovery');

    // Bob can reply
    const r4 = await sendAndDeliver(bob, alice, 'b2-after-recovery', 'dev-B');
    assert.strictEqual(r4.plain, 'b2-after-recovery');
  });

  it('multiple sequential ratchets recover correctly', async () => {
    const { alice, bob } = await bootstrapSession();

    // Build up several ratchet epochs
    await sendAndDeliver(alice, bob, 'a1', 'dev-A');
    await sendAndDeliver(bob, alice, 'b1', 'dev-B');
    await sendAndDeliver(alice, bob, 'a2', 'dev-A');
    await sendAndDeliver(bob, alice, 'b2', 'dev-B');

    // Snapshot before a burst from Bob
    const preSnap = takeSnapshot(alice);

    // Bob sends 3 more messages (no ratchet within burst)
    const packets = [];
    for (let i = 0; i < 3; i++) {
      const pkt = await drEncryptText(bob, `b-burst-${i}`, { deviceId: 'dev-B', version: 1 });
      packets.push(pkt);
    }

    // Alice processes all 3
    for (const pkt of packets) {
      const h = JSON.parse(JSON.stringify(pkt.header));
      await drDecryptText(alice, { header: h, ciphertext_b64: pkt.ciphertext_b64, iv_b64: pkt.iv_b64 }, { packetKey: null, msgType: 'text' });
    }

    // "Crash" — restore and replay
    restoreSnapshot(alice, preSnap);
    alice.skippedKeys = new Map();

    for (const pkt of packets) {
      const h = JSON.parse(JSON.stringify(pkt.header));
      const plain = await drDecryptText(alice, { header: h, ciphertext_b64: pkt.ciphertext_b64, iv_b64: pkt.iv_b64 }, { packetKey: null, msgType: 'text' });
      assert.ok(plain.startsWith('b-burst-'));
    }

    // Continue conversation
    const r = await sendAndDeliver(alice, bob, 'a-continue', 'dev-A');
    assert.strictEqual(r.plain, 'a-continue');
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 5.2 — Send-Side Ratchet Crash Recovery
// ═══════════════════════════════════════════════════════════════

describe('Phase 5.2 — Send-side ratchet crash recovery', () => {
  it('pendingSendRatchet=true forces new DH keypair on next send', async () => {
    const { alice, bob } = await bootstrapSession();

    // Establish chain
    await sendAndDeliver(alice, bob, 'setup-1', 'dev-A');
    await sendAndDeliver(bob, alice, 'setup-2', 'dev-B');

    const ekBefore = b64(alice.myRatchetPub);

    // Simulate hydration setting pendingSendRatchet
    alice.pendingSendRatchet = true;

    // Next send should trigger a fresh DH keypair
    const r = await sendAndDeliver(alice, bob, 'after-hydration', 'dev-A');
    assert.strictEqual(r.plain, 'after-hydration');

    const ekAfter = r.header.ek_pub_b64;
    assert.notStrictEqual(ekBefore, ekAfter,
      'pendingSendRatchet should force a new DH keypair');
    assert.strictEqual(alice.pendingSendRatchet, false,
      'pendingSendRatchet should be cleared after send');
  });

  it('ckS=null forces send-side ratchet (seedTransportCounterFromServer simulation)', async () => {
    const { alice, bob } = await bootstrapSession();

    // Establish chain and exchange
    await sendAndDeliver(alice, bob, 'init-1', 'dev-A');
    await sendAndDeliver(bob, alice, 'init-2', 'dev-B');
    await sendAndDeliver(alice, bob, 'init-3', 'dev-A');

    const ekBefore = b64(alice.myRatchetPub);

    // Simulate seedTransportCounterFromServer effect
    alice.NsTotal = 50;  // server says counter should be higher
    alice.Ns = 0;
    alice.PN = 0;
    alice.ckS = null;    // forces ratchet path in drEncryptText

    // Next send triggers send-side ratchet
    const r = await sendAndDeliver(alice, bob, 'after-seed', 'dev-A');
    assert.strictEqual(r.plain, 'after-seed');

    // New ek means ratchet happened
    assert.notStrictEqual(r.header.ek_pub_b64, ekBefore,
      'ckS=null should trigger send-side ratchet with new DH keypair');

    // NsTotal should continue from seeded value
    assert.strictEqual(alice.NsTotal, 51, 'NsTotal = seeded(50) + 1');
    assert.strictEqual(alice.Ns, 1, 'Ns should be 1 (reset by ratchet + 1 message)');
    assert.strictEqual(r.header.n, 1, 'header.n should be 1 after chain reset');
  });

  it('send-side crash recovery preserves receiver chain', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice sends, Bob replies → Alice has a receive chain
    await sendAndDeliver(alice, bob, 'a1', 'dev-A');
    await sendAndDeliver(bob, alice, 'b1', 'dev-B');

    // Snapshot Alice's ckR for comparison
    const ckRBefore = alice.ckR ? b64(alice.ckR) : null;
    assert.ok(ckRBefore, 'Alice should have a receive chain');

    // Simulate send-side crash recovery
    alice.pendingSendRatchet = true;

    // Alice sends (triggers send ratchet)
    await sendAndDeliver(alice, bob, 'a2-recovered', 'dev-A');

    // Bob sends more messages — Alice should still be able to receive
    const r1 = await sendAndDeliver(bob, alice, 'b2', 'dev-B');
    assert.strictEqual(r1.plain, 'b2');

    const r2 = await sendAndDeliver(bob, alice, 'b3', 'dev-B');
    assert.strictEqual(r2.plain, 'b3');
  });

  it('full crash-recovery cycle: stale snapshot → seed counter → pendingSendRatchet → resume', async () => {
    const { alice, bob } = await bootstrapSession();

    // Normal exchange
    await sendAndDeliver(alice, bob, 'normal-1', 'dev-A');
    await sendAndDeliver(bob, alice, 'normal-2', 'dev-B');
    await sendAndDeliver(alice, bob, 'normal-3', 'dev-A');

    // Take stale snapshot (before Alice's last send but we use current for simplicity)
    const staleSnap = takeSnapshot(alice);

    // Alice sends 2 more (these advance state beyond snapshot)
    await sendAndDeliver(alice, bob, 'lost-4', 'dev-A');
    await sendAndDeliver(alice, bob, 'lost-5', 'dev-A');

    // "atomicSend succeeded for lost-4 and lost-5 but app crashed before persist"
    // On next login: restore from stale snapshot
    restoreSnapshot(alice, staleSnap);
    alice.skippedKeys = new Map();

    // seedTransportCounterFromServer corrects NsTotal (server says alice sent up to counter 5)
    alice.NsTotal = 5;
    alice.Ns = 0;
    alice.PN = 0;
    alice.ckS = null;

    // pendingSendRatchet ensures fresh keys
    alice.pendingSendRatchet = true;

    // Alice resumes sending
    const r1 = await sendAndDeliver(alice, bob, 'recovered-6', 'dev-A');
    assert.strictEqual(r1.plain, 'recovered-6');
    assert.strictEqual(alice.NsTotal, 6, 'NsTotal should be 6 after recovery');

    // Bidirectional still works
    const r2 = await sendAndDeliver(bob, alice, 'bob-reply', 'dev-B');
    assert.strictEqual(r2.plain, 'bob-reply');
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 5.4 — send-state HMAC Integrity Verification (unit-level)
// ═══════════════════════════════════════════════════════════════

describe('Phase 5.4 — send-state response HMAC parity', () => {
  it('Worker signResponseBody and backend verification produce matching HMACs', async () => {
    const secret = 'test-hmac-secret-key-for-unit-test';
    const responseBody = JSON.stringify({
      ok: true,
      expected_counter: 42,
      last_accepted_counter: 41,
      last_accepted_message_id: 'msg-123',
      server_time: 1700000000
    });

    // Simulate worker-side signing (Web Crypto API)
    const workerKey = await webcrypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const mac = await webcrypto.subtle.sign('HMAC', workerKey, new TextEncoder().encode(responseBody));
    const workerHmac = Buffer.from(mac).toString('base64url');

    // Simulate backend-side verification (Node crypto)
    const backendHmac = crypto.createHmac('sha256', secret).update(responseBody).digest('base64url');

    assert.strictEqual(workerHmac, backendHmac,
      'Worker (Web Crypto) and backend (Node crypto) HMAC must match for same input');
  });

  it('HMAC detects tampering in response body', async () => {
    const secret = 'test-hmac-secret';
    const original = JSON.stringify({ ok: true, expected_counter: 42 });
    const tampered = JSON.stringify({ ok: true, expected_counter: 1 }); // attacker changes counter

    const hmac = crypto.createHmac('sha256', secret).update(original).digest('base64url');
    const verifyOriginal = crypto.createHmac('sha256', secret).update(original).digest('base64url');
    const verifyTampered = crypto.createHmac('sha256', secret).update(tampered).digest('base64url');

    assert.strictEqual(hmac, verifyOriginal, 'HMAC should match for untampered body');
    assert.notStrictEqual(hmac, verifyTampered, 'HMAC should NOT match for tampered body');
  });
});
