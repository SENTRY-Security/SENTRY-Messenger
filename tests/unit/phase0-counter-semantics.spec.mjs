#!/usr/bin/env node
/**
 * Phase 0 — Counter Semantics Verification Tests
 *
 * Validates that NsTotal/NrTotal remain monotonically increasing
 * across multiple ratchet epochs, and that drRatchet no longer
 * double-counts transport counters.
 *
 * Usage: node --test tests/unit/phase0-counter-semantics.spec.mjs
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';

// ── Shim browser globals for dr.js ──────────────────────────
function setupGlobals() {
  if (typeof globalThis.crypto === 'undefined') {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  }
  if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder;
  if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder;
  if (typeof globalThis.atob === 'undefined') globalThis.atob = (b) => Buffer.from(String(b), 'base64').toString('binary');
  if (typeof globalThis.btoa === 'undefined') globalThis.btoa = (b) => Buffer.from(String(b), 'binary').toString('base64');
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  if (typeof globalThis.sessionStorage === 'undefined') {
    const m = new Map();
    globalThis.sessionStorage = {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
      get length() { return m.size; }
    };
  }
  if (typeof globalThis.localStorage === 'undefined') {
    const m = new Map();
    globalThis.localStorage = {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
      get length() { return m.size; }
    };
  }
}

setupGlobals();

const { x3dhInitiate, x3dhRespond, drEncryptText, drDecryptText, drRatchet } = await import('../../web/src/shared/crypto/dr.js');
const { generateInitialBundle } = await import('../../web/src/shared/crypto/prekeys.js');

function b64(u8) { return Buffer.from(u8).toString('base64'); }

// ── Helper: bootstrap Alice↔Bob session ──────────────────────
async function bootstrapSession() {
  const { devicePriv: privA, bundlePub: bundleA } = await generateInitialBundle(1001, 4);
  const { devicePriv: privB, bundlePub: bundleB } = await generateInitialBundle(1, 4);
  privA.device_id = 'dev-A';
  privA.deviceId = 'dev-A';
  privB.device_id = 'dev-B';
  privB.deviceId = 'dev-B';

  const bobOpk = bundleB.opks[0];
  const alice = await x3dhInitiate(privA, {
    ik_pub: bundleB.ik_pub,
    spk_pub: bundleB.spk_pub,
    spk_sig: bundleB.spk_sig,
    opk: bobOpk
  });
  alice.skippedKeys = new Map();

  const bob = await x3dhRespond(privB, {
    ik_pub: privA.ik_pub_b64,
    spk_pub: privA.spk_pub_b64,
    spk_sig: privA.spk_sig_b64,
    ek_pub: b64(alice.myRatchetPub),
    opk_id: bobOpk.id
  });
  bob.skippedKeys = new Map();

  return { alice, bob };
}

// ── Helper: send + deliver (monotonic) ──────────────────────
async function sendAndDeliver(sender, receiver, text, senderDeviceId = 'dev-A') {
  const pkt = await drEncryptText(sender, text, { deviceId: senderDeviceId, version: 1 });
  const header = JSON.parse(JSON.stringify(pkt.header));
  const plain = await drDecryptText(
    receiver,
    { header, ciphertext_b64: pkt.ciphertext_b64, iv_b64: pkt.iv_b64 },
    { packetKey: null, msgType: 'text' }
  );
  return { pkt, plain };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('Phase 0.1 — drRatchet does NOT mutate NsTotal/NrTotal', () => {
  it('NsTotal and NrTotal remain unchanged after drRatchet call', async () => {
    const { alice } = await bootstrapSession();

    // Set known transport counters
    alice.NsTotal = 42;
    alice.NrTotal = 17;
    const theirPub = crypto.getRandomValues(new Uint8Array(32));

    await drRatchet(alice, theirPub);

    // Phase 0.1: drRatchet must NOT accumulate Ns/Nr into transport counters
    assert.strictEqual(alice.NsTotal, 42, 'NsTotal should not change in drRatchet');
    assert.strictEqual(alice.NrTotal, 17, 'NrTotal should not change in drRatchet');
  });

  it('NsTotal remains monotonic across multiple ratchets', async () => {
    const { alice, bob } = await bootstrapSession();

    // Simulate 3 message exchanges with ratchet (Alice→Bob, Bob→Alice, Alice→Bob)
    const nsTotalHistory = [alice.NsTotal];

    // Alice sends 3 messages
    for (let i = 0; i < 3; i++) {
      await sendAndDeliver(alice, bob, `alice-msg-${i}`, 'dev-A');
      nsTotalHistory.push(alice.NsTotal);
    }

    // Bob sends 2 messages (triggers receiver ratchet on Alice's side, then sender ratchet on Bob)
    for (let i = 0; i < 2; i++) {
      await sendAndDeliver(bob, alice, `bob-msg-${i}`, 'dev-B');
    }

    // Alice sends again (should advance NsTotal further)
    await sendAndDeliver(alice, bob, 'alice-after-bob', 'dev-A');
    nsTotalHistory.push(alice.NsTotal);

    // Verify monotonic increase
    for (let i = 1; i < nsTotalHistory.length; i++) {
      assert.ok(
        nsTotalHistory[i] >= nsTotalHistory[i - 1],
        `NsTotal must be monotonic: ${nsTotalHistory[i]} >= ${nsTotalHistory[i - 1]} at step ${i}`
      );
    }
  });
});

describe('Phase 0.2 — NsTotal unconditional assignment (integration check)', () => {
  it('drEncryptText increments NsTotal by exactly 1 per call', async () => {
    const { alice } = await bootstrapSession();

    // Force a known starting point
    alice.NsTotal = 10;
    const before = alice.NsTotal;
    await drEncryptText(alice, 'test-msg', { deviceId: 'dev-A', version: 1 });
    const after = alice.NsTotal;

    // drEncryptText does NsTotal = NsTotal + 1 (line 389)
    assert.strictEqual(after, before + 1, 'NsTotal should increment by exactly 1');
  });
});

describe('Phase 0.4 — chain reset semantics on transport counter seed', () => {
  it('clearing ckS forces send-side ratchet on next encrypt', async () => {
    const { alice, bob } = await bootstrapSession();

    // Send one message to establish chain
    await sendAndDeliver(alice, bob, 'initial', 'dev-A');
    const ekBefore = b64(alice.myRatchetPub);

    // Simulate seedTransportCounterFromServer effect
    alice.NsTotal = 100;
    alice.Ns = 0;
    alice.PN = 0;
    alice.ckS = null;

    // Next encrypt should trigger ratchet (new DH keypair)
    const pkt = await drEncryptText(alice, 'after-seed', { deviceId: 'dev-A', version: 1 });

    // Verify: new ek_pub means ratchet happened
    if (alice.theirRatchetPub) {
      // Only if theirRatchetPub exists — ratchet path (line 362-382) generates new keys
      assert.notStrictEqual(
        pkt.header.ek_pub_b64, ekBefore,
        'ckS=null with theirRatchetPub should trigger send ratchet → new ek'
      );
    }

    // Verify: NsTotal is still correct (100 + 1 from drEncryptText)
    assert.strictEqual(alice.NsTotal, 101, 'NsTotal should be seeded value + 1');
    // Verify: Ns reset to 1 (was 0, then +1 from encrypt)
    assert.strictEqual(alice.Ns, 1, 'Ns should be 1 after chain reset + encrypt');
  });
});

describe('End-to-end message exchange still works after Phase 0 changes', () => {
  it('Alice→Bob→Alice ping-pong', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice → Bob
    const r1 = await sendAndDeliver(alice, bob, 'hello-bob', 'dev-A');
    assert.strictEqual(r1.plain, 'hello-bob');

    // Bob → Alice
    const r2 = await sendAndDeliver(bob, alice, 'hello-alice', 'dev-B');
    assert.strictEqual(r2.plain, 'hello-alice');

    // Alice → Bob again
    const r3 = await sendAndDeliver(alice, bob, 'again-bob', 'dev-A');
    assert.strictEqual(r3.plain, 'again-bob');
  });

  it('burst 10 messages same direction', async () => {
    const { alice, bob } = await bootstrapSession();

    for (let i = 0; i < 10; i++) {
      const r = await sendAndDeliver(alice, bob, `burst-${i}`, 'dev-A');
      assert.strictEqual(r.plain, `burst-${i}`);
    }
    assert.strictEqual(alice.NsTotal, 10);
  });

  it('alternating messages (ratchet exercise)', async () => {
    const { alice, bob } = await bootstrapSession();

    for (let i = 0; i < 5; i++) {
      const r1 = await sendAndDeliver(alice, bob, `a2b-${i}`, 'dev-A');
      assert.strictEqual(r1.plain, `a2b-${i}`);
      const r2 = await sendAndDeliver(bob, alice, `b2a-${i}`, 'dev-B');
      assert.strictEqual(r2.plain, `b2a-${i}`);
    }
  });
});
