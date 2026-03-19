// E2E push notification preview encryption
// ECDH P-256 + HKDF-SHA-256 + AES-256-GCM
//
// Wire format (base64url-encoded):
//   [65 bytes ephemeral P-256 public key (uncompressed)]
//   [12 bytes IV]
//   [ciphertext + 16 bytes GCM tag]
//
// The server only sees opaque ciphertext — it cannot read the preview content.

const HKDF_INFO = new TextEncoder().encode('sentry-push-preview-v1');

// ── Base64url helpers ────────────────────────────────────────────

function b64uEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob(base64 + padding);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

// ── Key generation (PWA side) ────────────────────────────────────

/**
 * Generate an ECDH P-256 keypair for push preview encryption.
 * @returns {Promise<{publicKeyB64: string, privateKeyB64: string}>}
 *   publicKeyB64:  base64url-encoded raw public key (65 bytes uncompressed)
 *   privateKeyB64: base64url-encoded PKCS8 private key
 */
export async function generatePreviewKeypair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, // extractable
    ['deriveBits']
  );
  const pubRaw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const privPkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  return {
    publicKeyB64: b64uEncode(pubRaw),
    privateKeyB64: b64uEncode(privPkcs8)
  };
}

// ── Encrypt (sender / main app side) ─────────────────────────────

/**
 * Encrypt a preview string for a specific device's push preview public key.
 * @param {string} recipientPubKeyB64 - base64url raw P-256 public key (65 bytes)
 * @param {string} plaintext - preview text to encrypt
 * @returns {Promise<string>} base64url-encoded ciphertext blob
 */
export async function encryptPreview(recipientPubKeyB64, plaintext) {
  const recipientPubRaw = b64uDecode(recipientPubKeyB64);

  // Import recipient's public key
  const recipientPub = await crypto.subtle.importKey(
    'raw', recipientPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  // Generate ephemeral keypair
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveBits']
  );

  // ECDH shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: recipientPub },
    ephemeral.privateKey,
    256
  );

  // HKDF → AES-256-GCM key
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  // Encrypt
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);

  // Export ephemeral public key
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  // Pack: ephemeralPub(65) + iv(12) + ciphertext(variable)
  const blob = new Uint8Array(65 + 12 + ciphertext.byteLength);
  blob.set(ephPubRaw, 0);
  blob.set(iv, 65);
  blob.set(new Uint8Array(ciphertext), 77);

  return b64uEncode(blob);
}

// ── Decrypt (SW / PWA side) ──────────────────────────────────────

/**
 * Decrypt an encrypted preview blob using the device's private key.
 * @param {string} privateKeyB64 - base64url PKCS8 private key
 * @param {string} blobB64 - base64url-encoded ciphertext blob
 * @returns {Promise<string>} decrypted preview text
 */
export async function decryptPreview(privateKeyB64, blobB64) {
  const privBytes = b64uDecode(privateKeyB64);
  const blob = b64uDecode(blobB64);

  // Unpack
  const ephPubRaw = blob.slice(0, 65);
  const iv = blob.slice(65, 77);
  const ciphertext = blob.slice(77);

  // Import keys
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', privBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, ['deriveBits']
  );
  const ephPub = await crypto.subtle.importKey(
    'raw', ephPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  // ECDH shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephPub },
    privateKey,
    256
  );

  // HKDF → AES-256-GCM key
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  // Decrypt
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  return new TextDecoder().decode(plainBuf);
}
