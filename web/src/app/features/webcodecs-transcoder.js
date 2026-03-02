// /app/features/webcodecs-transcoder.js
// WebCodecs-based video transcoder for guaranteed MSE-compatible fMP4 output.
//
// Pipeline (streaming, frame-by-frame):
//   File → mp4box.js demux → VideoDecoder → VideoEncoder (H.264 Baseline)
//                           → AudioDecoder → AudioEncoder (AAC) or passthrough
//   → mp4box.js mux → fMP4 segments
//
// Smart path: if input is already H.264 + AAC, delegates to remux (no re-encode).
// Only transcodes when the input codec isn't MSE-compatible (e.g. HEVC, VP9).
//
// Progress callback reports two phases:
//   phase='load'   → WebCodecs capability check (instant, no WASM to load)
//   phase='encode' → streaming transcode progress (0-100%)

import { mergeInitSegments } from './mp4-remuxer.js';

const MP4BOX_CDN_URL = 'https://esm.sh/mp4box@0.5.3';

let _mp4boxModule = null;

async function loadMp4box() {
  if (_mp4boxModule) return _mp4boxModule;
  _mp4boxModule = await import(/* webpackIgnore: true */ MP4BOX_CDN_URL);
  return _mp4boxModule;
}

function createMp4boxFile(mp4boxMod) {
  const MP4Box = mp4boxMod.default || mp4boxMod.createFile || mp4boxMod;
  const createFileFn = typeof MP4Box.createFile === 'function' ? MP4Box.createFile : MP4Box;
  try {
    return typeof createFileFn === 'function' ? createFileFn() : new createFileFn();
  } catch {
    return MP4Box.createFile();
  }
}

// ─── WebCodecs support detection (cached) ───

let _supported = null;

export function isWebCodecsSupported() {
  if (_supported !== null) return _supported;
  _supported =
    typeof VideoDecoder === 'function' &&
    typeof VideoEncoder === 'function' &&
    typeof EncodedVideoChunk === 'function' &&
    typeof VideoFrame === 'function';
  return _supported;
}

// ─── Codec analysis ───

// Codecs that MSE can play directly (no transcode needed, just remux)
const MSE_SAFE_VIDEO = /^(avc1|avc3)/i;
const MSE_SAFE_AUDIO = /^(mp4a|opus)/i;

function needsTranscode(tracks) {
  let dominated = false;
  for (const t of tracks) {
    if (t._type === 'video') {
      if (!t.codec || !MSE_SAFE_VIDEO.test(t.codec)) dominated = true;
    }
    // Audio: AAC/Opus are fine; anything else needs transcode
    if (t._type === 'audio') {
      if (t.codec && !MSE_SAFE_AUDIO.test(t.codec)) dominated = true;
    }
  }
  return dominated;
}

/**
 * Check if video tracks exceed the given encoder constraints (resolution or bitrate).
 * Used to force re-encoding of H.264 videos that are too large for smooth MSE streaming.
 */
function exceedsConstraints(tracks, constraints) {
  if (!constraints) return false;
  for (const t of tracks) {
    if (t._type === 'video') {
      const w = t.video?.width || t.track_width || 0;
      const h = t.video?.height || t.track_height || 0;
      const bitrate = t.bitrate || 0;
      if (constraints.maxWidth && w > constraints.maxWidth) return true;
      if (constraints.maxHeight && h > constraints.maxHeight) return true;
      if (constraints.maxBitrate && bitrate > constraints.maxBitrate) return true;
    }
  }
  return false;
}

// ─── Rotation detection from tkhd matrix ───

/**
 * Extract rotation angle (0, 90, 180, 270) from mp4box.js track.matrix.
 * The matrix is a 3×3 column-major transform stored as 9 fixed-point values.
 * mp4box.js exposes them as regular numbers (already divided by 0x10000).
 */
function getTrackRotation(track) {
  const m = track.matrix;
  if (!m || !Array.isArray(m) || m.length < 6) return 0;
  // matrix layout: [a, b, u, c, d, v, tx, ty, w]
  // a = m[0], b = m[1], c = m[3], d = m[4]
  const a = m[0], b = m[1];
  const deg = Math.round(Math.atan2(b, a) * (180 / Math.PI));
  // Normalize to 0/90/180/270
  const normalized = ((deg % 360) + 360) % 360;
  if (normalized > 315 || normalized <= 45) return 0;
  if (normalized > 45 && normalized <= 135) return 90;
  if (normalized > 135 && normalized <= 225) return 180;
  return 270;
}

// ─── Build encoder configs from mp4box track info ───

function videoEncoderConfig(track, constraints = {}) {
  let codedW = track.video?.width || track.track_width || 640;
  let codedH = track.video?.height || track.track_height || 480;
  const rotation = getTrackRotation(track);
  const swap = rotation === 90 || rotation === 270;

  // Apply resolution constraints (for fallback retry with lower quality)
  if (constraints.maxWidth || constraints.maxHeight) {
    const maxW = constraints.maxWidth || Infinity;
    const maxH = constraints.maxHeight || Infinity;
    const scale = Math.min(1, maxW / codedW, maxH / codedH);
    if (scale < 1) {
      codedW = (Math.round(codedW * scale) >> 1) << 1; // round to even
      codedH = (Math.round(codedH * scale) >> 1) << 1;
    }
  }

  const baseBitrate = track.bitrate || 2_000_000;
  const maxBitrate = constraints.maxBitrate || 5_000_000;

  // Compute output dimensions (swap for 90°/270° rotation)
  const outW = swap ? codedH : codedW;
  const outH = swap ? codedW : codedH;

  // Select the minimum H.264 level that supports the output resolution.
  // Level 3.0 only handles 720×480 — using it for 1280×720 causes
  // "Encoding task failed" on iOS Safari because the hardware encoder
  // rejects the resolution/level mismatch.
  const macroblocks = Math.ceil(outW / 16) * Math.ceil(outH / 16);
  let avcLevel;
  if (macroblocks <= 1620)      avcLevel = '1E'; // Level 3.0: up to 720×480
  else if (macroblocks <= 3600) avcLevel = '1F'; // Level 3.1: up to 1280×720
  else if (macroblocks <= 5120) avcLevel = '20'; // Level 3.2: up to 1280×1024
  else if (macroblocks <= 8192) avcLevel = '28'; // Level 4.0: up to 1920×1080
  else                          avcLevel = '32'; // Level 5.0: up to 3672×1536

  // Target: H.264 Baseline for maximum MSE compatibility
  // If source has 90°/270° rotation, swap output dimensions so the
  // re-encoded video is already in display orientation (no matrix needed).
  return {
    codec: `avc1.4200${avcLevel}`, // Baseline profile, dynamic level
    width: outW,
    height: outH,
    bitrate: Math.min(baseBitrate, maxBitrate),
    framerate: track.video?.frame_rate || track.timescale / (track.samples_duration / track.nb_samples) || 30,
    latencyMode: 'quality',
    avc: { format: 'avc' }, // length-prefixed NALUs for mp4box muxing
    _rotation: rotation, // internal: used by streaming transcode
  };
}

function audioEncoderConfig(track) {
  return {
    codec: 'mp4a.40.2', // AAC-LC
    sampleRate: track.audio?.sample_rate || 44100,
    numberOfChannels: track.audio?.channel_count || 2,
    bitrate: 128_000,
  };
}

// ─── fMP4 segment builder using mp4box.js muxing API ───

function concatU8(arrays) {
  if (arrays.length === 0) return new Uint8Array(0);
  if (arrays.length === 1) return arrays[0];
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.byteLength; }
  return out;
}

// ─── Codec description extraction from mp4box internals ───
//
// mp4box.js's getInfo() does NOT copy codec config boxes (avcC, hvcC, esds)
// to the track info object. We must access them from the internal moov
// structure: trak → mdia → minf → stbl → stsd → entries[0].
//
// Additionally, mp4box.js 0.5.3 has NO write method for hvcC boxes,
// so we must manually serialize the HEVCDecoderConfigurationRecord.

/**
 * Extract the raw codec description for VideoDecoder.configure({ description }).
 * Accesses mp4box's internal moov to find avcC/hvcC boxes and serializes them.
 *
 * @param {object} mp4boxFile - the mp4box ISOFile instance (demuxer)
 * @param {number} trackId - the track ID
 * @returns {Uint8Array|undefined}
 */
function getCodecDescription(mp4boxFile, trackId) {
  try {
    const trak = mp4boxFile.getTrackById(trackId);
    if (!trak) return undefined;

    const entry = trak.mdia?.minf?.stbl?.stsd?.entries?.[0];
    if (!entry) return undefined;

    if (entry.avcC) return serializeAvcC(entry.avcC);
    if (entry.hvcC) return serializeHvcC(entry.hvcC);
    // For other codecs (VP9, AV1), try generic extractBoxData
    if (entry.vpcC) return extractBoxData(entry.vpcC);
    if (entry.av1C) return extractBoxData(entry.av1C);

    return undefined;
  } catch (err) {
    console.warn('[getCodecDescription] failed for track', trackId, err?.message);
    return undefined;
  }
}

/**
 * Extract the raw audio codec description (esds) from mp4box's internal moov.
 */
function getAudioDescription(mp4boxFile, trackId) {
  try {
    const trak = mp4boxFile.getTrackById(trackId);
    if (!trak) return undefined;

    const entry = trak.mdia?.minf?.stbl?.stsd?.entries?.[0];
    if (!entry?.esds) return undefined;

    return extractBoxData(entry.esds);
  } catch {
    return undefined;
  }
}

/** Manually serialize an AVCDecoderConfigurationRecord (avcC box content). */
function serializeAvcC(box) {
  const parts = [];
  parts.push(new Uint8Array([
    box.configurationVersion || 1,
    box.AVCProfileIndication || 0,
    box.profile_compatibility || 0,
    box.AVCLevelIndication || 0,
    0xFC | ((box.lengthSizeMinusOne ?? 3) & 0x03),
  ]));

  // SPS NALUs
  const spsList = box.SPS || [];
  parts.push(new Uint8Array([0xE0 | (spsList.length & 0x1F)]));
  for (const sps of spsList) {
    const data = sps.nalu || sps.data || sps;
    const len = data.length || data.byteLength;
    parts.push(new Uint8Array([(len >> 8) & 0xFF, len & 0xFF]));
    parts.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  // PPS NALUs
  const ppsList = box.PPS || [];
  parts.push(new Uint8Array([ppsList.length & 0xFF]));
  for (const pps of ppsList) {
    const data = pps.nalu || pps.data || pps;
    const len = data.length || data.byteLength;
    parts.push(new Uint8Array([(len >> 8) & 0xFF, len & 0xFF]));
    parts.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  return concatU8(parts);
}

/** Manually serialize an HEVCDecoderConfigurationRecord (hvcC box content).
 *  mp4box.js 0.5.3 has NO write method for hvcC, so we must do this ourselves. */
function serializeHvcC(box) {
  const parts = [];

  // Byte 0: configurationVersion
  // Byte 1: general_profile_space(2) | general_tier_flag(1) | general_profile_idc(5)
  parts.push(new Uint8Array([
    box.configurationVersion || 1,
    ((box.general_profile_space || 0) << 6) |
      ((box.general_tier_flag || 0) << 5) |
      ((box.general_profile_idc || 0) & 0x1F),
  ]));

  // Bytes 2-5: general_profile_compatibility (4 bytes, big-endian)
  const gpc = box.general_profile_compatibility || 0;
  parts.push(new Uint8Array([
    (gpc >>> 24) & 0xFF, (gpc >>> 16) & 0xFF,
    (gpc >>> 8) & 0xFF, gpc & 0xFF,
  ]));

  // Bytes 6-11: general_constraint_indicator (6 bytes)
  const gci = box.general_constraint_indicator;
  if (gci && gci.length >= 6) {
    parts.push(gci instanceof Uint8Array ? gci.slice(0, 6) : new Uint8Array(gci.slice(0, 6)));
  } else {
    parts.push(new Uint8Array(6));
  }

  // Bytes 12-22: remaining fixed fields
  const mss = box.min_spatial_segmentation_idc || 0;
  parts.push(new Uint8Array([
    box.general_level_idc || 0,                         // byte 12
    0xF0 | ((mss >> 8) & 0x0F),                         // byte 13 (4 reserved bits + upper 4 of mss)
    mss & 0xFF,                                          // byte 14
    0xFC | ((box.parallelismType || 0) & 0x03),          // byte 15
    0xFC | ((box.chroma_format_idc || 0) & 0x03),        // byte 16
    0xF8 | ((box.bit_depth_luma_minus8 || 0) & 0x07),    // byte 17
    0xF8 | ((box.bit_depth_chroma_minus8 || 0) & 0x07),  // byte 18
    ((box.avgFrameRate || 0) >> 8) & 0xFF,                // byte 19
    (box.avgFrameRate || 0) & 0xFF,                       // byte 20
    ((box.constantFrameRate || 0) << 6) |                 // byte 21
      (((box.numTemporalLayers || 0) & 0x07) << 3) |
      (((box.temporalIdNested || 0) & 0x01) << 2) |
      ((box.lengthSizeMinusOne ?? 3) & 0x03),
  ]));

  // NALU arrays
  const arrays = box.nalu_arrays || [];
  parts.push(new Uint8Array([arrays.length & 0xFF])); // byte 22: numOfArrays

  for (const arr of arrays) {
    parts.push(new Uint8Array([
      ((arr.completeness || 0) << 7) | ((arr.nalu_type || 0) & 0x3F),
    ]));
    const nalus = arr.nalus || [];
    parts.push(new Uint8Array([(nalus.length >> 8) & 0xFF, nalus.length & 0xFF]));
    for (const nalu of nalus) {
      const data = nalu.data;
      const len = nalu.length || data?.length || data?.byteLength || 0;
      parts.push(new Uint8Array([(len >> 8) & 0xFF, len & 0xFF]));
      if (data) parts.push(data instanceof Uint8Array ? data : new Uint8Array(data));
    }
  }

  return concatU8(parts);
}

// ─── Main transcode function ───

/**
 * Transcode a video file to MSE-compatible fMP4.
 *
 * Smart path: if the input is already H.264 + AAC, returns null to signal
 * the caller should use the existing remux path (no quality loss).
 *
 * @param {File|Blob} file
 * @param {{ onProgress?: (p: { phase: string, percent: number }) => void }} opts
 * @returns {Promise<{ segments, tracks, contentType } | null>}
 *   null = input already MSE-safe, use remux instead
 */
export async function transcodeToFmp4(file, { onProgress, encoderConstraints, onTranscodeStart, onSegment } = {}) {
  if (!file) throw new Error('file required');
  if (!isWebCodecsSupported()) return null; // fallback to remux

  onProgress?.({ phase: 'load', percent: 0 });

  // 1. Load mp4box.js (cached after first load)
  const mp4boxMod = await loadMp4box();
  onProgress?.({ phase: 'load', percent: 100 });

  // 2. Probe tracks FIRST (lightweight — only reads headers, no sample extraction).
  //    This avoids loading ~582MB of sample data just to discover the file is
  //    already H.264+AAC and doesn't need transcoding.
  onProgress?.({ phase: 'encode', percent: 0 });

  const probeResult = await probeFileTracks(file, mp4boxMod);

  if (probeResult.tracks.length === 0) {
    throw new Error('影片不包含可播放的音視訊軌道');
  }

  // 3. Check if transcoding is actually needed — BEFORE extracting samples
  const codecNeedsTranscode = needsTranscode(probeResult.tracks);
  const constraintsExceeded = exceedsConstraints(probeResult.tracks, encoderConstraints);

  if (!codecNeedsTranscode && !constraintsExceeded) {
    // Already MSE-safe AND within constraints → return null so caller uses fast remux path.
    // No samples were extracted, so memory usage stays near zero.
    return null;
  }

  // Notify caller that transcode is actually needed (for UI status updates).
  if (codecNeedsTranscode) {
    onTranscodeStart?.();
  } else if (constraintsExceeded) {
    // H.264 but exceeds size/bitrate constraints — force re-encode for smaller output
    const vt = probeResult.tracks.find(t => t._type === 'video');
    const w = vt?.video?.width || vt?.track_width || '?';
    const h = vt?.video?.height || vt?.track_height || '?';
    const br = vt?.bitrate ? `${(vt.bitrate / 1_000_000).toFixed(1)}Mbps` : '?';
    console.info(`[transcode] H.264 ${w}x${h} @ ${br} exceeds constraints — forcing re-encode to ${encoderConstraints.maxWidth}x${encoderConstraints.maxHeight} @ ${(encoderConstraints.maxBitrate / 1_000_000).toFixed(1)}Mbps`);
    onTranscodeStart?.();
  }

  // 4. Streaming transcode — processes samples incrementally to avoid loading
  //    the entire file into memory (critical for 500MB+ files on iOS Safari).
  //    Peak memory: ~current 2MB chunk + decoder/encoder pipeline + encoded output.
  //    When onSegment is provided, segments are emitted incrementally for
  //    immediate encrypt+upload instead of being collected in an array.
  const result = await streamingTranscode(file, mp4boxMod, onProgress, encoderConstraints, onSegment);
  return result;
}

/**
 * Probe a video file to determine if transcoding is needed and estimate segment count.
 * Lightweight — only reads file headers, no sample extraction.
 *
 * Used by chunked-upload.js to request presigned URLs BEFORE starting transcode,
 * enabling the streaming pipeline: transcode → encrypt → upload per-segment.
 *
 * @returns {{ needed: boolean, estimatedChunks?: number, tracks?: object[], duration?: number }}
 */
export async function probeTranscode(file, encoderConstraints) {
  if (!isWebCodecsSupported()) return { needed: false };

  const mp4boxMod = await loadMp4box();
  const probeResult = await probeFileTracks(file, mp4boxMod);
  if (probeResult.tracks.length === 0) {
    throw new Error('影片不包含可播放的音視訊軌道');
  }

  const codecNeeds = needsTranscode(probeResult.tracks);
  const constraintNeeds = exceedsConstraints(probeResult.tracks, encoderConstraints);
  if (!codecNeeds && !constraintNeeds) return { needed: false };

  const videoTrack = probeResult.tracks.find(t => t._type === 'video');
  const audioTrack = probeResult.tracks.find(t => t._type === 'audio');
  // Muxer uses nbSamples=100 per segment. Estimate total fMP4 segments:
  //   1 init + ceil(videoSamples/100) + ceil(audioSamples/100) + 2 buffer
  const videoSegs = Math.ceil((videoTrack?.nb_samples || 0) / 100);
  const audioSegs = audioTrack ? Math.ceil((audioTrack.nb_samples || 0) / 100) : 0;

  return {
    needed: true,
    estimatedChunks: 1 + videoSegs + audioSegs + 2,
    tracks: probeResult.tracks,
    duration: probeResult.duration,
  };
}

// ─── Lightweight probe: reads only headers to discover tracks (no samples) ───

function probeFileTracks(file, mp4boxMod) {
  return new Promise(async (resolve, reject) => {
    const mp4boxFile = createMp4boxFile(mp4boxMod);
    const tracks = [];
    let fileDuration = 0;

    mp4boxFile.onError = (err) => {
      reject(new Error('影片解析失敗：' + (err?.message || err)));
    };

    mp4boxFile.onReady = (info) => {
      fileDuration = (info.duration || 0) / (info.timescale || 1);

      for (const t of (info.tracks || [])) {
        const type =
          (t.type === 'video' || (t.codec && /^(avc|hvc|hev|vp0|av01)/.test(t.codec))) ? 'video' :
          (t.type === 'audio' || (t.codec && /^(mp4a|opus|ac-3|ec-3|flac)/.test(t.codec))) ? 'audio' :
          null;
        if (!type) continue;
        tracks.push({ ...t, _type: type });
      }

      // Do NOT call setExtractionOptions / start — we only need track info.
      // Resolve immediately to avoid loading any sample data.
      resolve({ tracks, duration: fileDuration });
    };

    // Feed just enough data for mp4box to parse moov (headers).
    // moov can be at the start (progressive MP4) or end (iPhone MOV).
    // Read start first, then end if needed — avoids loading entire file.
    const READ_CHUNK_SIZE = 2 * 1024 * 1024;
    const MAX_START_PROBE = 4 * 1024 * 1024;   // 4MB from start
    const MAX_END_PROBE   = 8 * 1024 * 1024;   // 8MB from end
    let readOffset = 0;
    try {
      // Phase 1: read from start (covers progressive MP4, short files)
      while (readOffset < Math.min(MAX_START_PROBE, file.size)) {
        const end = Math.min(readOffset + READ_CHUNK_SIZE, file.size);
        const chunk = await file.slice(readOffset, end).arrayBuffer();
        chunk.fileStart = readOffset;
        mp4boxFile.appendBuffer(chunk);
        readOffset = end;
        if (tracks.length > 0) break;
      }

      // Phase 2: moov not found at start — read from end (iPhone MOV, etc.)
      if (tracks.length === 0 && file.size > MAX_START_PROBE) {
        const endStart = Math.max(readOffset, file.size - MAX_END_PROBE);
        let endOffset = endStart;
        while (endOffset < file.size) {
          const end = Math.min(endOffset + READ_CHUNK_SIZE, file.size);
          const chunk = await file.slice(endOffset, end).arrayBuffer();
          chunk.fileStart = endOffset;
          mp4boxFile.appendBuffer(chunk);
          endOffset = end;
          if (tracks.length > 0) break;
        }
      }

      if (tracks.length === 0) {
        mp4boxFile.flush();
      }
    } catch (err) {
      reject(new Error('無法解析此影片：' + (err?.message || err)));
      return;
    }

    if (tracks.length === 0) {
      resolve({ tracks: [], duration: 0 });
    }
  });
}

// ─── Streaming transcode pipeline ───
//
// Processes file incrementally: feed 2MB chunks to mp4box → extract samples in
// small batches (nbSamples=60) → decode → encode → release immediately.
//
// Memory profile (500MB 4K input → 720p output):
//   Input buffer:   ~2MB  (current file.slice chunk)
//   Decoder queue:  ~few decoded VideoFrames (~5-10MB)
//   Encoder queue:  ~few encoded chunks (~1MB)
//   Encoded output: accumulates, but 720p@1.5Mbps ≈ 50MB for 3min video
//   Total peak:     ~60-70MB instead of 500MB+

async function streamingTranscode(file, mp4boxMod, onProgress, encoderConstraints = {}, onSegment = null) {
  const demuxer = createMp4boxFile(mp4boxMod);
  const isStreaming = typeof onSegment === 'function';

  // Batch mode: accumulate encoded output (original behavior when onSegment is null)
  const encodedVideo = isStreaming ? null : [];
  const encodedAudio = isStreaming ? null : [];

  // ── Streaming mode: incremental muxer state ──
  // When onSegment is provided, encoder outputs are fed to the muxer in
  // real-time instead of being collected in arrays. The muxer emits fMP4
  // segments which are passed to onSegment() for immediate encrypt+upload.
  let incMuxer = null;
  let incMuxVideoTrackId = null;
  let incMuxAudioTrackId = null;
  let incMuxReady = false;
  let videoMuxDesc = null;         // avcC from first encoder keyframe
  let audioMuxDesc = null;         // esds from demuxer (passthrough) or encoder
  let audioMuxDescReady = false;   // true immediately for passthrough
  let audioEsdsBox = null;         // mp4box.js Box object for esds (passthrough only)
  const preMuxVideoFrames = [];    // buffered until muxer init
  const preMuxAudioFrames = [];
  const readySegments = [];        // fMP4 segments waiting to be consumed
  let totalEmittedSegments = 0;
  let hadAudioOutput = false;

  // Track info (discovered in onReady)
  let videoTrack = null;
  let audioTrack = null;
  let vEncConfig = null;
  let totalSamples = 0;
  let processedSamples = 0;

  // Video codec instances
  let videoEncoder = null;
  let videoDecoder = null;
  let decodedFrameCount = 0;

  // Rotation support
  let rotCanvas = null;
  let rotCtx = null;
  let rotation = 0;

  // Audio
  let audioIsPassthrough = false;
  let audioEncoder = null;
  let audioDecoder = null;

  // Pending samples queue (filled by onSamples, drained after each appendBuffer)
  const pendingVideo = [];
  const pendingAudio = [];

  // Last released sample number per track (for releaseUsedSamples)
  const lastReleasedSample = {};

  // ── Fatal error propagation ──
  // WebCodecs error callbacks fire asynchronously in browser context.
  // Using `throw` inside them creates unhandled exceptions that never
  // propagate to the async function. Instead, we capture the FIRST error
  // and check it at every async yield point in the pipeline.
  let fatalError = null;
  function setFatalError(err) {
    if (!fatalError) {
      fatalError = err;
      console.error('[streamingTranscode] fatal:', err?.message || err);
    }
  }
  function checkError() {
    if (fatalError) throw fatalError;
  }

  const reportProgress = () => {
    if (!totalSamples) return;
    const pct = Math.round((processedSamples / totalSamples) * 100);
    onProgress?.({ phase: 'encode', percent: Math.min(pct, 99) });
  };

  // ── Setup helpers ──

  function setupVideoEncoder(config) {
    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          const frame = {
            data: buf,
            timestamp: chunk.timestamp,
            duration: chunk.duration || 0,
            key: chunk.type === 'key',
            description: meta?.decoderConfig?.description
              ? new Uint8Array(meta.decoderConfig.description)
              : undefined,
          };
          processedSamples++;
          reportProgress();

          if (isStreaming) {
            if (!videoMuxDesc && frame.description) {
              videoMuxDesc = frame.description;
              tryInitIncMuxer();
            }
            if (incMuxReady) {
              feedVideoToIncMuxer(frame);
            } else {
              preMuxVideoFrames.push(frame);
            }
          } else {
            encodedVideo.push(frame);
          }
        } catch (err) {
          setFatalError(err);
        }
      },
      error: (err) => setFatalError(new Error('視訊編碼失敗：' + (err?.message || err))),
    });
    videoEncoder.configure(config);
  }

  function setupVideoDecoder(track, encConfig) {
    rotation = encConfig._rotation || 0;
    const needsRot = rotation !== 0;

    // Determine if we need an OffscreenCanvas for scaling and/or rotation.
    // Decoded frames are at original resolution (e.g. 3840×2160) but the
    // encoder expects the target resolution (e.g. 720×1280). Some browsers'
    // VideoEncoder won't auto-rescale, so we must do it ourselves.
    const srcW = track.video?.width || track.track_width || encConfig.width;
    const srcH = track.video?.height || track.track_height || encConfig.height;
    const needsResize = (srcW !== encConfig.width) || (srcH !== encConfig.height);
    const needsCanvas = needsRot || needsResize;

    if (needsCanvas && typeof OffscreenCanvas === 'function') {
      rotCanvas = new OffscreenCanvas(encConfig.width, encConfig.height);
      rotCtx = rotCanvas.getContext('2d');
    }

    videoDecoder = new VideoDecoder({
      output: (frame) => {
        try {
          let toEncode = frame;
          if (needsCanvas && rotCtx) {
            const fw = frame.displayWidth;
            const fh = frame.displayHeight;
            const ow = encConfig.width;
            const oh = encConfig.height;
            rotCtx.clearRect(0, 0, ow, oh);
            rotCtx.save();
            rotCtx.translate(ow / 2, oh / 2);
            if (needsRot) rotCtx.rotate((rotation * Math.PI) / 180);

            // Scale the frame to fit the target canvas.
            // After rotation, a 90°/270° turn swaps the frame's effective
            // width/height relative to the canvas dimensions.
            let sx, sy;
            if (needsRot && (rotation === 90 || rotation === 270)) {
              sx = ow / fh;
              sy = oh / fw;
            } else {
              sx = ow / fw;
              sy = oh / fh;
            }
            const s = Math.min(sx, sy);
            rotCtx.drawImage(frame, (-fw * s) / 2, (-fh * s) / 2, fw * s, fh * s);

            rotCtx.restore();
            toEncode = new VideoFrame(rotCanvas, {
              timestamp: frame.timestamp,
              duration: frame.duration,
            });
            frame.close();
          }
          videoEncoder.encode(toEncode, { keyFrame: decodedFrameCount % 60 === 0 });
          toEncode.close();
          decodedFrameCount++;
        } catch (err) {
          try { frame.close(); } catch {}
          setFatalError(err);
        }
      },
      error: (err) => setFatalError(new Error('視訊解碼失敗：' + (err?.message || err))),
    });

    const decoderConfig = {
      codec: track.codec,
      codedWidth: track.video?.width || track.track_width,
      codedHeight: track.video?.height || track.track_height,
    };
    // Extract codec description from mp4box's internal moov structure.
    // track.avcC/hvcC are NOT populated by getInfo() — we must access
    // the internal trak→stsd→entry to get the decoder config record.
    const description = getCodecDescription(demuxer, track.id);
    if (description) {
      decoderConfig.description = description;
    } else {
      console.warn('[setupVideoDecoder] no codec description for', track.codec,
        '— decoder may fail for codecs that require SPS/PPS/VPS (HEVC, AVC)');
    }
    videoDecoder.configure(decoderConfig);
  }

  function setupAudioTranscode(track) {
    const aEncConfig = audioEncoderConfig(track);

    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        try {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          const frame = {
            data: buf,
            timestamp: chunk.timestamp,
            duration: chunk.duration || 0,
            key: chunk.type === 'key',
            description: meta?.decoderConfig?.description
              ? new Uint8Array(meta.decoderConfig.description)
              : undefined,
          };
          processedSamples++;
          reportProgress();
          hadAudioOutput = true;

          if (isStreaming) {
            if (!audioMuxDescReady && frame.description) {
              audioMuxDesc = frame.description;
              audioMuxDescReady = true;
              tryInitIncMuxer();
            }
            if (incMuxReady) {
              feedAudioToIncMuxer(frame);
            } else {
              preMuxAudioFrames.push(frame);
            }
          } else {
            encodedAudio.push(frame);
          }
        } catch (err) {
          setFatalError(err);
        }
      },
      error: (err) => setFatalError(new Error('音訊編碼失敗：' + (err?.message || err))),
    });
    audioEncoder.configure(aEncConfig);

    audioDecoder = new AudioDecoder({
      output: (frame) => {
        try {
          audioEncoder.encode(frame);
          frame.close();
        } catch (err) {
          try { frame.close(); } catch {}
          setFatalError(err);
        }
      },
      error: (err) => setFatalError(new Error('音訊解碼失敗：' + (err?.message || err))),
    });

    const decoderConfig = {
      codec: track.codec,
      sampleRate: track.audio?.sample_rate || 44100,
      numberOfChannels: track.audio?.channel_count || 2,
    };
    // Extract esds description from mp4box's internal moov structure
    const audioDesc = getAudioDescription(demuxer, track.id);
    if (audioDesc) decoderConfig.description = audioDesc;
    audioDecoder.configure(decoderConfig);
  }

  // ── Process accumulated samples from onSamples queue ──

  async function processPendingSamples() {
    // Feed video samples to decoder, releasing compressed data immediately
    while (pendingVideo.length > 0) {
      checkError();
      const s = pendingVideo.shift();
      try {
        videoDecoder.decode(new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
          duration: Math.round((s.duration / s.timescale) * 1_000_000),
          data: s.data,
        }));
      } catch (decodeErr) {
        // Decoder may have closed due to a codec error — throw the original
        throw fatalError || decodeErr;
      }
      // Track last sample number for releaseUsedSamples
      if (s.number != null) lastReleasedSample[s.track_id || videoTrack.id] = s.number;
      s.data = null;

      // Backpressure: if decoder queue is building up, yield to let it drain.
      // decodeQueueSize may not exist on all browsers — guard safely.
      if (videoDecoder.decodeQueueSize > 30) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Feed audio samples
    while (pendingAudio.length > 0) {
      checkError();
      const s = pendingAudio.shift();
      if (audioIsPassthrough) {
        const aFrame = {
          data: new Uint8Array(s.data),
          timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
          duration: Math.round((s.duration / s.timescale) * 1_000_000),
          key: s.is_sync,
        };
        processedSamples++;
        reportProgress();
        hadAudioOutput = true;

        if (isStreaming) {
          if (incMuxReady) {
            feedAudioToIncMuxer(aFrame);
          } else {
            preMuxAudioFrames.push(aFrame);
          }
        } else {
          encodedAudio.push(aFrame);
        }
      } else if (audioDecoder) {
        try {
          audioDecoder.decode(new EncodedAudioChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
            duration: Math.round((s.duration / s.timescale) * 1_000_000),
            data: s.data,
          }));
        } catch (decodeErr) {
          throw fatalError || decodeErr;
        }
      }
      if (s.number != null) lastReleasedSample[s.track_id || audioTrack.id] = s.number;
      s.data = null;
    }

    // Tell mp4box.js to release sample data for processed samples
    for (const [trackId, sampleNum] of Object.entries(lastReleasedSample)) {
      try { demuxer.releaseUsedSamples(Number(trackId), sampleNum); } catch {}
    }

    // Release mp4box.js internal stream buffers that are no longer needed.
    // mp4box accumulates ALL appendBuffer data in stream.buffers[]; without
    // cleanup, a 581MB file consumes 581MB of ArrayBuffers just for the stream.
    // After samples are extracted and released, the underlying mdat data is
    // no longer needed — only keep the most recent buffer for ongoing parsing.
    try {
      const stream = demuxer.stream;
      if (stream && Array.isArray(stream.buffers) && stream.buffers.length > 3) {
        // Keep last 3 buffers (~6MB) for any in-progress box parsing
        const keep = stream.buffers.length - 3;
        for (let i = 0; i < keep; i++) {
          // Null out the underlying ArrayBuffer data but keep the entry
          // so mp4box position tracking doesn't break
          stream.buffers[i] = new ArrayBuffer(0);
          stream.buffers[i].fileStart = i * READ_CHUNK_SIZE;
        }
      }
    } catch { /* best effort */ }
  }

  // ── Incremental muxer helpers (streaming mode only) ──

  /** Convert a Uint8Array (or typed view) to a standalone ArrayBuffer.
   *  mp4box.js internally uses DataView/stream on description & sample data,
   *  which expects ArrayBuffer — passing a Uint8Array can fail on Safari. */
  function toArrayBuffer(u8) {
    if (!u8) return u8;
    if (u8 instanceof ArrayBuffer) return u8;
    if (u8.buffer) {
      // Ensure we get exactly the relevant slice (not the full backing buffer)
      return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
        ? u8.buffer
        : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    }
    return u8;
  }

  function tryInitIncMuxer() {
    if (!isStreaming || incMuxReady) return;
    if (!videoMuxDesc) return;
    if (audioTrack && !audioMuxDescReady) return;

    try {
      incMuxer = createMp4boxFile(mp4boxMod);

      // mp4box.js addTrack requires the actual sample entry type (e.g. 'avc1'),
      // NOT generic 'video'/'audio'. It checks BoxParser[type+"SampleEntry"]
      // and returns undefined if the class doesn't exist.
      // For H.264, the avcC config must be passed as avcDecoderConfigRecord (ArrayBuffer),
      // NOT as description (which expects a parsed Box object).
      const videoDescAB = toArrayBuffer(videoMuxDesc);
      incMuxVideoTrackId = incMuxer.addTrack({
        type: 'avc1', width: vEncConfig.width, height: vEncConfig.height,
        timescale: 90000, media_duration: 0, nb_samples: 0,
        avcDecoderConfigRecord: videoDescAB,
      });
      if (incMuxVideoTrackId == null) {
        throw new Error('addTrack(video) returned ' + incMuxVideoTrackId);
      }

      if (audioTrack) {
        const audioTimescale = audioTrack.audio?.sample_rate || 44100;
        incMuxAudioTrackId = incMuxer.addTrack({
          type: 'mp4a', timescale: audioTimescale, media_duration: 0, nb_samples: 0,
          channel_count: audioTrack.audio?.channel_count || 2,
          samplerate: audioTimescale, samplesize: 16,
        });
        if (incMuxAudioTrackId == null) {
          throw new Error('addTrack(audio) returned ' + incMuxAudioTrackId);
        }

        // [FIX] Inject correct esds into the muxer's mp4a sample entry.
        // mp4box.js v0.5.3 generates a default/broken esds when addTrack
        // is called without a description (gpac/mp4box.js#502). Without
        // the proper AudioSpecificConfig in the esds, browsers cannot
        // initialize the audio decoder from the init segment, causing
        // MSE SourceBuffer append errors and infinite buffering on playback.
        if (audioEsdsBox) {
          // Passthrough: copy the original esds Box object from the demuxer
          try {
            const muxTrak = incMuxer.getTrackById(incMuxAudioTrackId);
            const muxEntry = muxTrak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
            if (muxEntry) {
              muxEntry.esds = audioEsdsBox;
              console.info('[streamingTranscode] injected source esds into muxer audio track');
            }
          } catch (e) {
            console.warn('[streamingTranscode] failed to inject audio esds:', e?.message);
          }
        }
      }

      incMuxer.setSegmentOptions(incMuxVideoTrackId, null, { nbSamples: 100 });
      if (incMuxAudioTrackId != null) {
        incMuxer.setSegmentOptions(incMuxAudioTrackId, null, { nbSamples: 100 });
      }

      const initSegs = incMuxer.initializeSegmentation();
      if (!initSegs || initSegs.length === 0) {
        throw new Error('initializeSegmentation returned empty');
      }
      const initParts = [];
      for (let i = 0; i < initSegs.length; i++) {
        const seg = initSegs[i];
        if (!seg || !seg.buffer) {
          throw new Error('initSeg[' + i + '].buffer is ' + (seg ? typeof seg.buffer : 'null entry'));
        }
        initParts.push(new Uint8Array(seg.buffer));
      }
      // mp4box.js v0.5.3 initializeSegmentation() returns one init segment
      // per setSegmentOptions() call. Each init contains only ONE track's
      // trak + trex. mergeInitSegments combines them into a single moov
      // with all tracks, which MSE requires for muxed playback.
      const combinedInit = mergeInitSegments(initParts);
      readySegments.push({ trackIndex: 0, data: combinedInit, encodeProgress: 0 });

      incMuxer.onSegment = (_id, _user, buf) => {
        const ep = totalSamples > 0 ? Math.min(1, processedSamples / totalSamples) : 0;
        if (buf) readySegments.push({ trackIndex: 0, data: new Uint8Array(buf), encodeProgress: ep });
      };
      incMuxer.start();
      incMuxReady = true;

      // Flush buffered frames that arrived before muxer was ready
      for (const f of preMuxVideoFrames) feedVideoToIncMuxer(f);
      preMuxVideoFrames.length = 0;
      for (const f of preMuxAudioFrames) feedAudioToIncMuxer(f);
      preMuxAudioFrames.length = 0;
    } catch (err) {
      console.error('[streamingTranscode] incMuxer init failed:', err);
      setFatalError(new Error('incremental muxer init: ' + (err?.message || err)));
    }
  }

  function feedVideoToIncMuxer(frame) {
    if (!frame?.data || !incMuxer) return;
    const ts = Math.round((frame.timestamp / 1_000_000) * 90000);
    const dur = Math.round((frame.duration / 1_000_000) * 90000);
    incMuxer.addSample(incMuxVideoTrackId, toArrayBuffer(frame.data), {
      duration: dur || 3000, is_sync: frame.key, cts: ts, dts: ts,
    });
  }

  function feedAudioToIncMuxer(frame) {
    if (!frame?.data || !incMuxer) return;
    const audioTimescale = audioTrack?.audio?.sample_rate || 44100;
    const ts = Math.round((frame.timestamp / 1_000_000) * audioTimescale);
    const dur = Math.round((frame.duration / 1_000_000) * audioTimescale);
    incMuxer.addSample(incMuxAudioTrackId, toArrayBuffer(frame.data), {
      duration: dur || 1024, is_sync: frame.key !== false, cts: ts, dts: ts,
    });
  }

  /** Yield to the event loop, then pass any ready segments to onSegment(). */
  async function drainReadySegments() {
    if (!isStreaming) return;
    // Give decoder/encoder callbacks a chance to fire and produce segments
    await new Promise(r => setTimeout(r, 0));
    while (readySegments.length > 0) {
      const seg = readySegments.shift();
      totalEmittedSegments++;
      await onSegment(seg);
    }
  }

  // ── Main flow ──

  let readyResolve, readyReject;
  const readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  demuxer.onError = (err) => readyReject(new Error('影片解析失敗：' + (err?.message || err)));

  demuxer.onReady = async (info) => {
    try {
      for (const t of (info.tracks || [])) {
        const type =
          (t.type === 'video' || (t.codec && /^(avc|hvc|hev|vp0|av01)/.test(t.codec))) ? 'video' :
          (t.type === 'audio' || (t.codec && /^(mp4a|opus|ac-3|ec-3|flac)/.test(t.codec))) ? 'audio' :
          null;
        if (!type) continue;

        if (type === 'video' && !videoTrack) {
          videoTrack = { ...t, _type: 'video' };
          totalSamples += t.nb_samples || 0;
          // Extract in small batches to avoid holding all samples in memory
          demuxer.setExtractionOptions(t.id, null, { nbSamples: 60 });
        } else if (type === 'audio' && !audioTrack) {
          audioTrack = { ...t, _type: 'audio' };
          totalSamples += t.nb_samples || 0;
          demuxer.setExtractionOptions(t.id, null, { nbSamples: 60 });
        }
      }

      if (!videoTrack) {
        readyReject(new Error('影片不包含視訊軌道'));
        return;
      }

      // Configure video encoder/decoder
      vEncConfig = videoEncoderConfig(videoTrack, encoderConstraints);
      const vSupport = await VideoEncoder.isConfigSupported(vEncConfig);
      if (!vSupport.supported) {
        readyReject(new Error('此裝置不支援 H.264 編碼'));
        return;
      }

      setupVideoEncoder(vEncConfig);
      setupVideoDecoder(videoTrack, vEncConfig);

      // Configure audio
      if (audioTrack) {
        const audioCodec = (audioTrack.codec || '').toLowerCase();
        if (MSE_SAFE_AUDIO.test(audioCodec)) {
          audioIsPassthrough = true;
          // Streaming mode: capture audio description now for muxer init
          if (isStreaming) {
            audioMuxDesc = getAudioDescription(demuxer, audioTrack.id) || undefined;
            // Also capture the mp4box.js Box object directly — avoids
            // serialization/deserialization roundtrip and mp4box.js esds
            // parsing bugs (gpac/mp4box.js#502).
            try {
              const srcTrak = demuxer.getTrackById(audioTrack.id);
              const srcEntry = srcTrak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
              if (srcEntry?.esds) audioEsdsBox = srcEntry.esds;
            } catch {}
            audioMuxDescReady = true;
          }
        } else {
          audioIsPassthrough = false;
          try {
            const aEncConfig = audioEncoderConfig(audioTrack);
            const aSupport = await AudioEncoder.isConfigSupported(aEncConfig);
            if (aSupport.supported) {
              setupAudioTranscode(audioTrack);
            } else {
              // Audio encoder not supported — skip audio (video-only output)
              audioTrack = null;
            }
          } catch {
            audioTrack = null;
          }
        }
      }

      demuxer.start();
      readyResolve();
    } catch (err) {
      readyReject(err);
    }
  };

  demuxer.onSamples = (trackId, _user, sampleArray) => {
    if (videoTrack && trackId === videoTrack.id) {
      for (const s of sampleArray) pendingVideo.push(s);
    } else if (audioTrack && trackId === audioTrack.id) {
      for (const s of sampleArray) pendingAudio.push(s);
    }
  };

  // ── Feed file in 2MB chunks, process samples after each chunk ──
  //
  // Phase 1: Find moov by reading the start and (if needed) end of the file.
  //          For iPhone MOV, moov is at the end — reading sequentially would
  //          load the entire file (~581MB) into mp4box stream.buffers, crashing
  //          the tab.  Reading only start + end caps memory at ~12MB.
  // Phase 2: Once moov is found and codecs are set up, read the remaining data
  //          sequentially.  The buffer-cleanup in processPendingSamples keeps
  //          memory bounded.

  const READ_CHUNK_SIZE = 2 * 1024 * 1024;
  const MOOV_START_PROBE = 4 * 1024 * 1024;
  const MOOV_END_PROBE   = 8 * 1024 * 1024;
  let readOffset = 0;
  let ready = false;
  let endProbeStart = -1; // byte offset where the end-probe region starts (-1 = not used)

  // Phase 1a: read from start
  while (readOffset < Math.min(MOOV_START_PROBE, file.size)) {
    checkError();
    const end = Math.min(readOffset + READ_CHUNK_SIZE, file.size);
    const chunk = await file.slice(readOffset, end).arrayBuffer();
    chunk.fileStart = readOffset;
    try { demuxer.appendBuffer(chunk); } catch (e) {
      throw fatalError || new Error('影片解析失敗（記憶體不足？）：' + (e?.message || e));
    }
    readOffset = end;
    if (videoTrack) { await readyPromise; ready = true; break; }
  }

  // Phase 1b: moov not found at start — read from end
  if (!ready && file.size > MOOV_START_PROBE) {
    endProbeStart = Math.max(readOffset, file.size - MOOV_END_PROBE);
    let endOffset = endProbeStart;
    while (endOffset < file.size) {
      checkError();
      const end = Math.min(endOffset + READ_CHUNK_SIZE, file.size);
      const chunk = await file.slice(endOffset, end).arrayBuffer();
      chunk.fileStart = endOffset;
      try { demuxer.appendBuffer(chunk); } catch (e) {
        throw fatalError || new Error('影片解析失敗（記憶體不足？）：' + (e?.message || e));
      }
      endOffset = end;
      if (videoTrack) { await readyPromise; ready = true; break; }
    }
  }

  // Tiny/edge-case: flush to trigger onReady for small files
  if (!ready) {
    try { demuxer.flush(); } catch {}
    await readyPromise;
    ready = true;
  }

  // Process any samples that the start/end probes already triggered
  checkError();
  await processPendingSamples();
  if (isStreaming) await drainReadySegments();

  // Phase 2: sequential read for sample data (cleanup active from the start)
  // readOffset is where Phase 1a left off; skip ranges already fed in Phase 1b.
  while (readOffset < file.size) {
    checkError();
    // Skip bytes already fed during the end-probe
    if (endProbeStart >= 0 && readOffset >= endProbeStart) {
      readOffset = file.size; // end-probe data already fed
      break;
    }
    const end = Math.min(readOffset + READ_CHUNK_SIZE,
                         endProbeStart >= 0 ? endProbeStart : file.size);
    const chunk = await file.slice(readOffset, end).arrayBuffer();
    chunk.fileStart = readOffset;
    try { demuxer.appendBuffer(chunk); } catch (e) {
      throw fatalError || new Error('影片解析失敗（記憶體不足？）：' + (e?.message || e));
    }
    readOffset = end;
    await processPendingSamples();
    if (isStreaming) await drainReadySegments();
  }

  try { demuxer.flush(); } catch {}

  // Process any remaining samples from flush
  checkError();
  await processPendingSamples();
  if (isStreaming) await drainReadySegments();
  checkError();

  // ── Flush decoder → encoder pipelines ──

  if (videoDecoder && videoDecoder.state === 'configured') {
    await videoDecoder.flush();
  }
  if (videoEncoder && videoEncoder.state === 'configured') {
    await videoEncoder.flush();
  }
  if (audioDecoder && audioDecoder.state === 'configured') {
    await audioDecoder.flush();
  }
  if (audioEncoder && audioEncoder.state === 'configured') {
    await audioEncoder.flush();
  }

  // Close codecs
  try { videoDecoder?.close(); } catch {}
  try { videoEncoder?.close(); } catch {}
  try { audioDecoder?.close(); } catch {}
  try { audioEncoder?.close(); } catch {}

  onProgress?.({ phase: 'encode', percent: 95 });

  // ── Streaming mode: flush muxer and drain final segments ──

  if (isStreaming) {
    try { incMuxer?.flush(); } catch {}
    await drainReadySegments();
    onProgress?.({ phase: 'encode', percent: 100 });

    const codecs = [vEncConfig.codec];
    if (hadAudioOutput) codecs.push('mp4a.40.2');

    return {
      tracks: [{ type: 'muxed', codec: codecs.join(',') }],
      contentType: 'video/mp4',
      totalSegments: totalEmittedSegments,
      transcoded: true,
    };
  }

  // ── Batch mode: mux into fMP4 segments ──

  const segments = await muxToFmp4(encodedVideo, encodedAudio, vEncConfig, audioTrack, mp4boxMod);

  const hadAudio = encodedAudio.length > 0;
  encodedVideo.length = 0;
  encodedAudio.length = 0;

  onProgress?.({ phase: 'encode', percent: 100 });

  const codecs = [vEncConfig.codec];
  if (hadAudio) codecs.push('mp4a.40.2');

  return {
    segments,
    tracks: [{ type: 'muxed', codec: codecs.join(',') }],
    contentType: 'video/mp4',
    remuxed: false,
    transcoded: true,
    name: (typeof file?.name === 'string' ? file.name : 'video').replace(/\.[^.]+$/, '') + '.mp4',
  };
}

// ─── Extract codec-specific description box data ───

function extractBoxData(boxObj) {
  // mp4box.js attaches parsed box objects; we need the raw bytes
  // for VideoDecoder.configure({ description })
  if (boxObj instanceof ArrayBuffer) return new Uint8Array(boxObj);
  if (boxObj instanceof Uint8Array) return boxObj;
  if (ArrayBuffer.isView(boxObj)) return new Uint8Array(boxObj.buffer, boxObj.byteOffset, boxObj.byteLength);
  // mp4box.js box: try to serialize via its write method
  if (typeof boxObj.write === 'function') {
    try {
      const stream = new boxObj.constructor.Stream(new ArrayBuffer(1024), 0, false);
      boxObj.write(stream);
      return new Uint8Array(stream.buffer, 0, stream.position);
    } catch { /* fall through */ }
  }
  // If box has a .data property
  if (boxObj.data) return extractBoxData(boxObj.data);
  return undefined;
}

// ─── Mux encoded frames into fMP4 segments via mp4box.js ───

async function muxToFmp4(encodedVideo, encodedAudio, videoConfig, audioTrackInfo, mp4boxMod) {
  const mp4boxFile = createMp4boxFile(mp4boxMod);
  const segments = []; // [{ trackIndex: 0, data: Uint8Array }]

  // Add video track
  // mp4box.js addTrack requires the actual sample entry type (e.g. 'avc1'),
  // NOT generic 'video'. It checks BoxParser[type+"SampleEntry"] and returns
  // undefined silently if the class doesn't exist.
  // For H.264, pass avcDecoderConfigRecord (raw avcC ArrayBuffer from encoder).
  const videoDesc = encodedVideo.find(e => e.description)?.description;
  const videoTrackId = mp4boxFile.addTrack({
    type: 'avc1',
    width: videoConfig.width,
    height: videoConfig.height,
    timescale: 90000,
    media_duration: 0,
    nb_samples: encodedVideo.length,
    avcDecoderConfigRecord: videoDesc
      ? (videoDesc.buffer || videoDesc) // ensure ArrayBuffer for mp4box.js
      : undefined,
  });

  // Add audio track (if we have encoded audio)
  let audioTrackId = null;
  if (encodedAudio.length > 0) {
    audioTrackId = mp4boxFile.addTrack({
      type: 'mp4a',
      timescale: audioTrackInfo?.audio?.sample_rate || 44100,
      media_duration: 0,
      nb_samples: encodedAudio.length,
      channel_count: audioTrackInfo?.audio?.channel_count || 2,
      samplerate: audioTrackInfo?.audio?.sample_rate || 44100,
      samplesize: 16,
    });
  }

  // Set segment options (fragmented output)
  mp4boxFile.setSegmentOptions(videoTrackId, null, { nbSamples: 100 });
  if (audioTrackId) {
    mp4boxFile.setSegmentOptions(audioTrackId, null, { nbSamples: 100 });
  }

  // [FIX] Initialize segmentation and start() BEFORE adding samples.
  // mp4box.js only triggers onSegment during addSample() when
  // sampleProcessingStarted is true (set by start()). Previously, all
  // samples were added before start(), so onSegment never fired and
  // only ~0-3 seconds of video was produced.

  // Collect init segments
  const initSegs = mp4boxFile.initializeSegmentation();
  const initParts = initSegs.map(s => new Uint8Array(s.buffer));

  // mp4box.js v0.5.3 initializeSegmentation() returns one init per
  // setSegmentOptions() call, each with only ONE track's trak+trex.
  // mergeInitSegments combines them into a single moov with all tracks.
  const combinedInit = mergeInitSegments(initParts);

  segments.push({ trackIndex: 0, data: combinedInit });

  // Set up segment collection callback BEFORE start()
  const mediaSegs = [];
  mp4boxFile.onSegment = (id, _user, buffer) => {
    mediaSegs.push(new Uint8Array(buffer));
  };

  // Start segmentation — enables onSegment callbacks during addSample()
  mp4boxFile.start();

  // [FIX] Interleave video and audio addSample() calls by timestamp.
  // mp4box.js emits per-track segments (each moof+mdat covers one track).
  // If all video samples are added first, mediaSegs becomes:
  //   [video_seg_1, ..., video_seg_N, audio_seg_1, ..., audio_seg_M]
  // During MSE streaming, the player appends all video before any audio,
  // causing silent playback. Interleaving by timestamp produces:
  //   [video_seg_1, audio_seg_1, video_seg_2, audio_seg_2, ...]
  // so both tracks progress together and MSE has audio data from the start.
  const audioTimescale = audioTrackInfo?.audio?.sample_rate || 44100;
  let vi = 0;
  let ai = 0;
  while (vi < encodedVideo.length || (audioTrackId && ai < encodedAudio.length)) {
    const vTs = vi < encodedVideo.length ? encodedVideo[vi].timestamp : Infinity;
    const aTs = (audioTrackId && ai < encodedAudio.length) ? encodedAudio[ai].timestamp : Infinity;

    if (vTs <= aTs && vi < encodedVideo.length) {
      const frame = encodedVideo[vi++];
      const tsInTimescale = Math.round((frame.timestamp / 1_000_000) * 90000);
      const durInTimescale = Math.round((frame.duration / 1_000_000) * 90000);
      mp4boxFile.addSample(videoTrackId, frame.data.buffer, {
        duration: durInTimescale || 3000,
        is_sync: frame.key,
        cts: tsInTimescale,
        dts: tsInTimescale,
      });
    } else if (audioTrackId && ai < encodedAudio.length) {
      const frame = encodedAudio[ai++];
      const tsInTimescale = Math.round((frame.timestamp / 1_000_000) * audioTimescale);
      const durInTimescale = Math.round((frame.duration / 1_000_000) * audioTimescale);
      mp4boxFile.addSample(audioTrackId, frame.data.buffer, {
        duration: durInTimescale || 1024,
        is_sync: frame.key !== false,
        cts: tsInTimescale,
        dts: tsInTimescale,
      });
    } else {
      break; // safety — shouldn't reach here
    }
  }

  // [FIX] Flush remaining samples to produce the last partial segment.
  // Without flush(), the final samples (up to nbSamples-1 ≈ 3.3s at 30fps)
  // are silently dropped.
  try { mp4boxFile.flush(); } catch { /* flush may not exist in all mp4box builds */ }

  // Collect all media segments produced by addSample() + flush()
  for (const seg of mediaSegs) {
    segments.push({ trackIndex: 0, data: seg });
  }

  return segments;
}
