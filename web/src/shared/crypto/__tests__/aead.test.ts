/**
 * Unit tests for aead.ts
 * Run: node --experimental-strip-types --test web/src/shared/crypto/__tests__/aead.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptAesGcm,
  decryptAesGcm,
  randomIv,
  wrapWithMK_JSON,
  unwrapWithMK_JSON,
  assertEnvelopeStrict,
  ALLOWED_ENVELOPE_INFO_TAGS,
} from '../aead.ts';

describe('aead.ts', () => {
  describe('randomIv', () => {
    it('generates a 12-byte IV', () => {
      const iv = randomIv();
      assert.ok(iv instanceof Uint8Array);
      assert.equal(iv.length, 12);
    });

    it('generates different IVs each time', () => {
      const iv1 = randomIv();
      const iv2 = randomIv();
      assert.notDeepEqual(iv1, iv2);
    });
  });

  describe('encryptAesGcm / decryptAesGcm', () => {
    async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
      return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }

    it('roundtrips plaintext through AES-GCM', async () => {
      const rawKey = crypto.getRandomValues(new Uint8Array(32));
      const key = await importRawKey(rawKey);
      const data = 'Hello, SENTRY Messenger!';
      const iv = randomIv();

      const result = await encryptAesGcm({ key, iv, data });
      assert.ok(result.ciphertext instanceof Uint8Array);
      assert.ok(result.ciphertext.length > data.length); // ciphertext + 16-byte auth tag

      const decrypted = await decryptAesGcm({ key, iv, ciphertext: result.ciphertext });
      const plaintext = new TextDecoder().decode(decrypted);
      assert.equal(plaintext, data);
    });

    it('decryption fails with wrong key', async () => {
      const key1 = await importRawKey(crypto.getRandomValues(new Uint8Array(32)));
      const key2 = await importRawKey(crypto.getRandomValues(new Uint8Array(32)));
      const iv = randomIv();

      const result = await encryptAesGcm({ key: key1, iv, data: 'secret' });
      await assert.rejects(
        async () => await decryptAesGcm({ key: key2, iv, ciphertext: result.ciphertext }),
      );
    });

    it('decryption fails with wrong IV', async () => {
      const key = await importRawKey(crypto.getRandomValues(new Uint8Array(32)));
      const iv1 = randomIv();
      const iv2 = randomIv();

      const result = await encryptAesGcm({ key, iv: iv1, data: 'secret' });
      await assert.rejects(
        async () => await decryptAesGcm({ key, iv: iv2, ciphertext: result.ciphertext }),
      );
    });
  });

  describe('wrapWithMK_JSON / unwrapWithMK_JSON', () => {
    it('roundtrips a JSON object', async () => {
      const mk = crypto.getRandomValues(new Uint8Array(32));
      const data = { foo: 'bar', num: 42, nested: { a: true } };

      const envelope = await wrapWithMK_JSON(data, mk, 'devkeys/v1');
      assert.equal(envelope.aead, 'aes-256-gcm');
      assert.equal(envelope.info, 'devkeys/v1');
      assert.equal(typeof envelope.ct_b64, 'string');
      assert.equal(typeof envelope.iv_b64, 'string');
      assert.equal(typeof envelope.salt_b64, 'string');

      const unwrapped = await unwrapWithMK_JSON(envelope as unknown as Record<string, unknown>, mk);
      assert.deepEqual(unwrapped, data);
    });

    it('fails with wrong MK', async () => {
      const mk1 = crypto.getRandomValues(new Uint8Array(32));
      const mk2 = crypto.getRandomValues(new Uint8Array(32));
      const data = { secret: 'value' };

      const envelope = await wrapWithMK_JSON(data, mk1, 'devkeys/v1');
      await assert.rejects(
        async () => await unwrapWithMK_JSON(envelope as unknown as Record<string, unknown>, mk2),
      );
    });
  });

  describe('assertEnvelopeStrict', () => {
    it('accepts a valid envelope', () => {
      const envelope: Record<string, unknown> = {
        aead: 'aes-256-gcm',
        info: 'devkeys/v1',
        salt_b64: 'AAAA',
        iv_b64: 'BBBB',
        ct_b64: 'CCCC',
      };
      assert.doesNotThrow(() => assertEnvelopeStrict(envelope));
    });

    it('rejects envelope with invalid aead', () => {
      const envelope: Record<string, unknown> = {
        aead: 'aes-128-gcm',
        info: 'devkeys/v1',
        salt_b64: 'AAAA',
        iv_b64: 'BBBB',
        ct_b64: 'CCCC',
      };
      assert.throws(() => assertEnvelopeStrict(envelope));
    });

    it('rejects envelope with missing fields', () => {
      assert.throws(() => assertEnvelopeStrict({} as Record<string, unknown>));
      assert.throws(() => assertEnvelopeStrict(null as unknown as Record<string, unknown>));
    });
  });

  describe('ALLOWED_ENVELOPE_INFO_TAGS', () => {
    it('contains expected info tags', () => {
      assert.ok(ALLOWED_ENVELOPE_INFO_TAGS.has('devkeys/v1'));
      assert.ok(ALLOWED_ENVELOPE_INFO_TAGS.has('blob/v1'));
      assert.ok(ALLOWED_ENVELOPE_INFO_TAGS.has('media/v1'));
    });
  });
});
