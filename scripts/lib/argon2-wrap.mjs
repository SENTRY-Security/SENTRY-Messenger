import crypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { bytesToB64, b64ToBytes } from '../../web/src/shared/utils/base64.js';
import { toU8Strict } from './u8-strict.js';

if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

const TEXT_ENCODER = new TextEncoder();
const DEFAULT_PARAMS = Object.freeze({ m: 64, t: 3, p: 1 });

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  return new Uint8Array(value);
}

async function deriveKEKFromPassword(pwd, saltU8, params = DEFAULT_PARAMS) {
  const { m, t, p } = params;
  const salt = toUint8Array(saltU8);
  const memKiB = Math.max(m, 8 * p) * 1024;
  const hash = argon2id(utf8ToBytes(String(pwd ?? '')), salt, {
    t,
    m: memKiB,
    p,
    dkLen: 32
  });
  const kek = await crypto.webcrypto.subtle.importKey(
    'raw',
    toU8Strict(hash, 'scripts/lib/argon2-wrap.mjs:29:deriveKEKFromPassword'),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return { kek, params: { m, t, p } };
}

export async function wrapMKWithPasswordArgon2id(pwd, mkRawU8, params = DEFAULT_PARAMS) {
  const mk = toUint8Array(mkRawU8);
  if (mk.length !== 32) {
    throw new Error('wrapMKWithPasswordArgon2id expects 32-byte MK');
  }
  const salt = crypto.webcrypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const { kek, params: finalParams } = await deriveKEKFromPassword(pwd, salt, params);
  const ciphertext = await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, mk);
  return {
    v: 1,
    kdf: 'argon2id',
    m: finalParams.m,
    t: finalParams.t,
    p: finalParams.p,
    salt_b64: bytesToB64(salt),
    iv_b64: bytesToB64(iv),
    ct_b64: bytesToB64(new Uint8Array(ciphertext))
  };
}

export async function unwrapMKWithPasswordArgon2id(pwd, blob) {
  if (!blob || blob.kdf !== 'argon2id') return null;
  const params = {
    m: blob.m ?? DEFAULT_PARAMS.m,
    t: blob.t ?? DEFAULT_PARAMS.t,
    p: blob.p ?? DEFAULT_PARAMS.p
  };
  const salt = b64ToBytes(blob.salt_b64);
  const iv = b64ToBytes(blob.iv_b64);
  const ct = b64ToBytes(blob.ct_b64);
  const { kek } = await deriveKEKFromPassword(pwd, salt, params);
  try {
    const mkBuf = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct);
    return new Uint8Array(mkBuf);
  } catch {
    return null;
  }
}

export const ARGON2_DEFAULT_PARAMS = DEFAULT_PARAMS;
