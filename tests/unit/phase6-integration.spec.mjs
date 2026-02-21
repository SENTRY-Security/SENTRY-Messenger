#!/usr/bin/env node
/**
 * Phase 6 — Integration Tests for Forward Secrecy Implementation
 *
 * End-to-end test scenarios validating the complete forward secrecy
 * implementation under various real-world conditions.
 *
 *   6.1 — Basic Ratchet Rotation (multi-directional)
 *   6.2 — Monotonic Receive with empty skippedKeys
 *   6.3 — Logout → Login → Restore
 *   6.4 — Force-Logout → New Device Login
 *   6.5 — CounterTooLow Recovery with Ratchet Correctness
 *   6.6 — gap-queue 404 Fault Tolerance (DR chain continuity)
 *
 * Usage: node --test tests/unit/phase6-integration.spec.mjs
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

// Helper: encrypt only (don't deliver to receiver)
async function encryptOnly(sender, text, senderDeviceId) {
  const pkt = await drEncryptText(sender, text, { deviceId: senderDeviceId, version: 1 });
  return pkt;
}

// Helper: deliver only (decrypt a previously encrypted packet)
async function deliverOnly(receiver, pkt) {
  const header = JSON.parse(JSON.stringify(pkt.header));
  const plain = await drDecryptText(
    receiver,
    { header, ciphertext_b64: pkt.ciphertext_b64, iv_b64: pkt.iv_b64 },
    { packetKey: null, msgType: 'text' }
  );
  return plain;
}

// ═══════════════════════════════════════════════════════════════
// 6.1 — Basic Ratchet Rotation
// ═══════════════════════════════════════════════════════════════

describe('6.1 — E2E: Basic Ratchet Rotation', () => {
  it('Alice→Bob(5) → Bob→Alice(3) → Alice→Bob(2): all decrypt, ek changes on direction switch', async () => {
    const { alice, bob } = await bootstrapSession();
    const ekSeen = { alice: new Set(), bob: new Set() };

    // Alice → Bob: 5 messages
    for (let i = 0; i < 5; i++) {
      const r = await sendAndDeliver(alice, bob, `a2b-${i}`, 'dev-A');
      assert.strictEqual(r.plain, `a2b-${i}`);
      ekSeen.alice.add(r.header.ek_pub_b64);
    }
    // All 5 messages should use same ek (same epoch)
    assert.strictEqual(ekSeen.alice.size, 1, 'Alice ek should be constant within one direction');

    // Bob → Alice: 3 messages
    for (let i = 0; i < 3; i++) {
      const r = await sendAndDeliver(bob, alice, `b2a-${i}`, 'dev-B');
      assert.strictEqual(r.plain, `b2a-${i}`);
      ekSeen.bob.add(r.header.ek_pub_b64);
    }
    assert.strictEqual(ekSeen.bob.size, 1, 'Bob ek should be constant within one direction');

    // Alice → Bob: 2 more messages (new ratchet epoch for Alice)
    const aliceEkBefore = [...ekSeen.alice][0];
    for (let i = 0; i < 2; i++) {
      const r = await sendAndDeliver(alice, bob, `a2b-more-${i}`, 'dev-A');
      assert.strictEqual(r.plain, `a2b-more-${i}`);
      ekSeen.alice.add(r.header.ek_pub_b64);
    }

    // Alice should have rotated her ek
    assert.strictEqual(ekSeen.alice.size, 2, 'Alice should have 2 distinct ek values (2 epochs)');
    assert.strictEqual(ekSeen.bob.size, 1, 'Bob ek should still be 1 (only one send direction)');

    // ek must differ across epochs
    const aliceEks = [...ekSeen.alice];
    assert.notStrictEqual(aliceEks[0], aliceEks[1], 'Alice ek must differ between epochs');

    // Verify counters
    assert.strictEqual(alice.NsTotal, 7, 'Alice total sends = 5 + 2 = 7');
    assert.strictEqual(bob.NsTotal, 3, 'Bob total sends = 3');
  });

  it('no decryption failures at ratchet boundaries', async () => {
    const { alice, bob } = await bootstrapSession();

    // Rapid direction switches at boundary
    for (let round = 0; round < 5; round++) {
      const ra = await sendAndDeliver(alice, bob, `boundary-a-${round}`, 'dev-A');
      assert.strictEqual(ra.plain, `boundary-a-${round}`);
      const rb = await sendAndDeliver(bob, alice, `boundary-b-${round}`, 'dev-B');
      assert.strictEqual(rb.plain, `boundary-b-${round}`);
    }

    // Single-message direction switches (maximum ratchet frequency)
    assert.strictEqual(alice.NsTotal, 5);
    assert.strictEqual(bob.NsTotal, 5);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6.2 — Monotonic Receive with empty skippedKeys
// ═══════════════════════════════════════════════════════════════

describe('6.2 — E2E: Monotonic Receive with empty skippedKeys', () => {
  it('onSkippedKeys callback is never triggered during monotonic delivery', async () => {
    const { alice, bob } = await bootstrapSession();
    let skippedKeysCallbackCount = 0;

    // Alice → Bob: 3 messages, then direction change, then 2 more
    for (let i = 0; i < 3; i++) {
      const pkt = await drEncryptText(alice, `a-${i}`, { deviceId: 'dev-A', version: 1 });
      const header = JSON.parse(JSON.stringify(pkt.header));
      await drDecryptText(bob, { header, ciphertext_b64: pkt.ciphertext_b64, iv_b64: pkt.iv_b64 }, {
        packetKey: null,
        msgType: 'text',
        onSkippedKeys: (keys) => { skippedKeysCallbackCount += keys.length; }
      });
    }

    // Bob → Alice: 2 messages (triggers ratchet)
    for (let i = 0; i < 2; i++) {
      const pkt = await drEncryptText(bob, `b-${i}`, { deviceId: 'dev-B', version: 1 });
      const header = JSON.parse(JSON.stringify(pkt.header));
      await drDecryptText(alice, { header, ciphertext_b64: pkt.ciphertext_b64, iv_b64: pkt.iv_b64 }, {
        packetKey: null,
        msgType: 'text',
        onSkippedKeys: (keys) => { skippedKeysCallbackCount += keys.length; }
      });
    }

    // Alice → Bob: 2 more messages (another ratchet)
    for (let i = 0; i < 2; i++) {
      const pkt = await drEncryptText(alice, `a2-${i}`, { deviceId: 'dev-A', version: 1 });
      const header = JSON.parse(JSON.stringify(pkt.header));
      await drDecryptText(bob, { header, ciphertext_b64: pkt.ciphertext_b64, iv_b64: pkt.iv_b64 }, {
        packetKey: null,
        msgType: 'text',
        onSkippedKeys: (keys) => { skippedKeysCallbackCount += keys.length; }
      });
    }

    assert.strictEqual(skippedKeysCallbackCount, 0,
      'onSkippedKeys should never be triggered under monotonic delivery');

    // skippedKeys maps should be empty
    const aliceSkipped = alice.skippedKeys instanceof Map ? alice.skippedKeys.size : 0;
    const bobSkipped = bob.skippedKeys instanceof Map ? bob.skippedKeys.size : 0;
    assert.strictEqual(aliceSkipped, 0, 'Alice skippedKeys must be empty');
    assert.strictEqual(bobSkipped, 0, 'Bob skippedKeys must be empty');
  });

  it('pn consistency holds at every ratchet boundary', async () => {
    const { alice, bob } = await bootstrapSession();

    // Track pn values at ratchet boundaries
    const pnChecks = [];

    // Alice sends 3
    for (let i = 0; i < 3; i++) {
      await sendAndDeliver(alice, bob, `a-${i}`, 'dev-A');
    }

    // Bob replies (pn should be 0 — Bob had 0 messages in previous send chain)
    const r1 = await sendAndDeliver(bob, alice, 'b-0', 'dev-B');
    pnChecks.push({ who: 'bob', pn: r1.header.pn, expectedPn: 0 });

    // Alice replies (pn should be 3 — Alice sent 3 in previous epoch)
    const r2 = await sendAndDeliver(alice, bob, 'a-3', 'dev-A');
    pnChecks.push({ who: 'alice', pn: r2.header.pn, expectedPn: 3 });

    // Bob sends 2 then Alice replies
    await sendAndDeliver(bob, alice, 'b-1', 'dev-B');
    const r3 = await sendAndDeliver(bob, alice, 'b-2', 'dev-B');

    const r4 = await sendAndDeliver(alice, bob, 'a-4', 'dev-A');
    pnChecks.push({ who: 'alice', pn: r4.header.pn, expectedPn: 1 });

    for (const check of pnChecks) {
      assert.strictEqual(check.pn, check.expectedPn,
        `${check.who} pn should be ${check.expectedPn}, got ${check.pn}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 6.3 — Logout → Login → Restore
// ═══════════════════════════════════════════════════════════════

describe('6.3 — E2E: Logout → Login → Restore', () => {
  it('DR state restores correctly from snapshot after logout/login cycle', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice → Bob: 5 messages
    for (let i = 0; i < 5; i++) {
      await sendAndDeliver(alice, bob, `pre-logout-${i}`, 'dev-A');
    }

    // Snapshot Bob's state (simulates server-side backup via atomicSend/vaultPut)
    const bobBackup = takeSnapshot(bob);

    // Bob "logs out" — clear all in-memory state
    bob.rk = null; bob.ckS = null; bob.ckR = null;
    bob.Ns = 0; bob.Nr = 0; bob.PN = 0;
    bob.NsTotal = 0; bob.NrTotal = 0;
    bob.myRatchetPriv = null; bob.myRatchetPub = null;
    bob.theirRatchetPub = null;

    // Bob "logs in" — restore from backup
    restoreSnapshot(bob, bobBackup);
    bob.skippedKeys = new Map();
    // [Phase 4.2] Force DH ratchet on next send
    bob.pendingSendRatchet = true;

    // Verify state restored correctly
    assert.strictEqual(bob.NrTotal, 5, 'Bob NrTotal should be 5 after restore');
    assert.strictEqual(bob.Nr, 5, 'Bob Nr should be 5 after restore');

    // Bob can now send messages
    const r1 = await sendAndDeliver(bob, alice, 'post-login-1', 'dev-B');
    assert.strictEqual(r1.plain, 'post-login-1');

    // Alice can send to Bob
    const r2 = await sendAndDeliver(alice, bob, 'post-login-2', 'dev-A');
    assert.strictEqual(r2.plain, 'post-login-2');

    // Continue bidirectional exchange
    const r3 = await sendAndDeliver(bob, alice, 'post-login-3', 'dev-B');
    assert.strictEqual(r3.plain, 'post-login-3');
  });

  it('restore preserves counter continuity', async () => {
    const { alice, bob } = await bootstrapSession();

    // Build up state
    await sendAndDeliver(alice, bob, 'a1', 'dev-A');
    await sendAndDeliver(bob, alice, 'b1', 'dev-B');
    await sendAndDeliver(alice, bob, 'a2', 'dev-A');

    const bobBackup = takeSnapshot(bob);

    // Logout + login
    restoreSnapshot(bob, bobBackup);
    bob.skippedKeys = new Map();
    bob.pendingSendRatchet = true;

    // Bob sends 3 messages
    for (let i = 0; i < 3; i++) {
      const r = await sendAndDeliver(bob, alice, `post-restore-${i}`, 'dev-B');
      assert.strictEqual(r.plain, `post-restore-${i}`);
    }

    // NsTotal should continue monotonically
    assert.strictEqual(bob.NsTotal, 4, 'Bob NsTotal = 1 (before) + 3 (after) = 4');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6.4 — Force-Logout → New Device Login
// ═══════════════════════════════════════════════════════════════

describe('6.4 — E2E: Force-Logout → New Device Login', () => {
  it('stale snapshot + gap-queue replay recovers all messages', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice → Bob: 2 messages
    await sendAndDeliver(alice, bob, 'a1', 'dev-A');
    await sendAndDeliver(alice, bob, 'a2', 'dev-A');

    // Take STALE snapshot of Bob (before messages 3-5)
    const staleBackup = takeSnapshot(bob);

    // Alice → Bob: 3 more messages (Bob processes them)
    const laterPackets = [];
    for (let i = 3; i <= 5; i++) {
      const pkt = await encryptOnly(alice, `a${i}`, 'dev-A');
      laterPackets.push(pkt);
      await deliverOnly(bob, pkt); // Bob processes in current session
    }

    // "Force-logout" (kicked) — Bob loses in-memory state
    // Restore from STALE backup (before messages 3-5)
    restoreSnapshot(bob, staleBackup);
    bob.skippedKeys = new Map();
    bob.pendingSendRatchet = true;

    // Gap-queue replay: re-process messages 3-5 from server
    for (const pkt of laterPackets) {
      const plain = await deliverOnly(bob, pkt);
      assert.ok(plain.startsWith('a'), `Should decrypt: ${plain}`);
    }

    // Verify Bob's state is now up-to-date
    assert.strictEqual(bob.NrTotal, 5, 'Bob NrTotal should be 5 after replay');

    // Alice sends 3 more messages — Bob should decrypt all
    for (let i = 6; i <= 8; i++) {
      const r = await sendAndDeliver(alice, bob, `a${i}`, 'dev-A');
      assert.strictEqual(r.plain, `a${i}`);
    }

    assert.strictEqual(bob.NrTotal, 8, 'Bob NrTotal should be 8 after new messages');
  });

  it('stale snapshot + gap-queue replay works across ratchet boundaries', async () => {
    const { alice, bob } = await bootstrapSession();

    // Exchange to establish ratchets
    await sendAndDeliver(alice, bob, 'a1', 'dev-A');
    await sendAndDeliver(bob, alice, 'b1', 'dev-B');

    // Stale snapshot
    const staleBackup = takeSnapshot(bob);

    // Alice sends 2 messages (same epoch as before)
    const p1 = await encryptOnly(alice, 'a2', 'dev-A');
    await deliverOnly(bob, p1);

    const p2 = await encryptOnly(alice, 'a3', 'dev-A');
    await deliverOnly(bob, p2);

    // Force-logout → restore stale
    restoreSnapshot(bob, staleBackup);
    bob.skippedKeys = new Map();
    bob.pendingSendRatchet = true;

    // Gap-queue replays p1 and p2
    assert.strictEqual(await deliverOnly(bob, p1), 'a2');
    assert.strictEqual(await deliverOnly(bob, p2), 'a3');

    // drRatchet was deterministic — ckR derived from same myRatchetPriv + theirRatchetPub
    // Continue communication
    const r = await sendAndDeliver(bob, alice, 'b2-recovered', 'dev-B');
    assert.strictEqual(r.plain, 'b2-recovered');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6.5 — CounterTooLow Recovery with Ratchet Correctness
// ═══════════════════════════════════════════════════════════════

describe('6.5 — E2E: CounterTooLow Recovery with Ratchet Correctness', () => {
  it('rollback after ratchet: re-encrypt is valid, no skippedKeys', async () => {
    const { alice, bob } = await bootstrapSession();

    // Build up ratchet state
    await sendAndDeliver(alice, bob, 'a1', 'dev-A');
    await sendAndDeliver(bob, alice, 'b1', 'dev-B');
    await sendAndDeliver(alice, bob, 'a2', 'dev-A');
    await sendAndDeliver(bob, alice, 'b2', 'dev-B');

    // Snapshot before the problematic send
    const preSnapshot = takeSnapshot(alice);

    // Alice encrypts (would be rejected by server with 409)
    const failedPkt = await drEncryptText(alice, 'will-fail', { deviceId: 'dev-A', version: 1 });
    const failedN = failedPkt.header.n;

    // Rollback to pre-encrypt state
    restoreSnapshot(alice, preSnapshot);
    alice.NsTotal = preSnapshot.NsTotal; // server would correct this

    // Re-encrypt from same chain position
    const retryPkt = await drEncryptText(alice, 'retried', { deviceId: 'dev-A', version: 1 });

    // Chain counter should be the same
    assert.strictEqual(retryPkt.header.n, failedN, 'Retry should use same chain counter as failed');

    // Bob decrypts successfully
    const header = JSON.parse(JSON.stringify(retryPkt.header));
    const plain = await drDecryptText(
      bob,
      { header, ciphertext_b64: retryPkt.ciphertext_b64, iv_b64: retryPkt.iv_b64 },
      { packetKey: null, msgType: 'text' }
    );
    assert.strictEqual(plain, 'retried');

    // No skippedKeys
    const bobSkipped = bob.skippedKeys instanceof Map
      ? [...bob.skippedKeys.values()].reduce((acc, chain) => acc + (chain instanceof Map ? chain.size : 0), 0)
      : 0;
    assert.strictEqual(bobSkipped, 0, 'No skippedKeys after rollback repair');
  });

  it('multiple consecutive CounterTooLow repairs maintain chain integrity', async () => {
    const { alice, bob } = await bootstrapSession();

    await sendAndDeliver(alice, bob, 'setup', 'dev-A');

    // Simulate 3 consecutive CounterTooLow failures + repairs
    for (let attempt = 0; attempt < 3; attempt++) {
      const preSnap = takeSnapshot(alice);
      await drEncryptText(alice, `fail-${attempt}`, { deviceId: 'dev-A', version: 1 }); // consumed
      restoreSnapshot(alice, preSnap);
      alice.NsTotal = preSnap.NsTotal;
    }

    // Final successful send
    const r = await sendAndDeliver(alice, bob, 'final-success', 'dev-A');
    assert.strictEqual(r.plain, 'final-success');

    // Continue conversation
    const r2 = await sendAndDeliver(bob, alice, 'bob-reply', 'dev-B');
    assert.strictEqual(r2.plain, 'bob-reply');

    const r3 = await sendAndDeliver(alice, bob, 'alice-again', 'dev-A');
    assert.strictEqual(r3.plain, 'alice-again');

    // No skippedKeys
    const aliceSkipped = alice.skippedKeys instanceof Map ? alice.skippedKeys.size : 0;
    const bobSkipped = bob.skippedKeys instanceof Map ? bob.skippedKeys.size : 0;
    assert.strictEqual(aliceSkipped, 0);
    assert.strictEqual(bobSkipped, 0);
  });

  it('CounterTooLow at ratchet boundary with pn verification', async () => {
    const { alice, bob } = await bootstrapSession();

    // Ping-pong to trigger ratchet
    await sendAndDeliver(alice, bob, 'a1', 'dev-A');
    await sendAndDeliver(alice, bob, 'a2', 'dev-A');
    await sendAndDeliver(bob, alice, 'b1', 'dev-B');

    // Snapshot before Alice sends in new epoch (after receiving Bob's ratchet)
    const preSnap = takeSnapshot(alice);

    // Alice encrypts (would fail — 409)
    const failed = await drEncryptText(alice, 'fail', { deviceId: 'dev-A', version: 1 });

    // Rollback
    restoreSnapshot(alice, preSnap);
    alice.NsTotal = preSnap.NsTotal;

    // Re-encrypt
    const retry = await drEncryptText(alice, 'retry-at-boundary', { deviceId: 'dev-A', version: 1 });

    // pn should correctly reflect the previous chain length
    assert.strictEqual(retry.header.pn, failed.header.pn, 'pn should be same after rollback');

    // Bob decrypts
    const header = JSON.parse(JSON.stringify(retry.header));
    const plain = await drDecryptText(
      bob,
      { header, ciphertext_b64: retry.ciphertext_b64, iv_b64: retry.iv_b64 },
      { packetKey: null, msgType: 'text' }
    );
    assert.strictEqual(plain, 'retry-at-boundary');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6.6 — gap-queue 404 Fault Tolerance (DR chain continuity)
// ═══════════════════════════════════════════════════════════════

describe('6.6 — E2E: gap-queue 404 Fault Tolerance', () => {
  it('DR chain remains consistent when transport counter has phantom gap', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice sends messages at transport counters 1-4
    const pkts = [];
    for (let i = 1; i <= 4; i++) {
      const pkt = await encryptOnly(alice, `msg-${i}`, 'dev-A');
      pkts.push(pkt);
    }

    // Simulate: message at transport counter 5 fails (409 CounterTooLow)
    // Alice encrypts but server rejects → phantom counter
    const prePhantomSnap = takeSnapshot(alice);
    const phantomPkt = await drEncryptText(alice, 'phantom', { deviceId: 'dev-A', version: 1 });
    // Rollback (phantom was never persisted)
    restoreSnapshot(alice, prePhantomSnap);
    // Server assigns next counter as 6 (skipping 5)
    alice.NsTotal = 5; // server says "expected_counter = 6, so NsTotal before encrypt = 5"

    // Alice re-encrypts at transport counter 6
    const repairedPkt = await encryptOnly(alice, 'msg-6-repaired', 'dev-A');
    assert.strictEqual(alice.NsTotal, 6, 'NsTotal should be 6 after repair');

    // Bob processes transport counters 1-4 normally
    for (let i = 0; i < 4; i++) {
      const plain = await deliverOnly(bob, pkts[i]);
      assert.strictEqual(plain, `msg-${i + 1}`);
    }

    // Transport counter 5: gap-queue gets 404 → skip
    // (No packet to process — phantom was never persisted)

    // Transport counter 6: Bob processes the repaired message
    // The DR chain counter for this message is the same as the phantom's
    // (because Alice rolled back before re-encrypting)
    const plain6 = await deliverOnly(bob, repairedPkt);
    assert.strictEqual(plain6, 'msg-6-repaired');

    // No skippedKeys (DR chain is continuous even though transport counter has a gap)
    const bobSkipped = bob.skippedKeys instanceof Map ? bob.skippedKeys.size : 0;
    assert.strictEqual(bobSkipped, 0,
      'No skippedKeys: DR chain is continuous despite transport counter gap');

    // Verify NrTotal reflects processed messages (5 = messages at counters 1,2,3,4,6)
    assert.strictEqual(bob.NrTotal, 5, 'Bob NrTotal = 5 (processed 5 DR messages)');
  });

  it('multiple phantom gaps do not break DR chain', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice sends 2 messages normally
    await sendAndDeliver(alice, bob, 'msg-1', 'dev-A');
    await sendAndDeliver(alice, bob, 'msg-2', 'dev-A');

    // First phantom: counter 3 lost
    const snap1 = takeSnapshot(alice);
    await drEncryptText(alice, 'phantom-3', { deviceId: 'dev-A', version: 1 });
    restoreSnapshot(alice, snap1);
    alice.NsTotal = 3;

    // Successful send at counter 4
    const r4 = await sendAndDeliver(alice, bob, 'msg-4', 'dev-A');
    assert.strictEqual(r4.plain, 'msg-4');

    // Second phantom: counter 5 lost
    const snap2 = takeSnapshot(alice);
    await drEncryptText(alice, 'phantom-5', { deviceId: 'dev-A', version: 1 });
    restoreSnapshot(alice, snap2);
    alice.NsTotal = 5;

    // Successful send at counter 6
    const r6 = await sendAndDeliver(alice, bob, 'msg-6', 'dev-A');
    assert.strictEqual(r6.plain, 'msg-6');

    // All messages decrypted, no skippedKeys
    const bobSkipped = bob.skippedKeys instanceof Map ? bob.skippedKeys.size : 0;
    assert.strictEqual(bobSkipped, 0, 'No skippedKeys despite multiple phantom gaps');

    // DR chain counters are continuous (4 messages processed)
    assert.strictEqual(bob.NrTotal, 4, 'Bob NrTotal = 4 (2 + 1 + 1, skipping phantoms)');
  });

  it('direction switch after phantom gap maintains correct pn', async () => {
    const { alice, bob } = await bootstrapSession();

    // Alice sends 2 messages
    await sendAndDeliver(alice, bob, 'a1', 'dev-A');
    await sendAndDeliver(alice, bob, 'a2', 'dev-A');

    // Phantom at counter 3
    const snap = takeSnapshot(alice);
    await drEncryptText(alice, 'phantom', { deviceId: 'dev-A', version: 1 });
    restoreSnapshot(alice, snap);
    alice.NsTotal = 3;

    // Successful send at counter 4
    await sendAndDeliver(alice, bob, 'a4', 'dev-A');

    // Bob replies (triggers ratchet)
    const bobReply = await sendAndDeliver(bob, alice, 'b1', 'dev-B');
    assert.strictEqual(bobReply.plain, 'b1');

    // Alice replies back (new ratchet epoch)
    const aliceReply = await sendAndDeliver(alice, bob, 'a5', 'dev-A');
    assert.strictEqual(aliceReply.plain, 'a5');

    // pn should reflect actual messages sent in previous epoch (3: a1, a2, a4)
    // The DR chain sent 3 messages (Ns was 3 before ratchet)
    assert.strictEqual(aliceReply.header.pn, 3,
      'pn should count actual DR chain messages (3), not transport counters');
  });
});
