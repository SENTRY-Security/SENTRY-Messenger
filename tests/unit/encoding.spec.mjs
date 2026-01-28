import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import {
    bytesToB64,
    bytesToB64Url,
    toB64Url,
    fromB64Url,
    b64ToBytes,
    b64UrlToBytes
} from '../../web/src/app/ui/mobile/ui-utils.js';

describe('ui-utils encoding', () => {
    const text = "Hello World";
    const textB64 = "SGVsbG8gV29ybGQ=";
    // URL safe: "+" -> "-", "/" -> "_"
    // "Hello World?" -> "SGVsbG8gV29ybGQ/" -> Url: "SGVsbG8gV29ybGQ_"
    const text2 = "Hello World?";
    const text2B64 = "SGVsbG8gV29ybGQ/";
    const text2B64Url = "SGVsbG8gV29ybGQ_";

    it('should convert bytes to B64', () => {
        const u8 = new TextEncoder().encode(text);
        assert.strictEqual(bytesToB64(u8), textB64);
    });

    it('should convert bytes to B64Url', () => {
        const u8 = new TextEncoder().encode(text2);
        assert.strictEqual(bytesToB64Url(u8), text2B64Url);
    });

    it('should convert B64 to bytes', () => {
        const u8 = b64ToBytes(textB64);
        const dec = new TextDecoder().decode(u8);
        assert.strictEqual(dec, text);
    });

    it('should convert B64Url to bytes', () => {
        const u8 = b64UrlToBytes(text2B64Url);
        const dec = new TextDecoder().decode(u8);
        assert.strictEqual(dec, text2);
    });

    it('should normalize standard B64 string to B64Url', () => {
        assert.strictEqual(toB64Url(text2B64), text2B64Url);
    });

    it('should normalize B64Url string to standard B64 (padded)', () => {
        // "A" -> "QQ==" (base64) -> "QQ" (url safe stripped)
        const val = "A";
        const b64 = "QQ==";
        const b64u = "QQ";
        assert.strictEqual(fromB64Url(b64u), b64);
    });
});
