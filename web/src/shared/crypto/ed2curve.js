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

// Ed25519 → X25519 key conversion using libsodium built-in functions.
// Replaces the previous hand-rolled curve25519 arithmetic.
import { ensureNacl } from './nacl.js';

export async function convertEd25519PublicKey(edPublicU8) {
  if (!(edPublicU8 instanceof Uint8Array) || edPublicU8.length !== 32) return null;
  const sodium = await ensureNacl();
  try {
    return sodium.crypto_sign_ed25519_pk_to_curve25519(edPublicU8);
  } catch {
    return null;
  }
}

export async function convertEd25519SecretKey(edSeedU8) {
  if (!(edSeedU8 instanceof Uint8Array) || edSeedU8.length !== 32) return null;
  const sodium = await ensureNacl();
  try {
    // Expand 32-byte seed to 64-byte Ed25519 secret key, then convert
    const fullSecret = sodium.crypto_sign_seed_keypair(edSeedU8).privateKey;
    return sodium.crypto_sign_ed25519_sk_to_curve25519(fullSecret);
  } catch {
    return null;
  }
}
