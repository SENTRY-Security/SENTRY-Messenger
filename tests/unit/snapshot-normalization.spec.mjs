import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeDrSnapshot } from '../../web/src/app/core/contact-secrets.js';

describe('contact-secrets snapshot normalization', () => {
    it('should prioritize _b64 suffix over legacy keys', () => {
        const input = {
            rk: 'LEGACY_VALUE',
            rk_b64: 'PREFERRED_VALUE',
            ckS_b64: 'CKS_VAL',
            ckR_b64: 'CKR_VAL',
            NsTotal: 1,
            NrTotal: 1
        };
        const result = normalizeDrSnapshot(input);

        // normalizeDrSnapshot outputs an object with keys like 'rk_b64', 'ckS_b64', etc.
        assert.strictEqual(result.rk_b64, 'PREFERRED_VALUE');
        assert.strictEqual(result.ckS_b64, 'CKS_VAL');
        assert.strictEqual(result.ckR_b64, 'CKR_VAL');
        // We can't easily inspect the internal return value of simplify, 
        // but normalizeDrSnapshot returns strings. 
        // Wait, normalizeDrSnapshot returns normalized values.
        // Let's check what it returns. It actually throws if invalid?
        // No, it returns { rk, ckS, ckR ... }

        // Wait, let me check the source code again to see what it returns. It seems it assigns to variables but... 
        // Ah, I need to see the return statement of normalizeDrSnapshot.
    });
});
