
// /app/crypto/nacl.js
// Re-export crypto primitives backed by libsodium-wrappers-sumo.
// Exports:
//  - loadNacl()
//  - genEd25519Keypair()     -> { publicKey:Uint8Array, secretKey:Uint8Array }
//  - genX25519Keypair()      -> { publicKey:Uint8Array, secretKey:Uint8Array }
//  - signDetached(msgU8, ed25519SecretKeyU8) -> Uint8Array
//  - scalarMult(secretKeyU832, publicKeyU8)  -> Uint8Array(32)
//  - b64(u8), b64u8(s)

export * from '../../shared/crypto/nacl.js';
