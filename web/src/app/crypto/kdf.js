

// /app/crypto/kdf.js
// Argon2id → KEK → wrap/unwrap MK (AES-GCM). Pure front-end, 0-knowledge.
// Exports:
//   - loadArgon2()
//   - deriveKEKFromPassword(pwd, saltU8, params={m:64,t:3,p:1}) -> {kek, params}
//   - wrapMKWithPasswordArgon2id(pwd, mkRawU8) -> {v:1,kdf:'argon2id',m,t,p,salt_b64,iv_b64,ct_b64}
//   - unwrapMKWithPasswordArgon2id(pwd, blob) -> Uint8Array | null
//
// Notes:
//   - m: memory in MiB; t: time (iterations); p: parallelism
//   - mkRawU8 is a 32-byte Uint8Array
//   - All crypto runs in the browser; server never sees the password nor MK
import { toU8Strict } from '/shared/utils/u8-strict.js';

/** Dynamically load argon2-browser (UMD) if not present. */
let _argon2Loading = null;
export function loadArgon2() {
  if (globalThis.argon2) return Promise.resolve();
  if (_argon2Loading) return _argon2Loading;
  _argon2Loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/argon2-browser@1.18.0/dist/argon2-bundled.min.js';
    s.onload = resolve;
    s.onerror = () => { _argon2Loading = null; reject(new Error('argon2 load failed')); };
    document.head.appendChild(s);
  });
  return _argon2Loading;
}

/** Derive a KEK (AES-GCM raw key) from password using Argon2id */
export async function deriveKEKFromPassword(pwd, saltU8, params = { m: 64, t: 3, p: 1 }) {
  await loadArgon2();
  const { m, t, p } = params;
  const res = await globalThis.argon2.hash({
    pass: pwd,
    salt: saltU8,
    type: globalThis.argon2.ArgonType.Argon2id,
    time: t,
    mem: m * 1024,        // KiB
    parallelism: p,
    hashLen: 32
  });
  const kekRaw = new Uint8Array(res.hash); // 32 bytes
  const kek = await crypto.subtle.importKey(
    'raw',
    toU8Strict(kekRaw, 'web/src/app/crypto/kdf.js:42:deriveKEKFromPassword'),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return { kek, params: { m, t, p } };
}

/** Wrap MK with password → argon2id KEK + AES-GCM */
export async function wrapMKWithPasswordArgon2id(pwd, mkRawU8) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const { kek, params } = await deriveKEKFromPassword(pwd, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, mkRawU8);
  return {
    v: 1,
    kdf: 'argon2id',
    m: params.m, t: params.t, p: params.p,
    salt_b64: b64(salt),
    iv_b64: b64(iv),
    ct_b64: b64(new Uint8Array(ct))
  };
}

/** Unwrap MK from argon2id blob; returns Uint8Array(32) or null on failure */
export async function unwrapMKWithPasswordArgon2id(pwd, blob) {
  try {
    if (!blob || blob.kdf !== 'argon2id') return null;
    const salt = b64u8(blob.salt_b64);
    const iv = b64u8(blob.iv_b64);
    const ct = b64u8(blob.ct_b64);
    const { kek } = await deriveKEKFromPassword(pwd, salt, {
      m: blob.m ?? 64, t: blob.t ?? 3, p: blob.p ?? 1
    });
    const mkBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct);
    return new Uint8Array(mkBuf);
  } catch {
    return null;
  }
}

// --- small helpers (local only) ---
function b64(u8) {
  let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64u8(b64s) {
  const bin = atob(String(b64s || ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
