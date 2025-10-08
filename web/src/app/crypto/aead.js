// /app/crypto/aead.js
// HKDF(SHA-256) + AES-GCM per-file/content encryption helpers（純前端，0-knowledge）
// 提供：
//   - encryptWithMK(plainU8, mkRawU8, infoTag='media/v1') -> { cipherBuf, iv, hkdfSalt }
//   - decryptWithMK(cipherU8, mkRawU8, saltU8, ivU8, infoTag='media/v1') -> Uint8Array
//   - wrapWithMK_JSON(obj, mkRawU8, infoTag='blob/v1') -> { v, aead:'aes-256-gcm', info, salt_b64, iv_b64, ct_b64 }
//   - unwrapWithMK_JSON(envelope, mkRawU8) -> any
//
// 注意：不匯入任何外部套件；使用瀏覽器 WebCrypto。

/** HKDF -> AES-GCM CryptoKey 派生 */
async function hkdfDeriveAesKey(mkRawU8, saltU8, infoStr, usages) {
  const mkKey = await crypto.subtle.importKey('raw', mkRawU8, 'HKDF', false, ['deriveKey']);
  const info = new TextEncoder().encode(infoStr || 'mk/aead');
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: saltU8, info },
    mkKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

/** 使用 MK 衍生的 AES-GCM 金鑰加密一段資料 */
export async function encryptWithMK(plainU8, mkRawU8, infoTag = 'media/v1') {
  const salt = crypto.getRandomValues(new Uint8Array(16));   // per-object salt
  const iv   = crypto.getRandomValues(new Uint8Array(12));   // 96-bit IV
  const key  = await hkdfDeriveAesKey(mkRawU8, salt, infoTag, ['encrypt']);
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainU8);
  return { cipherBuf: new Uint8Array(ctBuf), iv, hkdfSalt: salt };
}

/** 使用 MK 衍生的 AES-GCM 金鑰解密一段資料 */
export async function decryptWithMK(cipherU8, mkRawU8, saltU8, ivU8, infoTag = 'media/v1') {
  const key = await hkdfDeriveAesKey(mkRawU8, saltU8, infoTag, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivU8 }, key, cipherU8);
  return new Uint8Array(pt);
}

/** 以 MK 包裝 JSON 物件（輸出 envelope） */
export async function wrapWithMK_JSON(obj, mkRawU8, infoTag = 'blob/v1') {
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const { cipherBuf, iv, hkdfSalt } = await encryptWithMK(plain, mkRawU8, infoTag);
  return {
    v: 1,
    aead: 'aes-256-gcm',
    info: infoTag,
    salt_b64: b64(hkdfSalt),
    iv_b64:   b64(iv),
    ct_b64:   b64(cipherBuf)
  };
}

/** 以 MK 解開 envelope，還原 JSON 物件 */
export async function unwrapWithMK_JSON(envelope, mkRawU8) {
  if (!envelope || envelope.aead !== 'aes-256-gcm') {
    throw new Error('Unsupported envelope (expect aead=aes-256-gcm)');
  }
  const salt = b64u8(envelope.salt_b64);
  const iv   = b64u8(envelope.iv_b64);
  const ct   = b64u8(envelope.ct_b64);
  const info = envelope.info || 'blob/v1';
  const plain = await decryptWithMK(ct, mkRawU8, salt, iv, info);
  return JSON.parse(new TextDecoder().decode(plain));
}

// --- small helpers ---
export function b64(u8) {
  let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
export function b64u8(b64s) {
  const bin = atob(String(b64s || ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
