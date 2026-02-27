/**
 * Face Blur Pipeline
 *
 * Intercepts a camera VideoTrack, draws each frame through a <canvas>,
 * detects faces, applies pixelation mosaic over detected regions,
 * and outputs a processed VideoTrack via canvas.captureStream().
 *
 * Pipeline:
 *   Camera VideoTrack → hidden <video> → Canvas drawImage
 *   → detect faces → pixelate regions → canvas.captureStream()
 *   → processed VideoTrack → replaceTrack on RTCRtpSender
 */

import { log } from '../../core/log.js';

const TARGET_FPS = 30;
const DETECT_INTERVAL_MS = 150;
const PIXEL_BLOCK = 14;

let detector = null;
let detectorSupported = null;

async function getDetector() {
  if (detector) return detector;
  if (detectorSupported === false) return null;
  if (typeof globalThis.FaceDetector === 'undefined') {
    detectorSupported = false;
    log({ faceBlur: 'FaceDetector API not available' });
    return null;
  }
  try {
    detector = new globalThis.FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
    detectorSupported = true;
    return detector;
  } catch (err) {
    detectorSupported = false;
    log({ faceBlurDetectorError: err?.message || err });
    return null;
  }
}

function pixelateRegion(ctx, x, y, w, h, blockSize) {
  const bs = Math.max(4, blockSize);
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(x + w));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(y + h));
  for (let by = y0; by < y1; by += bs) {
    for (let bx = x0; bx < x1; bx += bs) {
      const sw = Math.min(bs, x1 - bx);
      const sh = Math.min(bs, y1 - by);
      const cx = bx + (sw >> 1);
      const cy = by + (sh >> 1);
      let pixel;
      try {
        pixel = ctx.getImageData(cx, cy, 1, 1).data;
      } catch {
        continue;
      }
      ctx.fillStyle = `rgb(${pixel[0]},${pixel[1]},${pixel[2]})`;
      ctx.fillRect(bx, by, sw, sh);
    }
  }
}

/**
 * Create a face blur processing pipeline.
 *
 * @param {MediaStreamTrack} sourceTrack - The camera video track to process.
 * @returns {{ track: MediaStreamTrack, setEnabled: (b: boolean) => void, isEnabled: () => boolean, updateSource: (t: MediaStreamTrack) => void, destroy: () => void }}
 */
export function createFaceBlurPipeline(sourceTrack) {
  let enabled = true;
  let destroyed = false;
  let currentSource = sourceTrack;
  let lastDetectTime = 0;
  let cachedFaces = [];
  let animFrameId = null;

  // Hidden video element to feed camera frames
  const srcVideo = document.createElement('video');
  srcVideo.setAttribute('playsinline', '');
  srcVideo.setAttribute('autoplay', '');
  srcVideo.muted = true;
  srcVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(srcVideo);

  // Canvas for processing
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Output stream from canvas
  const outputStream = canvas.captureStream(TARGET_FPS);
  const outputTrack = outputStream.getVideoTracks()[0];

  // Wire source
  function attachSource(track) {
    const ms = new MediaStream([track]);
    srcVideo.srcObject = ms;
    srcVideo.play().catch(() => {});
    // Match canvas size to track settings
    const settings = track.getSettings?.() || {};
    const w = settings.width || 640;
    const h = settings.height || 480;
    canvas.width = w;
    canvas.height = h;
  }
  attachSource(currentSource);

  // Resize canvas when video metadata loads
  srcVideo.addEventListener('loadedmetadata', () => {
    if (srcVideo.videoWidth && srcVideo.videoHeight) {
      canvas.width = srcVideo.videoWidth;
      canvas.height = srcVideo.videoHeight;
    }
  });

  // Main render loop
  async function processFrame() {
    if (destroyed) return;

    // Schedule next frame
    if ('requestVideoFrameCallback' in srcVideo && typeof srcVideo.requestVideoFrameCallback === 'function') {
      srcVideo.requestVideoFrameCallback(() => processFrame());
    } else {
      animFrameId = requestAnimationFrame(() => processFrame());
    }

    // Draw current camera frame to canvas
    if (srcVideo.readyState < 2) return;
    ctx.drawImage(srcVideo, 0, 0, canvas.width, canvas.height);

    if (!enabled) return; // passthrough — just drawImage, no blur

    // Detect faces at throttled interval
    const now = performance.now();
    if (now - lastDetectTime > DETECT_INTERVAL_MS) {
      lastDetectTime = now;
      try {
        const det = await getDetector();
        if (det && srcVideo.readyState >= 2) {
          cachedFaces = await det.detect(srcVideo);
        }
      } catch (err) {
        // Detection can fail if video element is in a bad state; just skip
        if (err?.name !== 'InvalidStateError') {
          log({ faceBlurDetectError: err?.message || err });
        }
      }
    }

    // Apply pixelation to detected face regions
    if (cachedFaces.length > 0) {
      for (const face of cachedFaces) {
        const box = face.boundingBox;
        if (!box) continue;
        // Expand bounding box by 20% for better coverage
        const padX = box.width * 0.2;
        const padY = box.height * 0.2;
        pixelateRegion(
          ctx,
          box.x - padX,
          box.y - padY,
          box.width + padX * 2,
          box.height + padY * 2,
          PIXEL_BLOCK
        );
      }
    }
  }

  // Kick off render loop
  processFrame();

  return {
    /** The processed output video track. Wire this to RTCRtpSender and local preview. */
    track: outputTrack,

    /** Enable or disable face blur (pipeline always runs, just skips pixelation when disabled). */
    setEnabled(val) {
      enabled = !!val;
      if (!enabled) cachedFaces = [];
    },

    /** Whether face blur is currently enabled. */
    isEnabled() { return enabled; },

    /** Swap the source track (e.g. after camera switch). Pipeline output track stays the same. */
    updateSource(newTrack) {
      if (destroyed) return;
      currentSource = newTrack;
      cachedFaces = [];
      attachSource(newTrack);
    },

    /** Tear down the pipeline. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cachedFaces = [];
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
      try { outputTrack.stop(); } catch {}
      try { srcVideo.srcObject = null; } catch {}
      try { srcVideo.remove(); } catch {}
      detector = null;
    }
  };
}

/** Check if the browser supports the FaceDetector API. */
export function isFaceDetectorSupported() {
  return typeof globalThis.FaceDetector !== 'undefined';
}
