import qrcode from './vendor/qrcode-generator.js';

// ─── finder-pattern geometry ────────────────────────────────────
// The three 7×7 finder patterns sit at fixed positions in the QR matrix.

function finderOrigins(count) {
  return [
    [0, 0],                  // top-left
    [0, count - 7],          // top-right
    [count - 7, 0],          // bottom-left
  ];
}

function isFinderZone(r, c, count) {
  for (const [fr, fc] of finderOrigins(count)) {
    if (r >= fr && r < fr + 7 && c >= fc && c < fc + 7) return true;
  }
  return false;
}

// ─── drawing primitives ─────────────────────────────────────────

function roundRect(ctx, x, y, w, h, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
  ctx.fill();
}

function drawFinderEye(ctx, x, y, cell, color) {
  const outer = cell * 7;
  const rOuter = cell * 1.4;
  const rInner = cell * 0.8;

  // outer ring (stroke)
  ctx.fillStyle = color;
  roundRect(ctx, x, y, outer, outer, rOuter);

  // white gap
  const gap = cell;
  ctx.fillStyle = '#fff';
  roundRect(ctx, x + gap, y + gap, outer - gap * 2, outer - gap * 2, rInner);

  // inner dot
  const dot = cell * 2;
  const dotOff = cell * 2;
  ctx.fillStyle = color;
  roundRect(ctx, x + dotOff, y + dotOff, cell * 3, cell * 3, rInner);
}

// ─── public API ─────────────────────────────────────────────────

/**
 * Generate a styled QR code canvas.
 * @param {string} text
 * @param {number} size   - target canvas size (px)
 * @param {number} margin - quiet zone (px)
 * @returns {HTMLCanvasElement}
 */
export function generateQR(text, size = 220, margin = 12) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();

    const count = qr.getModuleCount();
    const cellSize = Math.floor((size - margin * 2) / count) || 2;
    const canvasSize = cellSize * count + margin * 2;

    console.log('[qr]', { textLen: text?.length, count, cellSize, canvasSize });

    const canvas = document.createElement('canvas');
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas context 2d not supported');

    const fgColor = '#0f172a';
    const moduleRadius = cellSize * 0.32;

    // white background
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    // data modules (skip finder zones — we draw those separately)
    ctx.fillStyle = fgColor;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (isFinderZone(r, c, count)) continue;
        if (qr.isDark(r, c)) {
          roundRect(
            ctx,
            margin + c * cellSize,
            margin + r * cellSize,
            cellSize, cellSize,
            moduleRadius,
          );
        }
      }
    }

    // finder eyes with rounded corners
    for (const [fr, fc] of finderOrigins(count)) {
      drawFinderEye(ctx, margin + fc * cellSize, margin + fr * cellSize, cellSize, fgColor);
    }

    return canvas;
  } catch (err) {
    console.error('[qr-error]', err);
    throw err;
  }
}
