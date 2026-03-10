/**
 * Unit tests for nacl.ts
 * Run: node --experimental-strip-types --test web/src/shared/crypto/__tests__/nacl.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadNacl,
  ensureNacl,
  genEd25519Keypair,
  genX25519Keypair,
  signDetached,
  verifyDetached,
  scalarMult,
  b64,
  b64u8,
} from '../nacl.ts';

describe('nacl.ts', () => {
  it('loadNacl resolves without error', async () => {
    await loadNacl();
  });

  it('ensureNacl returns a NaclApi instance', async () => {
    const api = await ensureNacl();
    assert.ok(api);
    assert.equal(typeof api.sign.keyPair, 'function');
    assert.equal(typeof api.box.keyPair, 'function');
    assert.equal(typeof api.scalarMult, 'function');
  });

  describe('genEd25519Keypair', () => {
    it('generates keypair with 32-byte public and 64-byte secret', async () => {
      const kp = await genEd25519Keypair();
      assert.ok(kp.publicKey instanceof Uint8Array);
      assert.ok(kp.secretKey instanceof Uint8Array);
      assert.equal(kp.publicKey.length, 32);
      assert.equal(kp.secretKey.length, 64);
    });

    it('generates different keypairs each time', async () => {
      const kp1 = await genEd25519Keypair();
      const kp2 = await genEd25519Keypair();
      assert.notDeepEqual(kp1.publicKey, kp2.publicKey);
    });
  });

  describe('genX25519Keypair', () => {
    it('generates keypair with 32-byte public and secret', async () => {
      const kp = await genX25519Keypair();
      assert.ok(kp.publicKey instanceof Uint8Array);
      assert.ok(kp.secretKey instanceof Uint8Array);
      assert.equal(kp.publicKey.length, 32);
      assert.equal(kp.secretKey.length, 32);
    });
  });

  describe('signDetached / verifyDetached', () => {
    it('sign then verify succeeds with correct key', async () => {
      const kp = await genEd25519Keypair();
      const message = new TextEncoder().encode('hello world');
      const sig = await signDetached(message, kp.secretKey);
      assert.ok(sig instanceof Uint8Array);
      assert.equal(sig.length, 64);
      const ok = await verifyDetached(message, sig, kp.publicKey);
      assert.equal(ok, true);
    });

    it('verify fails with wrong public key', async () => {
      const kp1 = await genEd25519Keypair();
      const kp2 = await genEd25519Keypair();
      const message = new TextEncoder().encode('test');
      const sig = await signDetached(message, kp1.secretKey);
      const ok = await verifyDetached(message, sig, kp2.publicKey);
      assert.equal(ok, false);
    });

    it('verify fails with tampered message', async () => {
      const kp = await genEd25519Keypair();
      const message = new TextEncoder().encode('original');
      const sig = await signDetached(message, kp.secretKey);
      const tampered = new TextEncoder().encode('tampered');
      const ok = await verifyDetached(tampered, sig, kp.publicKey);
      assert.equal(ok, false);
    });
  });

  describe('scalarMult', () => {
    it('DH shared secret is consistent', async () => {
      const alice = await genX25519Keypair();
      const bob = await genX25519Keypair();
      const sharedAB = await scalarMult(alice.secretKey, bob.publicKey);
      const sharedBA = await scalarMult(bob.secretKey, alice.publicKey);
      assert.deepEqual(sharedAB, sharedBA);
    });

    it('produces 32-byte output', async () => {
      const kp1 = await genX25519Keypair();
      const kp2 = await genX25519Keypair();
      const shared = await scalarMult(kp1.secretKey, kp2.publicKey);
      assert.equal(shared.length, 32);
    });
  });

  describe('b64 / b64u8', () => {
    it('roundtrips Uint8Array through base64', () => {
      const original = new Uint8Array([1, 2, 3, 4, 255, 0, 128]);
      const encoded = b64(original);
      assert.equal(typeof encoded, 'string');
      const decoded = b64u8(encoded);
      assert.deepEqual(decoded, original);
    });

    it('handles empty array', () => {
      const empty = new Uint8Array(0);
      const encoded = b64(empty);
      const decoded = b64u8(encoded);
      assert.equal(decoded.length, 0);
    });

    it('b64u8 handles null/undefined gracefully', () => {
      const decoded = b64u8(null);
      assert.equal(decoded.length, 0);
      const decoded2 = b64u8(undefined);
      assert.equal(decoded2.length, 0);
    });
  });
});
