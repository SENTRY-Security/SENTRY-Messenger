#!/usr/bin/env node
/**
 * Phase 1 — Forward Secrecy (DH Ratchet) Verification Tests
 *
 * Validates that:
 *   1. DH ratchet rotates keys on every direction change
 *   2. skippedKeys remain empty under monotonic delivery
 *   3. NsTotal stays monotonic across ratchet epochs
 *   4. pn consistency holds (pn === Nr at ratchet boundary)
 *   5. AAD is mandatory (no-AAD encrypt throws)
 *   6. pn gap > limit is hard-rejected
 *
 * Usage: node --test tests/unit/phase1-forward-secrecy.spec.mjs
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert';
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

describe('Phase 1.1 — DH ratchet rotates keys on direction change', () => {
  it('ek_pub_b64 changes when sender switches', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice → Bob: first message
    const r1 = await sendAndDeliver(alice, bob, 'a2b-1', 'dev-A');
    const aliceEk1 = r1.header.ek_pub_b64;

    // Bob → Alice: triggers ratchet on Bob's send side
    const r2 = await sendAndDeliver(bob, alice, 'b2a-1', 'dev-B');
    const bobEk1 = r2.header.ek_pub_b64;

    // Keys must be different (different DH keypairs)
    assert.notStrictEqual(aliceEk1, bobEk1, 'Alice and Bob should have different ek_pub after ratchet');

    // Alice → Bob again: triggers ratchet on Alice's send side (she received Bob's new ek)
    const r3 = await sendAndDeliver(alice, bob, 'a2b-2', 'dev-A');
    const aliceEk2 = r3.header.ek_pub_b64;

    assert.notStrictEqual(aliceEk1, aliceEk2, 'Alice ek_pub should rotate after receiving from Bob');
  });

  it('ek_pub stays the same for consecutive messages in same direction', async () => {
    const { alice, bob } = await bootstrapSession();

    const r1 = await sendAndDeliver(alice, bob, 'msg-1', 'dev-A');
    const r2 = await sendAndDeliver(alice, bob, 'msg-2', 'dev-A');
    const r3 = await sendAndDeliver(alice, bob, 'msg-3', 'dev-A');

    // Same direction → same epoch → same ek_pub
    assert.strictEqual(r1.header.ek_pub_b64, r2.header.ek_pub_b64, 'ek should be same within epoch');
    assert.strictEqual(r2.header.ek_pub_b64, r3.header.ek_pub_b64, 'ek should be same within epoch');
  });

  it('Ns resets to 0 on ratchet, header.n reflects chain counter', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice sends 3 messages
    const a1 = await sendAndDeliver(alice, bob, 'a-1', 'dev-A');
    const a2 = await sendAndDeliver(alice, bob, 'a-2', 'dev-A');
    const a3 = await sendAndDeliver(alice, bob, 'a-3', 'dev-A');
    assert.strictEqual(a1.header.n, 1);
    assert.strictEqual(a2.header.n, 2);
    assert.strictEqual(a3.header.n, 3);

    // Bob replies (triggers ratchet)
    const b1 = await sendAndDeliver(bob, alice, 'b-1', 'dev-B');
    assert.strictEqual(b1.header.n, 1, 'Bob chain counter should reset to 1 after ratchet');
    assert.strictEqual(b1.header.pn, 0, 'Bob pn should be 0 (Bob had 0 messages in previous send chain)');

    // Alice replies again (triggers ratchet)
    const a4 = await sendAndDeliver(alice, bob, 'a-4', 'dev-A');
    assert.strictEqual(a4.header.n, 1, 'Alice chain counter should reset to 1 after ratchet');
    assert.strictEqual(a4.header.pn, 3, 'Alice pn should be 3 (she sent 3 messages in previous epoch)');
  });
});

describe('Phase 1.1 — NsTotal stays monotonic across ratchet epochs', () => {
  it('NsTotal increments continuously despite Ns resets', async () => {
    const { alice, bob } = await bootstrapSession();
    const history = [];

    // Alice: 3 msgs
    for (let i = 0; i < 3; i++) {
      await sendAndDeliver(alice, bob, `a-${i}`, 'dev-A');
      history.push({ who: 'alice', NsTotal: alice.NsTotal, Ns: alice.Ns });
    }
    // Bob: 2 msgs
    for (let i = 0; i < 2; i++) {
      await sendAndDeliver(bob, alice, `b-${i}`, 'dev-B');
    }
    // Alice: 2 more msgs
    for (let i = 0; i < 2; i++) {
      await sendAndDeliver(alice, bob, `a2-${i}`, 'dev-A');
      history.push({ who: 'alice', NsTotal: alice.NsTotal, Ns: alice.Ns });
    }

    // Alice NsTotal should be 5 (3 + 2), all monotonically increasing
    assert.strictEqual(alice.NsTotal, 5, 'Alice total sends = 5');
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i].NsTotal > history[i - 1].NsTotal,
        `NsTotal must strictly increase: ${history[i].NsTotal} > ${history[i - 1].NsTotal}`);
    }
  });
});

describe('Phase 1.1 — skippedKeys empty under monotonic delivery', () => {
  it('skippedKeys map stays empty through full ping-pong', async () => {
    const { alice, bob } = await bootstrapSession();

    for (let round = 0; round < 5; round++) {
      await sendAndDeliver(alice, bob, `a-${round}`, 'dev-A');
      await sendAndDeliver(bob, alice, `b-${round}`, 'dev-B');
    }

    const aliceSkipped = alice.skippedKeys instanceof Map ? alice.skippedKeys.size : 0;
    const bobSkipped = bob.skippedKeys instanceof Map ? bob.skippedKeys.size : 0;
    assert.strictEqual(aliceSkipped, 0, 'Alice skippedKeys must be empty under monotonic delivery');
    assert.strictEqual(bobSkipped, 0, 'Bob skippedKeys must be empty under monotonic delivery');
  });
});

describe('Phase 1.2 — pn gap hard reject', () => {
  it('rejects packet with pn gap > SKIPPED_KEYS_PER_CHAIN_MAX', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice sends one message to establish chain
    await sendAndDeliver(alice, bob, 'setup', 'dev-A');

    // Craft a fake ratchet packet with absurd pn
    const fakeEk = crypto.getRandomValues(new Uint8Array(32));
    const fakePacket = {
      header: {
        dr: 1, v: 1, device_id: 'dev-A',
        ek_pub_b64: b64(fakeEk),
        pn: 9999, // way beyond limit of 100
        n: 1
      },
      ciphertext_b64: 'AAAA',
      iv_b64: b64(crypto.getRandomValues(new Uint8Array(12)))
    };

    await assert.rejects(
      () => drDecryptText(bob, fakePacket, { packetKey: null, msgType: 'text' }),
      (err) => {
        assert.ok(err.message.includes('pn gap') || err.message.includes('exceeds limit'),
          `Expected pn gap error, got: ${err.message}`);
        return true;
      },
      'Should reject packets with excessive pn gap'
    );
  });
});

describe('Phase 1.4 — AAD is mandatory', () => {
  it('drEncryptText throws when deviceId is missing', async () => {
    const { alice } = await bootstrapSession();

    await assert.rejects(
      () => drEncryptText(alice, 'test', { version: 1 }),
      (err) => {
        assert.ok(err.message.includes('AAD'), `Expected AAD error, got: ${err.message}`);
        return true;
      },
      'Should throw when AAD cannot be constructed (no deviceId)'
    );
  });

  it('drEncryptText succeeds when deviceId is provided', async () => {
    const { alice } = await bootstrapSession();
    const pkt = await drEncryptText(alice, 'test', { deviceId: 'dev-A', version: 1 });
    assert.ok(pkt.header.ek_pub_b64, 'packet should have ek_pub_b64');
    assert.ok(pkt.ciphertext_b64, 'packet should have ciphertext');
  });
});

describe('End-to-end with full ratchet — complex scenarios', () => {
  it('3-round burst exchange with alternating speakers', async () => {
    const { alice, bob } = await bootstrapSession();
    const ekHistory = { alice: new Set(), bob: new Set() };

    for (let round = 0; round < 3; round++) {
      // Alice burst: 3 messages
      for (let i = 0; i < 3; i++) {
        const r = await sendAndDeliver(alice, bob, `a-r${round}-${i}`, 'dev-A');
        assert.strictEqual(r.plain, `a-r${round}-${i}`);
        ekHistory.alice.add(r.header.ek_pub_b64);
      }
      // Bob burst: 2 messages
      for (let i = 0; i < 2; i++) {
        const r = await sendAndDeliver(bob, alice, `b-r${round}-${i}`, 'dev-B');
        assert.strictEqual(r.plain, `b-r${round}-${i}`);
        ekHistory.bob.add(r.header.ek_pub_b64);
      }
    }

    // With 3 rounds, Alice should have used 3 different ek_pub (one per epoch after receiving Bob's reply)
    // round 0: initial ek, round 1: new ek after Bob's reply, round 2: new ek after Bob's reply
    assert.ok(ekHistory.alice.size >= 3, `Alice should have >= 3 distinct ek values, got ${ekHistory.alice.size}`);
    assert.ok(ekHistory.bob.size >= 3, `Bob should have >= 3 distinct ek values, got ${ekHistory.bob.size}`);
  });

  it('replay attack is still rejected after ratchet', async () => {
    const { alice, bob } = await bootstrapSession();

    const r1 = await sendAndDeliver(alice, bob, 'original', 'dev-A');
    assert.strictEqual(r1.plain, 'original');

    // Replay the same packet
    const header = JSON.parse(JSON.stringify(r1.pkt.header));
    await assert.rejects(
      () => drDecryptText(bob, { header, ciphertext_b64: r1.pkt.ciphertext_b64, iv_b64: r1.pkt.iv_b64 }, { packetKey: null }),
      'Replay should be rejected'
    );
  });

  it('long conversation with many ratchet rotations', async () => {
    const { alice, bob } = await bootstrapSession();

    // 20 alternating messages = 20 ratchet rotations
    for (let i = 0; i < 10; i++) {
      const r1 = await sendAndDeliver(alice, bob, `long-a-${i}`, 'dev-A');
      assert.strictEqual(r1.plain, `long-a-${i}`);
      const r2 = await sendAndDeliver(bob, alice, `long-b-${i}`, 'dev-B');
      assert.strictEqual(r2.plain, `long-b-${i}`);
    }

    // Verify counters
    assert.strictEqual(alice.NsTotal, 10, 'Alice should have sent 10 messages total');
    assert.strictEqual(bob.NsTotal, 10, 'Bob should have sent 10 messages total');
  });
});
