

// /app/crypto/prekeys.js
// Helpers for device pre-keys (OPKs) and initial device bundle management.
// Pure crypto + small helpers to wrap/unwrap device private blob with MK.
// This module does NOT call network APIs directly; callers should pass API callbacks
// into ensureKeysAfterUnlock() so the module remains testable.

import { loadNacl, genEd25519Keypair, genX25519Keypair, signDetached, b64 } from './nacl.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from './aead.js';

/**
 * Generate an initial device key bundle.
 * Returns: { devicePriv, bundlePub }
 *  - devicePriv: { ik_priv_b64, ik_pub_b64, spk_priv_b64, spk_pub_b64, spk_sig_b64, next_opk_id }
 *  - bundlePub: { ik_pub, spk_pub, spk_sig, opks: [{id,pub}] }
 */
export async function generateInitialBundle(nextIdStart = 1, count = 100) {
  await loadNacl();
  const ik  = await genEd25519Keypair();   // Ed25519 for signatures
  const spk = await genX25519Keypair();    // X25519 for DH
  const spk_sig = await signDetached(spk.publicKey, ik.secretKey);

  const opks = [];
  for (let i = 0; i < count; i++) {
    const kp = await genX25519Keypair();
    opks.push({ id: nextIdStart + i, pub: b64(kp.publicKey) });
  }

  const devicePriv = {
    ik_priv_b64:  b64(ik.secretKey),
    ik_pub_b64:   b64(ik.publicKey),
    spk_priv_b64: b64(spk.secretKey),
    spk_pub_b64:  b64(spk.publicKey),
    spk_sig_b64:  b64(spk_sig),
    next_opk_id: nextIdStart + count
  };

  const bundlePub = {
    ik_pub:  b64(ik.publicKey),
    spk_pub: b64(spk.publicKey),
    spk_sig: b64(spk_sig),
    opks
  };

  return { devicePriv, bundlePub };
}

/**
 * Generate `count` OPKs starting at nextIdStart.
 * Returns { opks: [{id,pub}], next }
 */
export async function generateOpksFrom(nextIdStart = 1, count = 20) {
  await loadNacl();
  const opks = [];
  for (let i = 0; i < count; i++) {
    const kp = await genX25519Keypair();
    opks.push({ id: nextIdStart + i, pub: b64(kp.publicKey) });
  }
  return { opks, next: nextIdStart + count };
}

/**
 * Wrap devicePriv (JSON object) with MK into an envelope (using aead.wrapWithMK_JSON)
 * Returns wrapped_dev envelope.
 */
export async function wrapDevicePrivWithMK(devicePrivObj, mkRawU8) {
  return await wrapWithMK_JSON(devicePrivObj, mkRawU8, 'devkeys/v1');
}

/**
 * Unwrap wrapped_dev envelope using MK; returns parsed devicePriv object
 */
export async function unwrapDevicePrivWithMK(wrappedDevEnvelope, mkRawU8) {
  return await unwrapWithMK_JSON(wrappedDevEnvelope, mkRawU8);
}

/**
 * Ensure device keys exist on server and are published.
 * This helper orchestrates crypto + network via injected callbacks so tests/mocks possible.
 *
 * Options must include the following async callbacks:
 *  - fetchDevkeys(uidHex) => returns { wrapped_dev } or null
 *  - publishBundle(bundlePub) => publishes public bundle to server (returns true/resp)
 *  - storeDevkeys(session, uidHex, wrapped_dev) => stores wrapped_dev server-side
 *
 * Arguments:
 *  - mkRawU8: Uint8Array MK to wrap devicePriv
 *  - uidHex: string
 *  - opts: { fetchDevkeys, publishBundle, storeDevkeys, initialOpkCount=100, replenishCount=20 }
 *
 * Behavior:
 *  1. If server already has wrapped_dev for uid -> return that.
 *  2. Otherwise generateInitialBundle(), publish bundlePub, wrap devicePriv with MK, store on server.
 *  3. Returns an object { wrapped_dev, bundlePub, devicePriv }
 */
export async function ensureKeysAfterUnlock(mkRawU8, uidHex, opts = {}) {
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

  // 1) try fetch
  const existing = await fetchDevkeys(uidHex).catch(()=>null);
  if (existing && existing.wrapped_dev) return { wrapped_dev: existing.wrapped_dev, existed: true };

  // 2) generate new bundle
  const { devicePriv, bundlePub } = await generateInitialBundle(1, initialOpkCount);

  // publish public bundle
  await publishBundle(bundlePub);

  // wrap devicePriv with MK and store
  const wrapped_dev = await wrapDevicePrivWithMK(devicePriv, mkRawU8);
  await storeDevkeys(session, uidHex, wrapped_dev);

  return { wrapped_dev, bundlePub, devicePriv };
}

// end of file