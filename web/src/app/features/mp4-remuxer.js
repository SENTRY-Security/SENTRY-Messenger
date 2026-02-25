// /app/features/mp4-remuxer.js
// Remux non-fragmented MP4/MOV to fragmented MP4 (fMP4) using mp4box.js.
// Dynamically loads mp4box.js from CDN on first use. Pure JS, no WASM required.
// Returns individual fMP4 segments (init + media) for MSE-compatible chunked upload.

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
  if (type === 'video/webm') return true; // WebM doesn't need remux, passes through
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

/**
 * Parse top-level MP4 boxes and split an already-fragmented MP4 into
 * an init segment (ftyp + moov) and media segments (each moof + mdat pair).
 *
 * This allows the chunked upload to store each fMP4 segment as a separate
 * encrypted chunk, so MSE SourceBuffer can append them directly.
 *
 * @param {Uint8Array} u8 - The fMP4 file bytes
 * @returns {{ initSegment: Uint8Array, mediaSegments: Uint8Array[] }}
 */
function splitFragmentedMp4(u8) {
  const initParts = []; // ftyp, moov, styp, etc. — everything before first moof
  const mediaSegments = [];
  let i = 0;
  let foundFirstMoof = false;
  let currentSegParts = [];

  while (i < u8.length - 7) {
    let boxSize = readU32(u8, i);
    const boxType = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);

    // Handle extended size (size == 1 means 64-bit size follows)
    let headerSize = 8;
    if (boxSize === 1 && i + 16 <= u8.length) {
      boxSize = readU64(u8, i + 8);
      headerSize = 16;
    }

    // Safety: if boxSize is 0 or invalid, stop parsing
    if (boxSize < headerSize || i + boxSize > u8.length) break;

    const boxData = u8.subarray(i, i + boxSize);

    if (boxType === 'moof') {
      foundFirstMoof = true;
      // If there's a pending segment, flush it
      if (currentSegParts.length > 0) {
        mediaSegments.push(concatU8(currentSegParts));
        currentSegParts = [];
      }
      currentSegParts.push(boxData);
    } else if (boxType === 'mdat') {
      if (foundFirstMoof) {
        // mdat belongs with the preceding moof
        currentSegParts.push(boxData);
        // Flush this moof+mdat as one media segment
        mediaSegments.push(concatU8(currentSegParts));
        currentSegParts = [];
      } else {
        // mdat before any moof — include in init
        initParts.push(boxData);
      }
    } else if (!foundFirstMoof) {
      // ftyp, moov, free, styp, etc. — part of init
      initParts.push(boxData);
    } else {
      // Other boxes after first moof (styp between segments, etc.)
      // Include with the next moof segment
      currentSegParts.push(boxData);
    }

    i += boxSize;
  }

  // Flush any remaining segment
  if (currentSegParts.length > 0) {
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
 * Remux a video File/Blob to fragmented MP4 using mp4box.js.
 *
 * Returns individual fMP4 segments for MSE-compatible chunked upload.
 * - segments[0] = init segment (ftyp + moov)
 * - segments[1..N] = media segments (moof + mdat pairs)
 *
 * Each segment can be independently appended to MSE SourceBuffer.
 *
 * For WebM files, returns null segments (WebM uses byte-range chunking).
 * For already-fragmented MP4, splits at moof boundaries.
 * For non-fragmented MP4/MOV, remuxes via mp4box.js.
 *
 * @param {File|Blob} file - Source video file
 * @returns {Promise<{
 *   segments: Uint8Array[]|null,
 *   contentType: string,
 *   remuxed: boolean,
 *   name: string
 * }>}
 */
export async function remuxToFragmentedMp4(file) {
  if (!file) throw new Error('file required');

  const type = (typeof file.type === 'string' ? file.type : '').toLowerCase().trim();
  const name = typeof file.name === 'string' ? file.name : 'video.mp4';

  // WebM doesn't need remuxing — natively MSE-compatible.
  // Return null segments to signal that byte-range chunking should be used.
  if (type === 'video/webm') {
    return { segments: null, contentType: 'video/webm', remuxed: false, name };
  }

  // Check if this is a remuxable type
  if (!REMUXABLE_TYPES.has(type)) {
    if (type.startsWith('video/')) {
      throw new UnsupportedVideoFormatError(`不支援此影片格式：${type}`);
    }
    return { segments: null, contentType: type || 'application/octet-stream', remuxed: false, name };
  }

  // Read file to check if already fragmented
  const fileBuffer = await file.arrayBuffer();
  const fileU8 = new Uint8Array(fileBuffer);

  if (isAlreadyFragmented(fileU8)) {
    // Already fMP4 — split at moof boundaries
    const { initSegment, mediaSegments } = splitFragmentedMp4(fileU8);
    if (!initSegment.byteLength || mediaSegments.length === 0) {
      throw new UnsupportedVideoFormatError('已分片的影片格式無法正確解析');
    }
    const segments = [initSegment, ...mediaSegments];
    return { segments, contentType: 'video/mp4', remuxed: false, name };
  }

  // Need to remux: load mp4box.js and fragment the file
  const mp4boxMod = await loadMp4box();
  const MP4Box = mp4boxMod.default || mp4boxMod.createFile || mp4boxMod;
  const createFile = typeof MP4Box.createFile === 'function' ? MP4Box.createFile : MP4Box;

  return new Promise((resolve, reject) => {
    let mp4boxFile;
    try {
      mp4boxFile = typeof createFile === 'function' ? createFile() : new createFile();
    } catch {
      try {
        mp4boxFile = MP4Box.createFile();
      } catch (err2) {
        reject(new Error('mp4box.js 初始化失敗：' + (err2?.message || err2)));
        return;
      }
    }

    const initSegments = [];
    const mediaSegments = [];

    mp4boxFile.onError = (err) => {
      reject(new Error('影片解析失敗：' + (err?.message || err || 'unknown mp4box error')));
    };

    mp4boxFile.onReady = (info) => {
      if (!info || !info.tracks || info.tracks.length === 0) {
        reject(new UnsupportedVideoFormatError('影片不包含任何可播放的音視訊軌道'));
        return;
      }

      for (const track of info.tracks) {
        // nbSamples controls how many samples per segment.
        // Lower = more segments but better streaming granularity.
        // Higher = fewer segments but each can be large.
        // 100 samples ≈ ~3-4 seconds at 30fps, good balance.
        mp4boxFile.setSegmentOptions(track.id, null, {
          nbSamples: 100
        });
      }

      const initSegs = mp4boxFile.initializeSegmentation();
      for (const seg of initSegs) {
        initSegments.push(new Uint8Array(seg.buffer));
      }

      mp4boxFile.start();
    };

    mp4boxFile.onSegment = (_id, _user, buffer, _sampleNum, _isLast) => {
      mediaSegments.push(new Uint8Array(buffer));
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
        if (initSegments.length === 0 || mediaSegments.length === 0) {
          reject(new UnsupportedVideoFormatError('影片轉檔失敗：無法產生有效的分片格式'));
          return;
        }

        // Combine all init segments into one (typically one per track)
        const initSegment = concatU8(initSegments);
        // Each media segment from mp4box is already a complete moof+mdat
        const segments = [initSegment, ...mediaSegments];

        const outputName = name.replace(/\.(mov|m4v|qt)$/i, '.mp4');
        resolve({ segments, contentType: 'video/mp4', remuxed: true, name: outputName });
      } catch (err) {
        reject(new Error('影片重封裝失敗：' + (err?.message || err)));
      }
    }, 50);
  });
}
