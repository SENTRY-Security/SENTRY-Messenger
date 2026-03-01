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

    // [FIX] If the extracted codec was HEVC but the generic "hvc1" wasn't
    // supported by isTypeSupported (Chrome needs specific profile/level like
    // "hvc1.1.6.L123.b0"), try common HEVC profile strings BEFORE falling
    // through to H.264 candidates.  Returning H.264 for HEVC data causes
    // the SourceBuffer append to fail and MediaSource to enter "ended" state.
    const isHevc = /^hvc1|^hev1/i.test(codecStr);
    if (isHevc) {
      const hasAudio = codecStr.includes('mp4a');
      const audioSuffix = hasAudio ? ',mp4a.40.2' : '';
      const hevcProfiles = [
        `hvc1.1.6.L93.b0${audioSuffix}`,   // Main L3.1
        `hvc1.1.6.L120.b0${audioSuffix}`,  // Main L4.0
        `hvc1.1.6.L123.b0${audioSuffix}`,  // Main L4.1
        `hvc1.1.6.L150.b0${audioSuffix}`,  // Main L5.0
        `hvc1.1.6.L153.b0${audioSuffix}`,  // Main L5.1
        `hvc1.2.4.L120.b0${audioSuffix}`,  // Main 10 L4.0
        `hvc1.2.4.L150.b0${audioSuffix}`,  // Main 10 L5.0
      ];
      for (const profile of hevcProfiles) {
        const mime = `video/mp4; codecs="${profile}"`;
        if (MSCtor.isTypeSupported(mime)) return mime;
      }
      // HEVC detected but not supported by MSE — return null so caller
      // can try manifest codec or blob fallback.  Do NOT fall through
      // to H.264 candidates which would cause an append error.
      return null;
    }
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
 * Validate that data looks like a valid fMP4 init segment for MSE.
 * MSE requires fragmented MP4 which has an 'mvex' (Movie Extends) box
 * inside 'moov'. Without mvex, browsers reject appendBuffer with a
 * decode error (readyState → "ended") even if the codec string is correct.
 *
 * Returns false for regular (non-fragmented) MP4 data, which plays fine
 * via blob URL but cannot be streamed via MSE SourceBuffer.
 */
export function isValidMseInitSegment(data) {
  if (!data || data.length < 12) return false;
  if (!hasMp4Box(data, 'moov')) return false;
  // mvex (Movie Extends) is the key indicator of fragmented MP4.
  // Without it, the browser treats the data as non-fragmented MP4 and
  // rejects appendBuffer with a decode error.
  return hasMp4Box(data, 'mvex');
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

/**
 * Parse an fMP4 media segment (moof+mdat) to extract timing metadata.
 *
 * Returns { trackId, startTime, duration } where startTime is in seconds,
 * or null if parsing fails. Reads:
 *   moof → traf → tfhd (track_ID)
 *   moof → traf → tfdt (baseMediaDecodeTime)
 *   moof → traf → trun (sample count + durations)
 *
 * Also needs the per-track timescale from the init segment (moov → trak → mdhd).
 */
export function parseMoofTiming(data, timescaleMap) {
  if (!data || data.length < 16) return null;
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const len = data.length;

    // Find moof box using proper box traversal (not byte-by-byte scan)
    // to avoid false matches inside mdat or other box payloads.
    let moofStart = -1, moofEnd = -1;
    {
      let i = 0;
      while (i <= len - 8) {
        const boxSize = view.getUint32(i);
        if (boxSize < 8 || i + boxSize > len) break;
        if (data[i + 4] === 0x6D && data[i + 5] === 0x6F &&
            data[i + 6] === 0x6F && data[i + 7] === 0x66) { // 'moof'
          moofStart = i + 8;
          moofEnd = i + boxSize;
          break;
        }
        i += boxSize;
      }
    }
    if (moofStart < 0) return null;

    // Find traf inside moof using proper box traversal
    let trafStart = -1, trafEnd = -1;
    {
      let i = moofStart;
      while (i <= moofEnd - 8) {
        const boxSize = view.getUint32(i);
        if (boxSize < 8 || i + boxSize > moofEnd) break;
        if (data[i + 4] === 0x74 && data[i + 5] === 0x72 &&
            data[i + 6] === 0x61 && data[i + 7] === 0x66) { // 'traf'
          trafStart = i + 8;
          trafEnd = i + boxSize;
          break;
        }
        i += boxSize;
      }
    }
    if (trafStart < 0) return null;

    let trackId = 0;
    let baseDecodeTime = 0;
    let totalDuration = 0;
    let defaultDuration = 0;

    // Scan traf children
    let pos = trafStart;
    while (pos < trafEnd - 8) {
      const boxSize = view.getUint32(pos);
      if (boxSize < 8 || pos + boxSize > trafEnd) break;
      const type = String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]);

      if (type === 'tfhd') {
        const flags = (view.getUint8(pos + 9) << 16) | (view.getUint8(pos + 10) << 8) | view.getUint8(pos + 11);
        trackId = view.getUint32(pos + 12);
        let off = 16;
        if (flags & 0x01) off += 8; // base-data-offset
        if (flags & 0x02) off += 4; // sample-description-index
        if (flags & 0x08) { defaultDuration = view.getUint32(pos + off); }
      } else if (type === 'tfdt') {
        const ver = data[pos + 8];
        if (ver === 1) {
          baseDecodeTime = Number(view.getBigUint64(pos + 12));
        } else {
          baseDecodeTime = view.getUint32(pos + 12);
        }
      } else if (type === 'trun') {
        const flags = (view.getUint8(pos + 9) << 16) | (view.getUint8(pos + 10) << 8) | view.getUint8(pos + 11);
        const sampleCount = view.getUint32(pos + 12);
        let off = 16;
        if (flags & 0x01) off += 4; // data-offset
        if (flags & 0x04) off += 4; // first-sample-flags
        const hasDuration = !!(flags & 0x100);
        const hasSize = !!(flags & 0x200);
        const hasFlags = !!(flags & 0x400);
        const hasCTO = !!(flags & 0x800);
        for (let s = 0; s < sampleCount && pos + off + 4 <= trafEnd; s++) {
          if (hasDuration) { totalDuration += view.getUint32(pos + off); off += 4; }
          else { totalDuration += defaultDuration; }
          if (hasSize) off += 4;
          if (hasFlags) off += 4;
          if (hasCTO) off += 4;
        }
        if (!hasDuration && defaultDuration) {
          totalDuration = sampleCount * defaultDuration;
        }
      }
      pos += boxSize;
    }

    const timescale = (timescaleMap && timescaleMap[trackId]) || 0;
    if (!timescale || !trackId) return null;

    return {
      trackId,
      startTime: baseDecodeTime / timescale,
      duration: totalDuration / timescale,
    };
  } catch {
    return null;
  }
}

/**
 * Extract per-track timescales from an fMP4 init segment (moov).
 * Returns a map of { trackId → timescale }.
 *
 * Parses: moov → trak → tkhd (track_ID) + mdia → mdhd (timescale)
 */
export function parseInitTimescales(data) {
  const map = {};
  if (!data || data.length < 16) return map;
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const len = data.length;

    // Find all trak boxes inside moov
    const findBoxes = (start, end, type) => {
      const results = [];
      let i = start;
      while (i <= end - 8) {
        const boxSize = view.getUint32(i);
        if (boxSize < 8 || i + boxSize > end) break;
        if (data[i + 4] === type.charCodeAt(0) && data[i + 5] === type.charCodeAt(1) &&
            data[i + 6] === type.charCodeAt(2) && data[i + 7] === type.charCodeAt(3)) {
          results.push({ start: i + 8, end: i + boxSize });
        }
        i += boxSize;
      }
      return results;
    };

    const findBox = (start, end, type) => {
      let i = start;
      while (i <= end - 8) {
        const boxSize = view.getUint32(i);
        if (boxSize < 8 || i + boxSize > end) break;
        if (data[i + 4] === type.charCodeAt(0) && data[i + 5] === type.charCodeAt(1) &&
            data[i + 6] === type.charCodeAt(2) && data[i + 7] === type.charCodeAt(3)) {
          return { start: i + 8, end: i + boxSize, headerStart: i };
        }
        i += boxSize;
      }
      return null;
    };

    // Find moov
    const moov = findBox(0, len, 'moov');
    if (!moov) return map;

    // Find each trak
    for (const trak of findBoxes(moov.start, moov.end, 'trak')) {
      // tkhd → track_ID
      const tkhd = findBox(trak.start, trak.end, 'tkhd');
      if (!tkhd) continue;
      const tkhdVer = data[tkhd.start];
      const trackId = view.getUint32(tkhd.start + (tkhdVer === 1 ? 20 : 12));

      // mdia → mdhd → timescale
      const mdia = findBox(trak.start, trak.end, 'mdia');
      if (!mdia) continue;
      const mdhd = findBox(mdia.start, mdia.end, 'mdhd');
      if (!mdhd) continue;
      const mdhdVer = data[mdhd.start];
      const timescale = view.getUint32(mdhd.start + (mdhdVer === 1 ? 20 : 12));
      if (timescale > 0) map[trackId] = timescale;
    }
  } catch {}
  return map;
}

// ─── Single SourceBuffer Append Queue (internal) ───

// Seconds of already-played buffer to keep before evicting.
const BUFFER_EVICT_KEEP_BEHIND = 5;
// Max retries for QuotaExceededError before giving up.
const QUOTA_MAX_RETRIES = 3;
// Proactive eviction: trigger when played-behind exceeds this many seconds.
// Higher = less frequent eviction = fewer buffer gaps during playback.
const PROACTIVE_EVICT_THRESHOLD = 30;
// Safety timeout: if an append doesn't complete within this time, reject it.
const APPEND_TIMEOUT_MS = 10_000;
// Safety timeout for buffer eviction (sourceBuffer.remove): if updateend
// never fires after remove(), unblock the queue after this many ms.
// Typical remove() completes in <200ms; 2s is a generous safety margin.
const EVICT_TIMEOUT_MS = 2_000;

function createAppendQueue(sourceBuffer, { onError, getVideoElement, getMediaSource } = {}) {
  let queue = [];
  let appending = false;
  let destroyed = false;
  let paused = false;  // For MMS endstreaming
  let evictionEnabled = true; // Can be disabled for seek re-append

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
      let settled = false;
      let timer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        sourceBuffer.removeEventListener('updateend', done);
        resolve();
      };
      sourceBuffer.addEventListener('updateend', done);
      // Safety timeout: if updateend never fires, unblock anyway
      timer = setTimeout(() => {
        if (settled) return;
        console.warn('[mse-player] evictPlayed: updateend timed out, forcing resolve');
        try { if (sourceBuffer.updating) sourceBuffer.abort(); } catch {}
        done();
      }, EVICT_TIMEOUT_MS);
      try {
        sourceBuffer.remove(0, removeEnd);
      } catch {
        done();
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
    if (destroyed || !queue.length) return;

    // If MediaSource is truly closed (destroyed), drain all pending
    // items so callers' promises settle instead of hanging forever.
    // Note: "ended" state still accepts appends — appendBuffer()
    // transitions readyState back to "open" automatically. This is
    // essential for seek-triggered re-append after endOfStream().
    const ms = getMediaSource?.();
    if (ms && ms.readyState === 'closed') {
      const drainErr = new Error(`MediaSource readyState is "closed", cannot append`);
      const pending = queue.splice(0);
      for (const entry of pending) entry.reject(drainErr);
      return;
    }

    if (appending || paused || !sourceBuffer) return;
    if (sourceBuffer.updating) return;

    // Proactive eviction: if too much played buffer has accumulated,
    // evict before appending the next chunk to keep memory under control.
    // Disabled during seek re-append to avoid evicting freshly appended data.
    if (evictionEnabled && shouldEvictProactively()) {
      appending = true; // Block queue while evicting
      // Double-safety: even if evictPlayed's own timeout fails, cap the total
      // wait so the queue can never be permanently blocked by eviction.
      let evictDone = false;
      const unblockEvict = () => {
        if (evictDone) return;
        evictDone = true;
        appending = false;
        if (!destroyed) processQueue();
      };
      evictPlayed().then(unblockEvict, unblockEvict);
      setTimeout(() => {
        if (!evictDone) {
          console.warn('[mse-player] proactive eviction overall timeout, forcing unblock');
          unblockEvict();
        }
      }, EVICT_TIMEOUT_MS + 2_000);
      return;
    }

    const entry = queue.shift();
    appending = true;

    let quotaRetries = 0;

    const attemptAppend = (data) => {
      let settled = false;
      let appendTimer = null;

      const cleanup = () => {
        settled = true;
        if (appendTimer) { clearTimeout(appendTimer); appendTimer = null; }
        sourceBuffer.removeEventListener('updateend', onUpdate);
        sourceBuffer.removeEventListener('error', onErr);
      };

      const onUpdate = () => {
        if (settled) return;
        cleanup();
        appending = false;
        entry.resolve();
        processQueue();
      };

      const onErr = () => {
        if (settled) return;
        cleanup();
        appending = false;
        const msState = getMediaSource?.()?.readyState || 'unknown';
        const sbUpdating = sourceBuffer?.updating ?? 'N/A';
        const err = new Error(`SourceBuffer append error (readyState=${msState}, updating=${sbUpdating}, bytes=${data?.byteLength ?? 0})`);
        entry.reject(err);
        onError?.(err);
        // Continue processing remaining entries so the queue doesn't stall
        processQueue();
      };

      sourceBuffer.addEventListener('updateend', onUpdate);
      sourceBuffer.addEventListener('error', onErr);

      // Safety timeout: if neither updateend nor error fires, unblock the queue
      appendTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        appending = false;
        // Try to abort the stuck update
        try { if (sourceBuffer.updating) sourceBuffer.abort(); } catch {}
        const err = new Error(`SourceBuffer append timed out (${APPEND_TIMEOUT_MS}ms, bytes=${data?.byteLength ?? 0})`);
        entry.reject(err);
        onError?.(err);
        processQueue();
      }, APPEND_TIMEOUT_MS);

      try {
        sourceBuffer.appendBuffer(data);
      } catch (err) {
        if (settled) return;
        cleanup();
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
    setEvictionEnabled(v) { evictionEnabled = !!v; },
    get pending() { return queue.length + (appending ? 1 : 0); },

    /**
     * Force-reset the queue for seek re-append.
     * If the previous append's updateend event was lost (common on MMS after
     * endOfStream), `appending` stays stuck at true and the entire queue
     * deadlocks. This method:
     *   1. Aborts any in-progress SourceBuffer operation
     *   2. Resets `appending` and `paused` flags
     *   3. Kicks processQueue to resume
     */
    resetForSeek() {
      if (sourceBuffer) {
        try {
          if (sourceBuffer.updating) sourceBuffer.abort();
        } catch {}
      }
      appending = false;
      paused = false;
      processQueue();
    },

    destroy() {
      destroyed = true;
      const pending = queue;
      queue = [];
      for (const entry of pending) {
        try { entry.reject(new Error('queue destroyed')); } catch {}
      }
    }
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
  let suppressEndStreaming = false; // Suppress endstreaming during seek re-append

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
          if (suppressEndStreaming) {
            console.info('[mse-player] endstreaming suppressed during re-append');
            return;
          }
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
    // On ManagedMediaSource (iOS Safari), setting mode can throw or cause
    // later append errors. Only set explicitly on standard MediaSource.
    if (!isMMS) {
      try { sb.mode = 'segments'; } catch { /* leave browser default */ }
    }

    const queue = createAppendQueue(sb, {
      onError,
      getVideoElement: () => videoElement,
      getMediaSource: () => mediaSource
    });
    buffers[label] = { sourceBuffer: sb, queue, mimeCodec };
  }

  /**
   * Remove a previously-added SourceBuffer so it can be re-added with a
   * different MIME codec string (used for init segment retry).
   */
  function removeSourceBuffer(label) {
    const buf = buffers[label];
    if (!buf) return;
    buf.queue.destroy();
    if (buf.sourceBuffer && mediaSource?.readyState === 'open') {
      try { mediaSource.removeSourceBuffer(buf.sourceBuffer); } catch {}
    }
    delete buffers[label];
  }

  return {
    open,
    addSourceBuffer,
    removeSourceBuffer,

    /**
     * Set MediaSource.duration explicitly. Call after the init segment is
     * appended so the browser knows the full timeline upfront, preventing
     * incremental duration growth (and associated durationchange pauses).
     */
    setDuration(seconds) {
      if (!mediaSource || mediaSource.readyState !== 'open') return;
      if (!Number.isFinite(seconds) || seconds <= 0) return;

      const trySet = () => {
        try {
          if (mediaSource?.readyState === 'open') {
            mediaSource.duration = seconds;
            console.info('[mse-player] duration set to', seconds, 's (was', mediaSource.duration, ')');
          }
        } catch (err) {
          console.warn('[mse-player] setDuration failed:', err?.message);
        }
      };

      const anyUpdating = Object.values(buffers).some(b => b.sourceBuffer?.updating);
      if (anyUpdating) {
        // Wait for the first SourceBuffer to finish, then try again.
        // Uses both updateend listener and timeout fallback for reliability.
        const updatingSb = Object.values(buffers).find(b => b.sourceBuffer?.updating)?.sourceBuffer;
        if (updatingSb) {
          const onDone = () => {
            updatingSb.removeEventListener('updateend', onDone);
            trySet();
          };
          updatingSb.addEventListener('updateend', onDone);
          // Safety fallback: if updateend never fires within 500ms, try anyway
          setTimeout(() => {
            updatingSb.removeEventListener('updateend', onDone);
            trySet();
          }, 500);
        } else {
          setTimeout(trySet, 100);
        }
      } else {
        trySet();
      }
    },

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

    /**
     * Check if a specific time is within the buffered range of any SourceBuffer.
     * Used by seek handler to decide if re-append is needed.
     */
    isTimeBuffered(time, toleranceSec = 0.5) {
      for (const buf of Object.values(buffers)) {
        const sb = buf.sourceBuffer;
        try {
          if (!sb?.buffered) continue;
          for (let i = 0; i < sb.buffered.length; i++) {
            if (time >= sb.buffered.start(i) - toleranceSec &&
                time <= sb.buffered.end(i) + toleranceSec) {
              return true;
            }
          }
        } catch {}
      }
      return false;
    },

    /**
     * Enable/disable proactive buffer eviction on all SourceBuffers.
     * Disable during seek re-append to avoid evicting freshly-appended data.
     */
    setEvictionEnabled(enabled) {
      for (const buf of Object.values(buffers)) {
        buf.queue.setEvictionEnabled(enabled);
      }
    },

    /**
     * Resume all paused append queues.
     * Must be called before seek re-append on MMS: endOfStream()
     * triggers the MMS 'endstreaming' event which pauses all queues.
     * Without an explicit resume, subsequent appendChunk() calls
     * deadlock because processQueue() exits on paused=true.
     */
    resumeQueues() {
      for (const b of Object.values(buffers)) {
        b.queue.resume();
      }
    },

    /**
     * Suppress MMS 'endstreaming' handler from pausing queues.
     * Must be enabled during seek re-append and disabled after.
     * On non-MMS browsers this is a no-op.
     */
    setSuppressEndStreaming(v) { suppressEndStreaming = !!v; },

    /**
     * Force-reset all SourceBuffer queues for seek re-append.
     * Aborts any stuck SourceBuffer operations, resets appending/paused
     * flags, and kicks processQueue. Call BEFORE pushing seek re-append
     * data to ensure the queue isn't deadlocked from a prior endOfStream
     * where updateend was missed (common MMS issue).
     */
    resetQueuesForSeek() {
      for (const b of Object.values(buffers)) {
        b.queue.resetForSeek();
      }
    },

    /**
     * Prepare MediaSource for seek re-append.
     * On MMS (iOS Safari), after endOfStream() the SourceBuffer won't
     * process appendBuffer() until the browser fires 'startstreaming'.
     * This method waits for that event (with a short timeout for
     * non-MMS browsers or if the event doesn't fire).
     *
     * Must be called AFTER setting video.currentTime (the seek itself)
     * and BEFORE appending chunks.
     */
    async prepareForSeekAppend() {
      if (!isMMS || !mediaSource) return;
      // If already open (startstreaming was fired), no need to wait
      if (mediaSource.readyState === 'open') return;

      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try { mediaSource.removeEventListener('sourceopen', finish); } catch {}
          resolve();
        };
        // When appendBuffer transitions 'ended' → 'open', sourceopen fires
        mediaSource.addEventListener('sourceopen', finish);
        // Also resolve on startstreaming (MMS-specific)
        try { mediaSource.addEventListener('startstreaming', finish); } catch {}
        // Fallback timeout: don't block forever if events don't fire
        setTimeout(finish, 500);
      });
    },

    /** Get the list of track labels that have SourceBuffers. */
    get labels() { return Object.keys(buffers); },

    get objectUrl() { return objectUrl; },

    /**
     * Get real-time stats for the MSE player.
     * Used by the video stats overlay to display buffer/queue info.
     */
    getStats() {
      const stats = {
        readyState: mediaSource?.readyState || 'closed',
        isMMS: isMMS,
        buffers: {}
      };
      for (const [label, buf] of Object.entries(buffers)) {
        const sb = buf.sourceBuffer;
        const ranges = [];
        try {
          if (sb?.buffered) {
            for (let i = 0; i < sb.buffered.length; i++) {
              ranges.push({ start: sb.buffered.start(i), end: sb.buffered.end(i) });
            }
          }
        } catch {}
        stats.buffers[label] = {
          mimeCodec: buf.mimeCodec,
          updating: sb?.updating || false,
          queuePending: buf.queue.pending,
          bufferedRanges: ranges,
          totalBuffered: ranges.reduce((sum, r) => sum + (r.end - r.start), 0),
          mode: sb?.mode || null
        };
      }
      return stats;
    }
  };
}
