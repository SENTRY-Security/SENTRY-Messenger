/**
 * Web Push for Cloudflare Workers (pure Web Crypto API)
 *
 * Implements RFC 8291 (Message Encryption for Web Push) and
 * RFC 8292 (VAPID) using only Web Crypto API — no Node.js crypto.
 *
 * Usage:
 *   const { sendPushNotification } = createWebPush({
 *     vapidPublicKey: '...',   // URL-safe base64 P-256 public key
 *     vapidPrivateKey: '...',  // URL-safe base64 P-256 private key
 *     vapidSubject: 'mailto:admin@example.com'
 *   });
 *   await sendPushNotification(subscriptionJSON, payloadString);
 */

// ── Helpers ──────────────────────────────────────────────────────

function base64UrlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - str.length % 4) % 4;
  str += '='.repeat(pad);
  const raw = atob(str);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a instanceof Uint8Array ? a : new Uint8Array(a), offset);
    offset += a.byteLength;
  }
  return result;
}

const encoder = new TextEncoder();

// ── VAPID JWT (RFC 8292) ─────────────────────────────────────────

async function createVapidJwt(audience, vapidSubject, privateKeyBytes, publicKeyBytes, expSeconds = 43200) {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: now + expSeconds,
    sub: vapidSubject
  };

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  // Import private key as ECDSA P-256
  // privateKeyBytes is the raw 32-byte scalar
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(publicKeyBytes.slice(1, 33)),
    y: base64UrlEncode(publicKeyBytes.slice(33, 65)),
    d: base64UrlEncode(privateKeyBytes)
  };

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsignedToken));

  return `${unsignedToken}.${base64UrlEncode(sig)}`;
}

// ── RFC 8291: Web Push Encryption ────────────────────────────────

async function hkdfSha256(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));

  const infoKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const t1Input = concat(info, new Uint8Array([1]));
  const t1 = new Uint8Array(await crypto.subtle.sign('HMAC', infoKey, t1Input));

  return t1.slice(0, length);
}

function createInfo(type, clientPublicKey, serverPublicKey) {
  // "Content-Encoding: <type>\0" + recipient_public + sender_public
  const typeBytes = encoder.encode(`Content-Encoding: ${type}\0`);
  const clientLen = new Uint8Array(2);
  clientLen[0] = (clientPublicKey.length >> 8) & 0xff;
  clientLen[1] = clientPublicKey.length & 0xff;
  const serverLen = new Uint8Array(2);
  serverLen[0] = (serverPublicKey.length >> 8) & 0xff;
  serverLen[1] = serverPublicKey.length & 0xff;
  return concat(typeBytes, clientLen, clientPublicKey, serverLen, serverPublicKey);
}

async function encryptPayload(clientPublicKeyBytes, authSecret, payload) {
  // Generate ephemeral ECDH key pair
  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey));

  // Import client public key
  const clientKey = await crypto.subtle.importKey('raw', clientPublicKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // ECDH shared secret
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKeyPair.privateKey, 256));

  // Generate 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF: auth_info = "WebPush: info\0" + client_public + server_public
  const authInfo = concat(encoder.encode('WebPush: info\0'), clientPublicKeyBytes, serverPublicKeyRaw);

  // IKM from auth secret
  const ikm = await hkdfSha256(authSecret, sharedSecret, authInfo, 32);

  // Content encryption key — RFC 8291 §3.4: info is just the content-encoding string
  const cekInfo = encoder.encode('Content-Encoding: aes128gcm\0');
  const cek = await hkdfSha256(salt, ikm, cekInfo, 16);

  // Nonce — RFC 8291 §3.4: info is just the content-encoding string
  const nonceInfo = encoder.encode('Content-Encoding: nonce\0');
  const nonce = await hkdfSha256(salt, ikm, nonceInfo, 12);

  // Pad payload — append delimiter byte per RFC 8188 §2 (0x02 = final record, 0x01 = non-final)
  const payloadBytes = encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const paddedPayload = concat(payloadBytes, new Uint8Array([2])); // 0x02 = final record

  // AES-128-GCM encrypt
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, paddedPayload));

  // Build aes128gcm content coding header:
  // salt (16) + record_size (4) + keyid_len (1) + keyid (65 = uncompressed P-256 point)
  const recordSize = new Uint8Array(4);
  const rs = 4096; // standard record size for web push (per RFC 8188)
  recordSize[0] = (rs >> 24) & 0xff;
  recordSize[1] = (rs >> 16) & 0xff;
  recordSize[2] = (rs >> 8) & 0xff;
  recordSize[3] = rs & 0xff;
  const keyIdLen = new Uint8Array([65]); // uncompressed P-256 key = 65 bytes

  return {
    body: concat(salt, recordSize, keyIdLen, serverPublicKeyRaw, encrypted),
    serverPublicKey: serverPublicKeyRaw
  };
}

// ── Main export ──────────────────────────────────────────────────

export function createWebPush({ vapidPublicKey, vapidPrivateKey, vapidSubject }) {
  const publicKeyBytes = base64UrlDecode(vapidPublicKey);
  const privateKeyBytes = base64UrlDecode(vapidPrivateKey);

  async function sendPushNotification(subscription, payload) {
    const endpoint = subscription.endpoint;
    const p256dh = base64UrlDecode(subscription.keys.p256dh);
    const auth = base64UrlDecode(subscription.keys.auth);

    // Extract audience from endpoint URL
    const url = new URL(endpoint);
    const audience = `${url.protocol}//${url.host}`;

    // Create VAPID authorization
    const jwt = await createVapidJwt(audience, vapidSubject, privateKeyBytes, publicKeyBytes);

    // Encrypt payload
    const { body } = await encryptPayload(p256dh, auth, payload);

    // Send to push service
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': String(body.byteLength),
        'TTL': '86400',
        'Authorization': `vapid t=${jwt}, k=${vapidPublicKey}`
      },
      body: body
    });

    // Read response body for diagnostics on failure
    let responseBody = '';
    if (!response.ok) {
      try { responseBody = await response.text(); } catch { /* ignore */ }
      console.warn('[web-push] push service error', {
        status: response.status,
        endpoint: endpoint.slice(0, 80),
        body: responseBody.slice(0, 200)
      });
    }

    return {
      ok: response.ok,
      status: response.status,
      gone: response.status === 404 || response.status === 410,
      responseBody
    };
  }

  return { sendPushNotification };
}
