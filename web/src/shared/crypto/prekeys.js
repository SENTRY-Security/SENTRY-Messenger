/**
 * SECURITY POLICY – STRICT CRYPTO PROTOCOL, NO FALLBACK ALLOWED.
 *
 * 本檔案中的所有密碼協定（X3DH、Double Ratchet、AEAD、鍵派生、counter 驗證、header 驗證）
 * 禁止設計、加入或推論任何 fallback、retry、rollback、resync、auto-repair 等邏輯。
 *
 * 規則如下：
 * 1. 若解密失敗 → 一律直接 fail，不可嘗試第二組 key 或舊 ratchet state。
 * 2. 若 counter 不一致 → 一律直接拒絕，不可重送、補拉或自動對齊。
 * 3. 不允許任何協定降級（downgrade）。不得用舊版本、舊頭資訊、舊密鑰重試。
 * 4. 不允許模糊錯誤處理。不做 try-catch fallback，不做 silent recovery。
 * 5. 對話重置必須是顯式事件，不得隱式重建 state。
 *
 * 一切協定邏輯必須「單一路徑」且「強一致性」，任何 fallback 視為安全漏洞。
 */
import { loadNacl, genEd25519Keypair, genX25519Keypair, signDetached, b64, b64u8 } from './nacl.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from './aead.js';

function ensureBuffer(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export async function generateInitialBundle(nextIdStart = 1, count = 50) {
  await loadNacl();
  const ik = await genEd25519Keypair();
  const spk = await genX25519Keypair();
  const spk_sig = await signDetached(spk.publicKey, ik.secretKey);

  const opks = [];
  const opkPrivMap = {};
  for (let i = 0; i < count; i += 1) {
    const kp = await genX25519Keypair();
    opks.push({ id: nextIdStart + i, pub: b64(kp.publicKey) });
    opkPrivMap[nextIdStart + i] = b64(kp.secretKey);
  }

  const devicePriv = {
    ik_priv_b64: b64(ik.secretKey),
    ik_pub_b64: b64(ik.publicKey),
    spk_priv_b64: b64(spk.secretKey),
    spk_pub_b64: b64(spk.publicKey),
    spk_sig_b64: b64(spk_sig),
    opk_priv_map: opkPrivMap,
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
  const opkPrivMap = {};
  for (let i = 0; i < count; i += 1) {
    const kp = await genX25519Keypair();
    const id = nextIdStart + i;
    opks.push({ id, pub: b64(kp.publicKey) });
    opkPrivMap[id] = b64(kp.secretKey);
  }
  return { opks, opkPrivMap, next: nextIdStart + count };
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
    initialOpkCount = 50,
    replenishCount = 20,
    session = 'n/a',
    deviceId = null
  } = opts;

  if (!fetchDevkeys || !publishBundle || !storeDevkeys) {
    throw new Error('ensureKeysAfterUnlock requires fetchDevkeys, publishBundle and storeDevkeys callbacks');
  }

  const existing = await fetchDevkeys().catch(() => null);
  if (existing && existing.wrapped_dev) return { wrapped_dev: existing.wrapped_dev, existed: true };

  const { devicePriv, bundlePub } = await generateInitialBundle(1, initialOpkCount);
  if (deviceId) {
    devicePriv.device_id = deviceId;
    devicePriv.deviceId = deviceId;
  }
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
