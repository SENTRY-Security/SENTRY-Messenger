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

// ─── Build encoder configs from mp4box track info ───

function videoEncoderConfig(track) {
  // Target: H.264 Baseline for maximum MSE compatibility
  return {
    codec: 'avc1.42001E', // Baseline profile, level 3.0
    width: track.video?.width || track.track_width || 640,
    height: track.video?.height || track.track_height || 480,
    bitrate: Math.min(
      (track.bitrate || 2_000_000),
      5_000_000
    ),
    framerate: track.video?.frame_rate || track.timescale / (track.samples_duration / track.nb_samples) || 30,
    latencyMode: 'quality',
    avc: { format: 'avc' }, // Annex-B → mp4box expects AVC (length-prefixed)
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
export async function transcodeToFmp4(file, { onProgress } = {}) {
  if (!file) throw new Error('file required');
  if (!isWebCodecsSupported()) return null; // fallback to remux

  onProgress?.({ phase: 'load', percent: 0 });

  // 1. Load mp4box.js (cached after first load)
  const mp4boxMod = await loadMp4box();
  onProgress?.({ phase: 'load', percent: 100 });

  // 2. Demux: parse input to discover tracks and extract samples
  onProgress?.({ phase: 'encode', percent: 0 });

  const { tracks: inputTracks, samples: inputSamples, duration } =
    await demuxFile(file, mp4boxMod);

  if (inputTracks.length === 0) {
    throw new Error('影片不包含可播放的音視訊軌道');
  }

  // 3. Check if transcoding is actually needed
  if (!needsTranscode(inputTracks)) {
    // Already MSE-safe → return null so caller uses fast remux path
    return null;
  }

  // 4. Transcode via WebCodecs
  const result = await doTranscode(inputTracks, inputSamples, duration, mp4boxMod, onProgress);
  return result;
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

    try {
      const buf = await file.arrayBuffer();
      buf.fileStart = 0;
      mp4boxFile.appendBuffer(buf);
      mp4boxFile.flush();
    } catch (err) {
      reject(new Error('無法解析此影片：' + (err?.message || err)));
      return;
    }

    // mp4box processes synchronously; small delay for safety
    setTimeout(() => {
      resolve({ tracks, samples, duration: fileDuration });
    }, 50);
  });
}

// ─── Transcode pipeline ───

async function doTranscode(inputTracks, inputSamples, duration, mp4boxMod, onProgress) {
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

  const vEncConfig = videoEncoderConfig(videoTrack);

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

  // ── Audio: passthrough if AAC, else re-encode ──

  if (audioTrack) {
    const audioCodec = (audioTrack.codec || '').toLowerCase();
    if (MSE_SAFE_AUDIO.test(audioCodec)) {
      // AAC passthrough — no re-encoding needed
      for (const s of (inputSamples[audioTrack.id] || [])) {
        encodedAudio.push({
          data: new Uint8Array(s.data),
          timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
          duration: Math.round((s.duration / s.timescale) * 1_000_000),
          key: s.is_sync,
        });
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
  }

  onProgress?.({ phase: 'encode', percent: 95 });

  // ── Mux into fMP4 segments ──

  const segments = await muxToFmp4(encodedVideo, encodedAudio, vEncConfig, audioTrack, mp4boxMod);

  onProgress?.({ phase: 'encode', percent: 100 });

  // Build codec string
  const codecs = ['avc1.42001E'];
  if (encodedAudio.length > 0) codecs.push('mp4a.40.2');
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

    // Decoder: decodes input frames → feeds to encoder
    const decoder = new VideoDecoder({
      output: (frame) => {
        encoder.encode(frame, { keyFrame: decoded % 60 === 0 });
        frame.close();
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

    // Feed samples to decoder
    for (const s of samples) {
      const chunk = new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
        duration: Math.round((s.duration / s.timescale) * 1_000_000),
        data: s.data,
      });
      decoder.decode(chunk);
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

    for (const s of samples) {
      const chunk = new EncodedAudioChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
        duration: Math.round((s.duration / s.timescale) * 1_000_000),
        data: s.data,
      });
      decoder.decode(chunk);
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

  // Add video samples
  for (const frame of encodedVideo) {
    const tsInTimescale = Math.round((frame.timestamp / 1_000_000) * 90000);
    const durInTimescale = Math.round((frame.duration / 1_000_000) * 90000);
    mp4boxFile.addSample(videoTrackId, frame.data.buffer, {
      duration: durInTimescale || 3000,
      is_sync: frame.key,
      cts: tsInTimescale,
      dts: tsInTimescale,
    });
  }

  // Add audio samples
  if (audioTrackId) {
    const audioTimescale = audioTrackInfo?.audio?.sample_rate || 44100;
    for (const frame of encodedAudio) {
      const tsInTimescale = Math.round((frame.timestamp / 1_000_000) * audioTimescale);
      const durInTimescale = Math.round((frame.duration / 1_000_000) * audioTimescale);
      mp4boxFile.addSample(audioTrackId, frame.data.buffer, {
        duration: durInTimescale || 1024,
        is_sync: frame.key !== false,
        cts: tsInTimescale,
        dts: tsInTimescale,
      });
    }
  }

  // Collect init segments
  const initSegs = mp4boxFile.initializeSegmentation();
  const initParts = initSegs.map(s => new Uint8Array(s.buffer));

  // Merge init segments into one
  const combinedInit = initParts.length === 1
    ? initParts[0]
    : concatU8(initParts);

  segments.push({ trackIndex: 0, data: combinedInit });

  // Collect media segments
  const mediaSegs = [];
  mp4boxFile.onSegment = (id, _user, buffer) => {
    mediaSegs.push(new Uint8Array(buffer));
  };

  mp4boxFile.start();

  // Media segments are produced synchronously by start()
  for (const seg of mediaSegs) {
    segments.push({ trackIndex: 0, data: seg });
  }

  return segments;
}
