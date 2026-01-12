import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveEntryTsMs, resolveEntryCounter } from '../../web/src/app/features/timeline-store.js';

describe('features/timeline-store precision', () => {
    describe('resolveEntryTsMs', () => {
        it('should prefer tsMs if present (ms)', () => {
            const entry = { tsMs: 1700000000000, ts: 100 };
            assert.strictEqual(resolveEntryTsMs(entry), 1700000000000);
        });

        it('should use ts if tsMs missing (ms)', () => {
            const entry = { ts: 1700000000000 };
            assert.strictEqual(resolveEntryTsMs(entry), 1700000000000);
        });

        it('should convert ts from seconds to ms if small value', () => {
            // 1700000000 is approx year 2023 in seconds. < 10^11.
            const entry = { ts: 1700000000 };
            assert.strictEqual(resolveEntryTsMs(entry), 1700000000000);
        });

        it('should return 0 if neither present', () => {
            assert.strictEqual(resolveEntryTsMs({}), 0);
        });
    });

    describe('resolveEntryCounter', () => {
        it('should prefer top-level counter', () => {
            const entry = { counter: 10, header: { n: 5 } };
            assert.strictEqual(resolveEntryCounter(entry), 10);
        });

        it('should fallback to header.n', () => {
            const entry = { header: { n: 5 } };
            assert.strictEqual(resolveEntryCounter(entry), 5);
        });

        it('should fallback to header.counter', () => {
            const entry = { header: { counter: 6 } };
            assert.strictEqual(resolveEntryCounter(entry), 6);
        });

        it('should normalize strings', () => {
            assert.strictEqual(resolveEntryCounter({ counter: "42" }), 42);
        });
    });
});
