import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert';

// Mock dependencies (store.js functions used by contact-secrets)
import * as store from '../../web/src/app/core/store.js';

// Since contact-secrets.js relies on globals or DOM in some parts, we need to be careful.
// However, normalizeContactRole is a pure function export (mostly).
// We might need to mock 'log' if it's imported strictly. 
// For now, let's try importing the specific function we need to test.
// If it fails due to top-level side effects (like DOM access), we might need a workaround.

// Let's rely on the fact we can import the module.
// Note: contact-secrets.js imports 'sessionStore' which might be problematic if not mocked.
// But let's try dynamic import or assume the environment is node-compatible enough or the top-level code handles undefined window.

// Update: contact-secrets.js checks for window/navigator for automation env, which is fine.
// It imports sessionStore from '../ui/mobile/session-store.js'.
// That might be an issue if it imports other UI stuff.

// Strategy: Read the file content and extract the function for isolation testing
// or use a setup that mocks the imports. 
// Given the environment constraints, let's try to import the file directly first.

import { normalizeContactRole } from '../../web/src/app/core/contact-secrets.js';

describe('core/contact-secrets', () => {
    describe('normalizeContactRole', () => {
        it('should return null for invalid input', () => {
            assert.strictEqual(normalizeContactRole(null), null);
            assert.strictEqual(normalizeContactRole(undefined), null);
            assert.strictEqual(normalizeContactRole(123), null);
        });

        it('should return valid role as-is', () => {
            assert.strictEqual(normalizeContactRole('guest'), 'guest');
            assert.strictEqual(normalizeContactRole('owner'), 'owner');
        });

        it('should normalize case', () => {
            assert.strictEqual(normalizeContactRole('Guest'), 'guest');
            assert.strictEqual(normalizeContactRole('OWNER'), 'owner');
        });

        it('should map legacy "initiator" to "guest"', () => {
            // We expect a console.warn, but mostly checking the return value
            assert.strictEqual(normalizeContactRole('initiator'), 'guest');
        });

        it('should map legacy "responder" to "owner"', () => {
            // We expect a console.warn, but mostly checking the return value
            assert.strictEqual(normalizeContactRole('responder'), 'owner');
        });
    });
});
