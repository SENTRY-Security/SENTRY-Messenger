import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import {
    classifyDecryptedPayload,
    MSG_SUBTYPE,
    SEMANTIC_KIND
} from '../../web/src/app/features/semantic.js';

describe('features/semantic', () => {
    describe('classifyDecryptedPayload', () => {
        it('should classify text message from msgType', () => {
            const plaintext = JSON.stringify({ msgType: MSG_SUBTYPE.TEXT, content: 'hello' });
            const res = classifyDecryptedPayload(plaintext);
            assert.strictEqual(res.kind, SEMANTIC_KIND.USER_MESSAGE);
            assert.strictEqual(res.subtype, MSG_SUBTYPE.TEXT);
        });

        it('should classify media message from msgType', () => {
            const plaintext = JSON.stringify({ msgType: MSG_SUBTYPE.MEDIA, fileId: '123' });
            const res = classifyDecryptedPayload(plaintext);
            assert.strictEqual(res.kind, SEMANTIC_KIND.USER_MESSAGE);
            assert.strictEqual(res.subtype, MSG_SUBTYPE.MEDIA);
        });

        it('should classify legacy type field (backward compatibility)', () => {
            const plaintext = JSON.stringify({ type: 'text', content: 'old' });
            const res = classifyDecryptedPayload(plaintext);
            assert.strictEqual(res.kind, SEMANTIC_KIND.USER_MESSAGE);
            assert.strictEqual(res.subtype, MSG_SUBTYPE.TEXT);
        });

        it('should classify legacy msg_type field (backward compatibility)', () => {
            const plaintext = JSON.stringify({ msg_type: 'media', fileId: '456' });
            const res = classifyDecryptedPayload(plaintext);
            assert.strictEqual(res.kind, SEMANTIC_KIND.USER_MESSAGE);
            assert.strictEqual(res.subtype, MSG_SUBTYPE.MEDIA);
        });

        it('should default to text if no type but has plaintext content', () => {
            const plaintext = 'just text';
            const res = classifyDecryptedPayload(plaintext);
            assert.strictEqual(res.kind, SEMANTIC_KIND.USER_MESSAGE);
            assert.strictEqual(res.subtype, MSG_SUBTYPE.TEXT);
        });

        it('should classify control state (contact-share)', () => {
            const plaintext = JSON.stringify({ msgType: MSG_SUBTYPE.CONTACT_SHARE });
            const res = classifyDecryptedPayload(plaintext);
            assert.strictEqual(res.kind, SEMANTIC_KIND.CONTROL_STATE);
            assert.strictEqual(res.subtype, MSG_SUBTYPE.CONTACT_SHARE);
        });

        it('should classify transient signal (read-receipt)', () => {
            const plaintext = JSON.stringify({ msgType: MSG_SUBTYPE.READ_RECEIPT });
            const res = classifyDecryptedPayload(plaintext);
            assert.strictEqual(res.kind, SEMANTIC_KIND.TRANSIENT_SIGNAL);
            assert.strictEqual(res.subtype, MSG_SUBTYPE.READ_RECEIPT);
        });

        it('should classify unknown type as ignorable', () => {
            const plaintext = JSON.stringify({ msgType: 'unknown-garbage' });
            const res = classifyDecryptedPayload(plaintext);
            assert.strictEqual(res.kind, SEMANTIC_KIND.IGNORABLE);
            assert.strictEqual(res.subtype, 'unknown-garbage');
        });
    });
});
