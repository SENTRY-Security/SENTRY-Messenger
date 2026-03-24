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

// Backed by libsodium-wrappers-sumo (audited by multiple security firms).
// Replaces the previous TweetNaCl (nacl-fast.min.js) backend.
import _sodium from 'libsodium-wrappers-sumo';

let sodiumReady = false;

async function ensureSodium() {
  if (sodiumReady) return _sodium;
  await _sodium.ready;
  sodiumReady = true;
  return _sodium;
}

export async function ensureNacl() {
  return ensureSodium();
}

export async function loadNacl() {
  await ensureSodium();
}

export async function genEd25519Keypair() {
  const sodium = await ensureSodium();
  const kp = sodium.crypto_sign_keypair();
  // Return 64-byte secretKey (seed‖publicKey) matching TweetNaCl format
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export async function genX25519Keypair() {
  const sodium = await ensureSodium();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export async function signDetached(messageU8, secretKeyU8) {
  const sodium = await ensureSodium();
  return sodium.crypto_sign_detached(messageU8, secretKeyU8);
}

export async function verifyDetached(messageU8, signatureU8, publicKeyU8) {
  const sodium = await ensureSodium();
  return sodium.crypto_sign_verify_detached(signatureU8, messageU8, publicKeyU8);
}

export async function scalarMult(secretKey32, publicKey32) {
  const sodium = await ensureSodium();
  return sodium.crypto_scalarmult(secretKey32, publicKey32);
}

export function b64(u8) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(u8).toString('base64');
  }
  let s = '';
  const arr = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function b64u8(b64s) {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(String(b64s || ''), 'base64'));
  }
  const bin = atob(String(b64s || ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
  return u8;
}
