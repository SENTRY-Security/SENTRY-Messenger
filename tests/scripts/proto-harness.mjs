#!/usr/bin/env node
// Deterministic in-memory protocol harness for X3DH + Double Ratchet.
// Usage: node tests/scripts/proto-harness.mjs
// Set PROTO_HARNESS_SEED to control deterministic RNG (default: proto-harness-seed).

import { webcrypto } from 'node:crypto';
import { TextEncoder, TextDecoder } from 'node:util';

const SEED = process.env.PROTO_HARNESS_SEED || 'proto-harness-seed';

const accountDigestA = 'a'.repeat(64);
const accountDigestB = 'b'.repeat(64);
const deviceIdA = 'device-A';
const deviceIdB = 'device-B';
const conversationId = 'conv-a-b';

const contactSecrets = new Map(); // peerKey -> snapshot
const drHolders = new Map(); // holderId -> state
const prekeyQueues = new Map(); // deviceId -> [{id,pub}]

const encoder = new TextEncoder();

class HarnessError extends Error {
  constructor(message, meta = null) {
    super(message);
    this.meta = meta;
  }
}

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function murmur() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function sfc32(a, b, c, d) {
  return function rand() {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const res = (t + d) | 0;
    c = (c + res) | 0;
    return (res >>> 0) / 4294967296;
  };
}

function makeSeededRng(seedStr) {
  const seedGen = xmur3(seedStr || 'proto-harness');
  const rand = sfc32(seedGen(), seedGen(), seedGen(), seedGen());
  return {
    random: () => rand(),
    bytes: (len) => {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) out[i] = Math.floor(rand() * 256) & 0xff;
      return out;
    }
  };
}

function uuidFromBytes(bytes) {
  const b = new Uint8Array(bytes);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function hashPrefix(u8, len = 12) {
  if (!(u8 instanceof Uint8Array)) return null;
  const digest = await crypto.subtle.digest('SHA-256', u8);
  const hex = Buffer.from(digest).toString('hex');
  return hex.slice(0, len);
}

function ensureStorage() {
  const backing = new Map();
  const storage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
    key: (i) => Array.from(backing.keys())[i] ?? null,
    get length() { return backing.size; }
  };
  if (typeof globalThis.sessionStorage === 'undefined') globalThis.sessionStorage = storage;
  if (typeof globalThis.localStorage === 'undefined') globalThis.localStorage = storage;
}

async function installDeterministicEnv(seedStr) {
  const rng = makeSeededRng(seedStr);

  const cryptoShim = webcrypto;
  cryptoShim.getRandomValues = (typedArray) => {
    const arr = typedArray;
    const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    view.set(rng.bytes(view.byteLength));
    return arr;
  };
  cryptoShim.randomUUID = () => uuidFromBytes(rng.bytes(16));

  Object.defineProperty(globalThis, 'crypto', { value: cryptoShim, configurable: true, writable: true });
  if (typeof globalThis.TextEncoder === 'undefined') Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder });
  if (typeof globalThis.TextDecoder === 'undefined') Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder });
  if (typeof globalThis.atob === 'undefined') globalThis.atob = (b64) => Buffer.from(String(b64), 'base64').toString('binary');
  if (typeof globalThis.btoa === 'undefined') globalThis.btoa = (bin) => Buffer.from(String(bin), 'binary').toString('base64');
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  ensureStorage();
  Math.random = () => rng.random();

  const naclMod = await import('tweetnacl');
  const nacl = naclMod.default || naclMod;
  if (typeof nacl.setPRNG === 'function') {
    nacl.setPRNG((out, len) => {
      const bytes = rng.bytes(len);
      for (let i = 0; i < len; i += 1) out[i] = bytes[i];
      return out;
    });
  }
  return { rng, crypto: cryptoShim };
}

function b64(u8) {
  return Buffer.from(u8).toString('base64');
}

function b64u8(b64s) {
  return Uint8Array.from(Buffer.from(String(b64s || ''), 'base64'));
}

function flipOneBit(u8) {
  if (!(u8 instanceof Uint8Array) || !u8.length) throw new HarnessError('flipOneBit expects Uint8Array');
  const out = new Uint8Array(u8);
  out[0] = out[0] ^ 1;
  return out;
}

function tamperHeaderJson(jsonStr) {
  const obj = JSON.parse(jsonStr);
  const flipStrBit = (s) => {
    if (typeof s !== 'string' || !s.length) return null;
    const buf = Buffer.from(s);
    buf[0] = buf[0] ^ 1;
    return buf.toString();
  };
  if (obj.device_id) {
    obj.device_id = flipStrBit(obj.device_id) || `${obj.device_id}-x`;
  } else if (obj.deviceId) {
    obj.deviceId = flipStrBit(obj.deviceId) || `${obj.deviceId}-x`;
  } else if (Number.isFinite(obj.n)) {
    obj.n = obj.n ^ 1;
  } else if (Number.isFinite(obj.v)) {
    obj.v = obj.v ^ 1;
  } else {
    obj.tampered = true;
  }
  return JSON.stringify(obj);
}

function snapshotForContact(state) {
  return {
    rk_b64: state?.rk ? b64(state.rk) : null,
    ckS_b64: state?.ckS ? b64(state.ckS) : null,
    ckR_b64: state?.ckR ? b64(state.ckR) : null,
    Ns: Number(state?.Ns ?? 0),
    Nr: Number(state?.Nr ?? 0),
    PN: Number(state?.PN ?? 0),
    theirRatchetPub_b64: state?.theirRatchetPub ? b64(state.theirRatchetPub) : null,
    myRatchetPub_b64: state?.myRatchetPub ? b64(state.myRatchetPub) : null,
    baseRole: state?.baseKey?.role || state?.baseRole || null
  };
}

function storeContactSecret(selfDigest, peerDigest, peerDeviceId, state) {
  const key = `${selfDigest}::${peerDigest}::${peerDeviceId}`;
  contactSecrets.set(key, snapshotForContact(state));
}

function cloneState(holder) {
  const copy = {
    rk: holder?.rk ? new Uint8Array(holder.rk) : null,
    ckS: holder?.ckS ? new Uint8Array(holder.ckS) : null,
    ckR: holder?.ckR ? new Uint8Array(holder.ckR) : null,
    Ns: Number(holder?.Ns ?? 0),
    Nr: Number(holder?.Nr ?? 0),
    PN: Number(holder?.PN ?? 0),
    NsTotal: Number(holder?.NsTotal ?? 0),
    NrTotal: Number(holder?.NrTotal ?? 0),
    myRatchetPriv: holder?.myRatchetPriv ? new Uint8Array(holder.myRatchetPriv) : null,
    myRatchetPub: holder?.myRatchetPub ? new Uint8Array(holder.myRatchetPub) : null,
    theirRatchetPub: holder?.theirRatchetPub ? new Uint8Array(holder.theirRatchetPub) : null,
    pendingSendRatchet: !!holder?.pendingSendRatchet,
    baseKey: holder?.baseKey ? { ...holder.baseKey } : undefined,
    baseRole: holder?.baseRole || holder?.baseKey?.role || null,
    __id: holder?.__id || null,
    skippedKeys: new Map()
  };
  if (holder?.skippedKeys instanceof Map) {
    for (const [chain, val] of holder.skippedKeys.entries()) {
      copy.skippedKeys.set(chain, val instanceof Map ? new Map(val) : new Map());
    }
  }
  return copy;
}

async function fingerprintState(holder) {
  return {
    Nr: Number.isFinite(holder?.Nr) ? Number(holder.Nr) : null,
    Ns: Number.isFinite(holder?.Ns) ? Number(holder.Ns) : null,
    PN: Number.isFinite(holder?.PN) ? Number(holder.PN) : null,
    theirPubHash: await hashPrefix(holder?.theirRatchetPub || null),
    ckRHash: await hashPrefix(holder?.ckR || null),
    role: holder?.baseKey?.role || holder?.baseRole || null,
    holderId: holder?.__id || null
  };
}

async function main() {
  await installDeterministicEnv(SEED);

  const { generateInitialBundle } = await import('../web/src/shared/crypto/prekeys.js');
  const { x3dhInitiate, x3dhRespond, drEncryptText, drDecryptText, buildDrAadFromHeader } = await import('../web/src/shared/crypto/dr.js');

  const { devicePriv: privA, bundlePub: bundleA } = await generateInitialBundle(1001, 8);
  const { devicePriv: privB, bundlePub: bundleB } = await generateInitialBundle(1, 8);

  privA.device_id = deviceIdA;
  privA.deviceId = deviceIdA;
  privB.device_id = deviceIdB;
  privB.deviceId = deviceIdB;

  prekeyQueues.set(deviceIdA, [...bundleA.opks]);
  prekeyQueues.set(deviceIdB, [...bundleB.opks]);

  const bobOpk = prekeyQueues.get(deviceIdB)?.shift();
  if (!bobOpk) throw new HarnessError('bob missing prekey');

  const bobBundleForAlice = {
    ik_pub: bundleB.ik_pub,
    spk_pub: bundleB.spk_pub,
    spk_sig: bundleB.spk_sig,
    opk: bobOpk
  };

  const aliceState = await x3dhInitiate(privA, bobBundleForAlice);
  const guestBundle = {
    ik_pub: privA.ik_pub_b64,
    spk_pub: privA.spk_pub_b64,
    spk_sig: privA.spk_sig_b64,
    ek_pub: b64(aliceState.myRatchetPub),
    opk_id: bobOpk.id
  };
  const bobState = await x3dhRespond(privB, guestBundle);

  const prepareHolder = (holder, role, selfDigest, peerDigest, selfDeviceId, peerDeviceId, label) => {
    holder.baseKey = {
      role,
      peerAccountDigest: peerDigest,
      peerDeviceId,
      conversationId,
      stateKey: `${role}:${selfDeviceId}->${peerDeviceId}`
    };
    holder.baseRole = role;
    holder.__id = `${label}-${role}`;
    if (!(holder.skippedKeys instanceof Map)) holder.skippedKeys = new Map();
    drHolders.set(holder.__id, holder);
  };

  prepareHolder(aliceState, 'initiator', accountDigestA, accountDigestB, deviceIdA, deviceIdB, 'alice');
  prepareHolder(bobState, 'responder', accountDigestB, accountDigestA, deviceIdB, deviceIdA, 'bob');

  storeContactSecret(accountDigestA, accountDigestB, deviceIdB, aliceState);
  storeContactSecret(accountDigestB, accountDigestA, deviceIdA, bobState);

  const peers = {
    alice: { label: 'Alice', digest: accountDigestA, deviceId: deviceIdA, priv: privA, state: aliceState },
    bob: { label: 'Bob', digest: accountDigestB, deviceId: deviceIdB, priv: privB, state: bobState }
  };

  const logPacket = async ({ direction, packet, packetKey, msgType }) => {
    const aad = buildDrAadFromHeader(packet.header);
    const aadHash = aad ? await hashPrefix(aad) : null;
    const ctHash = await hashPrefix(b64u8(packet.ciphertext_b64));
    const mkHash = await hashPrefix(b64u8(packet.message_key_b64));
    const ek = packet?.header?.ek_pub_b64 ? String(packet.header.ek_pub_b64).slice(0, 12) : null;
    console.log(
      `[packet] ${direction} ek=${ek} n=${packet?.header?.n ?? '?'} key=${packetKey || '-'} type=${msgType || 'text'} aad=${aadHash || '-'} ct=${ctHash || '-'} mk=${mkHash || '-'}`
    );
  };

  const serializePacket = (packet, packetKey, msgType = 'text') => ({
    header_json: JSON.stringify(packet.header),
    ciphertext_b64: packet.ciphertext_b64,
    iv_b64: packet.iv_b64,
    packetKey,
    msgType
  });

  const sendText = async (sender, receiver, plaintext, opts = {}) => {
    const msgType = opts.msgType || 'text';
    const packet = await drEncryptText(sender.state, plaintext, { deviceId: sender.deviceId, version: 1 });
    packet.header.meta = { ...(packet.header.meta || {}), msg_type: msgType };
    const packetKey = `${sender.label}->${receiver.label}#${packet.header.n}`;
    await logPacket({ direction: `${sender.label}->${receiver.label}`, packet, packetKey, msgType });
    return { wire: serializePacket(packet, packetKey, msgType), packet, plaintext, msgType };
  };

  const deliver = async (sender, receiver, wire, expectText, msgType = 'text') => {
    const header = JSON.parse(wire.header_json);
    const packetKey = wire.packetKey || null;
    const msgTypeOpt = wire.msgType || msgType || 'text';
    const before = cloneState(receiver.state);
    try {
      const plain = await drDecryptText(
        receiver.state,
        { header, ciphertext_b64: wire.ciphertext_b64, iv_b64: wire.iv_b64 },
        { packetKey, msgType: msgTypeOpt }
      );
      if (expectText !== undefined && plain !== expectText) {
        throw new HarnessError('plaintext mismatch', { got: plain, expect: expectText });
      }
      storeContactSecret(receiver.digest, sender.digest, sender.deviceId, receiver.state);
      return plain;
    } catch (err) {
      const fp = await fingerprintState(receiver.state);
      const beforeFp = await fingerprintState(before);
      throw new HarnessError(err.message || 'decrypt failed', { err, fingerprint: fp, before: beforeFp, direction: `${sender.label}->${receiver.label}` });
    }
  };

  const assertOk = (cond, message, meta = null) => {
    if (!cond) throw new HarnessError(message, meta);
  };

  const testSingle = async (sender, receiver, text, tag) => {
    const sent = await sendText(sender, receiver, text);
    const plain = await deliver(sender, receiver, sent.wire, text);
    assertOk(plain === text, `${tag} plaintext mismatch`, { direction: `${sender.label}->${receiver.label}` });
  };

  const testReplay = async (sender, receiver) => {
    const sent = await sendText(sender, receiver, '[replay]-once');
    await deliver(sender, receiver, sent.wire, '[replay]-once');
    const snapshot = cloneState(receiver.state);
    let replayFailed = false;
    try {
      await deliver(sender, receiver, sent.wire, '[replay]-once');
    } catch (err) {
      replayFailed = true;
      const fpAfter = await fingerprintState(receiver.state);
      const fpBefore = await fingerprintState(snapshot);
      assertOk(
        JSON.stringify(fpAfter) === JSON.stringify(fpBefore),
        'state drift on replay',
        { before: fpBefore, after: fpAfter, direction: `${sender.label}->${receiver.label}` }
      );
    }
    assertOk(replayFailed, 'replay accepted unexpectedly');
  };

  const testBurst = async (sender, receiver, count, label) => {
    for (let i = 0; i < count; i += 1) {
      const msg = `[${label}] msg-${i + 1}`;
      const sent = await sendText(sender, receiver, msg);
      await deliver(sender, receiver, sent.wire, msg);
    }
  };

  const testOutOfOrder = async (sender, receiver) => {
    const packets = [];
    for (let i = 0; i < 3; i += 1) {
      const msg = `[ooo ${sender.label} -> ${receiver.label}] ${i + 1}`;
      packets.push(await sendText(sender, receiver, msg));
    }
    // Deliver #3 before #2 to probe skip-key / out-of-order behavior.
    const msg3 = `[ooo ${sender.label} -> ${receiver.label}] 3`;
    await deliver(sender, receiver, packets[2].wire, msg3);
    const before = cloneState(receiver.state);
    let secondDelivered = false;
    const msg2 = `[ooo ${sender.label} -> ${receiver.label}] 2`;
    try {
      await deliver(sender, receiver, packets[1].wire, msg2);
      secondDelivered = true;
    } catch (err) {
      const fpAfter = await fingerprintState(receiver.state);
      const fpBefore = await fingerprintState(before);
      assertOk(
        JSON.stringify(fpAfter) === JSON.stringify(fpBefore),
        'state drift on out-of-order reject',
        { before: fpBefore, after: fpAfter, direction: `${sender.label}->${receiver.label}` }
      );
      console.log('[ooo]', 'out-of-order rejected (expected for strict counters)', { direction: `${sender.label}->${receiver.label}` });
      return;
    }
    if (secondDelivered) {
      const msg1 = `[ooo ${sender.label} -> ${receiver.label}] 1`;
      await deliver(sender, receiver, packets[0].wire, msg1);
    }
  };

  const testContactShareSequence = async (sender, receiver) => {
    const contactMsg = `[contact-share ${sender.label}]`;
    const textMsg = `[post-contact ${sender.label}]`;
    const fpBefore = await fingerprintState(receiver.state);
    const sentContact = await sendText(sender, receiver, contactMsg, { msgType: 'contact-share' });
    await deliver(sender, receiver, sentContact.wire, contactMsg, 'contact-share');
    const fpAfterContact = await fingerprintState(receiver.state);
    assertOk(
      Number(fpAfterContact.Nr) === Number(fpBefore.Nr || 0) + 1,
      'contact-share counter mismatch',
      { before: fpBefore, after: fpAfterContact, direction: `${sender.label}->${receiver.label}` }
    );
    const sentText = await sendText(sender, receiver, textMsg, { msgType: 'text' });
    await deliver(sender, receiver, sentText.wire, textMsg, 'text');
    const fpAfterText = await fingerprintState(receiver.state);
    assertOk(
      Number(fpAfterText.Nr) === Number(fpAfterContact.Nr || 0) + 1,
      'contact-share/text counter drift',
      { afterContact: fpAfterContact, afterText: fpAfterText, direction: `${sender.label}->${receiver.label}` }
    );
    assertOk(
      fpAfterText.theirPubHash === fpAfterContact.theirPubHash,
      'contact-share/text ek mismatch',
      { afterContact: fpAfterContact, afterText: fpAfterText, direction: `${sender.label}->${receiver.label}` }
    );
  };

  const expectTamperFailure = async ({ sender, receiver, wire, label }) => {
    const baseline = cloneState(receiver.state);
    let mkHashFirst = null;
    for (let i = 0; i < 2; i += 1) {
      let caught = false;
      try {
        await deliver(sender, receiver, wire, undefined, wire.msgType || 'text');
      } catch (err) {
        caught = true;
        const meta = err?.meta || {};
        const mkHash = meta?.err?.__drMeta?.mkHash ?? null;
        if (mkHashFirst === null) mkHashFirst = mkHash;
        else assertOk(mkHash === mkHashFirst, `${label} mkHash drift`, { mkHashFirst, mkHash });
        const fpAfter = await fingerprintState(receiver.state);
        const fpBaseline = await fingerprintState(baseline);
        assertOk(
          JSON.stringify(fpAfter) === JSON.stringify(fpBaseline),
          `${label} state drift after failure`,
          { baseline: fpBaseline, after: fpAfter }
        );
      }
      assertOk(caught, `${label} tamper unexpectedly decrypted`);
    }
  };

  const testTamperInvariant = async (sender, receiver) => {
    const sent = await sendText(sender, receiver, '[tamper-probe]');
    // Ciphertext bit flip
    const tamperedCt = {
      ...sent.wire,
      ciphertext_b64: b64(flipOneBit(b64u8(sent.wire.ciphertext_b64)))
    };
    await expectTamperFailure({ sender, receiver, wire: tamperedCt, label: 'tamper-ciphertext' });
    // AAD/header bit flip (keep JSON valid)
    const tamperedHeaderJson = tamperHeaderJson(sent.wire.header_json);
    const tamperedAad = { ...sent.wire, header_json: tamperedHeaderJson };
    await expectTamperFailure({ sender, receiver, wire: tamperedAad, label: 'tamper-aad' });
  };

  try {
    await testContactShareSequence(peers.alice, peers.bob);
    await testContactShareSequence(peers.bob, peers.alice);
    await testTamperInvariant(peers.alice, peers.bob);
    await testTamperInvariant(peers.bob, peers.alice);
    await testBurst(peers.alice, peers.bob, 5, 'A->B burst');
    await testBurst(peers.bob, peers.alice, 5, 'B->A burst');
    await testReplay(peers.alice, peers.bob);
    await testOutOfOrder(peers.bob, peers.alice);
    console.log('\n[harness] all protocol checks passed');
  } catch (err) {
    const meta = err?.meta || {};
    console.error('[harness:fail]', err?.message || err);
    if (meta?.err?.stack) {
      const frames = String(meta.err.stack).split('\n');
      const firstFrame = frames.find((line) => line.trim().startsWith('at')) || frames[1] || frames[0];
      if (firstFrame) console.error('[stack]', firstFrame.trim());
    } else if (err?.stack) {
      const frames = String(err.stack).split('\n');
      const firstFrame = frames.find((line) => line.trim().startsWith('at')) || frames[1] || frames[0];
      if (firstFrame) console.error('[stack]', firstFrame.trim());
    }
    if (meta.fingerprint || meta.before) {
      const fp = meta.fingerprint || null;
      const before = meta.before || null;
      console.error('[state]', { fingerprint: fp, before });
    }
    process.exit(1);
  }
}

main();
