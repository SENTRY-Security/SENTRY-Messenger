// /app/lib/identicon.js
// Shared identicon utilities for login / default avatar generation.

export const IDENTICON_PALETTE = ['#6366f1', '#22c55e', '#0ea5e9', '#f97316', '#14b8a6', '#8b5cf6', '#f43f5e', '#10b981'];

async function hashUid(uid) {
  const normalized = (uid || '').trim().toLowerCase();
  if (!normalized) return null;
  const encoder = new TextEncoder();
  const input = encoder.encode(normalized);
  if (crypto?.subtle?.digest) {
    const buf = await crypto.subtle.digest('SHA-256', input);
    return new Uint8Array(buf);
  }
  // Fallback: simple FNV-1a style hash expanded to 32 bytes
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input[i];
    h = Math.imul(h, 0x01000193);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i += 1) {
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    out[i] = h & 0xff;
  }
  return out;
}

export async function buildIdenticonSvg(uid, { size = 72, palette = IDENTICON_PALETTE } = {}) {
  const bytes = await hashUid(uid);
  if (!bytes) return '';
  const cells = 5;
  const cell = size / cells;
  const cornerRadius = Math.max(6, Math.round(size * 0.22));
  const color = palette[bytes[0] % palette.length];
  const accent = palette[(bytes[1] + 3) % palette.length];
  let svg = `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`;
  svg += `<rect width="${size}" height="${size}" rx="${cornerRadius}" ry="${cornerRadius}" fill="#f8fafc"/>`;
  let bitIndex = 0;
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < Math.ceil(cells / 2); x += 1) {
      const byte = bytes[2 + (bitIndex >> 3)] || bytes[bitIndex % bytes.length];
      const bit = (byte >> (bitIndex & 7)) & 1;
      const fill = bit ? color : accent;
      if (bit) {
        const xPos = x * cell;
        const yPos = y * cell;
        svg += `<rect x="${xPos.toFixed(2)}" y="${yPos.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="${(cell * 0.35).toFixed(2)}" ry="${(cell * 0.35).toFixed(2)}" fill="${fill}" />`;
        const mirrorX = (cells - 1 - x) * cell;
        if (mirrorX !== xPos) {
          svg += `<rect x="${mirrorX.toFixed(2)}" y="${yPos.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="${(cell * 0.35).toFixed(2)}" ry="${(cell * 0.35).toFixed(2)}" fill="${fill}" />`;
        }
      }
      bitIndex += 1;
    }
  }
  svg += '</svg>';
  return svg;
}

async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err || new Error('image load failed'));
    img.src = url;
  });
}

export async function renderIdenticonCanvas(uid, { size = 240, palette = IDENTICON_PALETTE } = {}) {
  const svg = await buildIdenticonSvg(uid, { size, palette });
  if (!svg) return null;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function buildIdenticonImage(uid, { size = 512, format = 'image/jpeg', quality = 0.9, palette = IDENTICON_PALETTE } = {}) {
  const canvas = await renderIdenticonCanvas(uid, { size, palette });
  if (!canvas) return null;
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('identicon render failed'));
    }, format, quality);
  });
  const dataUrl = canvas.toDataURL(format, quality);
  return { blob, dataUrl };
}
