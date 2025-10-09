// /app/crypto/dr.js
// Minimal X3DH (initiator) + Double Ratchet (DR) helpers.
// - Pure crypto (no network / store); caller supplies peer bundle & device keys and persists state as needed.
//
// Exports:
//   x3dhInitiate(devicePriv, peerBundle) -> DR state
//   drRatchet(state, theirRatchetPubU8) -> void
//   drEncryptText(state, plaintext) -> { aead:'aes-256-gcm', header:{dr,ek_pub_b64,pn,n}, iv_b64,ciphertext_b64 }
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
