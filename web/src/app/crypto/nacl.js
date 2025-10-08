

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

/** Attempt to load TweetNaCl from a list of sources (first success wins). */
export async function loadNacl() {
  if (globalThis.nacl) return;
  const trySrc = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('nacl load failed: ' + src));
    document.head.appendChild(s);
  });
  // Prefer local copy; then two CDNs
  const candidates = [
    '/libs/nacl-fast.min.js',
    'https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js',
    'https://unpkg.com/tweetnacl@1.0.3/nacl-fast.min.js'
  ];
  let lastErr = null;
  for (const src of candidates) {
    try { await trySrc(src); if (globalThis.nacl) return; }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('nacl not available on window');
}

/** Generate an Ed25519 (sign) keypair. */
export async function genEd25519Keypair() {
  await loadNacl();
  const n = globalThis.nacl;
  const kp = n.sign.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** Generate an X25519 (box) keypair. */
export async function genX25519Keypair() {
  await loadNacl();
  const n = globalThis.nacl;
  const kp = n.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** Detached Ed25519 signature. */
export async function signDetached(msgU8, ed25519SecretKeyU8) {
  await loadNacl();
  return globalThis.nacl.sign.detached(msgU8, ed25519SecretKeyU8);
}

/**
 * Curve25519 scalarMult.
 * secretKey32: Uint8Array(32) — must be the first 32 bytes of a NaCl secretKey.
 * publicKey  : Uint8Array(32) — peer's public key (X25519)
 */
export async function scalarMult(secretKey32, publicKey) {
  await loadNacl();
  return globalThis.nacl.scalarMult(secretKey32, publicKey);
}

// --- small helpers (exported for convenience) ---
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
