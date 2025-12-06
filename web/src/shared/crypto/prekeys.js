import { loadNacl, genEd25519Keypair, genX25519Keypair, signDetached, b64, b64u8 } from './nacl.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from './aead.js';

function ensureBuffer(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export async function generateInitialBundle(nextIdStart = 1, count = 100) {
  await loadNacl();
  const ik = await genEd25519Keypair();
  const spk = await genX25519Keypair();
  const spk_sig = await signDetached(spk.publicKey, ik.secretKey);

  const opks = [];
  for (let i = 0; i < count; i += 1) {
    const kp = await genX25519Keypair();
    opks.push({ id: nextIdStart + i, pub: b64(kp.publicKey) });
  }

  const devicePriv = {
    ik_priv_b64: b64(ik.secretKey),
    ik_pub_b64: b64(ik.publicKey),
    spk_priv_b64: b64(spk.secretKey),
    spk_pub_b64: b64(spk.publicKey),
    spk_sig_b64: b64(spk_sig),
    next_opk_id: nextIdStart + count
  };

  const bundlePub = {
    ik_pub: b64(ik.publicKey),
    spk_pub: b64(spk.publicKey),
    spk_sig: b64(spk_sig),
    opks
  };

  return { devicePriv, bundlePub };
}

export async function generateOpksFrom(nextIdStart = 1, count = 20) {
  await loadNacl();
  const opks = [];
  for (let i = 0; i < count; i += 1) {
    const kp = await genX25519Keypair();
    opks.push({ id: nextIdStart + i, pub: b64(kp.publicKey) });
  }
  return { opks, next: nextIdStart + count };
}

export async function wrapDevicePrivWithMK(devicePrivObj, mkRawU8) {
  return wrapWithMK_JSON(devicePrivObj, ensureBuffer(mkRawU8), 'devkeys/v1');
}

export async function unwrapDevicePrivWithMK(wrappedDevEnvelope, mkRawU8) {
  return unwrapWithMK_JSON(wrappedDevEnvelope, ensureBuffer(mkRawU8));
}

export async function ensureKeysAfterUnlock(mkRawU8, opts = {}) {
  const {
    fetchDevkeys,
    publishBundle,
    storeDevkeys,
    initialOpkCount = 100,
    replenishCount = 20,
    session = 'n/a'
  } = opts;

  if (!fetchDevkeys || !publishBundle || !storeDevkeys) {
    throw new Error('ensureKeysAfterUnlock requires fetchDevkeys, publishBundle and storeDevkeys callbacks');
  }

  const existing = await fetchDevkeys().catch(() => null);
  if (existing && existing.wrapped_dev) return { wrapped_dev: existing.wrapped_dev, existed: true };

  const { devicePriv, bundlePub } = await generateInitialBundle(1, initialOpkCount);
  await publishBundle(bundlePub);

  const wrapped_dev = await wrapDevicePrivWithMK(devicePriv, mkRawU8);
  await storeDevkeys(session, wrapped_dev);

  return { wrapped_dev, bundlePub, devicePriv };
}

export function decodeDevicePriv(devicePrivB64) {
  return {
    ikPriv: b64u8(devicePrivB64.ik_priv_b64),
    spkPriv: b64u8(devicePrivB64.spk_priv_b64)
  };
}
