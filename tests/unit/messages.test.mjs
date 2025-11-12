import test from 'node:test';
import assert from 'node:assert/strict';

const {
  listSecureAndDecrypt,
  resetProcessedMessages,
  __setMessagesTestOverrides,
  __resetMessagesTestOverrides
} = await import('../../web/src/app/features/messages.js');

const encoder = new TextEncoder();

function toBase64Url(str) {
  return String(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  return new Uint8Array(Buffer.from(padded + '='.repeat(pad), 'base64'));
}

function decodeBase64(str) {
  return new Uint8Array(Buffer.from(str, 'base64'));
}

test('listSecureAndDecrypt uses history message keys when replaying without mutating live state', async (t) => {
  __resetMessagesTestOverrides();
  t.after(() => {
    __resetMessagesTestOverrides();
    resetProcessedMessages('conv-replay');
  });

  const messageKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = 'hello from history';
  const aesKey = await crypto.subtle.importKey(
    'raw',
    messageKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoder.encode(plaintext))
  );

  const messageKeyB64 = Buffer.from(messageKey).toString('base64');
  const ivB64 = Buffer.from(iv).toString('base64');
  const ciphertextB64Url = toBase64Url(Buffer.from(ciphertext).toString('base64'));
  const headerJson = JSON.stringify({ iv_b64: ivB64 });
  const hdrB64Url = toBase64Url(Buffer.from(headerJson).toString('base64'));

  const payloadEnvelope = {
    hdr_b64: hdrB64Url,
    ct_b64: ciphertextB64Url
  };

  let drDecryptCalled = 0;
  const prepareCalls = [];

  __setMessagesTestOverrides({
    listSecureMessages: async () => ({
      r: { ok: true, status: 200 },
      data: {
        items: [
          {
            id: 'msg-replay',
            created_at: 1_730_000_000,
            payload_envelope: payloadEnvelope
          }
        ],
        nextCursorTs: null
      }
    }),
    decryptConversationEnvelope: async () => ({
      ...payloadEnvelope,
      meta: {
        ts: 1_730_000_000,
        sender_fingerprint: 'fp-PEER',
        msg_type: 'text'
      }
    }),
    computeConversationAccessFingerprint: async () => 'fp-access',
    computeConversationFingerprint: async (_token, uid) => `fp-${uid}`,
    prepareDrForMessage: (args) => {
      prepareCalls.push(args);
      return {
        restored: false,
        duplicate: false,
        historyEntry: {
          messageKey_b64: messageKeyB64,
          snapshotAfter: { rk_b64: 'rk' }
        }
      };
    },
    restoreDrStateFromSnapshot: () => true,
    cloneDrStateHolder: () => ({ cloned: true }),
    persistDrSnapshot: () => {},
    recordDrMessageHistory: () => {},
    snapshotDrState: () => null,
    restoreDrStateToHistoryPoint: () => false,
    recoverDrState: async () => false,
    drDecryptText: () => {
      drDecryptCalled += 1;
      throw new Error('drDecryptText should not be called for replay');
    },
    drState: () => ({ base: true }),
    getUidHex: () => 'SELF',
    getAccountDigest: () => 'ACCT',
    b64UrlToBytes: decodeBase64Url,
    b64u8: decodeBase64,
    saveEnvelopeMeta: () => {},
    ensureSecureConversationReady: async () => {}
  });

  const result = await listSecureAndDecrypt({
    conversationId: 'conv-replay',
    tokenB64: 'dG9rZW4',
    peerUidHex: 'PEER',
    limit: 10,
    mutateState: false,
    allowReplay: true
  });

  assert.equal(result.items.length, 1, 'should return one decrypted message');
  assert.equal(result.items[0].text, plaintext);
  assert.equal(result.items[0].type, 'text');
  assert.deepEqual(result.errors, []);

  assert.equal(drDecryptCalled, 0, 'ratchet decrypt should not run during history replay');
  assert.equal(prepareCalls.length, 1);
  assert.equal(prepareCalls[0].allowCursorReplay, true);
  assert.equal(prepareCalls[0].mutate, false);
});

test('listSecureAndDecrypt ignores control message decrypt errors', async (t) => {
  __resetMessagesTestOverrides();
  t.after(() => {
    __resetMessagesTestOverrides();
    resetProcessedMessages('conv-control');
  });

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const headerJson = JSON.stringify({ iv_b64: Buffer.from(iv).toString('base64') });
  const hdrB64Url = toBase64Url(Buffer.from(headerJson).toString('base64'));

  __setMessagesTestOverrides({
    listSecureMessages: async () => ({
      r: { ok: true, status: 200 },
      data: {
        items: [
          {
            id: 'msg-control',
            created_at: 1_730_000_100,
            payload_envelope: {
              hdr_b64: hdrB64Url,
              ct_b64: toBase64Url(Buffer.from([1, 2, 3]).toString('base64'))
            }
          }
        ],
        nextCursorTs: null
      }
    }),
    decryptConversationEnvelope: async () => ({
      hdr_b64: hdrB64Url,
      ct_b64: toBase64Url(Buffer.from([1, 2, 3]).toString('base64')),
      meta: {
        ts: 1_730_000_100,
        sender_fingerprint: 'fp-SELF',
        msg_type: 'session-init'
      }
    }),
    computeConversationAccessFingerprint: async () => 'fp-access',
    computeConversationFingerprint: async (_token, uid) => `fp-${uid}`,
    prepareDrForMessage: () => ({
      restored: false,
      duplicate: false
    }),
    restoreDrStateFromSnapshot: () => false,
    snapshotDrState: () => ({ snapshot: true }),
    recordDrMessageHistory: () => {},
    restoreDrStateToHistoryPoint: () => false,
    recoverDrState: async () => false,
    persistDrSnapshot: () => {},
    cloneDrStateHolder: (state) => ({ ...state }),
    saveEnvelopeMeta: () => {},
    ensureSecureConversationReady: async () => {},
    drState: () => ({ live: true }),
    getUidHex: () => 'SELF',
    getAccountDigest: () => 'ACCT',
    b64UrlToBytes: decodeBase64Url,
    b64u8: decodeBase64,
    drDecryptText: () => {
      throw new Error('OperationError: simulated failure');
    }
  });

  const result = await listSecureAndDecrypt({
    conversationId: 'conv-control',
    tokenB64: 'dG9rZW4',
    peerUidHex: 'PEER',
    limit: 10
  });

  assert.equal(result.items.length, 0, 'control messages should not surface to timeline');
  assert.equal(result.errors.length, 0, 'control message decrypt errors should be suppressed');
});
