/**
 * Unit tests for dr.ts (Double Ratchet + X3DH)
 * Run: node --experimental-strip-types --test web/src/shared/crypto/__tests__/dr.test.ts
 * Requires: tweetnacl installed (npm install)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  x3dhInitiate,
  x3dhRespond,
  drEncryptText,
  drDecryptText,
  drRatchet,
  buildDrAadFromHeader,
  rememberSkippedKey,
  type DrState,
  type DrPacket,
  type DrHeader,
  type PeerBundle,
  type GuestBundle,
  type SkippedKeyStore,
} from '../dr.ts';
import {
  generateInitialBundle,
  type DevicePriv,
  type BundlePub,
} from '../prekeys.ts';
import { b64, genX25519Keypair } from '../nacl.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

async function createAliceBob(): Promise<{
  alicePriv: DevicePriv;
  alicePub: BundlePub;
  bobPriv: DevicePriv;
  bobPub: BundlePub;
}> {
  const alice = await generateInitialBundle(1, 5);
  const bob = await generateInitialBundle(1, 5);
  return {
    alicePriv: alice.devicePriv,
    alicePub: alice.bundlePub,
    bobPriv: bob.devicePriv,
    bobPub: bob.bundlePub,
  };
}

function makePeerBundle(pub: BundlePub): PeerBundle {
  return {
    ik_pub: pub.ik_pub,
    spk_pub: pub.spk_pub,
    spk_sig: pub.spk_sig,
    opk: pub.opks[0] ? { pub: pub.opks[0].pub, id: pub.opks[0].id } : null,
  };
}

function makeGuestBundle(
  pub: BundlePub,
  ekPubB64: string,
  opkId: number
): GuestBundle {
  return {
    ek_pub: ekPubB64,
    ik_pub: pub.ik_pub,
    spk_pub: pub.spk_pub,
    spk_sig: pub.spk_sig,
    opk_id: opkId,
  };
}

describe('dr.ts', () => {
  describe('buildDrAadFromHeader', () => {
    it('returns null for null header', () => {
      assert.equal(buildDrAadFromHeader(null), null);
    });

    it('returns null for header without device_id', () => {
      const header: Partial<DrHeader> = { n: 1, v: 1 };
      assert.equal(buildDrAadFromHeader(header), null);
    });

    it('returns Uint8Array for valid header', () => {
      const header: Partial<DrHeader> = { n: 1, v: 1, device_id: 'dev-123' };
      const aad = buildDrAadFromHeader(header);
      assert.ok(aad instanceof Uint8Array);
      const str = new TextDecoder().decode(aad);
      assert.ok(str.includes('v:1'));
      assert.ok(str.includes('d:dev-123'));
      assert.ok(str.includes('c:1'));
    });
  });

  describe('rememberSkippedKey', () => {
    it('stores and retrieves skipped keys', () => {
      const st: DrState = {
        rk: new Uint8Array(32),
        ckS: null,
        ckR: null,
        Ns: 0,
        Nr: 0,
        PN: 0,
        NsTotal: 0,
        NrTotal: 0,
        myRatchetPriv: new Uint8Array(32),
        myRatchetPub: new Uint8Array(32),
        theirRatchetPub: null,
        pendingSendRatchet: false,
      };

      rememberSkippedKey(st, 'chain-1', 5, 'key-base64-5');
      rememberSkippedKey(st, 'chain-1', 6, 'key-base64-6');
      rememberSkippedKey(st, 'chain-2', 1, 'key-base64-1');

      assert.ok(st.skippedKeys instanceof Map);
      assert.equal(st.skippedKeys!.size, 2);
      assert.equal(st.skippedKeys!.get('chain-1')!.get(5), 'key-base64-5');
      assert.equal(st.skippedKeys!.get('chain-1')!.get(6), 'key-base64-6');
      assert.equal(st.skippedKeys!.get('chain-2')!.get(1), 'key-base64-1');
    });

    it('evicts oldest key when exceeding maxPerChain', () => {
      const st: DrState = {
        rk: new Uint8Array(32),
        ckS: null,
        ckR: null,
        Ns: 0,
        Nr: 0,
        PN: 0,
        NsTotal: 0,
        NrTotal: 0,
        myRatchetPriv: new Uint8Array(32),
        myRatchetPub: new Uint8Array(32),
        theirRatchetPub: null,
        pendingSendRatchet: false,
      };

      // Use maxPerChain = 3
      for (let i = 0; i < 5; i++) {
        rememberSkippedKey(st, 'chain', i, `key-${i}`, 3);
      }

      const chain = st.skippedKeys!.get('chain')!;
      assert.equal(chain.size, 3);
      // First two should be evicted (0, 1)
      assert.equal(chain.has(0), false);
      assert.equal(chain.has(1), false);
      assert.equal(chain.get(2), 'key-2');
      assert.equal(chain.get(3), 'key-3');
      assert.equal(chain.get(4), 'key-4');
    });
  });

  describe('X3DH + Double Ratchet end-to-end', () => {
    it('Alice initiates → Bob responds → encrypt/decrypt works', async () => {
      const { alicePriv, alicePub, bobPriv, bobPub } = await createAliceBob();

      // Alice initiates X3DH with Bob's bundle
      const peerBundle = makePeerBundle(bobPub);
      const aliceState = await x3dhInitiate(alicePriv, peerBundle);

      // Verify Alice state structure
      assert.ok(aliceState.rk instanceof Uint8Array);
      assert.equal(aliceState.rk.length, 32);
      assert.ok(aliceState.ckS instanceof Uint8Array);
      assert.equal(aliceState.ckR, null);
      assert.equal(aliceState.Ns, 0);
      assert.equal(aliceState.Nr, 0);
      assert.equal(aliceState.__bornReason, 'x3dh-initiate');

      // Bob responds using Alice's public info
      const guestBundle = makeGuestBundle(
        alicePub,
        b64(aliceState.myRatchetPub),
        bobPub.opks[0]!.id
      );
      const bobState = await x3dhRespond(bobPriv, guestBundle);

      // Verify Bob state structure
      assert.ok(bobState.rk instanceof Uint8Array);
      assert.equal(bobState.rk.length, 32);
      assert.ok(bobState.ckS instanceof Uint8Array);
      assert.ok(bobState.ckR instanceof Uint8Array);
      assert.equal(bobState.Ns, 0);
      assert.equal(bobState.Nr, 0);
      assert.equal(bobState.__bornReason, 'x3dh-respond');

      // Alice encrypts
      const packet = await drEncryptText(aliceState, 'Hello Bob!');
      assert.equal(packet.aead, 'aes-256-gcm');
      assert.ok(packet.header);
      assert.equal(packet.header.dr, 1);
      assert.equal(typeof packet.iv_b64, 'string');
      assert.equal(typeof packet.ciphertext_b64, 'string');

      // Bob decrypts
      const plaintext = await drDecryptText(bobState, packet);
      assert.equal(plaintext, 'Hello Bob!');
    });

    it('multiple messages in sequence', async () => {
      const { alicePriv, alicePub, bobPriv, bobPub } = await createAliceBob();

      const peerBundle = makePeerBundle(bobPub);
      const aliceState = await x3dhInitiate(alicePriv, peerBundle);
      const guestBundle = makeGuestBundle(
        alicePub,
        b64(aliceState.myRatchetPub),
        bobPub.opks[0]!.id
      );
      const bobState = await x3dhRespond(bobPriv, guestBundle);

      // Alice sends 3 messages
      const messages = ['msg1', 'msg2', 'msg3'];
      for (const msg of messages) {
        const pkt = await drEncryptText(aliceState, msg);
        const dec = await drDecryptText(bobState, pkt);
        assert.equal(dec, msg);
      }

      // Verify counters advanced
      assert.equal(aliceState.Ns, 3);
      assert.equal(aliceState.NsTotal, 3);
    });

    it('message counter increments correctly', async () => {
      const { alicePriv, alicePub, bobPriv, bobPub } = await createAliceBob();

      const peerBundle = makePeerBundle(bobPub);
      const aliceState = await x3dhInitiate(alicePriv, peerBundle);
      const guestBundle = makeGuestBundle(
        alicePub,
        b64(aliceState.myRatchetPub),
        bobPub.opks[0]!.id
      );
      const bobState = await x3dhRespond(bobPriv, guestBundle);

      const pkt1 = await drEncryptText(aliceState, 'first');
      assert.equal(pkt1.header.n, 1);

      const pkt2 = await drEncryptText(aliceState, 'second');
      assert.equal(pkt2.header.n, 2);

      // Bob decrypts in order
      assert.equal(await drDecryptText(bobState, pkt1), 'first');
      assert.equal(await drDecryptText(bobState, pkt2), 'second');
    });

    it('decryption fails with tampered ciphertext', async () => {
      const { alicePriv, alicePub, bobPriv, bobPub } = await createAliceBob();

      const peerBundle = makePeerBundle(bobPub);
      const aliceState = await x3dhInitiate(alicePriv, peerBundle);
      const guestBundle = makeGuestBundle(
        alicePub,
        b64(aliceState.myRatchetPub),
        bobPub.opks[0]!.id
      );
      const bobState = await x3dhRespond(bobPriv, guestBundle);

      const pkt = await drEncryptText(aliceState, 'original');
      // Tamper with ciphertext
      const tamperedPkt: DrPacket = {
        ...pkt,
        ciphertext_b64: b64(crypto.getRandomValues(new Uint8Array(64))),
      };

      await assert.rejects(
        async () => await drDecryptText(bobState, tamperedPkt),
        (err: Error) => {
          // Should fail with AEAD error (OperationError) or invariant
          return err instanceof Error;
        }
      );
    });

    it('X3DH rejects invalid signed prekey signature', async () => {
      const { alicePriv, bobPub } = await createAliceBob();

      const badBundle: PeerBundle = {
        ...makePeerBundle(bobPub),
        spk_sig: b64(crypto.getRandomValues(new Uint8Array(64))),
      };

      await assert.rejects(
        async () => await x3dhInitiate(alicePriv, badBundle),
        /signature invalid/
      );
    });

    it('X3DH requires OPK', async () => {
      const { alicePriv, bobPub } = await createAliceBob();

      const noOpkBundle: PeerBundle = {
        ik_pub: bobPub.ik_pub,
        spk_pub: bobPub.spk_pub,
        spk_sig: bobPub.spk_sig,
        opk: null,
      };

      await assert.rejects(
        async () => await x3dhInitiate(alicePriv, noOpkBundle),
        /missing one-time prekey/
      );
    });
  });

  describe('X3DH + DR with AAD (device_id)', () => {
    it('encrypt/decrypt works with device_id AAD', async () => {
      const { alicePriv, alicePub, bobPriv, bobPub } = await createAliceBob();

      const peerBundle = makePeerBundle(bobPub);
      const aliceState = await x3dhInitiate(alicePriv, peerBundle);
      const guestBundle = makeGuestBundle(
        alicePub,
        b64(aliceState.myRatchetPub),
        bobPub.opks[0]!.id
      );
      const bobState = await x3dhRespond(bobPriv, guestBundle);

      // Alice encrypts with device_id → AAD is non-null
      const pkt = await drEncryptText(aliceState, 'Hello with AAD!', {
        deviceId: 'alice-device-001',
        version: 1,
      });
      assert.equal(pkt.header.device_id, 'alice-device-001');
      assert.equal(pkt.header.v, 1);

      // Bob decrypts — AAD is reconstructed from header
      const plaintext = await drDecryptText(bobState, pkt);
      assert.equal(plaintext, 'Hello with AAD!');
    });

    it('multiple messages with AAD in sequence', async () => {
      const { alicePriv, alicePub, bobPriv, bobPub } = await createAliceBob();

      const peerBundle = makePeerBundle(bobPub);
      const aliceState = await x3dhInitiate(alicePriv, peerBundle);
      const guestBundle = makeGuestBundle(
        alicePub,
        b64(aliceState.myRatchetPub),
        bobPub.opks[0]!.id
      );
      const bobState = await x3dhRespond(bobPriv, guestBundle);

      const messages = ['msg-aad-1', 'msg-aad-2', 'msg-aad-3'];
      for (const msg of messages) {
        const pkt = await drEncryptText(aliceState, msg, {
          deviceId: 'dev-A',
          version: 1,
        });
        assert.equal(pkt.header.device_id, 'dev-A');
        const dec = await drDecryptText(bobState, pkt);
        assert.equal(dec, msg);
      }
      assert.equal(aliceState.Ns, 3);
    });

    it('tampered AAD device_id causes decryption failure', async () => {
      const { alicePriv, alicePub, bobPriv, bobPub } = await createAliceBob();

      const peerBundle = makePeerBundle(bobPub);
      const aliceState = await x3dhInitiate(alicePriv, peerBundle);
      const guestBundle = makeGuestBundle(
        alicePub,
        b64(aliceState.myRatchetPub),
        bobPub.opks[0]!.id
      );
      const bobState = await x3dhRespond(bobPriv, guestBundle);

      const pkt = await drEncryptText(aliceState, 'AAD integrity test', {
        deviceId: 'real-device',
        version: 1,
      });

      // Tamper with the device_id in header → AAD mismatch → decryption fails
      const tamperedPkt: DrPacket = {
        ...pkt,
        header: { ...pkt.header, device_id: 'fake-device' },
      };

      await assert.rejects(
        async () => await drDecryptText(bobState, tamperedPkt),
        (err: Error) => err instanceof Error
      );
    });

    it('tampered AAD version causes decryption failure', async () => {
      const { alicePriv, alicePub, bobPriv, bobPub } = await createAliceBob();

      const peerBundle = makePeerBundle(bobPub);
      const aliceState = await x3dhInitiate(alicePriv, peerBundle);
      const guestBundle = makeGuestBundle(
        alicePub,
        b64(aliceState.myRatchetPub),
        bobPub.opks[0]!.id
      );
      const bobState = await x3dhRespond(bobPriv, guestBundle);

      const pkt = await drEncryptText(aliceState, 'version integrity', {
        deviceId: 'dev-X',
        version: 1,
      });

      // Tamper with version in header → AAD mismatch
      const tamperedPkt: DrPacket = {
        ...pkt,
        header: { ...pkt.header, v: 99 },
      };

      await assert.rejects(
        async () => await drDecryptText(bobState, tamperedPkt),
        (err: Error) => err instanceof Error
      );
    });

    it('tampered AAD counter causes decryption failure', async () => {
      const { alicePriv, alicePub, bobPriv, bobPub } = await createAliceBob();

      const peerBundle = makePeerBundle(bobPub);
      const aliceState = await x3dhInitiate(alicePriv, peerBundle);
      const guestBundle = makeGuestBundle(
        alicePub,
        b64(aliceState.myRatchetPub),
        bobPub.opks[0]!.id
      );
      const bobState = await x3dhRespond(bobPriv, guestBundle);

      const pkt = await drEncryptText(aliceState, 'counter integrity', {
        deviceId: 'dev-Y',
        version: 1,
      });

      // Tamper with counter in header → AAD mismatch
      const tamperedPkt: DrPacket = {
        ...pkt,
        header: { ...pkt.header, n: 999 },
      };

      await assert.rejects(
        async () => await drDecryptText(bobState, tamperedPkt),
        (err: Error) => err instanceof Error
      );
    });
  });

  describe('drRatchet', () => {
    it('advances the ratchet state', async () => {
      const { alicePriv, bobPub } = await createAliceBob();
      const peerBundle = makePeerBundle(bobPub);
      const state = await x3dhInitiate(alicePriv, peerBundle);

      const originalRk = new Uint8Array(state.rk);
      const newPub = (await genX25519Keypair()).publicKey;
      const result = await drRatchet(state, newPub);

      assert.ok(result.ckR instanceof Uint8Array);
      assert.notDeepEqual(state.rk, originalRk); // rk changed
      assert.equal(state.Nr, 0); // Nr reset
      assert.deepEqual(state.theirRatchetPub, newPub);
    });
  });

  describe('DrState type safety', () => {
    it('DrState interface enforces required fields', () => {
      // This is a compile-time check. At runtime, verify the shape.
      const state: DrState = {
        rk: new Uint8Array(32),
        ckS: new Uint8Array(32),
        ckR: null,
        Ns: 0,
        Nr: 0,
        PN: 0,
        NsTotal: 0,
        NrTotal: 0,
        myRatchetPriv: new Uint8Array(32),
        myRatchetPub: new Uint8Array(32),
        theirRatchetPub: null,
        pendingSendRatchet: false,
      };

      assert.ok(state.rk instanceof Uint8Array);
      assert.equal(state.ckR, null);
      assert.equal(state.pendingSendRatchet, false);
    });
  });
});
