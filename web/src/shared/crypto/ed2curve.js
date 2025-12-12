/**
 * SECURITY POLICY – STRICT CRYPTO PROTOCOL, NO FALLBACK ALLOWED.
 *
 * 本檔案中的所有密碼協定（X3DH、Double Ratchet、AEAD、鍵派生、counter 驗證、header 驗證）
 * 禁止設計、加入或推論任何 fallback、retry、rollback、resync、auto-repair 等邏輯。
 *
 * 規則如下：
 * 1. 若解密失敗 → 一律直接 fail，不可嘗試第二組 key 或舊 ratchet state。
 * 2. 若 counter 不一致 → 一律直接拒絕，不可重送、補拉或自動對齊。
 * 3. 不允許任何協定降級（downgrade）。不得用舊版本、舊頭資訊、舊密鑰重試。
 * 4. 不允許模糊錯誤處理。不做 try-catch fallback，不做 silent recovery。
 * 5. 對話重置必須是顯式事件，不得隱式重建 state。
 *
 * 一切協定邏輯必須「單一路徑」且「強一致性」，任何 fallback 視為安全漏洞。
 */
import { ensureNacl } from './nacl.js';

let cached = null;

function initEd2Curve(nacl) {
  if (cached) return cached;

  const gf = (init) => {
    const r = new Float64Array(16);
    if (init) {
      for (let i = 0; i < init.length; i += 1) r[i] = init[i];
    }
    return r;
  };

  const gf0 = gf();
  const gf1 = gf([1]);
  const D = gf([0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070, 0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203]);
  const I = gf([0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43, 0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83]);

  const car25519 = (o) => {
    for (let i = 0; i < 16; i += 1) {
      o[i] += 65536;
      const c = Math.floor(o[i] / 65536);
      o[(i + 1) * (i < 15 ? 1 : 0)] += c - 1 + 37 * (c - 1) * (i === 15 ? 1 : 0);
      o[i] -= c * 65536;
    }
  };

  const sel25519 = (p, q, b) => {
    const c = ~(b - 1);
    for (let i = 0; i < 16; i += 1) {
      const t = c & (p[i] ^ q[i]);
      p[i] ^= t;
      q[i] ^= t;
    }
  };

  const pack25519 = (o, n) => {
    const m = gf();
    const t = gf();
    for (let i = 0; i < 16; i += 1) t[i] = n[i];
    car25519(t);
    car25519(t);
    car25519(t);
    for (let j = 0; j < 2; j += 1) {
      m[0] = t[0] - 0xffed;
      for (let i = 1; i < 15; i += 1) {
        m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
        m[i - 1] &= 0xffff;
      }
      m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
      const b = (m[15] >> 16) & 1;
      m[14] &= 0xffff;
      sel25519(t, m, 1 - b);
    }
    for (let i = 0; i < 16; i += 1) {
      o[2 * i] = t[i] & 0xff;
      o[2 * i + 1] = t[i] >> 8;
    }
  };

  const unpack25519 = (o, n) => {
    for (let i = 0; i < 16; i += 1) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
    o[15] &= 0x7fff;
  };

  const A = (o, a, b) => {
    for (let i = 0; i < 16; i += 1) o[i] = (a[i] + b[i]) | 0;
  };

  const Z = (o, a, b) => {
    for (let i = 0; i < 16; i += 1) o[i] = (a[i] - b[i]) | 0;
  };

  const M = (o, a, b) => {
    const t = new Float64Array(31);
    for (let i = 0; i < 31; i += 1) t[i] = 0;
    for (let i = 0; i < 16; i += 1) {
      for (let j = 0; j < 16; j += 1) {
        t[i + j] += a[i] * b[j];
      }
    }
    for (let i = 0; i < 15; i += 1) t[i] += 38 * t[i + 16];
    for (let i = 0; i < 16; i += 1) o[i] = t[i];
    car25519(o);
    car25519(o);
  };

  const S = (o, a) => { M(o, a, a); };

  const neq25519 = (a, b) => {
    const c = new Uint8Array(32);
    const d = new Uint8Array(32);
    pack25519(c, a);
    pack25519(d, b);
    let r = 0;
    for (let i = 0; i < 32; i += 1) r |= c[i] ^ d[i];
    return r !== 0;
  };

  const par25519 = (a) => {
    const d = new Uint8Array(32);
    pack25519(d, a);
    return d[0] & 1;
  };

  const pow2523 = (o, i) => {
    const c = gf();
    for (let a = 0; a < 16; a += 1) c[a] = i[a];
    for (let a = 250; a >= 0; a -= 1) {
      S(c, c);
      if (a !== 1) M(c, c, i);
    }
    for (let a = 0; a < 16; a += 1) o[a] = c[a];
  };

  const set25519 = (r, a) => {
    for (let i = 0; i < 16; i += 1) r[i] = a[i] | 0;
  };

  const inv25519 = (o, i) => {
    const c = gf();
    for (let a = 0; a < 16; a += 1) c[a] = i[a];
    for (let a = 253; a >= 0; a -= 1) {
      S(c, c);
      if (a !== 2 && a !== 4) M(c, c, i);
    }
    for (let a = 0; a < 16; a += 1) o[a] = c[a];
  };

  const unpackneg = (r, p) => {
    const t = gf();
    const chk = gf();
    const num = gf();
    const den = gf();
    const den2 = gf();
    const den4 = gf();
    const den6 = gf();

    set25519(r[2], gf1);
    unpack25519(r[1], p);
    S(num, r[1]);
    M(den, num, D);
    Z(num, num, r[2]);
    A(den, r[2], den);
    S(den2, den);
    S(den4, den2);
    M(den6, den4, den2);
    M(t, den6, num);
    M(t, t, den);
    pow2523(t, t);
    M(t, t, num);
    M(t, t, den);
    M(t, t, den);
    M(r[0], t, den);
    S(chk, r[0]);
    M(chk, chk, den);
    if (neq25519(chk, num)) M(r[0], r[0], I);
    S(chk, r[0]);
    M(chk, chk, den);
    if (neq25519(chk, num)) return -1;
    if (par25519(r[0]) === (p[31] >> 7)) Z(r[0], gf0, r[0]);
    M(r[3], r[0], r[1]);
    return 0;
  };

  const convertPublicKey = (pk) => {
    if (!(pk instanceof Uint8Array) || pk.length !== 32) return null;
    const z = new Uint8Array(32);
    const q = [gf(), gf(), gf(), gf()];
    const a = gf();
    const b = gf();
    if (unpackneg(q, pk)) return null;
    const y = q[1];
    A(a, gf1, y);
    Z(b, gf1, y);
    inv25519(b, b);
    M(a, a, b);
    pack25519(z, a);
    return z;
  };

  const convertSecretKey = (sk) => {
    if (!(sk instanceof Uint8Array) || sk.length !== 32) return null;
    if (!nacl.lowlevel || typeof nacl.lowlevel.crypto_hash !== 'function') {
      throw new Error('nacl.lowlevel.crypto_hash unavailable');
    }
    const d = new Uint8Array(64);
    const o = new Uint8Array(32);
    nacl.lowlevel.crypto_hash(d, sk, 32);
    d[0] &= 248;
    d[31] &= 127;
    d[31] |= 64;
    o.set(d.subarray(0, 32));
    d.fill(0);
    return o;
  };

  cached = { convertPublicKey, convertSecretKey };
  return cached;
}

export async function convertEd25519PublicKey(edPublicU8) {
  const nacl = await ensureNacl();
  const api = initEd2Curve(nacl);
  return api.convertPublicKey(edPublicU8);
}

export async function convertEd25519SecretKey(edSeedU8) {
  const nacl = await ensureNacl();
  const api = initEd2Curve(nacl);
  return api.convertSecretKey(edSeedU8);
}
