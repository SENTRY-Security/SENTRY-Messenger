let naclInstance = null;

async function loadNaclScript() {
  if (typeof window === 'undefined') return null;
  if (window.nacl) return window.nacl;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/libs/nacl-fast.min.js';
    script.onload = () => resolve(window.nacl || null);
    script.onerror = (err) => reject(err || new Error('nacl load failed'));
    document.head.appendChild(script);
  });
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
