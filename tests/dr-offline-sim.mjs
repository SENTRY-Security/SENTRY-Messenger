import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

if (typeof globalThis.TextEncoder === 'undefined' || typeof globalThis.TextDecoder === 'undefined') {
  const { TextEncoder, TextDecoder } = await import('node:util');
  if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder;
  if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder;
}

const sessionMap = new Map();
if (typeof globalThis.sessionStorage === 'undefined') {
  globalThis.sessionStorage = {
    getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
    setItem: (k, v) => sessionMap.set(k, String(v)),
    removeItem: (k) => sessionMap.delete(k),
    clear: () => sessionMap.clear(),
    key: (i) => Array.from(sessionMap.keys())[i] ?? null,
    get length() { return sessionMap.size; }
  };
}
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = globalThis.sessionStorage;
}
if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = (b64) => Buffer.from(String(b64), 'base64').toString('binary');
}
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (bin) => Buffer.from(String(bin), 'binary').toString('base64');
}

const {
  setAccountDigest,
  setDeviceId,
  setDevicePriv,
  drState
} = await import('../web/src/app/core/store.js');
const { generateInitialBundle } = await import('../web/src/shared/crypto/prekeys.js');
const { x3dhInitiate, x3dhRespond, drEncryptText } = await import('../web/src/shared/crypto/dr.js');
const {
  listSecureAndDecrypt,
  __setMessagesTestOverrides,
  __resetMessagesTestOverrides
} = await import('../web/src/app/features/messages.js');

const toB64 = (u8) => Buffer.from(u8).toString('base64');
const b64UrlToBytes = (str) => {
  const normalized = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  return new Uint8Array(Buffer.from(normalized + pad, 'base64'));
};

const setSelf = ({ digest, deviceId, devicePriv }) => {
  if (digest) setAccountDigest(digest);
  if (deviceId) setDeviceId(deviceId);
  if (devicePriv) setDevicePriv(devicePriv);
};

const ensureSkippedMap = (state) => {
  if (!state) return state;
  if (!(state.skippedKeys instanceof Map)) state.skippedKeys = new Map();
  return state;
};

const buildHeader = ({
  baseHeader,
  senderDigest,
  senderDeviceId,
  receiverDigest,
  receiverDeviceId,
  ts,
  ivB64
}) => {
  const header = {
    ...baseHeader,
    dr: 1,
    device_id: baseHeader.device_id || senderDeviceId,
    peerAccountDigest: receiverDigest,
    peerDeviceId: receiverDeviceId,
    meta: {
      msg_type: 'text',
      senderDigest,
      sender_digest: senderDigest,
      sender_device_id: senderDeviceId,
      senderDeviceId: senderDeviceId,
      receiverDeviceId: receiverDeviceId,
      receiver_device_id: receiverDeviceId,
      receiverAccountDigest: receiverDigest,
      receiver_account_digest: receiverDigest,
      targetAccountDigest: receiverDigest,
      target_account_digest: receiverDigest,
      ts
    }
  };
  header.n = baseHeader.n;
  header.ek_pub_b64 = baseHeader.ek_pub_b64;
  header.iv_b64 = ivB64 || baseHeader.iv_b64;
  return header;
};

async function main() {
  const initiatorDigest = 'A'.repeat(64);
  const responderDigest = 'B'.repeat(64);
  const initiatorDeviceId = 'dev-A';
  const responderDeviceId = 'dev-B';

  const { devicePriv: initiatorPriv, bundlePub: initiatorBundle } = await generateInitialBundle(101, 4);
  const { devicePriv: responderPriv, bundlePub: responderBundle } = await generateInitialBundle(1, 4);

  initiatorPriv.device_id = initiatorDeviceId;
  initiatorPriv.deviceId = initiatorDeviceId;
  responderPriv.device_id = responderDeviceId;
  responderPriv.deviceId = responderDeviceId;

  const initiatorCtx = { digest: initiatorDigest, deviceId: initiatorDeviceId, priv: initiatorPriv, bundle: initiatorBundle };
  const responderCtx = { digest: responderDigest, deviceId: responderDeviceId, priv: responderPriv, bundle: responderBundle };

  const responderOpk = responderBundle.opks[0];
  if (!responderOpk) throw new Error('responder bundle missing opk');

  const responderBundleForInitiator = {
    ik_pub: responderBundle.ik_pub,
    spk_pub: responderBundle.spk_pub,
    spk_sig: responderBundle.spk_sig,
    opk: responderOpk
  };

  const initStateA = await x3dhInitiate(initiatorPriv, responderBundleForInitiator);

  const guestBundleFromInitiator = {
    ek_pub: toB64(initStateA.myRatchetPub),
    ik_pub: initiatorBundle.ik_pub,
    spk_pub: initiatorBundle.spk_pub,
    spk_sig: initiatorBundle.spk_sig,
    opk_id: responderOpk.id
  };

  const respStateB = await x3dhRespond(responderPriv, guestBundleFromInitiator);

  setSelf(responderCtx);
  const respHolder = ensureSkippedMap(drState({ peerAccountDigest: initiatorDigest, peerDeviceId: initiatorDeviceId }));
  Object.assign(respHolder, respStateB);
  ensureSkippedMap(respHolder);

  setSelf(initiatorCtx);
  const initHolder = ensureSkippedMap(drState({ peerAccountDigest: responderDigest, peerDeviceId: responderDeviceId }));
  Object.assign(initHolder, initStateA);
  ensureSkippedMap(initHolder);

  const stubByConversation = new Map();

  const noop = () => {};
  let overridesSet = false;
  let exitCode = 1;
  try {
    __setMessagesTestOverrides({
      listSecureMessages: async ({ conversationId }) => {
        const payload = stubByConversation.get(conversationId);
        if (payload) return payload;
        return { r: { ok: true }, data: { items: [] } };
      },
      ensureSecureConversationReady: async () => {},
      ensureDrReceiverState: async () => {},
      persistDrSnapshot: noop,
      snapshotDrState: (state) => (state ? { ...state, skippedKeys: state.skippedKeys instanceof Map ? new Map(state.skippedKeys) : new Map() } : state),
      cloneDrStateHolder: (state) => (state ? { ...state, skippedKeys: state.skippedKeys instanceof Map ? new Map(state.skippedKeys) : new Map() } : state),
      sendReadReceipt: async () => {},
      sendDeliveryReceipt: async () => {},
      b64UrlToBytes
    });
    overridesSet = true;

    const nowTs = Math.floor(Date.now() / 1000);

    // A -> B
    const encryptedAB = await drEncryptText(initHolder, 'hello-from-A', { deviceId: initiatorDeviceId, version: 1 });
    const headerAB = buildHeader({
      baseHeader: encryptedAB.header,
      senderDigest: initiatorDigest,
      senderDeviceId: initiatorDeviceId,
      receiverDigest: responderDigest,
      receiverDeviceId: responderDeviceId,
      ts: nowTs,
      ivB64: encryptedAB.iv_b64
    });
    const convAtoB = `contacts-${responderDigest}`;
    stubByConversation.set(convAtoB, {
      r: { ok: true },
      data: {
        items: [
          {
            id: 'msg-ab-1',
            counter: headerAB.n,
            created_at: nowTs,
            header_json: JSON.stringify(headerAB),
            ciphertext_b64: encryptedAB.ciphertext_b64
          }
        ]
      }
    });

    setSelf(responderCtx);
    const resAB = await listSecureAndDecrypt({
      conversationId: convAtoB,
      peerAccountDigest: initiatorDigest,
      peerDeviceId: initiatorDeviceId,
      limit: 20,
      sendReadReceipt: false,
      allowReplay: true,
      mutateState: true
    });
    console.log('\n[A -> B] items:', resAB.items);
    console.log('[A -> B] errors:', resAB.errors);
    console.log('[A -> B] deadLetters:', resAB.deadLetters);
    const successAB = !resAB.errors?.length && !resAB.deadLetters?.length && resAB.items?.[0]?.text === 'hello-from-A';

    // B -> A (reply)
    const encryptedBA = await drEncryptText(respHolder, 'hello-from-B', { deviceId: responderDeviceId, version: 1 });
    const headerBA = buildHeader({
      baseHeader: encryptedBA.header,
      senderDigest: responderDigest,
      senderDeviceId: responderDeviceId,
      receiverDigest: initiatorDigest,
      receiverDeviceId: initiatorDeviceId,
      ts: nowTs + 1,
      ivB64: encryptedBA.iv_b64
    });
    const convBtoA = `contacts-${initiatorDigest}`;
    stubByConversation.set(convBtoA, {
      r: { ok: true },
      data: {
        items: [
          {
            id: 'msg-ba-1',
            counter: headerBA.n,
            created_at: nowTs + 1,
            header_json: JSON.stringify(headerBA),
            ciphertext_b64: encryptedBA.ciphertext_b64
          }
        ]
      }
    });

    setSelf(initiatorCtx);
    const resBA = await listSecureAndDecrypt({
      conversationId: convBtoA,
      peerAccountDigest: responderDigest,
      peerDeviceId: responderDeviceId,
      limit: 20,
      sendReadReceipt: false,
      allowReplay: true,
      mutateState: true
    });
    console.log('\n[B -> A] items:', resBA.items);
    console.log('[B -> A] errors:', resBA.errors);
    console.log('[B -> A] deadLetters:', resBA.deadLetters);
    const successBA = !resBA.errors?.length && !resBA.deadLetters?.length && resBA.items?.[0]?.text === 'hello-from-B';

    const success = successAB && successBA;
    console.log('\nSuccess (both directions):', success);
    exitCode = success ? 0 : 1;
  } finally {
    if (overridesSet) __resetMessagesTestOverrides();
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exit(Number.isInteger(code) ? code : 0);
  })
  .catch((err) => {
    console.error('Simulation failed:', err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  });
