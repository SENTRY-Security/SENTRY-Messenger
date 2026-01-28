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
// /app/crypto/dr.js
// Minimal X3DH (initiator) + Double Ratchet (DR) helpers.
// - Pure crypto (no network / store); caller supplies peer bundle & device keys and persists state as needed.
//
// Exports:
//   x3dhInitiate(devicePriv, peerBundle) -> DR state
//   drRatchet(state, theirRatchetPubU8) -> void
//   drEncryptText(state, plaintext) -> { aead:'aes-256-gcm', header:{dr,v,device_id,ek_pub_b64,pn,n}, iv_b64,ciphertext_b64, message_key_b64 }
//   drDecryptText(state, packet) -> string
//
// Types:
//   devicePriv = {
//     ik_priv_b64, ik_pub_b64,        // Ed25519 (sign)
//     spk_priv_b64, spk_pub_b64,      // X25519 (box)
//     spk_sig_b64, next_opk_id
//   }
//   peerBundle = {
//     ik_pub, spk_pub, spk_sig,       // base64 strings
//     opk: { id, pub } | null         // base64 string or null
//   }

export * from '../../shared/crypto/dr.js';
