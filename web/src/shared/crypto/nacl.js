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
let naclInstance = null;

async function loadNaclScript() {
  if (typeof window === 'undefined') return null;
  if (window.nacl) return window.nacl;
  const tryLoad = (src) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve(window.nacl || null);
    script.onerror = (err) => reject(err || new Error(`nacl load failed: ${src}`));
    document.head.appendChild(script);
  });
  try {
    await tryLoad('/libs/nacl-fast.min.js');
  } catch (err) {
    console.warn('Local nacl load failed, trying CDN:', err);
    try {
      await tryLoad('https://unpkg.com/tweetnacl@1.0.3/nacl-fast.min.js');
    } catch (err2) {
      throw new Error(`nacl load failed (local+cdn): ${err?.message} || ${err2?.message}`);
    }
  }
  return window.nacl || null;
}

export async function ensureNacl() {
  if (naclInstance) return naclInstance;
  if (typeof window !== 'undefined') {
    naclInstance = window.nacl || await loadNaclScript();
    if (!naclInstance) throw new Error('nacl not available in browser');
    return naclInstance;
  }
  const mod = await import('tweetnacl');
  naclInstance = mod.default || mod;
  return naclInstance;
}

export async function loadNacl() {
  await ensureNacl();
}

export async function genEd25519Keypair() {
  const nacl = await ensureNacl();
  const kp = nacl.sign.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export async function genX25519Keypair() {
  const nacl = await ensureNacl();
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export async function signDetached(messageU8, secretKeyU8) {
  const nacl = await ensureNacl();
  return nacl.sign.detached(messageU8, secretKeyU8);
}

export async function verifyDetached(messageU8, signatureU8, publicKeyU8) {
  const nacl = await ensureNacl();
  return nacl.sign.detached.verify(messageU8, signatureU8, publicKeyU8);
}

export async function scalarMult(secretKey32, publicKey32) {
  const nacl = await ensureNacl();
  return nacl.scalarMult(secretKey32, publicKey32);
}

export function b64(u8) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(u8).toString('base64');
  }
  let s = '';
  const arr = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function b64u8(b64s) {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(String(b64s || ''), 'base64'));
  }
  const bin = atob(String(b64s || ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
  return u8;
}
