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

  // Target: H.264 Baseline for maximum MSE compatibility
  // If source has 90°/270° rotation, swap output dimensions so the
  // re-encoded video is already in display orientation (no matrix needed).
  return {
    codec: 'avc1.42001E', // Baseline profile, level 3.0
    width: swap ? codedH : codedW,
    height: swap ? codedW : codedH,
    bitrate: Math.min(baseBitrate, maxBitrate),
    framerate: track.video?.frame_rate || track.timescale / (track.samples_duration / track.nb_samples) || 30,
    latencyMode: 'quality',
    avc: { format: 'avc' }, // Annex-B → mp4box expects AVC (length-prefixed)
    _rotation: rotation, // internal: used by transcodeVideoTrack
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
export async function transcodeToFmp4(file, { onProgress, encoderConstraints, onTranscodeStart } = {}) {
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

  // 4. Now extract samples (heavy — loads all sample data for transcoding)
  const { tracks: inputTracks, samples: inputSamples, duration } =
    await demuxFile(file, mp4boxMod);

  if (inputTracks.length === 0) {
    throw new Error('影片不包含可播放的音視訊軌道');
  }

  // 5. Transcode via WebCodecs
  const result = await doTranscode(inputTracks, inputSamples, duration, mp4boxMod, onProgress, encoderConstraints);
  return result;
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
    // For most MP4 files, moov is at the start or end; mp4box handles both.
    const READ_CHUNK_SIZE = 2 * 1024 * 1024;
    let readOffset = 0;
    try {
      while (readOffset < file.size) {
        const end = Math.min(readOffset + READ_CHUNK_SIZE, file.size);
        const chunk = await file.slice(readOffset, end).arrayBuffer();
        chunk.fileStart = readOffset;
        mp4boxFile.appendBuffer(chunk);
        readOffset = end;
        // If onReady already fired, stop reading — we have what we need
        if (tracks.length > 0) break;
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

// ─── Demux helper ───

function demuxFile(file, mp4boxMod) {
  return new Promise(async (resolve, reject) => {
    const mp4boxFile = createMp4boxFile(mp4boxMod);
    const tracks = [];
    const samples = {}; // trackId → [{ data, duration, is_sync, cts, dts }]
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
        samples[t.id] = [];

        // Extract all samples for this track
        mp4boxFile.setExtractionOptions(t.id, null, {
          nbSamples: Infinity,
        });
      }

      if (tracks.length === 0) {
        reject(new Error('影片不包含可播放的音視訊軌道'));
        return;
      }

      mp4boxFile.start();
    };

    mp4boxFile.onSamples = (trackId, _user, sampleArray) => {
      if (!samples[trackId]) samples[trackId] = [];
      for (const s of sampleArray) {
        samples[trackId].push({
          data: s.data, // ArrayBuffer
          duration: s.duration,
          is_sync: s.is_sync,
          cts: s.cts,
          dts: s.dts,
          timescale: s.timescale,
          size: s.size,
        });
      }
    };

    // Feed file to mp4box in 2MB chunks via file.slice() — avoids loading
    // the entire file into memory. mp4box supports incremental appendBuffer.
    const READ_CHUNK_SIZE = 2 * 1024 * 1024;
    let readOffset = 0;
    try {
      while (readOffset < file.size) {
        const end = Math.min(readOffset + READ_CHUNK_SIZE, file.size);
        const chunk = await file.slice(readOffset, end).arrayBuffer();
        chunk.fileStart = readOffset;
        mp4boxFile.appendBuffer(chunk);
        readOffset = end;
      }
      mp4boxFile.flush();
    } catch (err) {
      reject(new Error('無法解析此影片：' + (err?.message || err)));
      return;
    }

    if (tracks.length === 0) {
      reject(new Error('影片不包含可播放的音視訊軌道'));
      return;
    }

    resolve({ tracks, samples, duration: fileDuration });
  });
}

// ─── Transcode pipeline ───

async function doTranscode(inputTracks, inputSamples, duration, mp4boxMod, onProgress, encoderConstraints = {}) {
  const videoTrack = inputTracks.find(t => t._type === 'video');
  const audioTrack = inputTracks.find(t => t._type === 'audio');

  if (!videoTrack) throw new Error('影片不包含視訊軌道');

  // Collect encoded output
  const encodedVideo = []; // [{ data: Uint8Array, timestamp, duration, key }]
  const encodedAudio = []; // [{ data: Uint8Array, timestamp, duration, key }]

  // Total samples for progress
  const totalVideoSamples = (inputSamples[videoTrack.id] || []).length;
  const totalAudioSamples = audioTrack ? (inputSamples[audioTrack.id] || []).length : 0;
  const totalSamples = totalVideoSamples + totalAudioSamples;
  let processedSamples = 0;

  const reportProgress = () => {
    if (!totalSamples) return;
    const pct = Math.round((processedSamples / totalSamples) * 100);
    onProgress?.({ phase: 'encode', percent: Math.min(pct, 99) });
  };

  // ── Video: decode → re-encode ──

  const vEncConfig = videoEncoderConfig(videoTrack, encoderConstraints);

  // Check encoder support
  const vSupport = await VideoEncoder.isConfigSupported(vEncConfig);
  if (!vSupport.supported) {
    throw new Error('此裝置不支援 H.264 編碼');
  }

  await transcodeVideoTrack(
    videoTrack, inputSamples[videoTrack.id] || [],
    vEncConfig, encodedVideo,
    () => { processedSamples++; reportProgress(); }
  );
  // Release video samples — transcodeVideoTrack already nulled individual entries,
  // but drop the array reference too so the entire allocation can be reclaimed.
  delete inputSamples[videoTrack.id];

  // ── Audio: passthrough if AAC, else re-encode ──

  if (audioTrack) {
    const audioCodec = (audioTrack.codec || '').toLowerCase();
    if (MSE_SAFE_AUDIO.test(audioCodec)) {
      // AAC passthrough — no re-encoding needed
      const audioSamples = inputSamples[audioTrack.id] || [];
      for (let ai = 0; ai < audioSamples.length; ai++) {
        const s = audioSamples[ai];
        encodedAudio.push({
          data: new Uint8Array(s.data),
          timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
          duration: Math.round((s.duration / s.timescale) * 1_000_000),
          key: s.is_sync,
        });
        s.data = null;
        audioSamples[ai] = null;
        processedSamples++;
        reportProgress();
      }
    } else {
      // Need to re-encode audio
      const aEncConfig = audioEncoderConfig(audioTrack);
      const aSupport = await AudioEncoder.isConfigSupported(aEncConfig);
      if (aSupport.supported) {
        await transcodeAudioTrack(
          audioTrack, inputSamples[audioTrack.id] || [],
          aEncConfig, encodedAudio,
          () => { processedSamples++; reportProgress(); }
        );
      }
      // If audio encode not supported, skip audio (video-only output)
    }
    delete inputSamples[audioTrack.id];
  }

  onProgress?.({ phase: 'encode', percent: 95 });

  // ── Mux into fMP4 segments ──

  const segments = await muxToFmp4(encodedVideo, encodedAudio, vEncConfig, audioTrack, mp4boxMod);

  // Release encoded frame arrays — data now lives in segments
  const hadAudio = encodedAudio.length > 0;
  encodedVideo.length = 0;
  encodedAudio.length = 0;

  onProgress?.({ phase: 'encode', percent: 100 });

  // Build codec string
  const codecs = ['avc1.42001E'];
  if (hadAudio) codecs.push('mp4a.40.2');
  const combinedCodec = codecs.join(',');

  return {
    segments,
    tracks: [{ type: 'muxed', codec: combinedCodec }],
    contentType: 'video/mp4',
    remuxed: false,
    transcoded: true,
    name: (typeof file?.name === 'string' ? file.name : 'video').replace(/\.[^.]+$/, '') + '.mp4',
  };
}

// ─── Video transcode (decode → encode) ───

function transcodeVideoTrack(track, samples, encConfig, output, onSample) {
  return new Promise((resolve, reject) => {
    if (!samples.length) { resolve(); return; }

    let decoded = 0;
    let encoded = 0;
    const totalCount = samples.length;
    let decoderDone = false;

    const rotation = encConfig._rotation || 0;
    const needsRotation = rotation !== 0;

    // Prepare OffscreenCanvas for frame rotation (reused across all frames)
    let rotCanvas = null;
    let rotCtx = null;
    if (needsRotation && typeof OffscreenCanvas === 'function') {
      rotCanvas = new OffscreenCanvas(encConfig.width, encConfig.height);
      rotCtx = rotCanvas.getContext('2d');
    }

    /**
     * Rotate a decoded VideoFrame via OffscreenCanvas.
     * Returns a new VideoFrame at the display dimensions; caller must close both.
     */
    function rotateFrame(frame) {
      if (!rotCtx) return frame; // fallback: no rotation
      const fw = frame.displayWidth;
      const fh = frame.displayHeight;
      const ow = encConfig.width;
      const oh = encConfig.height;

      rotCtx.clearRect(0, 0, ow, oh);
      rotCtx.save();
      rotCtx.translate(ow / 2, oh / 2);
      rotCtx.rotate((rotation * Math.PI) / 180);
      // After rotation, the source frame center must align with canvas center
      rotCtx.drawImage(frame, -fw / 2, -fh / 2, fw, fh);
      rotCtx.restore();

      const rotated = new VideoFrame(rotCanvas, {
        timestamp: frame.timestamp,
        duration: frame.duration,
      });
      return rotated;
    }

    // Encoder: collects re-encoded H.264 chunks
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        output.push({
          data: buf,
          timestamp: chunk.timestamp,
          duration: chunk.duration || 0,
          key: chunk.type === 'key',
          description: meta?.decoderConfig?.description
            ? new Uint8Array(meta.decoderConfig.description)
            : undefined,
        });
        encoded++;
        onSample();
        if (decoderDone && encoded >= totalCount) resolve();
      },
      error: (err) => reject(new Error('視訊編碼失敗：' + (err?.message || err))),
    });
    encoder.configure(encConfig);

    // Decoder: decodes input frames → optionally rotates → feeds to encoder
    const decoder = new VideoDecoder({
      output: (frame) => {
        let toEncode = frame;
        if (needsRotation) {
          toEncode = rotateFrame(frame);
          frame.close();
        }
        encoder.encode(toEncode, { keyFrame: decoded % 60 === 0 });
        toEncode.close();
        decoded++;
      },
      error: (err) => reject(new Error('視訊解碼失敗：' + (err?.message || err))),
    });

    // Build decoder config from track info
    const decoderConfig = {
      codec: track.codec,
      codedWidth: track.video?.width || track.track_width,
      codedHeight: track.video?.height || track.track_height,
    };

    // Extract avcC/hvcC description from track (needed for AVC/HEVC decoding)
    if (track.avcC) {
      decoderConfig.description = extractBoxData(track.avcC);
    } else if (track.hvcC) {
      decoderConfig.description = extractBoxData(track.hvcC);
    }

    decoder.configure(decoderConfig);

    // Feed samples to decoder, releasing each sample's data after
    // it's been consumed to avoid holding all compressed frames in memory.
    for (let si = 0; si < samples.length; si++) {
      const s = samples[si];
      const chunk = new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
        duration: Math.round((s.duration / s.timescale) * 1_000_000),
        data: s.data,
      });
      decoder.decode(chunk);
      // Release reference to the compressed frame data so GC can reclaim it
      s.data = null;
      samples[si] = null;
    }

    decoder.flush().then(() => {
      decoderDone = true;
      return encoder.flush();
    }).then(() => {
      if (encoded >= totalCount) resolve();
      // else the output callback will resolve
      decoder.close();
      encoder.close();
    }).catch(reject);
  });
}

// ─── Audio transcode (decode → encode) ───

function transcodeAudioTrack(track, samples, encConfig, output, onSample) {
  return new Promise((resolve, reject) => {
    if (!samples.length) { resolve(); return; }

    let encoded = 0;
    const totalCount = samples.length;
    let decoderDone = false;

    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        output.push({
          data: buf,
          timestamp: chunk.timestamp,
          duration: chunk.duration || 0,
          key: chunk.type === 'key',
          description: meta?.decoderConfig?.description
            ? new Uint8Array(meta.decoderConfig.description)
            : undefined,
        });
        encoded++;
        onSample();
        if (decoderDone && encoded >= totalCount) resolve();
      },
      error: (err) => reject(new Error('音訊編碼失敗：' + (err?.message || err))),
    });
    encoder.configure(encConfig);

    const decoder = new AudioDecoder({
      output: (frame) => {
        encoder.encode(frame);
        frame.close();
      },
      error: (err) => reject(new Error('音訊解碼失敗：' + (err?.message || err))),
    });

    const decoderConfig = {
      codec: track.codec,
      sampleRate: track.audio?.sample_rate || 44100,
      numberOfChannels: track.audio?.channel_count || 2,
    };

    if (track.esds) {
      decoderConfig.description = extractBoxData(track.esds);
    }

    decoder.configure(decoderConfig);

    for (let si = 0; si < samples.length; si++) {
      const s = samples[si];
      const chunk = new EncodedAudioChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
        duration: Math.round((s.duration / s.timescale) * 1_000_000),
        data: s.data,
      });
      decoder.decode(chunk);
      s.data = null;
      samples[si] = null;
    }

    decoder.flush().then(() => {
      decoderDone = true;
      return encoder.flush();
    }).then(() => {
      if (encoded >= totalCount) resolve();
      decoder.close();
      encoder.close();
    }).catch(reject);
  });
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
  const videoTrackId = mp4boxFile.addTrack({
    type: 'video',
    width: videoConfig.width,
    height: videoConfig.height,
    timescale: 90000,
    media_duration: 0,
    nb_samples: encodedVideo.length,
    codec: 'avc1',
    // avcC description from first keyframe
    description: encodedVideo.find(e => e.description)?.description,
  });

  // Add audio track (if we have encoded audio)
  let audioTrackId = null;
  if (encodedAudio.length > 0) {
    audioTrackId = mp4boxFile.addTrack({
      type: 'audio',
      timescale: audioTrackInfo?.audio?.sample_rate || 44100,
      media_duration: 0,
      nb_samples: encodedAudio.length,
      codec: 'mp4a',
      channel_count: audioTrackInfo?.audio?.channel_count || 2,
      samplerate: audioTrackInfo?.audio?.sample_rate || 44100,
      samplesize: 16,
      description: encodedAudio.find(e => e.description)?.description,
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

  // [FIX] Use mergeInitSegments for multi-track (video+audio) init segments.
  // Simple concatenation (concatU8) produces invalid fMP4 with two ftyp+moov
  // blocks. mergeInitSegments properly combines traks into one moov.
  const combinedInit = initParts.length === 1
    ? initParts[0]
    : mergeInitSegments(initParts);

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
