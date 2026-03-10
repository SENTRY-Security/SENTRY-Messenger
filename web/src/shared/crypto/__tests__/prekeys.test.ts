/**
 * Unit tests for prekeys.ts
 * Run: node --experimental-strip-types --test web/src/shared/crypto/__tests__/prekeys.test.ts
 * Requires: tweetnacl installed (npm install)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateInitialBundle,
  generateOpksFrom,
  wrapDevicePrivWithMK,
  unwrapDevicePrivWithMK,
  decodeDevicePriv,
  type DevicePriv,
  type BundlePub,
  type GenerateInitialBundleResult,
  type GenerateOpksResult,
} from '../prekeys.ts';
import { b64u8 } from '../nacl.ts';

describe('prekeys.ts', () => {
  describe('generateInitialBundle', () => {
    it('produces devicePriv and bundlePub with correct structure', async () => {
      const result: GenerateInitialBundleResult = await generateInitialBundle(1, 5);

      // devicePriv
      assert.ok(result.devicePriv);
      assert.equal(typeof result.devicePriv.ik_priv_b64, 'string');
      assert.equal(typeof result.devicePriv.ik_pub_b64, 'string');
      assert.equal(typeof result.devicePriv.spk_priv_b64, 'string');
      assert.equal(typeof result.devicePriv.spk_pub_b64, 'string');
      assert.equal(typeof result.devicePriv.spk_sig_b64, 'string');
      assert.equal(typeof result.devicePriv.opk_priv_map, 'object');
      assert.equal(result.devicePriv.next_opk_id, 6); // 1 + 5

      // bundlePub
      assert.ok(result.bundlePub);
      assert.equal(typeof result.bundlePub.ik_pub, 'string');
      assert.equal(typeof result.bundlePub.spk_pub, 'string');
      assert.equal(typeof result.bundlePub.spk_sig, 'string');
      assert.equal(result.bundlePub.opks.length, 5);
    });

    it('generates OPK ids starting from nextIdStart', async () => {
      const result = await generateInitialBundle(100, 3);
      const ids = result.bundlePub.opks.map(o => o.id);
      assert.deepEqual(ids, [100, 101, 102]);
      assert.equal(result.devicePriv.next_opk_id, 103);
    });

    it('OPK private map matches public OPK ids', async () => {
      const result = await generateInitialBundle(1, 5);
      const pubIds = result.bundlePub.opks.map(o => o.id);
      const privIds = Object.keys(result.devicePriv.opk_priv_map).map(Number);
      assert.deepEqual(pubIds.sort(), privIds.sort());
    });

    it('ik_pub in devicePriv matches bundlePub', async () => {
      const result = await generateInitialBundle();
      assert.equal(result.devicePriv.ik_pub_b64, result.bundlePub.ik_pub);
    });

    it('spk_pub in devicePriv matches bundlePub', async () => {
      const result = await generateInitialBundle();
      assert.equal(result.devicePriv.spk_pub_b64, result.bundlePub.spk_pub);
    });
  });

  describe('generateOpksFrom', () => {
    it('generates the correct count of OPKs', async () => {
      const result: GenerateOpksResult = await generateOpksFrom(10, 5);
      assert.equal(result.opks.length, 5);
      assert.equal(result.next, 15);
    });

    it('OPK ids are sequential', async () => {
      const result = await generateOpksFrom(50, 3);
      assert.deepEqual(result.opks.map(o => o.id), [50, 51, 52]);
    });

    it('private map keys match public ids', async () => {
      const result = await generateOpksFrom(1, 10);
      for (const opk of result.opks) {
        assert.ok(result.opkPrivMap[opk.id], `missing private key for OPK ${opk.id}`);
      }
    });
  });

  describe('wrapDevicePrivWithMK / unwrapDevicePrivWithMK', () => {
    it('roundtrips devicePriv through MK encryption', async () => {
      const { devicePriv } = await generateInitialBundle(1, 3);
      const mk = crypto.getRandomValues(new Uint8Array(32));
      const wrapped = await wrapDevicePrivWithMK(devicePriv, mk);

      assert.ok(wrapped);
      assert.equal(wrapped.aead, 'aes-256-gcm');
      assert.equal(wrapped.info, 'devkeys/v1');
      assert.equal(typeof wrapped.ct_b64, 'string');
      assert.equal(typeof wrapped.iv_b64, 'string');
      assert.equal(typeof wrapped.salt_b64, 'string');

      const unwrapped = await unwrapDevicePrivWithMK(wrapped as unknown as Record<string, unknown>, mk);
      assert.ok(unwrapped);
      const unwrappedObj = unwrapped as DevicePriv;
      assert.equal(unwrappedObj.ik_priv_b64, devicePriv.ik_priv_b64);
      assert.equal(unwrappedObj.ik_pub_b64, devicePriv.ik_pub_b64);
      assert.equal(unwrappedObj.spk_priv_b64, devicePriv.spk_priv_b64);
    });

    it('decryption fails with wrong MK', async () => {
      const { devicePriv } = await generateInitialBundle(1, 2);
      const mk1 = crypto.getRandomValues(new Uint8Array(32));
      const mk2 = crypto.getRandomValues(new Uint8Array(32));
      const wrapped = await wrapDevicePrivWithMK(devicePriv, mk1);

      await assert.rejects(
        async () => await unwrapDevicePrivWithMK(wrapped as unknown as Record<string, unknown>, mk2),
        /OperationError|decrypt/i
      );
    });
  });

  describe('decodeDevicePriv', () => {
    it('decodes base64 keys to Uint8Array', async () => {
      const { devicePriv } = await generateInitialBundle(1, 2);
      const decoded = decodeDevicePriv(devicePriv);
      assert.ok(decoded.ikPriv instanceof Uint8Array);
      assert.ok(decoded.spkPriv instanceof Uint8Array);
      assert.ok(decoded.ikPriv.length > 0);
      assert.ok(decoded.spkPriv.length > 0);
    });

    it('decoded keys match original base64 values', async () => {
      const { devicePriv } = await generateInitialBundle(1, 2);
      const decoded = decodeDevicePriv(devicePriv);
      assert.deepEqual(decoded.ikPriv, b64u8(devicePriv.ik_priv_b64));
      assert.deepEqual(decoded.spkPriv, b64u8(devicePriv.spk_priv_b64));
    });
  });
});
