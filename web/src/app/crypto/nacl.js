

// /app/crypto/nacl.js
// Lightweight wrapper around TweetNaCl (UMD) with local→CDN fallback.
// Exports:
//  - loadNacl()
//  - genEd25519Keypair()     -> { publicKey:Uint8Array, secretKey:Uint8Array }
//  - genX25519Keypair()      -> { publicKey:Uint8Array, secretKey:Uint8Array }
//  - signDetached(msgU8, ed25519SecretKeyU8) -> Uint8Array
//  - scalarMult(secretKeyU832, publicKeyU8)  -> Uint8Array(32)
//  - b64(u8), b64u8(s)
//
// No state persistence; this module does not expose window.nacl to callers.

// Recommended: use ui-utils.js for Base64 instead.
export * from '../../shared/crypto/nacl.js';
