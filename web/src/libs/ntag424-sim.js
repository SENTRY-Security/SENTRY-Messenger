// /libs/ntag424-sim.js
// NTAG424 SDM debug模擬器（前端專用）
// - 允許輸入與伺服器端相同的 Root Key（HKDF 或 EV2 模式）
// - 用 localStorage 持久化模擬資料，方便迭代測試
// - 提供產生 UID / Counter / CMAC 的工具方法供登入頁 DEBUG 按鈕使用

import { toU8Strict } from '../shared/utils/u8-strict.js';

const SIM_STORAGE_KEY = 'ntag424-sim:v1';
const SIM_RESERVED_PREFIX = 'ntag424-sim:'; // 供其他模組辨識，登出時會保留此前綴資料
const DEFAULT_CONFIG = Object.freeze({
  mode: 'HKDF', // 'HKDF' | 'EV2'
  rootKeyHex: '',
  legacyKeyHex: '',
  salt: 'sentry.red',
  info: 'ntag424-static-key',
  tagidHex: '',
  kver: null
});

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function encodeUtf8(str) {
  if (textEncoder) return textEncoder.encode(str);
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) {
    arr[i] = str.charCodeAt(i) & 0xff;
  }
  return arr;
}

let cachedState = null; // 反序列化後的最新狀態
let memoryFallback = null; // localStorage 不可用時的 in-memory 儲存

function createDefaultState() {
  return {
    config: { ...DEFAULT_CONFIG },
    tags: [], // { uidHex, counter, note?, lastGenerated?: { counter, ctrHex, macHex, nonce, at } }
    selectedUidHex: null,
    updatedAt: Date.now()
  };
}

function hasLocalStorage() {
  try {
    if (typeof localStorage === 'undefined') return false;
    const probeKey = SIM_RESERVED_PREFIX + 'probe';
    localStorage.setItem(probeKey, '1');
    localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

function loadPersistentState() {
  if (cachedState) return cloneState(cachedState);

  const fallback = memoryFallback || createDefaultState();
  if (!hasLocalStorage()) {
    cachedState = normalizeState(fallback);
    memoryFallback = cloneState(cachedState);
    return cloneState(cachedState);
  }

  try {
    const raw = localStorage.getItem(SIM_STORAGE_KEY);
    if (!raw) {
      cachedState = normalizeState(fallback);
      persistState(cachedState);
      return cloneState(cachedState);
    }
    const parsed = JSON.parse(raw);
    cachedState = normalizeState(parsed);
    memoryFallback = cloneState(cachedState);
    return cloneState(cachedState);
  } catch (err) {
    console.warn('[ntag424-sim] load failed, fallback to memory', err);
    cachedState = normalizeState(fallback);
    memoryFallback = cloneState(cachedState);
    return cloneState(cachedState);
  }
}

function normalizeState(input) {
  const base = createDefaultState();
  if (!input || typeof input !== 'object') return base;

  // config
  const cfg = typeof input.config === 'object' && input.config ? input.config : {};
  base.config = {
    mode: (cfg.mode || DEFAULT_CONFIG.mode || 'HKDF').toString().toUpperCase(),
    rootKeyHex: sanitizeHexKey(cfg.rootKeyHex || ''),
    legacyKeyHex: sanitizeHexKey(cfg.legacyKeyHex || ''),
    salt: typeof cfg.salt === 'string' && cfg.salt.length ? cfg.salt : DEFAULT_CONFIG.salt,
    info: typeof cfg.info === 'string' && cfg.info.length ? cfg.info : DEFAULT_CONFIG.info,
    tagidHex: sanitizeHexString(cfg.tagidHex || ''),
    kver: (cfg.kver === null || cfg.kver === undefined) ? null : Number(cfg.kver)
  };

  // tags array
  const tags = Array.isArray(input.tags) ? input.tags : [];
  base.tags = tags
    .map((tag) => normalizeTag(tag))
    .filter(Boolean);
  base.selectedUidHex = normalizeUid(input.selectedUidHex) || (base.tags[0]?.uidHex ?? null);
  base.updatedAt = Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : Date.now();
  return base;
}

function normalizeTag(tag) {
  if (!tag || typeof tag !== 'object') return null;
  const uidHex = normalizeUid(tag.uidHex || tag.uid);
  if (!uidHex) return null;
  const counter = normalizeCounterValue(tag.counter);
  const out = {
    uidHex,
    counter,
    note: typeof tag.note === 'string' ? tag.note : undefined
  };
  if (tag.lastGenerated && typeof tag.lastGenerated === 'object') {
    out.lastGenerated = {
      counter: Number.isFinite(tag.lastGenerated.counter) ? Number(tag.lastGenerated.counter) : counter,
      ctrHex: typeof tag.lastGenerated.ctrHex === 'string' ? tag.lastGenerated.ctrHex : undefined,
      macHex: typeof tag.lastGenerated.macHex === 'string' ? tag.lastGenerated.macHex : undefined,
      nonce: typeof tag.lastGenerated.nonce === 'string' ? tag.lastGenerated.nonce : undefined,
      at: Number.isFinite(tag.lastGenerated.at) ? Number(tag.lastGenerated.at) : Date.now()
    };
  }
  return out;
}

function normalizeCounterValue(value) {
  const num = Number.isFinite(value) ? Number(value) : parseInt(value || '0', 10);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num & 0xffffff; // 24-bit counter
}

function persistState(state) {
  cachedState = normalizeState(state);
  memoryFallback = cloneState(cachedState);
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(SIM_STORAGE_KEY, JSON.stringify(cachedState));
  } catch (err) {
    console.warn('[ntag424-sim] persist failed', err);
  }
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function sanitizeHexKey(hex) {
  const clean = sanitizeHexString(hex);
  if (!clean) return '';
  if (clean.length !== 32) throw new Error('Root key 需為 32 個十六進位字元 (16 bytes)');
  return clean.toUpperCase();
}

function sanitizeHexString(hex) {
  if (hex === null || hex === undefined) return '';
  const clean = String(hex).replace(/[^0-9a-f]/gi, '');
  return clean.toUpperCase();
}

function normalizeUid(uid) {
  const clean = sanitizeHexString(uid);
  if (clean.length < 14) return null;
  return clean.slice(0, 14);
}

function ensureStateMutator(mutator) {
  const state = loadPersistentState();
  mutator(state);
  state.updatedAt = Date.now();
  persistState(state);
  return cloneState(state);
}

function ensureTagEntry(state, uidHex) {
  const normUid = normalizeUid(uidHex);
  if (!normUid) throw new Error('無效的 UID（需 14 個十六進位字元）');
  let found = state.tags.find((t) => t.uidHex === normUid);
  if (!found) {
    found = { uidHex: normUid, counter: 1 };
    state.tags.push(found);
  }
  return found;
}

function toCounterHex(counter) {
  const value = normalizeCounterValue(counter);
  return value.toString(16).toUpperCase().padStart(6, '0');
}

function normCtrHex(input) {
  const s = sanitizeHexString(input || '');
  const right6 = s.length > 6 ? s.slice(-6) : s;
  return right6.padStart(6, '0');
}

function toLsb3Bytes(ctrHex) {
  const norm = normCtrHex(ctrHex);
  const buf = hexToBytes(norm);
  if (buf.length !== 3) {
    const padded = new Uint8Array(3);
    const start = Math.max(0, buf.length - 3);
    padded.set(buf.subarray(start));
    return reverseBytes(padded);
  }
  return reverseBytes(buf);
}

function reverseBytes(u8) {
  const out = new Uint8Array(u8.length);
  for (let i = 0; i < u8.length; i += 1) {
    out[i] = u8[u8.length - 1 - i];
  }
  return out;
}

function hexToBytes(hex) {
  const clean = sanitizeHexString(hex);
  if (clean.length % 2 === 1) {
    return hexToBytes('0' + clean);
  }
  const len = clean.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, arr) => sum + (arr ? arr.length : 0), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (!chunk || !chunk.length) continue;
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// --- AES-128 實作（僅支援單一區塊加密，供 CMAC 使用） ---
const SBOX = new Uint8Array([
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
]);
const RCON = new Uint8Array([0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36]);

function aesExpandKey(key) {
  if (!key || key.length !== 16) throw new Error('AES key 必須為 16 bytes');
  const expanded = new Uint8Array(176);
  expanded.set(key);
  let bytesGenerated = 16;
  let rconIter = 1;
  const temp = new Uint8Array(4);

  while (bytesGenerated < 176) {
    for (let i = 0; i < 4; i += 1) {
      temp[i] = expanded[bytesGenerated - 4 + i];
    }
    if (bytesGenerated % 16 === 0) {
      // RotWord + SubWord + RCON
      const t = temp[0];
      temp[0] = SBOX[temp[1]];
      temp[1] = SBOX[temp[2]];
      temp[2] = SBOX[temp[3]];
      temp[3] = SBOX[t];
      temp[0] ^= RCON[rconIter++];
    } else if (bytesGenerated % 16 === 8) {
      temp[0] = SBOX[temp[0]];
      temp[1] = SBOX[temp[1]];
      temp[2] = SBOX[temp[2]];
      temp[3] = SBOX[temp[3]];
    }
    for (let i = 0; i < 4; i += 1) {
      expanded[bytesGenerated] = expanded[bytesGenerated - 16] ^ temp[i];
      bytesGenerated += 1;
    }
  }
  return expanded;
}

function aesEncryptBlock(plain, expandedKey) {
  if (!plain || plain.length !== 16) throw new Error('明文需為 16 bytes');
  if (!expandedKey || expandedKey.length !== 176) throw new Error('expandedKey 無效');
  const state = new Uint8Array(plain);

  addRoundKey(state, expandedKey, 0);
  for (let round = 1; round < 10; round += 1) {
    subBytes(state);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, expandedKey, round * 16);
  }
  subBytes(state);
  shiftRows(state);
  addRoundKey(state, expandedKey, 160);
  return state;
}

function addRoundKey(state, expandedKey, offset) {
  for (let i = 0; i < 16; i += 1) {
    state[i] ^= expandedKey[offset + i];
  }
}

function subBytes(state) {
  for (let i = 0; i < 16; i += 1) {
    state[i] = SBOX[state[i]];
  }
}

function shiftRows(state) {
  const t = new Uint8Array(state);
  state[0] = t[0];
  state[1] = t[5];
  state[2] = t[10];
  state[3] = t[15];
  state[4] = t[4];
  state[5] = t[9];
  state[6] = t[14];
  state[7] = t[3];
  state[8] = t[8];
  state[9] = t[13];
  state[10] = t[2];
  state[11] = t[7];
  state[12] = t[12];
  state[13] = t[1];
  state[14] = t[6];
  state[15] = t[11];
}

function mixColumns(state) {
  for (let c = 0; c < 4; c += 1) {
    const i = c * 4;
    const a0 = state[i];
    const a1 = state[i + 1];
    const a2 = state[i + 2];
    const a3 = state[i + 3];
    state[i] = mul2(a0) ^ mul3(a1) ^ a2 ^ a3;
    state[i + 1] = a0 ^ mul2(a1) ^ mul3(a2) ^ a3;
    state[i + 2] = a0 ^ a1 ^ mul2(a2) ^ mul3(a3);
    state[i + 3] = mul3(a0) ^ a1 ^ a2 ^ mul2(a3);
  }
}

function mul2(x) {
  const res = x << 1;
  return ((res & 0xff) ^ ((x & 0x80) ? 0x1b : 0)) & 0xff;
}

function mul3(x) {
  return (mul2(x) ^ x) & 0xff;
}

function xorBlock(a, b) {
  const len = Math.min(a.length, b.length);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

function dbl(block) {
  const out = new Uint8Array(block.length);
  let carry = 0;
  for (let i = block.length - 1; i >= 0; i -= 1) {
    const val = block[i];
    out[i] = ((val << 1) & 0xff) | carry;
    carry = (val & 0x80) ? 1 : 0;
  }
  if (carry) out[out.length - 1] ^= 0x87;
  return out;
}

function aesCmacBlock(keyBytes, message) {
  const expandedKey = aesExpandKey(keyBytes);
  const zero = new Uint8Array(16);
  const L = aesEncryptBlock(zero, expandedKey);
  const K1 = dbl(L);
  const K2 = dbl(K1);

  const msg = message && message.length ? message : new Uint8Array(0);
  const n = Math.max(1, Math.ceil(msg.length / 16));
  const lastBlockComplete = msg.length > 0 && msg.length % 16 === 0;
  const lastBlock = new Uint8Array(16);

  if (lastBlockComplete) {
    const prev = msg.subarray((n - 1) * 16, n * 16);
    lastBlock.set(xorBlock(prev, K1));
  } else {
    const rem = msg.subarray((n - 1) * 16);
    lastBlock.set(rem);
    lastBlock[rem.length] = 0x80;
    const padded = xorBlock(lastBlock, K2);
    lastBlock.set(padded);
  }

  let X = new Uint8Array(16); // 初始為 0^128
  for (let i = 0; i < n - 1; i += 1) {
    const block = msg.subarray(i * 16, i * 16 + 16);
    const y = xorBlock(X, block.length === 16 ? block : padBlock(block));
    X = aesEncryptBlock(y, expandedKey);
  }
  const finalInput = xorBlock(X, lastBlock);
  const result = aesEncryptBlock(finalInput, expandedKey);
  return result;
}

function padBlock(block) {
  const out = new Uint8Array(16);
  out.set(block);
  out[block.length] = 0x80;
  return out;
}

function getSubtle() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle) {
    return self.crypto.subtle;
  }
  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    return window.crypto.subtle;
  }
  throw new Error('當前環境不支援 WebCrypto SubtleCrypto');
}

async function hmacSha256(keyBytes, dataBytes) {
  const subtle = getSubtle();
  const keyData = keyBytes && keyBytes.length ? keyBytes : new Uint8Array([0]);
  const cryptoKey = await subtle.importKey(
    'raw',
    toU8Strict(keyData, 'web/src/libs/ntag424-sim.js:454:hmacSha256'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await subtle.sign('HMAC', cryptoKey, dataBytes);
  return new Uint8Array(signature);
}

async function hkdf16(rootKeyHex, uidHex, { salt, info }) {
  const ikm = hexToBytes(rootKeyHex);
  const saltBytes = encodeUtf8(salt || '');
  const prk = await hmacSha256(saltBytes, ikm);
  const infoBytes = encodeUtf8(`${info || 'ntag424-static-key'}:${uidHex}`);
  const okm = await hmacSha256(prk, infoBytes);
  return okm.subarray(0, 16);
}

function deriveEv2Key(rootKeyHex, { uidHex, tagidHex, kver }) {
  const km = hexToBytes(rootKeyHex);
  const parts = [new Uint8Array([0x01]), encodeUtf8('EV2-KDF')];
  if (uidHex) parts.push(hexToBytes(uidHex));
  if (tagidHex) parts.push(hexToBytes(tagidHex));
  if (Number.isFinite(kver)) parts.push(new Uint8Array([Number(kver) & 0xff]));
  const msg = concatBytes(...parts);
  const mac = aesCmacBlock(km, msg);
  return mac.subarray(0, 16);
}

function deriveKSesSDMFileReadMAC(sdmFileReadKey, uidHex, ctrHex) {
  const uidBytes = hexToBytes(uidHex);
  if (uidBytes.length !== 7) throw new Error('UID 必須為 7 bytes (14 hex)');
  const ctrBytes = toLsb3Bytes(ctrHex);
  const sv2 = concatBytes(hexToBytes('3CC300010080'), uidBytes, ctrBytes);
  return aesCmacBlock(sdmFileReadKey, sv2);
}

function mac16To8(mac16) {
  const out = new Uint8Array(8);
  for (let i = 0, j = 1; i < 8; i += 1, j += 2) {
    out[i] = mac16[j];
  }
  return out;
}

async function deriveSdmFileReadKey({ uidHex, config }) {
  const mode = (config.mode || 'HKDF').toUpperCase();
  const rootKeyHex = config.rootKeyHex;
  if (!rootKeyHex) throw new Error('尚未設定 Root Key');
  if (mode === 'EV2') {
    return deriveEv2Key(rootKeyHex, { uidHex, tagidHex: config.tagidHex, kver: config.kver });
  }
  return await hkdf16(rootKeyHex, uidHex, { salt: config.salt || DEFAULT_CONFIG.salt, info: config.info || DEFAULT_CONFIG.info });
}

async function computeSdmCmac({ uidHex, ctrHex, cmacInput = '', config }) {
  const sdmKey = await deriveSdmFileReadKey({ uidHex, config });
  const sessionKey = deriveKSesSDMFileReadMAC(sdmKey, uidHex, ctrHex);
  const payload = typeof cmacInput === 'string'
    ? encodeUtf8(cmacInput)
    : (cmacInput instanceof Uint8Array ? cmacInput : new Uint8Array());
  const macFull = aesCmacBlock(sessionKey, payload);
  return bytesToHex(mac16To8(macFull));
}

function ensureSimConfigPresent(config) {
  if (!config.rootKeyHex) throw new Error('尚未設定模擬 Root Key（請先透過 setSimConfig 指定）');
}

export function getSimState() {
  return loadPersistentState();
}

export function setSimConfig(partial = {}) {
  return ensureStateMutator((state) => {
    const cfg = state.config;
    if (Object.prototype.hasOwnProperty.call(partial, 'rootKeyHex')) {
      cfg.rootKeyHex = partial.rootKeyHex ? sanitizeHexKey(partial.rootKeyHex) : '';
    }
    if (Object.prototype.hasOwnProperty.call(partial, 'legacyKeyHex')) {
      const val = partial.legacyKeyHex ? sanitizeHexKey(partial.legacyKeyHex) : '';
      cfg.legacyKeyHex = val;
    }
    if (partial.mode) cfg.mode = String(partial.mode).toUpperCase() === 'EV2' ? 'EV2' : 'HKDF';
    if (Object.prototype.hasOwnProperty.call(partial, 'salt')) {
      cfg.salt = typeof partial.salt === 'string' ? partial.salt : DEFAULT_CONFIG.salt;
    }
    if (Object.prototype.hasOwnProperty.call(partial, 'info')) {
      cfg.info = typeof partial.info === 'string' ? partial.info : DEFAULT_CONFIG.info;
    }
    if (Object.prototype.hasOwnProperty.call(partial, 'tagidHex')) {
      cfg.tagidHex = sanitizeHexString(partial.tagidHex || '');
    }
    if (Object.prototype.hasOwnProperty.call(partial, 'kver')) {
      cfg.kver = partial.kver === null || partial.kver === undefined ? null : Number(partial.kver);
    }
    state.config = cfg;
  });
}

export function upsertSimTag({ uidHex, counter, note }) {
  return ensureStateMutator((state) => {
    const tag = ensureTagEntry(state, uidHex);
    if (counter !== undefined) tag.counter = normalizeCounterValue(counter);
    if (note !== undefined) tag.note = note;
  });
}

export function setSimSelectedUid(uidHex) {
  return ensureStateMutator((state) => {
    const norm = normalizeUid(uidHex);
    if (!norm) throw new Error('UID 需為 14 個十六進位字元');
    ensureTagEntry(state, norm);
    state.selectedUidHex = norm;
  });
}

export function incrementSimCounter(uidHex, step = 1) {
  return ensureStateMutator((state) => {
    const tag = ensureTagEntry(state, uidHex);
    const delta = Number.isFinite(step) ? Number(step) : 1;
    tag.counter = normalizeCounterValue(tag.counter + delta);
  });
}

export function resetSimData() {
  const fresh = createDefaultState();
  persistState(fresh);
  return cloneState(fresh);
}

export async function generateSimExchange({ uidHex, advance = true, cmacInput = '', nonce } = {}) {
  const state = loadPersistentState();
  const config = state.config;
  ensureSimConfigPresent(config);

  const targetUid = normalizeUid(uidHex || state.selectedUidHex || (state.tags[0]?.uidHex ?? ''));
  if (!targetUid) throw new Error('尚未設定模擬 UID，請先使用 upsertSimTag 指定');

  const tag = state.tags.find((t) => t.uidHex === targetUid) || ensureTagEntry(state, targetUid);
  const counterValue = normalizeCounterValue(tag.counter);
  const ctrHex = toCounterHex(counterValue);
  const macHex = await computeSdmCmac({ uidHex: targetUid, ctrHex, cmacInput, config });
  const nonceStr = nonce || `SIM-${Date.now()}`;

  tag.lastGenerated = {
    counter: counterValue,
    ctrHex,
    macHex,
    nonce: nonceStr,
    at: Date.now()
  };
  if (advance) {
    tag.counter = normalizeCounterValue(counterValue + 1);
  }
  state.selectedUidHex = targetUid;
  persistState(state);
  return {
    uidHex: targetUid,
    sdmcounter: ctrHex,
    sdmmac: macHex,
    nonce: nonceStr
  };
}

export function getSimStorageKey() {
  return SIM_STORAGE_KEY;
}

export function getSimStoragePrefix() {
  return SIM_RESERVED_PREFIX;
}
