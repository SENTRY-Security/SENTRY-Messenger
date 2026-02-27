// /app/features/mse-player.js
// MediaSource Extensions (MSE) / ManagedMediaSource (MMS) player wrapper
// for streaming encrypted video chunks.
//
// Supports multi-track playback with separate SourceBuffers (one per track).
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
 * Detect codec string from an fMP4 init segment.
 * Extracts codec info from moov/trak/stsd atoms.
 *
 * Returns a MIME type with codec string, e.g. 'video/mp4; codecs="avc1.64001f"'.
 * Falls back to trying common codec strings if extraction fails.
 */
export function detectCodecFromInitSegment(data, trackType) {
  const MSCtor = getMediaSourceCtor();
  if (!MSCtor) return null;

  // Try to extract codec from moov/trak/stsd atoms in the data
  const codecStr = extractMp4Codec(data, trackType);
  if (codecStr) {
    const mimeCodec = `video/mp4; codecs="${codecStr}"`;
    if (MSCtor.isTypeSupported(mimeCodec)) return mimeCodec;
  }

  // Fallback: try common codec strings based on track type.
  // For 'muxed' tracks, try combined video+audio first, then video-only.
  // A muxed SourceBuffer MUST declare both codecs or audio segments will be rejected.
  const candidates = trackType === 'audio'
    ? [
        'video/mp4; codecs="mp4a.40.2"',     // AAC-LC
        'video/mp4; codecs="mp4a.40.5"',     // HE-AAC
        'video/mp4; codecs="opus"',
      ]
    : trackType === 'muxed'
      ? [
          'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',   // H.264 Baseline + AAC
          'video/mp4; codecs="avc1.4D401E,mp4a.40.2"',   // H.264 Main + AAC
          'video/mp4; codecs="avc1.64001E,mp4a.40.2"',   // H.264 High + AAC
          'video/mp4; codecs="hvc1,mp4a.40.2"',           // HEVC + AAC (Safari)
        ]
      : [
          'video/mp4; codecs="avc1.42E01E"',   // H.264 Baseline
          'video/mp4; codecs="avc1.4D401E"',   // H.264 Main
          'video/mp4; codecs="avc1.64001E"',   // H.264 High
          'video/mp4; codecs="hvc1"',           // HEVC (Safari)
        ];

  for (const candidate of candidates) {
    if (MSCtor.isTypeSupported(candidate)) return candidate;
  }

  return null;
}

/**
 * Build a full MIME codec string from a codec identifier
 * (e.g. "avc1.64001E,mp4a.40.2" → 'video/mp4; codecs="avc1.64001E,mp4a.40.2"').
 * Returns the MIME type if the browser supports it, null otherwise.
 */
export function buildMimeFromCodecString(codecStr) {
  if (!codecStr) return null;
  const MSCtor = getMediaSourceCtor();
  if (!MSCtor) return null;
  const mime = `video/mp4; codecs="${codecStr}"`;
  if (MSCtor.isTypeSupported(mime)) return mime;
  return null;
}

/**
 * Legacy: Detect codec from the first chunk (init segment) for muxed streams.
 * Returns { mimeCodec, fragmented }.
 */
export function detectCodecFromFirstChunk(data, contentType) {
  const MSCtor = getMediaSourceCtor();
  if (!MSCtor) return { mimeCodec: null, fragmented: false };

  if (contentType === 'video/webm' || contentType === 'audio/webm') {
    const mimeCodec = `${contentType}; codecs="vp9,opus"`;
    if (MSCtor.isTypeSupported(mimeCodec)) return { mimeCodec, fragmented: true };
    const fallback = `${contentType}; codecs="vp8,vorbis"`;
    if (MSCtor.isTypeSupported(fallback)) return { mimeCodec: fallback, fragmented: true };
    return { mimeCodec: contentType, fragmented: true };
  }

  // For muxed fMP4, extract both video and audio codecs
  const codecStr = extractMp4Codec(data);
  if (codecStr) {
    const mimeCodec = `video/mp4; codecs="${codecStr}"`;
    if (MSCtor.isTypeSupported(mimeCodec)) return { mimeCodec, fragmented: true };
  }

  // Fallback: try common combined codec strings
  const candidates = [
    'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4; codecs="avc1.4D401E,mp4a.40.2"',
    'video/mp4; codecs="avc1.64001E,mp4a.40.2"',
    'video/mp4; codecs="hvc1,mp4a.40.2"',
    'video/mp4; codecs="avc1.42E01E"',
    'video/mp4; codecs="avc1.4D401E"',
    'video/mp4; codecs="hvc1"',
  ];

  for (const candidate of candidates) {
    if (MSCtor.isTypeSupported(candidate)) return { mimeCodec: candidate, fragmented: true };
  }

  return { mimeCodec: null, fragmented: true };
}

/**
 * Check if MP4 data contains a specific box type.
 */
function hasMp4Box(data, boxType) {
  if (!data || data.length < 8) return false;
  const needle = new TextEncoder().encode(boxType);
  const limit = data.length - 4;
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
 */
function extractMp4Codec(data, preferType) {
  const codecs = [];
  const limit = data.length;

  const videoCodecs = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01'];
  const audioCodecs = ['mp4a', 'opus', 'ac-3', 'ec-3', 'flac'];

  const searchList = preferType === 'audio'
    ? audioCodecs
    : preferType === 'video'
      ? videoCodecs
      : [...videoCodecs, ...audioCodecs];

  for (const codec of searchList) {
    const needle = new TextEncoder().encode(codec);
    for (let i = 4; i < limit - 4; i++) {
      if (data[i] === needle[0] && data[i + 1] === needle[1] &&
          data[i + 2] === needle[2] && data[i + 3] === needle[3]) {
        if (codec === 'avc1' || codec === 'avc3') {
          const profileStr = tryReadAvcProfile(data, i);
          codecs.push(profileStr || 'avc1.42E01E');
        } else if (codec === 'hev1') {
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
  const searchEnd = Math.min(avc1Offset + 200, data.length - 8);
  const needle = new TextEncoder().encode('avcC');
  for (let i = avc1Offset; i < searchEnd; i++) {
    if (data[i] === needle[0] && data[i + 1] === needle[1] &&
        data[i + 2] === needle[2] && data[i + 3] === needle[3]) {
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

// ─── Single SourceBuffer Append Queue (internal) ───

// Seconds of already-played buffer to keep before evicting.
const BUFFER_EVICT_KEEP_BEHIND = 5;
// Max retries for QuotaExceededError before giving up.
const QUOTA_MAX_RETRIES = 3;
// Proactive eviction: trigger when played-behind exceeds this many seconds.
const PROACTIVE_EVICT_THRESHOLD = 15;

function createAppendQueue(sourceBuffer, { onError, getVideoElement, getMediaSource } = {}) {
  let queue = [];
  let appending = false;
  let destroyed = false;
  let paused = false;  // For MMS endstreaming

  /**
   * Evict already-played buffer to free space for new appends.
   * Keeps BUFFER_EVICT_KEEP_BEHIND seconds behind currentTime.
   * Returns a Promise that resolves when the eviction updateend fires.
   */
  function evictPlayed() {
    const video = getVideoElement?.();
    if (!video || !sourceBuffer || sourceBuffer.updating) return Promise.resolve();

    const currentTime = video.currentTime || 0;
    const removeEnd = Math.max(0, currentTime - BUFFER_EVICT_KEEP_BEHIND);
    if (removeEnd <= 0) return Promise.resolve();

    // Check if there's anything to remove
    const buffered = sourceBuffer.buffered;
    if (!buffered || buffered.length === 0 || buffered.start(0) >= removeEnd) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const onDone = () => {
        sourceBuffer.removeEventListener('updateend', onDone);
        resolve();
      };
      sourceBuffer.addEventListener('updateend', onDone);
      try {
        sourceBuffer.remove(0, removeEnd);
      } catch {
        sourceBuffer.removeEventListener('updateend', onDone);
        resolve();
      }
    });
  }

  /**
   * Check if proactive eviction is needed (buffered behind > threshold).
   */
  function shouldEvictProactively() {
    const video = getVideoElement?.();
    if (!video || !sourceBuffer) return false;
    const buffered = sourceBuffer.buffered;
    if (!buffered || buffered.length === 0) return false;
    const currentTime = video.currentTime || 0;
    const bufferStart = buffered.start(0);
    return (currentTime - bufferStart) > PROACTIVE_EVICT_THRESHOLD;
  }

  const processQueue = () => {
    if (destroyed || appending || paused || !sourceBuffer || !queue.length) return;
    if (sourceBuffer.updating) return;

    const ms = getMediaSource?.();
    if (ms && ms.readyState !== 'open') return;

    // Proactive eviction: if too much played buffer has accumulated,
    // evict before appending the next chunk to keep memory under control.
    if (shouldEvictProactively()) {
      appending = true; // Block queue while evicting
      evictPlayed().then(() => {
        appending = false;
        if (!destroyed) processQueue();
      });
      return;
    }

    const entry = queue.shift();
    appending = true;

    let quotaRetries = 0;

    const attemptAppend = (data) => {
      const onUpdate = () => {
        sourceBuffer.removeEventListener('updateend', onUpdate);
        sourceBuffer.removeEventListener('error', onErr);
        appending = false;
        entry.resolve();
        processQueue();
      };

      const onErr = () => {
        sourceBuffer.removeEventListener('updateend', onUpdate);
        sourceBuffer.removeEventListener('error', onErr);
        appending = false;
        const err = new Error('SourceBuffer append error');
        entry.reject(err);
        onError?.(err);
        // Continue processing remaining entries so the queue doesn't stall
        processQueue();
      };

      sourceBuffer.addEventListener('updateend', onUpdate);
      sourceBuffer.addEventListener('error', onErr);

      try {
        sourceBuffer.appendBuffer(data);
      } catch (err) {
        sourceBuffer.removeEventListener('updateend', onUpdate);
        sourceBuffer.removeEventListener('error', onErr);
        appending = false;

        // QuotaExceededError — evict played buffer and retry
        if (err.name === 'QuotaExceededError' && quotaRetries < QUOTA_MAX_RETRIES) {
          quotaRetries++;
          evictPlayed().then(() => {
            if (destroyed) { entry.reject(new Error('queue destroyed')); return; }
            attemptAppend(data);
          });
          return;
        }

        entry.reject(err);
        onError?.(err);
      }
    };

    attemptAppend(entry.data);
  };

  return {
    append(data) {
      return new Promise((resolve, reject) => {
        if (destroyed) return reject(new Error('queue destroyed'));
        queue.push({ data, resolve, reject });
        processQueue();
      });
    },
    flush() { processQueue(); },
    pause() { paused = true; },
    resume() { paused = false; processQueue(); },
    get pending() { return queue.length + (appending ? 1 : 0); },
    destroy() { destroyed = true; queue = []; }
  };
}

// ─── MSE Player (Multi-SourceBuffer) ───

/**
 * Create an MSE/MMS-based video player controller.
 * Supports multiple SourceBuffers for multi-track playback.
 *
 * Usage for multi-track:
 *   const player = createMsePlayer({ videoElement, onError });
 *   await player.addSourceBuffer('video', mimeCodec);    // e.g. 'video/mp4; codecs="avc1.64001F"'
 *   await player.addSourceBuffer('audio', mimeCodec);    // e.g. 'video/mp4; codecs="mp4a.40.2"'
 *   await player.appendChunk('video', initSegmentData);
 *   await player.appendChunk('audio', initSegmentData);
 *   await player.appendChunk('video', mediaSegmentData);
 *   // ...
 *   await player.endOfStream();
 *
 * Usage for single-track / muxed:
 *   const player = createMsePlayer({ videoElement, onError });
 *   await player.addSourceBuffer('muxed', mimeCodec);
 *   await player.appendChunk('muxed', initData);
 *   await player.appendChunk('muxed', mediaData);
 *   await player.endOfStream();
 */
export function createMsePlayer({ videoElement, onError }) {
  let mediaSource = null;
  let objectUrl = null;
  let destroyed = false;
  let sourceOpen = false;
  let sourceOpenResolve = null;

  // Map of label → { sourceBuffer, queue }
  const buffers = {};

  const MSCtor = getMediaSourceCtor();
  const isMMS = typeof self !== 'undefined' && typeof self.ManagedMediaSource === 'function' && MSCtor === self.ManagedMediaSource;

  /**
   * Initialize the MediaSource and attach to the video element.
   * Must be called before addSourceBuffer.
   */
  function open() {
    return new Promise((resolve, reject) => {
      if (destroyed) return reject(new Error('player destroyed'));
      if (!MSCtor) return reject(new Error('MediaSource/ManagedMediaSource not available'));

      mediaSource = new MSCtor();

      if (isMMS && videoElement) {
        videoElement.disableRemotePlayback = true;
      }

      // Bind event listeners BEFORE setting src to avoid race conditions
      mediaSource.addEventListener('sourceopen', () => {
        sourceOpen = true;
        resolve();
        if (sourceOpenResolve) { sourceOpenResolve(); sourceOpenResolve = null; }
      }, { once: true });

      mediaSource.addEventListener('error', () => {
        const err = new Error('MediaSource error');
        reject(err);
        onError?.(err);
      }, { once: true });

      if (isMMS) {
        // ManagedMediaSource: pause/resume append queues based on streaming state.
        // iOS Safari fires endstreaming when it has enough buffered data;
        // startstreaming when it needs more.
        mediaSource.addEventListener('startstreaming', () => {
          for (const b of Object.values(buffers)) {
            b.queue.resume();
          }
        });
        mediaSource.addEventListener('endstreaming', () => {
          for (const b of Object.values(buffers)) {
            b.queue.pause();
          }
        });
      }

      // Set src after event listeners are bound
      objectUrl = URL.createObjectURL(mediaSource);
      videoElement.src = objectUrl;
    });
  }

  /**
   * Add a SourceBuffer for a given track label (e.g. 'video', 'audio', 'muxed').
   * @param {string} label - Track label for routing chunks
   * @param {string} mimeCodec - MIME type with codecs, e.g. 'video/mp4; codecs="avc1.64001F"'
   */
  function addSourceBuffer(label, mimeCodec) {
    if (destroyed) throw new Error('player destroyed');
    if (!mediaSource || !sourceOpen) throw new Error('MediaSource not open — call open() first');
    if (buffers[label]) throw new Error(`SourceBuffer "${label}" already exists`);

    const sb = mediaSource.addSourceBuffer(mimeCodec);
    sb.mode = 'segments';

    const queue = createAppendQueue(sb, {
      onError,
      getVideoElement: () => videoElement,
      getMediaSource: () => mediaSource
    });
    buffers[label] = { sourceBuffer: sb, queue, mimeCodec };
  }

  return {
    open,
    addSourceBuffer,

    /**
     * Queue a chunk of data to be appended to a specific track's SourceBuffer.
     * @param {string} label - Track label (e.g. 'video', 'audio', 'muxed')
     * @param {Uint8Array} data - The fMP4 segment data
     */
    appendChunk(label, data) {
      if (destroyed) return Promise.reject(new Error('player destroyed'));
      const buf = buffers[label];
      if (!buf) return Promise.reject(new Error(`No SourceBuffer for label "${label}"`));
      return buf.queue.append(data);
    },

    /**
     * Signal end of stream after all queued chunks have been appended.
     * Returns a Promise that resolves when endOfStream has been called.
     */
    endOfStream() {
      if (destroyed || !mediaSource) return Promise.resolve();

      return new Promise((resolve) => {
        const callEndOfStream = () => {
          try {
            if (mediaSource && mediaSource.readyState === 'open') {
              mediaSource.endOfStream();
            }
          } catch (err) {
            console.warn('[mse-player] endOfStream error:', err?.message);
          }
          resolve();
        };

        const waitForQuiet = () => {
          if (destroyed || !mediaSource) { resolve(); return; }
          const anyUpdating = Object.values(buffers).some(b => b.sourceBuffer?.updating);
          const anyPending = Object.values(buffers).some(b => b.queue.pending > 0);
          if (!anyUpdating && !anyPending) {
            callEndOfStream();
          } else {
            // Poll until all SourceBuffers are idle
            let attempts = 0;
            const maxAttempts = 200; // 10s at 50ms intervals
            const checkInterval = setInterval(() => {
              attempts++;
              if (destroyed || !mediaSource) {
                clearInterval(checkInterval);
                resolve();
                return;
              }
              const still = Object.values(buffers).some(b => b.sourceBuffer?.updating);
              const pending = Object.values(buffers).some(b => b.queue.pending > 0);
              if (!still && !pending) {
                clearInterval(checkInterval);
                callEndOfStream();
              } else if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                callEndOfStream(); // Force EOS after timeout
              }
            }, 50);
          }
        };

        // Resume all paused queues so they can drain
        for (const b of Object.values(buffers)) {
          b.queue.resume();
        }
        waitForQuiet();
      });
    },

    /**
     * Clean up all resources.
     */
    destroy() {
      destroyed = true;

      for (const b of Object.values(buffers)) {
        b.queue.destroy();
        if (b.sourceBuffer && mediaSource?.readyState === 'open') {
          try { mediaSource.removeSourceBuffer(b.sourceBuffer); } catch {}
        }
      }

      if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch {}
        objectUrl = null;
      }

      if (mediaSource?.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch {}
      }

      mediaSource = null;
    },

    /** Get the list of track labels that have SourceBuffers. */
    get labels() { return Object.keys(buffers); },

    get objectUrl() { return objectUrl; }
  };
}
