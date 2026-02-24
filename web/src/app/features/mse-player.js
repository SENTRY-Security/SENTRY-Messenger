// /app/features/mse-player.js
// MediaSource Extensions (MSE) / ManagedMediaSource (MMS) player wrapper
// for streaming encrypted video chunks.
// Handles SourceBuffer management, codec detection, and fallback to blob URL playback.
// On iPhone (iOS 17.1+), uses ManagedMediaSource; on desktop/iPad, uses MediaSource.

/**
 * Resolve the best available MediaSource constructor.
 * iPhone Safari requires ManagedMediaSource; desktop/iPad use standard MediaSource.
 */
function getMediaSourceCtor() {
  if (typeof self !== 'undefined' && typeof self.ManagedMediaSource === 'function') {
    return self.ManagedMediaSource;
  }
  if (typeof MediaSource !== 'undefined') {
    return MediaSource;
  }
  return null;
}

/**
 * Check if the browser supports MediaSource or ManagedMediaSource API.
 */
export function isMseSupported() {
  const Ctor = getMediaSourceCtor();
  return !!Ctor && typeof Ctor.isTypeSupported === 'function';
}

/**
 * Detect codec string from the first chunk of video data.
 * For fMP4: parses moov/ftyp boxes to find codec info.
 * Returns a MIME type with codec string, e.g. 'video/mp4; codecs="avc1.64001f,mp4a.40.2"'.
 *
 * Falls back to generic MIME type if detection fails.
 */
export function detectCodecFromFirstChunk(data, contentType) {
  const MSCtor = getMediaSourceCtor();
  if (!MSCtor) return { mimeCodec: null, fragmented: false };

  // Check if it's fragmented MP4 by looking for 'moof' box
  const isFragmented = hasMp4Box(data, 'moof') || hasMp4Box(data, 'styp');

  if (contentType === 'video/webm' || contentType === 'audio/webm') {
    // WebM is always MSE-compatible
    const mimeCodec = `${contentType}; codecs="vp9,opus"`;
    if (MSCtor.isTypeSupported(mimeCodec)) return { mimeCodec, fragmented: true };
    const fallback = `${contentType}; codecs="vp8,vorbis"`;
    if (MSCtor.isTypeSupported(fallback)) return { mimeCodec: fallback, fragmented: true };
    return { mimeCodec: contentType, fragmented: true };
  }

  if (!isFragmented) {
    // Regular MP4 — not compatible with MSE without remuxing
    return { mimeCodec: null, fragmented: false };
  }

  // Fragmented MP4 — try to extract codec from moov/trak atoms
  const codecStr = extractMp4Codec(data);
  if (codecStr) {
    const mimeCodec = `video/mp4; codecs="${codecStr}"`;
    if (MSCtor.isTypeSupported(mimeCodec)) return { mimeCodec, fragmented: true };
  }

  // Fallback: try common codec strings
  // Safari requires 'hvc1' for HEVC (not 'hev1')
  const candidates = [
    'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',  // H.264 Baseline + AAC
    'video/mp4; codecs="avc1.4D401E,mp4a.40.2"',  // H.264 Main + AAC
    'video/mp4; codecs="avc1.64001E,mp4a.40.2"',  // H.264 High + AAC
    'video/mp4; codecs="hvc1,mp4a.40.2"',          // HEVC + AAC (Safari)
    'video/mp4; codecs="avc1.42E01E"',             // H.264 Baseline video-only
    'video/mp4; codecs="avc1.4D401E"',             // H.264 Main video-only
    'video/mp4; codecs="hvc1"',                    // HEVC video-only (Safari)
  ];

  for (const candidate of candidates) {
    if (MSCtor.isTypeSupported(candidate)) {
      return { mimeCodec: candidate, fragmented: true };
    }
  }

  return { mimeCodec: null, fragmented: true };
}

/**
 * Check if MP4 data contains a specific box type (e.g. 'moof', 'moov', 'ftyp').
 */
function hasMp4Box(data, boxType) {
  if (!data || data.length < 8) return false;
  const needle = new TextEncoder().encode(boxType);
  const limit = Math.min(data.length - 4, 64 * 1024); // Only scan first 64KB
  for (let i = 4; i < limit; i++) {
    if (data[i] === needle[0] && data[i + 1] === needle[1] &&
        data[i + 2] === needle[2] && data[i + 3] === needle[3]) {
      return true;
    }
  }
  return false;
}

/**
 * Extract codec string from MP4 sample description atoms (stsd).
 * Looks for 'avc1', 'avc3', 'hvc1', 'hev1' etc.
 * For Safari HEVC, always emits 'hvc1' (Safari doesn't support 'hev1').
 */
function extractMp4Codec(data) {
  const codecs = [];
  const limit = Math.min(data.length, 128 * 1024);

  // Look for common video codec identifiers
  const videoCodecs = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01'];
  const audioCodecs = ['mp4a', 'opus', 'ac-3', 'ec-3', 'flac'];

  for (const codec of [...videoCodecs, ...audioCodecs]) {
    const needle = new TextEncoder().encode(codec);
    for (let i = 4; i < limit - 4; i++) {
      if (data[i] === needle[0] && data[i + 1] === needle[1] &&
          data[i + 2] === needle[2] && data[i + 3] === needle[3]) {
        if (codec === 'avc1' || codec === 'avc3') {
          // Try to read avcC config
          const profileStr = tryReadAvcProfile(data, i);
          codecs.push(profileStr || 'avc1.42E01E');
        } else if (codec === 'hev1') {
          // Safari requires 'hvc1' — normalize hev1 to hvc1
          codecs.push('hvc1');
        } else if (codec === 'hvc1') {
          codecs.push('hvc1');
        } else if (codec === 'mp4a') {
          codecs.push('mp4a.40.2');
        } else {
          codecs.push(codec);
        }
        break;
      }
    }
  }

  return codecs.length ? codecs.join(',') : null;
}

/**
 * Try to extract H.264 profile/level from avcC box.
 */
function tryReadAvcProfile(data, avc1Offset) {
  // Search for 'avcC' box near the avc1 entry
  const searchEnd = Math.min(avc1Offset + 200, data.length - 8);
  const needle = new TextEncoder().encode('avcC');
  for (let i = avc1Offset; i < searchEnd; i++) {
    if (data[i] === needle[0] && data[i + 1] === needle[1] &&
        data[i + 2] === needle[2] && data[i + 3] === needle[3]) {
      // avcC starts at i+4: configurationVersion, AVCProfileIndication, profile_compat, AVCLevelIndication
      const profile = data[i + 5];
      const compat = data[i + 6];
      const level = data[i + 7];
      if (profile && level) {
        const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
        return `avc1.${hex(profile)}${hex(compat)}${hex(level)}`;
      }
    }
  }
  return null;
}

/**
 * Create an MSE/MMS-based video player controller.
 * Automatically uses ManagedMediaSource on iPhone Safari, MediaSource elsewhere.
 *
 * @param {{ videoElement: HTMLVideoElement, onError?: (err: Error) => void }} params
 * @returns {{
 *   init: (mimeCodec: string) => Promise<void>,
 *   appendChunk: (data: Uint8Array) => Promise<void>,
 *   endOfStream: () => void,
 *   destroy: () => void,
 *   objectUrl: string|null
 * }}
 */
export function createMsePlayer({ videoElement, onError }) {
  let mediaSource = null;
  let sourceBuffer = null;
  let objectUrl = null;
  let appendQueue = [];
  let appending = false;
  let destroyed = false;
  let endPending = false;

  const MSCtor = getMediaSourceCtor();
  const isMMS = typeof self !== 'undefined' && typeof self.ManagedMediaSource === 'function' && MSCtor === self.ManagedMediaSource;

  const processQueue = () => {
    if (destroyed || appending || !sourceBuffer || !appendQueue.length) return;
    if (sourceBuffer.updating) return;

    if (endPending && appendQueue.length === 0) {
      try {
        if (mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
        }
      } catch (err) {
        console.warn('[mse-player] endOfStream error:', err?.message);
      }
      return;
    }

    const { data, resolve, reject } = appendQueue.shift();
    appending = true;

    const onUpdate = () => {
      sourceBuffer.removeEventListener('updateend', onUpdate);
      sourceBuffer.removeEventListener('error', onErr);
      appending = false;
      resolve();
      processQueue();
    };

    const onErr = (evt) => {
      sourceBuffer.removeEventListener('updateend', onUpdate);
      sourceBuffer.removeEventListener('error', onErr);
      appending = false;
      const err = new Error('SourceBuffer append error');
      reject(err);
      onError?.(err);
    };

    sourceBuffer.addEventListener('updateend', onUpdate);
    sourceBuffer.addEventListener('error', onErr);

    try {
      sourceBuffer.appendBuffer(data);
    } catch (err) {
      sourceBuffer.removeEventListener('updateend', onUpdate);
      sourceBuffer.removeEventListener('error', onErr);
      appending = false;
      reject(err);
      onError?.(err);
    }
  };

  return {
    /**
     * Initialize the MediaSource/ManagedMediaSource and attach to the video element.
     * @param {string} mimeCodec e.g. 'video/mp4; codecs="avc1.42E01E"'
     */
    init(mimeCodec) {
      return new Promise((resolve, reject) => {
        if (destroyed) return reject(new Error('player destroyed'));
        if (!MSCtor) return reject(new Error('MediaSource/ManagedMediaSource not available'));

        mediaSource = new MSCtor();

        // ManagedMediaSource on iPhone: must disable remote playback
        // (required unless providing an AirPlay source alternative)
        if (isMMS && videoElement) {
          videoElement.disableRemotePlayback = true;
        }

        objectUrl = URL.createObjectURL(mediaSource);
        videoElement.src = objectUrl;

        const openEvent = isMMS ? 'sourceopen' : 'sourceopen';

        mediaSource.addEventListener(openEvent, () => {
          try {
            sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
            sourceBuffer.mode = 'sequence';
            resolve();
          } catch (err) {
            reject(err);
            onError?.(err);
          }
        }, { once: true });

        mediaSource.addEventListener('error', (evt) => {
          const err = new Error('MediaSource error');
          reject(err);
          onError?.(err);
        }, { once: true });

        // ManagedMediaSource: handle startstreaming/endstreaming for power efficiency
        if (isMMS) {
          mediaSource.addEventListener('startstreaming', () => {
            // Browser wants data — resume processing queue if paused
            processQueue();
          });
          // endstreaming: browser may evict buffered data, no action needed
        }
      });
    },

    /**
     * Queue a chunk of data to be appended to the SourceBuffer.
     */
    appendChunk(data) {
      return new Promise((resolve, reject) => {
        if (destroyed) return reject(new Error('player destroyed'));
        appendQueue.push({ data, resolve, reject });
        processQueue();
      });
    },

    /**
     * Signal end of stream after all queued chunks have been appended.
     */
    endOfStream() {
      endPending = true;
      processQueue();
    },

    /**
     * Clean up all resources.
     */
    destroy() {
      destroyed = true;
      appendQueue = [];

      if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch { }
        objectUrl = null;
      }

      if (sourceBuffer && mediaSource?.readyState === 'open') {
        try { mediaSource.removeSourceBuffer(sourceBuffer); } catch { }
      }

      if (mediaSource?.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch { }
      }

      sourceBuffer = null;
      mediaSource = null;
    },

    get objectUrl() { return objectUrl; }
  };
}
