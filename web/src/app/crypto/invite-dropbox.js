import { genX25519Keypair, scalarMult, b64, b64u8 } from './nacl.js';
import { bytesToB64, b64ToBytes } from '../../shared/utils/base64.js';
import { toU8Strict } from '/shared/utils/u8-strict.js';

const INFO_TAG = 'contact-init/dropbox/v1';
const SALT_BYTES = new TextEncoder().encode('invite-dropbox-salt');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requireNonEmptyString(value, key) {
  if (typeof value !== 'string') throw new Error(`${key} required`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${key} required`);
  return trimmed;
}

function requirePositiveInt(value, key) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) throw new Error(`${key} required`);
  return Math.floor(num);
}

export function assertInviteEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') throw new Error('envelope required');
  const allowedKeys = new Set(['v', 'aead', 'info', 'sealed', 'createdAt', 'expiresAt']);
  for (const key of Object.keys(envelope)) {
    if (!allowedKeys.has(key)) throw new Error('invalid envelope field');
  }
  const v = Number(envelope.v ?? 0);
  if (!Number.isFinite(v) || v !== 1) throw new Error('invalid envelope version');
  const aead = requireNonEmptyString(envelope.aead, 'aead');
  if (aead !== 'aes-256-gcm') throw new Error('invalid envelope aead');
  const info = requireNonEmptyString(envelope.info, 'info');
  if (info !== INFO_TAG) throw new Error('invalid envelope info');
  const sealed = envelope.sealed;
  if (!sealed || typeof sealed !== 'object') throw new Error('invalid envelope sealed');
  const sealedAllowed = new Set(['eph_pub_b64', 'iv_b64', 'ct_b64']);
  for (const key of Object.keys(sealed)) {
    if (!sealedAllowed.has(key)) throw new Error('invalid sealed field');
  }
  const ephPub = requireNonEmptyString(sealed.eph_pub_b64, 'sealed.eph_pub_b64');
  const iv = requireNonEmptyString(sealed.iv_b64, 'sealed.iv_b64');
  const ct = requireNonEmptyString(sealed.ct_b64, 'sealed.ct_b64');
  const createdAt = requirePositiveInt(envelope.createdAt, 'createdAt');
  const expiresAt = requirePositiveInt(envelope.expiresAt, 'expiresAt');
  return {
    v,
    aead,
    info,
    sealed: {
      eph_pub_b64: ephPub,
      iv_b64: iv,
      ct_b64: ct
    },
    createdAt,
    expiresAt
  };
}

async function deriveAesKey(sharedSecret, infoTag) {
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(sharedSecret, 'web/src/app/crypto/invite-dropbox.js:48:deriveAesKey'),
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT_BYTES, info: encoder.encode(infoTag) },
    key,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function sealInviteEnvelope({ ownerPublicKeyB64, payload, expiresAt }) {
  const ownerPub = b64u8(requireNonEmptyString(ownerPublicKeyB64, 'ownerPublicKeyB64'));
  if (!(ownerPub instanceof Uint8Array) || ownerPub.length !== 32) {
    throw new Error('ownerPublicKey invalid');
  }
  if (!payload || typeof payload !== 'object') throw new Error('payload required');
  const expires = requirePositiveInt(expiresAt, 'expiresAt');
  const ek = await genX25519Keypair();
  const shared = await scalarMult(ek.secretKey, ownerPub);
  const key = await deriveAesKey(shared, INFO_TAG);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return {
    v: 1,
    aead: 'aes-256-gcm',
    info: INFO_TAG,
    sealed: {
      eph_pub_b64: b64(ek.publicKey),
      iv_b64: bytesToB64(iv),
      ct_b64: bytesToB64(ciphertext)
    },
    createdAt: Date.now(),
    expiresAt: expires
  };
}

export async function openInviteEnvelope({ ownerPrivateKeyB64, envelope }) {
  const normalized = assertInviteEnvelope(envelope);
  const ownerPriv = b64u8(requireNonEmptyString(ownerPrivateKeyB64, 'ownerPrivateKeyB64'));
  if (!(ownerPriv instanceof Uint8Array) || ownerPriv.length !== 32) {
    throw new Error('ownerPrivateKey invalid');
  }
  const ephPub = b64u8(normalized.sealed.eph_pub_b64);
  if (!(ephPub instanceof Uint8Array) || ephPub.length !== 32) {
    throw new Error('eph_pub_b64 invalid');
  }
  const shared = await scalarMult(ownerPriv, ephPub);
  const key = await deriveAesKey(shared, normalized.info);
  const iv = b64ToBytes(normalized.sealed.iv_b64);
  const ct = b64ToBytes(normalized.sealed.ct_b64);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(decoder.decode(new Uint8Array(plain)));
}
