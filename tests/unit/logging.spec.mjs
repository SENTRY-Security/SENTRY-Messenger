import { test, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { logDrModule } from '../../web/src/app/lib/logging.js';

describe('logging standardization', () => {
    it('should format prefix correctly', (t) => {
        // Mock console.log
        const originalLog = console.log;
        let lastOutput = '';
        console.log = (msg) => { lastOutput = msg; };

        // Mock window/flags if needed. 
        // Note: logging.js checks window and flags. We might need to override them or use force option.
        // Looking at source: if (!shouldLogDrCore() && !opts.force) return;
        // So we can pass { force: true }

        logDrModule('TestMod', 'test-event', { foo: 'bar' }, { force: true });

        console.log = originalLog;

        assert.match(lastOutput, /^\[DR:TestMod\]/);
        assert.ok(lastOutput.includes('"event":"test-event"'));
        assert.ok(lastOutput.includes('"foo":"bar"'));
    });
});
