export function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeSelector(value) {
  if (!value) return '';
  return String(value).replace(/["\\]/g, '\\$&');
}

export function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = Number(bytes);
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return idx ? `${value.toFixed(1)} ${units[idx]}` : `${value} ${units[idx]}`;
}

export function safeJSON(source) {
  try {
    return typeof source === 'string' ? JSON.parse(source) : source;
  } catch {
    return null;
  }
}

export function bytesToB64(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i += 1) {
    out += String.fromCharCode(u8[i]);
  }
  return btoa(out);
}

export function bytesToB64Url(u8) {
  return bytesToB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function toB64Url(str) {
  return String(str || '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromB64Url(str) {
  const normalized = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  return normalized + (pad ? '='.repeat(4 - pad) : '');
}

export function b64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function b64UrlToBytes(str) {
  const cleaned = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const mod = cleaned.length % 4;
  const padded = mod ? cleaned + '='.repeat(4 - mod) : cleaned;
  return b64ToBytes(padded);
}

export function b64u8(str) {
  return b64ToBytes(str);
}

export function shouldNotifyForMessage({ computedIsHistoryReplay = false, silent = false } = {}) {
  if (computedIsHistoryReplay) return false;
  if (silent) return false;
  return true;
}

export async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(blob);
  });
}

export function buildConversationSnippet(text) {
  if (!text) return '';
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const MAX_LEN = 42;
  return cleaned.length > MAX_LEN ? `${cleaned.slice(0, MAX_LEN - 1)}…` : cleaned;
}
