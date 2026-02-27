/**
 * Face Blur Pipeline — Cross-browser
 * (Chrome, Edge, Safari, iOS Safari, Firefox)
 *
 * Intercepts a camera VideoTrack, draws each frame through a <canvas>,
 * detects faces, applies pixelation mosaic over detected regions,
 * and outputs a processed VideoTrack via canvas.captureStream().
 *
 * Face detection strategy (three tiers):
 *   1. Native FaceDetector API (Chrome 86+, Edge 86+) — instant, no network
 *   2. MediaPipe Face Detection via CDN (Safari, iOS Safari, Firefox)
 *      — WASM + WebGL, loaded in background on first pipeline creation
 *   3. Skin-color region detector (last resort if CDN load fails)
 *
 * Pipeline:
 *   Camera VideoTrack → hidden <video> → Canvas drawImage
 *   → detect faces → pixelate regions → canvas.captureStream()
 *   → processed VideoTrack → replaceTrack on RTCRtpSender
 */

import { log } from '../../core/log.js';

const TARGET_FPS = 30;
const DETECT_INTERVAL_MS = 200;
const PIXEL_BLOCK = 14;

// ──────────────────────────────────────────────────────────────
// Tier 1: Native FaceDetector (Chrome / Edge)
// ──────────────────────────────────────────────────────────────

let nativeDetector = null;
let nativeSupported = null;

function getNativeDetector() {
  if (nativeSupported === false) return null;
  if (nativeDetector) return nativeDetector;
  if (typeof globalThis.FaceDetector === 'undefined') {
    nativeSupported = false;
    return null;
  }
  try {
    nativeDetector = new globalThis.FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
    nativeSupported = true;
    return nativeDetector;
  } catch {
    nativeSupported = false;
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// Tier 2: MediaPipe Face Detection (CDN — all browsers)
// ──────────────────────────────────────────────────────────────
// Uses @mediapipe/tasks-vision loaded dynamically from jsDelivr.
// The WASM runtime + BlazeFace model (~1.5 MB total) are fetched
// once and cached by the browser. Loading happens in the
// background; skin-color detection is used in the interim.

const MP_VERSION = '0.10.14';
const MP_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const MP_LOAD_TIMEOUT_MS = 20_000;

let mpDetector = null;
let mpReady = false;
let mpFailed = false;
let mpLoadPromise = null;

function startMediaPipeLoad() {
  if (nativeSupported === true || mpReady || mpFailed || mpLoadPromise) return;
  mpLoadPromise = (async () => {
    try {
      // Race against timeout
      const result = await Promise.race([
        (async () => {
          const { FilesetResolver, FaceDetector } = await import(
            /* webpackIgnore: true */ `${MP_CDN}/vision_bundle.mjs`
          );
          const vision = await FilesetResolver.forVisionTasks(`${MP_CDN}/wasm`);
          return FaceDetector.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: MP_MODEL,
              delegate: 'GPU'
            },
            runningMode: 'VIDEO'
          });
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), MP_LOAD_TIMEOUT_MS)
        )
      ]);
      mpDetector = result;
      mpReady = true;
      log({ mediaPipe: 'face detector loaded', version: MP_VERSION });
    } catch (err) {
      mpFailed = true;
      log({ mediaPipeLoadError: err?.message || err });
    }
    mpLoadPromise = null;
  })();
}

// ──────────────────────────────────────────────────────────────
// Tier 3: Skin-color region detector (offline / CDN-fail fallback)
// ──────────────────────────────────────────────────────────────
// Downscales the frame, classifies pixels as skin using YCbCr
// thresholds, clusters skin blocks via connected-component
// labeling, and returns bounding boxes for face-like regions.

const ANALYSIS_W = 160;
const ANALYSIS_H = 120;
const GRID = 8;
const SKIN_CELL_RATIO = 0.32;
const MIN_COMPONENT_CELLS = 6;
const MIN_ASPECT = 0.45;
const MAX_ASPECT = 2.2;

class SkinFaceDetector {
  constructor() {
    this._canvas = document.createElement('canvas');
    this._canvas.width = ANALYSIS_W;
    this._canvas.height = ANALYSIS_H;
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._gw = Math.ceil(ANALYSIS_W / GRID);
    this._gh = Math.ceil(ANALYSIS_H / GRID);
  }

  async detect(source) {
    const ctx = this._ctx;
    const cw = ANALYSIS_W;
    const ch = ANALYSIS_H;

    try { ctx.drawImage(source, 0, 0, cw, ch); } catch { return []; }

    let imageData;
    try { imageData = ctx.getImageData(0, 0, cw, ch); } catch { return []; }

    const data = imageData.data;
    const gw = this._gw;
    const gh = this._gh;

    // Build skin grid
    const grid = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let skinCount = 0;
        let totalCount = 0;
        const px0 = gx * GRID;
        const py0 = gy * GRID;
        const px1 = Math.min(px0 + GRID, cw);
        const py1 = Math.min(py0 + GRID, ch);
        for (let py = py0; py < py1; py++) {
          for (let px = px0; px < px1; px++) {
            const idx = (py * cw + px) * 4;
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            const y  = 0.299 * r + 0.587 * g + 0.114 * b;
            const cb = 128 - 0.169 * r - 0.331 * g + 0.5 * b;
            const cr = 128 + 0.5 * r - 0.419 * g - 0.081 * b;
            if (y > 50 && cb >= 77 && cb <= 135 && cr >= 130 && cr <= 180) skinCount++;
            totalCount++;
          }
        }
        if (totalCount > 0 && skinCount / totalCount >= SKIN_CELL_RATIO) {
          grid[gy * gw + gx] = 1;
        }
      }
    }

    // Connected-component labeling (BFS)
    const labels = new Int32Array(gw * gh);
    let nextLabel = 1;
    const components = [];
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const idx = gy * gw + gx;
        if (grid[idx] !== 1 || labels[idx] !== 0) continue;
        const label = nextLabel++;
        const queue = [idx];
        labels[idx] = label;
        let minX = gx, maxX = gx, minY = gy, maxY = gy, count = 0;
        while (queue.length > 0) {
          const ci = queue.pop();
          const cx = ci % gw, cy = (ci - cx) / gw;
          count++;
          if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
          if (cy > 0)      { const ni = (cy - 1) * gw + cx; if (grid[ni] === 1 && labels[ni] === 0) { labels[ni] = label; queue.push(ni); } }
          if (cy < gh - 1) { const ni = (cy + 1) * gw + cx; if (grid[ni] === 1 && labels[ni] === 0) { labels[ni] = label; queue.push(ni); } }
          if (cx > 0)      { const ni = cy * gw + cx - 1;   if (grid[ni] === 1 && labels[ni] === 0) { labels[ni] = label; queue.push(ni); } }
          if (cx < gw - 1) { const ni = cy * gw + cx + 1;   if (grid[ni] === 1 && labels[ni] === 0) { labels[ni] = label; queue.push(ni); } }
        }
        components.push({ minX, minY, maxX, maxY, count });
      }
    }

    const srcW = source.videoWidth || source.width || cw;
    const srcH = source.videoHeight || source.height || ch;
    const scaleX = srcW / cw, scaleY = srcH / ch;
    const faces = [];
    for (const comp of components) {
      if (comp.count < MIN_COMPONENT_CELLS) continue;
      const cellsW = comp.maxX - comp.minX + 1;
      const cellsH = comp.maxY - comp.minY + 1;
      const aspect = cellsW / (cellsH || 1);
      if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
      faces.push({
        boundingBox: {
          x: comp.minX * GRID * scaleX,
          y: comp.minY * GRID * scaleY,
          width:  cellsW * GRID * scaleX,
          height: cellsH * GRID * scaleY
        }
      });
    }
    return faces;
  }
}

// ──────────────────────────────────────
// Unified detection dispatcher
// ──────────────────────────────────────

let skinDetector = null;
function getSkinDetector() {
  if (!skinDetector) skinDetector = new SkinFaceDetector();
  return skinDetector;
}

function detectFaces(source, timestamp) {
  // Tier 1 — native
  const native = getNativeDetector();
  if (native) {
    try {
      return native.detect(source);
    } catch {
      // fall through
    }
  }

  // Tier 2 — MediaPipe (non-blocking: only used once loaded)
  if (mpReady && mpDetector) {
    try {
      const result = mpDetector.detectForVideo(source, timestamp);
      return Promise.resolve(
        (result.detections || []).map(d => ({
          boundingBox: {
            x: d.boundingBox.originX,
            y: d.boundingBox.originY,
            width: d.boundingBox.width,
            height: d.boundingBox.height
          }
        }))
      );
    } catch (err) {
      log({ mediaPipeDetectError: err?.message || err });
      // fall through to skin
    }
  }

  // Tier 3 — skin-color
  return getSkinDetector().detect(source);
}

// ──────────────────────────
// Optimized pixelation
// ──────────────────────────

function pixelateRegion(ctx, x, y, w, h, blockSize) {
  const bs = Math.max(4, blockSize);
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(x + w));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(y + h));
  const regionW = x1 - x0;
  const regionH = y1 - y0;
  if (regionW <= 0 || regionH <= 0) return;

  let regionData;
  try { regionData = ctx.getImageData(x0, y0, regionW, regionH); } catch { return; }
  const data = regionData.data;

  for (let by = 0; by < regionH; by += bs) {
    for (let bx = 0; bx < regionW; bx += bs) {
      const sw = Math.min(bs, regionW - bx);
      const sh = Math.min(bs, regionH - by);
      const cx = bx + (sw >> 1);
      const cy = by + (sh >> 1);
      const idx = (cy * regionW + cx) * 4;
      ctx.fillStyle = `rgb(${data[idx]},${data[idx + 1]},${data[idx + 2]})`;
      ctx.fillRect(x0 + bx, y0 + by, sw, sh);
    }
  }
}

// ──────────────────────────
// Pipeline
// ──────────────────────────

/**
 * Create a face blur processing pipeline.
 *
 * @param {MediaStreamTrack} sourceTrack - The camera video track to process.
 * @returns {{ track, setEnabled, isEnabled, updateSource, destroy } | null}
 *          null when the browser lacks captureStream support.
 */
export function createFaceBlurPipeline(sourceTrack) {
  let enabled = true;
  let destroyed = false;
  let currentSource = sourceTrack;
  let lastDetectTime = 0;
  let lastDrawTime = 0;
  let cachedFaces = [];
  let animFrameId = null;
  let safariIntervalId = null;

  // Hidden video element to feed camera frames
  const srcVideo = document.createElement('video');
  srcVideo.setAttribute('playsinline', '');
  srcVideo.setAttribute('autoplay', '');
  srcVideo.setAttribute('muted', '');
  srcVideo.muted = true;
  srcVideo.playsInline = true;
  srcVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(srcVideo);

  // Canvas for processing
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // captureStream support check
  if (typeof canvas.captureStream !== 'function') {
    log({ faceBlur: 'captureStream not supported — pipeline disabled' });
    try { srcVideo.remove(); } catch {}
    return null;
  }

  const outputStream = canvas.captureStream(TARGET_FPS);
  const outputTrack = outputStream.getVideoTracks()[0];
  if (!outputTrack) {
    log({ faceBlur: 'captureStream produced no video track' });
    try { srcVideo.remove(); } catch {}
    return null;
  }

  function attachSource(track) {
    const ms = new MediaStream([track]);
    srcVideo.srcObject = ms;
    srcVideo.play().catch(() => {});
    const settings = track.getSettings?.() || {};
    canvas.width  = settings.width  || 640;
    canvas.height = settings.height || 480;
  }
  attachSource(currentSource);

  srcVideo.addEventListener('loadedmetadata', () => {
    if (srcVideo.videoWidth && srcVideo.videoHeight) {
      canvas.width  = srcVideo.videoWidth;
      canvas.height = srcVideo.videoHeight;
    }
  });

  // If native FaceDetector is unavailable, start loading MediaPipe in background
  if (!getNativeDetector()) {
    startMediaPipeLoad();
  }

  // ── Render loop ──
  const useRVFC = typeof HTMLVideoElement !== 'undefined' &&
    'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  function scheduleNextFrame() {
    if (destroyed) return;
    if (useRVFC) {
      try {
        srcVideo.requestVideoFrameCallback(() => processFrame());
      } catch {
        animFrameId = requestAnimationFrame(() => processFrame());
      }
    } else {
      animFrameId = requestAnimationFrame(() => processFrame());
    }
  }

  async function processFrame() {
    if (destroyed) return;
    scheduleNextFrame();

    if (srcVideo.readyState < 2) return;
    ctx.drawImage(srcVideo, 0, 0, canvas.width, canvas.height);
    lastDrawTime = performance.now();

    if (!enabled) return;

    const now = performance.now();
    if (now - lastDetectTime > DETECT_INTERVAL_MS) {
      lastDetectTime = now;
      try {
        if (srcVideo.readyState >= 2) {
          cachedFaces = await detectFaces(srcVideo, now);
        }
      } catch (err) {
        if (err?.name !== 'InvalidStateError') {
          log({ faceBlurDetectError: err?.message || err });
        }
      }
    }

    if (cachedFaces.length > 0) {
      for (const face of cachedFaces) {
        const box = face.boundingBox;
        if (!box) continue;
        const padX = box.width * 0.2;
        const padY = box.height * 0.2;
        pixelateRegion(
          ctx,
          box.x - padX,
          box.y - padY,
          box.width  + padX * 2,
          box.height + padY * 2,
          PIXEL_BLOCK
        );
      }
    }
  }

  // Safari captureStream heartbeat
  const isSafari = typeof navigator !== 'undefined' &&
    /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari) {
    safariIntervalId = setInterval(() => {
      if (destroyed || srcVideo.readyState < 2) return;
      if (performance.now() - lastDrawTime > 80) {
        ctx.drawImage(srcVideo, 0, 0, canvas.width, canvas.height);
        lastDrawTime = performance.now();
      }
    }, Math.floor(1000 / TARGET_FPS));
  }

  processFrame();

  const detectorKind = getNativeDetector() ? 'native' : mpReady ? 'mediapipe' : 'skin-color (mediapipe loading)';
  log({ faceBlurDetector: detectorKind, isSafari: !!isSafari });

  return {
    track: outputTrack,

    setEnabled(val) {
      enabled = !!val;
      if (!enabled) cachedFaces = [];
    },

    isEnabled() { return enabled; },

    updateSource(newTrack) {
      if (destroyed) return;
      currentSource = newTrack;
      cachedFaces = [];
      attachSource(newTrack);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      cachedFaces = [];
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
      if (safariIntervalId) {
        clearInterval(safariIntervalId);
        safariIntervalId = null;
      }
      try { outputTrack.stop(); } catch {}
      try { srcVideo.srcObject = null; } catch {}
      try { srcVideo.remove(); } catch {}
      nativeDetector = null;
    }
  };
}

/**
 * Check if the browser can run the face blur pipeline.
 * Requires canvas.captureStream() — Chrome 51+, Firefox 43+, Safari 15+, iOS Safari 15+.
 */
export function isFaceBlurSupported() {
  if (typeof document === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    return typeof c.captureStream === 'function';
  } catch {
    return false;
  }
}
