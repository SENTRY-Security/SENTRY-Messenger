// /app/features/mp4-remuxer.js
// Remux non-fragmented MP4/MOV to fragmented MP4 (fMP4) using mp4box.js.
// Dynamically loads mp4box.js from CDN on first use. Pure JS, no WASM required.
//
// Returns per-track fMP4 segments for MSE-compatible chunked upload.
// Each track gets its own init segment and media segments — designed for
// MSE playback with one SourceBuffer per track (the correct MSE pattern).

const MP4BOX_CDN_URL = 'https://esm.sh/mp4box@0.5.3';

let _mp4boxModule = null;

/**
 * Lazily load mp4box.js from CDN. Cached after first load.
 */
async function loadMp4box() {
  if (_mp4boxModule) return _mp4boxModule;
  try {
    _mp4boxModule = await import(/* webpackIgnore: true */ MP4BOX_CDN_URL);
    return _mp4boxModule;
  } catch (err) {
    throw new Error('無法載入影片處理模組：' + (err?.message || err));
  }
}

// Supported MIME types for remuxing
const REMUXABLE_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
]);

/**
 * Custom error class for unsupported video formats.
 * UI layers catch this to show a user-friendly modal.
 */
export class UnsupportedVideoFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedVideoFormatError';
  }
}

/**
 * Check if a file's MIME type is a video that can be remuxed to fMP4.
 * WebM passes through without remuxing.
 * Non-video or unsupported video types should be rejected.
 */
export function canRemuxVideo(file) {
  if (!file) return false;
  const type = (typeof file.type === 'string' ? file.type : '').toLowerCase().trim();
  if (REMUXABLE_TYPES.has(type)) return true;
  if (type === 'video/webm') return true;
  return false;
}

/**
 * Check if the file is already fragmented MP4 by scanning for 'moof' box in first 64KB.
 */
function isAlreadyFragmented(u8) {
  if (!u8 || u8.length < 8) return false;
  const m = 0x6D, o = 0x6F, f = 0x66; // 'moof'
  const limit = Math.min(u8.length - 3, 64 * 1024);
  for (let i = 4; i < limit; i++) {
    if (u8[i] === m && u8[i + 1] === o && u8[i + 2] === o && u8[i + 3] === f) return true;
  }
  return false;
}

/**
 * Count 'trak' sub-boxes in the moov box to determine number of tracks.
 * Used to decide whether splitFragmentedMp4 (single-track muxed) is safe,
 * or whether mp4box.js is needed for proper per-track segmentation.
 *
 * Multi-track already-fragmented MP4 files may have non-interleaved segments
 * (separate moof+mdat for video and audio). These cannot be fed to a single
 * muxed SourceBuffer — each track needs its own SourceBuffer.
 */
function countMoovTracks(u8) {
  let i = 0;
  while (i < u8.length - 7) {
    let boxSize = readU32(u8, i) >>> 0; // unsigned
    const boxType = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
    let headerSize = 8;
    if (boxSize === 1 && i + 16 <= u8.length) {
      boxSize = readU64(u8, i + 8);
      headerSize = 16;
    }
    if (boxSize < headerSize || i + boxSize > u8.length) break;

    if (boxType === 'moov') {
      let count = 0;
      let j = i + headerSize;
      const moovEnd = i + boxSize;
      while (j < moovEnd - 7) {
        let subSize = readU32(u8, j) >>> 0;
        const subType = String.fromCharCode(u8[j + 4], u8[j + 5], u8[j + 6], u8[j + 7]);
        if (subSize === 1 && j + 16 <= moovEnd) {
          subSize = readU64(u8, j + 8);
        }
        if (subSize < 8 || j + subSize > moovEnd) break;
        if (subType === 'trak') count++;
        j += subSize;
      }
      return count;
    }

    i += boxSize;
  }
  return 0;
}

/**
 * Read a big-endian uint32 from data at the given offset.
 */
function readU32(data, offset) {
  return (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
}

/**
 * Read a big-endian uint64 from data at the given offset (returns Number, safe up to 2^53).
 */
function readU64(data, offset) {
  const hi = readU32(data, offset);
  const lo = readU32(data, offset + 4);
  return hi * 0x100000000 + lo;
}

// ─── Helpers ───

/**
 * Parse top-level MP4 boxes from a Uint8Array.
 * Returns array of { type: string, data: Uint8Array, offset: number }.
 */
function parseTopLevelBoxes(u8) {
  const boxes = [];
  let i = 0;
  while (i < u8.length - 7) {
    let boxSize = readU32(u8, i);
    const boxType = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
    let headerSize = 8;
    if (boxSize === 1 && i + 16 <= u8.length) {
      boxSize = readU64(u8, i + 8);
      headerSize = 16;
    }
    if (boxSize < headerSize || i + boxSize > u8.length) break;
    boxes.push({ type: boxType, data: u8.subarray(i, i + boxSize), offset: i });
    i += boxSize;
  }
  return boxes;
}

// Boxes that are part of the init segment (before first moof)
const INIT_BOX_TYPES = new Set(['ftyp', 'moov', 'free', 'skip', 'wide']);
// Boxes that appear between segments but belong WITH the next moof+mdat pair
const SEGMENT_PREFIX_TYPES = new Set(['styp', 'sidx', 'ssix', 'prft']);
// Boxes at the end of the file that are NOT valid media segments
const TRAILING_BOX_TYPES = new Set(['mfra', 'mfro', 'free', 'skip', 'wide']);

/**
 * Parse top-level MP4 boxes and split an already-fragmented MP4 into
 * an init segment (ftyp + moov) and media segments (each moof + mdat pair).
 * Already-fragmented files are typically single-SourceBuffer compatible.
 *
 * Correctly handles:
 * - styp/sidx boxes that precede moof (included with the next segment)
 * - Trailing non-media boxes like mfra/free (discarded, not valid MSE segments)
 *
 * @param {Uint8Array} u8 - The fMP4 file bytes
 * @returns {{ initSegment: Uint8Array, mediaSegments: Uint8Array[] }}
 */
function splitFragmentedMp4(u8) {
  const initParts = [];
  const mediaSegments = [];
  let i = 0;
  let foundFirstMoof = false;
  // Pending parts that will become part of the next segment (styp, sidx, moof, mdat)
  let currentSegParts = [];
  // Whether the current pending parts contain a moof (i.e. a real segment is forming)
  let currentHasMoof = false;

  while (i < u8.length - 7) {
    let boxSize = readU32(u8, i);
    const boxType = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
    let headerSize = 8;
    if (boxSize === 1 && i + 16 <= u8.length) {
      boxSize = readU64(u8, i + 8);
      headerSize = 16;
    }
    if (boxSize < headerSize || i + boxSize > u8.length) break;

    const boxData = u8.subarray(i, i + boxSize);

    if (!foundFirstMoof) {
      // Before first moof — everything goes to init
      if (boxType === 'moof') {
        foundFirstMoof = true;
        currentSegParts.push(boxData);
        currentHasMoof = true;
      } else {
        initParts.push(boxData);
      }
    } else if (boxType === 'moof') {
      // New moof — flush previous segment if it contains a complete moof+mdat
      if (currentSegParts.length > 0 && currentHasMoof) {
        mediaSegments.push(concatU8(currentSegParts));
        currentSegParts = [];
        currentHasMoof = false;
      } else if (currentSegParts.length > 0 && !currentHasMoof) {
        // Pending prefix boxes (styp/sidx) without moof — keep them, they belong with this moof
      }
      currentSegParts.push(boxData);
      currentHasMoof = true;
    } else if (boxType === 'mdat') {
      // mdat — always pair with the current moof
      currentSegParts.push(boxData);
      if (currentHasMoof) {
        mediaSegments.push(concatU8(currentSegParts));
        currentSegParts = [];
        currentHasMoof = false;
      }
    } else if (SEGMENT_PREFIX_TYPES.has(boxType)) {
      // styp/sidx/ssix/prft — keep as prefix for the next moof+mdat segment
      currentSegParts.push(boxData);
    } else if (TRAILING_BOX_TYPES.has(boxType)) {
      // mfra/free/skip/wide after media segments — discard (not valid MSE data)
    } else {
      // Unknown box type after first moof — include with current segment if building one
      if (currentHasMoof) {
        currentSegParts.push(boxData);
      }
      // Otherwise discard (not a valid media segment on its own)
    }

    i += boxSize;
  }

  // Flush remaining segment only if it contains a moof (i.e. a real media segment)
  if (currentSegParts.length > 0 && currentHasMoof) {
    mediaSegments.push(concatU8(currentSegParts));
  }

  const initSegment = concatU8(initParts);
  return { initSegment, mediaSegments };
}

/**
 * Concatenate an array of Uint8Arrays into a single Uint8Array.
 */
function concatU8(arrays) {
  if (arrays.length === 0) return new Uint8Array(0);
  if (arrays.length === 1) return arrays[0];
  let totalLen = 0;
  for (const a of arrays) totalLen += a.byteLength;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

/**
 * Determine track type from mp4box.js track info.
 */
function getTrackType(track) {
  if (track.type === 'video' || (track.codec && /^(avc|hvc|hev|vp0|av01)/.test(track.codec))) return 'video';
  if (track.type === 'audio' || (track.codec && /^(mp4a|opus|ac-3|ec-3|flac)/.test(track.codec))) return 'audio';
  return track.type || 'unknown';
}

// ─── Main Remux Function ───

/**
 * Remux a video File/Blob to fragmented MP4 using mp4box.js.
 *
 * Returns per-track fMP4 data for MSE playback with separate SourceBuffers.
 *
 * Result format:
 * - tracks[]: array of { type, codec, initSegment, mediaSegments[] }
 * - segments[]: flat ordered array of { trackIndex, data } for chunked upload
 *   - First N entries are init segments (one per track)
 *   - Remaining entries are media segments in playback order
 *
 * For WebM files, returns null tracks (WebM uses byte-range chunking).
 * For already-fragmented MP4, returns single-track format (already muxed).
 * For non-fragmented MP4/MOV, remuxes via mp4box.js into per-track segments.
 *
 * @param {File|Blob} file - Source video file
 * @param {{ onProgress?: (p: {percent: number}) => void }} [opts]
 * @returns {Promise<{
 *   tracks: Array<{type: string, codec: string, initSegment: Uint8Array, mediaSegments: Uint8Array[]}> | null,
 *   segments: Array<{trackIndex: number, data: Uint8Array}> | null,
 *   contentType: string,
 *   remuxed: boolean,
 *   name: string
 * }>}
 */
export async function remuxToFragmentedMp4(file, { onProgress } = {}) {
  if (!file) throw new Error('file required');

  const type = (typeof file.type === 'string' ? file.type : '').toLowerCase().trim();
  const name = typeof file.name === 'string' ? file.name : 'video.mp4';

  // WebM doesn't need remuxing — natively MSE-compatible.
  if (type === 'video/webm') {
    onProgress?.({ percent: 100 });
    return { tracks: null, segments: null, contentType: 'video/webm', remuxed: false, name };
  }

  // Check if this is a remuxable type
  if (!REMUXABLE_TYPES.has(type)) {
    if (type.startsWith('video/')) {
      throw new UnsupportedVideoFormatError(`不支援此影片格式：${type}`);
    }
    onProgress?.({ percent: 100 });
    return { tracks: null, segments: null, contentType: type || 'application/octet-stream', remuxed: false, name };
  }

  // Read file into memory
  onProgress?.({ percent: 0 });
  const fileBuffer = await file.arrayBuffer();
  const fileU8 = new Uint8Array(fileBuffer);
  onProgress?.({ percent: 30 });

  if (isAlreadyFragmented(fileU8)) {
    // Multi-track already-fragmented MP4 (e.g. separate video + audio tracks)
    // must go through mp4box.js for proper per-track segmentation.
    // A single muxed SourceBuffer fails when segments are non-interleaved
    // (separate moof+mdat per track) — the browser rejects single-track
    // segments appended to a multi-codec SourceBuffer.
    const moovTrackCount = countMoovTracks(fileU8);
    if (moovTrackCount <= 1) {
      // Single-track fMP4 — safe to use simple moof-boundary split
      const { initSegment, mediaSegments } = splitFragmentedMp4(fileU8);
      if (!initSegment.byteLength || mediaSegments.length === 0) {
        throw new UnsupportedVideoFormatError('已分片的影片格式無法正確解析');
      }
      const track = { type: 'muxed', codec: null, initSegment, mediaSegments };
      const segments = [
        { trackIndex: 0, data: initSegment },
        ...mediaSegments.map(data => ({ trackIndex: 0, data }))
      ];
      onProgress?.({ percent: 100 });
      return { tracks: [track], segments, contentType: 'video/mp4', remuxed: false, name };
    }
    // Multi-track fMP4 — fall through to mp4box.js for per-track segmentation
  }

  // Need to remux: load mp4box.js and fragment the file
  onProgress?.({ percent: 40 });
  const mp4boxMod = await loadMp4box();
  onProgress?.({ percent: 60 });
  const MP4Box = mp4boxMod.default || mp4boxMod.createFile || mp4boxMod;
  const createFileFn = typeof MP4Box.createFile === 'function' ? MP4Box.createFile : MP4Box;

  return new Promise((resolve, reject) => {
    let mp4boxFile;
    try {
      mp4boxFile = typeof createFileFn === 'function' ? createFileFn() : new createFileFn();
    } catch {
      try {
        mp4boxFile = MP4Box.createFile();
      } catch (err2) {
        reject(new Error('mp4box.js 初始化失敗：' + (err2?.message || err2)));
        return;
      }
    }

    // Per-track state: trackId → { type, codec, initSegment, mediaSegments[] }
    const trackMap = {};
    let trackOrder = []; // ordered track IDs as they appear in info.tracks
    // Ordered list of media segments as they arrive: { trackId, data }
    const orderedMediaSegs = [];

    mp4boxFile.onError = (err) => {
      reject(new Error('影片解析失敗：' + (err?.message || err || 'unknown mp4box error')));
    };

    mp4boxFile.onReady = (info) => {
      if (!info || !info.tracks || info.tracks.length === 0) {
        reject(new UnsupportedVideoFormatError('影片不包含任何可播放的音視訊軌道'));
        return;
      }

      // Only process video and audio tracks — subtitle, metadata, hint,
      // and other track types are not supported by MSE SourceBuffer and
      // would cause codec detection failures during playback.
      const avTracks = info.tracks.filter(t => {
        const tt = getTrackType(t);
        return tt === 'video' || tt === 'audio';
      });

      if (avTracks.length === 0) {
        reject(new UnsupportedVideoFormatError('影片不包含任何可播放的音視訊軌道'));
        return;
      }

      trackOrder = avTracks.map(t => t.id);

      for (const track of avTracks) {
        const trackType = getTrackType(track);
        trackMap[track.id] = {
          type: trackType,
          codec: track.codec || null,
          initSegment: null,
          mediaSegments: []
        };
        mp4boxFile.setSegmentOptions(track.id, track.id, {
          nbSamples: 100
        });
      }

      const initSegs = mp4boxFile.initializeSegmentation();
      for (const seg of initSegs) {
        const tid = seg.id;
        if (trackMap[tid]) {
          trackMap[tid].initSegment = new Uint8Array(seg.buffer);
        }
      }

      mp4boxFile.start();
    };

    mp4boxFile.onSegment = (id, _user, buffer, _sampleNum, _isLast) => {
      const data = new Uint8Array(buffer);
      if (trackMap[id]) {
        trackMap[id].mediaSegments.push(data);
      }
      orderedMediaSegs.push({ trackId: id, data });
    };

    // Feed the entire file to mp4box
    const buf = fileBuffer.slice(0);
    buf.fileStart = 0;

    try {
      mp4boxFile.appendBuffer(buf);
    } catch (err) {
      reject(new UnsupportedVideoFormatError('無法解析此影片檔案：' + (err?.message || err)));
      return;
    }

    mp4boxFile.flush();

    // Give mp4box a moment to process all segments
    setTimeout(() => {
      try {
        // Build tracks array in order
        const tracks = trackOrder.map(tid => trackMap[tid]).filter(t => t && t.initSegment);

        if (tracks.length === 0) {
          reject(new UnsupportedVideoFormatError('影片轉檔失敗：無法產生有效的分片格式'));
          return;
        }

        // Build trackId → trackIndex mapping
        const tidToIndex = {};
        for (let i = 0; i < trackOrder.length; i++) {
          tidToIndex[trackOrder[i]] = i;
        }

        // Build flat segments array for upload:
        // First: init segments (one per track, in track order)
        // Then: media segments in the order mp4box.js fired them
        const segments = [];

        for (let i = 0; i < tracks.length; i++) {
          segments.push({ trackIndex: i, data: tracks[i].initSegment });
        }

        for (const ms of orderedMediaSegs) {
          const idx = tidToIndex[ms.trackId];
          if (idx !== undefined) {
            segments.push({ trackIndex: idx, data: ms.data });
          }
        }

        const outputName = name.replace(/\.(mov|m4v|qt)$/i, '.mp4');
        onProgress?.({ percent: 100 });
        resolve({ tracks, segments, contentType: 'video/mp4', remuxed: true, name: outputName });
      } catch (err) {
        reject(new Error('影片重封裝失敗：' + (err?.message || err)));
      }
    }, 50);
  });
}
