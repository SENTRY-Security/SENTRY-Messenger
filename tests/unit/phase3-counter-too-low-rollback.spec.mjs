#!/usr/bin/env node
/**
 * Phase 3.1 — CounterTooLow DR State Rollback Verification
 *
 * Validates that:
 *   1. After drEncryptText advances chain state, restoring from a pre-encrypt snapshot
 *      resets the chain to the exact same position
 *   2. Re-encrypting from the rolled-back state produces a valid packet that the
 *      receiver can decrypt (same mk derivation path)
 *   3. The receiver sees no skippedKeys after rollback+re-encrypt
 *
 * Usage: node --test tests/unit/phase3-counter-too-low-rollback.spec.mjs
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

const { x3dhInitiate, x3dhRespond, drEncryptText, drDecryptText } = await import('../../web/src/shared/crypto/dr.js');
const { generateInitialBundle } = await import('../../web/src/shared/crypto/prekeys.js');

function b64(u8) { return Buffer.from(u8).toString('base64'); }
function b64u8(b) { return new Uint8Array(Buffer.from(b, 'base64')); }

function cloneU8(u8) {
  return u8 instanceof Uint8Array ? new Uint8Array(u8) : null;
}

/** Deep-snapshot a DR state object (simulates snapshotDrState + restoreDrStateFromSnapshot) */
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

/** Restore DR state from a snapshot (simulates restoreDrStateFromSnapshot) */
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
  const alice = await x3dhInitiate(privA, {
    ik_pub: bundleB.ik_pub, spk_pub: bundleB.spk_pub,
    spk_sig: bundleB.spk_sig, opk: bobOpk
  });
  alice.skippedKeys = new Map();
  const bob = await x3dhRespond(privB, {
    ik_pub: privA.ik_pub_b64, spk_pub: privA.spk_pub_b64,
    spk_sig: privA.spk_sig_b64, ek_pub: b64(alice.myRatchetPub), opk_id: bobOpk.id
  });
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

describe('Phase 3.1 — CounterTooLow DR state rollback', () => {
  it('rollback + re-encrypt produces decryptable packet at same chain position', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice sends 2 messages to establish some chain state
    await sendAndDeliver(alice, bob, 'msg-1', 'dev-A');
    await sendAndDeliver(alice, bob, 'msg-2', 'dev-A');

    // Snapshot BEFORE the third encrypt (simulates preSnapshot in sendText)
    const preSnapshot = takeSnapshot(alice);

    // Alice encrypts (simulates the first attempt that will get 409)
    const failedPkt = await drEncryptText(alice, 'msg-3', { deviceId: 'dev-A', version: 1 });

    // Verify state advanced (Ns increased, chain key changed)
    assert.notStrictEqual(alice.Ns, preSnapshot.Ns, 'Ns should have advanced after encrypt');

    // === ROLLBACK (simulates CounterTooLow repair) ===
    restoreSnapshot(alice, preSnapshot);
    // Set NsTotal to "server expected - 1" (simulates state.NsTotal = expectedCounter - 1)
    // In this test, the transport counter stays the same since we're just testing the DR layer
    alice.NsTotal = preSnapshot.NsTotal;

    // Verify state is back to pre-encrypt
    assert.strictEqual(alice.Ns, preSnapshot.Ns, 'Ns should be restored after rollback');
    assert.strictEqual(alice.ckS ? b64(alice.ckS) : null, preSnapshot.ckS_b64, 'ckS should be restored');

    // Alice re-encrypts from the rolled-back state (same chain position)
    const retryPkt = await drEncryptText(alice, 'msg-3', { deviceId: 'dev-A', version: 1 });

    // The retry packet should be at the SAME chain counter as the failed one
    assert.strictEqual(retryPkt.header.n, failedPkt.header.n, 'retry should use same chain counter');

    // Bob should be able to decrypt the retry packet
    const header = JSON.parse(JSON.stringify(retryPkt.header));
    const plain = await drDecryptText(
      bob,
      { header, ciphertext_b64: retryPkt.ciphertext_b64, iv_b64: retryPkt.iv_b64 },
      { packetKey: null, msgType: 'text' }
    );
    assert.strictEqual(plain, 'msg-3');

    // Verify no skippedKeys on either side
    const aliceSkipped = alice.skippedKeys instanceof Map ? alice.skippedKeys.size : 0;
    const bobSkipped = bob.skippedKeys instanceof Map ? bob.skippedKeys.size : 0;
    assert.strictEqual(aliceSkipped, 0, 'Alice should have no skippedKeys');
    assert.strictEqual(bobSkipped, 0, 'Bob should have no skippedKeys');
  });

  it('WITHOUT rollback, re-encrypt uses different chain counter (demonstrates phantom)', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice sends 1 message
    await sendAndDeliver(alice, bob, 'setup', 'dev-A');

    // Snapshot before
    const preSnapshot = takeSnapshot(alice);

    // First encrypt (would be rejected by server — consumes chain key)
    const failedPkt = await drEncryptText(alice, 'test', { deviceId: 'dev-A', version: 1 });
    assert.strictEqual(failedPkt.header.n, 2, 'first attempt should be chain counter 2');

    // NO rollback — just re-encrypt on advanced state (the old broken behavior)
    const retryPkt = await drEncryptText(alice, 'test', { deviceId: 'dev-A', version: 1 });

    // The retry packet is at a DIFFERENT chain counter than the failed one
    assert.strictEqual(retryPkt.header.n, 3,
      'without rollback, retry uses chain counter 3 (n=2 was consumed by phantom)');

    // WITH rollback (for comparison), the retry would use the same counter
    restoreSnapshot(alice, preSnapshot);
    alice.NsTotal = preSnapshot.NsTotal;
    const rollbackRetry = await drEncryptText(alice, 'test', { deviceId: 'dev-A', version: 1 });
    assert.strictEqual(rollbackRetry.header.n, 2,
      'with rollback, retry reuses chain counter 2 (no phantom)');
  });

  it('rollback works correctly across ratchet boundaries', async () => {
    const { alice, bob } = await bootstrapSession();

    // Ping-pong to trigger ratchets
    await sendAndDeliver(alice, bob, 'a1', 'dev-A');
    await sendAndDeliver(bob, alice, 'b1', 'dev-B');
    await sendAndDeliver(alice, bob, 'a2', 'dev-A');

    // After ratchets, snapshot
    const preSnapshot = takeSnapshot(alice);

    // Encrypt (would fail)
    await drEncryptText(alice, 'will-fail', { deviceId: 'dev-A', version: 1 });

    // Rollback
    restoreSnapshot(alice, preSnapshot);
    alice.NsTotal = preSnapshot.NsTotal;

    // Re-encrypt
    const retryPkt = await drEncryptText(alice, 'retry-after-ratchet', { deviceId: 'dev-A', version: 1 });

    // Bob decrypts
    const header = JSON.parse(JSON.stringify(retryPkt.header));
    const plain = await drDecryptText(
      bob,
      { header, ciphertext_b64: retryPkt.ciphertext_b64, iv_b64: retryPkt.iv_b64 },
      { packetKey: null, msgType: 'text' }
    );
    assert.strictEqual(plain, 'retry-after-ratchet');

    // No phantoms
    const bobSkipped = bob.skippedKeys instanceof Map
      ? [...bob.skippedKeys.values()].reduce((acc, chain) => acc + (chain instanceof Map ? chain.size : 0), 0)
      : 0;
    assert.strictEqual(bobSkipped, 0, 'No skippedKeys after rollback across ratchet boundary');
  });

  it('conversation continues normally after rollback repair', async () => {
    const { alice, bob } = await bootstrapSession();

    await sendAndDeliver(alice, bob, 'before', 'dev-A');

    // Simulate CounterTooLow repair
    const snap = takeSnapshot(alice);
    await drEncryptText(alice, 'failed', { deviceId: 'dev-A', version: 1 }); // consumed chain key
    restoreSnapshot(alice, snap);
    alice.NsTotal = snap.NsTotal;

    // Re-encrypt and deliver
    await sendAndDeliver(alice, bob, 'repaired', 'dev-A');

    // Continue conversation normally
    await sendAndDeliver(bob, alice, 'reply', 'dev-B');
    await sendAndDeliver(alice, bob, 'after-repair', 'dev-A');
    await sendAndDeliver(bob, alice, 'final', 'dev-B');

    // All counters are clean
    assert.strictEqual(alice.NsTotal, 3, 'Alice total sends = 3');
    assert.strictEqual(bob.NsTotal, 2, 'Bob total sends = 2');

    const aliceSkipped = alice.skippedKeys instanceof Map ? alice.skippedKeys.size : 0;
    const bobSkipped = bob.skippedKeys instanceof Map ? bob.skippedKeys.size : 0;
    assert.strictEqual(aliceSkipped, 0);
    assert.strictEqual(bobSkipped, 0);
  });
});
