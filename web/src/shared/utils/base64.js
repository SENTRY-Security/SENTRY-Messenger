export function bytesToB64(u8) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(u8).toString('base64');
  }
  let s = '';
  for (let i = 0; i < u8.length; i += 1) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

export function bytesToB64Url(u8) {
  return bytesToB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64ToBytes(str) {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(str, 'base64'));
  }
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64UrlToBytes(str) {
  const normalized = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized;
  return b64ToBytes(padded);
}

