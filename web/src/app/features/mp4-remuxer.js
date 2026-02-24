// /app/features/mp4-remuxer.js
// Remux non-fragmented MP4/MOV to fragmented MP4 (fMP4) using mp4box.js.
// Dynamically loads mp4box.js from CDN on first use. Pure JS, no WASM required.
// This ensures all chunked video uploads are in fMP4 format for MSE/ManagedMediaSource playback.

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
 * Remux a video File/Blob to fragmented MP4 using mp4box.js.
 *
 * Returns a new File/Blob in fMP4 format with contentType 'video/mp4'.
 * If the file is already fMP4, returns it as-is.
 * If the file is WebM, returns it as-is (WebM is natively MSE-compatible).
 * If the format is unsupported, throws UnsupportedVideoFormatError.
 *
 * @param {File|Blob} file - Source video file
 * @returns {Promise<{ file: File|Blob, contentType: string, remuxed: boolean }>}
 */
export async function remuxToFragmentedMp4(file) {
  if (!file) throw new Error('file required');

  const type = (typeof file.type === 'string' ? file.type : '').toLowerCase().trim();
  const name = typeof file.name === 'string' ? file.name : 'video.mp4';

  // WebM doesn't need remuxing — natively MSE-compatible
  if (type === 'video/webm') {
    return { file, contentType: 'video/webm', remuxed: false };
  }

  // Check if this is a remuxable type
  if (!REMUXABLE_TYPES.has(type)) {
    // Check if it's a video/* at all
    if (type.startsWith('video/')) {
      throw new UnsupportedVideoFormatError(`不支援此影片格式：${type}`);
    }
    // Not a video — shouldn't be called, but let it pass through
    return { file, contentType: type || 'application/octet-stream', remuxed: false };
  }

  // Read file to check if already fragmented
  const fileBuffer = await file.arrayBuffer();
  const fileU8 = new Uint8Array(fileBuffer);

  if (isAlreadyFragmented(fileU8)) {
    // Already fMP4 — pass through with corrected content type
    const outFile = new File([fileBuffer], name, { type: 'video/mp4' });
    return { file: outFile, contentType: 'video/mp4', remuxed: false };
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
    let trackCount = 0;
    let tracksConfigured = 0;
    let totalDuration = 0;

    mp4boxFile.onError = (err) => {
      reject(new Error('影片解析失敗：' + (err?.message || err || 'unknown mp4box error')));
    };

    mp4boxFile.onReady = (info) => {
      if (!info || !info.tracks || info.tracks.length === 0) {
        reject(new UnsupportedVideoFormatError('影片不包含任何可播放的音視訊軌道'));
        return;
      }

      totalDuration = info.duration || 0;
      trackCount = info.tracks.length;

      for (const track of info.tracks) {
        // Configure segmentation for each track
        // nbSamples controls segment size — lower = more fragments, higher = fewer
        mp4boxFile.setSegmentOptions(track.id, null, {
          nbSamples: 100 // ~100 samples per segment for good streaming granularity
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
      tracksConfigured++;
    };

    // Feed the entire file to mp4box
    // mp4box requires an ArrayBuffer with a fileStart property
    const buf = fileBuffer.slice(0); // copy
    buf.fileStart = 0;

    try {
      mp4boxFile.appendBuffer(buf);
    } catch (err) {
      reject(new UnsupportedVideoFormatError('無法解析此影片檔案：' + (err?.message || err)));
      return;
    }

    mp4boxFile.flush();

    // Collect all segments and build the final fMP4
    // Give mp4box a moment to process all segments
    setTimeout(() => {
      try {
        const parts = [...initSegments, ...mediaSegments];
        if (parts.length === 0) {
          reject(new UnsupportedVideoFormatError('影片轉檔失敗：無法產生有效的分片格式'));
          return;
        }

        const outputName = name.replace(/\.(mov|m4v|qt)$/i, '.mp4');
        const outFile = new File(parts, outputName, { type: 'video/mp4' });
        resolve({ file: outFile, contentType: 'video/mp4', remuxed: true });
      } catch (err) {
        reject(new Error('影片重封裝失敗：' + (err?.message || err)));
      }
    }, 50);
  });
}
