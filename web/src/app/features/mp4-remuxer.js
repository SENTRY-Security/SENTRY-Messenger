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

  // Read file into memory
  onProgress?.({ percent: 0 });
  const fileBuffer = await file.arrayBuffer();
  const fileU8 = new Uint8Array(fileBuffer);
  onProgress?.({ percent: 30 });

  if (isAlreadyFragmented(fileU8)) {
    // Already-fragmented MP4 — split at moof boundaries.
    // Works for both single-track and multi-track: the init segment contains
    // the full moov with all track descriptions, and each moof+mdat pair
    // references a specific track_ID that the browser demuxes internally.
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
    let trackOrder = [];
    const orderedMediaSegs = [];

    mp4boxFile.onError = (err) => {
      reject(new Error('影片解析失敗：' + (err?.message || err || 'unknown mp4box error')));
    };

    mp4boxFile.onReady = (info) => {
      if (!info || !info.tracks || info.tracks.length === 0) {
        reject(new UnsupportedVideoFormatError('影片不包含任何可播放的音視訊軌道'));
        return;
      }

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

    // mp4box.js processes synchronously in appendBuffer/flush, but use
    // a short delay as a safety net for any async callback scheduling.
    setTimeout(() => {
      try {
        const perTrackData = trackOrder.map(tid => trackMap[tid]).filter(t => t && t.initSegment);

        if (perTrackData.length === 0) {
          reject(new UnsupportedVideoFormatError('影片轉檔失敗：無法產生有效的分片格式'));
          return;
        }

        // Merge per-track init segments into one combined muxed init segment.
        // Single-track: pass-through. Multi-track: merge moov traks.
        const combinedInit = perTrackData.length === 1
          ? perTrackData[0].initSegment
          : mergeInitSegments(perTrackData.map(t => t.initSegment));

        // Combine codec strings: e.g. 'avc1.64001E,mp4a.40.2'
        const combinedCodec = perTrackData.map(t => t.codec).filter(Boolean).join(',') || null;

        // All media segments in the order mp4box.js fired them
        const allMediaSegs = orderedMediaSegs.map(ms => ms.data);

        const muxedTrack = {
          type: 'muxed',
          codec: combinedCodec,
          initSegment: combinedInit,
          mediaSegments: allMediaSegs
        };

        // Build flat segments array for upload:
        // [combined-init, mediaSeg1, mediaSeg2, ...]
        const segments = [
          { trackIndex: 0, data: combinedInit },
          ...allMediaSegs.map(data => ({ trackIndex: 0, data }))
        ];

        const outputName = name.replace(/\.(mov|m4v|qt)$/i, '.mp4');
        onProgress?.({ percent: 100 });
        resolve({ tracks: [muxedTrack], segments, contentType: 'video/mp4', remuxed: true, name: outputName });
      } catch (err) {
        reject(new Error('影片重封裝失敗：' + (err?.message || err)));
      }
    }, 50);
  });
}
