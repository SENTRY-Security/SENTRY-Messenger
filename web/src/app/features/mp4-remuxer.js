// /app/features/mp4-remuxer.js
// Remux non-fragmented MP4/MOV to fragmented MP4 (fMP4) using mp4box.js.
// Dynamically loads mp4box.js from CDN on first use. Pure JS, no WASM required.
// Returns individual fMP4 segments (init + media) for MSE-compatible chunked upload.
//
// IMPORTANT: mp4box.js produces per-track init segments and per-track media segments.
// For MSE playback with a single SourceBuffer, we must:
//   1. Merge per-track init segments into one valid init segment (ftyp + combined moov)
//   2. Pair per-track media segments by ordinal and concatenate into multiplexed segments

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
 * Write a big-endian uint32 into data at the given offset.
 */
function writeU32(data, offset, value) {
  data[offset] = (value >>> 24) & 0xFF;
  data[offset + 1] = (value >>> 16) & 0xFF;
  data[offset + 2] = (value >>> 8) & 0xFF;
  data[offset + 3] = value & 0xFF;
}

// ─── MP4 Box Parsing Helpers ───

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

/**
 * Parse child boxes within a container box (e.g. moov, mvex).
 * Skips the 8-byte box header of the parent to parse children.
 */
function parseChildBoxes(parentData) {
  if (!parentData || parentData.length < 8) return [];
  // Children start after the parent's 8-byte header (size + type)
  const inner = parentData.subarray(8);
  return parseTopLevelBoxes(inner);
}

/**
 * Build an MP4 container box from type string and array of child Uint8Arrays.
 */
function buildContainerBox(type, childDataArrays) {
  let contentLen = 0;
  for (const c of childDataArrays) contentLen += c.byteLength;
  const totalSize = 8 + contentLen;
  const out = new Uint8Array(totalSize);
  writeU32(out, 0, totalSize);
  const te = new TextEncoder();
  const typeBytes = te.encode(type);
  out.set(typeBytes.subarray(0, 4), 4);
  let offset = 8;
  for (const c of childDataArrays) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// ─── Init Segment Merging ───

/**
 * Merge per-track init segments from mp4box.js into a single valid init segment.
 *
 * mp4box.js initializeSegmentation() returns one init segment per track, each with
 * its own ftyp + moov (containing a single trak). For MSE with a single SourceBuffer,
 * we need one init segment with one ftyp and one moov containing ALL trak atoms.
 *
 * Strategy:
 * - Take ftyp from the first init segment
 * - From each init segment's moov, extract: trak, and trex (from mvex)
 * - From the first moov, take mvhd and any other non-trak/non-mvex children
 * - Rebuild moov = mvhd + other children + all traks + combined mvex
 *
 * @param {Uint8Array[]} initSegArrays - Per-track init segments from mp4box.js
 * @returns {Uint8Array} A single merged init segment
 */
function mergeInitSegments(initSegArrays) {
  if (!initSegArrays || initSegArrays.length === 0) return new Uint8Array(0);
  if (initSegArrays.length === 1) return initSegArrays[0];

  // Parse boxes from the first init segment to get ftyp
  const firstBoxes = parseTopLevelBoxes(initSegArrays[0]);
  const ftypBox = firstBoxes.find(b => b.type === 'ftyp');

  // Collect trak and trex from all init segments
  const allTraks = [];
  const allTrexes = [];
  let mvhdData = null;
  const otherMoovChildren = []; // non-trak, non-mvex children (e.g. udta)

  for (let idx = 0; idx < initSegArrays.length; idx++) {
    const boxes = parseTopLevelBoxes(initSegArrays[idx]);
    const moovBox = boxes.find(b => b.type === 'moov');
    if (!moovBox) continue;

    const moovChildren = parseChildBoxes(moovBox.data);

    for (const child of moovChildren) {
      if (child.type === 'trak') {
        allTraks.push(child.data);
      } else if (child.type === 'mvex') {
        // Extract trex boxes from mvex
        const mvexChildren = parseChildBoxes(child.data);
        for (const mc of mvexChildren) {
          if (mc.type === 'trex') {
            allTrexes.push(mc.data);
          }
        }
      } else if (child.type === 'mvhd') {
        if (!mvhdData) mvhdData = child.data;
      } else {
        // Only collect other children from first moov to avoid duplicates
        if (idx === 0) {
          otherMoovChildren.push(child.data);
        }
      }
    }
  }

  // Rebuild mvex with all trex boxes
  const mvexData = allTrexes.length > 0
    ? buildContainerBox('mvex', allTrexes)
    : null;

  // Rebuild moov: mvhd + other children + all traks + mvex
  const moovParts = [];
  if (mvhdData) moovParts.push(mvhdData);
  for (const other of otherMoovChildren) moovParts.push(other);
  for (const trak of allTraks) moovParts.push(trak);
  if (mvexData) moovParts.push(mvexData);

  const moovData = buildContainerBox('moov', moovParts);

  // Final init segment: ftyp + moov
  const parts = [];
  if (ftypBox) parts.push(ftypBox.data);
  parts.push(moovData);
  return concatU8(parts);
}

// ─── Existing Helpers ───

/**
 * Parse top-level MP4 boxes and split an already-fragmented MP4 into
 * an init segment (ftyp + moov) and media segments (each moof + mdat pair).
 *
 * @param {Uint8Array} u8 - The fMP4 file bytes
 * @returns {{ initSegment: Uint8Array, mediaSegments: Uint8Array[] }}
 */
function splitFragmentedMp4(u8) {
  const initParts = [];
  const mediaSegments = [];
  let i = 0;
  let foundFirstMoof = false;
  let currentSegParts = [];

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

    if (boxType === 'moof') {
      foundFirstMoof = true;
      if (currentSegParts.length > 0) {
        mediaSegments.push(concatU8(currentSegParts));
        currentSegParts = [];
      }
      currentSegParts.push(boxData);
    } else if (boxType === 'mdat') {
      if (foundFirstMoof) {
        currentSegParts.push(boxData);
        mediaSegments.push(concatU8(currentSegParts));
        currentSegParts = [];
      } else {
        initParts.push(boxData);
      }
    } else if (!foundFirstMoof) {
      initParts.push(boxData);
    } else {
      currentSegParts.push(boxData);
    }

    i += boxSize;
  }

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

// ─── Main Remux Function ───

/**
 * Remux a video File/Blob to fragmented MP4 using mp4box.js.
 *
 * Returns individual fMP4 segments for MSE-compatible chunked upload.
 * - segments[0] = init segment (ftyp + moov with ALL tracks)
 * - segments[1..N] = media segments (multiplexed moof+mdat for all tracks)
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

    const initSegments = [];
    const mediaSegments = [];

    // Multi-track segment merging state
    let trackIds = [];
    let numTracks = 0;
    const segCountByTrack = {}; // trackId → count of segments received so far
    const pendingByOrdinal = {}; // ordinal → { trackId: Uint8Array }
    let nextEmitOrdinal = 0;

    mp4boxFile.onError = (err) => {
      reject(new Error('影片解析失敗：' + (err?.message || err || 'unknown mp4box error')));
    };

    mp4boxFile.onReady = (info) => {
      if (!info || !info.tracks || info.tracks.length === 0) {
        reject(new UnsupportedVideoFormatError('影片不包含任何可播放的音視訊軌道'));
        return;
      }

      trackIds = info.tracks.map(t => t.id);
      numTracks = trackIds.length;
      for (const tid of trackIds) segCountByTrack[tid] = 0;

      for (const track of info.tracks) {
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

    mp4boxFile.onSegment = (id, _user, buffer, _sampleNum, _isLast) => {
      if (numTracks <= 1) {
        // Single track — no merging needed
        mediaSegments.push(new Uint8Array(buffer));
        return;
      }

      // Multi-track: buffer by ordinal and merge when all tracks have a segment
      const ordinal = segCountByTrack[id];
      segCountByTrack[id]++;

      if (!pendingByOrdinal[ordinal]) pendingByOrdinal[ordinal] = {};
      pendingByOrdinal[ordinal][id] = new Uint8Array(buffer);

      // Emit merged segments in order when all tracks are available
      while (
        pendingByOrdinal[nextEmitOrdinal] &&
        Object.keys(pendingByOrdinal[nextEmitOrdinal]).length === numTracks
      ) {
        const parts = trackIds.map(tid => pendingByOrdinal[nextEmitOrdinal][tid]);
        mediaSegments.push(concatU8(parts));
        delete pendingByOrdinal[nextEmitOrdinal];
        nextEmitOrdinal++;
      }
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
        // Flush remaining buffered segments (tail segments from unequal track counts)
        if (numTracks > 1) {
          const maxOrdinal = Math.max(...Object.values(segCountByTrack));
          for (let ord = nextEmitOrdinal; ord < maxOrdinal; ord++) {
            const pending = pendingByOrdinal[ord];
            if (!pending) continue;
            // Emit whatever segments are available for this ordinal
            const parts = [];
            for (const tid of trackIds) {
              if (pending[tid]) parts.push(pending[tid]);
            }
            if (parts.length > 0) {
              mediaSegments.push(concatU8(parts));
            }
            delete pendingByOrdinal[ord];
          }
        }

        if (initSegments.length === 0 || mediaSegments.length === 0) {
          reject(new UnsupportedVideoFormatError('影片轉檔失敗：無法產生有效的分片格式'));
          return;
        }

        // Merge per-track init segments into a single valid init segment
        const initSegment = mergeInitSegments(initSegments);

        const segments = [initSegment, ...mediaSegments];

        const outputName = name.replace(/\.(mov|m4v|qt)$/i, '.mp4');
        resolve({ segments, contentType: 'video/mp4', remuxed: true, name: outputName });
      } catch (err) {
        reject(new Error('影片重封裝失敗：' + (err?.message || err)));
      }
    }, 50);
  });
}
