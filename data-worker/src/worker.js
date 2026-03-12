import crypto from 'node:crypto';
import { toU8Strict } from './u8-strict.js';
import { getOpaqueConfig, OpaqueID, OpaqueServer, KE1, KE3, RegistrationRequest, RegistrationRecord, ExpectedAuthResult } from '@cloudflare/opaque-ts';

// Re-export Durable Object class so Cloudflare runtime can find it
export { AccountWebSocket } from './account-ws.js';

// ---- 基本工具與正規化 ----
const textEncoder = new TextEncoder();

// Node.js proxy removed — all routes are now served by Cloudflare Workers.
const INVITE_INFO_TAG = 'contact-init/dropbox/v1';

// ---- AES-CMAC (RFC 4493) implemented with Web Crypto API ----
// Uses AES-CBC with zero IV to simulate AES-ECB per block (for a single
// 16-byte block, CBC with zero IV is identical to ECB).
async function aesCmac(keyBuf, dataBuf) {
  const BLOCKLEN = 16;
  const Rb = 0x87;
  const ZERO_IV = new Uint8Array(BLOCKLEN);

  const rawKey = keyBuf instanceof Uint8Array ? keyBuf : new Uint8Array(keyBuf.buffer || keyBuf);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', rawKey, { name: 'AES-CBC' }, false, ['encrypt']
  );

  // Helper: AES-ECB encrypt a single 16-byte block via AES-CBC(zero IV).
  // AES-CBC output = encrypted block (16 B) + PKCS7 pad block (16 B) → take first 16.
  async function ecbBlock(block) {
    const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ZERO_IV }, cryptoKey, block);
    return new Uint8Array(ct, 0, BLOCKLEN);
  }

  // Step 1: Generate subkeys  L = AES-ECB(K, 0^128)
  const L = await ecbBlock(ZERO_IV);
  function dbl(buf) {
    const out = new Uint8Array(BLOCKLEN);
    let carry = 0;
    for (let i = BLOCKLEN - 1; i >= 0; i--) {
      const v = (buf[i] << 1) | carry;
      out[i] = v & 0xff;
      carry = buf[i] >> 7;
    }
    if (carry) out[BLOCKLEN - 1] ^= Rb;
    return out;
  }
  const K1 = dbl(L);
  const K2 = dbl(K1);

  // Step 2: Prepare blocks
  const data = dataBuf instanceof Uint8Array ? dataBuf : new Uint8Array(
    Buffer.isBuffer(dataBuf) ? dataBuf.buffer.slice(dataBuf.byteOffset, dataBuf.byteOffset + dataBuf.byteLength) : (dataBuf || [])
  );
  const n = data.length === 0 ? 1 : Math.ceil(data.length / BLOCKLEN);
  const lastComplete = data.length > 0 && data.length % BLOCKLEN === 0;
  const Mn = new Uint8Array(BLOCKLEN);
  if (lastComplete) {
    Mn.set(data.subarray((n - 1) * BLOCKLEN, n * BLOCKLEN));
    for (let i = 0; i < BLOCKLEN; i++) Mn[i] ^= K1[i];
  } else {
    const tail = data.length - (n - 1) * BLOCKLEN;
    if (tail > 0) Mn.set(data.subarray((n - 1) * BLOCKLEN, data.length));
    Mn[tail] = 0x80; // padding
    for (let i = 0; i < BLOCKLEN; i++) Mn[i] ^= K2[i];
  }

  // Step 3: CBC-MAC
  let X = new Uint8Array(BLOCKLEN);
  for (let i = 0; i < n - 1; i++) {
    const block = data.subarray(i * BLOCKLEN, (i + 1) * BLOCKLEN);
    for (let j = 0; j < BLOCKLEN; j++) X[j] ^= block[j];
    X = await ecbBlock(X);
  }
  for (let j = 0; j < BLOCKLEN; j++) X[j] ^= Mn[j];
  const T = await ecbBlock(X);
  return Buffer.from(T); // Return as Buffer for caller compatibility
}

// ---- NTAG424 KDF ----
function ntag424_normalizeCtr(ctrHex) {
  const s = String(ctrHex || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  const right6 = s.length > 6 ? s.slice(-6) : s;
  return right6.padStart(6, '0');
}

function ntag424_hkdf16(kmHex, uidHex, salt, info) {
  const km = Buffer.from(kmHex, 'hex');
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const prk = hmac(Buffer.from(salt || ''), km);
  const okm = hmac(prk, Buffer.from(`${info || 'ntag424-static-key'}:${uidHex}`, 'utf8'));
  return okm.subarray(0, 16);
}

async function ntag424_ev2cmac16(kmHex, uidHex, tagidHex, kver) {
  const parts = [Buffer.from([0x01]), Buffer.from('EV2-KDF')];
  if (uidHex) parts.push(Buffer.from(uidHex, 'hex'));
  if (tagidHex) parts.push(Buffer.from(String(tagidHex).replace(/-/g, ''), 'hex'));
  if (kver != null) parts.push(Buffer.from([Number(kver) & 0xff]));
  return (await aesCmac(Buffer.from(kmHex, 'hex'), Buffer.concat(parts))).subarray(0, 16);
}

async function ntag424_deriveKey(env, kmEnvName, uidHex, tagidHex) {
  const kmHex = String(env[kmEnvName] || '').trim().toUpperCase();
  if (!/^[0-9A-Fa-f]{32}$/.test(kmHex)) throw new Error(`${kmEnvName} missing or invalid`);
  const uid = String(uidHex || '').toUpperCase();
  const mode = String(env.NTAG424_KDF || 'HKDF').toUpperCase();
  const kver = env.NTAG424_KVER ? Number(env.NTAG424_KVER) : undefined;
  if (mode === 'EV2') return ntag424_ev2cmac16(kmHex, uid, tagidHex, kver);
  const salt = env.NTAG424_SALT || env.DOMAIN || 'sentry.red';
  const info = env.NTAG424_INFO || 'ntag424-static-key';
  return ntag424_hkdf16(kmHex, uid, salt, info);
}

async function ntag424_deriveWithFallback(env, uidHex, tagidHex) {
  const current = await ntag424_deriveKey(env, 'NTAG424_KM', uidHex, tagidHex);
  const oldHex = String(env.NTAG424_KM_OLD || '').trim();
  if (/^[0-9A-Fa-f]{32}$/.test(oldHex)) {
    const uid = String(uidHex || '').toUpperCase();
    const mode = String(env.NTAG424_KDF || 'HKDF').toUpperCase();
    const kver = env.NTAG424_KVER ? Number(env.NTAG424_KVER) : undefined;
    const legacy = (mode === 'EV2')
      ? await ntag424_ev2cmac16(oldHex.toUpperCase(), uid, tagidHex, kver)
      : ntag424_hkdf16(oldHex.toUpperCase(), uid, env.NTAG424_SALT || env.DOMAIN || 'sentry.red', env.NTAG424_INFO || 'ntag424-static-key');
    return { current, legacy };
  }
  return { current };
}

// ---- NTAG424 SDM CMAC Verify ----
async function ntag424_computeSdmCmac(sdmKeyHex, uidHex, ctrHex) {
  const K = Buffer.from(sdmKeyHex, 'hex');
  const UID = Buffer.from(String(uidHex).replace(/[^0-9a-f]/gi, ''), 'hex');
  const ctr6 = ntag424_normalizeCtr(ctrHex);
  const ctrBuf = Buffer.from(ctr6, 'hex');
  const ctrLSB = Buffer.from(ctrBuf).reverse();
  const SV2 = Buffer.concat([Buffer.from('3CC300010080', 'hex'), UID, ctrLSB]);
  const Kses = await aesCmac(K, SV2);
  const full = await aesCmac(Kses, Buffer.alloc(0));
  // MACt: take odd-indexed bytes (indices 1,3,5,7,9,11,13,15) → 8 bytes
  const mac8 = Buffer.alloc(8);
  for (let i = 1, j = 0; i < 16 && j < 8; i += 2, j++) mac8[j] = full[i];
  return mac8.toString('hex').toUpperCase();
}

async function ntag424_verifyCmac(env, uidHex, ctrHex, cmacHex, tagidHex) {
  const { current, legacy } = await ntag424_deriveWithFallback(env, uidHex, tagidHex);
  const got = String(cmacHex || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  const keyHex = current.toString('hex').toUpperCase();
  const expected = await ntag424_computeSdmCmac(keyHex, uidHex, ctrHex);
  if (got === expected) return { ok: true, expected, got, used: 'current' };
  if (legacy) {
    const legacyHex = legacy.toString('hex').toUpperCase();
    const expectedOld = await ntag424_computeSdmCmac(legacyHex, uidHex, ctrHex);
    if (got === expectedOld) return { ok: true, expected: expectedOld, got, used: 'legacy' };
  }
  return { ok: false, expected, got, used: 'current' };
}

async function ntag424_computeSdmCmacForDebug(env, uidHex, ctrHex) {
  const key = await ntag424_deriveKey(env, 'NTAG424_KM', uidHex);
  return ntag424_computeSdmCmac(key.toString('hex').toUpperCase(), uidHex, ctrHex);
}

// ---- OPAQUE Server (singleton per isolate) ----
let _opaqueServer = null;
function getOrInitOpaqueServer(env) {
  if (_opaqueServer) return _opaqueServer;
  const seedHex = String(env.OPAQUE_OPRF_SEED || '').trim();
  if (!/^[0-9A-Fa-f]{64}$/.test(seedHex)) return null;
  const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
  const oprf_seed = Array.from(Buffer.from(seedHex, 'hex'));
  const serverId = env.OPAQUE_SERVER_ID || env.DOMAIN || 'api.sentry';
  const privB64 = String(env.OPAQUE_AKE_PRIV_B64 || '').trim();
  const pubB64 = String(env.OPAQUE_AKE_PUB_B64 || '').trim();
  let ake_keypair = null;
  if (privB64 && pubB64) {
    ake_keypair = {
      private_key: Array.from(Buffer.from(privB64, 'base64')),
      public_key: Array.from(Buffer.from(pubB64, 'base64'))
    };
  }
  try {
    _opaqueServer = new OpaqueServer(cfg, oprf_seed, ake_keypair, serverId);
    return _opaqueServer;
  } catch (e) {
    console.error('[opaque.init] failed', e?.message || e);
    return null;
  }
}

// ---- Auth KV helpers ----
const AUTH_KV_PREFIX_SESS = 'sess:';
const AUTH_KV_PREFIX_OPAQUE = 'opaque:';
const AUTH_KV_PREFIX_DBG_CTR = 'dbgctr:';

async function kvPut(env, key, value, ttlSeconds) {
  if (!env.AUTH_KV) throw new Error('AUTH_KV not bound');
  await env.AUTH_KV.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
}

async function kvGet(env, key) {
  if (!env.AUTH_KV) return null;
  const raw = await env.AUTH_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function kvDelete(env, key) {
  if (!env.AUTH_KV) return;
  await env.AUTH_KV.delete(key);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i += 1) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function b64ToBytes(str) {
  if (!str) return null;
  try {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64UrlToBytes(str) {
  if (!str) return null;
  const padded = str.length % 4 ? str + '==='.slice(str.length % 4) : str;
  return b64ToBytes(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

function b64ToU8(b64) {
  try {
    const bin = atob(String(b64 || ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
    return u8;
  } catch {
    return null;
  }
}

async function verifySignedPrekey({ spk_pub_b64, spk_sig_b64, ik_pub_b64 }) {
  if (!spk_pub_b64 || !spk_sig_b64 || !ik_pub_b64) return false;
  const spkPub = b64ToU8(spk_pub_b64);
  const spkSig = b64ToU8(spk_sig_b64);
  const ikPub = b64ToU8(ik_pub_b64);
  if (!spkPub || !spkSig || !ikPub) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      toU8Strict(ikPub, 'data-worker/src/worker.js:60:verifySignedPrekey'),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, spkSig, spkPub);
  } catch {
    return false;
  }
}

function normalizeAccountDigest(value) {
  const cleaned = String(value || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (cleaned.length !== 64) return null;
  return cleaned;
}

function normalizeDeviceId(value) {
  if (!value || typeof value !== 'string') return null;
  const token = value.trim();
  if (!token) return null;
  return token.slice(0, 120);
}

function normalizeUid(uid) {
  const cleaned = String(uid || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return cleaned.length >= 14 ? cleaned : null;
}

function json(obj, init) {
  return new Response(JSON.stringify(obj), {
    ...(init || {}),
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function verifyHMAC(req, env) {
  const sig = req.headers.get('x-auth') || '';
  if (!sig || !env.HMAC_SECRET) return false;
  const url = new URL(req.url);
  const body = req.method === 'GET' ? '' : await req.clone().text();
  const msgPipe = url.pathname + url.search + '|' + body;
  const msgNewline = url.pathname + url.search + '\n' + body;

  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(new TextEncoder().encode(env.HMAC_SECRET), 'data-worker/src/worker.js:106:verifyHMAC'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const encode = async (input) => {
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
    return btoa(String.fromCharCode(...new Uint8Array(mac)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const [sigPipe, sigNewline] = await Promise.all([encode(msgPipe), encode(msgNewline)]);
  return timingSafeEqual(sig, sigPipe) || timingSafeEqual(sig, sigNewline);
}

// ---- 帳號與 MK / TAGS 相關共用 ----
let dataTablesReady = false;
const _pairingCodeRateLimit = new Map(); // { accountDigest → { attempts, lockedUntil } }

function bytesToHex(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i += 1) {
    out += u8[i].toString(16).padStart(2, '0');
  }
  return out.toUpperCase();
}

function hexToBytes(hex) {
  const cleaned = String(hex || '').replace(/[^0-9A-Fa-f]/g, '');
  if (cleaned.length % 2 === 1) {
    throw new Error('hexToBytes: invalid length');
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToBase64Url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 1) {
    bin += String.fromCharCode(u8[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeJSON(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function normalizeHashHex(value, { maxLen = 128, minLen = 8 } = {}) {
  if (!value || typeof value !== 'string') return null;
  const cleaned = value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (!cleaned.length || cleaned.length < minLen) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function normalizeConversationId(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  if (!/^[A-Za-z0-9_:-]{8,128}$/.test(token)) return null;
  return token;
}

function normalizeMessageId(value) {
  if (value === null || value === undefined) return null;
  const token = String(value || '').trim();
  if (!token) return null;
  if (token.length < 8 || token.length > 200) return null;
  return token;
}

function normalizeEnvelope(input) {
  if (!input || typeof input !== 'object') return null;
  const iv = typeof input.iv === 'string' ? input.iv.trim() : '';
  const ct = typeof input.ct === 'string' ? input.ct.trim() : '';
  if (!iv || !ct) return null;
  if (iv.length < 8 || ct.length < 8) return null;
  return { iv, ct };
}

function safeParseEnvelope(json) {
  try {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    return normalizeEnvelope(obj);
  } catch {
    return null;
  }
}

function parseBackupPayload(rawPayload) {
  const parsed = safeJSON(rawPayload);
  if (parsed && typeof parsed === 'object' && parsed.payload && parsed.meta && parsed.payload.aead) {
    const withDrStateMeta = Number.isFinite(Number(parsed.meta?.withDrState)) ? Number(parsed.meta.withDrState) : null;
    return { payload: parsed.payload, withDrState: withDrStateMeta };
  }
  const withDrStateInline = Number.isFinite(Number(parsed?.withDrState)) ? Number(parsed.withDrState) : null;
  return { payload: parsed, withDrState: withDrStateInline };
}

function normalizeOpk(opk) {
  if (!opk || typeof opk !== 'object') return null;
  const allowed = new Set(['id', 'pub']);
  for (const key of Object.keys(opk)) {
    if (!allowed.has(key)) return null;
  }
  const id = Number(opk.id);
  const pub = typeof opk.pub === 'string' ? opk.pub.trim() : null;
  if (!Number.isFinite(id) || !pub) return null;
  return { id, pub: pub.slice(0, 4096) };
}

function normalizeSignedPrekey(spk) {
  if (!spk || typeof spk !== 'object') return null;
  const allowed = new Set(['id', 'pub', 'sig', 'ik_pub']);
  for (const key of Object.keys(spk)) {
    if (!allowed.has(key)) return null;
  }
  const id = Number(spk.id);
  const pub = typeof spk.pub === 'string' ? spk.pub.trim() : null;
  const sig = typeof spk.sig === 'string' ? spk.sig.trim() : null;
  const ikPub = typeof spk.ik_pub === 'string' ? spk.ik_pub.trim() : null;
  if (!Number.isFinite(id) || !pub || !sig || !ikPub) return null;
  return {
    id,
    pub: pub.slice(0, 4096),
    sig: sig.slice(0, 4096),
    ik_pub: ikPub.slice(0, 4096)
  };
}

function normalizeGroupId(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return null;
  return token;
}

function normalizeGroupName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 120);
}

function normalizeGroupRole(value) {
  const role = String(value || '').toLowerCase();
  if (role === 'owner' || role === 'admin') return role;
  return 'member';
}

function normalizeGroupStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['active', 'left', 'kicked', 'removed'].includes(status)) return status;
  return null;
}

function normalizeGroupAvatar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return null; }
  }
  return null;
}

function normalizeInviteDropboxEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const allowedKeys = new Set(['v', 'aead', 'info', 'sealed', 'createdAt', 'expiresAt']);
  for (const key of Object.keys(envelope)) {
    if (!allowedKeys.has(key)) return null;
  }
  const v = Number(envelope.v ?? 0);
  const aead = String(envelope.aead || '').trim();
  const info = String(envelope.info || '').trim();
  const createdAt = Number(envelope.createdAt || 0);
  const expiresAt = Number(envelope.expiresAt || 0);
  if (!Number.isFinite(v) || v !== 1) return null;
  if (aead !== 'aes-256-gcm') return null;
  if (info !== INVITE_INFO_TAG) return null;
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  const sealed = envelope.sealed;
  if (!sealed || typeof sealed !== 'object') return null;
  const sealedAllowed = new Set(['eph_pub_b64', 'iv_b64', 'ct_b64']);
  for (const key of Object.keys(sealed)) {
    if (!sealedAllowed.has(key)) return null;
  }
  const ephPub = String(sealed.eph_pub_b64 || '').trim();
  const iv = String(sealed.iv_b64 || '').trim();
  const ct = String(sealed.ct_b64 || '').trim();
  if (!ephPub || !iv || !ct) return null;
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

const INVITE_DELIVER_ALIAS_FIELDS = new Set([
  'invite_id',
  'account_token',
  'account_digest',
  'device_id',
  'ciphertext_envelope'
]);
const INVITE_CONSUME_ALIAS_FIELDS = new Set([
  'invite_id',
  'account_token',
  'account_digest',
  'device_id',
  'ciphertext_envelope'
]);
const INVITE_STATUS_ALIAS_FIELDS = new Set([
  'invite_id',
  'account_token',
  'account_digest'
]);
const INVITE_DELIVER_ALLOWED_FIELDS = new Set([
  'inviteId',
  'accountToken',
  'accountDigest',
  'deviceId',
  'ciphertextEnvelope'
]);
const INVITE_CONSUME_ALLOWED_FIELDS = new Set([
  'inviteId',
  'accountToken',
  'accountDigest',
  'deviceId'
]);
const INVITE_STATUS_ALLOWED_FIELDS = new Set([
  'inviteId',
  'accountToken',
  'accountDigest'
]);
const INVITE_CONFIRM_ALIAS_FIELDS = new Set([
  'invite_id',
  'account_token',
  'account_digest',
  'device_id'
]);
const INVITE_CONFIRM_ALLOWED_FIELDS = new Set([
  'inviteId',
  'accountToken',
  'accountDigest',
  'deviceId'
]);
const INVITE_UNCONFIRMED_ALIAS_FIELDS = new Set([
  'account_token',
  'account_digest'
]);
const INVITE_UNCONFIRMED_ALLOWED_FIELDS = new Set([
  'accountToken',
  'accountDigest'
]);

function findAliasKey(payload, aliasKeys) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of Object.keys(payload)) {
    if (aliasKeys.has(key)) return key;
  }
  return null;
}

function findUnexpectedKey(payload, allowedKeys) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) return key;
  }
  return null;
}

function inviteAliasError(key) {
  return json(
    { error: 'BadRequest', code: 'InviteSchemaMismatch', message: `alias field not allowed: ${key}`, field: key },
    { status: 400 }
  );
}

function inviteUnexpectedFieldError(key) {
  return json(
    { error: 'BadRequest', code: 'InviteSchemaMismatch', message: `unexpected field: ${key}`, field: key },
    { status: 400 }
  );
}

async function allocateOwnerPrekeyBundle(env, ownerAccountDigest, preferredDeviceId = null) {
  if (!ownerAccountDigest) return null;
  let deviceId = normalizeDeviceId(preferredDeviceId);

  if (!deviceId) {
    const devRow = await env.DB.prepare(
      `SELECT device_id FROM devices
         WHERE account_digest=?1
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`
    ).bind(ownerAccountDigest).first();
    deviceId = normalizeDeviceId(devRow?.device_id);
  }
  if (!deviceId) return null;

  const spkRow = await env.DB.prepare(
    `SELECT spk_id, spk_pub, spk_sig, ik_pub
       FROM device_signed_prekeys
      WHERE account_digest=?1 AND device_id=?2
      ORDER BY spk_id DESC
      LIMIT 1`
  ).bind(ownerAccountDigest, deviceId).first();
  if (!spkRow) return null;
  const ikPub = spkRow.ik_pub || null;
  if (!ikPub) return null; // 嚴格要求當前設備簽名鍵附帶 IK，不再嘗試備份回填

  let opk = null;
  const opkRow = await env.DB.prepare(
    `SELECT opk_id, opk_pub
       FROM device_opks
      WHERE account_digest=?1 AND device_id=?2 AND consumed_at IS NULL
      ORDER BY opk_id ASC
      LIMIT 1`
  ).bind(ownerAccountDigest, deviceId).first();
  if (!opkRow) {
    console.warn('allocate_owner_bundle_opk_missing', { ownerAccountDigest, deviceId });
    return null;
  }
  await env.DB.prepare(
    `UPDATE device_opks SET consumed_at=strftime('%s','now')
       WHERE account_digest=?1 AND device_id=?2 AND opk_id=?3`
  ).bind(ownerAccountDigest, deviceId, opkRow.opk_id).run();
  opk = { id: Number(opkRow.opk_id), pub: String(opkRow.opk_pub || '') };

  return {
    device_id: deviceId,
    ik_pub: ikPub,
    spk_pub: String(spkRow.spk_pub || ''),
    spk_sig: String(spkRow.spk_sig || ''),
    opk
  };
}

async function grantConversationAccess(env, { conversationId, accountDigest, deviceId = null, role = 'member' }) {
  if (!conversationId || !accountDigest) return;
  await ensureDataTables(env);
  try {
    await env.DB.prepare(`
      INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(conversation_id, account_digest, device_id) DO UPDATE SET
        role = COALESCE(excluded.role, conversation_acl.role),
        updated_at = strftime('%s','now')
    `).bind(conversationId, accountDigest, deviceId, role || null).run();
  } catch (err) {
    console.warn('conversation_acl_upsert_failed', err?.message || err);
  }
}

async function deleteContactByPeer(env, convId, _targetUid, targetAccountDigest = null) {
  if (!convId || !targetAccountDigest) return 0;
  const acctParam = targetAccountDigest ? targetAccountDigest.toUpperCase() : null;
  let total = 0;
  try {
    const resSecure = await env.DB.prepare(`
      DELETE FROM messages_secure
       WHERE conversation_id=?1
         AND json_extract(header_json,'$.contact') = 1
         AND (
           ( ?2 IS NOT NULL AND UPPER(json_extract(header_json,'$.peerAccountDigest')) = ?2 )
         )
    `).bind(convId, acctParam).run();
    total += resSecure?.meta?.changes || 0;
  } catch (err) {
    console.warn('delete_contact_secure_failed', err?.message || err);
  }
  try {
    const resLegacy = await env.DB.prepare(`
      DELETE FROM messages
       WHERE conv_id=?1
         AND json_extract(header_json,'$.contact') = 1
         AND (
           ( ?2 IS NOT NULL AND UPPER(json_extract(header_json,'$.peerAccountDigest')) = ?2 )
         )
    `).bind(convId, acctParam).run();
    total += resLegacy?.meta?.changes || 0;
  } catch (err) {
    console.warn('delete_contact_legacy_failed', err?.message || err);
  }
  return total;
}

async function deleteConversationData(env, conversationId) {
  if (!conversationId) return 0;
  let total = 0;
  const tables = [
    { sql: `DELETE FROM messages_secure WHERE conversation_id=?1`, label: 'messages_secure' },
    { sql: `DELETE FROM messages WHERE conv_id=?1`, label: 'messages' },
    { sql: `DELETE FROM attachments WHERE conversation_id=?1`, label: 'attachments' },
    { sql: `DELETE FROM media_objects WHERE conv_id=?1`, label: 'media_objects' },
    { sql: `DELETE FROM message_key_vault WHERE conversation_id=?1`, label: 'message_key_vault' },
    { sql: `DELETE FROM deletion_cursors WHERE conversation_id=?1`, label: 'deletion_cursors' },
    { sql: `DELETE FROM conversation_deletion_log WHERE conversation_id=?1`, label: 'conversation_deletion_log' },
    { sql: `DELETE FROM conversation_acl WHERE conversation_id=?1`, label: 'conversation_acl' },
    { sql: `DELETE FROM conversations WHERE id=?1`, label: 'conversations' }
  ];
  for (const { sql, label } of tables) {
    try {
      const res = await env.DB.prepare(sql).bind(conversationId).run();
      total += res?.meta?.changes || 0;
    } catch (err) {
      console.warn(`delete_conversation_${label}_failed`, conversationId, err?.message || err);
    }
  }
  return total;
}

async function insertContactMessage(env, { convAccountDigest, peerAccountDigest, envelope, ts, messageId }) {
  await ensureDataTables(env);
  const normalized = normalizeEnvelope(envelope);
  if (!normalized) return;

  const convAcctNorm = normalizeAccountDigest(convAccountDigest);
  if (!convAcctNorm) return;
  const peerAcctNorm = normalizeAccountDigest(peerAccountDigest);

  const convId = `contacts-${convAcctNorm}`;
  const senderDeviceId = 'contacts-system';
  const senderAccountDigest = peerAcctNorm || convAcctNorm;
  const receiverAccountDigest = convAcctNorm;
  const createdAt = Number.isFinite(ts) && ts > 0 ? ts : Math.floor(Date.now() / 1000);

  let counter = 1;
  try {
    const row = await env.DB.prepare(`
      SELECT MAX(counter) AS max_counter
        FROM messages_secure
       WHERE conversation_id=?1
         AND sender_account_digest=?2
         AND sender_device_id=?3
    `).bind(convId, senderAccountDigest, senderDeviceId).first();
    const maxCounter = Number(row?.max_counter ?? 0);
    if (Number.isFinite(maxCounter) && maxCounter > 0) counter = maxCounter + 1;
  } catch (err) {
    console.warn('contact_counter_lookup_failed', err?.message || err);
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ivB64 = bytesToBase64Url(iv);
  const header = {
    contact: 1,
    v: 1,
    peerAccountDigest: peerAcctNorm,
    ts: createdAt,
    envelope: normalized,
    iv_b64: ivB64,
    n: counter,
    device_id: senderDeviceId
  };
  const headerJson = JSON.stringify(header);
  const ciphertextB64 = bytesToBase64Url(new TextEncoder().encode(headerJson));
  if (!messageId) {
    throw new Error('messageId required for contact message');
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO conversations(id) VALUES (?1)`
  ).bind(convId).run();

  try {
    await env.DB.prepare(`
      INSERT INTO messages_secure (
        id, conversation_id, sender_account_digest, sender_device_id,
        receiver_account_digest, receiver_device_id, header_json, ciphertext_b64,
        counter, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).bind(
      messageId,
      convId,
      senderAccountDigest,
      senderDeviceId,
      receiverAccountDigest,
      null,
      headerJson,
      ciphertextB64,
      counter,
      createdAt
    ).run();
  } catch (err) {
    console.warn('contact_message_insert_failed', err?.message || err);
  }
}

async function removeConversationAccess(env, { conversationId, accountDigest }) {
  if (!conversationId || !accountDigest) return;
  await ensureDataTables(env);
  try {
    await env.DB.prepare(
      `DELETE FROM conversation_acl WHERE conversation_id=?1 AND account_digest=?2`
    ).bind(conversationId, accountDigest).run();
  } catch (err) {
    console.warn('conversation_acl_delete_failed', err?.message || err);
  }
}

async function upsertGroupMember(env, {
  groupId,
  accountDigest,
  role = 'member',
  status = 'active',
  inviterAccountDigest = null,
  joinedAt = null
} = {}) {
  if (!groupId || !accountDigest) return false;
  const normalizedRole = normalizeGroupRole(role);
  const normalizedStatus = normalizeGroupStatus(status) || 'active';
  const joined = Number.isFinite(Number(joinedAt)) && Number(joinedAt) > 0
    ? Math.floor(Number(joinedAt))
    : Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`
      INSERT INTO group_members (
        group_id, account_digest, role, status,
        inviter_account_digest, joined_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(group_id, account_digest) DO UPDATE SET
        role=excluded.role,
        status=excluded.status,
        inviter_account_digest=COALESCE(excluded.inviter_account_digest, group_members.inviter_account_digest),
        joined_at=COALESCE(group_members.joined_at, excluded.joined_at),
        updated_at=strftime('%s','now')
    `).bind(
      groupId,
      accountDigest,
      normalizedRole,
      normalizedStatus,
      inviterAccountDigest || null,
      joined
    ).run();
    return true;
  } catch (err) {
    console.warn('group_member_upsert_failed', err?.message || err);
    return false;
  }
}

async function fetchGroupWithMembers(env, groupId) {
  if (!groupId) return null;
  await ensureDataTables(env);
  const groupRows = await env.DB.prepare(
    `SELECT group_id, conversation_id, creator_account_digest, name, avatar_json, created_at, updated_at
       FROM groups WHERE group_id=?1`
  ).bind(groupId).all();
  const group = groupRows?.results?.[0] || null;
  if (!group) return null;
  const membersRes = await env.DB.prepare(
    `SELECT group_id, account_digest, role, status, inviter_account_digest,
            joined_at, muted_until, last_read_ts, created_at, updated_at
       FROM group_members
      WHERE group_id=?1`
  ).bind(groupId).all();
  const members = (membersRes?.results || []).map((row) => ({
    group_id: row.group_id,
    account_digest: row.account_digest,
    role: row.role || 'member',
    status: row.status || 'active',
    inviter_account_digest: row.inviter_account_digest || null,
    joined_at: Number(row.joined_at) || null,
    muted_until: Number(row.muted_until) || null,
    last_read_ts: Number(row.last_read_ts) || null,
    created_at: Number(row.created_at) || null,
    updated_at: Number(row.updated_at) || null
  }));
  return {
    group: {
      group_id: group.group_id,
      conversation_id: group.conversation_id,
      creator_account_digest: group.creator_account_digest,
      name: group.name || null,
      avatar: safeJSON(group.avatar_json) || null,
      created_at: Number(group.created_at) || null,
      updated_at: Number(group.updated_at) || null
    },
    members
  };
}

async function trimContactSecretBackups(env, accountDigest, limit = 5) {
  if (!accountDigest) return;
  const keep = Math.max(Number(limit) || 1, 1);
  await env.DB.prepare(
    `DELETE FROM contact_secret_backups
       WHERE account_digest=?1
         AND id NOT IN (
           SELECT id FROM contact_secret_backups
            WHERE account_digest=?1
            ORDER BY updated_at DESC, id DESC
            LIMIT ?2
         )`
  ).bind(accountDigest, keep).run();
}

const CallStatusSet = new Set(['dialing', 'ringing', 'connecting', 'connected', 'in_call', 'ended', 'failed', 'cancelled', 'timeout', 'pending']);
const CallModeSet = new Set(['voice', 'video']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CALL_SESSION_PURGE_GRACE_MS = 5 * 60 * 1000;
let lastCallCleanupAt = 0;

function normalizeCallId(value) {
  const token = String(value || '').trim();
  if (!token || !UUID_REGEX.test(token)) return null;
  return token.toLowerCase();
}

function normalizeCallStatus(value) {
  if (!value) return null;
  const token = String(value).trim().toLowerCase();
  if (CallStatusSet.has(token)) return token;
  return null;
}

function normalizeCallMode(value) {
  if (!value) return null;
  const token = String(value).trim().toLowerCase();
  if (CallModeSet.has(token)) return token;
  return null;
}

function normalizeCallEndReason(value) {
  if (!value) return null;
  const token = String(value).trim().toLowerCase();
  if (!token) return null;
  return token;
}

function normalizeTimestampMs(value) {
  if (value === null || value === undefined) return null;
  let num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (Math.abs(num) < 1e11) {
    num = Math.round(num * 1000);
  } else {
    num = Math.round(num);
  }
  return num;
}

function normalizePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...value };
}

function resolveCapabilities(existingJson, incoming) {
  if (incoming === undefined) {
    return normalizePlainObject(safeJSON(existingJson));
  }
  if (incoming === null) return null;
  return normalizePlainObject(incoming) || null;
}

function resolveMergableJson(existingJson, incoming) {
  const base = normalizePlainObject(safeJSON(existingJson));
  if (incoming === undefined) {
    return base;
  }
  if (incoming === null) {
    return null;
  }
  const patch = normalizePlainObject(incoming);
  if (!patch) return base;
  const merged = { ...(base || {}) };
  for (const [key, val] of Object.entries(patch)) {
    merged[key] = val;
  }
  return merged;
}

function jsonStringOrNull(obj) {
  if (obj === null || obj === undefined) return null;
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

async function upsertCallSession(env, payload = {}) {
  await ensureDataTables(env);
  const callId = normalizeCallId(payload.callId || payload.call_id);
  if (!callId) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'callId required' };
  }
  const rows = await env.DB.prepare(`SELECT * FROM call_sessions WHERE call_id=?1`).bind(callId).all();
  const existing = rows?.results?.[0] || null;
  const status = normalizeCallStatus(payload.status) || existing?.status || 'dialing';
  const mode = normalizeCallMode(payload.mode) || existing?.mode || 'voice';
  let callerDigest = normalizeAccountDigest(payload.callerAccountDigest || payload.caller_account_digest) || existing?.caller_account_digest || null;
  let calleeDigest = normalizeAccountDigest(payload.calleeAccountDigest || payload.callee_account_digest) || existing?.callee_account_digest || null;
  if (!callerDigest || !calleeDigest) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'callerAccountDigest and calleeAccountDigest required' };
  }
  const now = Date.now();
  const createdAt = existing?.created_at ? Number(existing.created_at) : now;
  const updatedAt = normalizeTimestampMs(payload.updatedAt || payload.updated_at) || now;
  const expiresAt = normalizeTimestampMs(payload.expiresAt || payload.expires_at) || existing?.expires_at || (now + 90_000);
  const connectedAtInput = normalizeTimestampMs(payload.connectedAt || payload.connected_at);
  const connectedAt = connectedAtInput ?? (existing && Number.isFinite(existing.connected_at) ? Number(existing.connected_at) : null);
  const endedAtInput = normalizeTimestampMs(payload.endedAt || payload.ended_at);
  const endedAt = endedAtInput ?? (existing && Number.isFinite(existing.ended_at) ? Number(existing.ended_at) : null);
  const endReason = normalizeCallEndReason(payload.endReason || payload.end_reason) || existing?.end_reason || null;
  const capabilitiesObj = resolveCapabilities(existing?.capabilities_json, payload.capabilities);
  const metadataObj = resolveMergableJson(existing?.metadata_json, payload.metadata);
  const metricsObj = resolveMergableJson(existing?.metrics_json, payload.metrics);
  const lastEvent = payload.lastEvent || payload.last_event || existing?.last_event || null;

  await env.DB.prepare(`
    INSERT INTO call_sessions (
      call_id, caller_uid, callee_uid,
      caller_account_digest, callee_account_digest,
      status, mode,
      capabilities_json, metadata_json, metrics_json,
      created_at, updated_at, connected_at, ended_at, end_reason, expires_at, last_event
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
    ON CONFLICT(call_id) DO UPDATE SET
      caller_uid=excluded.caller_uid,
      callee_uid=excluded.callee_uid,
      caller_account_digest=excluded.caller_account_digest,
      callee_account_digest=excluded.callee_account_digest,
      status=excluded.status,
      mode=excluded.mode,
      capabilities_json=excluded.capabilities_json,
      metadata_json=excluded.metadata_json,
      metrics_json=excluded.metrics_json,
      updated_at=excluded.updated_at,
      connected_at=excluded.connected_at,
      ended_at=excluded.ended_at,
      end_reason=excluded.end_reason,
      expires_at=excluded.expires_at,
      last_event=excluded.last_event,
      created_at=call_sessions.created_at
  `).bind(
    callId,
    callerDigest,
    calleeDigest,
    callerDigest,
    calleeDigest,
    status,
    mode,
    jsonStringOrNull(capabilitiesObj),
    jsonStringOrNull(metadataObj),
    jsonStringOrNull(metricsObj),
    createdAt,
    updatedAt,
    connectedAt,
    endedAt,
    endReason,
    expiresAt,
    lastEvent
  ).run();

  const latest = await env.DB.prepare(`SELECT * FROM call_sessions WHERE call_id=?1`).bind(callId).all();
  const row = latest?.results?.[0];
  if (!row) {
    return { ok: false, status: 500, error: 'UpsertFailed', message: 'call session missing after upsert' };
  }
  return { ok: true, session: serializeCallSessionRow(row) };
}

async function insertCallEvent(env, payload = {}) {
  await ensureDataTables(env);
  const callId = normalizeCallId(payload.callId || payload.call_id);
  if (!callId) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'callId required' };
  }
  const type = String(payload.type || '').trim();
  if (!type) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'type required' };
  }
  const sessionRows = await env.DB.prepare(`SELECT call_id FROM call_sessions WHERE call_id=?1`).bind(callId).all();
  if (!sessionRows?.results?.length) {
    return { ok: false, status: 404, error: 'NotFound', message: 'call session not found' };
  }
  const eventId = String(payload.eventId || payload.event_id || crypto.randomUUID());
  const createdAt = normalizeTimestampMs(payload.createdAt || payload.created_at) || Date.now();
  const fromAccountDigestInput = normalizeAccountDigest(payload.fromAccountDigest || payload.from_account_digest);
  const toAccountDigestInput = normalizeAccountDigest(payload.toAccountDigest || payload.to_account_digest);
  const traceId = payload.traceId ? String(payload.traceId).trim() : null;
  const eventPayload = payload.payload === undefined ? null : payload.payload;
  const payloadJson = eventPayload === null ? null : jsonStringOrNull(eventPayload);
  let fromAccountDigest = fromAccountDigestInput || null;
  let toAccountDigest = toAccountDigestInput || null;
  if (!fromAccountDigest || !toAccountDigest) {
    try {
      const sessionRow = await env.DB.prepare(
        `SELECT caller_account_digest, callee_account_digest FROM call_sessions WHERE call_id=?1`
      ).bind(callId).all();
      const row = sessionRow?.results?.[0] || null;
      if (!fromAccountDigest && row?.caller_account_digest) fromAccountDigest = normalizeAccountDigest(row.caller_account_digest);
      if (!toAccountDigest && row?.callee_account_digest) toAccountDigest = normalizeAccountDigest(row.callee_account_digest);
    } catch (err) {
      console.warn('call_session_lookup_for_event_failed', err?.message || err);
    }
  }

  if (!fromAccountDigest || !toAccountDigest) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'fromAccountDigest and toAccountDigest required' };
  }

  await env.DB.prepare(`
    INSERT INTO call_events (event_id, call_id, type, payload_json, from_account_digest, to_account_digest, trace_id, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `).bind(
    eventId,
    callId,
    type,
    payloadJson,
    fromAccountDigest,
    toAccountDigest,
    traceId,
    createdAt
  ).run();
  await env.DB.prepare(
    `UPDATE call_sessions SET last_event=?2, updated_at=?3 WHERE call_id=?1`
  ).bind(callId, type, createdAt).run();
  return {
    ok: true,
    event: {
      event_id: eventId,
      call_id: callId,
      type,
      payload: eventPayload,
      from_account_digest: fromAccountDigest || null,
      to_account_digest: toAccountDigest || null,
      trace_id: traceId || null,
      created_at: createdAt
    }
  };
}

function serializeCallSessionRow(row) {
  if (!row) return null;
  return {
    call_id: row.call_id,
    caller_account_digest: row.caller_account_digest || null,
    callee_account_digest: row.callee_account_digest || null,
    status: row.status,
    mode: row.mode,
    capabilities: normalizePlainObject(safeJSON(row.capabilities_json)),
    metadata: normalizePlainObject(safeJSON(row.metadata_json)),
    metrics: normalizePlainObject(safeJSON(row.metrics_json)),
    created_at: Number(row.created_at) || null,
    updated_at: Number(row.updated_at) || null,
    connected_at: row.connected_at != null ? Number(row.connected_at) : null,
    ended_at: row.ended_at != null ? Number(row.ended_at) : null,
    end_reason: row.end_reason || null,
    expires_at: Number(row.expires_at) || null,
    last_event: row.last_event || null
  };
}

async function cleanupCallTables(env) {
  const now = Date.now();
  if (now - lastCallCleanupAt < 60_000) return;
  lastCallCleanupAt = now;
  await ensureDataTables(env);
  const eventExpiry = now - CALL_EVENT_TTL_MS;
  const sessionExpiry = now - CALL_SESSION_PURGE_GRACE_MS;
  try {
    await env.DB.prepare(`DELETE FROM call_events WHERE created_at < ?1`).bind(eventExpiry).run();
  } catch (err) {
    console.warn('call_events_cleanup_failed', err?.message || err);
  }
  try {
    await env.DB.prepare(
      `DELETE FROM call_sessions
        WHERE expires_at < ?1
          AND status IN ('ended','failed','cancelled','timeout')`
    ).bind(sessionExpiry).run();
  } catch (err) {
    console.warn('call_sessions_cleanup_failed', err?.message || err);
  }
}

async function getAccountHmacCryptoKey(env) {
  const keyHex = String(env.ACCOUNT_HMAC_KEY || '').trim();
  if (!/^[0-9A-Fa-f]{64}$/.test(keyHex)) {
    throw new Error('ACCOUNT_HMAC_KEY missing or invalid (expect 64 hex chars)');
  }
  if (getAccountHmacCryptoKey._cacheHex === keyHex && getAccountHmacCryptoKey._cacheKey) {
    return getAccountHmacCryptoKey._cacheKey;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(hexToBytes(keyHex), 'data-worker/src/worker.js:864:getAccountHmacCryptoKey'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  getAccountHmacCryptoKey._cacheHex = keyHex;
  getAccountHmacCryptoKey._cacheKey = key;
  return key;
}

async function hashUidToDigest(env, uidHex) {
  const normalized = normalizeUid(uidHex);
  if (!normalized) {
    throw new Error('hashUidToDigest: invalid uid');
  }
  const key = await getAccountHmacCryptoKey(env);
  const mac = await crypto.subtle.sign('HMAC', key, textEncoder.encode(normalized));
  return bytesToHex(new Uint8Array(mac));
}

function accountTokenLength(env) {
  const n = Number.parseInt(env.ACCOUNT_TOKEN_BYTES || '32', 10);
  if (Number.isFinite(n) && n > 0 && n <= 64) return n;
  return 32;
}

function generateAccountToken(env) {
  const raw = new Uint8Array(accountTokenLength(env));
  crypto.getRandomValues(raw);
  return bytesToBase64Url(raw);
}

async function digestAccountToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(token || '')));
  return bytesToHex(new Uint8Array(digest));
}

async function resolveAccount(env, { uidHex, accountToken, accountDigest } = {}, { allowCreate = false, preferredAccountToken = null, preferredAccountDigest = null } = {}) {
  const db = env.DB;
  const normalizedUid = uidHex ? normalizeUid(uidHex) : null;
  const normalizedAccountDigest = normalizeAccountDigest(preferredAccountDigest || accountDigest);
  const tokenInput = preferredAccountToken ?? accountToken;
  const normalizedToken = typeof tokenInput === 'string' && tokenInput.trim().length ? tokenInput.trim() : null;
  const uidDigest = normalizedUid ? await hashUidToDigest(env, normalizedUid) : null;

  let lookupDigest = normalizedAccountDigest || null;
  if (!lookupDigest && normalizedToken) {
    lookupDigest = await digestAccountToken(normalizedToken);
  }

  let accountRow = null;
  if (lookupDigest) {
    const rows = await db.prepare(
      `SELECT account_digest, account_token, uid_digest, last_ctr, wrapped_mk_json, brand, brand_name, brand_logo
         FROM accounts
        WHERE account_digest=?1`
    ).bind(lookupDigest).all();
    accountRow = rows?.results?.[0] || null;
  }

  if (!accountRow && uidDigest) {
    const rows = await db.prepare(
      `SELECT account_digest, account_token, uid_digest, last_ctr, wrapped_mk_json, brand, brand_name, brand_logo
         FROM accounts
        WHERE uid_digest=?1`
    ).bind(uidDigest).all();
    accountRow = rows?.results?.[0] || null;
  }

  if (accountRow) {
    if (normalizedToken && accountRow.account_token !== normalizedToken) {
      return null;
    }
    return {
      account_digest: accountRow.account_digest,
      account_token: accountRow.account_token,
      uid_digest: accountRow.uid_digest,
      last_ctr: Number(accountRow.last_ctr || 0),
      wrapped_mk_json: accountRow.wrapped_mk_json,
      brand: accountRow.brand || null,
      brand_name: accountRow.brand_name || null,
      brand_logo: accountRow.brand_logo || null,
      newly_created: false
    };
  }

  if (!allowCreate) {
    return null;
  }

  let acctToken = normalizedToken || null;
  let acctDigest = normalizedAccountDigest || null;

  if (acctToken && !acctDigest) {
    acctDigest = await digestAccountToken(acctToken);
  }
  if (!acctToken) {
    acctToken = generateAccountToken(env);
  }
  if (!acctDigest) {
    acctDigest = await digestAccountToken(acctToken);
  }

  let acctUidDigest = uidDigest || null;
  if (!acctUidDigest) {
    acctUidDigest = acctDigest;
  }

  if (!acctDigest || !acctUidDigest) {
    throw new Error('resolveAccount: account identity required to create account');
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    await db.prepare(
      `INSERT INTO accounts (account_digest, account_token, uid_digest, last_ctr, created_at, updated_at)
       VALUES (?1, ?2, ?3, 0, ?4, ?4)`
    ).bind(acctDigest, acctToken, acctUidDigest, now).run();
    return {
      account_digest: acctDigest,
      account_token: acctToken,
      uid_digest: acctUidDigest,
      last_ctr: 0,
      wrapped_mk_json: null,
      brand: null,
      brand_name: null,
      brand_logo: null,
      newly_created: true
    };
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('UNIQUE constraint failed')) {
      const rows = await db.prepare(
        `SELECT account_digest, account_token, uid_digest, last_ctr, wrapped_mk_json, brand, brand_name, brand_logo
           FROM accounts
          WHERE account_digest=?1 OR uid_digest=?2`
      ).bind(acctDigest, acctUidDigest).all();
      const row = rows?.results?.[0];
      if (row) {
        return {
          account_digest: row.account_digest,
          account_token: row.account_token,
          uid_digest: row.uid_digest,
          last_ctr: Number(row.last_ctr || 0),
          wrapped_mk_json: row.wrapped_mk_json,
          brand: row.brand || null,
          brand_name: row.brand_name || null,
          brand_logo: row.brand_logo || null,
          newly_created: false
        };
      }
    }
    throw err;
  }
}

async function ensureDataTables(env) {
  if (dataTablesReady) return;
  const requiredTables = [
    'accounts',
    'devices',
    'device_signed_prekeys',
    'device_opks',
    'prekey_users',
    'prekey_opk',
    'conversations',
    'conversation_acl',
    'messages_secure',
    'message_key_vault',
    'attachments',
    // 'messages', // Legacy table, optional
    'media_objects',
    'opaque_records',
    'device_backup',
    'invite_dropbox',
    'call_sessions',
    'call_events',
    'contact_secret_backups',
    'groups',
    'group_members',
    'group_invites',
    'subscriptions',
    'tokens',
    'extend_logs'
  ];
  try {
    const tableRows = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
    const tableNames = new Set((tableRows?.results || []).map((row) => row.name));
    const missingTables = requiredTables.filter((name) => !tableNames.has(name));
    const missingColumns = [];
    try {
      await env.DB.prepare(`SELECT wrapped_mk_json FROM accounts LIMIT 0`).all();
    } catch {
      missingColumns.push('accounts.wrapped_mk_json');
    }
    try {
      await env.DB.prepare(`SELECT updated_at FROM invite_dropbox LIMIT 0`).all();
    } catch {
      missingColumns.push('invite_dropbox.updated_at');
    }
    try {
      await env.DB.prepare(`SELECT dr_state_snapshot FROM message_key_vault LIMIT 0`).all();
    } catch {
      missingColumns.push('message_key_vault.dr_state_snapshot');
    }
    // Auto-add min_ts column to deletion_cursors (timestamp-based filtering)
    try {
      await env.DB.prepare(`SELECT min_ts FROM deletion_cursors LIMIT 0`).all();
    } catch {
      try {
        await env.DB.prepare(`ALTER TABLE deletion_cursors ADD COLUMN min_ts REAL NOT NULL DEFAULT 0`).run();
        console.log('ensureDataTables: added min_ts column to deletion_cursors');
      } catch (alterErr) {
        console.warn('ensureDataTables: min_ts column add failed (may already exist)', alterErr?.message);
      }
    }
    // [FIX] Repair any deletion_cursors rows where min_ts was stored in
    // milliseconds instead of seconds.  A ms value (>1e11) makes the SQL
    // filter `created_at_sec > min_ts_ms` always false, permanently hiding
    // all messages.  This is a one-time idempotent repair.
    try {
      const repaired = await env.DB.prepare(`
        UPDATE deletion_cursors SET min_ts = min_ts / 1000.0 WHERE min_ts > 100000000000
      `).run();
      if (repaired?.changes > 0) {
        console.log('ensureDataTables: repaired', repaired.changes, 'deletion_cursors rows (ms→s)');
      }
    } catch (repairErr) {
      console.warn('ensureDataTables: deletion_cursors ms repair failed', repairErr?.message);
    }
    // Auto-add brand column to accounts (multi-brand support)
    try {
      await env.DB.prepare(`SELECT brand FROM accounts LIMIT 0`).all();
    } catch {
      try {
        await env.DB.prepare(`ALTER TABLE accounts ADD COLUMN brand TEXT`).run();
        console.log('ensureDataTables: added brand column to accounts');
      } catch (alterErr) {
        console.warn('ensureDataTables: brand column add failed (may already exist)', alterErr?.message);
      }
    }
    // Auto-add brand_name + brand_logo columns to accounts (white-label display metadata)
    try {
      await env.DB.prepare(`SELECT brand_name FROM accounts LIMIT 0`).all();
    } catch {
      try {
        await env.DB.prepare(`ALTER TABLE accounts ADD COLUMN brand_name TEXT`).run();
        await env.DB.prepare(`ALTER TABLE accounts ADD COLUMN brand_logo TEXT`).run();
        console.log('ensureDataTables: added brand_name + brand_logo columns to accounts');
      } catch (alterErr) {
        console.warn('ensureDataTables: brand_name/brand_logo columns add failed (may already exist)', alterErr?.message);
      }
    }
    // Auto-add pairing_code + prekey_bundle_json columns to invite_dropbox
    try {
      await env.DB.prepare(`SELECT pairing_code FROM invite_dropbox LIMIT 0`).all();
    } catch {
      try {
        await env.DB.prepare(`ALTER TABLE invite_dropbox ADD COLUMN pairing_code TEXT`).run();
        await env.DB.prepare(`ALTER TABLE invite_dropbox ADD COLUMN prekey_bundle_json TEXT`).run();
        await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_dropbox_pairing_code ON invite_dropbox(pairing_code) WHERE pairing_code IS NOT NULL AND status = 'CREATED'`).run();
        console.log('ensureDataTables: added pairing_code + prekey_bundle_json columns to invite_dropbox');
      } catch (alterErr) {
        console.warn('ensureDataTables: pairing_code columns add failed (may already exist)', alterErr?.message);
      }
    }
    // Auto-create ephemeral_invites + ephemeral_sessions tables (migration 0010)
    if (!tableNames.has('ephemeral_invites')) {
      try {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ephemeral_invites (
          token TEXT PRIMARY KEY, owner_digest TEXT NOT NULL, owner_device_id TEXT NOT NULL,
          prekey_bundle_json TEXT NOT NULL, consumed_at INTEGER, expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          FOREIGN KEY (owner_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE)`).run();
        await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ephemeral_invites_owner ON ephemeral_invites(owner_digest)`).run();
        await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ephemeral_invites_expires ON ephemeral_invites(expires_at)`).run();
        console.log('ensureDataTables: created ephemeral_invites table');
      } catch (e) { console.warn('ensureDataTables: ephemeral_invites create failed', e?.message); }
    }
    if (!tableNames.has('ephemeral_sessions')) {
      try {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ephemeral_sessions (
          session_id TEXT PRIMARY KEY, invite_token TEXT NOT NULL, owner_digest TEXT NOT NULL,
          owner_device_id TEXT NOT NULL, guest_digest TEXT NOT NULL, guest_device_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL, expires_at INTEGER NOT NULL, extended_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), deleted_at INTEGER,
          FOREIGN KEY (owner_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE)`).run();
        // Add pending_key_exchange_json column (safe to re-run — ALTER TABLE IF NOT EXISTS is not SQL standard, so we swallow the error)
        await env.DB.prepare(`ALTER TABLE ephemeral_sessions ADD COLUMN pending_key_exchange_json TEXT`).run().catch(() => {});
        await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_owner ON ephemeral_sessions(owner_digest, deleted_at)`).run();
        await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_guest ON ephemeral_sessions(guest_digest)`).run();
        await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_conv ON ephemeral_sessions(conversation_id)`).run();
        await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_expires ON ephemeral_sessions(expires_at)`).run();
        console.log('ensureDataTables: created ephemeral_sessions table');
      } catch (e) { console.warn('ensureDataTables: ephemeral_sessions create failed', e?.message); }
    }
    if (missingTables.length || missingColumns.length) {
      const detail = [
        ...missingTables.map((name) => `table:${name}`),
        ...missingColumns.map((name) => `column:${name}`)
      ];
      const message = `D1 schema missing (${detail.join(', ') || 'none'}); run migrations (including 0026_invite_dropbox.sql and latest schema drops).`;
      console.error(message);
      throw new Error(message);
    }
    dataTablesReady = true;
  } catch (err) {
    console.error('ensureDataTables schema check failed', err);
    throw err;
  }
}

// ---- Tags / SDM / OPAQUE 路由（先搬）----
async function handleTagsRoutes(req, env) {
  const url = new URL(req.url);

  // 交換：建立 / 更新 account、檢查 counter、回傳 MK 包裝資訊
  if (req.method === 'POST' && url.pathname === '/d1/tags/exchange') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const uidHex = normalizeUid(body.uidHex || body.uid);
    const accountTokenRaw = body.accountToken || body.account_token;
    const accountDigest = normalizeAccountDigest(body.accountDigest || body.account_digest);
    const accountToken = typeof accountTokenRaw === 'string' && accountTokenRaw.trim().length ? accountTokenRaw.trim() : null;
    if (!uidHex && !accountDigest && !accountToken) {
      return json({ error: 'BadRequest', message: 'accountDigest/accountToken or uidHex required' }, { status: 400 });
    }
    const ctrNum = Number(body.ctr ?? body.counter ?? body.sdmcounter ?? 0);
    if (!Number.isFinite(ctrNum) || ctrNum < 0) {
      return json({ error: 'BadRequest', message: 'ctr must be a non-negative number' }, { status: 400 });
    }

    let account;
    try {
      account = await resolveAccount(
        env,
        { uidHex, accountToken, accountDigest },
        { allowCreate: true, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest }
      );
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }

    if (!account) {
      const errCode = uidHex ? 'AccountCreateFailed' : 'AccountNotFound';
      return json({ error: errCode }, { status: uidHex ? 500 : 404 });
    }

    if (!account.newlyCreated && !(ctrNum > account.last_ctr)) {
      return json({ error: 'Replay', message: 'counter must be strictly increasing', lastCtr: account.last_ctr }, { status: 409 });
    }

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `UPDATE accounts
          SET last_ctr=?2,
              updated_at=?3
        WHERE account_digest=?1`
    ).bind(account.account_digest, ctrNum, now).run();

    const hasMK = !!account.wrapped_mk_json;
    let wrapped;
    if (hasMK) {
      try {
        wrapped = JSON.parse(account.wrapped_mk_json);
      } catch {
        wrapped = null;
      }
    }

    return json({
      has_mk: hasMK,
      wrapped_mk: wrapped || undefined,
      account_token: account.account_token,
      account_digest: account.account_digest,
      uid_digest: account.uid_digest,
      newly_created: account.newlyCreated,
      brand: account.brand || undefined,
      brand_name: account.brand_name || undefined,
      brand_logo: account.brand_logo || undefined
    });
  }

  // 首次設定：儲存 wrapped_mk
  if (req.method === 'POST' && url.pathname === '/d1/tags/store-mk') {
    const cfRay = req.headers.get('cf-ray') || null;
    const makeError = (status, payload) => json({ cfRay, ...payload }, { status });
    try {
      let body;
      try {
        body = await req.json();
      } catch {
        return makeError(400, { error: 'BadRequest', code: 'JSON_PARSE_ERROR', message: 'invalid json' });
      }
      const accountDigest = normalizeAccountDigest(body.accountDigest || body.account_digest);
      const accountToken = typeof body.accountToken === 'string' ? body.accountToken : (typeof body.account_token === 'string' ? body.account_token : null);
      if (!accountDigest || !accountToken) {
        return makeError(400, { error: 'BadRequest', code: 'VALIDATION_ERROR', message: 'accountDigest & accountToken required' });
      }
      if (!body.wrapped_mk) {
        return makeError(400, { error: 'BadRequest', code: 'VALIDATION_ERROR', message: 'wrapped_mk required' });
      }
      await ensureDataTables(env);
      // 確認帳號存在且 token 匹配
      const acct = await resolveAccount(env, { accountDigest, accountToken }, { allowCreate: false });
      if (!acct) {
        return makeError(401, { error: 'Unauthorized', code: 'HMAC_INVALID', message: 'account token mismatch' });
      }
      try {
        await env.DB.prepare(
          `UPDATE accounts SET wrapped_mk_json=?2, updated_at=strftime('%s','now')
             WHERE account_digest=?1`
        ).bind(accountDigest, JSON.stringify(body.wrapped_mk)).run();
      } catch (err) {
        const msg = String(err?.message || '').slice(0, 200);
        return makeError(500, { error: 'StoreMkFailed', code: 'D1_ERROR', message: msg });
      }
      return new Response(null, { status: 204 });
    } catch (err) {
      const msg = String(err?.message || '').slice(0, 200);
      return makeError(500, { error: 'StoreMkFailed', code: 'UNKNOWN', message: msg });
    }
  }

  // 讀取裝置私鑰密文備份（wrapped_device_keys）
  if (req.method === 'POST' && url.pathname === '/d1/devkeys/fetch') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken: body.accountToken,
        accountDigest: body.accountDigest || body.account_digest
      });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }

    if (!account) {
      return json({ error: 'NotFound' }, { status: 404 });
    }

    const sel = await env.DB.prepare(
      `SELECT wrapped_dev_json FROM device_backup WHERE account_digest=?1`
    ).bind(account.account_digest).all();

    if (!sel.results || sel.results.length === 0) {
      return json({ error: 'NotFound' }, { status: 404 });
    }
    const wrapped = JSON.parse(sel.results[0].wrapped_dev_json);
    return json({ wrapped_dev: wrapped });
  }

  // 儲存裝置私鑰密文備份（wrapped_device_keys）
  if (req.method === 'POST' && url.pathname === '/d1/devkeys/store') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 }); }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken: body.accountToken,
        accountDigest: body.accountDigest || body.account_digest
      });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }

    if (!account) {
      return json({ error: 'NotFound' }, { status: 404 });
    }

    if (!body.wrapped_dev) {
      return json({ error: 'BadRequest', message: 'wrapped_dev required' }, { status: 400 });
    }
    await ensureDataTables(env);
    // Use upsert to avoid race condition
    await env.DB.prepare(
      `INSERT INTO device_backup (account_digest, wrapped_dev_json, created_at, updated_at)
       VALUES (?1, ?2, strftime('%s','now'), strftime('%s','now'))
       ON CONFLICT(account_digest) DO UPDATE SET
         wrapped_dev_json=excluded.wrapped_dev_json,
         updated_at=strftime('%s','now')`
    ).bind(account.account_digest, JSON.stringify(body.wrapped_dev)).run();

    return new Response(null, { status: 204 });
  }

  // OPAQUE: store registration record
  if (req.method === 'POST' && url.pathname === '/d1/opaque/store') {
    let body; try { body = await req.json(); } catch { return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 }); }
    const acct = String(body?.accountDigest || body?.account_digest || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const record_b64 = typeof body?.record_b64 === 'string' ? body.record_b64.trim() : '';
    const client_identity = typeof body?.client_identity === 'string' ? body.client_identity : null;
    if (!acct || acct.length !== 64 || !record_b64) {
      return json({ error: 'BadRequest', message: 'accountDigest(64 hex) and record_b64 required' }, { status: 400 });
    }
    await env.DB.prepare(
      `INSERT INTO opaque_records (account_digest, record_b64, client_identity)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(account_digest) DO UPDATE SET record_b64=excluded.record_b64, client_identity=excluded.client_identity, updated_at=strftime('%s','now')`
    ).bind(acct, record_b64, client_identity).run();
    return new Response(null, { status: 204 });
  }

  // OPAQUE: fetch registration record
  if (req.method === 'POST' && url.pathname === '/d1/opaque/fetch') {
    let body; try { body = await req.json(); } catch { return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 }); }
    const acct = String(body?.accountDigest || body?.account_digest || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (!acct || acct.length !== 64) {
      return json({ error: 'BadRequest', message: 'accountDigest(64 hex) required' }, { status: 400 });
    }
    const rs = await env.DB.prepare(`SELECT record_b64, client_identity FROM opaque_records WHERE account_digest=?1`).bind(acct).all();
    const row = rs?.results?.[0];
    if (!row) return json({ error: 'NotFound' }, { status: 404 });
    return json({ account_digest: acct, record_b64: row.record_b64, client_identity: row.client_identity || null });
  }

  return null;
}

async function markInviteExpired(env, inviteId, nowSec) {
  if (!inviteId) return;
  await env.DB.prepare(
    `UPDATE invite_dropbox
        SET status='EXPIRED',
            updated_at=?2
      WHERE invite_id=?1 AND status IN ('CREATED', 'DELIVERED')`
  ).bind(inviteId, nowSec).run();
}

async function handleInviteDropboxRoutes(req, env) {
  const url = new URL(req.url);

  // Create invite dropbox (owner)
  if (req.method === 'POST' && url.pathname === '/d1/invites/create') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const inviteId = String(body?.inviteId || '').trim();
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    const ownerDeviceId = normalizeDeviceId(body?.deviceId);
    if (!inviteId || inviteId.length < 8) {
      return json({ error: 'BadRequest', message: 'inviteId required' }, { status: 400 });
    }
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }
    if (!ownerDeviceId) {
      return json({ error: 'BadRequest', message: 'deviceId required' }, { status: 400 });
    }

    const existing = await env.DB.prepare(
      `SELECT invite_id FROM invite_dropbox WHERE invite_id=?1`
    ).bind(inviteId).first();
    if (existing) {
      return json({ error: 'InviteAlreadyExists' }, { status: 409 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    const now = Math.floor(Date.now() / 1000);
    const wantPairingCode = !!(body?.wantPairingCode);
    const expiresAt = now + (wantPairingCode ? 180 : 300);
    const ownerBundle = await allocateOwnerPrekeyBundle(env, account.account_digest, ownerDeviceId);
    if (!ownerBundle) {
      return json({ error: 'PrekeyUnavailable', message: 'owner prekey bundle unavailable' }, { status: 409 });
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'ownerPublicKey')) {
      return json({ error: 'BadRequest', code: 'InviteSchemaMismatch', message: 'ownerPublicKey not allowed' }, { status: 400 });
    }
    const ownerPublicKeyInput = String(body?.ownerPublicKeyB64 || '').trim();
    const ownerPublicKeyB64 = ownerPublicKeyInput || String(ownerBundle.spk_pub || '').trim();
    if (!ownerPublicKeyB64) {
      return json({ error: 'BadRequest', code: 'InviteSchemaInvalid', message: 'ownerPublicKeyB64 required' }, { status: 400 });
    }
    if (ownerPublicKeyInput && ownerBundle.spk_pub && ownerPublicKeyInput !== ownerBundle.spk_pub) {
      return json({ error: 'OwnerPublicKeyMismatch', message: 'ownerPublicKeyB64 mismatch' }, { status: 400 });
    }

    const prekeyBundle = ownerBundle
      ? {
        ikPubB64: String(ownerBundle.ik_pub || '').trim(),
        spkPubB64: String(ownerBundle.spk_pub || '').trim(),
        signatureB64: String(ownerBundle.spk_sig || '').trim(),
        opkId: ownerBundle.opk?.id ?? null,
        opkPubB64: String(ownerBundle.opk?.pub || '').trim() || null
      }
      : null;

    // Generate 6-digit pairing code if requested
    let pairingCode = null;
    if (wantPairingCode) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
        const collision = await env.DB.prepare(
          `SELECT 1 FROM invite_dropbox WHERE pairing_code=?1 AND status='CREATED' AND expires_at>?2 LIMIT 1`
        ).bind(candidate, now).first();
        if (!collision) { pairingCode = candidate; break; }
      }
      if (!pairingCode) {
        return json({ error: 'PairingCodeUnavailable', message: 'could not generate unique pairing code' }, { status: 503 });
      }
    }

    await env.DB.prepare(
      `INSERT INTO invite_dropbox (
          invite_id, owner_account_digest, owner_device_id,
          owner_public_key_b64, expires_at, status, pairing_code, prekey_bundle_json,
          created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'CREATED', ?6, ?7, ?8, ?9)`
    ).bind(
      inviteId,
      account.account_digest,
      ownerDeviceId,
      ownerPublicKeyB64,
      expiresAt,
      pairingCode,
      prekeyBundle ? JSON.stringify(prekeyBundle) : null,
      now,
      now
    ).run();

    const result = {
      ok: true,
      invite_id: inviteId,
      expires_at: expiresAt,
      owner_account_digest: account.account_digest,
      owner_device_id: ownerDeviceId,
      owner_public_key_b64: ownerPublicKeyB64,
      prekey_bundle: prekeyBundle
    };
    if (pairingCode) result.pairing_code = pairingCode;
    return json(result);
  }

  // Lookup invite by 6-digit pairing code (guest)
  if (req.method === 'POST' && url.pathname === '/d1/invites/lookup-code') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const pairingCode = String(body?.pairingCode || '').trim();
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    if (!pairingCode || !/^\d{6}$/.test(pairingCode)) {
      return json({ error: 'BadRequest', message: 'pairingCode must be 6 digits' }, { status: 400 });
    }
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    // Rate limit: 3 failed attempts → 30s lockout (in-memory per worker instance)
    const rlKey = account.account_digest;
    const rlEntry = _pairingCodeRateLimit.get(rlKey);
    const now = Math.floor(Date.now() / 1000);
    if (rlEntry && rlEntry.lockedUntil > now) {
      return json({ error: 'RateLimited', message: 'too many attempts, try again later', retry_after: rlEntry.lockedUntil - now }, { status: 429 });
    }

    const row = await env.DB.prepare(
      `SELECT invite_id, owner_account_digest, owner_device_id, owner_public_key_b64,
              expires_at, prekey_bundle_json
         FROM invite_dropbox
        WHERE pairing_code=?1 AND status='CREATED' AND expires_at>?2
        LIMIT 1`
    ).bind(pairingCode, now).first();

    if (!row) {
      // Increment failed attempts
      const attempts = (rlEntry?.attempts || 0) + 1;
      if (attempts >= 3) {
        _pairingCodeRateLimit.set(rlKey, { attempts, lockedUntil: now + 30 });
      } else {
        _pairingCodeRateLimit.set(rlKey, { attempts, lockedUntil: 0 });
      }
      return json({ error: 'NotFound', message: 'pairing code not found or expired' }, { status: 404 });
    }

    // Prevent looking up own invite
    if (row.owner_account_digest === account.account_digest) {
      return json({ error: 'BadRequest', message: 'cannot lookup own pairing code' }, { status: 400 });
    }

    // Success: reset rate limit
    _pairingCodeRateLimit.delete(rlKey);

    let prekeyBundle = null;
    if (row.prekey_bundle_json) {
      try { prekeyBundle = JSON.parse(row.prekey_bundle_json); } catch { /* ignore */ }
    }

    return json({
      ok: true,
      invite_id: row.invite_id,
      expires_at: Number(row.expires_at),
      owner_account_digest: row.owner_account_digest,
      owner_device_id: row.owner_device_id,
      owner_public_key_b64: row.owner_public_key_b64,
      prekey_bundle: prekeyBundle
    });
  }

  // Deliver invite payload (guest)
  if (req.method === 'POST' && url.pathname === '/d1/invites/deliver') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const aliasKey = findAliasKey(body, INVITE_DELIVER_ALIAS_FIELDS);
    if (aliasKey) return inviteAliasError(aliasKey);
    const unexpectedKey = findUnexpectedKey(body, INVITE_DELIVER_ALLOWED_FIELDS);
    if (unexpectedKey) return inviteUnexpectedFieldError(unexpectedKey);
    const inviteId = String(body?.inviteId || '').trim();
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    const senderDeviceId = normalizeDeviceId(body?.deviceId);
    const envelope = normalizeInviteDropboxEnvelope(body?.ciphertextEnvelope);
    if (!inviteId || inviteId.length < 8) {
      return json({ error: 'BadRequest', message: 'inviteId required' }, { status: 400 });
    }
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }
    if (!senderDeviceId) {
      return json({ error: 'BadRequest', message: 'deviceId required' }, { status: 400 });
    }
    if (!envelope) {
      return json({ error: 'BadRequest', code: 'InviteEnvelopeInvalid', message: 'ciphertextEnvelope invalid' }, { status: 400 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    const row = await env.DB.prepare(
      `SELECT invite_id, owner_account_digest, owner_device_id, expires_at, status
         FROM invite_dropbox WHERE invite_id=?1`
    ).bind(inviteId).first();
    if (!row) return json({ error: 'NotFound' }, { status: 404 });
    const now = Math.floor(Date.now() / 1000);
    if (Number(row.expires_at) <= now) {
      await markInviteExpired(env, inviteId, now);
      return json({ error: 'Expired' }, { status: 410 });
    }
    if (envelope.expiresAt !== Number(row.expires_at)) {
      return json({ error: 'InviteExpiresMismatch', message: 'envelope expires mismatch' }, { status: 400 });
    }
    if (row.status !== 'CREATED') {
      return json({ error: 'InviteAlreadyDelivered' }, { status: 409 });
    }

    const upd = await env.DB.prepare(
      `UPDATE invite_dropbox
          SET status='DELIVERED',
              delivered_by_account_digest=?2,
              delivered_by_device_id=?3,
              delivered_at=?4,
              ciphertext_json=?5,
              updated_at=?6
        WHERE invite_id=?1 AND status='CREATED'`
    ).bind(
      inviteId,
      account.account_digest,
      senderDeviceId,
      now,
      JSON.stringify(envelope),
      now
    ).run();
    if (!upd || (upd.meta && upd.meta.changes === 0)) {
      return json({ error: 'InviteAlreadyDelivered' }, { status: 409 });
    }

    return json({
      ok: true,
      invite_id: inviteId,
      owner_account_digest: row.owner_account_digest,
      owner_device_id: row.owner_device_id,
      delivered_at: now
    });
  }

  // Consume invite payload (owner)
  if (req.method === 'POST' && url.pathname === '/d1/invites/consume') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const aliasKey = findAliasKey(body, INVITE_CONSUME_ALIAS_FIELDS);
    if (aliasKey) return inviteAliasError(aliasKey);
    const unexpectedKey = findUnexpectedKey(body, INVITE_CONSUME_ALLOWED_FIELDS);
    if (unexpectedKey) return inviteUnexpectedFieldError(unexpectedKey);
    const inviteId = String(body?.inviteId || '').trim();
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    if (!inviteId || inviteId.length < 8) {
      return json({ error: 'BadRequest', message: 'inviteId required' }, { status: 400 });
    }
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    const row = await env.DB.prepare(
      `SELECT invite_id, owner_account_digest, owner_device_id, expires_at, status, ciphertext_json
         FROM invite_dropbox WHERE invite_id=?1`
    ).bind(inviteId).first();
    if (!row) return json({ error: 'NotFound' }, { status: 404 });
    const now = Math.floor(Date.now() / 1000);
    if (Number(row.expires_at) <= now) {
      await markInviteExpired(env, inviteId, now);
      return json({ error: 'Expired' }, { status: 410 });
    }
    if (row.owner_account_digest !== account.account_digest) {
      return json({ error: 'Forbidden', message: 'invite owner mismatch' }, { status: 403 });
    }
    if (row.status === 'CONSUMED') {
      const envelope = safeJSON(row.ciphertext_json);
      if (!envelope) {
        return json({ error: 'PayloadMissing', message: 'ciphertext missing' }, { status: 500 });
      }
      return json({
        ok: true,
        invite_id: inviteId,
        owner_device_id: row.owner_device_id,
        expires_at: row.expires_at,
        ciphertext_envelope: envelope
      });
    }
    if (row.status !== 'DELIVERED') {
      return json({ error: 'NotFound' }, { status: 404 });
    }
    const envelope = safeJSON(row.ciphertext_json);
    if (!envelope) {
      return json({ error: 'PayloadMissing', message: 'ciphertext missing' }, { status: 500 });
    }

    const upd = await env.DB.prepare(
      `UPDATE invite_dropbox
          SET status='CONSUMED',
              consumed_at=?2,
              updated_at=?3
        WHERE invite_id=?1 AND status='DELIVERED'`
    ).bind(inviteId, now, now).run();
    if (!upd || (upd.meta && upd.meta.changes === 0)) {
      const retry = await env.DB.prepare(
        `SELECT status, ciphertext_json, owner_device_id, expires_at
           FROM invite_dropbox WHERE invite_id=?1`
      ).bind(inviteId).first();
      if (retry?.status === 'CONSUMED') {
        const retryEnvelope = safeJSON(retry.ciphertext_json);
        if (!retryEnvelope) {
          return json({ error: 'PayloadMissing', message: 'ciphertext missing' }, { status: 500 });
        }
        return json({
          ok: true,
          invite_id: inviteId,
          owner_device_id: retry.owner_device_id,
          expires_at: retry.expires_at,
          ciphertext_envelope: retryEnvelope
        });
      }
      return json({ error: 'NotFound' }, { status: 404 });
    }

    return json({
      ok: true,
      invite_id: inviteId,
      owner_device_id: row.owner_device_id,
      expires_at: row.expires_at,
      ciphertext_envelope: envelope
    });
  }

  // Confirm invite (owner marks consume as fully processed)
  if (req.method === 'POST' && url.pathname === '/d1/invites/confirm') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const aliasKey = findAliasKey(body, INVITE_CONFIRM_ALIAS_FIELDS);
    if (aliasKey) return inviteAliasError(aliasKey);
    const unexpectedKey = findUnexpectedKey(body, INVITE_CONFIRM_ALLOWED_FIELDS);
    if (unexpectedKey) return inviteUnexpectedFieldError(unexpectedKey);
    const inviteId = String(body?.inviteId || '').trim();
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    if (!inviteId || inviteId.length < 8) {
      return json({ error: 'BadRequest', message: 'inviteId required' }, { status: 400 });
    }
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    const row = await env.DB.prepare(
      `SELECT status, owner_account_digest FROM invite_dropbox WHERE invite_id=?1`
    ).bind(inviteId).first();
    if (!row) return json({ error: 'NotFound' }, { status: 404 });

    if (row.owner_account_digest !== account.account_digest) {
      return json({ error: 'Forbidden', message: 'invite access denied' }, { status: 403 });
    }

    if (row.status === 'CONFIRMED') {
      return json({ ok: true, invite_id: inviteId });
    }
    if (row.status !== 'CONSUMED') {
      return json({ error: 'BadRequest', message: 'invite not in CONSUMED state' }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `UPDATE invite_dropbox SET status='CONFIRMED', updated_at=?2 WHERE invite_id=?1 AND status='CONSUMED'`
    ).bind(inviteId, now).run();

    return json({ ok: true, invite_id: inviteId });
  }

  // List unconfirmed (CONSUMED but not CONFIRMED) invites for an account
  if (req.method === 'POST' && url.pathname === '/d1/invites/unconfirmed') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const aliasKey = findAliasKey(body, INVITE_UNCONFIRMED_ALIAS_FIELDS);
    if (aliasKey) return inviteAliasError(aliasKey);
    const unexpectedKey = findUnexpectedKey(body, INVITE_UNCONFIRMED_ALLOWED_FIELDS);
    if (unexpectedKey) return inviteUnexpectedFieldError(unexpectedKey);
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    const now = Math.floor(Date.now() / 1000);
    const rows = await env.DB.prepare(
      `SELECT invite_id, owner_device_id, expires_at
         FROM invite_dropbox
        WHERE owner_account_digest=?1 AND status='CONSUMED' AND expires_at > ?2`
    ).bind(account.account_digest, now).all();

    const invites = (rows?.results || []).map(r => ({
      invite_id: r.invite_id,
      owner_device_id: r.owner_device_id,
      expires_at: r.expires_at
    }));

    return json({ ok: true, invites });
  }

  // Check invite status (owner or deliverer)
  if (req.method === 'POST' && url.pathname === '/d1/invites/status') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const aliasKey = findAliasKey(body, INVITE_STATUS_ALIAS_FIELDS);
    if (aliasKey) return inviteAliasError(aliasKey);
    const unexpectedKey = findUnexpectedKey(body, INVITE_STATUS_ALLOWED_FIELDS);
    if (unexpectedKey) return inviteUnexpectedFieldError(unexpectedKey);
    const inviteId = String(body?.inviteId || '').trim();
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    if (!inviteId || inviteId.length < 8) {
      return json({ error: 'BadRequest', message: 'inviteId required' }, { status: 400 });
    }
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    const row = await env.DB.prepare(
      `SELECT invite_id, owner_account_digest, owner_device_id,
              delivered_by_account_digest, delivered_by_device_id,
              status, created_at, delivered_at, consumed_at, expires_at, updated_at
         FROM invite_dropbox WHERE invite_id=?1`
    ).bind(inviteId).first();
    if (!row) return json({ error: 'NotFound' }, { status: 404 });

    const requester = account.account_digest;
    const isOwner = row.owner_account_digest === requester;
    const isDeliverer = row.delivered_by_account_digest && row.delivered_by_account_digest === requester;
    if (!isOwner && !isDeliverer) {
      return json({ error: 'Forbidden', message: 'invite access denied' }, { status: 403 });
    }

    const now = Math.floor(Date.now() / 1000);
    const isExpired = Number(row.expires_at) <= now;
    let status = row.status;
    let updatedAt = row.updated_at || row.created_at || null;
    if (isExpired && status !== 'CONSUMED' && status !== 'CONFIRMED') {
      await markInviteExpired(env, inviteId, now);
      status = 'EXPIRED';
      updatedAt = now;
    }
    return json({
      invite_id: row.invite_id,
      status,
      expires_at: row.expires_at,
      created_at: row.created_at || null,
      updated_at: updatedAt,
      delivered_at: row.delivered_at || null,
      consumed_at: row.consumed_at || null
    });
  }

  return null;
}

// ---- Ephemeral Chat Sessions ----
const EPHEMERAL_TTL_SEC = 600;          // 10 minutes — session (conversation) lifetime
const EPHEMERAL_INVITE_TTL_SEC = 86400; // 24 hours — invite link lifetime
const EPHEMERAL_MAX_PER_OWNER = 1;

async function handleEphemeralRoutes(req, env) {
  const url = new URL(req.url);

  // POST /d1/ephemeral/create-link — owner creates a one-time link
  if (req.method === 'POST' && url.pathname === '/d1/ephemeral/create-link') {
    const body = await req.json();
    const ownerDigest = normalizeAccountDigest(body.ownerDigest);
    const ownerDeviceId = body.ownerDeviceId || '';
    const prekeyBundleJson = body.prekeyBundleJson || '{}';
    if (!ownerDigest) return json({ error: 'BadRequest', message: 'ownerDigest required' }, { status: 400 });

    await ensureDataTables(env);
    // Check active session count (max 2)
    const activeCount = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM ephemeral_sessions WHERE owner_digest = ? AND deleted_at IS NULL AND expires_at > ?`
    ).bind(ownerDigest, Math.floor(Date.now() / 1000)).first('cnt');
    if (activeCount >= EPHEMERAL_MAX_PER_OWNER) {
      return json({ error: 'LimitReached', message: `max ${EPHEMERAL_MAX_PER_OWNER} active ephemeral sessions` }, { status: 429 });
    }

    // Also count unconsumed invites
    const pendingCount = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM ephemeral_invites WHERE owner_digest = ? AND consumed_at IS NULL AND expires_at > ?`
    ).bind(ownerDigest, Math.floor(Date.now() / 1000)).first('cnt');
    if ((activeCount + pendingCount) >= EPHEMERAL_MAX_PER_OWNER) {
      return json({ error: 'LimitReached', message: `max ${EPHEMERAL_MAX_PER_OWNER} active ephemeral sessions (including pending links)` }, { status: 429 });
    }

    const token = generateNanoId(32);
    const now = Math.floor(Date.now() / 1000);
    const inviteExpiresAt = now + EPHEMERAL_INVITE_TTL_SEC;

    await env.DB.prepare(
      `INSERT INTO ephemeral_invites (token, owner_digest, owner_device_id, prekey_bundle_json, expires_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(token, ownerDigest, ownerDeviceId, prekeyBundleJson, inviteExpiresAt).run();

    return json({ token, expires_at: inviteExpiresAt });
  }

  // POST /d1/ephemeral/consume — guest consumes a link
  if (req.method === 'POST' && url.pathname === '/d1/ephemeral/consume') {
    const body = await req.json();
    const token = (body.token || '').trim();
    if (!token) return json({ error: 'BadRequest', message: 'token required' }, { status: 400 });

    await ensureDataTables(env);
    const now = Math.floor(Date.now() / 1000);

    // Atomically consume: UPDATE WHERE consumed_at IS NULL
    const result = await env.DB.prepare(
      `UPDATE ephemeral_invites SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL AND expires_at > ?`
    ).bind(now, token, now).run();

    if (!result?.meta?.changes) {
      return json({ error: 'NotFound', message: 'link expired or already used' }, { status: 404 });
    }

    const invite = await env.DB.prepare(
      `SELECT * FROM ephemeral_invites WHERE token = ?`
    ).bind(token).first();

    if (!invite) return json({ error: 'NotFound' }, { status: 404 });

    // Generate guest ephemeral identity
    const guestDigest = 'EPHEMERAL_' + generateNanoId(32).toUpperCase();
    const guestDeviceId = 'eph-' + generateNanoId(16);
    const sessionId = generateNanoId(32);
    const conversationId = 'eph-' + generateNanoId(32);
    const sessionExpiresAt = now + EPHEMERAL_TTL_SEC;

    // Create conversation
    await env.DB.prepare(
      `INSERT INTO conversations (id, created_at) VALUES (?, ?)`
    ).bind(conversationId, now).run();

    // Create ACL for both parties
    await env.DB.prepare(
      `INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role) VALUES (?, ?, ?, 'owner')`
    ).bind(conversationId, invite.owner_digest, invite.owner_device_id).run();
    await env.DB.prepare(
      `INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role) VALUES (?, ?, ?, 'ephemeral')`
    ).bind(conversationId, guestDigest, guestDeviceId).run();

    // Create ephemeral session
    await env.DB.prepare(
      `INSERT INTO ephemeral_sessions (session_id, invite_token, owner_digest, owner_device_id, guest_digest, guest_device_id, conversation_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(sessionId, token, invite.owner_digest, invite.owner_device_id, guestDigest, guestDeviceId, conversationId, sessionExpiresAt).run();

    // Issue a WS token for the guest
    let wsToken = null;
    try {
      const { token: jwt } = await createWsToken(env, { accountDigest: guestDigest, ttlSec: EPHEMERAL_TTL_SEC });
      wsToken = jwt;
    } catch { /* best-effort */ }

    // Notify the owner that their ephemeral link was consumed
    try {
      await notifyAccountDO(env, invite.owner_digest, {
        type: 'ephemeral_session_started',
        sessionId,
        conversationId,
        inviteToken: token,
        guestDigest,
        guestDeviceId,
        ownerDigest: invite.owner_digest,
        ownerDeviceId: invite.owner_device_id,
        expiresAt: sessionExpiresAt
      });
    } catch (e) { console.warn('[ephemeral-consume] owner notify failed', e?.message); }

    return json({
      session_id: sessionId,
      conversation_id: conversationId,
      guest_digest: guestDigest,
      guest_device_id: guestDeviceId,
      owner_digest: invite.owner_digest,
      owner_device_id: invite.owner_device_id,
      prekey_bundle: JSON.parse(invite.prekey_bundle_json || '{}'),
      expires_at: sessionExpiresAt,
      ws_token: wsToken
    });
  }

  // POST /d1/ephemeral/extend — either party extends timer
  if (req.method === 'POST' && url.pathname === '/d1/ephemeral/extend') {
    const body = await req.json();
    const sessionId = (body.sessionId || body.session_id || '').trim();
    const callerDigest = normalizeAccountDigest(body.callerDigest || body.caller_digest || '');
    if (!sessionId) return json({ error: 'BadRequest', message: 'sessionId required' }, { status: 400 });

    await ensureDataTables(env);
    const now = Math.floor(Date.now() / 1000);

    const session = await env.DB.prepare(
      `SELECT * FROM ephemeral_sessions WHERE session_id = ? AND deleted_at IS NULL`
    ).bind(sessionId).first();
    if (!session) return json({ error: 'NotFound', message: 'session not found' }, { status: 404 });
    if (session.expires_at <= now) return json({ error: 'Expired', message: 'session already expired' }, { status: 410 });

    // Only allow extend when remaining < 5 minutes
    const remaining = session.expires_at - now;
    if (remaining > 300) return json({ error: 'TooEarly', message: 'can only extend when < 5 minutes remaining' }, { status: 400 });

    // Verify caller is owner or guest
    if (callerDigest && callerDigest !== session.owner_digest && callerDigest !== session.guest_digest) {
      return json({ error: 'Forbidden', message: 'not a participant' }, { status: 403 });
    }

    const newExpiresAt = now + EPHEMERAL_TTL_SEC;
    await env.DB.prepare(
      `UPDATE ephemeral_sessions SET expires_at = ?, extended_count = extended_count + 1 WHERE session_id = ?`
    ).bind(newExpiresAt, sessionId).run();

    // Notify both parties via WS
    try {
      await notifyAccountDO(env, session.owner_digest, {
        type: 'ephemeral-extended',
        sessionId,
        conversationId: session.conversation_id,
        expiresAt: newExpiresAt,
        ts: Date.now()
      });
    } catch { /* best-effort */ }

    return json({ expires_at: newExpiresAt, extended_count: session.extended_count + 1 });
  }

  // POST /d1/ephemeral/delete — owner deletes session
  if (req.method === 'POST' && url.pathname === '/d1/ephemeral/delete') {
    const body = await req.json();
    const sessionId = (body.sessionId || body.session_id || '').trim();
    const ownerDigest = normalizeAccountDigest(body.ownerDigest || body.owner_digest || '');
    if (!sessionId || !ownerDigest) return json({ error: 'BadRequest', message: 'sessionId and ownerDigest required' }, { status: 400 });

    await ensureDataTables(env);
    const session = await env.DB.prepare(
      `SELECT * FROM ephemeral_sessions WHERE session_id = ? AND owner_digest = ? AND deleted_at IS NULL`
    ).bind(sessionId, ownerDigest).first();
    if (!session) return json({ error: 'NotFound' }, { status: 404 });

    return await deleteEphemeralSession(env, session);
  }

  // POST /d1/ephemeral/revoke-invite — owner revokes an unconsumed invite
  if (req.method === 'POST' && url.pathname === '/d1/ephemeral/revoke-invite') {
    const body = await req.json();
    const token = (body.token || '').trim();
    const ownerDigest = normalizeAccountDigest(body.ownerDigest || body.owner_digest || '');
    if (!token || !ownerDigest) return json({ error: 'BadRequest', message: 'token and ownerDigest required' }, { status: 400 });

    await ensureDataTables(env);
    const invite = await env.DB.prepare(
      `SELECT * FROM ephemeral_invites WHERE token = ? AND owner_digest = ? AND consumed_at IS NULL`
    ).bind(token, ownerDigest).first();
    if (!invite) return json({ error: 'NotFound', message: 'invite not found or already consumed' }, { status: 404 });

    await env.DB.prepare(`DELETE FROM ephemeral_invites WHERE token = ?`).bind(token).run();
    return json({ ok: true });
  }

  // POST /d1/ephemeral/list — owner lists active sessions
  if (req.method === 'POST' && url.pathname === '/d1/ephemeral/list') {
    const body = await req.json();
    const ownerDigest = normalizeAccountDigest(body.ownerDigest || body.owner_digest || '');
    if (!ownerDigest) return json({ error: 'BadRequest', message: 'ownerDigest required' }, { status: 400 });

    await ensureDataTables(env);
    const now = Math.floor(Date.now() / 1000);
    const rows = await env.DB.prepare(
      `SELECT session_id, conversation_id, guest_digest, guest_device_id, expires_at, extended_count, created_at, invite_token, pending_key_exchange_json
       FROM ephemeral_sessions WHERE owner_digest = ? AND deleted_at IS NULL AND expires_at > ? ORDER BY created_at DESC`
    ).bind(ownerDigest, now).all();

    // Also return unconsumed pending invites so the client can display/revoke them
    const pendingRows = await env.DB.prepare(
      `SELECT token, expires_at, created_at FROM ephemeral_invites WHERE owner_digest = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC`
    ).bind(ownerDigest, now).all();

    return json({ sessions: rows?.results || [], pending_invites: pendingRows?.results || [] });
  }

  // POST /d1/ephemeral/cleanup — garbage-collect expired sessions
  if (req.method === 'POST' && url.pathname === '/d1/ephemeral/cleanup') {
    await ensureDataTables(env);
    const now = Math.floor(Date.now() / 1000);
    const expired = await env.DB.prepare(
      `SELECT * FROM ephemeral_sessions WHERE deleted_at IS NULL AND expires_at <= ?`
    ).bind(now).all();
    const sessions = expired?.results || [];
    let cleaned = 0;
    for (const session of sessions) {
      try {
        await deleteEphemeralSession(env, session);
        cleaned++;
      } catch (e) { console.warn('ephemeral cleanup failed', session.session_id, e?.message); }
    }
    // Also clean expired unconsumed invites
    await env.DB.prepare(`DELETE FROM ephemeral_invites WHERE expires_at <= ? AND consumed_at IS NULL`).bind(now).run();
    return json({ cleaned });
  }

  // GET /d1/ephemeral/session-info — get session info (for guest reconnect)
  if (req.method === 'POST' && url.pathname === '/d1/ephemeral/session-info') {
    const body = await req.json();
    const sessionId = (body.sessionId || body.session_id || '').trim();
    if (!sessionId) return json({ error: 'BadRequest' }, { status: 400 });

    await ensureDataTables(env);
    const session = await env.DB.prepare(
      `SELECT * FROM ephemeral_sessions WHERE session_id = ? AND deleted_at IS NULL`
    ).bind(sessionId).first();
    if (!session) return json({ error: 'NotFound' }, { status: 404 });
    if (session.expires_at <= Math.floor(Date.now() / 1000)) {
      return json({ error: 'Expired' }, { status: 410 });
    }
    return json({
      session_id: session.session_id,
      conversation_id: session.conversation_id,
      owner_digest: session.owner_digest,
      guest_digest: session.guest_digest,
      expires_at: session.expires_at
    });
  }

  return null;
}

async function deleteEphemeralSession(env, session) {
  const now = Math.floor(Date.now() / 1000);
  // Delete messages
  await env.DB.prepare(`DELETE FROM messages_secure WHERE conversation_id = ?`).bind(session.conversation_id).run();
  // Delete message key vault entries
  await env.DB.prepare(`DELETE FROM message_key_vault WHERE conversation_id = ?`).bind(session.conversation_id).run();
  // Delete ACL
  await env.DB.prepare(`DELETE FROM conversation_acl WHERE conversation_id = ?`).bind(session.conversation_id).run();
  // Delete conversation
  await env.DB.prepare(`DELETE FROM conversations WHERE id = ?`).bind(session.conversation_id).run();
  // Mark session deleted
  await env.DB.prepare(`UPDATE ephemeral_sessions SET deleted_at = ? WHERE session_id = ?`).bind(now, session.session_id).run();

  // Notify owner
  try {
    await notifyAccountDO(env, session.owner_digest, {
      type: 'ephemeral-deleted',
      sessionId: session.session_id,
      conversationId: session.conversation_id,
      ts: Date.now()
    });
  } catch { /* best-effort */ }

  // Notify guest (EPHEMERAL_ digest DO)
  try {
    await notifyEphemeralDO(env, session.guest_digest, {
      type: 'ephemeral-deleted',
      sessionId: session.session_id,
      conversationId: session.conversation_id,
      ts: Date.now()
    });
  } catch { /* best-effort */ }

  return json({ ok: true, deleted: session.session_id });
}

// ---- 主入口 ----
async function handleFriendsRoutes(req, env) {
  const url = new URL(req.url);

  // 刪除聯絡（依 peer）
  if (req.method === 'POST' && url.pathname === '/d1/friends/contact-delete') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }

    let ownerAccountDigest = normalizeAccountDigest(body?.ownerAccountDigest || body?.owner_account_digest || body?.accountDigest || body?.account_digest);
    let peerAccountDigest = normalizeAccountDigest(body?.peerAccountDigest || body?.peer_account_digest);

    if (!ownerAccountDigest) {
      return json({ error: 'BadRequest', message: 'ownerAccountDigest required' }, { status: 400 });
    }
    if (!peerAccountDigest) {
      return json({ error: 'BadRequest', message: 'peerAccountDigest required' }, { status: 400 });
    }

    const results = [];
    const now = Math.floor(Date.now() / 1000);

    // 1. Delete contact-type messages from contacts-{digest} conversations
    const targets = new Map();
    const addTarget = (convId, targetAccountDigest) => {
      if (!convId) return;
      const key = `${convId}::${targetAccountDigest || peerAccountDigest || ''}`;
      if (!targets.has(key)) targets.set(key, { convId, targetAccountDigest: targetAccountDigest || peerAccountDigest || null });
    };

    addTarget(`contacts-${ownerAccountDigest}`, peerAccountDigest);
    addTarget(`contacts-${peerAccountDigest}`, ownerAccountDigest);

    const targetList = Array.from(targets.values());
    for (const entry of targetList) {
      const removed = await deleteContactByPeer(env, entry.convId, null, entry.targetAccountDigest);

      const convOwner = entry.convId ? entry.convId.replace('contacts-', '') : null;
      if (convOwner && entry.targetAccountDigest) {
        try {
          await env.DB.prepare(
            `DELETE FROM contacts WHERE owner_digest=?1 AND peer_digest=?2`
          ).bind(convOwner, entry.targetAccountDigest).run();
        } catch (err) {
          console.warn('contact_row_delete_failed', err?.message || err);
        }
      }

      results.push({ convId: entry.convId, removed, target: entry.targetAccountDigest || null });
    }

    // 2. Delete DM conversation data (all messages, attachments, vault keys, etc.)
    const dmConversationIds = new Set();
    // Use client-provided conversationId if available
    const clientConvId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    if (clientConvId && !clientConvId.startsWith('contacts-')) {
      dmConversationIds.add(clientConvId);
    }
    // Also discover shared conversations via conversation_acl
    try {
      const aclRows = await env.DB.prepare(`
        SELECT a1.conversation_id
          FROM conversation_acl a1
          JOIN conversation_acl a2
            ON a1.conversation_id = a2.conversation_id
         WHERE a1.account_digest = ?1
           AND a2.account_digest = ?2
           AND a1.conversation_id NOT LIKE 'contacts-%'
           AND a1.conversation_id NOT LIKE 'drive-%'
           AND a1.conversation_id NOT LIKE 'profile-%'
           AND a1.conversation_id NOT LIKE 'profile:%'
           AND a1.conversation_id NOT LIKE 'settings-%'
           AND a1.conversation_id NOT LIKE 'avatar-%'
      `).bind(ownerAccountDigest, peerAccountDigest).all();
      for (const row of (aclRows?.results || [])) {
        if (row?.conversation_id) dmConversationIds.add(row.conversation_id);
      }
    } catch (err) {
      console.warn('dm_conversation_lookup_failed', err?.message || err);
    }
    let dmRemoved = 0;
    for (const dmConvId of dmConversationIds) {
      try {
        dmRemoved += await deleteConversationData(env, dmConvId);
      } catch (err) {
        console.warn('dm_conversation_delete_failed', dmConvId, err?.message || err);
      }
    }
    if (dmRemoved > 0) {
      results.push({ convId: 'dm', removed: dmRemoved, conversationIds: Array.from(dmConversationIds) });
    }

    return json({ ok: true, ts: now, results });
  }

  return null;
}

async function handlePrekeysRoutes(req, env) {
  const url = new URL(req.url);

  // Publish per-device prekeys (Signal-style)
  if (req.method === 'POST' && url.pathname === '/d1/prekeys/publish') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const deviceId = normalizeDeviceId(body?.deviceId || body?.device_id);
    const signedPrekey = normalizeSignedPrekey(body?.signedPrekey);
    const opks = Array.isArray(body?.opks) ? body.opks.map(normalizeOpk) : [];
    if (!accountDigest || !deviceId || !signedPrekey) {
      return json({ error: 'BadRequest', message: 'accountDigest, deviceId, signedPrekey required' }, { status: 400 });
    }
    if (opks.some((entry) => !entry)) {
      return json({ error: 'BadRequest', message: 'invalid opk entry' }, { status: 400 });
    }
    if (!signedPrekey.ik_pub) {
      return json({ error: 'BadRequest', message: 'ik_pub required for signedPrekey' }, { status: 400 });
    }
    const spkValid = await verifySignedPrekey({
      spk_pub_b64: signedPrekey.pub,
      spk_sig_b64: signedPrekey.sig,
      ik_pub_b64: signedPrekey.ik_pub
    });
    if (!spkValid) {
      return json({ error: 'BadRequest', message: 'signedPrekey signature invalid' }, { status: 400 });
    }
    await ensureDataTables(env);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      INSERT INTO devices (account_digest, device_id, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?3)
      ON CONFLICT(account_digest, device_id) DO UPDATE SET updated_at=strftime('%s','now')
    `).bind(accountDigest, deviceId, now).run();
    await env.DB.prepare(`
      INSERT INTO device_signed_prekeys (account_digest, device_id, spk_id, spk_pub, spk_sig, ik_pub, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(account_digest, device_id, spk_id) DO UPDATE SET
        spk_pub=excluded.spk_pub,
        spk_sig=excluded.spk_sig,
        ik_pub=COALESCE(excluded.ik_pub, device_signed_prekeys.ik_pub)
    `).bind(accountDigest, deviceId, signedPrekey.id, signedPrekey.pub, signedPrekey.sig, signedPrekey.ik_pub || null, now).run();
    if (opks.length) {
      const stmt = env.DB.prepare(`
        INSERT OR REPLACE INTO device_opks (account_digest, device_id, opk_id, opk_pub, issued_at, consumed_at)
        VALUES (?1, ?2, ?3, ?4, ?5, NULL)
      `);
      for (const opk of opks) {
        await stmt.bind(accountDigest, deviceId, opk.id, opk.pub, now).run();
      }
    }
    const nextRow = await env.DB.prepare(`
      SELECT MAX(opk_id) as max_id FROM device_opks WHERE account_digest=?1 AND device_id=?2
    `).bind(accountDigest, deviceId).first();
    const nextOpkId = Number(nextRow?.max_id || 0) + 1;
    return json({ ok: true, next_opk_id: nextOpkId });
  }

  // Fetch per-device bundle (consume one OPK)
  if (req.method === 'GET' && url.pathname === '/d1/prekeys/bundle') {
    const peerAccountDigest = normalizeAccountDigest(url.searchParams.get('peerAccountDigest'));
    let peerDeviceId = normalizeDeviceId(url.searchParams.get('peerDeviceId'));
    if (!peerAccountDigest) {
      return json({ error: 'BadRequest', message: 'peerAccountDigest required' }, { status: 400 });
    }
    await ensureDataTables(env);
    if (!peerDeviceId) {
      const deviceRow = await env.DB.prepare(`
        SELECT device_id FROM devices
         WHERE account_digest=?1
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1
      `).bind(peerAccountDigest).first();
      peerDeviceId = normalizeDeviceId(deviceRow?.device_id);
    }
    if (!peerDeviceId) {
      console.warn('prekeys_bundle_peer_device_missing', { peerAccountDigest });
      return json({ error: 'PrekeyUnavailable', message: 'peer device not found' }, { status: 404 });
    }
    const spkRow = await env.DB.prepare(`
      SELECT spk_id, spk_pub, spk_sig, ik_pub
        FROM device_signed_prekeys
       WHERE account_digest=?1 AND device_id=?2
       ORDER BY spk_id DESC
       LIMIT 1
    `).bind(peerAccountDigest, peerDeviceId).first();
    if (!spkRow || !spkRow.spk_pub || !spkRow.spk_sig) {
      console.warn('prekeys_bundle_spk_missing', { peerAccountDigest, peerDeviceId });
      return json({ error: 'PrekeyUnavailable', message: 'signed prekey missing' }, { status: 404 });
    }
    const ikPub = spkRow.ik_pub || null;
    if (!ikPub) {
      console.warn('prekeys_bundle_ik_missing', { peerAccountDigest, peerDeviceId });
      return json({ error: 'PrekeyUnavailable', message: 'ik_pub missing for peer device' }, { status: 409 });
    }
    const opkRow = await env.DB.prepare(`
      SELECT opk_id, opk_pub FROM device_opks
       WHERE account_digest=?1 AND device_id=?2 AND consumed_at IS NULL
       ORDER BY opk_id ASC
       LIMIT 1
    `).bind(peerAccountDigest, peerDeviceId).first();
    if (!opkRow) {
      return json({ error: 'PrekeyUnavailable', message: 'one-time prekey missing' }, { status: 404 });
    }
    await env.DB.prepare(`
      UPDATE device_opks SET consumed_at=strftime('%s','now')
       WHERE account_digest=?1 AND device_id=?2 AND opk_id=?3
    `).bind(peerAccountDigest, peerDeviceId, opkRow.opk_id).run();
    return json({
      ok: true,
      device_id: peerDeviceId,
      signed_prekey: {
        id: spkRow.spk_id,
        pub: spkRow.spk_pub,
        sig: spkRow.spk_sig,
        ik_pub: ikPub
      },
      opk: {
        id: opkRow.opk_id,
        pub: opkRow.opk_pub
      }
    });
  }

  return null;
}


async function handleAtomicSendRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/messages/atomic-send') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }

    // 1. Common Validation
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest); // Sender
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);

    if (!conversationId || !accountDigest || !senderDeviceId) {
      return json({ error: 'BadRequest', message: 'conversationId, accountDigest, senderDeviceId required' }, { status: 400 });
    }

    await ensureDataTables(env);

    const messagePayload = body?.message;
    const vaultPayload = body?.vault;
    const backupPayload = body?.backup;

    if (!messagePayload || !vaultPayload) {
      return json({ error: 'BadRequest', message: 'message and vault payloads required' }, { status: 400 });
    }

    // 2. Prepare Message Insert
    const msgId = normalizeMessageId(messagePayload?.id);
    // [FIX] Infer sender digest/device from auth context if not explicitly provided (Client sends null)
    const payloadSenderDigest = normalizeAccountDigest(messagePayload?.sender_account_digest || messagePayload?.senderAccountDigest);
    const msgSenderDigest = payloadSenderDigest || accountDigest;

    const payloadSenderDevice = normalizeDeviceId(messagePayload?.sender_device_id || messagePayload?.senderDeviceId);
    const msgSenderDevice = payloadSenderDevice || senderDeviceId;

    const msgReceiverDigest = normalizeAccountDigest(messagePayload?.receiver_account_digest || messagePayload?.receiverAccountDigest);
    const msgReceiverDevice = normalizeDeviceId(messagePayload?.receiver_device_id || messagePayload?.receiverDeviceId); // nullable
    const msgHeaderJson = typeof messagePayload?.header_json === 'string' ? messagePayload.header_json : (messagePayload?.header ? JSON.stringify(messagePayload.header) : null);
    const msgCiphertext = typeof messagePayload?.ciphertext_b64 === 'string' ? messagePayload.ciphertext_b64 : null;
    const msgCounter = Number(messagePayload?.counter);
    const msgCreatedAt = Number(messagePayload?.created_at || messagePayload?.ts || 0) || Math.floor(Date.now() / 1000);

    if (!msgId || !msgSenderDigest || !msgSenderDevice || !msgReceiverDigest || !msgHeaderJson || !msgCiphertext || !Number.isFinite(msgCounter)) {
      return json({ error: 'BadRequest', message: 'invalid message payload' }, { status: 400 });
    }
    // Consistency Check (Only if payload explicitly provided a different value)
    if (payloadSenderDigest && payloadSenderDigest !== accountDigest) {
      return json({ error: 'BadRequest', message: 'message sender digest mismatch' }, { status: 400 });
    }
    if (payloadSenderDevice && payloadSenderDevice !== senderDeviceId) {
      return json({ error: 'BadRequest', message: 'message sender device mismatch' }, { status: 400 });
    }

    // 3. Prepare Vault Insert
    const vaultConversationId = normalizeConversationId(vaultPayload?.conversationId || vaultPayload?.conversation_id);
    const vaultMessageId = normalizeMessageId(vaultPayload?.messageId || vaultPayload?.message_id);
    const vaultSenderDevice = normalizeDeviceId(vaultPayload?.senderDeviceId || vaultPayload?.sender_device_id);
    const vaultTargetDevice = normalizeDeviceId(vaultPayload?.targetDeviceId || vaultPayload?.target_device_id);
    const vaultDirection = typeof vaultPayload?.direction === 'string' ? vaultPayload.direction.trim() : '';
    const vaultMsgType = typeof vaultPayload?.msgType === 'string' ? vaultPayload.msgType.trim() : (typeof vaultPayload?.msg_type === 'string' ? vaultPayload.msg_type.trim() : null);
    const vaultHeaderCounter = Number.isFinite(Number(vaultPayload?.headerCounter ?? vaultPayload?.header_counter)) ? Number(vaultPayload?.headerCounter ?? vaultPayload?.header_counter) : null;
    const vaultWrapped = vaultPayload?.wrapped_mk || vaultPayload?.wrappedMk || null;
    const vaultContext = vaultPayload?.wrap_context || vaultPayload?.wrapContext || null;
    const vaultDrState = vaultPayload?.dr_state || vaultPayload?.drState || null;

    if (!vaultConversationId || !vaultMessageId || !vaultSenderDevice || !vaultTargetDevice || !vaultDirection || !vaultWrapped || !vaultContext) {
      return json({ error: 'BadRequest', message: 'invalid vault payload' }, { status: 400 });
    }
    // Consistency Check
    if (vaultConversationId !== conversationId || vaultMessageId !== msgId || vaultSenderDevice !== senderDeviceId) {
      return json({ error: 'BadRequest', message: 'vault mismatch with context' }, { status: 400 });
    }
    if (!validateWrappedMessageKeyEnvelope(vaultWrapped)) {
      return json({ error: 'InvalidWrappedPayload', message: 'wrapped envelope invalid' }, { status: 400 });
    }
    // Note: We skip deep context validation here or reuse validateWrapContext if needed,
    // but we can trust the client providing consistent context if signature/hmac verifies request.
    // However, basic consistency is good.
    if (!validateWrapContext(vaultContext, {
      conversationId: vaultConversationId,
      messageId: vaultMessageId,
      senderDeviceId: vaultSenderDevice,
      targetDeviceId: vaultTargetDevice,
      direction: vaultDirection,
      msgType: vaultMsgType,
      headerCounter: vaultHeaderCounter
    })) {
      return json({ error: 'InvalidWrapContext', message: 'wrap_context invalid' }, { status: 400 });
    }


    // 4. Validate Max Counter (Optimistic Concurrency)
    // We should check max counter for the conversation to prevent overwrite or re-use (though D1 primary key handles unique id).
    // The separate 'secure message insert' handler does this check. We should replicate it or rely on unique constraint on ID.
    // But 'CounterTooLow' is a logic error we might want to catch.
    const maxRow = await env.DB.prepare(`
      SELECT MAX(counter) AS max_counter
        FROM messages_secure
       WHERE conversation_id=?1
         AND sender_account_digest=?2
         AND sender_device_id=?3
    `).bind(conversationId, accountDigest, senderDeviceId).first();
    const maxCounter = Number(maxRow?.max_counter ?? -1);
    if (Number.isFinite(maxCounter) && maxCounter >= 0 && msgCounter <= maxCounter) {
      return json({ error: 'CounterTooLow', message: 'counter must be greater than previous', maxCounter, details: { max_counter: maxCounter, maxCounter } }, { status: 409 });
    }

    // 5. Construct Batch
    const batch = [];

    // 5a. Conversations & ACL (ensure existence)
    // These are upserts (ON CONFLICT DO NOTHING/UPDATE), safe to include in batch or run before.
    // If run before, they are not atomic with message. Ideally everything in batch.
    // However, D1 batch is just array of statements.
    batch.push(env.DB.prepare(`
      INSERT INTO conversations (id)
      VALUES (?1)
      ON CONFLICT(id) DO NOTHING
    `).bind(conversationId));

    batch.push(env.DB.prepare(`
      INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
      VALUES (?1, ?2, ?3, 'member')
      ON CONFLICT(conversation_id, account_digest, device_id) DO UPDATE SET updated_at=strftime('%s','now')
    `).bind(conversationId, accountDigest, senderDeviceId));

    // Receiver ACL
    if (msgReceiverDigest) {
      batch.push(env.DB.prepare(`
         INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
         VALUES (?1, ?2, ?3, 'member')
         ON CONFLICT(conversation_id, account_digest, device_id) DO UPDATE SET updated_at=strftime('%s','now')
       `).bind(conversationId, msgReceiverDigest, msgReceiverDevice || null));
    }

    // 5b. Message Insert
    batch.push(env.DB.prepare(`
      INSERT INTO messages_secure (
        id, conversation_id, sender_account_digest, sender_device_id,
        receiver_account_digest, receiver_device_id, header_json, ciphertext_b64, counter, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).bind(
      msgId, conversationId, accountDigest, senderDeviceId,
      msgReceiverDigest, msgReceiverDevice || null, msgHeaderJson, msgCiphertext, msgCounter, msgCreatedAt
    ));

    // 5c. Vault Insert
    batch.push(env.DB.prepare(`
      INSERT INTO message_key_vault (
          account_digest, conversation_id, message_id, sender_device_id,
          target_device_id, direction, msg_type, header_counter, wrapped_mk_json, wrap_context_json, dr_state_snapshot, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, strftime('%s','now'))
       ON CONFLICT(account_digest, conversation_id, message_id, sender_device_id)
       DO NOTHING
    `).bind(
      accountDigest, conversationId, msgId, senderDeviceId,
      vaultTargetDevice, vaultDirection, vaultMsgType, vaultHeaderCounter,
      JSON.stringify(vaultWrapped), JSON.stringify(vaultContext), vaultDrState ? JSON.stringify(vaultDrState) : null
    ));

    // 5d. Backup Insert (if present)
    if (backupPayload) {
      try {
        console.log('[atomic-send] processing backup', {
          digest: backupPayload.accountDigest,
          hasPayload: !!backupPayload.payload
        });
        // Validate backup payload
        const bkDigest = normalizeAccountDigest(backupPayload.accountDigest || backupPayload.account_digest);
        if (bkDigest !== accountDigest) {
          return json({ error: 'BadRequest', message: 'backup digest mismatch' }, { status: 400 });
        }
        const rawPayload = backupPayload.payload;
        if (!rawPayload || typeof rawPayload !== 'object') {
          return json({ error: 'BadRequest', message: 'backup payload invalid' }, { status: 400 });
        }

        // Check version monotonicity need extra read?
        // Constraint: We want this to be atomic. If we do a read now for version, and write in batch, it's fine.
        // Or we can blindly insert if client ensures version is correct?
        // The client usually knows the next version.
        // But let's check basic version logic if supplied.
        // Actually, to fully protect overwrite, we should rely on UNIQUE constraint on (account_digest, version) if it existed.
        // But let's look at `contact_secret_backups` schema (inferred).
        // If we assume client sends correct Monotonic Number, we can just Insert.
        // If we want to auto-increment version on server, we can't easily do that in a Batch with arbitrary logic, unless we use specific SQL.
        // EXISTING LOGIC: reads MAX(version), then increments.
        // We can replicate that READ here before the batch. It breaks strict "Serializability" if concurrent requests happen,
        // but for a single user/device, it's usually sequential.
        // Let's do the read.

        let bkVersion = Number.isFinite(Number(backupPayload.version)) && Number(backupPayload.version) > 0
          ? Math.floor(Number(backupPayload.version))
          : null;

        // Only if version not provided do we fetch. If provided, we respect it.
        if (!bkVersion) {
          const existingVersionRow = await env.DB.prepare(
            `SELECT MAX(version) as max_version FROM contact_secret_backups WHERE account_digest=?1`
          ).bind(accountDigest).all();
          const nextVersion = Number(existingVersionRow?.results?.[0]?.max_version || 0);
          bkVersion = nextVersion + 1;
        }

        const bkSnapshotVersion = Number.isFinite(Number(backupPayload.snapshotVersion)) ? Number(backupPayload.snapshotVersion) : null;
        const bkEntries = Number.isFinite(Number(backupPayload.entries)) ? Number(backupPayload.entries) : null;
        const bkBytes = Number.isFinite(Number(backupPayload.bytes)) ? Number(backupPayload.bytes) : null;
        const bkChecksum = typeof backupPayload.checksum === 'string' ? String(backupPayload.checksum).slice(0, 128) : null;
        const bkDeviceLabel = typeof backupPayload.deviceLabel === 'string' ? String(backupPayload.deviceLabel).slice(0, 120) : null;
        const bkDeviceId = typeof backupPayload.deviceId === 'string' ? String(backupPayload.deviceId).slice(0, 120) : null;
        const bkUpdatedAt = normalizeTimestampMs(backupPayload.updatedAt || backupPayload.updated_at) || Date.now();
        const bkWithDrState = Number.isFinite(Number(backupPayload.withDrState)) ? Number(backupPayload.withDrState) : null;

        const payloadRecord = Number.isFinite(bkWithDrState)
          ? { payload: rawPayload, meta: { withDrState: bkWithDrState } }
          : rawPayload;

        batch.push(env.DB.prepare(
          `INSERT INTO contact_secret_backups (
            account_digest, version, payload_json, snapshot_version, entries,
            checksum, bytes, updated_at, device_label, device_id, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%s','now'))`
        ).bind(
          accountDigest, bkVersion, JSON.stringify(payloadRecord),
          bkSnapshotVersion, bkEntries, bkChecksum, bkBytes, bkUpdatedAt,
          bkDeviceLabel, bkDeviceId
        ));

        // Trim (DELETE)
        // "Delete all but last 5"
        // We can use the same logic as trimContactSecretBackups but hardcoded params
        const keep = 5;
        batch.push(env.DB.prepare(
          `DELETE FROM contact_secret_backups
           WHERE account_digest=?1
             AND id NOT IN (
               SELECT id FROM contact_secret_backups
                WHERE account_digest=?1
                ORDER BY updated_at DESC, id DESC
                LIMIT ?2
             )`
        ).bind(accountDigest, keep));
      } catch (err) {
        console.error('[atomic-send] backup processing crash', err);
        return json({
          error: 'WorkerCrash',
          message: 'BackupLogicFailed: ' + (err?.message || String(err)),
          stack: err?.stack
        }, { status: 500 });
      }
    }

    // 6. Execute Batch
    try {
      await env.DB.batch(batch);
    } catch (err) {
      console.warn('atomic_send_failed', err?.message || err);
      // Analyze error (duplicate message id? etc)
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('unique') || msg.includes('primary')) {
        // If message ID conflict, it might be a retry.
        // Consider returning OK if it looks like exact duplicate?
        // For now, fail to let client know or handle idempotency carefully.
        // But strict atomicity means we should probably return Error so client knows it failed.
        return json({ error: 'Conflict', message: 'duplicate entry' }, { status: 409 });
      }
      return json({ error: 'AtomicSendFailed', message: 'transaction failed' }, { status: 500 });
    }

    return json({
      ok: true,
      id: msgId,
      created_at: msgCreatedAt,
      vault_saved: true,
      backup_saved: !!backupPayload
    });
  }

  return null;
}

async function handleMessagesRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/messages/send-state') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);
    if (!conversationId || !accountDigest || !senderDeviceId) {
      return json({ error: 'BadRequest', message: 'conversationId, accountDigest, senderDeviceId required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const row = await env.DB.prepare(`
      SELECT id, counter
        FROM messages_secure
       WHERE conversation_id=?1
         AND sender_account_digest=?2
         AND sender_device_id=?3
       ORDER BY counter DESC, created_at DESC, id DESC
       LIMIT 1
    `).bind(conversationId, accountDigest, senderDeviceId).first();
    const lastAcceptedCounter = Number(row?.counter);
    const expectedCounter = Number.isFinite(lastAcceptedCounter) ? lastAcceptedCounter + 1 : 1;
    return json({
      ok: true,
      expected_counter: expectedCounter,
      last_accepted_counter: Number.isFinite(lastAcceptedCounter) ? lastAcceptedCounter : null,
      last_accepted_message_id: row?.id || null,
      server_time: Math.floor(Date.now() / 1000)
    });
  }

  if (req.method === 'POST' && url.pathname === '/d1/messages/outgoing-status') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const senderAccountDigest = normalizeAccountDigest(body?.senderAccountDigest || body?.sender_account_digest);
    const receiverAccountDigest = normalizeAccountDigest(body?.receiverAccountDigest || body?.receiver_account_digest);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);
    const messageIdsInput = Array.isArray(body?.messageIds) ? body.messageIds : [];
    const messageIds = messageIdsInput
      .map((value) => normalizeMessageId(value))
      .filter(Boolean);
    if (!conversationId || !senderAccountDigest || !receiverAccountDigest || !senderDeviceId) {
      return json({ error: 'BadRequest', message: 'conversationId, senderAccountDigest, receiverAccountDigest, senderDeviceId required' }, { status: 400 });
    }
    if (!messageIds.length) {
      return json({ error: 'BadRequest', message: 'messageIds required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const placeholders = messageIds.map((_, idx) => `?${idx + 5}`).join(', ');
    const params = [conversationId, senderDeviceId, senderAccountDigest, receiverAccountDigest, ...messageIds];
    const stmt = env.DB.prepare(`
      SELECT message_id, account_digest, direction, COUNT(*) AS row_count
        FROM message_key_vault
       WHERE conversation_id=?1
         AND sender_device_id=?2
         AND account_digest IN (?3, ?4)
         AND direction IN ('outgoing', 'incoming')
         AND message_id IN (${placeholders})
       GROUP BY message_id, account_digest, direction
    `).bind(...params);
    const { results } = await stmt.all();
    const counterByMessage = new Map();
    for (const messageId of messageIds) {
      counterByMessage.set(messageId, { outgoingCount: 0, incomingCount: 0 });
    }
    for (const row of results) {
      const messageId = row?.message_id || null;
      if (!messageId || !counterByMessage.has(messageId)) continue;
      const entry = counterByMessage.get(messageId);
      if (!entry) continue;
      const rowCount = Number(row?.row_count) || 0;
      const account = row?.account_digest || '';
      const direction = row?.direction || '';
      if (account === senderAccountDigest && direction === 'outgoing') {
        entry.outgoingCount += rowCount;
      } else if (account === receiverAccountDigest && direction === 'incoming') {
        entry.incomingCount += rowCount;
      }
    }
    const items = messageIds.map((messageId) => {
      const entry = counterByMessage.get(messageId) || { outgoingCount: 0, incomingCount: 0 };
      return {
        message_id: messageId,
        outgoing_count: entry.outgoingCount,
        incoming_count: entry.incomingCount,
        total_count: entry.outgoingCount + entry.incomingCount
      };
    });
    return json({
      ok: true,
      items,
      server_time: Math.floor(Date.now() / 1000)
    });
  }

  if (req.method === 'POST' && url.pathname === '/d1/messages/secure/max-counter') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);
    const senderAccountDigest = normalizeAccountDigest(body?.senderAccountDigest || body?.sender_account_digest);
    if (!conversationId || !senderDeviceId) {
      return json({ error: 'BadRequest', message: 'conversationId and senderDeviceId required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const where = ['conversation_id=?1', 'sender_device_id=?2'];
    const params = [conversationId, senderDeviceId];
    if (senderAccountDigest) {
      where.push(`sender_account_digest=?${params.length + 1}`);
      params.push(senderAccountDigest);
    }
    const row = await env.DB.prepare(`
      SELECT MAX(counter) AS max_counter
        FROM messages_secure
       WHERE ${where.join(' AND ')}
    `).bind(...params).first();
    const maxCounter = Number.isFinite(Number(row?.max_counter)) ? Number(row.max_counter) : null;
    return json({
      ok: true,
      conversationId,
      senderDeviceId,
      maxCounter,
      ts: Math.floor(Date.now() / 1000)
    });
  }

  // [WS-AUTH] Token Endpoint — handled by handlePublicRoutes (real JWT)
  // Mock removed: the public route at /api/v1/ws/token now issues proper JWT tokens.

  // [CALLS] Network Config Endpoint (Mock/Stub for WebRTC)
  if (req.method === 'GET' && (url.pathname === '/d1/calls/network-config' || url.pathname === '/api/v1/calls/network-config')) {
    return json({
      config: {
        version: 1,
        turnSecretsEndpoint: '/api/v1/calls/turn-credentials',
        turnTtlSeconds: 300,
        rtcpProbe: { timeoutMs: 1500, maxAttempts: 3, targetBitrateKbps: 2000 },
        bandwidthProfiles: [],
        ice: {
          iceTransportPolicy: 'all',
          bundlePolicy: 'balanced',
          continualGatheringPolicy: 'gather_continually',
          servers: [
            { urls: ['stun:stun.cloudflare.com:3478'] }
          ]
        },
        fallback: {
          maxPeerConnectionRetries: 2,
          relayOnlyAfterAttempts: 2,
          showBlockedAfterSeconds: 20
        }
      }
    });
  }


  // Secure Gap Count (Precise)
  if (req.method === 'GET' && (url.pathname === '/d1/messages/secure/gap-count' || url.pathname === '/api/v1/messages/secure/gap-count')) {
    const conversationId = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');
    const minCounter = Number(url.searchParams.get('minCounter') || url.searchParams.get('min_counter') || -1);
    const maxCounter = Number(url.searchParams.get('maxCounter') || url.searchParams.get('max_counter') || -1);
    const excludeSenderAccountDigest = url.searchParams.get('excludeSenderAccountDigest') || null;

    if (!conversationId) return json({ error: 'MissingParams', message: 'conversationId required' }, { status: 400 });

    try {
      let query = `SELECT count(*) as count FROM messages_secure WHERE conversation_id = ?1 AND counter > ?2 AND counter <= ?3`;
      const params = [conversationId, minCounter, maxCounter];

      if (excludeSenderAccountDigest) {
        query += ` AND sender_account_digest != ?4`;
        params.push(excludeSenderAccountDigest);
      }

      const row = await env.DB.prepare(query).bind(...params).first();
      return json({ count: row?.count || 0 });
    } catch (err) {
      console.warn('gap-count failed', err);
      return json({ count: 0 }); // Fail safe
    }
  }

  // [NEW] Unread Messages Count (Offline/Missing Keys)
  if (req.method === 'POST' && (url.pathname === '/d1/messages/unread-count' || url.pathname === '/api/v1/messages/unread-count')) {
    let body = {};
    try { body = await req.json(); } catch { }
    const conversationIds = Array.isArray(body?.conversationIds) ? body.conversationIds : [];
    const selfAccountDigest = body?.selfAccountDigest || null;

    if (!selfAccountDigest) {
      return json({ error: 'MissingParams', message: 'selfAccountDigest required' }, { status: 400 });
    }

    const result = {};
    for (const conversationId of conversationIds) {
      try {
        const query = `
          SELECT count(*) as count
          FROM messages_secure m
          LEFT JOIN message_key_vault v ON m.id = v.message_id
          WHERE m.conversation_id = ?1
            AND m.sender_account_digest != ?2
            AND v.message_id IS NULL
            AND (
              json_extract(m.header_json, '$.meta.msgType') IS NULL
              OR json_extract(m.header_json, '$.meta.msgType') NOT IN (
                'read-receipt', 'delivery-receipt',
                'session-init', 'session-ack', 'session-error',
                'conversation-deleted', 'profile-update'
              )
            )
        `;
        const row = await env.DB.prepare(query).bind(conversationId, selfAccountDigest).first();
        result[conversationId] = row?.count || 0;
      } catch (err) {
        console.warn(`unread-count failed for ${conversationId}`, err);
        result[conversationId] = 0;
      }
    }
    return json({ counts: result });
  }

  if (req.method === 'GET' && (url.pathname === '/d1/messages/by-counter' || url.pathname === '/api/v1/messages/by-counter')) {
    const conversationIdRaw = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');
    const counterRaw = url.searchParams.get('counter');
    const senderDeviceRaw = url.searchParams.get('senderDeviceId') || url.searchParams.get('sender_device_id');
    const senderDigestRaw = url.searchParams.get('senderAccountDigest') || url.searchParams.get('sender_account_digest');
    const conversationId = normalizeConversationId(conversationIdRaw);
    const counter = Number(counterRaw);
    const senderDeviceId = normalizeDeviceId(senderDeviceRaw || null);
    const senderAccountDigest = normalizeAccountDigest(senderDigestRaw || null);
    if (!conversationId || !Number.isFinite(counter)) {
      return json({ error: 'BadRequest', message: 'conversationId and counter required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const where = ['conversation_id=?1', 'counter=?2'];
    const params = [conversationId, counter];
    if (senderDeviceId) {
      where.push(`sender_device_id=?${params.length + 1}`);
      params.push(senderDeviceId);
    }
    if (senderAccountDigest) {
      where.push(`sender_account_digest=?${params.length + 1}`);
      params.push(senderAccountDigest);
    }
    const row = await env.DB.prepare(`
      SELECT id, conversation_id, sender_account_digest, sender_device_id, receiver_account_digest, receiver_device_id,
             header_json, ciphertext_b64, counter, created_at
        FROM messages_secure
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    `).bind(...params).first();
    if (!row) {
      return json({ error: 'NotFound', message: 'message not found' }, { status: 404 });
    }

    const includeKeys = url.searchParams.get('includeKeys') === 'true' || url.searchParams.get('include_keys') === 'true';
    let keysMap = null;
    let debugInfo = {
      url: url.href,
      includeKeys: includeKeys
    };

    if (includeKeys) {
      // [FIX] Strict Header Check (Align with listSecureMessages)
      const accountDigest = normalizeAccountDigest(req.headers.get('x-account-digest'));

      debugInfo = {
        includeKeys,
        targetId: row.id,
        accountDigest: accountDigest || 'MISSING',
        headersDigest: req.headers.get('x-account-digest'),
        qsDigest: url.searchParams.get('requesterDigest')
      };

      if (accountDigest && row.id) {
        try {
          const stmtKey = env.DB.prepare(`
            SELECT message_id, wrapped_mk_json, wrap_context_json, dr_state_snapshot
              FROM message_key_vault
             WHERE account_digest = ?1 AND message_id = ?2
          `).bind(accountDigest, row.id);
          const keyRow = await stmtKey.first();

          if (keyRow) {
            keysMap = {
              [keyRow.message_id]: {
                wrapped_mk_json: safeJSON(keyRow.wrapped_mk_json),
                wrap_context_json: safeJSON(keyRow.wrap_context_json),
                dr_state_snapshot: safeJSON(keyRow.dr_state_snapshot)
              }
            };
            debugInfo.found = true;
          } else {
            debugInfo.found = false;
            debugInfo.error = 'Key row not found in vault';
          }
        } catch (err) {
          debugInfo.error = err.message;
        }
      } else {
        debugInfo.error = 'Missing accountDigest or row.id';
      }
    }

    return json({
      ok: true,
      item: {
        id: row.id,
        conversation_id: row.conversation_id,
        sender_account_digest: row.sender_account_digest,
        sender_device_id: row.sender_device_id,
        receiver_account_digest: row.receiver_account_digest,
        receiver_device_id: row.receiver_device_id,
        header: safeJSON(row.header_json),
        header_json: row.header_json,
        ciphertext_b64: row.ciphertext_b64,
        counter: row.counter,
        created_at: row.created_at
      },
      keys: keysMap, // [FIX] Return keys if requested
      _debug: debugInfo // [DEBUG] Return debug info to client
    });
  }

  // Secure message insert
  if (req.method === 'POST' && url.pathname === '/d1/messages') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversation_id || body?.conversationId);
    const senderAccountDigest = normalizeAccountDigest(body?.sender_account_digest || body?.senderAccountDigest);
    const senderDeviceId = normalizeDeviceId(body?.sender_device_id || body?.senderDeviceId);
    const receiverAccountDigest = normalizeAccountDigest(body?.receiver_account_digest || body?.receiverAccountDigest);
    const receiverDeviceId = normalizeDeviceId(body?.receiver_device_id || body?.receiverDeviceId);
    const headerJson = typeof body?.header_json === 'string' ? body.header_json : (body?.header ? JSON.stringify(body.header) : null);
    const ciphertextB64 = typeof body?.ciphertext_b64 === 'string' ? body.ciphertext_b64 : null;
    const counter = Number(body?.counter);
    if (!conversationId || !senderAccountDigest || !senderDeviceId || !receiverAccountDigest || !headerJson || !ciphertextB64 || !Number.isFinite(counter)) {
      return json({ error: 'BadRequest', message: 'conversationId, sender/receiver digest+device, header_json, ciphertext_b64, counter required' }, { status: 400 });
    }
    let header;
    try {
      header = JSON.parse(headerJson);
    } catch {
      return json({ error: 'BadRequest', message: 'header_json invalid' }, { status: 400 });
    }
    const headerCounter = Number.isFinite(header?.n) ? header.n : Number(header?.counter);
    if (!Number.isFinite(headerCounter)) {
      return json({ error: 'BadRequest', message: 'header counter invalid' }, { status: 400 });
    }
    const headerDeviceId = normalizeDeviceId(header?.device_id || header?.deviceId || null);
    if (!headerDeviceId) {
      return json({ error: 'BadRequest', message: 'header device_id required' }, { status: 400 });
    }
    if (headerDeviceId !== senderDeviceId) {
      return json({ error: 'BadRequest', message: 'header device_id mismatch' }, { status: 400 });
    }
    const headerVersion = Number(header?.v ?? header?.version ?? 1);
    if (!Number.isFinite(headerVersion) || headerVersion <= 0) {
      return json({ error: 'BadRequest', message: 'header version invalid' }, { status: 400 });
    }
    if (!header?.iv_b64) {
      return json({ error: 'BadRequest', message: 'header iv_b64 required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const maxRow = await env.DB.prepare(`
      SELECT MAX(counter) AS max_counter
        FROM messages_secure
       WHERE conversation_id=?1
         AND sender_account_digest=?2
         AND sender_device_id=?3
    `).bind(conversationId, senderAccountDigest, senderDeviceId).first();
    const maxCounter = Number(maxRow?.max_counter ?? -1);
    if (Number.isFinite(maxCounter) && maxCounter >= 0 && counter <= maxCounter) {
      return json({ error: 'CounterTooLow', message: 'counter must be greater than previous', maxCounter, details: { max_counter: maxCounter, maxCounter } }, { status: 409 });
    }
    await env.DB.prepare(`
      INSERT INTO conversations (id)
      VALUES (?1)
      ON CONFLICT(id) DO NOTHING
    `).bind(conversationId).run();
    await env.DB.prepare(`
      INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
      VALUES (?1, ?2, ?3, 'member')
      ON CONFLICT(conversation_id, account_digest, device_id) DO UPDATE SET updated_at=strftime('%s','now')
    `).bind(conversationId, senderAccountDigest, senderDeviceId).run();
    await env.DB.prepare(`
      INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
      VALUES (?1, ?2, ?3, 'member')
      ON CONFLICT(conversation_id, account_digest, device_id) DO UPDATE SET updated_at=strftime('%s','now')
    `).bind(conversationId, receiverAccountDigest, receiverDeviceId || null).run();
    const messageId = typeof body?.id === 'string' && body.id.trim().length ? body.id.trim() : null;
    if (!messageId) {
      return json({ error: 'BadRequest', message: 'id (messageId) required' }, { status: 400 });
    }
    const createdAtInput = Number(body?.created_at || body?.ts || 0);
    const createdAt = Number.isFinite(createdAtInput) && createdAtInput > 0 ? createdAtInput : Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(`
        INSERT INTO messages_secure (
          id, conversation_id, sender_account_digest, sender_device_id,
          receiver_account_digest, receiver_device_id, header_json, ciphertext_b64, counter, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      `).bind(
        messageId,
        conversationId,
        senderAccountDigest,
        senderDeviceId,
        receiverAccountDigest,
        receiverDeviceId || null,
        headerJson,
        ciphertextB64,
        counter,
        createdAt
      ).run();
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('unique') || msg.includes('primary')) {
        return json({ ok: true, id: messageId, created_at: createdAt });
      }
      console.warn('messages_secure insert failed', err);
      return json({ error: 'InsertFailed', message: err?.message || 'insert failed' }, { status: 500 });
    }
    return json({ ok: true, id: messageId, created_at: createdAt });
  }

  // List secure messages (Smart Fetch / Visible Limit)
  if (req.method === 'GET' && (url.pathname === '/d1/messages' || url.pathname === '/d1/messages/secure' || url.pathname === '/api/v1/messages/secure')) {
    const conversationIdRaw = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');
    let cursorTs = Number(url.searchParams.get('cursorTs') || url.searchParams.get('cursor_ts') || 0);
    // [FIX] Normalize cursorTs to seconds — the SQL CASE WHEN normalizes created_at to seconds,
    // so cursorTs must also be in seconds for the comparison to work correctly.
    if (cursorTs > 100000000000) cursorTs = cursorTs / 1000.0;
    let cursorCounter = Number(url.searchParams.get('cursorCounter') || url.searchParams.get('cursor_counter') || 0);
    let cursorId = url.searchParams.get('cursorId') || url.searchParams.get('cursor_id') || '';

    // Treat 'limit' as 'visibleLimit' (default 20, max 200)
    const visibleLimit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20), 1), 200);

    const conversationId = normalizeConversationId(conversationIdRaw);
    if (!conversationId) {
      return json({ error: 'BadRequest', message: 'conversationId required' }, { status: 400 });
    }
    const requesterDigest = normalizeAccountDigest(req.headers.get('x-account-digest') || url.searchParams.get('requesterDigest'));
    if (!requesterDigest) {
      // Optional: if no digest, return all (or 403? standard practice: return all if system call, but strictly for user privacy we should require it)
      // For now, if missing, default to -1 (show all).
    }
    await ensureDataTables(env);

    const SEMANTIC_VISIBLE = new Set(['text', 'media', 'call-log', 'system']);
    function isVisibleItem(row) {
      if (!row || !row.header_json) return false;
      try {
        const header = JSON.parse(row.header_json);
        let type = header?.meta?.msgType || header?.meta?.msg_type || null;
        if (!type && row.ciphertext_b64) {
          type = 'text';
        }
        return type && SEMANTIC_VISIBLE.has(type.toLowerCase());
      } catch {
        return false;
      }
    }

    const MAX_ITERATIONS = 5;
    let iteration = 0;
    let totalVisible = 0;
    const allItems = [];
    let hasMoreGlobal = false;

    while (totalVisible < visibleLimit && iteration < MAX_ITERATIONS) {
      iteration++;
      const needed = visibleLimit - totalVisible;
      const nextLimit = Math.min(Math.max(needed * 2, 50), 200);

      const params = [conversationId];
      let cursorClause = '';
      if (Number.isFinite(cursorCounter) && cursorCounter > 0) {
        params.push(cursorCounter, cursorId || '');
        cursorClause = 'AND (counter < ?2 OR (counter = ?2 AND id < ?3))';
      } else if (cursorTs) {
        params.push(cursorTs, cursorId);
        // [FIX] Handle Mixed Units: Normalize DB created_at to Seconds
        // If created_at > 1e11 (MS), divide by 1000. Else use as is.
        // We compare normalized DB time against cursorTs (which is presumed Seconds).
        cursorClause = `
          AND (
            (CASE WHEN created_at > 100000000000 THEN created_at / 1000.0 ELSE created_at END) < ?2
            OR (
              (CASE WHEN created_at > 100000000000 THEN created_at / 1000.0 ELSE created_at END) = ?2
              AND id < ?3
            )
          )
        `;
      }
      params.push(nextLimit + 1);

      const stmt = env.DB.prepare(`
        SELECT id, conversation_id, sender_account_digest, sender_device_id, receiver_account_digest, receiver_device_id,
               header_json, ciphertext_b64, counter, created_at
          FROM messages_secure
         WHERE conversation_id=?1
           ${cursorClause}
           AND (
             (CASE WHEN created_at > 100000000000 THEN created_at / 1000.0 ELSE created_at END)
               > COALESCE((SELECT CASE WHEN min_ts > 100000000000 THEN min_ts / 1000.0 ELSE min_ts END FROM deletion_cursors WHERE conversation_id=?1 AND account_digest=?${params.length + 1}), 0)
           )
         ORDER BY 
           (CASE WHEN created_at > 100000000000 THEN created_at / 1000.0 ELSE created_at END) DESC,
           counter DESC,
           id DESC
         LIMIT ?${params.length}
      `).bind(...params, requesterDigest);

      const { results } = await stmt.all();
      const rawCount = results.length;
      const hasMoreLocal = rawCount > nextLimit;
      const batch = hasMoreLocal ? results.slice(0, nextLimit) : results;

      if (batch.length === 0) {
        hasMoreGlobal = false;
        break;
      }

      // [FIX-START] Aggregate vault put access count for delivery status
      // We need to know how many devices have this message key (Sender + Receiver(s))
      // vaultPutCount >= 2 usually means delivered.
      const batchIds = batch.map(r => r.id).filter(Boolean);
      const vaultCounts = new Map();
      if (batchIds.length > 0) {
        try {
          const placeholders = batchIds.map((_, i) => `?${i + 1}`).join(',');
          const countStmt = env.DB.prepare(`
            SELECT message_id, COUNT(*) as c
              FROM message_key_vault
             WHERE message_id IN (${placeholders})
             GROUP BY message_id
          `).bind(...batchIds);
          const { results: countRows } = await countStmt.all();
          for (const cr of countRows || []) {
            if (cr.message_id) vaultCounts.set(cr.message_id, Number(cr.c));
          }
        } catch (err) {
          console.warn('vault_count_agg_failed', err);
        }
      }
      // [FIX-END]


      let lastItemInBatch = null;
      for (const row of batch) {
        if (totalVisible >= visibleLimit) {
          hasMoreGlobal = true;
          break;
        }

        const item = {
          id: row.id,
          conversation_id: row.conversation_id,
          sender_account_digest: row.sender_account_digest,
          sender_device_id: row.sender_device_id,
          receiver_account_digest: row.receiver_account_digest,
          receiver_device_id: row.receiver_device_id,
          header: safeJSON(row.header_json), // Root Cause Fix: Return parsed header object
          header_json: row.header_json,
          ciphertext_b64: row.ciphertext_b64,
          counter: row.counter,
          vault_put_count: vaultCounts.get(row.id) || 0, // [FIX] Return aggregated count
          created_at: row.created_at
        };

        if (isVisibleItem(row)) {
          totalVisible++;
        }
        allItems.push(item);
        lastItemInBatch = item;
      }

      if (lastItemInBatch) {
        cursorCounter = lastItemInBatch.counter;
        cursorTs = lastItemInBatch.created_at;
        // [FIX] Normalize loop cursor to seconds (matching CASE WHEN in SQL)
        if (cursorTs > 100000000000) cursorTs = cursorTs / 1000.0;
        cursorId = lastItemInBatch.id;
      }

      if (totalVisible < visibleLimit) {
        if (!hasMoreLocal) {
          hasMoreGlobal = false;
          break;
        }
        hasMoreGlobal = true;
      } else {
        if (!hasMoreLocal && batch.length === results.length && totalVisible === visibleLimit) {
          // Check if there are more items after this exact point?
          // Since we fetched `nextLimit + 1` and hasMoreLocal is false, we know DB is empty after this batch.
          // If we consumed the WHOLE batch to hit the limit, then global hasMore is false (unless batch length < results length due to logical break?)
          // Actually `results.length` vs `batch.length` handles the +1 query.
          if (rawCount <= nextLimit) hasMoreGlobal = false;
          else hasMoreGlobal = true;
        } else {
          hasMoreGlobal = true;
        }
        break;
      }
    }

    const last = allItems.at(-1) || null;
    // [FIX] Normalize nextCursor.ts to seconds for client consistency
    const lastTs = last ? (last.created_at > 100000000000 ? last.created_at / 1000.0 : last.created_at) : null;
    const nextCursor = last ? { ts: lastTs, id: last.id, counter: last.counter } : null;

    const includeKeys = url.searchParams.get('includeKeys') === 'true' || url.searchParams.get('include_keys') === 'true';
    let keysMap = null;

    if (includeKeys && allItems.length > 0) {
      const ids = allItems.map(it => it.id).filter(id => typeof id === 'string');
      // Pass 'X-Account-Digest' from Controller to Worker to scope Vault Query
      const accountDigest = req.headers.get('x-account-digest');

      if (ids.length > 0 && accountDigest) {
        try {
          const placeholders = ids.map((_, i) => `?${i + 2}`).join(',');
          const stmtKeys = env.DB.prepare(`
            SELECT message_id, wrapped_mk_json, wrap_context_json, dr_state_snapshot
              FROM message_key_vault
             WHERE account_digest = ?1
               AND message_id IN (${placeholders})
          `).bind(accountDigest, ...ids);
          const { results: keyRows } = await stmtKeys.all();
          if (keyRows && keyRows.length > 0) {
            keysMap = {};
            for (const kRow of keyRows) {
              keysMap[kRow.message_id] = {
                wrapped_mk_json: safeJSON(kRow.wrapped_mk_json),
                wrap_context_json: safeJSON(kRow.wrap_context_json),
                dr_state_snapshot: safeJSON(kRow.dr_state_snapshot)
              };
            }
          }
        } catch (err) {
          console.warn('d1_messages_include_keys_failed', err);
        }
      }
    }

    return json({
      ok: true,
      items: allItems,
      keys: keysMap,
      next_cursor: nextCursor,
      next_cursor_ts: nextCursor?.ts || null,
      next_cursor_counter: nextCursor?.counter ?? null,
      has_more_at_cursor: hasMoreGlobal
    });
  }

  // Deletion Cursor API
  if (req.method === 'POST' && url.pathname === '/d1/deletion/cursor') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 }); }

    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const targetDigest = normalizeAccountDigest(body?.targetDigest || body?.targetAccountDigest || body?.accountDigest);
    const minTsRaw = Number(body?.minTs || body?.min_ts || 0);
    // [FIX] Normalize to seconds — clients may accidentally send Date.now() (ms).
    // The message listing SQL normalizes created_at to seconds, so min_ts must
    // also be in seconds.  A ms value (>1e11) would permanently block all messages.
    const minTsNorm = Number.isFinite(minTsRaw) && minTsRaw > 0
      ? (minTsRaw > 100000000000 ? Math.floor(minTsRaw / 1000) : minTsRaw)
      : 0;

    if (!conversationId || !targetDigest || !minTsNorm) {
      return json({ error: 'BadRequest', message: 'conversationId, targetDigest, min_ts required' }, { status: 400 });
    }

    await ensureDataTables(env);

    // [FIX] Also repair any existing corrupted cursors that were stored in ms.
    // If the existing row has min_ts > 1e11 (clearly ms, not seconds), normalize
    // it first so the MAX() comparison works correctly.
    await env.DB.prepare(`
      UPDATE deletion_cursors
         SET min_ts = min_ts / 1000.0
       WHERE conversation_id = ?1 AND account_digest = ?2
         AND min_ts > 100000000000
    `).bind(conversationId, targetDigest).run();

    await env.DB.prepare(`
      INSERT INTO deletion_cursors (conversation_id, account_digest, min_ts, updated_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(conversation_id, account_digest) DO UPDATE SET
        min_ts = MAX(deletion_cursors.min_ts, excluded.min_ts),
        updated_at = excluded.updated_at
      WHERE excluded.min_ts > deletion_cursors.min_ts
    `).bind(conversationId, targetDigest, minTsNorm, Date.now()).run();

    return json({ ok: true, min_ts: minTsNorm });
  }

  // Batch delete messages/attachments by id
  if (req.method === 'POST' && url.pathname === '/d1/messages/delete') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const ids = Array.isArray(body?.ids)
      ? Array.from(new Set(body.ids.map((k) => String(k || '').trim()).filter(Boolean)))
      : [];
    if (!ids.length) {
      return json({ error: 'BadRequest', message: 'ids required' }, { status: 400 });
    }

    const results = [];
    for (const id of ids) {
      let secureCount = 0;
      let attachmentCount = 0;
      try {
        const resAttach = await env.DB.prepare(
          `DELETE FROM attachments WHERE message_id=?1`
        ).bind(id).run();
        attachmentCount = resAttach?.meta?.changes || 0;
      } catch (err) {
        console.warn('delete attachments failed', err);
      }
      try {
        const resSecure = await env.DB.prepare(
          `DELETE FROM messages_secure WHERE id=?1`
        ).bind(id).run();
        secureCount = resSecure?.meta?.changes || 0;
      } catch (err) {
        console.warn('delete messages_secure failed', err);
      }
      results.push({ id, secure: secureCount, attachments: attachmentCount });
    }

    return json({ ok: true, results });
  }

  return null;
}

async function handleContactSecretsRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/contact-secrets/backup') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    const payload = body?.payload;
    if (!payload || typeof payload !== 'object') {
      return json({ error: 'BadRequest', message: 'payload required' }, { status: 400 });
    }
    const snapshotVersion = Number.isFinite(Number(body?.snapshotVersion)) ? Number(body.snapshotVersion) : null;
    const entries = Number.isFinite(Number(body?.entries)) ? Number(body.entries) : null;
    const bytes = Number.isFinite(Number(body?.bytes)) ? Number(body.bytes) : null;
    const withDrState = Number.isFinite(Number(body?.withDrState)) ? Number(body.withDrState) : null;
    const checksum = typeof body?.checksum === 'string' ? String(body.checksum).slice(0, 128) : null;
    const deviceLabel = typeof body?.deviceLabel === 'string' ? String(body.deviceLabel).slice(0, 120) : null;
    const deviceId = typeof body?.deviceId === 'string' ? String(body.deviceId).slice(0, 120) : null;
    const updatedAt = normalizeTimestampMs(body?.updatedAt || body?.updated_at) || Date.now();
    let version = Number.isFinite(Number(body?.version)) && Number(body.version) > 0
      ? Math.floor(Number(body.version))
      : null;

    let existingWithDrState = null;
    const latestRows = await env.DB.prepare(
      `SELECT payload_json
        FROM contact_secret_backups
        WHERE account_digest=?1
        ORDER BY updated_at DESC, id DESC
        LIMIT 5`
    ).bind(accountDigest).all();
    const latestList = latestRows?.results || [];
    for (const row of latestList) {
      const parsed = parseBackupPayload(row.payload_json);
      if (Number.isFinite(parsed?.withDrState)) {
        existingWithDrState = parsed.withDrState;
        break;
      }
    }

    const existingVersionRow = await env.DB.prepare(
      `SELECT MAX(version) as max_version FROM contact_secret_backups WHERE account_digest=?1`
    ).bind(accountDigest).all();
    const nextVersion = Number(existingVersionRow?.results?.[0]?.max_version || 0);
    if (!version || version <= nextVersion) {
      version = nextVersion + 1;
    }

    if (Number.isFinite(withDrState) && Number.isFinite(existingWithDrState) && withDrState < existingWithDrState) {
      return json({ ok: false, error: 'ContactSecretsBackupRejected', message: 'withDrState regression' }, { status: 409 });
    }

    const payloadRecord = Number.isFinite(withDrState)
      ? { payload, meta: { withDrState } }
      : payload;

    await env.DB.prepare(
      `INSERT INTO contact_secret_backups (
          account_digest, version, payload_json, snapshot_version, entries,
          checksum, bytes, updated_at, device_label, device_id, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%s','now'))`
    ).bind(
      accountDigest,
      version,
      JSON.stringify(payloadRecord),
      snapshotVersion,
      entries,
      checksum,
      bytes,
      updatedAt,
      deviceLabel,
      deviceId
    ).run();

    await trimContactSecretBackups(env, accountDigest, 5);

    return json({
      ok: true,
      backup: {
        accountDigest,
        version,
        updatedAt,
        snapshotVersion,
        entries,
        bytes,
        checksum,
        deviceLabel,
        deviceId
      }
    });
  }

  if (req.method === 'GET' && url.pathname === '/d1/contact-secrets/backup') {
    const accountDigest = normalizeAccountDigest(
      url.searchParams.get('accountDigest')
      || url.searchParams.get('account_digest')
    );
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    const limitParam = Number(url.searchParams.get('limit') || 1);
    const limit = Math.min(Math.max(limitParam || 1, 1), 10);
    const versionParam = Number(url.searchParams.get('version') || 0);

    let stmt;
    if (Number.isFinite(versionParam) && versionParam > 0) {
      stmt = env.DB.prepare(
        `SELECT * FROM contact_secret_backups
          WHERE account_digest=?1 AND version=?2
          ORDER BY updated_at DESC
          LIMIT 1`
      ).bind(accountDigest, Math.floor(versionParam));
    } else {
      stmt = env.DB.prepare(
        `SELECT * FROM contact_secret_backups
          WHERE account_digest=?1
          ORDER BY updated_at DESC, id DESC
          LIMIT ?2`
      ).bind(accountDigest, limit);
    }
    const rows = await stmt.all();
    const backups = (rows?.results || []).map((row) => {
      const parsed = parseBackupPayload(row.payload_json);
      const parsedWithDrState = Number.isFinite(parsed?.withDrState) ? Number(parsed.withDrState) : null;
      return {
        id: row.id,
        account_digest: row.account_digest,
        version: row.version,
        snapshot_version: row.snapshot_version,
        entries: row.entries,
        checksum: row.checksum,
        bytes: row.bytes,
        updated_at: Number(row.updated_at) || null,
        device_label: row.device_label || null,
        device_id: row.device_id || null,
        created_at: Number(row.created_at) || null,
        payload: parsed?.payload ?? null,
        with_dr_state: parsedWithDrState
      };
    });
    return json({ ok: true, backups });
  }

  return null;
}

let messageKeyVaultSchemaWarned = false;
const VAULT_WORKER_LOG_LIMIT = 5;
let messageKeyVaultPutLogCount = 0;
let messageKeyVaultGetLogCount = 0;

function logMessageKeyVault(kind, payload) {
  if (kind === 'put' && messageKeyVaultPutLogCount >= VAULT_WORKER_LOG_LIMIT) return;
  if (kind === 'get' && messageKeyVaultGetLogCount >= VAULT_WORKER_LOG_LIMIT) return;
  if (kind === 'put') messageKeyVaultPutLogCount += 1;
  if (kind === 'get') messageKeyVaultGetLogCount += 1;
  try {
    console.log(kind === 'put' ? 'messageKeyVaultPut' : 'messageKeyVaultGet', payload);
  } catch {
    /* ignore logging errors */
  }
}

function shapeOf(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length ? 'string' : 'string(empty)';
  if (typeof value === 'object') return Array.isArray(value) ? 'array' : 'object';
  return typeof value;
}

function summarizeMessageKeyVaultShape(body = {}) {
  return {
    accountDigest: shapeOf(body?.accountDigest || body?.account_digest),
    conversationId: shapeOf(body?.conversationId || body?.conversation_id),
    messageId: shapeOf(body?.messageId || body?.message_id),
    senderDeviceId: shapeOf(body?.senderDeviceId || body?.sender_device_id),
    targetDeviceId: shapeOf(body?.targetDeviceId || body?.target_device_id),
    direction: shapeOf(body?.direction),
    msgType: shapeOf(body?.msgType || body?.msg_type),
    headerCounter: shapeOf(body?.headerCounter || body?.header_counter),
    wrapped_mk: shapeOf(body?.wrapped_mk || body?.wrappedMk),
    wrap_context: shapeOf(body?.wrap_context || body?.wrapContext)
  };
}

function validateWrappedMessageKeyEnvelope(wrapped) {
  if (!wrapped || typeof wrapped !== 'object') return false;
  const version = Number(wrapped.v ?? wrapped.version ?? 0);
  if (!Number.isFinite(version) || version <= 0) return false;
  if (wrapped.aead !== 'aes-256-gcm') return false;
  if (wrapped.info !== 'message-key/v1') return false;
  const salt = typeof wrapped.salt_b64 === 'string'
    ? wrapped.salt_b64
    : (typeof wrapped.salt === 'string' ? wrapped.salt : null);
  const iv = typeof wrapped.iv_b64 === 'string'
    ? wrapped.iv_b64
    : (typeof wrapped.iv === 'string' ? wrapped.iv : null);
  const ct = typeof wrapped.ct_b64 === 'string'
    ? wrapped.ct_b64
    : (typeof wrapped.ct === 'string' ? wrapped.ct : null);
  if (!salt || !iv || !ct) return false;
  return true;
}

function getWrapContextString(ctx, key) {
  if (!ctx || typeof ctx !== 'object') return null;
  const snake = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const raw = ctx[key] ?? ctx[snake];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function normalizeWrapContextDirection(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === 'incoming' || trimmed === 'outgoing' ? trimmed : null;
}

function normalizeWrapContextHeaderCounter(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function validateWrapContext(ctx, expected) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return false;
  const version = Number(ctx.v ?? ctx.version ?? 0);
  if (!Number.isFinite(version) || version <= 0) return false;
  const conversationId = getWrapContextString(ctx, 'conversationId');
  const messageId = getWrapContextString(ctx, 'messageId');
  const senderDeviceId = getWrapContextString(ctx, 'senderDeviceId');
  const targetDeviceId = getWrapContextString(ctx, 'targetDeviceId');
  const direction = normalizeWrapContextDirection(ctx.direction);
  if (!conversationId || conversationId !== expected.conversationId) return false;
  if (!messageId || messageId !== expected.messageId) return false;
  if (!senderDeviceId || senderDeviceId !== expected.senderDeviceId) return false;
  if (!targetDeviceId || targetDeviceId !== expected.targetDeviceId) return false;
  if (!direction || direction !== expected.direction) return false;
  const headerCounter = normalizeWrapContextHeaderCounter(ctx.headerCounter ?? ctx.header_counter);
  if (headerCounter !== (expected.headerCounter ?? null)) return false;
  const msgType = getWrapContextString(ctx, 'msgType');
  if (msgType && expected.msgType && msgType !== expected.msgType) return false;
  return true;
}

async function handleMessageKeyVaultRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/message-key-vault/put') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const bodyShape = summarizeMessageKeyVaultShape(body);
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const messageId = normalizeMessageId(body?.messageId || body?.message_id);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);
    const targetDeviceId = normalizeDeviceId(body?.targetDeviceId || body?.target_device_id);
    const directionRaw = typeof body?.direction === 'string' ? body.direction.trim() : '';
    const direction = directionRaw === 'incoming' || directionRaw === 'outgoing' ? directionRaw : null;
    const msgType = typeof body?.msgType === 'string'
      ? body.msgType.trim()
      : (typeof body?.msg_type === 'string' ? body.msg_type.trim() : null);
    const headerCounterRaw = body?.headerCounter ?? body?.header_counter;
    const headerCounter = (headerCounterRaw === null || headerCounterRaw === undefined || headerCounterRaw === '')
      ? null
      : (Number.isFinite(Number(headerCounterRaw)) ? Number(headerCounterRaw) : null);
    const wrapped = body?.wrapped_mk || body?.wrappedMk || null;
    const wrapContext = body?.wrap_context || body?.wrapContext || null;
    const drStateSnapshot = body?.dr_state || body?.drState || null; // Atomic Piggyback State

    if (!accountDigest || !conversationId || !messageId || !senderDeviceId || !targetDeviceId || !direction || !wrapped || !wrapContext) {
      console.warn('messageKeyVault.put.badPayload', {
        reason: 'required-missing',
        shape: bodyShape
      });
      return json({ error: 'BadRequest', message: 'accountDigest, conversationId, messageId, senderDeviceId, targetDeviceId, direction, wrapped_mk, wrap_context required' }, { status: 400 });
    }
    if (!validateWrappedMessageKeyEnvelope(wrapped)) {
      console.warn('messageKeyVault.put.badPayload', {
        reason: 'wrapped-envelope-invalid',
        shape: bodyShape
      });
      return json({ error: 'InvalidWrappedPayload', message: 'wrapped envelope missing required fields' }, { status: 400 });
    }
    if (!validateWrapContext(wrapContext, {
      conversationId,
      messageId,
      senderDeviceId,
      targetDeviceId,
      direction,
      msgType,
      headerCounter
    })) {
      console.warn('messageKeyVault.put.badPayload', {
        reason: 'wrap-context-invalid',
        shape: bodyShape
      });
      return json({ error: 'InvalidWrapContext', message: 'wrap_context invalid or mismatched' }, { status: 400 });
    }

    try {
      await ensureDataTables(env);
    } catch (err) {
      const message = err?.message || String(err);
      if (message.includes('message_key_vault')) {
        if (!messageKeyVaultSchemaWarned) {
          messageKeyVaultSchemaWarned = true;
          console.error('message_key_vault_schema_missing', message);
        }
        return json({ error: 'SchemaMissing', message: 'message_key_vault table missing; apply migration' }, { status: 500 });
      }
      throw err;
    }

    try {
      const result = await env.DB.prepare(
        `INSERT INTO message_key_vault (
            account_digest, conversation_id, message_id, sender_device_id,
            target_device_id, direction, msg_type, header_counter, wrapped_mk_json, wrap_context_json, dr_state_snapshot, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, strftime('%s','now'))
         ON CONFLICT(account_digest, conversation_id, message_id, sender_device_id)
         DO NOTHING`
      ).bind(
        accountDigest,
        conversationId,
        messageId,
        senderDeviceId,
        targetDeviceId,
        direction,
        msgType,
        headerCounter,
        JSON.stringify(wrapped),
        JSON.stringify(wrapContext),
        drStateSnapshot || null
      ).run();
      if (result?.meta?.changes === 0) {
        logMessageKeyVault('put', {
          accountDigestSuffix4: accountDigest.slice(-4),
          conversationIdPrefix8: conversationId.slice(0, 8),
          messageIdPrefix8: messageId.slice(0, 8),
          senderDeviceIdSuffix4: senderDeviceId.slice(-4),
          duplicate: true
        });
        return json({ ok: true, duplicate: true });
      }
    } catch (err) {
      console.warn('message_key_vault_put_failed', err?.message || err);
      return json({ error: 'InsertFailed', message: err?.message || 'unable to store message key' }, { status: 500 });
    }

    logMessageKeyVault('put', {
      accountDigestSuffix4: accountDigest.slice(-4),
      conversationIdPrefix8: conversationId.slice(0, 8),
      messageIdPrefix8: messageId.slice(0, 8),
      senderDeviceIdSuffix4: senderDeviceId.slice(-4),
      duplicate: false
    });
    return json({ ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/d1/message-key-vault/get') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const messageId = normalizeMessageId(body?.messageId || body?.message_id);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);
    const headerCounter = body?.headerCounter ?? body?.header_counter;
    const headerCounterNum = Number.isFinite(Number(headerCounter)) ? Number(headerCounter) : null;

    if (!accountDigest || !conversationId || !senderDeviceId || (!messageId && headerCounterNum === null)) {
      return json({ error: 'BadRequest', message: 'accountDigest, conversationId, senderDeviceId, and (messageId or headerCounter) required' }, { status: 400 });
    }
    try {
      await ensureDataTables(env);
    } catch (err) {
      return json({ error: 'SchemaMissing', message: 'database not ready' }, { status: 500 });
    }

    let row = null;
    if (headerCounterNum !== null) {
      row = await env.DB.prepare(
        `SELECT wrapped_mk_json, wrap_context_json, direction, msg_type, header_counter, target_device_id, dr_state_snapshot, created_at
           FROM message_key_vault
          WHERE account_digest=?1 AND conversation_id=?2 AND sender_device_id=?3 AND header_counter=?4
          ORDER BY created_at DESC
          LIMIT 1`
      ).bind(accountDigest, conversationId, senderDeviceId, headerCounterNum).first();
    } else {
      row = await env.DB.prepare(
        `SELECT wrapped_mk_json, wrap_context_json, direction, msg_type, header_counter, target_device_id, dr_state_snapshot, created_at
           FROM message_key_vault
          WHERE account_digest=?1 AND conversation_id=?2 AND sender_device_id=?3 AND message_id=?4
          ORDER BY created_at DESC
          LIMIT 1`
      ).bind(accountDigest, conversationId, senderDeviceId, messageId).first();
    }

    if (!row) {
      logMessageKeyVault('get', {
        accountDigestSuffix4: accountDigest.slice(-4),
        conversationIdPrefix8: conversationId.slice(0, 8),
        messageIdPrefix8: messageId.slice(0, 8),
        senderDeviceIdSuffix4: senderDeviceId.slice(-4),
        found: false
      });
      return json({ error: 'NotFound', message: 'message key not found' }, { status: 404 });
    }
    logMessageKeyVault('get', {
      accountDigestSuffix4: accountDigest.slice(-4),
      conversationIdPrefix8: conversationId.slice(0, 8),
      messageIdPrefix8: messageId.slice(0, 8),
      senderDeviceIdSuffix4: senderDeviceId.slice(-4),
      found: true
    });
    return json({
      ok: true,
      wrapped_mk: safeJSON(row.wrapped_mk_json),
      wrap_context: safeJSON(row.wrap_context_json),
      dr_state: row.dr_state_snapshot || null,
      direction: row.direction || null,
      msg_type: row.msg_type || null,
      header_counter: Number(row.header_counter) || null,
      target_device_id: row.target_device_id || null,
      created_at: Number(row.created_at) || null
    });
  }

  if (req.method === 'POST' && (url.pathname === '/d1/message-key-vault/latest-state' || url.pathname === '/api/v1/message-key-vault/latest-state')) {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);

    if (!accountDigest || !conversationId) {
      return json({ error: 'BadRequest', message: 'accountDigest and conversationId required' }, { status: 400 });
    }
    try {
      await ensureDataTables(env);
    } catch (err) {
      return json({ error: 'SchemaMissing', message: 'database not ready' }, { status: 500 });
    }

    // Parallel fetch: Latest Outgoing (My Send) & Latest Incoming (My Receive)
    // Note: 'sender_device_id' in Vault is the person who emitted the message.
    // For Outgoing: sender_device_id should be one of MY devices (but we might check all my devices? or just the current one?)
    // Actually, DR State is device-specific. So we only care about state relevant to THIS device?
    // Wait. If I am restoring on specific device D1...
    // I want the state that D1 pushed (Outgoing) OR the state D1 received (Incoming target=D1).
    // The Vault stores:
    // account_digest = ME
    // sender_device_id = Sender
    // target_device_id = Receiver

    // Case 1: Latest Outgoing (I sent it)
    // account_digest=ME, sender_device_id=MY_DEV_ID (if passed) OR any of my devices?
    // Usually we want the specific device's chain.
    // If strict device binding: sender_device_id = passed senderDeviceId.

    // Case 2: Latest Incoming (I received it)
    // account_digest=ME, target_device_id=MY_DEV_ID.
    // AND sender_device_id=THE_PEER?
    // If we want "Latest Incoming from ANY peer", that's broad.
    // If we want "Latest state for this conversation", we usually mean "Between Me and Peer X".
    // But Vault index is (account, conv, msg_id).
    // It does NOT easily index "Latest by Conversation".
    // We have index `account_digest, conversation_id, message_id`.
    // We do NOT have an index on `created_at` or `header_counter` grouped by conversation!
    // Searching `WHERE account_digest=? AND conversation_id=? ORDER BY header_counter DESC` might be slow without index.
    // However, D1/SQLite might optimize if PK prefix matches.
    // Let's try to fetch both directions.

    // Optimization: If senderDeviceId is provided, we assume it's "Self Device ID" for outgoing matching.

    const [outgoingRow, incomingRow] = await Promise.all([
      // 1. Latest Outgoing (I sent)
      env.DB.prepare(
        `SELECT dr_state_snapshot, header_counter, created_at, sender_device_id
           FROM message_key_vault
          WHERE account_digest=?1 AND conversation_id=?2 AND direction='outgoing'
            ${senderDeviceId ? 'AND sender_device_id=?3' : ''}
          ORDER BY header_counter DESC
          LIMIT 1`
      ).bind(
        accountDigest,
        conversationId,
        ...(senderDeviceId ? [senderDeviceId] : [])
      ).first(),

      // 2. Latest Incoming (I received)
      // Note: We filter by direction='incoming'. we don't necessarily filter by sender_device_id unless we want specific peer.
      // Usually we want "Latest from anyone in this convo" (e.g. group) or "Latest from Peer" (DM).
      // Double Ratchet is 1:1. So Conversation = Peer in 1:1.
      // So simple 'incoming' check is sufficient for DM.
      env.DB.prepare(
        `SELECT dr_state_snapshot, header_counter, created_at, sender_device_id
           FROM message_key_vault
          WHERE account_digest=?1 AND conversation_id=?2 AND direction='incoming'
          ORDER BY header_counter DESC
          LIMIT 1`
      ).bind(accountDigest, conversationId).first()
    ]);

    return json({
      ok: true,
      outgoing: outgoingRow ? {
        dr_state: outgoingRow.dr_state_snapshot || null,
        header_counter: Number(outgoingRow.header_counter) || 0,
        created_at: Number(outgoingRow.created_at) || 0,
        sender_device_id: outgoingRow.sender_device_id
      } : null,
      incoming: incomingRow ? {
        dr_state: incomingRow.dr_state_snapshot || null,
        header_counter: Number(incomingRow.header_counter) || 0,
        created_at: Number(incomingRow.created_at) || 0,
        sender_device_id: incomingRow.sender_device_id
      } : null
    });
  }

  if (req.method === 'POST' && url.pathname === '/d1/message-key-vault/delete') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const messageId = normalizeMessageId(body?.messageId || body?.message_id);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);

    if (!accountDigest || !conversationId || !messageId || !senderDeviceId) {
      return json({ error: 'BadRequest', message: 'accountDigest, conversationId, messageId, senderDeviceId required' }, { status: 400 });
    }

    try {
      await ensureDataTables(env);
      const result = await env.DB.prepare(
        `DELETE FROM message_key_vault
          WHERE account_digest=?1 AND conversation_id=?2 AND message_id=?3 AND sender_device_id=?4`
      ).bind(accountDigest, conversationId, messageId, senderDeviceId).run();

      const deleted = result?.meta?.changes > 0;
      logMessageKeyVault('delete', {
        accountDigestSuffix4: accountDigest.slice(-4),
        conversationIdPrefix8: conversationId.slice(0, 8),
        messageIdPrefix8: messageId.slice(0, 8),
        senderDeviceIdSuffix4: senderDeviceId.slice(-4),
        deleted
      });
      return json({ ok: true, deleted });
    } catch (err) {
      console.warn('message_key_vault_delete_failed', err?.message || err);
      return json({ error: 'DeleteFailed', message: err?.message || 'unable to delete message key' }, { status: 500 });
    }
  }

  if (req.method === 'POST' && url.pathname === '/d1/message-key-vault/count') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const messageId = normalizeMessageId(body?.messageId || body?.message_id);

    if (!conversationId || !messageId) {
      return json({ error: 'BadRequest', message: 'conversationId, messageId required' }, { status: 400 });
    }

    try {
      await ensureDataTables(env);
    } catch (err) {
      // similar error handling if needed, usually ensureDataTables handles log
    }

    const row = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM message_key_vault
        WHERE conversation_id=?1 AND message_id=?2`
    ).bind(conversationId, messageId).first();

    const count = Number(row?.count || 0);
    return json({ ok: true, count });
  }

  return null;
}

async function handleGroupsRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/groups/create') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const groupId = normalizeGroupId(body?.groupId || body?.group_id);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const creatorAccountDigest = normalizeAccountDigest(body?.creatorAccountDigest || body?.creator_account_digest);
    const name = normalizeGroupName(body?.name);
    const avatarJson = normalizeGroupAvatar(body?.avatar || body?.avatarJson || body?.avatar_json);
    const membersInput = Array.isArray(body?.members) ? body.members : [];
    if (!groupId || !conversationId || !creatorAccountDigest) {
      return json({ error: 'BadRequest', message: 'groupId, conversationId, creatorAccountDigest required' }, { status: 400 });
    }

    await ensureDataTables(env);
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(`
        INSERT INTO groups (group_id, conversation_id, creator_account_digest, name, avatar_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(group_id) DO UPDATE SET
          conversation_id=excluded.conversation_id,
          name=excluded.name,
          avatar_json=excluded.avatar_json,
          updated_at=strftime('%s','now')
      `).bind(groupId, conversationId, creatorAccountDigest, name, avatarJson, now).run();
    } catch (err) {
      console.warn('group_create_failed', err?.message || err);
      return json({ error: 'CreateFailed', message: err?.message || 'unable to create group' }, { status: 500 });
    }

    await upsertGroupMember(env, {
      groupId,
      accountDigest: creatorAccountDigest,
      role: 'owner',
      status: 'active',
      inviterAccountDigest: creatorAccountDigest,
      joinedAt: now
    });
    await grantConversationAccess(env, { conversationId, accountDigest: creatorAccountDigest });

    const seenDigests = new Set([creatorAccountDigest]);
    for (const entry of membersInput) {
      const acct = normalizeAccountDigest(entry?.accountDigest || entry?.account_digest);
      if (!acct || seenDigests.has(acct)) continue;
      seenDigests.add(acct);
      const role = normalizeGroupRole(entry?.role);
      await upsertGroupMember(env, {
        groupId,
        accountDigest: acct,
        role,
        status: 'active',
        inviterAccountDigest: creatorAccountDigest,
        joinedAt: now
      });
      await grantConversationAccess(env, { conversationId, accountDigest: acct });
    }

    const detail = await fetchGroupWithMembers(env, groupId);
    return json(detail ? { ok: true, ...detail } : { ok: true, groupId });
  }

  if (req.method === 'POST' && url.pathname === '/d1/groups/members/add') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const groupId = normalizeGroupId(body?.groupId || body?.group_id);
    const membersInput = Array.isArray(body?.members) ? body.members : [];
    if (!groupId || !membersInput.length) {
      return json({ error: 'BadRequest', message: 'groupId and members required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const groupRow = await env.DB.prepare(`SELECT conversation_id FROM groups WHERE group_id=?1`).bind(groupId).all();
    const group = groupRow?.results?.[0] || null;
    if (!group) {
      return json({ error: 'NotFound', message: 'group not found' }, { status: 404 });
    }
    const conversationId = group.conversation_id;
    const now = Math.floor(Date.now() / 1000);
    let added = 0;
    for (const entry of membersInput) {
      const acct = normalizeAccountDigest(entry?.accountDigest || entry?.account_digest);
      if (!acct) continue;
      const role = normalizeGroupRole(entry?.role);
      const inviterAcct = normalizeAccountDigest(entry?.inviterAccountDigest || entry?.inviter_account_digest);
      await upsertGroupMember(env, {
        groupId,
        accountDigest: acct,
        role,
        status: 'active',
        inviterAccountDigest: inviterAcct,
        joinedAt: now
      });
      await grantConversationAccess(env, { conversationId, accountDigest: acct });
      added += 1;
    }
    const detail = await fetchGroupWithMembers(env, groupId);
    return json(detail ? { ok: true, added, ...detail } : { ok: true, added });
  }

  if (req.method === 'POST' && url.pathname === '/d1/groups/members/remove') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const groupId = normalizeGroupId(body?.groupId || body?.group_id);
    const membersInput = Array.isArray(body?.members) ? body.members : [];
    const statusOverride = normalizeGroupStatus(body?.status);
    if (!groupId || !membersInput.length) {
      return json({ error: 'BadRequest', message: 'groupId and members required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const groupRow = await env.DB.prepare(`SELECT conversation_id FROM groups WHERE group_id=?1`).bind(groupId).all();
    const group = groupRow?.results?.[0] || null;
    if (!group) {
      return json({ error: 'NotFound', message: 'group not found' }, { status: 404 });
    }
    const conversationId = group.conversation_id;
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;
    for (const entry of membersInput) {
      const acct = normalizeAccountDigest(entry?.accountDigest || entry?.account_digest);
      if (!acct) continue;
      const status = statusOverride || normalizeGroupStatus(entry?.status) || 'removed';
      try {
        await env.DB.prepare(`
          UPDATE group_members
             SET status=?3,
                 updated_at=strftime('%s','now')
           WHERE group_id=?1 AND account_digest=?2
        `).bind(groupId, acct, status).run();
        removed += 1;
      } catch (err) {
        console.warn('group_member_remove_failed', err?.message || err);
      }
      await removeConversationAccess(env, { conversationId, accountDigest: acct });
    }
    const detail = await fetchGroupWithMembers(env, groupId);
    return json(detail ? { ok: true, removed, ...detail } : { ok: true, removed });
  }

  if (req.method === 'GET' && url.pathname === '/d1/groups/get') {
    const groupId = normalizeGroupId(
      url.searchParams.get('groupId')
      || url.searchParams.get('group_id')
    );
    if (!groupId) {
      return json({ error: 'BadRequest', message: 'groupId required' }, { status: 400 });
    }
    const detail = await fetchGroupWithMembers(env, groupId);
    if (!detail) {
      return json({ error: 'NotFound', message: 'group not found' }, { status: 404 });
    }
    return json({ ok: true, ...detail });
  }

  return null;
}

async function handleMediaRoutes(req, env) {
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === '/d1/media/usage') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const convIdRaw = body?.convId ?? body?.conversationId;
    if (!convIdRaw || typeof convIdRaw !== 'string') {
      return json({ error: 'BadRequest', message: 'convId required' }, { status: 400 });
    }
    const convId = normalizeConversationId(convIdRaw);
    if (!convId) {
      return json({ error: 'BadRequest', message: 'invalid convId' }, { status: 400 });
    }
    const prefixRaw = typeof body?.prefix === 'string' ? body.prefix.trim() : '';
    let prefix = prefixRaw || convId;
    prefix = prefix.replace(/[\u0000-\u001F\u007F]/gu, '');
    if (!prefix.startsWith(convId)) {
      prefix = convId;
    }
    const ensureSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    let totalBytes = 0;
    let objectCount = 0;
    try {
      const stmt = await env.DB.prepare(`
        SELECT
          COALESCE(SUM(COALESCE(size_bytes, 0)), 0) AS total_bytes,
          COUNT(*) AS object_count
        FROM attachments
        WHERE conversation_id=?1
          AND object_key LIKE ?2
      `).bind(convId, `${ensureSlash}%`).all();
      const row = stmt?.results?.[0] || null;
      totalBytes = Number(row?.total_bytes ?? 0);
      objectCount = Number(row?.object_count ?? 0);
    } catch (err) {
      console.warn('media usage query failed', err?.message || err);
      return json({ error: 'UsageQueryFailed', message: err?.message || 'media usage query failed' }, { status: 500 });
    }
    return json({
      ok: true,
      convId,
      prefix,
      totalBytes,
      objectCount
    });
  }
  return null;
}

async function handleConversationRoutes(req, env) {
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === '/d1/conversations/authorize') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    if (!conversationId) {
      return json({ error: 'BadRequest', message: 'conversationId required' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    const deviceId = normalizeDeviceId(body?.deviceId || body?.device_id) || null;
    if (!deviceId) {
      return json({ error: 'BadRequest', message: 'deviceId required' }, { status: 400 });
    }
    await ensureDataTables(env);
    let deviceExists = false;
    try {
      const devRow = await env.DB.prepare(
        `SELECT 1 FROM devices WHERE account_digest=?1 AND device_id=?2`
      ).bind(accountDigest, deviceId).first();
      deviceExists = !!devRow;
    } catch (err) {
      console.warn('device_lookup_failed', err?.message || err);
    }
    if (!deviceExists) {
      return json({ error: 'DeviceNotFound', message: 'device not registered' }, { status: 404 });
    }
    let row;
    try {
      const res = await env.DB.prepare(
        `SELECT device_id FROM conversation_acl WHERE conversation_id=?1 AND account_digest=?2 AND (device_id=?3 OR device_id IS NULL)`
      ).bind(conversationId, accountDigest, deviceId).all();
      row = res?.results?.[0] || null;
    } catch (err) {
      console.warn('conversation_acl_query_failed', err?.message || err);
      return json({ error: 'ConversationLookupFailed', message: err?.message || 'lookup failed' }, { status: 500 });
    }
    if (!row) {
      await grantConversationAccess(env, { conversationId, accountDigest, deviceId });
      return json({ ok: true, created: true });
    }
    if (row?.device_id === null) {
      await grantConversationAccess(env, { conversationId, accountDigest, deviceId });
    }
    return json({ ok: true, deviceId });
  }
  return null;
}

async function handleSubscriptionRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/subscription/redeem') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const digest = normalizeAccountDigest(body?.digest || body?.accountDigest || body?.account_digest || body?.usedByDigest || body?.used_by_digest);
    const tokenId = typeof body?.tokenId === 'string' ? body.tokenId.trim() : (typeof body?.token_id === 'string' ? body.token_id.trim() : (typeof body?.voucherId === 'string' ? body.voucherId.trim() : null));
    const jti = typeof body?.jti === 'string' ? body.jti.trim() : null;
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : null;
    const keyId = typeof body?.keyId === 'string' ? body.keyId.trim() : 'default';
    const signatureB64 = typeof body?.signatureB64 === 'string' ? body.signatureB64.trim() : (typeof body?.signature_b64 === 'string' ? body.signature_b64.trim() : null);
    const issuedAt = Number(body?.issuedAt || body?.issued_at || 0);
    const durationDays = Number(body?.durationDays || body?.extend_days || 0);
    const dryRun = body?.dryRun === true;
    if (!digest) {
      return json({ error: 'BadRequest', message: 'digest required' }, { status: 400 });
    }
    if (!tokenId && !jti) {
      return json({ error: 'BadRequest', message: 'tokenId required' }, { status: 400 });
    }
    const tokenKey = tokenId || jti;
    if (!Number.isFinite(durationDays) || durationDays <= 0) {
      return json({ error: 'BadRequest', message: 'durationDays required' }, { status: 400 });
    }
    const now = Math.floor(Date.now() / 1000);
    const durationSeconds = Math.floor(durationDays * 86400);

    let currentExpires = 0;
    try {
      const row = await env.DB.prepare(`SELECT expires_at FROM subscriptions WHERE digest=?1`).bind(digest).all();
      currentExpires = Number(row?.results?.[0]?.expires_at || 0);
    } catch (err) {
      console.warn('subscription_lookup_failed', err?.message || err);
    }
    const base = Math.max(currentExpires, now);
    const newExpires = base + durationSeconds;

    if (dryRun) {
      return json({
        ok: true,
        dryRun: true,
        tokenId: tokenKey,
        digest,
        currentExpires,
        expiresAt: newExpires,
        durationDays
      });
    }

    try {
      const existingToken = await env.DB.prepare(
        `SELECT token_id, status, used_at, used_by_digest FROM tokens WHERE token_id=?1`
      ).bind(tokenKey).all();
      const tokenRow = existingToken?.results?.[0] || null;
      if (tokenRow && tokenRow.status === 'used') {
        return json({
          error: 'TokenUsed',
          message: '憑證已被使用',
          tokenId: tokenKey,
          used_at: tokenRow.used_at || null,
          used_by_digest: tokenRow.used_by_digest || null
        }, { status: 409 });
      }

      const batch = [];
      batch.push(env.DB.prepare(
        `INSERT INTO subscriptions (digest, expires_at, updated_at, created_at)
           VALUES (?1, ?2, strftime('%s','now'), strftime('%s','now'))
           ON CONFLICT(digest) DO UPDATE SET expires_at=excluded.expires_at, updated_at=strftime('%s','now')`
      ).bind(digest, newExpires));

      batch.push(env.DB.prepare(
        `INSERT INTO tokens (token_id, digest, issued_at, extend_days, nonce, key_id, signature_b64, status, used_at, used_by_digest, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'used', ?8, ?9, strftime('%s','now'))
           ON CONFLICT(token_id) DO UPDATE SET digest=excluded.digest, extend_days=excluded.extend_days, key_id=excluded.key_id, signature_b64=excluded.signature_b64, status='used', used_at=excluded.used_at, used_by_digest=excluded.used_by_digest`
      ).bind(
        tokenKey,
        digest,
        Number.isFinite(issuedAt) && issuedAt > 0 ? issuedAt : now,
        durationDays,
        typeof body?.nonce === 'string' ? body.nonce.trim() : null,
        keyId,
        signatureB64 || '',
        now,
        digest
      ));

      batch.push(env.DB.prepare(
        `INSERT INTO extend_logs (token_id, digest, extend_days, expires_at_after, used_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))`
      ).bind(tokenKey, digest, durationDays, newExpires, now));

      await env.DB.batch(batch);
    } catch (err) {
      console.error('subscription_redeem_failed', err?.message || err);
      const msg = err?.message || '展期失敗，請稍後再試';
      return json({ error: 'RedeemFailed', message: msg }, { status: 500 });
    }

    return json({
      ok: true,
      tokenId: tokenKey,
      digest,
      currentExpires,
      expiresAt: newExpires,
      durationDays,
      usedAt: now,
      agentId: agentId || null
    });
  }

  if (req.method === 'GET' && url.pathname === '/d1/subscription/status') {
    await ensureDataTables(env);
    const digest = normalizeAccountDigest(url.searchParams.get('digest'));
    const uidDigest = normalizeAccountDigest(url.searchParams.get('uidDigest') || url.searchParams.get('uid_digest'));
    const limitRaw = url.searchParams.get('limit');
    const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Math.floor(Number(limitRaw)), 1), 200) : 50;
    let targetDigest = digest || null;
    if (!targetDigest && uidDigest) {
      try {
        const acct = await env.DB.prepare(
          `SELECT account_digest FROM accounts WHERE uid_digest=?1`
        ).bind(uidDigest).first();
        targetDigest = acct?.account_digest || null;
      } catch (err) {
        console.warn('subscription_uid_lookup_failed', err?.message || err);
      }
    }
    if (!targetDigest) {
      return json({ error: 'BadRequest', message: 'digest required' }, { status: 400 });
    }
    let record = null;
    let accountCreatedAt = null;
    let logs = [];
    try {
      const row = await env.DB.prepare(
        `SELECT digest, expires_at, updated_at FROM subscriptions WHERE digest=?1`
      ).bind(targetDigest).all();
      record = row?.results?.[0] || null;
    } catch (err) {
      console.warn('subscription_status_query_failed', err?.message || err);
    }
    try {
      const acctRow = await env.DB.prepare(
        `SELECT created_at FROM accounts WHERE account_digest=?1`
      ).bind(targetDigest).all();
      const acct = acctRow?.results?.[0] || null;
      accountCreatedAt = acct?.created_at ? Number(acct.created_at) : null;
    } catch (err) {
      console.warn('subscription_account_query_failed', err?.message || err);
    }
    try {
      const logRows = await env.DB.prepare(
        `SELECT l.token_id, l.extend_days, l.expires_at_after, l.used_at, t.status, t.key_id, t.created_at
           FROM extend_logs l
           LEFT JOIN tokens t ON l.token_id = t.token_id
          WHERE l.digest=?1
          ORDER BY l.used_at DESC
          LIMIT ?2`
      ).bind(targetDigest, limit).all();
      logs = Array.isArray(logRows?.results) ? logRows.results : [];
    } catch (err) {
      console.warn('subscription_logs_query_failed', err?.message || err);
    }
    if (!record) {
      return json({ ok: true, found: false, digest: targetDigest, now: Math.floor(Date.now() / 1000), account_created_at: accountCreatedAt, logs });
    }
    const now = Math.floor(Date.now() / 1000);
    return json({
      ok: true,
      found: true,
      digest: targetDigest,
      expires_at: Number(record.expires_at || 0),
      updated_at: Number(record.updated_at || 0),
      now,
      account_created_at: accountCreatedAt,
      logs
    });
  }

  if (req.method === 'GET' && url.pathname === '/d1/subscription/token-status') {
    await ensureDataTables(env);
    const tokenId = url.searchParams.get('tokenId') || url.searchParams.get('voucherId') || url.searchParams.get('jti');
    const tokenKey = typeof tokenId === 'string' ? tokenId.trim() : '';
    if (!tokenKey) {
      return json({ error: 'BadRequest', message: 'tokenId required' }, { status: 400 });
    }
    try {
      const row = await env.DB.prepare(
        `SELECT token_id, digest, issued_at, extend_days, nonce, key_id, signature_b64, status, used_at, used_by_digest, created_at
           FROM tokens
          WHERE token_id=?1`
      ).bind(tokenKey).all();
      const token = row?.results?.[0] || null;
      if (!token) {
        return json({ ok: true, found: false, tokenId: tokenKey });
      }
      let lastLog = null;
      try {
        const logRow = await env.DB.prepare(
          `SELECT expires_at_after, used_at, extend_days
             FROM extend_logs
            WHERE token_id=?1
            ORDER BY used_at DESC
            LIMIT 1`
        ).bind(tokenKey).all();
        lastLog = logRow?.results?.[0] || null;
      } catch (err) {
        console.warn('token_log_query_failed', err?.message || err);
      }
      return json({
        ok: true,
        found: true,
        tokenId: token.token_id,
        digest: token.digest,
        issued_at: Number(token.issued_at || 0),
        extend_days: Number(token.extend_days || 0),
        key_id: token.key_id || null,
        signature_b64: token.signature_b64 || null,
        status: token.status || null,
        used_at: token.used_at ? Number(token.used_at) : null,
        used_by_digest: token.used_by_digest || null,
        created_at: Number(token.created_at || 0) || null,
        expires_at_after: lastLog?.expires_at_after || null,
        last_extend_days: lastLog?.extend_days || null
      });
    } catch (err) {
      console.error('token_status_failed', err?.message || err);
      return json({ error: 'TokenStatusFailed', message: err?.message || 'query failed' }, { status: 500 });
    }
  }

  return null;
}

async function handleCallsRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/calls/session') {
    await cleanupCallTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const result = await upsertCallSession(env, body || {});
    if (!result.ok) {
      return json({ error: result.error || 'CallSessionUpsertFailed', message: result.message || 'unable to store call session' }, { status: result.status || 400 });
    }
    return json({ ok: true, session: result.session });
  }

  if (req.method === 'GET' && url.pathname === '/d1/calls/session') {
    await cleanupCallTables(env);
    const callId = normalizeCallId(url.searchParams.get('callId') || url.searchParams.get('call_id') || url.searchParams.get('id'));
    if (!callId) {
      return json({ error: 'BadRequest', message: 'callId required' }, { status: 400 });
    }
    const rows = await env.DB.prepare(
      `SELECT * FROM call_sessions WHERE call_id=?1`
    ).bind(callId).all();
    const row = rows?.results?.[0];
    if (!row) {
      return json({ error: 'NotFound', message: 'call session not found' }, { status: 404 });
    }
    return json({ ok: true, session: serializeCallSessionRow(row) });
  }

  if (req.method === 'POST' && url.pathname === '/d1/calls/events') {
    await cleanupCallTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const result = await insertCallEvent(env, body || {});
    if (!result.ok) {
      return json({ error: result.error || 'CallEventInsertFailed', message: result.message || 'unable to store call event' }, { status: result.status || 400 });
    }
    return json({ ok: true, event: result.event });
  }

  if (req.method === 'GET' && url.pathname === '/d1/calls/events') {
    await cleanupCallTables(env);
    const callId = normalizeCallId(url.searchParams.get('callId') || url.searchParams.get('call_id') || url.searchParams.get('id'));
    if (!callId) {
      return json({ error: 'BadRequest', message: 'callId required' }, { status: 400 });
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
    const rows = await env.DB.prepare(
      `SELECT event_id, call_id, type, payload_json, from_account_digest, to_account_digest, trace_id, created_at
         FROM call_events
        WHERE call_id=?1
        ORDER BY created_at DESC
        LIMIT ?2`
    ).bind(callId, limit).all();
    const events = (rows?.results || []).map((row) => ({
      event_id: row.event_id,
      call_id: row.call_id,
      type: row.type,
      payload: safeJSON(row.payload_json),
      from_account_digest: row.from_account_digest || null,
      to_account_digest: row.to_account_digest || null,
      trace_id: row.trace_id || null,
      created_at: Number(row.created_at) || null
    }));
    return json({ ok: true, events });
  }

  return null;
}

async function handleDeviceRoutes(req, env) {
  const url = new URL(req.url);
  const now = Math.floor(Date.now() / 1000);

  if (req.method === 'POST' && url.pathname === '/d1/devices/upsert') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const deviceId = normalizeDeviceId(body?.deviceId || body?.device_id);
    const label = typeof body?.label === 'string' ? body.label.trim() : null;
    if (!accountDigest || !deviceId) {
      return json({ error: 'BadRequest', message: 'accountDigest and deviceId required' }, { status: 400 });
    }
    try {
      await env.DB.prepare(
        `INSERT INTO devices (account_digest, device_id, label, status, last_seen_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'active', ?4, ?4, ?4)
         ON CONFLICT(account_digest, device_id) DO UPDATE SET
           label=COALESCE(excluded.label, devices.label),
           status='active',
           last_seen_at=?4,
           updated_at=?4`
      ).bind(accountDigest, deviceId, label, now).run();
      return json({ ok: true });
    } catch (err) {
      console.error('device_upsert_failed', err?.message || err);
      return json({ error: 'DeviceUpsertFailed', message: err?.message || 'device upsert failed' }, { status: 500 });
    }
  }

  if (req.method === 'GET' && url.pathname === '/d1/devices/check') {
    await ensureDataTables(env);
    const accountDigest = normalizeAccountDigest(url.searchParams.get('accountDigest') || url.searchParams.get('account_digest'));
    const deviceId = normalizeDeviceId(url.searchParams.get('deviceId') || url.searchParams.get('device_id'));
    if (!accountDigest || !deviceId) {
      return json({ error: 'BadRequest', message: 'accountDigest and deviceId required' }, { status: 400 });
    }
    try {
      const rows = await env.DB.prepare(
        `SELECT status, last_seen_at, created_at FROM devices WHERE account_digest=?1 AND device_id=?2`
      ).bind(accountDigest, deviceId).all();
      const row = rows?.results?.[0] || null;
      if (!row) {
        return json({ ok: false, status: null });
      }
      return json({
        ok: row.status === 'active',
        status: row.status || null,
        last_seen_at: Number(row.last_seen_at) || null,
        created_at: Number(row.created_at) || null
      });
    } catch (err) {
      console.error('device_check_failed', err?.message || err);
      return json({ error: 'DeviceCheckFailed', message: err?.message || 'device check failed' }, { status: 500 });
    }
  }

  if (req.method === 'GET' && url.pathname === '/d1/devices/active') {
    await ensureDataTables(env);
    const accountDigest = normalizeAccountDigest(url.searchParams.get('accountDigest') || url.searchParams.get('account_digest'));
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    try {
      const rows = await env.DB.prepare(
        `SELECT device_id, status, last_seen_at, created_at, label
           FROM devices
          WHERE account_digest=?1 AND status='active'
          ORDER BY (last_seen_at IS NOT NULL) DESC, last_seen_at DESC, created_at DESC`
      ).bind(accountDigest).all();
      const devices = (rows?.results || []).map((row) => ({
        device_id: row.device_id,
        status: row.status,
        last_seen_at: row.last_seen_at != null ? Number(row.last_seen_at) : null,
        created_at: row.created_at != null ? Number(row.created_at) : null,
        label: row.label || null
      }));
      return json({ devices });
    } catch (err) {
      console.error('device_active_list_failed', err?.message || err);
      return json({ error: 'DeviceListFailed', message: err?.message || 'device list failed' }, { status: 500 });
    }
  }

  return null;
}



async function handleContactsRoutes(req, env) {
  const url = new URL(req.url);

  // POST /d1/contacts/upsert
  if (req.method === 'POST' && url.pathname === '/d1/contacts/upsert') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body.accountDigest || body.account_digest);
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    const contacts = Array.isArray(body.contacts) ? body.contacts : [];
    if (!contacts.length) {
      return json({ ok: true, count: 0 }); // nothing to do
    }

    let count = 0;
    // Batch upsert? or loop. Parallel prepared statements is usually fine for D1.
    // For large lists, strict batching might be needed, but for contact list sync (usually incremental or < 1000), sequential/parallel is okay.

    // We'll use a transaction if possible, or just Promise.all
    // D1 `batch` API is available on `env.DB`.

    const stmts = [];
    for (const item of contacts) {
      const peerDigest = normalizeAccountDigest(item.peerDigest || item.peer_digest);
      if (!peerDigest) continue;
      const blob = typeof item.encryptedBlob === 'string' ? item.encryptedBlob : null;
      const isBlocked = item.isBlocked === true || item.isBlocked === 1 ? 1 : 0;

      stmts.push(env.DB.prepare(`
        INSERT INTO contacts (owner_digest, peer_digest, encrypted_blob, is_blocked, updated_at)
        VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))
        ON CONFLICT(owner_digest, peer_digest) DO UPDATE SET
          encrypted_blob = COALESCE(excluded.encrypted_blob, contacts.encrypted_blob),
          is_blocked = COALESCE(excluded.is_blocked, contacts.is_blocked),
          updated_at = strftime('%s','now')
      `).bind(accountDigest, peerDigest, blob, isBlocked));
    }

    if (stmts.length) {
      try {
        const results = await env.DB.batch(stmts);
        count = results.length;
      } catch (err) {
        console.error('contacts_upsert_failed', err);
        return json({ error: 'UpsertFailed', message: err?.message || 'db error' }, { status: 500 });
      }
    }
    return json({ ok: true, count });
  }

  // GET /d1/contacts/snapshot
  if (req.method === 'GET' && url.pathname === '/d1/contacts/snapshot') {
    await ensureDataTables(env);
    const accountDigest = normalizeAccountDigest(
      url.searchParams.get('accountDigest')
      || url.searchParams.get('account_digest')
      || req.headers.get('x-account-digest')
    );
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required (checked QS and Headers)' }, { status: 400 });
    }

    try {
      const rows = await env.DB.prepare(`
        SELECT peer_digest, encrypted_blob, is_blocked, updated_at
          FROM contacts
         WHERE owner_digest = ?1
      `).bind(accountDigest).all();

      const contacts = (rows?.results || []).map(r => ({
        peer_digest: r.peer_digest,
        encrypted_blob: r.encrypted_blob || null,
        is_blocked: r.is_blocked === 1,
        updated_at: Number(r.updated_at) || 0
      }));

      return json({ ok: true, contacts });
    } catch (err) {
      console.error('contacts_snapshot_failed', err);
      return json({ error: 'SnapshotFailed', message: err?.message }, { status: 500 });
    }
  }

  return null;
}

async function handleAccountsRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'GET' && url.pathname === '/d1/account/evidence') {
    const accountDigest = normalizeAccountDigest(
      url.searchParams.get('accountDigest')
      || url.searchParams.get('account_digest')
      || url.searchParams.get('digest')
    );
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    try {
      await ensureDataTables(env);
    } catch (err) {
      return json({ error: 'EnsureTablesFailed', message: err?.message || 'ensureDataTables failed' }, { status: 500 });
    }
    const evidence = {
      backup_exists: false,
      vault_exists: false,
      messages_exists: false,
      backup_device_id: null,
      backup_device_label: null,
      backup_updated_at: null,
      registry_device_id: null,
      registry_device_label: null
    };
    try {
      const row = await env.DB.prepare(
        `SELECT device_id, device_label, updated_at
           FROM contact_secret_backups
          WHERE account_digest=?1
          ORDER BY updated_at DESC, id DESC
          LIMIT 1`
      ).bind(accountDigest).first();
      if (row) {
        evidence.backup_exists = true;
        evidence.backup_device_id = row.device_id || null;
        evidence.backup_device_label = row.device_label || null;
        evidence.backup_updated_at = row.updated_at != null ? Number(row.updated_at) : null;
      }
    } catch (err) {
      return json({ error: 'BackupEvidenceFailed', message: err?.message || 'backup evidence query failed' }, { status: 500 });
    }
    try {
      const row = await env.DB.prepare(
        `SELECT 1 FROM message_key_vault WHERE account_digest=?1 LIMIT 1`
      ).bind(accountDigest).first();
      evidence.vault_exists = !!row;
    } catch (err) {
      return json({ error: 'VaultEvidenceFailed', message: err?.message || 'vault evidence query failed' }, { status: 500 });
    }
    try {
      const row = await env.DB.prepare(
        `SELECT 1 FROM messages_secure
           WHERE sender_account_digest=?1 OR receiver_account_digest=?1
           LIMIT 1`
      ).bind(accountDigest).first();
      evidence.messages_exists = !!row;
    } catch (err) {
      return json({ error: 'MessagesEvidenceFailed', message: err?.message || 'messages evidence query failed' }, { status: 500 });
    }
    try {
      const row = await env.DB.prepare(
        `SELECT device_id, label
           FROM devices
          WHERE account_digest=?1 AND status='active'
          ORDER BY (last_seen_at IS NOT NULL) DESC, last_seen_at DESC, created_at DESC
          LIMIT 1`
      ).bind(accountDigest).first();
      if (row) {
        evidence.registry_device_id = row.device_id || null;
        evidence.registry_device_label = row.label || null;
      }
    } catch (err) {
      return json({ error: 'DeviceEvidenceFailed', message: err?.message || 'device evidence query failed' }, { status: 500 });
    }
    return json({ ok: true, account_digest: accountDigest, evidence });
  }

  if (req.method === 'POST' && url.pathname === '/d1/accounts/verify') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountTokenRaw = body?.accountToken || body?.account_token;
    const accountDigestRaw = body?.accountDigest || body?.account_digest;
    const accountToken = typeof accountTokenRaw === 'string' && accountTokenRaw.trim().length ? accountTokenRaw.trim() : null;
    const accountDigest = typeof accountDigestRaw === 'string' && accountDigestRaw.trim().length ? normalizeAccountDigest(accountDigestRaw) : null;
    if (!accountToken && !accountDigest) {
      return json({ error: 'BadRequest', message: 'accountToken or accountDigest required' }, { status: 400 });
    }
    try {
      const account = await resolveAccount(
        env,
        { accountToken, accountDigest },
        { allowCreate: false, preferredAccountToken: accountToken || null, preferredAccountDigest: accountDigest || null }
      );
      if (!account) {
        return json({ error: 'NotFound' }, { status: 404 });
      }
      return json({
        ok: true,
        account_digest: account.account_digest
      });
    } catch (err) {
      return json({ error: 'VerifyFailed', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
  }

  if (req.method === 'GET' && url.pathname === '/d1/accounts/created') {
    let accountDigest = normalizeAccountDigest(
      url.searchParams.get('accountDigest')
      || url.searchParams.get('account_digest')
      || url.searchParams.get('digest')
    );
    const uidDigest = normalizeAccountDigest(
      url.searchParams.get('uidDigest')
      || url.searchParams.get('uid_digest')
    );

    if (!accountDigest && uidDigest) {
      try {
        const row = await env.DB.prepare(
          `SELECT account_digest FROM accounts WHERE uid_digest=?1`
        ).bind(uidDigest).first();
        accountDigest = row?.account_digest || null;
      } catch (err) {
        console.warn('accounts_created_uid_lookup_failed', err?.message || err);
      }
    }

    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    const rows = await env.DB.prepare(
      `SELECT account_digest, created_at FROM accounts WHERE account_digest=?1`
    ).bind(accountDigest).all();
    const row = rows?.results?.[0] || null;
    if (!row) {
      return json({ error: 'NotFound', message: 'account not found' }, { status: 404 });
    }
    return json({
      account_digest: row.account_digest,
      created_at: Number(row.created_at) || null
    });
  }

  if (req.method === 'POST' && url.pathname === '/d1/accounts/purge') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    let accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const uidDigest = normalizeAccountDigest(body?.uidDigest || body?.uid_digest);
    const dryRun = body?.dryRun === true;

    if (!accountDigest && uidDigest) {
      try {
        const row = await env.DB.prepare(
          `SELECT account_digest FROM accounts WHERE uid_digest=?1`
        ).bind(uidDigest).first();
        accountDigest = normalizeAccountDigest(row?.account_digest);
      } catch (err) {
        console.warn('account_purge_uid_lookup_failed', err?.message || err);
      }
    }

    if (!accountDigest) {
      return json({ ok: true, skipped: true, reason: 'accountDigest not found' });
    }

    const convIds = new Set([
      `contacts-${accountDigest}`,
      `profile-${accountDigest}`,
      `settings-${accountDigest}`,
      `drive-${accountDigest}`,
      `avatar-${accountDigest}`
    ]);
    const groupIds = new Set();
    const prefixes = new Set();

    const addConv = (id) => {
      if (!id) return;
      const normalized = normalizeConversationId(id);
      if (normalized) convIds.add(normalized);
    };

    const addGroup = (id) => {
      if (!id) return;
      const norm = String(id || '').trim();
      if (norm) groupIds.add(norm);
    };

    try {
      const rows = await env.DB.prepare(
        `SELECT conversation_id FROM conversation_acl WHERE account_digest=?1`
      ).bind(accountDigest).all();
      for (const row of rows?.results || []) addConv(row?.conversation_id);
    } catch (err) {
      console.warn('account_purge_conv_acl_lookup_failed', err?.message || err);
    }

    try {
      const creatorGroups = await env.DB.prepare(
        `SELECT group_id, conversation_id FROM groups WHERE creator_account_digest=?1`
      ).bind(accountDigest).all();
      for (const row of creatorGroups?.results || []) {
        addGroup(row?.group_id);
        addConv(row?.conversation_id);
      }
      const memberGroups = await env.DB.prepare(
        `SELECT gm.group_id, g.conversation_id
           FROM group_members gm
           JOIN groups g ON gm.group_id = g.group_id
          WHERE gm.account_digest=?1`
      ).bind(accountDigest).all();
      for (const row of memberGroups?.results || []) {
        addGroup(row?.group_id);
        addConv(row?.conversation_id);
      }
    } catch (err) {
      console.warn('account_purge_group_lookup_failed', err?.message || err);
    }

    const mediaKeys = new Set();
    if (convIds.size) {
      const convList = Array.from(convIds);
      const placeholders = convList.map((_, i) => `?${i + 1}`).join(',');
      try {
        const rows = await env.DB.prepare(
          `SELECT obj_key FROM media_objects WHERE conv_id IN (${placeholders})`
        ).bind(...convList).all();
        for (const row of rows?.results || []) {
          if (row?.obj_key) mediaKeys.add(row.obj_key);
        }
      } catch (err) {
        console.warn('account_purge_media_lookup_failed', err?.message || err);
      }
    }

    for (const convId of convIds) {
      prefixes.add(`${convId}/`);
    }

    if (dryRun) {
      return json({
        ok: true,
        dryRun: true,
        accountDigest,
        convIds: Array.from(convIds),
        groupIds: Array.from(groupIds),
        mediaKeys: Array.from(mediaKeys),
        prefixes: Array.from(prefixes)
      });
    }

    const del = async (sql, params = []) => {
      try {
        const res = await env.DB.prepare(sql).bind(...params).run();
        return res?.meta?.changes || 0;
      } catch (err) {
        console.warn('account_purge_delete_failed', { sql: sql.slice(0, 64), error: err?.message || err });
        return 0;
      }
    };

    const convList = Array.from(convIds);
    const convPlaceholders = convList.length ? convList.map((_, i) => `?${i + 1}`).join(',') : '';
    const groupList = Array.from(groupIds);
    const groupPlaceholders = groupList.length ? groupList.map((_, i) => `?${i + 1}`).join(',') : '';

    const summary = {};
    if (convList.length) {
      summary.messagesSecure = await del(
        `DELETE FROM messages_secure WHERE conversation_id IN (${convPlaceholders})`,
        convList
      );
      summary.attachments = await del(
        `DELETE FROM attachments WHERE conversation_id IN (${convPlaceholders})`,
        convList
      );
      summary.messages = await del(
        `DELETE FROM messages WHERE conv_id IN (${convPlaceholders})`,
        convList
      );
      summary.mediaObjects = await del(
        `DELETE FROM media_objects WHERE conv_id IN (${convPlaceholders})`,
        convList
      );
      summary.conversationAcl = await del(
        `DELETE FROM conversation_acl WHERE conversation_id IN (${convPlaceholders})`,
        convList
      );
      summary.conversations = await del(
        `DELETE FROM conversations WHERE id IN (${convPlaceholders})`,
        convList
      );
    }

    let callIds = [];
    try {
      const rows = await env.DB.prepare(
        `SELECT call_id FROM call_sessions WHERE caller_account_digest=?1 OR callee_account_digest=?1`
      ).bind(accountDigest).all();
      callIds = (rows?.results || []).map(r => r?.call_id).filter(Boolean);
    } catch (err) {
      console.warn('account_purge_call_lookup_failed', err?.message || err);
    }
    if (callIds.length) {
      const placeholders = callIds.map((_, i) => `?${i + 1}`).join(',');
      summary.callEvents = await del(
        `DELETE FROM call_events WHERE call_id IN (${placeholders})`,
        callIds
      );
      summary.callSessions = await del(
        `DELETE FROM call_sessions WHERE call_id IN (${placeholders})`,
        callIds
      );
    } else {
      summary.callEvents = await del(
        `DELETE FROM call_events WHERE from_account_digest=?1 OR to_account_digest=?1`,
        [accountDigest]
      );
      summary.callSessions = await del(
        `DELETE FROM call_sessions WHERE caller_account_digest=?1 OR callee_account_digest=?1`,
        [accountDigest]
      );
    }

    summary.contactSecretBackups = await del(
      `DELETE FROM contact_secret_backups WHERE account_digest=?1`,
      [accountDigest]
    );

    if (groupList.length) {
      summary.groupInvites = await del(
        `DELETE FROM group_invites WHERE group_id IN (${groupPlaceholders})`,
        groupList
      );
      summary.groupMembers = await del(
        `DELETE FROM group_members WHERE group_id IN (${groupPlaceholders})`,
        groupList
      );
      summary.groups = await del(
        `DELETE FROM groups WHERE group_id IN (${groupPlaceholders})`,
        groupList
      );
    } else {
      summary.groupMembers = await del(
        `DELETE FROM group_members WHERE account_digest=?1`,
        [accountDigest]
      );
    }

    summary.extendLogs = await del(
      `DELETE FROM extend_logs WHERE digest=?1`,
      [accountDigest]
    );
    summary.tokens = await del(
      `DELETE FROM tokens WHERE digest=?1`,
      [accountDigest]
    );
    summary.subscriptions = await del(
      `DELETE FROM subscriptions WHERE digest=?1`,
      [accountDigest]
    );

    summary.prekeyOpk = await del(
      `DELETE FROM prekey_opk WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.prekeyUsers = await del(
      `DELETE FROM prekey_users WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.deviceBackup = await del(
      `DELETE FROM device_backup WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.deviceOpks = await del(
      `DELETE FROM device_opks WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.deviceSignedPrekeys = await del(
      `DELETE FROM device_signed_prekeys WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.devices = await del(
      `DELETE FROM devices WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.opaqueRecords = await del(
      `DELETE FROM opaque_records WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.accounts = await del(
      `DELETE FROM accounts WHERE account_digest=?1`,
      [accountDigest]
    );

    if (convList.length) {
      summary.conversationAclCleanup = await del(
        `DELETE FROM conversation_acl WHERE conversation_id IN (${convPlaceholders})`,
        convList
      );
    }

    return json({
      ok: true,
      accountDigest,
      convIds: Array.from(convIds),
      groupIds: Array.from(groupIds),
      mediaKeys: Array.from(mediaKeys),
      prefixes: Array.from(prefixes),
      summary
    });
  }

  // GET /d1/accounts/brand?uid=<hex> — lightweight brand lookup by UID
  // Returns brand info without requiring full SDM exchange.
  // Used by frontend to show brand on splash screen while exchange is in progress.
  if (req.method === 'GET' && url.pathname === '/d1/accounts/brand') {
    const uidHex = normalizeUid(url.searchParams.get('uid'));
    if (!uidHex) {
      return json({ error: 'BadRequest', message: 'uid query parameter required (14+ hex)' }, { status: 400 });
    }
    try {
      await ensureDataTables(env);
      const uidDigest = await hashUidToDigest(env, uidHex);
      const row = await env.DB.prepare(
        `SELECT brand, brand_name, brand_logo FROM accounts WHERE uid_digest=?1`
      ).bind(uidDigest).first();
      if (!row) {
        return json({ brand: null, brand_name: null, brand_logo: null });
      }
      return json({
        brand: row.brand || null,
        brand_name: row.brand_name || null,
        brand_logo: row.brand_logo || null
      });
    } catch (err) {
      return json({ error: 'LookupFailed', message: err?.message || 'brand lookup failed' }, { status: 500 });
    }
  }

  // POST /d1/accounts/set-brand — admin sets brand for account(s)
  if (req.method === 'POST' && url.pathname === '/d1/accounts/set-brand') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }

    const brand = body?.brand !== undefined ? (body.brand || null) : undefined;
    if (brand === undefined) {
      return json({ error: 'BadRequest', message: 'brand field required (string or null to clear)' }, { status: 400 });
    }
    const brandName = body?.brandName || body?.brand_name || null;
    const brandLogo = body?.brandLogo || body?.brand_logo || null;

    // Support single or batch: accountDigest / uidDigest / uidHex, or arrays
    const toArray = (v) => Array.isArray(v) ? v : (v ? [v] : []);
    const accountDigests = toArray(body?.accountDigest || body?.account_digest).map(normalizeAccountDigest).filter(Boolean);
    const uidDigests = toArray(body?.uidDigest || body?.uid_digest).map(normalizeAccountDigest).filter(Boolean);
    const uidHexes = toArray(body?.uidHex || body?.uid_hex).map(v => String(v || '').trim().toUpperCase()).filter(v => v.length >= 14);

    // Resolve uidDigests → accountDigests
    for (const ud of uidDigests) {
      const row = await env.DB.prepare(
        `SELECT account_digest FROM accounts WHERE uid_digest=?1`
      ).bind(ud).first();
      if (row?.account_digest) {
        const ad = normalizeAccountDigest(row.account_digest);
        if (ad && !accountDigests.includes(ad)) accountDigests.push(ad);
      }
    }

    // Resolve uidHexes → accountDigests (hash uidHex to uid_digest first)
    for (const uh of uidHexes) {
      try {
        const uidDigest = await hashUidToDigest(env, uh);
        const row = await env.DB.prepare(
          `SELECT account_digest FROM accounts WHERE uid_digest=?1`
        ).bind(uidDigest).first();
        if (row?.account_digest) {
          const ad = normalizeAccountDigest(row.account_digest);
          if (ad && !accountDigests.includes(ad)) accountDigests.push(ad);
        }
      } catch (err) {
        console.warn('set-brand: uidHex lookup failed for', uh, err?.message);
      }
    }

    if (!accountDigests.length) {
      return json({ error: 'BadRequest', message: 'no matching accounts found; provide accountDigest, uidDigest, or uidHex' }, { status: 400 });
    }

    const updated = [];
    const failed = [];
    for (const ad of accountDigests) {
      try {
        await env.DB.prepare(
          `UPDATE accounts SET brand=?1, brand_name=?2, brand_logo=?3 WHERE account_digest=?4`
        ).bind(brand, brandName, brandLogo, ad).run();
        updated.push(ad);
      } catch (err) {
        failed.push({ accountDigest: ad, error: err?.message || String(err) });
      }
    }

    return json({ ok: true, brand, brandName, brandLogo, updated, failed: failed.length ? failed : undefined });
  }

  return null;
}

// ── Public API helpers (Phase 1 – edge-direct access) ────────────────────────

function buildCORSHeaders(req, env) {
  const origin = req.headers.get('origin') || '';
  const allowList = (env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const allowed = !allowList.length || !origin || allowList.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? (origin || '*') : '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Account-Token, X-Account-Digest, X-Device-Id, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function withCORS(response, req, env) {
  const headers = buildCORSHeaders(req, env);
  const resp = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) resp.headers.set(k, v);
  return resp;
}

/**
 * Resolve account auth from request headers + body for public API routes.
 * Returns { accountDigest } or null if auth fails.
 */
async function resolvePublicAuth(req, env, { body = null } = {}) {
  const tokenHeader = (req.headers.get('x-account-token') || '').trim();
  const digestHeader = (req.headers.get('x-account-digest') || '').trim();

  const accountToken = tokenHeader || body?.account_token || body?.accountToken || null;
  const rawDigest = digestHeader || body?.account_digest || body?.accountDigest || null;
  const accountDigest = rawDigest ? normalizeAccountDigest(rawDigest) : null;

  if (!accountToken && !accountDigest) return null;

  await ensureDataTables(env);
  const account = await resolveAccount(
    env,
    { accountToken, accountDigest },
    { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest }
  );
  if (!account) return null;
  return { accountDigest: account.account_digest };
}

function isSystemOwnedConversation(convId, accountDigest) {
  if (!convId) return false;
  const acct = (accountDigest || '').toUpperCase();
  if (!acct) return false;
  return convId === `drive-${acct}` ||
    convId === `profile-${acct}` || convId === `profile:${acct}` ||
    convId === `settings-${acct}` ||
    convId === `avatar-${acct}` ||
    convId === `contacts-${acct}`;
}

/**
 * Direct conversation authorization – replaces the HTTP round-trip
 * that Node.js used via /d1/conversations/authorize.
 */
async function authorizeConversationDirect(env, { convId, accountDigest, deviceId = null }) {
  await ensureDataTables(env);
  const normalizedDeviceId = deviceId ? normalizeDeviceId(deviceId) : null;
  if (normalizedDeviceId) {
    const devRow = await env.DB.prepare(
      `SELECT 1 FROM devices WHERE account_digest=?1 AND device_id=?2`
    ).bind(accountDigest, normalizedDeviceId).first();
    if (!devRow) {
      const err = new Error('device not registered');
      err.status = 404;
      throw err;
    }
  }
  const row = await env.DB.prepare(
    `SELECT device_id FROM conversation_acl
     WHERE conversation_id=?1 AND account_digest=?2
       AND (device_id=?3 OR device_id IS NULL)`
  ).bind(convId, accountDigest, normalizedDeviceId || '').first();
  if (!row) {
    await grantConversationAccess(env, { conversationId: convId, accountDigest, deviceId: normalizedDeviceId });
  } else if (row.device_id === null && normalizedDeviceId) {
    await grantConversationAccess(env, { conversationId: convId, accountDigest, deviceId: normalizedDeviceId });
  }
  return { ok: true };
}

// ── Direct D1 helpers for device & call operations (edge-direct) ──────────

async function touchDeviceDirect(env, accountDigest, deviceId) {
  await ensureDataTables(env);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO devices (account_digest, device_id, status, last_seen_at, created_at, updated_at)
     VALUES (?1, ?2, 'active', ?3, ?3, ?3)
     ON CONFLICT(account_digest, device_id) DO UPDATE SET status='active', last_seen_at=?3, updated_at=?3`
  ).bind(accountDigest, deviceId, now).run();
}

async function assertDeviceActiveDirect(env, accountDigest, deviceId) {
  await ensureDataTables(env);
  const row = await env.DB.prepare(
    `SELECT status FROM devices WHERE account_digest=?1 AND device_id=?2`
  ).bind(accountDigest, deviceId).first();
  if (!row || row.status !== 'active') {
    const err = new Error('device not active');
    err.status = 403;
    err.code = 'DEVICE_NOT_ACTIVE';
    throw err;
  }
}

async function listActiveDevicesDirect(env, accountDigest) {
  await ensureDataTables(env);
  const rows = await env.DB.prepare(
    `SELECT device_id, status, last_seen_at FROM devices
     WHERE account_digest=?1 AND status='active'
     ORDER BY last_seen_at DESC`
  ).bind(accountDigest).all();
  return (rows?.results || []).map(r => ({ deviceId: r.device_id, status: r.status }));
}

async function assertActiveDeviceOrReturn(env, accountDigest, deviceId) {
  try {
    await touchDeviceDirect(env, accountDigest, deviceId);
    await assertDeviceActiveDirect(env, accountDigest, deviceId);
    return null;
  } catch (err) {
    const status = err?.status || 403;
    const code = err?.code || 'DEVICE_NOT_ACTIVE';
    return json({ error: code, message: err?.message || 'device not active' }, { status });
  }
}

async function resolveTargetDeviceDirect(env, peerAccountDigest, preferredDeviceId) {
  if (preferredDeviceId) {
    await assertDeviceActiveDirect(env, peerAccountDigest, preferredDeviceId);
    return preferredDeviceId;
  }
  const devices = await listActiveDevicesDirect(env, peerAccountDigest);
  if (!devices.length || !devices[0]?.deviceId) {
    const err = new Error('peer-no-active-device');
    err.status = 409;
    err.code = 'peer-no-active-device';
    throw err;
  }
  return devices[0].deviceId;
}

// ── Call network config builder (edge-direct) ────────────────────────────

const CALL_NETWORK_CONFIG_DEFAULTS = {
  version: 1,
  turnSecretsEndpoint: '/api/v1/calls/turn-credentials',
  turnTtlSeconds: 300,
  rtcpProbe: { timeoutMs: 1500, maxAttempts: 3, targetBitrateKbps: 2000 },
  bandwidthProfiles: [
    { name: 'video-medium', minBitrate: 900000, maxBitrate: 1400000, maxFrameRate: 30, resolution: '540p' },
    { name: 'video-low', minBitrate: 300000, maxBitrate: 600000, maxFrameRate: 24, resolution: '360p' },
    { name: 'audio', minBitrate: 32000, maxBitrate: 64000, maxFrameRate: null, resolution: null }
  ],
  ice: {
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    continualGatheringPolicy: 'gather_continually',
    servers: [{ urls: ['stun:stun.cloudflare.com:3478'] }]
  },
  fallback: { maxPeerConnectionRetries: 2, relayOnlyAfterAttempts: 2, showBlockedAfterSeconds: 20 }
};

function clampNum(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function buildCallNetworkConfigEdge(env) {
  const cfg = JSON.parse(JSON.stringify(CALL_NETWORK_CONFIG_DEFAULTS));
  cfg.version = clampNum(env.CALL_NETWORK_VERSION || cfg.version, 1, 999);
  cfg.turnSecretsEndpoint = (env.CALL_TURN_ENDPOINT || cfg.turnSecretsEndpoint).trim();
  cfg.turnTtlSeconds = clampNum(env.TURN_TTL_SECONDS || cfg.turnTtlSeconds, 60, 3600);
  cfg.rtcpProbe.timeoutMs = clampNum(env.CALL_RTCP_TIMEOUT_MS || cfg.rtcpProbe.timeoutMs, 250, 10000);
  cfg.rtcpProbe.maxAttempts = clampNum(env.CALL_RTCP_MAX_ATTEMPTS || cfg.rtcpProbe.maxAttempts, 1, 10);
  cfg.rtcpProbe.targetBitrateKbps = clampNum(env.CALL_RTCP_TARGET_KBPS || cfg.rtcpProbe.targetBitrateKbps, 64, 10000);
  cfg.ice.iceTransportPolicy = env.CALL_ICE_TRANSPORT_POLICY || cfg.ice.iceTransportPolicy;
  cfg.ice.bundlePolicy = env.CALL_ICE_BUNDLE_POLICY || cfg.ice.bundlePolicy;
  cfg.ice.continualGatheringPolicy = env.CALL_ICE_GATHER_POLICY || cfg.ice.continualGatheringPolicy;
  const extraStun = (env.CALL_EXTRA_STUN_URIS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (extraStun.length) cfg.ice.servers.push({ urls: extraStun });
  cfg.fallback.maxPeerConnectionRetries = clampNum(env.CALL_FALLBACK_MAX_RETRIES || cfg.fallback.maxPeerConnectionRetries, 0, 10);
  cfg.fallback.relayOnlyAfterAttempts = clampNum(env.CALL_FALLBACK_RELAY_AFTER || cfg.fallback.relayOnlyAfterAttempts, 0, 10);
  cfg.fallback.showBlockedAfterSeconds = clampNum(env.CALL_FALLBACK_BLOCKED_AFTER || cfg.fallback.showBlockedAfterSeconds, 1, 120);
  return cfg;
}

// ── JWT RS256 verification via Web Crypto (edge-direct) ──────────────────

function pemToArrayBuffer(pem) {
  let raw = pem;
  if (raw.includes('\\n')) raw = raw.replace(/\\n/g, '\n');
  if (!raw.includes('-----BEGIN')) {
    const chunks = raw.replace(/\s+/g, '').match(/.{1,64}/g) || [];
    raw = ['-----BEGIN PUBLIC KEY-----', ...chunks, '-----END PUBLIC KEY-----'].join('\n');
  }
  const b64 = raw.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

function base64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function verifyJwtRS256(token, publicKeyPem) {
  if (!publicKeyPem) {
    const err = new Error('PUBLIC KEY missing');
    err.status = 500;
    throw err;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    const err = new Error('invalid JWT format');
    err.status = 400;
    err.code = 'InvalidVoucher';
    throw err;
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  let header, payload;
  try {
    header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
    payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    const err = new Error('invalid JWT encoding');
    err.status = 400;
    err.code = 'InvalidVoucher';
    throw err;
  }
  const keyData = pemToArrayBuffer(publicKeyPem);
  const key = await crypto.subtle.importKey(
    'spki', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  if (!valid) {
    const err = new Error('invalid JWT signature');
    err.status = 400;
    err.code = 'InvalidVoucher';
    throw err;
  }
  return { payload, header, signatureB64 };
}

// ── S3v4 presigned URL generation (edge-direct, no AWS SDK) ──────────────

async function hmacSha256(key, data) {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const d = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const cryptoKey = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, d));
}

async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getS3SigningKey(secretKey, dateStamp, region, service) {
  let key = await hmacSha256(`AWS4${secretKey}`, dateStamp);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, service);
  key = await hmacSha256(key, 'aws4_request');
  return key;
}

function parseS3Endpoint(endpoint) {
  const u = new URL(endpoint);
  return { protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port };
}

async function generatePresignedUrl(env, { method, key, expiresIn, contentType, downloadName }) {
  const endpoint = env.S3_ENDPOINT;
  const accessKey = env.S3_ACCESS_KEY;
  const secretKey = env.S3_SECRET_KEY;
  const bucket = env.S3_BUCKET;
  const region = env.S3_REGION || 'auto';
  if (!endpoint || !accessKey || !secretKey || !bucket) {
    throw new Error('S3 configuration missing');
  }
  const { protocol, host } = parseS3Endpoint(endpoint);
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const credential = `${accessKey}/${dateStamp}/${region}/s3/aws4_request`;
  const encodedKey = key.split('/').map(s => encodeURIComponent(s)).join('/');
  const canonicalUri = `/${bucket}/${encodedKey}`;
  const queryParams = new URLSearchParams();
  queryParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  queryParams.set('X-Amz-Credential', credential);
  queryParams.set('X-Amz-Date', amzDate);
  queryParams.set('X-Amz-Expires', String(expiresIn));
  queryParams.set('X-Amz-SignedHeaders', 'host');
  if (method === 'PUT' && contentType) {
    queryParams.set('X-Amz-SignedHeaders', 'content-type;host');
  }
  if (method === 'GET' && downloadName) {
    queryParams.set('response-content-disposition', `attachment; filename="${downloadName}"`);
  }
  const sortedParams = new URLSearchParams([...queryParams.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const canonicalQueryString = sortedParams.toString();
  let canonicalHeaders = `host:${host}\n`;
  let signedHeaders = 'host';
  if (method === 'PUT' && contentType) {
    canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
    signedHeaders = 'content-type;host';
  }
  const canonicalRequest = [method, canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signingKey = await getS3SigningKey(secretKey, dateStamp, region, 's3');
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = [...signatureBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  sortedParams.set('X-Amz-Signature', signature);
  return `${protocol}//${host}${canonicalUri}?${sortedParams.toString()}`;
}

// ── S3 direct operations (DELETE, LIST) for purge / cleanup ───────
async function s3SignedRequest(env, { method, key, query = '', body = null }) {
  const endpoint = env.S3_ENDPOINT;
  const accessKey = env.S3_ACCESS_KEY;
  const secretKey = env.S3_SECRET_KEY;
  const bucket = env.S3_BUCKET;
  const region = env.S3_REGION || 'auto';
  if (!endpoint || !accessKey || !secretKey || !bucket) {
    throw new Error('S3 configuration missing');
  }
  const { protocol, host } = parseS3Endpoint(endpoint);
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const credential = `${accessKey}/${dateStamp}/${region}/s3/aws4_request`;
  const encodedKey = key ? '/' + key.split('/').map(s => encodeURIComponent(s)).join('/') : '';
  const canonicalUri = `/${bucket}${encodedKey}`;
  const canonicalQueryString = query ? new URLSearchParams([...new URLSearchParams(query).entries()].sort((a, b) => a[0].localeCompare(b[0]))).toString() : '';
  const payloadHash = body ? await sha256Hex(body) : await sha256Hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signingKey = await getS3SigningKey(secretKey, dateStamp, region, 's3');
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = [...signatureBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const authHeader = `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `${protocol}//${host}${canonicalUri}${canonicalQueryString ? '?' + canonicalQueryString : ''}`;
  return fetch(url, {
    method,
    headers: {
      'Host': host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Authorization': authHeader
    },
    body: body || undefined
  });
}

async function deleteS3Object(env, key) {
  const res = await s3SignedRequest(env, { method: 'DELETE', key });
  return res.ok || res.status === 404; // 404 = already gone
}

async function deleteS3Prefix(env, prefix, maxKeys = 1000) {
  let deleted = 0;
  let continuationToken = null;
  for (let iter = 0; iter < 10; iter++) { // safety limit
    const params = new URLSearchParams({ prefix, 'max-keys': String(maxKeys), 'list-type': '2' });
    if (continuationToken) params.set('continuation-token', continuationToken);
    const res = await s3SignedRequest(env, { method: 'GET', key: '', query: params.toString() });
    if (!res.ok) break;
    const xml = await res.text();
    // Simple XML parsing for <Key> elements
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
    if (keys.length === 0) break;
    for (const k of keys) {
      try {
        await deleteS3Object(env, k);
        deleted++;
      } catch { /* best-effort */ }
    }
    // Check for truncation
    const isTruncated = xml.includes('<IsTruncated>true</IsTruncated>');
    if (!isTruncated) break;
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!tokenMatch) break;
    continuationToken = tokenMatch[1];
  }
  return deleted;
}

function generateNanoId(len = 32) {
  const chars = '1234567890abcdef';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let id = '';
  for (let i = 0; i < len; i++) id += chars[bytes[i] % chars.length];
  return id;
}

// ── WS Token (JWT HS256) ──────────────────────────────────────────
const WS_JWT_HEADER_B64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmacSha256Sign(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createWsToken(env, { accountDigest, ttlSec = 300 }) {
  const secret = env.WS_TOKEN_SECRET;
  if (!secret) throw new Error('WS_TOKEN_SECRET not configured');
  if (!accountDigest) throw new Error('accountDigest required');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    accountDigest: String(accountDigest).toUpperCase(),
    iat: now,
    exp: now + ttlSec
  };
  const bodyB64 = base64url(JSON.stringify(payload));
  const signature = await hmacSha256Sign(secret, `${WS_JWT_HEADER_B64}.${bodyB64}`);
  return {
    token: `${WS_JWT_HEADER_B64}.${bodyB64}.${signature}`,
    payload
  };
}

// ── WebSocket upgrade handler → Durable Object ──────────────────
//
// Flow:
//   1. Client connects to /ws?token=<JWT>
//   2. Worker verifies JWT, extracts accountDigest
//   3. Worker looks up DO by accountDigest, forwards the upgrade request
//
async function handleWsUpgrade(req, env, url) {
  // Token can come from query param (most WS clients) or header
  const token = url.searchParams.get('token')
    || (req.headers.get('sec-websocket-protocol') || '').split(',').map(s => s.trim()).find(s => s.startsWith('ey'))
    || '';

  if (!token) {
    return json({ error: 'Unauthorized', message: 'token query param required' }, { status: 401 });
  }

  // Verify JWT (same secret as createWsToken)
  const secret = env.WS_TOKEN_SECRET;
  if (!secret) {
    return json({ error: 'ConfigError', message: 'WS_TOKEN_SECRET not configured' }, { status: 500 });
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== WS_JWT_HEADER_B64) {
    return json({ error: 'Unauthorized', message: 'invalid token format' }, { status: 401 });
  }
  const [headerB64, bodyB64, signature] = parts;
  const expectedSig = await hmacSha256Sign(secret, `${headerB64}.${bodyB64}`);
  if (signature !== expectedSig) {
    return json({ error: 'Unauthorized', message: 'invalid token signature' }, { status: 401 });
  }

  let payload;
  try {
    const payloadStr = bodyB64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = payloadStr.length % 4 === 0 ? '' : '='.repeat(4 - (payloadStr.length % 4));
    payload = JSON.parse(atob(payloadStr + pad));
  } catch {
    return json({ error: 'Unauthorized', message: 'invalid token payload' }, { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now >= payload.exp) {
    return json({ error: 'Unauthorized', message: 'token expired' }, { status: 401 });
  }

  const rawAccountDigest = String(payload.accountDigest || '');
  const isEphemeral = rawAccountDigest.startsWith('EPHEMERAL_');
  const accountDigest = isEphemeral
    ? rawAccountDigest
    : rawAccountDigest.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (!isEphemeral && accountDigest.length !== 64) {
    return json({ error: 'Unauthorized', message: 'invalid accountDigest in token' }, { status: 401 });
  }

  // Forward to Durable Object
  if (!env.ACCOUNT_WS) {
    console.error('[ws-upgrade] ACCOUNT_WS binding not available');
    return json({ error: 'ConfigError', message: 'ACCOUNT_WS DO binding not configured' }, { status: 500 });
  }

  const deviceId = url.searchParams.get('deviceId') || req.headers.get('x-device-id') || '';

  try {
    const doId = env.ACCOUNT_WS.idFromName(accountDigest);
    const stub = env.ACCOUNT_WS.get(doId);

    // Clone from the original client Request (not just its URL) so that the
    // Cloudflare runtime preserves the internal WebSocket upgrade state needed
    // to bridge the client ↔ DO connection.  We override headers to inject
    // our metadata while keeping the original WS upgrade headers intact.
    const doHeaders = new Headers(req.headers);
    doHeaders.set('x-account-digest', accountDigest);
    doHeaders.set('x-device-id', deviceId);
    doHeaders.set('x-session-ts', String(payload.iat || now));

    return await stub.fetch(new Request(req, { headers: doHeaders }));
  } catch (err) {
    console.error('[ws-upgrade] DO fetch failed', { error: err?.message || String(err), stack: err?.stack, accountDigest });
    return json({
      error: 'WsUpgradeError',
      message: err?.message || 'Durable Object fetch failed',
      stage: 'do-fetch'
    }, { status: 500 });
  }
}

// ── Notify account via Durable Object (replaces notifyWsServer) ──
async function notifyAccountDO(env, accountDigest, payload) {
  if (!env.ACCOUNT_WS) {
    console.warn('[notify-do] ACCOUNT_WS binding not available');
    return;
  }
  const digest = String(accountDigest || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (digest.length !== 64) return;

  try {
    const doId = env.ACCOUNT_WS.idFromName(digest);
    const stub = env.ACCOUNT_WS.get(doId);
    const res = await stub.fetch('https://do/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.warn('[notify-do] failed', { status: res.status, type: payload?.type, accountDigest: digest });
    }
  } catch (err) {
    console.warn('[notify-do] error', { type: payload?.type, accountDigest: digest, error: err?.message || String(err) });
  }
}

/** Notify an ephemeral guest DO (EPHEMERAL_ prefixed digest). */
async function notifyEphemeralDO(env, ephemeralDigest, payload) {
  if (!env.ACCOUNT_WS) return;
  const digest = String(ephemeralDigest || '');
  if (!digest.startsWith('EPHEMERAL_')) return;
  try {
    const doId = env.ACCOUNT_WS.idFromName(digest);
    const stub = env.ACCOUNT_WS.get(doId);
    const res = await stub.fetch('https://do/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.warn('[notify-eph-do] failed', { status: res.status, type: payload?.type });
    }
  } catch (err) {
    console.warn('[notify-eph-do] error', { type: payload?.type, error: err?.message || String(err) });
  }
}

/**
 * Create a synthetic internal Request to delegate to existing /d1/ handlers.
 */
function internalRequest(url, method, body, baseUrl) {
  const opts = { method, headers: { 'content-type': 'application/json' } };
  if (body !== null && body !== undefined && method !== 'GET') {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request(new URL(url, baseUrl), opts);
}

// ---- Auth routes (SDM exchange, OPAQUE, MK) ----
const ACCOUNT_DIGEST_RE = /^[0-9A-Fa-f]{64}$/;
const SDM_EXCHANGE_TTL = 300; // seconds
const OPAQUE_SESSION_TTL = 120;

async function handleAuthRoutes(path, method, url, body, req, env, baseUrl) {
  // POST /api/v1/auth/sdm/exchange
  if (path === '/api/v1/auth/sdm/exchange' && method === 'POST') {
    if (!body?.uid || !body?.sdmmac) return json({ error: 'BadRequest', message: 'uid, sdmmac required' }, { status: 400 });
    const uidHex = String(body.uid).replace(/[^0-9a-f]/gi, '').toUpperCase();
    const ctrHex = typeof body.sdmcounter === 'number' ? body.sdmcounter.toString(16) : String(body.sdmcounter || '0');
    const cmacHex = String(body.sdmmac).replace(/[^0-9a-f]/gi, '').toUpperCase();

    // 1) Verify SDM CMAC
    let vr;
    try { vr = await ntag424_verifyCmac(env, uidHex, ctrHex, cmacHex); }
    catch (e) { return json({ error: 'ConfigError', message: e?.message || 'NTAG424 config missing' }, { status: 500 }); }
    if (!vr.ok) return json({ error: 'Unauthorized', detail: 'SDM verify failed' }, { status: 401 });

    // 2) Call /d1/tags/exchange
    const intBody = { uidHex, ctr: parseInt(ctrHex, 16) || 0 };
    const tagRes = await handleTagsRoutes(internalRequest('/d1/tags/exchange', 'POST', intBody, baseUrl), env);
    if (!tagRes || tagRes.status >= 400) {
      const errData = tagRes ? await tagRes.json().catch(() => ({})) : {};
      return json({ error: 'ExchangeFailed', details: errData }, { status: tagRes?.status || 502 });
    }
    const data = await tagRes.json();
    if (!data.account_token || !data.account_digest) {
      return json({ error: 'AccountInfoMissing', message: 'worker did not return account token' }, { status: 502 });
    }

    // 3) Create session in KV
    const session = crypto.randomBytes(24).toString('base64url');
    await kvPut(env, AUTH_KV_PREFIX_SESS + session, {
      accountToken: data.account_token,
      accountDigest: data.account_digest.toUpperCase(),
      uidDigest: data.uid_digest || null
    }, SDM_EXCHANGE_TTL);

    const serverId = env.OPAQUE_SERVER_ID || env.DOMAIN || 'api.sentry';
    return json({
      session,
      has_mk: !!(data.hasMK || data.has_mk),
      wrapped_mk: data.wrapped_mk || undefined,
      account_token: data.account_token,
      account_digest: data.account_digest.toUpperCase(),
      uid_digest: data.uid_digest || null,
      opaque_server_id: serverId,
      brand: data.brand || undefined,
      brand_name: data.brand_name || undefined,
      brand_logo: data.brand_logo || undefined
    });
  }

  // POST /api/v1/auth/sdm/debug-kit
  if (path === '/api/v1/auth/sdm/debug-kit' && method === 'POST') {
    let uidHex = String(body?.uid_hex || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (!uidHex || uidHex.length < 14) uidHex = crypto.randomBytes(7).toString('hex').toUpperCase();
    else uidHex = uidHex.slice(0, 14);

    // Debug counter via KV
    const ctrKey = AUTH_KV_PREFIX_DBG_CTR + uidHex;
    const now = Math.floor(Date.now() / 1000);
    const last = (await kvGet(env, ctrKey)) || 0;
    const next = now > last ? now : last + 1;
    await kvPut(env, ctrKey, next, 86400);

    const ctrHex = next.toString(16).toUpperCase().padStart(6, '0').slice(-6);
    let cmacHex;
    try { cmacHex = await ntag424_computeSdmCmacForDebug(env, uidHex, ctrHex); }
    catch (e) { return json({ error: 'ConfigError', message: e?.message }, { status: 500 }); }
    return json({ uid_hex: uidHex, sdmcounter: ctrHex, sdmmac: cmacHex, nonce: `debug-${Date.now()}` });
  }

  // POST /api/v1/mk/store
  if (path === '/api/v1/mk/store' && method === 'POST') {
    if (!body?.session) return json({ error: 'BadRequest', message: 'session required' }, { status: 400 });
    const sess = await kvGet(env, AUTH_KV_PREFIX_SESS + body.session);
    await kvDelete(env, AUTH_KV_PREFIX_SESS + body.session); // single use

    if (!sess) return json({ error: 'SessionExpired', message: 'please re-tap the tag' }, { status: 401 });
    const accountToken = sess.accountToken || body.account_token || null;
    const accountDigest = (sess.accountDigest || body.account_digest || '').toUpperCase();
    if (body.account_token && body.account_token !== accountToken) {
      return json({ error: 'SessionMismatch', message: 'account token mismatch' }, { status: 401 });
    }
    if (body.account_digest && body.account_digest.toUpperCase() !== accountDigest) {
      return json({ error: 'SessionMismatch', message: 'account digest mismatch' }, { status: 401 });
    }
    if (!accountToken || !accountDigest || !ACCOUNT_DIGEST_RE.test(accountDigest)) {
      return json({ error: 'AccountInfoMissing', message: 'account token missing' }, { status: 400 });
    }
    if (!body?.wrapped_mk) return json({ error: 'BadRequest', message: 'wrapped_mk required' }, { status: 400 });

    const intBody = { accountToken, accountDigest, wrapped_mk: body.wrapped_mk };
    const r = await handleTagsRoutes(internalRequest('/d1/tags/store-mk', 'POST', intBody, baseUrl), env);
    if (!r || r.status >= 400) {
      const errData = r ? await r.text().catch(() => '') : 'no response';
      return json({ error: 'StoreFailed', details: errData }, { status: r?.status || 502 });
    }
    return new Response(null, { status: 204 });
  }

  // POST /api/v1/mk/update
  if (path === '/api/v1/mk/update' && method === 'POST') {
    if (!body?.account_token || !body?.account_digest || !body?.wrapped_mk) {
      return json({ error: 'BadRequest', message: 'account_token, account_digest, wrapped_mk required' }, { status: 400 });
    }
    const intBody = {
      accountToken: body.account_token,
      accountDigest: body.account_digest.toUpperCase(),
      wrapped_mk: body.wrapped_mk
    };
    const r = await handleTagsRoutes(internalRequest('/d1/tags/store-mk', 'POST', intBody, baseUrl), env);
    if (!r || r.status >= 400) {
      const txt = r ? await r.text().catch(() => '') : '';
      return json({ error: 'StoreFailed', details: txt }, { status: 502 });
    }
    return new Response(null, { status: 204 });
  }

  // ---- OPAQUE endpoints ----
  // POST /api/v1/auth/opaque/register-init
  if (path === '/api/v1/auth/opaque/register-init' && method === 'POST') {
    const server = getOrInitOpaqueServer(env);
    if (!server) return json({ error: 'ConfigError', message: 'OPAQUE not configured' }, { status: 500 });
    const acct = String(body?.account_digest || '').trim().toUpperCase();
    const reqB64 = String(body?.request_b64 || '');
    if (!ACCOUNT_DIGEST_RE.test(acct) || !reqB64) return json({ error: 'BadRequest', message: 'account_digest and request_b64 required' }, { status: 400 });

    const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
    const reqBytes = Array.from(Buffer.from(reqB64, 'base64'));
    const expectedLen = RegistrationRequest.sizeSerialized(cfg);
    if (reqBytes.length !== expectedLen) {
      return json({ error: 'BadRequest', message: `invalid request_b64 length (got ${reqBytes.length}, expected ${expectedLen})` }, { status: 400 });
    }
    let reqObj;
    try { reqObj = RegistrationRequest.deserialize(cfg, reqBytes); }
    catch { return json({ error: 'BadRequest', message: 'invalid request_b64' }, { status: 400 }); }
    let out;
    try { out = await server.registerInit(reqObj, acct); }
    catch { return json({ error: 'RecordNotFound' }, { status: 404 }); }
    if (out instanceof Error) return json({ error: 'RecordNotFound' }, { status: 404 });
    const response_b64 = Buffer.from(new Uint8Array(out.serialize())).toString('base64');
    return json({ response_b64 });
  }

  // POST /api/v1/auth/opaque/register-finish
  if (path === '/api/v1/auth/opaque/register-finish' && method === 'POST') {
    const acct = String(body?.account_digest || '').trim().toUpperCase();
    const record_b64 = body?.record_b64;
    if (!ACCOUNT_DIGEST_RE.test(acct) || !record_b64) {
      return json({ error: 'BadRequest', message: 'account_digest and record_b64 required' }, { status: 400 });
    }
    const intBody = { accountDigest: acct, record_b64, client_identity: body?.client_identity ?? null };
    const intReq = internalRequest('/d1/opaque/store', 'POST', intBody, baseUrl);
    // Use the existing internal handler for /d1/opaque/store
    const storeUrl = new URL(intReq.url);
    // Direct D1 call
    try {
      await env.DB.prepare(
        'INSERT OR REPLACE INTO opaque_records (account_digest, record_b64, client_identity, updated_at) VALUES (?, ?, ?, ?)'
      ).bind(acct, record_b64, body?.client_identity ?? null, Date.now()).run();
    } catch (e) {
      return json({ error: 'OpaqueStoreFailed', message: e?.message }, { status: 500 });
    }
    return new Response(null, { status: 204 });
  }

  // POST /api/v1/auth/opaque/login-init
  if (path === '/api/v1/auth/opaque/login-init' && method === 'POST') {
    const server = getOrInitOpaqueServer(env);
    if (!server) return json({ error: 'ConfigError', message: 'OPAQUE not configured' }, { status: 500 });
    const acct = String(body?.account_digest || '').trim().toUpperCase();
    const ke1B64 = String(body?.ke1_b64 || '');
    if (!ACCOUNT_DIGEST_RE.test(acct) || !ke1B64) return json({ error: 'BadRequest' }, { status: 400 });

    const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);

    // Fetch registration record from D1
    const row = await env.DB.prepare('SELECT record_b64, client_identity FROM opaque_records WHERE account_digest = ?').bind(acct).first();
    if (!row) return json({ error: 'RecordNotFound' }, { status: 404 });

    const recBytes = Array.from(Buffer.from(row.record_b64, 'base64'));
    const minRecord = RegistrationRecord.sizeSerialized(cfg);
    if (recBytes.length < minRecord) return json({ error: 'RecordNotFound' }, { status: 404 });
    let record;
    try { record = RegistrationRecord.deserialize(cfg, recBytes); }
    catch { return json({ error: 'RecordNotFound' }, { status: 404 }); }

    const ke1Bytes = Array.from(Buffer.from(ke1B64, 'base64'));
    if (ke1Bytes.length !== KE1.sizeSerialized(cfg)) return json({ error: 'RecordNotFound' }, { status: 404 });
    let ke1;
    try { ke1 = KE1.deserialize(cfg, ke1Bytes); }
    catch { return json({ error: 'RecordNotFound' }, { status: 404 }); }

    const client_identity = row.client_identity || undefined;
    const context = body?.context || undefined;
    const initRes = await server.authInit(ke1, record, acct, client_identity, context);
    if (initRes instanceof Error) return json({ error: 'RecordNotFound', message: 'register required' }, { status: 404 });

    const ke2_b64 = Buffer.from(new Uint8Array(initRes.ke2.serialize())).toString('base64');
    const expected_b64 = Buffer.from(new Uint8Array(initRes.expected.serialize())).toString('base64');
    const opaqueSession = `opaque-${crypto.randomBytes(18).toString('base64url')}`;

    // Store expected in KV
    await kvPut(env, AUTH_KV_PREFIX_OPAQUE + opaqueSession, { expected_b64 }, OPAQUE_SESSION_TTL);
    return json({ ke2_b64, opaque_session: opaqueSession });
  }

  // POST /api/v1/auth/opaque/login-finish
  if (path === '/api/v1/auth/opaque/login-finish' && method === 'POST') {
    const server = getOrInitOpaqueServer(env);
    if (!server) return json({ error: 'ConfigError', message: 'OPAQUE not configured' }, { status: 500 });
    const opaqueSession = body?.opaque_session;
    const ke3B64 = body?.ke3_b64;
    if (!opaqueSession || !ke3B64) return json({ error: 'BadRequest' }, { status: 400 });

    const rec = await kvGet(env, AUTH_KV_PREFIX_OPAQUE + opaqueSession);
    await kvDelete(env, AUTH_KV_PREFIX_OPAQUE + opaqueSession); // single use
    if (!rec) return json({ error: 'OpaqueSessionNotFound' }, { status: 400 });

    const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
    let expected, ke3;
    try { expected = ExpectedAuthResult.deserialize(cfg, Array.from(Buffer.from(rec.expected_b64, 'base64'))); }
    catch { return json({ error: 'BadRequest', message: 'invalid expected_b64' }, { status: 400 }); }
    try { ke3 = KE3.deserialize(cfg, Array.from(Buffer.from(ke3B64, 'base64'))); }
    catch { return json({ error: 'BadRequest', message: 'invalid ke3_b64' }, { status: 400 }); }

    const fin = server.authFinish(ke3, expected);
    if (fin instanceof Error) return json({ error: 'OpaqueLoginFinishFailed', message: fin.message || 'login-finish failed' }, { status: 400 });
    const session_key_b64 = Buffer.from(new Uint8Array(fin.session_key)).toString('base64');
    return json({ ok: true, session_key_b64 });
  }

  // GET /api/v1/auth/opaque/debug
  if (path === '/api/v1/auth/opaque/debug' && method === 'GET') {
    const seedHex = String(env.OPAQUE_OPRF_SEED || '');
    const privB64 = String(env.OPAQUE_AKE_PRIV_B64 || '');
    const pubB64 = String(env.OPAQUE_AKE_PUB_B64 || '');
    return json({
      hasSeed: /^[0-9A-Fa-f]{64}$/.test(seedHex),
      hasPriv: !!privB64,
      hasPub: !!pubB64,
      seedLen: seedHex.length,
      privLen: privB64 ? Buffer.from(privB64, 'base64').length : 0,
      pubLen: pubB64 ? Buffer.from(pubB64, 'base64').length : 0,
      serverId: env.OPAQUE_SERVER_ID || env.DOMAIN || 'api.sentry'
    });
  }

  return null;
}

/**
 * Main public API router for /api/ and /api/v1/ paths.
 * No HMAC required — uses account token/digest auth.
 */
async function handlePublicRoutes(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const baseUrl = url.origin;

  // ── Health / Status ───────────────────────────────────────────
  if (path === '/api/health' || path === '/api/v1/health') {
    return json({ ok: true, ts: Date.now() });
  }
  if (path === '/api/status' || path === '/api/v1/status') {
    return json({ name: 'message-data', version: '1.0.0', edge: true });
  }
  if (path === '/api/v1/messages/probe') {
    return json({ probe: 'ok' });
  }

  // ── Parse body for POST requests ─────────────────────────────
  let body = null;
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  const isJsonContent = !contentType || contentType.includes('application/json') || contentType.includes('text/');
  if (method === 'POST' && isJsonContent) {
    try { body = await req.json(); } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
  }

  // ── Auth (SDM exchange, OPAQUE, MK) ──────────────────────────
  if (path.startsWith('/api/v1/auth/') || path === '/api/v1/mk/store' || path === '/api/v1/mk/update') {
    const authResult = await handleAuthRoutes(path, method, url, body, req, env, baseUrl);
    if (authResult) return authResult;
  }

  // ── WS Token ─────────────────────────────────────────────────
  if (path === '/api/v1/ws/token' && method === 'POST') {
    if (!env.WS_TOKEN_SECRET) {
      return json({ error: 'ConfigError', message: 'WS_TOKEN_SECRET not configured' }, { status: 500 });
    }
    const accountToken = (body?.account_token || body?.accountToken || '').trim();
    const rawDigest = (body?.account_digest || body?.accountDigest || '').trim();
    const accountDigest = rawDigest ? normalizeAccountDigest(rawDigest) : null;
    if (!accountToken && !accountDigest) {
      return json({ error: 'BadRequest', message: 'account_token or account_digest required' }, { status: 400 });
    }
    // Verify account
    await ensureDataTables(env);
    let account;
    try {
      account = await resolveAccount(env, { accountToken: accountToken || null, accountDigest }, {
        allowCreate: false,
        preferredAccountToken: accountToken || null,
        preferredAccountDigest: accountDigest
      });
    } catch (err) {
      return json({ error: 'VerifyFailed', message: err?.message || 'resolveAccount failed' }, { status: 502 });
    }
    if (!account) {
      return json({ error: 'VerifyFailed', message: 'account not found' }, { status: 401 });
    }
    const resolvedDigest = String(account.account_digest || '').toUpperCase();
    if (!resolvedDigest) {
      return json({ error: 'VerifyFailed', message: 'account digest missing' }, { status: 500 });
    }
    const sessionTs = Math.floor(Date.now() / 1000);
    try {
      const { token, payload } = await createWsToken(env, { accountDigest: resolvedDigest });
      // Include the Worker's direct WS endpoint so the client can bypass Pages proxy
      const workerWsUrl = `wss://${new URL(req.url).hostname}/ws`;
      return json({
        token,
        expires_at: payload.exp,
        account_digest: payload.accountDigest,
        session_ts: sessionTs,
        client_session_ts: body?.session_ts ?? null,
        ws_url: workerWsUrl
      });
    } catch (err) {
      return json({ error: 'TokenError', message: err?.message || 'failed to create token' }, { status: 500 });
    }
  }

  // ── Groups ────────────────────────────────────────────────────
  if (path === '/api/v1/groups/create' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized', message: 'account verification failed' }, { status: 401 });
    const intBody = {
      groupId: body.group_id || body.groupId,
      conversationId: body.conversation_id || body.conversationId,
      creatorAccountDigest: auth.accountDigest,
      name: body.name || null,
      avatar: body.avatar ?? null,
      members: (body.members || []).map(m => ({
        accountDigest: m.account_digest || m.accountDigest
      }))
    };
    return handleGroupsRoutes(internalRequest('/d1/groups/create', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/groups/members/add' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      groupId: body.group_id || body.groupId,
      members: (body.members || []).map(m => ({
        accountDigest: m.account_digest || m.accountDigest
      }))
    };
    return handleGroupsRoutes(internalRequest('/d1/groups/members/add', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/groups/members/remove' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      groupId: body.group_id || body.groupId,
      members: (body.members || []).map(m => ({
        accountDigest: m.account_digest || m.accountDigest
      })),
      status: body.status || null
    };
    return handleGroupsRoutes(internalRequest('/d1/groups/members/remove', 'POST', intBody, baseUrl), env);
  }

  {
    const groupMatch = path.match(/^\/api\/v1\/groups\/([A-Za-z0-9_-]{8,128})$/);
    if (groupMatch && method === 'GET') {
      const groupId = groupMatch[1];
      const accountDigest = url.searchParams.get('account_digest') || url.searchParams.get('accountDigest') || '';
      if (!accountDigest) return json({ error: 'BadRequest', message: 'account_digest required' }, { status: 400 });
      const qs = `?groupId=${encodeURIComponent(groupId)}&accountDigest=${encodeURIComponent(accountDigest)}`;
      return handleGroupsRoutes(internalRequest(`/d1/groups/get${qs}`, 'GET', null, baseUrl), env);
    }
  }

  // ── Contact Secrets ───────────────────────────────────────────
  if (path === '/api/v1/contact-secrets/backup' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      accountDigest: auth.accountDigest,
      payload: body.payload,
      checksum: body.checksum || null,
      snapshotVersion: body.snapshot_version ?? body.snapshotVersion ?? null,
      entries: body.entries ?? null,
      updatedAt: body.updated_at ?? body.updatedAt ?? Date.now(),
      bytes: body.bytes ?? null,
      withDrState: body.with_dr_state ?? body.withDrState ?? null,
      deviceLabel: body.device_label ?? body.deviceLabel ?? null,
      deviceId: body.device_id || body.deviceId,
      reason: body.reason || 'auto'
    };
    return handleContactSecretsRoutes(internalRequest('/d1/contact-secrets/backup', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/contact-secrets/backup' && method === 'GET') {
    const auth = await resolvePublicAuth(req, env, { body: null });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 1), 1), 10);
    const version = Number(url.searchParams.get('version') || 0);
    let qs = `?accountDigest=${encodeURIComponent(auth.accountDigest)}&limit=${limit}`;
    if (version > 0) qs += `&version=${Math.floor(version)}`;
    return handleContactSecretsRoutes(internalRequest(`/d1/contact-secrets/backup${qs}`, 'GET', null, baseUrl), env);
  }

  // ── Message Key Vault ─────────────────────────────────────────
  if (path === '/api/v1/message-key-vault/put' && method === 'POST') {
    // Authenticate via token only (sender may write to peer's vault)
    const tokenHeader = (req.headers.get('x-account-token') || '').trim();
    const accountToken = tokenHeader || body?.account_token || body?.accountToken || null;
    if (!accountToken) return json({ error: 'Unauthorized', message: 'account_token required' }, { status: 401 });
    await ensureDataTables(env);
    const account = await resolveAccount(env, { accountToken }, { allowCreate: false });
    if (!account) return json({ error: 'Unauthorized' }, { status: 401 });
    // Target digest: explicit body field, or default to authenticated user
    const targetDigest = normalizeAccountDigest(body?.account_digest || body?.accountDigest) || account.account_digest;
    const intBody = {
      accountDigest: targetDigest,
      conversationId: body.conversation_id || body.conversationId,
      messageId: body.message_id || body.messageId,
      senderDeviceId: body.sender_device_id || body.senderDeviceId,
      targetDeviceId: body.target_device_id || body.targetDeviceId,
      direction: body.direction,
      msgType: body.msg_type || body.msgType || null,
      headerCounter: body.header_counter ?? body.headerCounter ?? null,
      wrapped_mk: body.wrapped_mk,
      wrap_context: body.wrap_context
    };
    return handleMessageKeyVaultRoutes(internalRequest('/d1/message-key-vault/put', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/message-key-vault/get' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      accountDigest: auth.accountDigest,
      conversationId: body.conversation_id || body.conversationId,
      messageId: body.message_id || body.messageId,
      senderDeviceId: body.sender_device_id || body.senderDeviceId
    };
    return handleMessageKeyVaultRoutes(internalRequest('/d1/message-key-vault/get', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/message-key-vault/latest-state' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      accountDigest: auth.accountDigest,
      conversationId: body.conversation_id || body.conversationId
    };
    return handleMessageKeyVaultRoutes(internalRequest('/d1/message-key-vault/latest-state', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/message-key-vault/count' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      conversationId: body.conversation_id || body.conversationId,
      messageId: body.message_id || body.messageId
    };
    return handleMessageKeyVaultRoutes(internalRequest('/d1/message-key-vault/count', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/message-key-vault/delete' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      accountDigest: auth.accountDigest,
      conversationId: body.conversation_id || body.conversationId,
      messageId: body.message_id || body.messageId,
      senderDeviceId: body.sender_device_id || body.senderDeviceId
    };
    return handleMessageKeyVaultRoutes(internalRequest('/d1/message-key-vault/delete', 'POST', intBody, baseUrl), env);
  }

  // ── Keys (Prekeys) ────────────────────────────────────────────
  if (path === '/api/v1/keys/publish' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const spk = body.signed_prekey || body.signedPrekey || {};
    const intBody = {
      accountDigest: auth.accountDigest,
      deviceId: body.device_id || body.deviceId,
      signedPrekey: {
        id: spk.id,
        pub: spk.pub,
        sig: spk.sig,
        ik_pub: spk.ik_pub
      },
      opks: body.opks || []
    };
    return handlePrekeysRoutes(internalRequest('/d1/prekeys/publish', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/keys/bundle' && method === 'POST') {
    const peerDigest = normalizeAccountDigest(body?.peer_account_digest || body?.peerAccountDigest);
    if (!peerDigest) return json({ error: 'BadRequest', message: 'peer_account_digest required' }, { status: 400 });
    let qs = `?peerAccountDigest=${encodeURIComponent(peerDigest)}`;
    const peerDeviceId = body?.peer_device_id || body?.peerDeviceId;
    if (peerDeviceId) qs += `&peerDeviceId=${encodeURIComponent(peerDeviceId)}`;
    return handlePrekeysRoutes(internalRequest(`/d1/prekeys/bundle${qs}`, 'GET', null, baseUrl), env);
  }

  // ── DevKeys ───────────────────────────────────────────────────
  if (path === '/api/v1/devkeys/fetch' && method === 'POST') {
    const accountToken = body?.account_token || body?.accountToken || null;
    const accountDigest = normalizeAccountDigest(body?.account_digest || body?.accountDigest);
    if (!accountToken && !accountDigest) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {};
    if (accountToken) intBody.accountToken = String(accountToken).trim();
    if (accountDigest) intBody.accountDigest = accountDigest;
    // If we have a token but no digest, compute digest
    if (accountToken && !accountDigest) {
      intBody.accountDigest = await digestAccountToken(String(accountToken).trim());
    }
    return handleTagsRoutes(internalRequest('/d1/devkeys/fetch', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/devkeys/store' && method === 'POST') {
    const accountToken = body?.account_token || body?.accountToken || null;
    const accountDigest = normalizeAccountDigest(body?.account_digest || body?.accountDigest);
    if (!accountToken && !accountDigest) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {};
    if (accountToken) intBody.accountToken = String(accountToken).trim();
    if (accountDigest) intBody.accountDigest = accountDigest;
    if (accountToken && !accountDigest) {
      intBody.accountDigest = await digestAccountToken(String(accountToken).trim());
    }
    intBody.wrapped_dev = body.wrapped_dev;
    if (body.session) intBody.session = body.session;
    return handleTagsRoutes(internalRequest('/d1/devkeys/store', 'POST', intBody, baseUrl), env);
  }

  // ── Account ───────────────────────────────────────────────────
  if (path === '/api/v1/account/evidence' && method === 'GET') {
    // Frontend sends digest via x-account-digest header or query param
    const accountDigest = normalizeAccountDigest(
      url.searchParams.get('account_digest') || url.searchParams.get('accountDigest') ||
      req.headers.get('x-account-digest') || ''
    );
    if (!accountDigest) return json({ error: 'BadRequest', message: 'account_digest required' }, { status: 400 });
    const qs = `?accountDigest=${encodeURIComponent(accountDigest)}`;
    return handleAccountsRoutes(internalRequest(`/d1/account/evidence${qs}`, 'GET', null, baseUrl), env);
  }

  // ── Invites ───────────────────────────────────────────────────
  if (path === '/api/v1/invites/create' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const accountToken = (body?.account_token || body?.accountToken || req.headers.get('x-account-token') || '').trim();
    const deviceId = (req.headers.get('x-device-id') || body?.device_id || body?.deviceId || '').trim();
    const inviteId = body.invite_id || body.inviteId || generateNanoId(32);
    const intBody = {
      inviteId,
      accountToken,
      accountDigest: auth.accountDigest,
      deviceId,
      ownerPublicKeyB64: body.owner_public_key_b64 || body.ownerPublicKeyB64 || null,
      wantPairingCode: body.want_pairing_code ?? body.wantPairingCode ?? false
    };
    return handleInviteDropboxRoutes(internalRequest('/d1/invites/create', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/invites/deliver' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const accountToken = (body?.account_token || body?.accountToken || req.headers.get('x-account-token') || '').trim();
    const deviceId = (req.headers.get('x-device-id') || body?.device_id || body?.deviceId || '').trim();
    const intBody = {
      inviteId: body.invite_id || body.inviteId,
      accountToken,
      accountDigest: auth.accountDigest,
      deviceId,
      ciphertextEnvelope: body.ciphertext_envelope || body.ciphertextEnvelope
    };
    const result = await handleInviteDropboxRoutes(internalRequest('/d1/invites/deliver', 'POST', intBody, baseUrl), env);
    // WS notification: invite delivered
    if (result && result.status < 400) {
      try {
        const resData = await result.clone().json().catch(() => null);
        const ownerDigest = resData?.ownerAccountDigest || resData?.owner_account_digest;
        if (ownerDigest) {
          const targetDeviceId = body?.target_device_id || body?.targetDeviceId || null;
          await notifyAccountDO(env, ownerDigest, {
            type: 'invite-delivered',
            targetDeviceId,
            inviteId: intBody.inviteId,
            ts: Date.now()
          });
        }
      } catch { /* best-effort */ }
    }
    return result;
  }

  if (path === '/api/v1/invites/consume' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const accountToken = (body?.account_token || body?.accountToken || req.headers.get('x-account-token') || '').trim();
    const intBody = {
      inviteId: body.invite_id || body.inviteId,
      accountToken,
      accountDigest: auth.accountDigest
    };
    return handleInviteDropboxRoutes(internalRequest('/d1/invites/consume', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/invites/confirm' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const accountToken = (body?.account_token || body?.accountToken || req.headers.get('x-account-token') || '').trim();
    const intBody = {
      inviteId: body.invite_id || body.inviteId,
      accountToken,
      accountDigest: auth.accountDigest
    };
    return handleInviteDropboxRoutes(internalRequest('/d1/invites/confirm', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/invites/unconfirmed' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const accountToken = (body?.account_token || body?.accountToken || req.headers.get('x-account-token') || '').trim();
    const intBody = { accountToken, accountDigest: auth.accountDigest };
    return handleInviteDropboxRoutes(internalRequest('/d1/invites/unconfirmed', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/invites/status' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const accountToken = (body?.account_token || body?.accountToken || req.headers.get('x-account-token') || '').trim();
    const intBody = {
      inviteId: body.invite_id || body.inviteId,
      accountToken,
      accountDigest: auth.accountDigest
    };
    return handleInviteDropboxRoutes(internalRequest('/d1/invites/status', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/invites/lookup-code' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const accountToken = (body?.account_token || body?.accountToken || req.headers.get('x-account-token') || '').trim();
    const intBody = {
      pairingCode: body.pairing_code || body.pairingCode,
      accountToken,
      accountDigest: auth.accountDigest
    };
    return handleInviteDropboxRoutes(internalRequest('/d1/invites/lookup-code', 'POST', intBody, baseUrl), env);
  }

  // ── Ephemeral Chat ──────────────────────────────────────────
  if (path === '/api/v1/ephemeral/create-link' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const deviceId = (req.headers.get('x-device-id') || body?.device_id || body?.deviceId || '').trim();
    const intBody = {
      ownerDigest: auth.accountDigest,
      ownerDeviceId: deviceId,
      prekeyBundleJson: JSON.stringify(body?.prekey_bundle || body?.prekeyBundle || {})
    };
    return handleEphemeralRoutes(internalRequest('/d1/ephemeral/create-link', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/ephemeral/consume' && method === 'POST') {
    // No auth required — guest has no account
    const intBody = { token: body?.token };
    return handleEphemeralRoutes(internalRequest('/d1/ephemeral/consume', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/ephemeral/extend' && method === 'POST') {
    // Auth optional — guest may not have account
    const auth = await resolvePublicAuth(req, env, { body }).catch(() => null);
    const intBody = {
      sessionId: body?.session_id || body?.sessionId,
      callerDigest: auth?.accountDigest || body?.guest_digest || body?.guestDigest || ''
    };
    return handleEphemeralRoutes(internalRequest('/d1/ephemeral/extend', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/ephemeral/delete' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      sessionId: body?.session_id || body?.sessionId,
      ownerDigest: auth.accountDigest
    };
    return handleEphemeralRoutes(internalRequest('/d1/ephemeral/delete', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/ephemeral/revoke-invite' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      token: body?.token,
      ownerDigest: auth.accountDigest
    };
    return handleEphemeralRoutes(internalRequest('/d1/ephemeral/revoke-invite', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/ephemeral/revoke-invite' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      token: body?.token,
      ownerDigest: auth.accountDigest
    };
    return handleEphemeralRoutes(internalRequest('/d1/ephemeral/revoke-invite', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/ephemeral/list' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = { ownerDigest: auth.accountDigest };
    return handleEphemeralRoutes(internalRequest('/d1/ephemeral/list', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/ephemeral/session-info' && method === 'POST') {
    const intBody = { sessionId: body?.session_id || body?.sessionId };
    return handleEphemeralRoutes(internalRequest('/d1/ephemeral/session-info', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/ephemeral/ws-token' && method === 'POST') {
    // Issue a fresh WS token for an ephemeral guest
    const guestDigest = (body?.guest_digest || body?.guestDigest || '').trim();
    const sessionId = (body?.session_id || body?.sessionId || '').trim();
    if (!guestDigest || !sessionId) return json({ error: 'BadRequest' }, { status: 400 });
    await ensureDataTables(env);
    const session = await env.DB.prepare(
      `SELECT * FROM ephemeral_sessions WHERE session_id = ? AND guest_digest = ? AND deleted_at IS NULL`
    ).bind(sessionId, guestDigest).first();
    if (!session) return json({ error: 'NotFound' }, { status: 404 });
    const now = Math.floor(Date.now() / 1000);
    if (session.expires_at <= now) return json({ error: 'Expired' }, { status: 410 });
    const remaining = session.expires_at - now;
    try {
      const { token: jwt, payload } = await createWsToken(env, { accountDigest: guestDigest, ttlSec: remaining });
      return json({ token: jwt, expires_at: payload.exp });
    } catch (err) {
      return json({ error: 'TokenError', message: err?.message }, { status: 500 });
    }
  }

  // HTTP fallback for key exchange — stores guest bundle in D1 so owner can pick it up
  // even if the WS relay fails (e.g. owner tab backgrounded, WS disconnected)
  if (path === '/api/v1/ephemeral/key-exchange-submit' && method === 'POST') {
    const guestDigest = (body?.guest_digest || body?.guestDigest || '').trim();
    const sessionId = (body?.session_id || body?.sessionId || '').trim();
    const guestBundle = body?.guest_bundle || body?.guestBundle;
    if (!guestDigest || !sessionId || !guestBundle) return json({ error: 'BadRequest' }, { status: 400 });
    await ensureDataTables(env);
    const session = await env.DB.prepare(
      `SELECT * FROM ephemeral_sessions WHERE session_id = ? AND guest_digest = ? AND deleted_at IS NULL`
    ).bind(sessionId, guestDigest).first();
    if (!session) return json({ error: 'NotFound' }, { status: 404 });
    const now = Math.floor(Date.now() / 1000);
    if (session.expires_at <= now) return json({ error: 'Expired' }, { status: 410 });
    // Store guest bundle in D1 for owner to pick up
    await env.DB.prepare(
      `UPDATE ephemeral_sessions SET pending_key_exchange_json = ? WHERE session_id = ?`
    ).bind(JSON.stringify(guestBundle), sessionId).run();
    // Also try WS relay to owner (best-effort)
    try {
      await notifyAccountDO(env, session.owner_digest, {
        type: 'ephemeral-key-exchange',
        sessionId,
        conversationId: session.conversation_id,
        guestBundle,
        senderDigest: guestDigest
      });
    } catch (e) { console.warn('[ephemeral] key-exchange notify failed', e?.message); }
    return json({ ok: true });
  }

  // Owner clears the pending key exchange after processing
  if (path === '/api/v1/ephemeral/clear-pending-kex' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const sessionId = (body?.session_id || body?.sessionId || '').trim();
    if (!sessionId) return json({ error: 'BadRequest' }, { status: 400 });
    await ensureDataTables(env);
    await env.DB.prepare(
      `UPDATE ephemeral_sessions SET pending_key_exchange_json = NULL WHERE session_id = ? AND owner_digest = ?`
    ).bind(sessionId, auth.accountDigest).run();
    return json({ ok: true });
  }

  if (path === '/api/v1/ephemeral/cleanup' && method === 'POST') {
    return handleEphemeralRoutes(internalRequest('/d1/ephemeral/cleanup', 'POST', {}, baseUrl), env);
  }

  // ── Friends ───────────────────────────────────────────────────
  if (path === '/api/v1/friends/delete' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const senderDeviceId = (req.headers.get('x-device-id') || '').trim();
    if (!senderDeviceId) return json({ error: 'BadRequest', message: 'deviceId header required' }, { status: 400 });
    const peerDigest = normalizeAccountDigest(body?.peer_account_digest || body?.peerAccountDigest);
    if (!peerDigest) return json({ error: 'BadRequest', message: 'peer_account_digest required' }, { status: 400 });
    const conversationId = body?.conversation_id || body?.conversationId || null;
    const intBody = {
      ownerAccountDigest: auth.accountDigest,
      peerAccountDigest: peerDigest,
      ...(conversationId ? { conversationId } : {})
    };
    const result = await handleFriendsRoutes(internalRequest('/d1/friends/contact-delete', 'POST', intBody, baseUrl), env);
    // WS notifications: contact removed
    if (result && result.status < 400) {
      const targetDeviceId = body?.target_device_id || body?.targetDeviceId || null;
      await notifyAccountDO(env, peerDigest, {
        type: 'contact-removed',
        peerAccountDigest: auth.accountDigest,
        senderDeviceId,
        targetDeviceId,
        conversationId,
        ts: Date.now()
      });
    }
    return result;
  }

  // ── Messages ──────────────────────────────────────────────────
  if (path === '/api/v1/messages/atomic-send' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const deviceId = (req.headers.get('x-device-id') || '').trim() || body?.sender_device_id || body?.senderDeviceId;
    if (!deviceId) return json({ error: 'BadRequest', message: 'deviceId required' }, { status: 400 });
    // atomic-send: pass body through with accountDigest injected
    const intBody = { ...body, senderAccountDigest: auth.accountDigest, sender_account_digest: auth.accountDigest };
    delete intBody.account_token; delete intBody.accountToken;
    const result = await handleAtomicSendRoutes(internalRequest('/d1/messages/atomic-send', 'POST', intBody, baseUrl), env);
    // WS notification for message delivery
    if (result && result.status < 400) {
      try {
        const resData = await result.clone().json().catch(() => null);
        // [FIX] For atomic-send the receiver/message fields live inside body.message, not top-level
        const msg = body?.message || {};
        const receiverDigest = body?.receiver_account_digest || body?.receiverAccountDigest
          || msg.receiver_account_digest || msg.receiverAccountDigest;
        const convId = body?.conversation_id || body?.conversationId;
        if (receiverDigest && convId) {
          await notifyAccountDO(env, receiverDigest, {
            type: 'secure-message',
            conversationId: convId,
            messageId: msg.id || body?.id || body?.messageId || resData?.id || resData?.messageId || null,
            preview: body?.preview || '',
            ts: msg.created_at || body?.created_at || body?.ts || Date.now(),
            count: 1,
            counter: msg.counter ?? body?.counter ?? null,
            senderAccountDigest: auth.accountDigest,
            senderDeviceId: deviceId,
            targetDeviceId: msg.receiver_device_id || msg.receiverDeviceId || body?.receiver_device_id || body?.receiverDeviceId || null,
            peerAccountDigest: auth.accountDigest,
            targetAccountDigest: receiverDigest
          });
        }
      } catch { /* best-effort */ }
    }
    return result;
  }

  if (path === '/api/v1/messages/secure' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const deviceId = (req.headers.get('x-device-id') || body?.sender_device_id || body?.senderDeviceId || body?.device_id || body?.deviceId || '').trim();
    if (!deviceId) return json({ error: 'BadRequest', message: 'deviceId required' }, { status: 400 });
    const convId = normalizeConversationId(body?.conversation_id || body?.conversationId);
    if (!convId) return json({ error: 'BadRequest', message: 'conversation_id required' }, { status: 400 });
    // Conversation auth
    if (!isSystemOwnedConversation(convId, auth.accountDigest)) {
      try {
        await authorizeConversationDirect(env, { convId, accountDigest: auth.accountDigest, deviceId });
      } catch (err) {
        return json({ error: 'ConversationAccessDenied', message: err?.message || 'access denied' }, { status: err?.status || 403 });
      }
    }
    const intBody = {
      conversation_id: convId,
      sender_account_digest: auth.accountDigest,
      sender_device_id: deviceId,
      receiver_account_digest: body?.receiver_account_digest || body?.receiverAccountDigest,
      receiver_device_id: body?.receiver_device_id || body?.receiverDeviceId,
      header_json: body?.header_json || (body?.header ? JSON.stringify(body.header) : undefined),
      ciphertext_b64: body?.ciphertext_b64 || body?.ciphertext,
      counter: body?.counter,
      id: body?.id || body?.messageId,
      created_at: body?.created_at || body?.ts
    };
    // Use handleMessagesRoutes for /d1/messages (secure messages go through the same store path)
    const result = await handleMessagesRoutes(internalRequest('/d1/messages', 'POST', intBody, baseUrl), env);
    // WS notification
    if (result && result.status < 400) {
      const receiverDigest = intBody.receiver_account_digest;
      if (receiverDigest) {
        await notifyAccountDO(env, receiverDigest, {
          type: 'secure-message',
          conversationId: convId,
          messageId: intBody.id || null,
          preview: body?.preview || '',
          ts: Number(intBody.created_at || Date.now()),
          count: 1,
          counter: intBody.counter ?? null,
          senderAccountDigest: auth.accountDigest,
          senderDeviceId: deviceId,
          targetDeviceId: intBody.receiver_device_id || null,
          peerAccountDigest: auth.accountDigest,
          targetAccountDigest: receiverDigest
        });
      }
    }
    return result;
  }

  if (path === '/api/v1/messages' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const deviceId = (req.headers.get('x-device-id') || body?.sender_device_id || body?.senderDeviceId || body?.device_id || body?.deviceId || '').trim();
    if (!deviceId) return json({ error: 'BadRequest', message: 'deviceId required' }, { status: 400 });
    const convId = normalizeConversationId(body?.conv_id || body?.conversation_id || body?.conversationId);
    if (!convId) return json({ error: 'BadRequest', message: 'conversation_id required' }, { status: 400 });
    if (!isSystemOwnedConversation(convId, auth.accountDigest)) {
      try {
        await authorizeConversationDirect(env, { convId, accountDigest: auth.accountDigest, deviceId });
      } catch (err) {
        return json({ error: 'ConversationAccessDenied', message: err?.message || 'access denied' }, { status: err?.status || 403 });
      }
    }
    const receiverDigest = body?.receiver_account_digest || body?.receiverAccountDigest;
    const receiverDeviceId = body?.receiver_device_id || body?.receiverDeviceId;
    const intBody = {
      conversation_id: convId,
      sender_account_digest: auth.accountDigest,
      sender_device_id: deviceId,
      receiver_account_digest: receiverDigest,
      receiver_device_id: receiverDeviceId,
      header_json: body?.header_json || (body?.header ? JSON.stringify(body.header) : undefined),
      ciphertext_b64: body?.ciphertext_b64 || body?.ciphertext,
      counter: body?.counter,
      id: body?.id || body?.messageId,
      created_at: body?.created_at || body?.ts
    };
    const result = await handleMessagesRoutes(internalRequest('/d1/messages', 'POST', intBody, baseUrl), env);
    if (result && result.status < 400 && receiverDigest) {
      await notifyAccountDO(env, receiverDigest, {
        type: 'secure-message',
        conversationId: convId,
        messageId: intBody.id || null,
        preview: body?.preview || body?.text || '',
        ts: Number(intBody.created_at || Date.now()),
        count: 1,
        counter: intBody.counter ?? null,
        senderAccountDigest: auth.accountDigest,
        senderDeviceId: deviceId,
        targetDeviceId: receiverDeviceId || null,
        peerAccountDigest: auth.accountDigest,
        targetAccountDigest: receiverDigest
      });
    }
    return result;
  }

  if (path === '/api/v1/messages/secure' && method === 'GET') {
    const auth = await resolvePublicAuth(req, env, { body: null });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const convId = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');
    if (!convId) return json({ error: 'BadRequest', message: 'conversationId required' }, { status: 400 });
    // Build query string for internal handler
    const params = new URLSearchParams(url.searchParams);
    params.set('conversationId', convId);
    return handleMessagesRoutes(internalRequest(`/d1/messages/secure?${params.toString()}`, 'GET', null, baseUrl), env);
  }

  if (path === '/api/v1/messages/secure/max-counter' && method === 'GET') {
    const convId = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');
    const senderDeviceId = url.searchParams.get('senderDeviceId') || url.searchParams.get('sender_device_id');
    if (!convId) return json({ error: 'BadRequest', message: 'conversationId required' }, { status: 400 });
    // Internal handler expects POST with body
    const intBody = { conversationId: convId };
    if (senderDeviceId) intBody.senderDeviceId = senderDeviceId;
    return handleMessagesRoutes(internalRequest('/d1/messages/secure/max-counter', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/messages/by-counter' && method === 'GET') {
    const convId = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');
    const counter = url.searchParams.get('counter');
    if (!convId) return json({ error: 'BadRequest', message: 'conversationId required' }, { status: 400 });
    const params = new URLSearchParams();
    params.set('conversationId', convId);
    if (counter !== null) params.set('counter', counter);
    // Forward additional query params
    for (const [k, v] of url.searchParams) {
      if (!params.has(k)) params.set(k, v);
    }
    return handleMessagesRoutes(internalRequest(`/d1/messages/by-counter?${params.toString()}`, 'GET', null, baseUrl), env);
  }

  {
    const convMsgMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
    if (convMsgMatch && method === 'GET') {
      const convId = convMsgMatch[1];
      const params = new URLSearchParams(url.searchParams);
      params.set('conversationId', convId);
      return handleMessagesRoutes(internalRequest(`/d1/messages?${params.toString()}`, 'GET', null, baseUrl), env);
    }
  }

  if (path === '/api/v1/messages/send-state' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = { ...body };
    intBody.sender_account_digest = intBody.sender_account_digest || auth.accountDigest;
    delete intBody.account_token; delete intBody.accountToken;
    return handleMessagesRoutes(internalRequest('/d1/messages/send-state', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/messages/outgoing-status' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = { ...body };
    intBody.sender_account_digest = intBody.sender_account_digest || auth.accountDigest;
    delete intBody.account_token; delete intBody.accountToken;
    return handleMessagesRoutes(internalRequest('/d1/messages/outgoing-status', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/messages/delete' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = {
      ids: body.ids,
      conversation_id: body.conversation_id || body.conversationId,
      account_digest: auth.accountDigest
    };
    return handleMessagesRoutes(internalRequest('/d1/messages/delete', 'POST', intBody, baseUrl), env);
  }

  if (path === '/api/v1/deletion/cursor' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const intBody = { ...body, account_digest: auth.accountDigest, accountDigest: auth.accountDigest };
    delete intBody.account_token; delete intBody.accountToken;
    return handleMessagesRoutes(internalRequest('/d1/deletion/cursor', 'POST', intBody, baseUrl), env);
  }

  // ── Auth brand lookup (public, no auth needed) ────────────────
  if (path === '/api/v1/auth/brand' && method === 'GET') {
    const uidHex = url.searchParams.get('uid') || '';
    if (!uidHex) return json({ error: 'BadRequest', message: 'uid required' }, { status: 400 });
    const qs = `?uid=${encodeURIComponent(uidHex)}`;
    return handleAccountsRoutes(internalRequest(`/d1/accounts/brand${qs}`, 'GET', null, baseUrl), env);
  }

  // ── Calls ────────────────────────────────────────────────────────
  if (path === '/api/v1/calls/invite' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const senderDeviceId = (req.headers.get('x-device-id') || '').trim();
    if (!senderDeviceId) return json({ error: 'BadRequest', message: 'deviceId header required' }, { status: 400 });
    const peerDigest = normalizeAccountDigest(body?.peer_account_digest || body?.peerAccountDigest);
    if (!peerDigest) return json({ error: 'BadRequest', message: 'peer_account_digest required' }, { status: 400 });
    const callId = (body?.call_id || body?.callId || crypto.randomUUID()).toLowerCase();
    const ttlSeconds = clampNum(body?.expires_in_seconds ?? body?.expiresInSeconds ?? 90, 30, 600);
    // Device validation
    const devErr = await assertActiveDeviceOrReturn(env, auth.accountDigest, senderDeviceId);
    if (devErr) return devErr;
    let targetDeviceId;
    try {
      targetDeviceId = await resolveTargetDeviceDirect(env, peerDigest, body?.preferred_device_id || body?.preferredDeviceId || null);
    } catch (err) {
      if (!(body?.preferred_device_id || body?.preferredDeviceId)) {
        return json({ error: err?.code || 'peer-device-not-active', message: err?.message }, { status: err?.status || 409 });
      }
      targetDeviceId = body.preferred_device_id || body.preferredDeviceId;
    }
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const sessionPayload = {
      callId, callerAccountDigest: auth.accountDigest, calleeAccountDigest: peerDigest,
      callerDeviceId: senderDeviceId, status: 'dialing', mode: body?.mode || 'voice',
      capabilities: body?.capabilities || null,
      metadata: { ...(body?.metadata || {}), traceId: body?.trace_id || null, initiatedBy: auth.accountDigest },
      targetDeviceId, expiresAt
    };
    let sessionRes;
    try {
      sessionRes = await handleCallsRoutes(internalRequest('/d1/calls/session', 'POST', sessionPayload, baseUrl), env);
    } catch { sessionRes = null; }
    // Append call event (best-effort)
    try {
      await handleCallsRoutes(internalRequest('/d1/calls/events', 'POST', {
        callId, type: 'call-invite',
        payload: { traceId: body?.trace_id || null, mode: body?.mode || 'voice', capabilities: body?.capabilities || null, targetDeviceId },
        fromAccountDigest: auth.accountDigest, toAccountDigest: peerDigest, traceId: body?.trace_id || null
      }, baseUrl), env);
    } catch { /* best-effort */ }
    let session = null;
    if (sessionRes && sessionRes.status < 400) {
      try { session = (await sessionRes.json())?.session || null; } catch { session = null; }
    }
    // WS notification
    await notifyAccountDO(env, peerDigest, {
      type: 'call-invite',
      callId,
      fromAccountDigest: auth.accountDigest,
      toAccountDigest: peerDigest,
      fromDeviceId: senderDeviceId,
      toDeviceId: targetDeviceId,
      mode: body?.mode || 'voice',
      ts: Date.now()
    });
    return json({ ok: true, callId, targetDeviceId, session, expiresInSeconds: ttlSeconds });
  }

  if (path === '/api/v1/calls/cancel' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const senderDeviceId = (req.headers.get('x-device-id') || '').trim();
    if (!senderDeviceId) return json({ error: 'BadRequest', message: 'deviceId header required' }, { status: 400 });
    const callId = (body?.call_id || body?.callId || '').trim().toLowerCase();
    if (!callId) return json({ error: 'BadRequest', message: 'call_id required' }, { status: 400 });
    const devErr = await assertActiveDeviceOrReturn(env, auth.accountDigest, senderDeviceId);
    if (devErr) return devErr;
    const payload = {
      callId, status: 'ended', endReason: body?.reason || 'cancelled', endedAt: Date.now(), expiresAt: Date.now() + 30000,
      metadata: { cancelledBy: auth.accountDigest, cancelledByDeviceId: senderDeviceId }
    };
    let session = null;
    try {
      const r = await handleCallsRoutes(internalRequest('/d1/calls/session', 'POST', payload, baseUrl), env);
      if (r && r.status < 400) session = (await r.json())?.session || null;
    } catch { /* */ }
    try {
      await handleCallsRoutes(internalRequest('/d1/calls/events', 'POST', {
        callId, type: 'call-cancel', payload: { reason: body?.reason || 'cancelled' },
        fromAccountDigest: auth.accountDigest, traceId: body?.trace_id || null
      }, baseUrl), env);
    } catch { /* best-effort */ }
    return json({ ok: true, session });
  }

  if (path === '/api/v1/calls/acknowledge' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const senderDeviceId = (req.headers.get('x-device-id') || '').trim();
    if (!senderDeviceId) return json({ error: 'BadRequest', message: 'deviceId header required' }, { status: 400 });
    const callId = (body?.call_id || body?.callId || '').trim().toLowerCase();
    if (!callId) return json({ error: 'BadRequest', message: 'call_id required' }, { status: 400 });
    const devErr = await assertActiveDeviceOrReturn(env, auth.accountDigest, senderDeviceId);
    if (devErr) return devErr;
    const payload = {
      callId, status: 'ringing', expiresAt: Date.now() + 90000,
      metadata: { lastAckAccountDigest: auth.accountDigest, lastAckDeviceId: senderDeviceId }
    };
    let session = null;
    try {
      const r = await handleCallsRoutes(internalRequest('/d1/calls/session', 'POST', payload, baseUrl), env);
      if (r && r.status < 400) session = (await r.json())?.session || null;
    } catch { /* */ }
    try {
      await handleCallsRoutes(internalRequest('/d1/calls/events', 'POST', {
        callId, type: 'call-ack', payload: { ackAccountDigest: auth.accountDigest },
        fromAccountDigest: auth.accountDigest, traceId: body?.trace_id || null
      }, baseUrl), env);
    } catch { /* best-effort */ }
    return json({ ok: true, session });
  }

  if (path === '/api/v1/calls/metrics' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const senderDeviceId = (req.headers.get('x-device-id') || '').trim();
    if (!senderDeviceId) return json({ error: 'BadRequest', message: 'deviceId header required' }, { status: 400 });
    const callId = (body?.call_id || body?.callId || '').trim().toLowerCase();
    if (!callId) return json({ error: 'BadRequest', message: 'call_id required' }, { status: 400 });
    const devErr = await assertActiveDeviceOrReturn(env, auth.accountDigest, senderDeviceId);
    if (devErr) return devErr;
    const payload = {
      callId, metrics: body?.metrics, status: body?.status, endReason: body?.end_reason,
      endedAt: body?.ended ? Date.now() : undefined, senderDeviceId
    };
    let session = null;
    try {
      const r = await handleCallsRoutes(internalRequest('/d1/calls/session', 'POST', payload, baseUrl), env);
      if (r && r.status < 400) session = (await r.json())?.session || null;
    } catch { /* */ }
    try {
      await handleCallsRoutes(internalRequest('/d1/calls/events', 'POST', {
        callId, type: 'call-report-metrics', payload: body?.metrics || {},
        fromAccountDigest: auth.accountDigest
      }, baseUrl), env);
    } catch { /* best-effort */ }
    return json({ ok: true, session });
  }

  {
    const callSessionMatch = path.match(/^\/api\/v1\/calls\/session\/([^/]+)$/);
    if (callSessionMatch && method === 'GET') {
      const callId = callSessionMatch[1].trim().toLowerCase();
      if (!callId) return json({ error: 'BadRequest', message: 'invalid call id' }, { status: 400 });
      const auth = await resolvePublicAuth(req, env, { body: null });
      if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
      const senderDeviceId = (req.headers.get('x-device-id') || '').trim();
      if (!senderDeviceId) return json({ error: 'BadRequest', message: 'deviceId header required' }, { status: 400 });
      const devErr = await assertActiveDeviceOrReturn(env, auth.accountDigest, senderDeviceId);
      if (devErr) return devErr;
      const r = await handleCallsRoutes(internalRequest(`/d1/calls/session?callId=${encodeURIComponent(callId)}`, 'GET', null, baseUrl), env);
      if (!r || r.status >= 400) return r || json({ error: 'NotFound' }, { status: 404 });
      const data = await r.json();
      const session = data?.session;
      if (!session) return json({ error: 'NotFound', message: 'call session absent' }, { status: 404 });
      const isParticipant = (session.caller_account_digest === auth.accountDigest) || (session.callee_account_digest === auth.accountDigest);
      if (!isParticipant) return json({ error: 'Forbidden', message: 'not a participant of this call' }, { status: 403 });
      return json({ ok: true, session });
    }
  }

  if (path === '/api/v1/calls/network-config' && method === 'GET') {
    const auth = await resolvePublicAuth(req, env, { body: null });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const senderDeviceId = (req.headers.get('x-device-id') || '').trim();
    if (!senderDeviceId) return json({ error: 'BadRequest', message: 'deviceId header required' }, { status: 400 });
    const config = buildCallNetworkConfigEdge(env);
    return json({ ok: true, config });
  }

  if (path === '/api/v1/calls/turn-credentials' && method === 'POST') {
    const turnTokenId = env.CLOUDFLARE_TURN_TOKEN_ID || '';
    const turnTokenKey = env.CLOUDFLARE_TURN_TOKEN_KEY || '';
    if (!turnTokenId || !turnTokenKey) {
      return json({ error: 'ConfigError', message: 'Cloudflare TURN credentials not configured' }, { status: 500 });
    }
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const senderDeviceId = (req.headers.get('x-device-id') || '').trim();
    if (!senderDeviceId) return json({ error: 'BadRequest', message: 'deviceId header required' }, { status: 400 });
    const ttlSeconds = clampNum(body?.ttl_seconds ?? body?.ttlSeconds ?? 300, 60, 600);
    try {
      const cfResp = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${turnTokenId}/credentials/generate`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${turnTokenKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: ttlSeconds })
        }
      );
      if (!cfResp.ok) {
        return json({ error: 'TurnCredentialsFailed', message: `Cloudflare TURN API error: ${cfResp.status}` }, { status: 502 });
      }
      const cfData = await cfResp.json();
      const iceServers = [];
      if (cfData.iceServers?.urls && cfData.iceServers?.username && cfData.iceServers?.credential) {
        iceServers.push({
          urls: Array.isArray(cfData.iceServers.urls) ? cfData.iceServers.urls : [cfData.iceServers.urls],
          username: cfData.iceServers.username,
          credential: cfData.iceServers.credential
        });
      }
      return json({ ttl: ttlSeconds, expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds, iceServers });
    } catch (err) {
      return json({ error: 'TurnCredentialsFailed', message: err?.message || 'TURN API request failed' }, { status: 502 });
    }
  }

  // ── Subscription ─────────────────────────────────────────────────
  if (path === '/api/v1/subscription/redeem' && method === 'POST') {
    const token = body?.token;
    if (!token || typeof token !== 'string') return json({ error: 'BadRequest', message: 'token required' }, { status: 400 });
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const dryRun = body?.dry_run === true || body?.dryRun === true;
    let jwtResult;
    try {
      jwtResult = await verifyJwtRS256(token, env.PRIVATE_KEY_PUBLIC_PEM || '');
    } catch (err) {
      return json({ error: err?.code || 'InvalidVoucher', message: err?.message || 'JWT verification failed' }, { status: err?.status || 400 });
    }
    const { payload: jwtPayload, header: jwtHeader, signatureB64 } = jwtResult;
    const durationDays = Number(jwtPayload?.durationDays || jwtPayload?.extendDays || 0);
    if (!Number.isFinite(durationDays) || durationDays <= 0) {
      return json({ error: 'InvalidVoucher', message: '憑證缺少展期天數' }, { status: 400 });
    }
    const tokenId = jwtPayload?.voucherId || jwtPayload?.sub || jwtPayload?.jti;
    if (!tokenId) return json({ error: 'InvalidVoucher', message: '憑證缺少 voucherId/jti' }, { status: 400 });
    const redeemBody = {
      tokenId, voucherId: jwtPayload?.voucherId || null, jti: jwtPayload?.jti || null,
      agentId: jwtPayload?.agentId || null, durationDays,
      issuedAt: jwtPayload?.iat || null, expiresAt: jwtPayload?.exp || null,
      keyId: jwtHeader?.kid || 'default', signatureB64: signatureB64 || null,
      digest: auth.accountDigest, dryRun
    };
    return handleSubscriptionRoutes(internalRequest('/d1/subscription/redeem', 'POST', redeemBody, baseUrl), env);
  }

  if (path === '/api/v1/subscription/validate' && method === 'POST') {
    const token = body?.token;
    if (!token || typeof token !== 'string') return json({ error: 'BadRequest', message: 'token required' }, { status: 400 });
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    let jwtResult;
    try {
      jwtResult = await verifyJwtRS256(token, env.PRIVATE_KEY_PUBLIC_PEM || '');
    } catch (err) {
      return json({ error: err?.code || 'InvalidVoucher', message: err?.message || 'JWT verification failed' }, { status: err?.status || 400 });
    }
    const { payload: jwtPayload, header: jwtHeader, signatureB64 } = jwtResult;
    const durationDays = Number(jwtPayload?.durationDays || jwtPayload?.extendDays || 0);
    if (!Number.isFinite(durationDays) || durationDays <= 0) {
      return json({ error: 'InvalidVoucher', message: '憑證缺少展期天數' }, { status: 400 });
    }
    const tokenId = jwtPayload?.voucherId || jwtPayload?.sub || jwtPayload?.jti;
    if (!tokenId) return json({ error: 'InvalidVoucher', message: '憑證缺少 voucherId/jti' }, { status: 400 });
    const redeemBody = {
      tokenId, voucherId: jwtPayload?.voucherId || null, jti: jwtPayload?.jti || null,
      agentId: jwtPayload?.agentId || null, durationDays,
      issuedAt: jwtPayload?.iat || null, expiresAt: jwtPayload?.exp || null,
      keyId: jwtHeader?.kid || 'default', signatureB64: signatureB64 || null,
      digest: auth.accountDigest, dryRun: true
    };
    return handleSubscriptionRoutes(internalRequest('/d1/subscription/redeem', 'POST', redeemBody, baseUrl), env);
  }

  if (path === '/api/v1/subscription/status' && method === 'GET') {
    const digest = normalizeAccountDigest(url.searchParams.get('digest') || '');
    const uidDigest = normalizeAccountDigest(url.searchParams.get('uidDigest') || '');
    if (!digest && !uidDigest) return json({ error: 'BadRequest', message: 'digest or uidDigest required' }, { status: 400 });
    const params = new URLSearchParams();
    if (digest) params.set('digest', digest);
    if (!digest && uidDigest) params.set('uidDigest', uidDigest);
    const limitRaw = Number(url.searchParams.get('limit') || 0);
    if (Number.isFinite(limitRaw) && limitRaw > 0) params.set('limit', String(Math.min(Math.max(Math.floor(limitRaw), 1), 200)));
    return handleSubscriptionRoutes(internalRequest(`/d1/subscription/status?${params.toString()}`, 'GET', null, baseUrl), env);
  }

  if (path === '/api/v1/subscription/token-status' && method === 'GET') {
    const tokenId = url.searchParams.get('token_id') || url.searchParams.get('tokenId') || url.searchParams.get('voucherId') || url.searchParams.get('jti') || '';
    if (!tokenId.trim()) return json({ error: 'BadRequest', message: 'tokenId required' }, { status: 400 });
    return handleSubscriptionRoutes(internalRequest(`/d1/subscription/token-status?tokenId=${encodeURIComponent(tokenId.trim())}`, 'GET', null, baseUrl), env);
  }

  // ── Media ────────────────────────────────────────────────────────
  if (path === '/api/v1/media/sign-put' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const convId = normalizeConversationId(body?.conv_id || body?.conversationId);
    if (!convId) return json({ error: 'BadRequest', message: 'invalid conv_id' }, { status: 400 });
    if (!isSystemOwnedConversation(convId, auth.accountDigest)) {
      try {
        await authorizeConversationDirect(env, { convId, accountDigest: auth.accountDigest, deviceId: (req.headers.get('x-device-id') || '').trim() || null });
      } catch (err) {
        return json({ error: 'ConversationAccessDenied', message: err?.message || 'access denied' }, { status: err?.status || 403 });
      }
    }
    const maxBytes = Number(env.UPLOAD_MAX_BYTES || 1073741824);
    if (body?.size != null) {
      const sizeNum = Number(body.size);
      if (!Number.isFinite(sizeNum) || sizeNum <= 0) return json({ error: 'BadRequest', message: 'invalid size' }, { status: 400 });
      if (sizeNum > maxBytes) return json({ error: 'FileTooLarge', message: `Payload exceeds limit ${maxBytes} bytes`, maxBytes }, { status: 413 });
    }
    const direction = body?.direction === 'received' ? 'received' : (body?.direction === 'sent' ? 'sent' : null);
    let basePrefix = convId;
    if (direction === 'received') basePrefix = `${convId}/__SYS_RECV__`;
    else if (direction === 'sent') basePrefix = `${convId}/__SYS_SENT__`;
    let dirClean = '';
    if (body?.dir && typeof body.dir === 'string') {
      const segs = String(body.dir).replace(/\\+/g, '/').split('/').map(s => s ? s.normalize('NFKC').replace(/[\u0000-\u001F\u007F]/gu, '').replace(/[\\/]/g, '').replace(/[?#*<>"'`|]/g, '').trim().slice(0, 96) : '').filter(Boolean);
      if (segs.length) dirClean = segs.join('/');
    }
    const keyPrefix = dirClean ? `${basePrefix}/${dirClean}` : basePrefix;
    // Quota check via internal handler
    if (body?.size != null) {
      try {
        const usageResp = await handleMediaRoutes(internalRequest('/d1/media/usage', 'POST', { convId, prefix: basePrefix }, baseUrl), env);
        if (usageResp && usageResp.status < 400) {
          const usage = await usageResp.json();
          const totalBytes = Number(usage?.totalBytes ?? 0);
          const quota = Number(env.DRIVE_QUOTA_BYTES || 3221225472);
          if (Number.isFinite(totalBytes) && totalBytes + Number(body.size) > quota) {
            return json({ error: 'FolderCapacityExceeded', message: `空間不足，上限 ${quota} bytes`, maxBytes: quota, currentBytes: totalBytes }, { status: 413 });
          }
        }
      } catch { /* proceed without quota check */ }
    }
    const uid = generateNanoId();
    const key = `${keyPrefix}/${uid}`;
    const ct = body?.content_type || 'application/octet-stream';
    const ttlSec = Number(env.SIGNED_PUT_TTL || 900);
    try {
      const presignedUrl = await generatePresignedUrl(env, { method: 'PUT', key, expiresIn: ttlSec, contentType: ct });
      return json({ upload: { url: presignedUrl, bucket: env.S3_BUCKET, key, method: 'PUT', headers: { 'Content-Type': ct } }, expiresIn: ttlSec, objectPath: key });
    } catch (err) {
      return json({ error: 'PresignFailed', message: err?.message || 'failed to generate presigned URL' }, { status: 500 });
    }
  }

  if (path === '/api/v1/media/sign-get' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const keyStr = body?.key;
    if (!keyStr || typeof keyStr !== 'string' || keyStr.length < 3) return json({ error: 'BadRequest', message: 'key required' }, { status: 400 });
    const convIdFrag = keyStr.replace(/[\u0000-\u001F\u007F]/gu, '').trim();
    const firstSlash = convIdFrag.indexOf('/');
    const convIdPart = firstSlash === -1 ? convIdFrag : convIdFrag.slice(0, firstSlash);
    const convId = normalizeConversationId(convIdPart);
    if (!convId) return json({ error: 'BadRequest', message: 'invalid object key' }, { status: 400 });
    if (!isSystemOwnedConversation(convId, auth.accountDigest)) {
      try {
        await authorizeConversationDirect(env, { convId, accountDigest: auth.accountDigest, deviceId: (req.headers.get('x-device-id') || '').trim() || null });
      } catch (err) {
        return json({ error: 'ConversationAccessDenied', message: err?.message || 'access denied' }, { status: err?.status || 403 });
      }
    }
    const ttlSec = Number(env.SIGNED_GET_TTL || 900);
    try {
      const presignedUrl = await generatePresignedUrl(env, { method: 'GET', key: keyStr, expiresIn: ttlSec, downloadName: body?.download_name });
      return json({ download: { url: presignedUrl, bucket: env.S3_BUCKET, key: keyStr }, expiresIn: ttlSec });
    } catch (err) {
      return json({ error: 'PresignFailed', message: err?.message || 'failed to generate presigned URL' }, { status: 500 });
    }
  }

  if (path === '/api/v1/media/sign-put-chunked' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const convId = normalizeConversationId(body?.conv_id || body?.conversationId);
    if (!convId) return json({ error: 'BadRequest', message: 'invalid conv_id' }, { status: 400 });
    if (!isSystemOwnedConversation(convId, auth.accountDigest)) {
      try {
        await authorizeConversationDirect(env, { convId, accountDigest: auth.accountDigest, deviceId: (req.headers.get('x-device-id') || '').trim() || null });
      } catch (err) {
        return json({ error: 'ConversationAccessDenied', message: err?.message || 'access denied' }, { status: err?.status || 403 });
      }
    }
    const totalSize = Number(body?.total_size || 0);
    const chunkCount = Number(body?.chunk_count || 0);
    if (!totalSize || !chunkCount || chunkCount > 2000) return json({ error: 'BadRequest', message: 'total_size and chunk_count required' }, { status: 400 });
    const maxBytes = Number(env.UPLOAD_MAX_BYTES || 1073741824);
    if (totalSize > maxBytes) return json({ error: 'FileTooLarge', message: `Payload exceeds limit ${maxBytes} bytes`, maxBytes }, { status: 413 });
    const direction = body?.direction === 'received' ? 'received' : (body?.direction === 'sent' ? 'sent' : null);
    let basePrefix = convId;
    if (direction === 'received') basePrefix = `${convId}/__SYS_RECV__`;
    else if (direction === 'sent') basePrefix = `${convId}/__SYS_SENT__`;
    let dirClean = '';
    if (body?.dir && typeof body.dir === 'string') {
      const segs = String(body.dir).replace(/\\+/g, '/').split('/').map(s => s ? s.normalize('NFKC').replace(/[\u0000-\u001F\u007F]/gu, '').replace(/[\\/]/g, '').replace(/[?#*<>"'`|]/g, '').trim().slice(0, 96) : '').filter(Boolean);
      if (segs.length) dirClean = segs.join('/');
    }
    const keyPrefix = dirClean ? `${basePrefix}/${dirClean}` : basePrefix;
    // Quota check
    try {
      const usageResp = await handleMediaRoutes(internalRequest('/d1/media/usage', 'POST', { convId, prefix: basePrefix }, baseUrl), env);
      if (usageResp && usageResp.status < 400) {
        const usage = await usageResp.json();
        const totalBytes = Number(usage?.totalBytes ?? 0);
        const quota = Number(env.DRIVE_QUOTA_BYTES || 3221225472);
        if (Number.isFinite(totalBytes) && totalBytes + totalSize > quota) {
          return json({ error: 'FolderCapacityExceeded', message: `空間不足，上限 ${quota} bytes`, maxBytes: quota, currentBytes: totalBytes }, { status: 413 });
        }
      }
    } catch { /* proceed */ }
    const ttlSec = Number(env.SIGNED_PUT_TTL || 900);
    const ct = body?.content_type || 'application/octet-stream';
    const uid = generateNanoId();
    const baseKey = `${keyPrefix}/${uid}`;
    try {
      const manifestUrl = await generatePresignedUrl(env, { method: 'PUT', key: `${baseKey}/m`, expiresIn: ttlSec, contentType: 'application/octet-stream' });
      const manifest = { url: manifestUrl, bucket: env.S3_BUCKET, key: `${baseKey}/m`, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' } };
      const chunks = [];
      for (let i = 0; i < chunkCount; i++) {
        const chunkKey = `${baseKey}/c/${i}`;
        const chunkUrl = await generatePresignedUrl(env, { method: 'PUT', key: chunkKey, expiresIn: ttlSec, contentType: ct });
        chunks.push({ index: i, url: chunkUrl, bucket: env.S3_BUCKET, key: chunkKey, method: 'PUT', headers: { 'Content-Type': ct } });
      }
      return json({ baseKey, manifest, chunks, expiresIn: ttlSec });
    } catch (err) {
      return json({ error: 'PresignFailed', message: err?.message || 'failed to generate presigned URLs' }, { status: 500 });
    }
  }

  if (path === '/api/v1/media/sign-get-chunked' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const baseKeyStr = body?.base_key;
    if (!baseKeyStr || typeof baseKeyStr !== 'string' || baseKeyStr.length < 3) return json({ error: 'BadRequest', message: 'base_key required' }, { status: 400 });
    const convIdFrag = baseKeyStr.replace(/[\u0000-\u001F\u007F]/gu, '').trim();
    const firstSlash = convIdFrag.indexOf('/');
    const convIdPart = firstSlash === -1 ? convIdFrag : convIdFrag.slice(0, firstSlash);
    const convId = normalizeConversationId(convIdPart);
    if (!convId) return json({ error: 'BadRequest', message: 'invalid base_key' }, { status: 400 });
    if (!isSystemOwnedConversation(convId, auth.accountDigest)) {
      try {
        await authorizeConversationDirect(env, { convId, accountDigest: auth.accountDigest, deviceId: (req.headers.get('x-device-id') || '').trim() || null });
      } catch (err) {
        return json({ error: 'ConversationAccessDenied', message: err?.message || 'access denied' }, { status: err?.status || 403 });
      }
    }
    const ttlSec = Number(env.SIGNED_GET_TTL || 900);
    try {
      const manifestUrl = await generatePresignedUrl(env, { method: 'GET', key: `${baseKeyStr}/m`, expiresIn: ttlSec });
      const manifestGet = { url: manifestUrl, bucket: env.S3_BUCKET, key: `${baseKeyStr}/m` };
      const chunks = [];
      if (Array.isArray(body?.chunk_indices) && body.chunk_indices.length > 0) {
        for (const idx of body.chunk_indices) {
          const chunkKey = `${baseKeyStr}/c/${idx}`;
          const chunkUrl = await generatePresignedUrl(env, { method: 'GET', key: chunkKey, expiresIn: ttlSec });
          chunks.push({ index: idx, url: chunkUrl, bucket: env.S3_BUCKET, key: chunkKey });
        }
      }
      return json({ manifest: manifestGet, chunks, expiresIn: ttlSec });
    } catch (err) {
      return json({ error: 'PresignFailed', message: err?.message || 'failed to generate presigned URLs' }, { status: 500 });
    }
  }

  if (path === '/api/v1/media/cleanup-chunked' && method === 'POST') {
    // Cleanup requires S3 ListObjects + DeleteObjects — not feasible without SDK from Worker.
    // Delegate to Node.js or return a best-effort acknowledgment.
    // For now, we just verify auth + return ok (actual deletion handled by TTL or manual cleanup).
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    return json({ ok: true, deleted: 0, note: 'cleanup delegated to backend' });
  }

  if (path === '/api/v1/media/copy' && method === 'POST') {
    // Server-side S3 copy requires SDK — not available in pure Worker.
    // Return error directing client to re-upload or use Node.js path.
    return json({ error: 'NotImplemented', message: 'media/copy not yet available on edge; use origin server' }, { status: 501 });
  }

  if (path === '/api/v1/media/copy-chunked' && method === 'POST') {
    return json({ error: 'NotImplemented', message: 'media/copy-chunked not yet available on edge; use origin server' }, { status: 501 });
  }

  // ── Contacts (migrated from Node.js) ──────────────────────────
  // POST /api/v1/contacts/uplink — upsert encrypted contact list
  if (path === '/api/v1/contacts/uplink' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const contacts = Array.isArray(body?.contacts) ? body.contacts : [];
    const intBody = { accountDigest: auth.accountDigest, contacts };
    return handleContactsRoutes(internalRequest('/d1/contacts/upsert', 'POST', intBody, baseUrl), env);
  }

  // POST /api/v1/contacts/downlink — get contact snapshot
  if (path === '/api/v1/contacts/downlink' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const qs = `?accountDigest=${auth.accountDigest}`;
    return handleContactsRoutes(internalRequest(`/d1/contacts/snapshot${qs}`, 'GET', null, baseUrl), env);
  }

  // POST /api/v1/contacts/avatar/sign-put — get presigned upload URL for avatar
  if (path === '/api/v1/contacts/avatar/sign-put' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const peerDigest = normalizeAccountDigest(body?.peerDigest || body?.peer_digest);
    if (!peerDigest) return json({ error: 'BadRequest', message: 'peerDigest required' }, { status: 400 });
    const size = Number(body?.size || 0);
    if (size < 1 || size > 5 * 1024 * 1024) return json({ error: 'BadRequest', message: 'size must be 1–5MB' }, { status: 400 });
    const uid = generateNanoId();
    const key = `avatars/${auth.accountDigest}/${peerDigest}_${Date.now()}_${uid}.enc`;
    const ttlSec = 300;
    try {
      const presignedUrl = await generatePresignedUrl(env, { method: 'PUT', key, expiresIn: ttlSec, contentType: 'application/octet-stream' });
      return json({
        upload: { url: presignedUrl, bucket: env.S3_BUCKET, key, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' } },
        expiresIn: ttlSec,
        objectPath: key
      });
    } catch (err) {
      return json({ error: 'PresignFailed', message: err?.message || 'failed to generate presigned URL' }, { status: 500 });
    }
  }

  // POST /api/v1/contacts/avatar/sign-get — get presigned download URL for avatar
  if (path === '/api/v1/contacts/avatar/sign-get' && method === 'POST') {
    const auth = await resolvePublicAuth(req, env, { body });
    if (!auth) return json({ error: 'Unauthorized' }, { status: 401 });
    const keyStr = body?.key;
    if (!keyStr || typeof keyStr !== 'string') return json({ error: 'BadRequest', message: 'key required' }, { status: 400 });
    const expectedPrefix = `avatars/${auth.accountDigest}/`;
    if (!keyStr.startsWith(expectedPrefix)) {
      return json({ error: 'AccessDenied', message: 'invalid key scope' }, { status: 403 });
    }
    const ttlSec = 3600;
    try {
      const presignedUrl = await generatePresignedUrl(env, { method: 'GET', key: keyStr, expiresIn: ttlSec });
      return json({ download: { url: presignedUrl, bucket: env.S3_BUCKET, key: keyStr }, expiresIn: ttlSec });
    } catch (err) {
      return json({ error: 'PresignFailed', message: err?.message || 'failed to generate presigned URL' }, { status: 500 });
    }
  }

  // ── Admin (migrated from Node.js) ────────────────────────────
  // POST /api/v1/admin/set-brand — set brand info for account/uid
  if (path === '/api/v1/admin/set-brand' && method === 'POST') {
    // Verify admin HMAC (same as Node.js verifyIncomingHmac)
    if (!await verifyHMAC(req, env)) {
      return json({ error: 'Unauthorized', message: 'invalid admin signature' }, { status: 401 });
    }
    if (body?.brand === undefined) {
      return json({ error: 'BadRequest', message: 'brand field required' }, { status: 400 });
    }
    const payload = {
      brand: body.brand || null,
      brandName: body.brandName || body.brand_name || undefined,
      brandLogo: body.brandLogo || body.brand_logo || undefined,
      accountDigest: body.accountDigest || body.account_digest || undefined,
      uidDigest: body.uidDigest || body.uid_digest || undefined,
      uidHex: body.uidHex || body.uid_hex || undefined
    };
    return handleAccountsRoutes(internalRequest('/d1/accounts/set-brand', 'POST', payload, baseUrl), env);
  }

  // POST /api/v1/admin/purge-account — full account purge (D1 + S3 + WS logout)
  if (path === '/api/v1/admin/purge-account' && method === 'POST') {
    if (!await verifyHMAC(req, env)) {
      return json({ error: 'Unauthorized', message: 'invalid admin signature' }, { status: 401 });
    }
    const { uidDigest, accountDigest, dryRun = false } = body || {};
    if (!uidDigest && !accountDigest) {
      return json({ error: 'BadRequest', message: 'uidDigest or accountDigest required' }, { status: 400 });
    }
    // Step 1: Call internal D1 purge handler
    const purgeBody = {
      uidDigest: uidDigest || undefined,
      accountDigest: accountDigest || undefined,
      dryRun: !!dryRun
    };
    const purgeResult = await handleAccountsRoutes(
      internalRequest('/d1/accounts/purge', 'POST', purgeBody, baseUrl), env
    );
    let workerJson;
    try {
      workerJson = await purgeResult.clone().json();
    } catch {
      workerJson = null;
    }
    if (!purgeResult.ok) return purgeResult;
    const result = { worker: workerJson || {} };
    if (dryRun || workerJson?.skipped) return json(result);

    // Step 2: Delete S3/R2 objects
    const mediaKeys = Array.isArray(workerJson?.mediaKeys) ? workerJson.mediaKeys : [];
    const prefixes = Array.isArray(workerJson?.prefixes) ? workerJson.prefixes : [];
    const r2Summary = { deletedKeys: 0, failedKeys: [], prefixDeleted: 0, prefixFailures: [] };
    for (const key of mediaKeys) {
      try {
        await deleteS3Object(env, key);
        r2Summary.deletedKeys++;
      } catch (err) {
        r2Summary.failedKeys.push({ key, error: err?.message || String(err) });
      }
    }
    for (const prefix of prefixes) {
      try {
        const deleted = await deleteS3Prefix(env, prefix);
        r2Summary.prefixDeleted += deleted;
      } catch (err) {
        r2Summary.prefixFailures.push({ prefix, error: err?.message || String(err) });
      }
    }
    result.r2 = r2Summary;

    // Step 3: WS forceLogout
    const logoutDigest = workerJson?.accountDigest || null;
    if (logoutDigest) {
      // Force logout via DO, then close all sockets
      await notifyAccountDO(env, logoutDigest, {
        type: 'force-logout',
        reason: 'account purged',
        ts: Date.now()
      });
      // Also force-close all WS connections for this account
      try {
        const doId = env.ACCOUNT_WS.idFromName(logoutDigest.toUpperCase());
        const stub = env.ACCOUNT_WS.get(doId);
        await stub.fetch('https://do/force-close', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'account_purged' })
        });
      } catch {}
    }
    return json(result);
  }

  return null;
}

// ── Main fetch handler ──────────────────────────────────────────
export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);

      // ── CORS preflight for public API ──
      if (req.method === 'OPTIONS' && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/api'))) {
        return new Response(null, { status: 204, headers: buildCORSHeaders(req, env) });
      }

      // ── WebSocket upgrade → Durable Object ──
      if ((url.pathname === '/ws' || url.pathname === '/api/ws') && (req.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
        return handleWsUpgrade(req, env, url);
      }

      // ── Public API routes (no HMAC, account-token auth) ──
      if (url.pathname.startsWith('/api/')) {
        const result = await handlePublicRoutes(req, env);
        if (result) return withCORS(result, req, env);
        // No matching public route
        return withCORS(json({ error: 'not_found', message: 'no matching route' }, { status: 404 }), req, env);
      }

      // ── Internal API (HMAC-protected, backward-compat) ──
      if (!await verifyHMAC(req, env)) {
        return new Response('unauthorized', { status: 401 });
      }

      // 先搬好的 Tags/OPAQUE/DevKeys
      const tagResult = await handleTagsRoutes(req, env);
      if (tagResult) return tagResult;

      const inviteDropboxResult = await handleInviteDropboxRoutes(req, env);
      if (inviteDropboxResult) return inviteDropboxResult;

      const ephemeralResult = await handleEphemeralRoutes(req, env);
      if (ephemeralResult) return ephemeralResult;

      // Friends / Invites
      const friendsResult = await handleFriendsRoutes(req, env);
      if (friendsResult) return friendsResult;

      const prekeyResult = await handlePrekeysRoutes(req, env);
      if (prekeyResult) return prekeyResult;

      const atomicSendResult = await handleAtomicSendRoutes(req, env);
      if (atomicSendResult) return atomicSendResult;

      const messagesResult = await handleMessagesRoutes(req, env);
      if (messagesResult) return messagesResult;

      const contactSecretResult = await handleContactSecretsRoutes(req, env);
      if (contactSecretResult) return contactSecretResult;

      const messageKeyVaultResult = await handleMessageKeyVaultRoutes(req, env);
      if (messageKeyVaultResult) return messageKeyVaultResult;

      const groupsResult = await handleGroupsRoutes(req, env);
      if (groupsResult) return groupsResult;

      const mediaResult = await handleMediaRoutes(req, env);
      if (mediaResult) return mediaResult;

      const convResult = await handleConversationRoutes(req, env);
      if (convResult) return convResult;

      const subscriptionResult = await handleSubscriptionRoutes(req, env);
      if (subscriptionResult) return subscriptionResult;

      const devicesResult = await handleDeviceRoutes(req, env);
      if (devicesResult) return devicesResult;

      const callsResult = await handleCallsRoutes(req, env);
      if (callsResult) return callsResult;

      const accountsResult = await handleAccountsRoutes(req, env);
      if (accountsResult) return accountsResult;

      const contactsResult = await handleContactsRoutes(req, env);
      if (contactsResult) return contactsResult;

      // No matching internal route
      return json({ error: 'not_found', message: 'no matching internal route' }, { status: 404 });
    } catch (err) {
      console.error('[global-trap] worker exception', err);
      try {
        return json({
          error: 'WorkerGlobalException',
          message: err?.message || String(err),
          stack: err?.stack,
          name: err?.name
        }, { status: 500 });
      } catch {
        return new Response(JSON.stringify({ error: 'CriticalFailure' }), { status: 500 });
      }
    }
  }
};
