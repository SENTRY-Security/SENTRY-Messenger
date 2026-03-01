// /app/features/mp4-remuxer.js
// Remux non-fragmented MP4/MOV to fragmented MP4 (fMP4) using mp4box.js.
// Dynamically loads mp4box.js from CDN on first use. Pure JS, no WASM required.
//
// ALWAYS returns MUXED single-track output so downstream code can use a single
// MSE SourceBuffer and blob-URL fallback (concatenation = valid fMP4).

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
export function isAlreadyFragmented(u8) {
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

// ─── File-based box reading (avoids loading entire file into memory) ───

/**
 * Read a top-level MP4 box header from a File/Blob at the given byte offset.
 * Returns { type, size, headerSize } or null if invalid/EOF.
 * Only reads up to 16 bytes — does NOT load the box body.
 */
async function readBoxHeaderFromFile(file, offset) {
  if (offset + 8 > file.size) return null;
  const hdrBuf = new Uint8Array(
    await file.slice(offset, Math.min(offset + 16, file.size)).arrayBuffer()
  );
  if (hdrBuf.length < 8) return null;
  let size = readU32(hdrBuf, 0);
  const type = String.fromCharCode(hdrBuf[4], hdrBuf[5], hdrBuf[6], hdrBuf[7]);
  let headerSize = 8;
  if (size === 1) {
    if (hdrBuf.length < 16) return null;
    size = readU64(hdrBuf, 8);
    headerSize = 16;
  }
  if (size < headerSize) return null;
  return { type, size, headerSize };
}

/**
 * Count moof boxes in a File/Blob by scanning box headers without loading
 * the file into memory. Each call reads only up to 16 bytes per top-level box.
 *
 * @param {File|Blob} file
 * @returns {Promise<number>}
 */
export async function countMoofBoxesFromFile(file) {
  let count = 0;
  let offset = 0;
  while (offset < file.size) {
    const hdr = await readBoxHeaderFromFile(file, offset);
    if (!hdr || offset + hdr.size > file.size) break;
    if (hdr.type === 'moof') count++;
    offset += hdr.size;
  }
  return count;
}

/**
 * Async generator that yields fMP4 segments from a File/Blob without loading
 * the entire file into memory. First yield is the init segment (ftyp + moov),
 * then each media segment (moof + mdat pair).
 *
 * Only one segment's worth of data is in memory at a time — the caller should
 * process (encrypt + upload) each segment before resuming the generator.
 *
 * @param {File|Blob} file
 * @yields {{ trackIndex: number, data: Uint8Array }}
 */
export async function* iterateFragmentedSegmentsFromFile(file) {
  const initParts = [];
  let offset = 0;
  let foundFirstMoof = false;
  let currentSegParts = [];
  let currentHasMoof = false;

  while (offset < file.size) {
    const hdr = await readBoxHeaderFromFile(file, offset);
    if (!hdr || offset + hdr.size > file.size) break;

    const boxType = hdr.type;
    const boxData = new Uint8Array(
      await file.slice(offset, offset + hdr.size).arrayBuffer()
    );

    if (!foundFirstMoof) {
      if (boxType === 'moof') {
        foundFirstMoof = true;
        if (initParts.length > 0) {
          yield { trackIndex: 0, data: concatU8(initParts) };
          initParts.length = 0;
        }
        currentSegParts.push(boxData);
        currentHasMoof = true;
      } else {
        initParts.push(boxData);
      }
    } else if (boxType === 'moof') {
      if (currentSegParts.length > 0 && currentHasMoof) {
        yield { trackIndex: 0, data: concatU8(currentSegParts) };
        currentSegParts = [];
        currentHasMoof = false;
      }
      currentSegParts.push(boxData);
      currentHasMoof = true;
    } else if (boxType === 'mdat') {
      currentSegParts.push(boxData);
      if (currentHasMoof) {
        yield { trackIndex: 0, data: concatU8(currentSegParts) };
        currentSegParts = [];
        currentHasMoof = false;
      }
    } else if (SEGMENT_PREFIX_TYPES.has(boxType)) {
      currentSegParts.push(boxData);
    } else if (TRAILING_BOX_TYPES.has(boxType)) {
      // discard trailing non-media boxes
    } else {
      if (currentHasMoof) {
        currentSegParts.push(boxData);
      }
    }

    offset += hdr.size;
  }

  if (currentSegParts.length > 0 && currentHasMoof) {
    yield { trackIndex: 0, data: concatU8(currentSegParts) };
  }
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

/**
 * Parse immediate child boxes inside a parent box.
 * @param {Uint8Array} parentData - The full parent box bytes (including header)
 * @param {number} headerSize - Size of parent's header (8 or 16)
 */
function parseChildBoxes(parentData, headerSize) {
  const children = [];
  let i = headerSize;
  while (i < parentData.length - 7) {
    let boxSize = readU32(parentData, i);
    const boxType = String.fromCharCode(parentData[i + 4], parentData[i + 5], parentData[i + 6], parentData[i + 7]);
    let hdr = 8;
    if (boxSize === 1 && i + 16 <= parentData.length) {
      boxSize = readU64(parentData, i + 8);
      hdr = 16;
    }
    if (boxSize < hdr || i + boxSize > parentData.length) break;
    children.push({ type: boxType, data: parentData.subarray(i, i + boxSize) });
    i += boxSize;
  }
  return children;
}

/**
 * Build an MP4 box from type + body content.
 */
function buildBox(type, body) {
  const size = 8 + body.byteLength;
  const box = new Uint8Array(size);
  box[0] = (size >>> 24) & 0xff;
  box[1] = (size >>> 16) & 0xff;
  box[2] = (size >>> 8) & 0xff;
  box[3] = size & 0xff;
  box[4] = type.charCodeAt(0);
  box[5] = type.charCodeAt(1);
  box[6] = type.charCodeAt(2);
  box[7] = type.charCodeAt(3);
  box.set(body, 8);
  return box;
}

/**
 * Merge multiple per-track init segments into one combined init segment.
 * Each input init segment has its own ftyp + moov (with one trak).
 * Output has one ftyp + one moov (with all traks + merged mvex).
 *
 * Exported so the download side can merge old multi-track manifests.
 */
export function mergeInitSegments(initSegments) {
  if (!initSegments || initSegments.length === 0) return new Uint8Array(0);
  if (initSegments.length === 1) return initSegments[0];

  let ftyp = null;
  let mvhd = null;
  const traks = [];
  const trexes = [];

  for (const initSeg of initSegments) {
    const topBoxes = parseTopLevelBoxes(initSeg);
    for (const box of topBoxes) {
      if (box.type === 'ftyp' && !ftyp) {
        ftyp = box.data;
      }
      if (box.type === 'moov') {
        const moovChildren = parseChildBoxes(box.data, 8);
        for (const child of moovChildren) {
          if (child.type === 'mvhd' && !mvhd) {
            mvhd = child.data;
          }
          if (child.type === 'trak') {
            traks.push(child.data);
          }
          if (child.type === 'mvex') {
            const mvexChildren = parseChildBoxes(child.data, 8);
            for (const mc of mvexChildren) {
              if (mc.type === 'trex') {
                trexes.push(mc.data);
              }
            }
          }
        }
      }
    }
  }

  // Build combined moov: mvhd + all traks + mvex(all trex)
  const moovParts = [];
  if (mvhd) moovParts.push(mvhd);
  for (const trak of traks) moovParts.push(trak);
  if (trexes.length > 0) {
    moovParts.push(buildBox('mvex', concatU8(trexes)));
  }
  const moov = buildBox('moov', concatU8(moovParts));

  return concatU8([ftyp || new Uint8Array(0), moov]);
}

// Boxes that appear between segments but belong WITH the next moof+mdat pair
const SEGMENT_PREFIX_TYPES = new Set(['styp', 'sidx', 'ssix', 'prft']);
// Boxes at the end of the file that are NOT valid media segments
const TRAILING_BOX_TYPES = new Set(['mfra', 'mfro', 'free', 'skip', 'wide']);

/**
 * Split an already-fragmented MP4 into init segment (ftyp + moov) and
 * media segments (each moof + mdat pair).
 *
 * Works for both single-track and multi-track fMP4. For multi-track, each
 * moof+mdat pair references a specific track_ID in the moov — the browser's
 * MSE implementation handles demuxing internally when using a muxed SourceBuffer.
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
      if (boxType === 'moof') {
        foundFirstMoof = true;
        currentSegParts.push(boxData);
        currentHasMoof = true;
      } else {
        initParts.push(boxData);
      }
    } else if (boxType === 'moof') {
      if (currentSegParts.length > 0 && currentHasMoof) {
        mediaSegments.push(concatU8(currentSegParts));
        currentSegParts = [];
        currentHasMoof = false;
      }
      currentSegParts.push(boxData);
      currentHasMoof = true;
    } else if (boxType === 'mdat') {
      currentSegParts.push(boxData);
      if (currentHasMoof) {
        mediaSegments.push(concatU8(currentSegParts));
        currentSegParts = [];
        currentHasMoof = false;
      }
    } else if (SEGMENT_PREFIX_TYPES.has(boxType)) {
      currentSegParts.push(boxData);
    } else if (TRAILING_BOX_TYPES.has(boxType)) {
      // discard trailing non-media boxes
    } else {
      if (currentHasMoof) {
        currentSegParts.push(boxData);
      }
    }

    i += boxSize;
  }

  if (currentSegParts.length > 0 && currentHasMoof) {
    mediaSegments.push(concatU8(currentSegParts));
  }

  const initSegment = concatU8(initParts);
  return { initSegment, mediaSegments };
}

/**
 * Count moof boxes in a fragmented MP4 without extracting segment data.
 * Returns the number of media segments (each moof+mdat pair = 1 segment).
 * Total chunk count for upload = 1 (init) + countMoofBoxes(u8).
 *
 * @param {Uint8Array} u8
 * @returns {number}
 */
export function countMoofBoxes(u8) {
  let count = 0;
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
    if (boxType === 'moof') count++;
    i += boxSize;
  }
  return count;
}

/**
 * Generator that yields segments from a fragmented MP4 one at a time.
 * First yield is the init segment (ftyp + moov), then each media segment
 * (moof + mdat pair). Only one segment copy exists in memory at a time —
 * the caller should process (encrypt + upload) each segment before resuming.
 *
 * The file buffer (u8) must remain valid for the lifetime of the generator.
 *
 * @param {Uint8Array} u8 - The fMP4 file bytes
 * @yields {{ trackIndex: number, data: Uint8Array }}
 */
export function* iterateFragmentedSegments(u8) {
  const initParts = [];
  let i = 0;
  let foundFirstMoof = false;
  let currentSegParts = [];
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
      if (boxType === 'moof') {
        foundFirstMoof = true;
        // Yield init segment before first media segment
        if (initParts.length > 0) {
          yield { trackIndex: 0, data: concatU8(initParts) };
          initParts.length = 0;
        }
        currentSegParts.push(boxData);
        currentHasMoof = true;
      } else {
        initParts.push(boxData);
      }
    } else if (boxType === 'moof') {
      if (currentSegParts.length > 0 && currentHasMoof) {
        yield { trackIndex: 0, data: concatU8(currentSegParts) };
        currentSegParts = [];
        currentHasMoof = false;
      }
      currentSegParts.push(boxData);
      currentHasMoof = true;
    } else if (boxType === 'mdat') {
      currentSegParts.push(boxData);
      if (currentHasMoof) {
        yield { trackIndex: 0, data: concatU8(currentSegParts) };
        currentSegParts = [];
        currentHasMoof = false;
      }
    } else if (SEGMENT_PREFIX_TYPES.has(boxType)) {
      currentSegParts.push(boxData);
    } else if (TRAILING_BOX_TYPES.has(boxType)) {
      // discard trailing non-media boxes
    } else {
      if (currentHasMoof) {
        currentSegParts.push(boxData);
      }
    }

    i += boxSize;
  }

  // Flush last segment
  if (currentSegParts.length > 0 && currentHasMoof) {
    yield { trackIndex: 0, data: concatU8(currentSegParts) };
  }
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
 * ALWAYS returns MUXED single-track output:
 * - tracks[0] = { type: 'muxed', codec, initSegment, mediaSegments[] }
 * - segments[] = [{ trackIndex: 0, data: initSegment }, { trackIndex: 0, data: mediaSeg1 }, ...]
 *
 * This means the download side always uses a single MSE SourceBuffer,
 * and blob-URL fallback (simple concatenation) always produces a valid fMP4.
 *
 * For WebM files, returns null tracks (WebM uses byte-range chunking).
 * For already-fragmented MP4, splits at moof boundaries (works for single & multi-track).
 * For non-fragmented MP4/MOV, remuxes via mp4box.js then merges into muxed output.
 *
 * @param {File|Blob} file - Source video file
 * @param {{ onProgress?: (p: {percent: number}) => void }} [opts]
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

  // Peek at first 64KB to check if already fragmented — avoids loading the full file.
  onProgress?.({ percent: 0 });
  const peekBuf = new Uint8Array(
    await file.slice(0, Math.min(65536, file.size)).arrayBuffer()
  );
  onProgress?.({ percent: 10 });

  if (isAlreadyFragmented(peekBuf)) {
    // Already-fragmented MP4 — read boxes from file via file.slice() instead
    // of loading the entire file. Each segment is wrapped in a Blob immediately
    // to avoid accumulating ~582MB of Uint8Arrays in heap.
    const segments = [];
    let initSegment = null;
    for await (const seg of iterateFragmentedSegmentsFromFile(file)) {
      if (!initSegment) {
        // First segment is the init segment — keep as Uint8Array (tiny, <1KB)
        initSegment = seg.data;
        segments.push(seg);
      } else {
        const size = seg.data.byteLength;
        segments.push({ trackIndex: seg.trackIndex, blob: new Blob([seg.data]), size, data: null });
      }
    }
    if (segments.length < 2 || !initSegment?.byteLength) {
      throw new UnsupportedVideoFormatError('已分片的影片格式無法正確解析');
    }
    const track = { type: 'muxed', codec: null, initSegment, mediaSegments: null };
    onProgress?.({ percent: 100 });
    return { tracks: [track], segments, contentType: 'video/mp4', remuxed: false, name };
  }

  // Need to remux: load mp4box.js and fragment the file
  onProgress?.({ percent: 20 });
  const mp4boxMod = await loadMp4box();
  onProgress?.({ percent: 30 });
  const MP4Box = mp4boxMod.default || mp4boxMod.createFile || mp4boxMod;
  const createFileFn = typeof MP4Box.createFile === 'function' ? MP4Box.createFile : MP4Box;

  let mp4boxFile;
  try {
    mp4boxFile = typeof createFileFn === 'function' ? createFileFn() : new createFileFn();
  } catch {
    try {
      mp4boxFile = MP4Box.createFile();
    } catch (err2) {
      throw new Error('mp4box.js 初始化失敗：' + (err2?.message || err2));
    }
  }

  // Per-track state: trackId → { type, codec, initSegment }
  const trackMap = {};
  let trackOrder = [];
  const orderedMediaSegs = [];
  let mp4boxError = null;
  let readyFired = false;

  mp4boxFile.onError = (err) => {
    mp4boxError = new Error('影片解析失敗：' + (err?.message || err || 'unknown mp4box error'));
  };

  mp4boxFile.onReady = (info) => {
    if (!info || !info.tracks || info.tracks.length === 0) {
      mp4boxError = new UnsupportedVideoFormatError('影片不包含任何可播放的音視訊軌道');
      return;
    }

    const avTracks = info.tracks.filter(t => {
      const tt = getTrackType(t);
      return tt === 'video' || tt === 'audio';
    });

    if (avTracks.length === 0) {
      mp4boxError = new UnsupportedVideoFormatError('影片不包含任何可播放的音視訊軌道');
      return;
    }

    trackOrder = avTracks.map(t => t.id);

    for (const track of avTracks) {
      const trackType = getTrackType(track);
      trackMap[track.id] = {
        type: trackType,
        codec: track.codec || null,
        initSegment: null,
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
    readyFired = true;
  };

  mp4boxFile.onSegment = (id, _user, buffer, _sampleNum, _isLast) => {
    // Wrap segment data in a Blob immediately so the ArrayBuffer can be GC'd.
    // Without this, orderedMediaSegs accumulates ~582MB of Uint8Arrays in heap,
    // exceeding iOS Safari's jetsam limit (~300-450MB) and crashing the tab.
    // Each segment is ~5MB; the Blob constructor copies the data and the browser
    // may store it on disk or in low-priority cache.
    const u8 = new Uint8Array(buffer);
    const size = u8.byteLength;
    orderedMediaSegs.push({ trackId: id, blob: new Blob([u8]), size });
  };

  // Feed file to mp4box in 2MB chunks via file.slice() — avoids loading entire
  // file into memory. mp4box.js supports incremental appendBuffer with fileStart.
  const READ_CHUNK_SIZE = 2 * 1024 * 1024;
  let readOffset = 0;
  try {
    while (readOffset < file.size) {
      if (mp4boxError) break;
      const end = Math.min(readOffset + READ_CHUNK_SIZE, file.size);
      const chunk = await file.slice(readOffset, end).arrayBuffer();
      chunk.fileStart = readOffset;
      mp4boxFile.appendBuffer(chunk);
      readOffset = end;
      // Report progress: 30–70% range for feeding data to mp4box
      onProgress?.({ percent: 30 + Math.round((readOffset / file.size) * 40) });
    }
  } catch (err) {
    throw new UnsupportedVideoFormatError('無法解析此影片檔案：' + (err?.message || err));
  }

  if (mp4boxError) throw mp4boxError;

  mp4boxFile.flush();

  if (mp4boxError) throw mp4boxError;

  if (!readyFired) {
    throw new UnsupportedVideoFormatError('影片不包含任何可播放的音視訊軌道');
  }

  // Build result
  const perTrackData = trackOrder.map(tid => trackMap[tid]).filter(t => t && t.initSegment);

  if (perTrackData.length === 0) {
    throw new UnsupportedVideoFormatError('影片轉檔失敗：無法產生有效的分片格式');
  }

  // Merge per-track init segments into one combined muxed init segment.
  // Single-track: pass-through. Multi-track: merge moov traks.
  const combinedInit = perTrackData.length === 1
    ? perTrackData[0].initSegment
    : mergeInitSegments(perTrackData.map(t => t.initSegment));

  // Combine codec strings: e.g. 'avc1.64001E,mp4a.40.2'
  const combinedCodec = perTrackData.map(t => t.codec).filter(Boolean).join(',') || null;

  // Release per-track data — no longer needed after merging
  for (const tid of trackOrder) {
    if (trackMap[tid]) {
      trackMap[tid].initSegment = null;
      trackMap[tid] = null;
    }
  }

  // Build flat segments array for upload:
  // [combined-init, mediaSeg1, mediaSeg2, ...]
  // Media segments are already Blobs (from onSegment), init stays as Uint8Array (tiny).
  const segments = [
    { trackIndex: 0, data: combinedInit },
    ...orderedMediaSegs.map(ms => ({ trackIndex: 0, blob: ms.blob, size: ms.size, data: null }))
  ];

  // Release orderedMediaSegs — blob references now live in segments array
  orderedMediaSegs.length = 0;

  const muxedTrack = {
    type: 'muxed',
    codec: combinedCodec,
    initSegment: combinedInit,
    mediaSegments: null // Not needed — segments array is the canonical source
  };

  const outputName = name.replace(/\.(mov|m4v|qt)$/i, '.mp4');
  onProgress?.({ percent: 100 });
  return { tracks: [muxedTrack], segments, contentType: 'video/mp4', remuxed: true, name: outputName };
}
