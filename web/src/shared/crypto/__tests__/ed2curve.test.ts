/**
 * Unit tests for ed2curve.ts
 * Run: node --experimental-strip-types --test web/src/shared/crypto/__tests__/ed2curve.test.ts
 * Requires: tweetnacl installed (npm install)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertEd25519PublicKey, convertEd25519SecretKey } from '../ed2curve.ts';
import { genEd25519Keypair, scalarMult } from '../nacl.ts';

describe('ed2curve.ts', () => {
  describe('convertEd25519PublicKey', () => {
    it('converts Ed25519 public key to X25519 (32 bytes)', async () => {
      const kp = await genEd25519Keypair();
      const x25519Pub = await convertEd25519PublicKey(kp.publicKey);
      assert.ok(x25519Pub instanceof Uint8Array);
      assert.equal(x25519Pub!.length, 32);
    });

    it('produces different output from the Ed25519 input', async () => {
      const kp = await genEd25519Keypair();
      const x25519Pub = await convertEd25519PublicKey(kp.publicKey);
      // The converted key should be different from the original
      assert.notDeepEqual(x25519Pub, kp.publicKey);
    });

    it('returns consistent results for the same input', async () => {
      const kp = await genEd25519Keypair();
      const result1 = await convertEd25519PublicKey(kp.publicKey);
      const result2 = await convertEd25519PublicKey(kp.publicKey);
      assert.deepEqual(result1, result2);
    });
  });

  describe('convertEd25519SecretKey', () => {
    it('converts Ed25519 secret seed to X25519 (32 bytes)', async () => {
      const kp = await genEd25519Keypair();
      const seed = kp.secretKey.slice(0, 32);
      const x25519Sec = await convertEd25519SecretKey(seed);
      assert.ok(x25519Sec instanceof Uint8Array);
      assert.equal(x25519Sec!.length, 32);
    });

    it('converted keypair produces valid DH shared secret', async () => {
      const kp1 = await genEd25519Keypair();
      const kp2 = await genEd25519Keypair();

      const seed1 = kp1.secretKey.slice(0, 32);
      const seed2 = kp2.secretKey.slice(0, 32);

      const x25519Sec1 = await convertEd25519SecretKey(seed1);
      const x25519Pub2 = await convertEd25519PublicKey(kp2.publicKey);
      const x25519Sec2 = await convertEd25519SecretKey(seed2);
      const x25519Pub1 = await convertEd25519PublicKey(kp1.publicKey);

      assert.ok(x25519Sec1);
      assert.ok(x25519Pub2);
      assert.ok(x25519Sec2);
      assert.ok(x25519Pub1);

      // DH(sec1, pub2) === DH(sec2, pub1)
      const shared1 = await scalarMult(x25519Sec1!, x25519Pub2!);
      const shared2 = await scalarMult(x25519Sec2!, x25519Pub1!);
      assert.deepEqual(shared1, shared2);
    });
  });
});
