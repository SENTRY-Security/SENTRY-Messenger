import qrcode from './vendor/qrcode-generator.js';

/**
 * Generate a QR code canvas for given text.
 * @param {string} text
 * @param {number} size
 * @param {number} margin
 * @returns {HTMLCanvasElement}
 */
export function generateQR(text, size = 220, margin = 4) {
  try {
    const qr = qrcode(0, 'L'); // typeNumber 0 = auto
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

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvasSize, canvasSize);
    ctx.fillStyle = '#000';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(margin + c * cellSize, margin + r * cellSize, cellSize, cellSize);
        }
      }
    }
    return canvas;
  } catch (err) {
    console.error('[qr-error]', err);
    throw err;
  }
}
