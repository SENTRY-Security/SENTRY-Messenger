/**
 * MediaHandlingController
 * Manages media preview interactions and modals.
 * Video playback uses MSE (ManagedMediaSource on iOS Safari 17.1+)
 * for streaming encrypted chunks without loading the entire video into memory.
 */

import { BaseController } from './base-controller.js';
import { downloadAndDecrypt } from '../../../features/media.js';
import { downloadChunkedManifest, streamChunks, downloadAllChunks, getChunkUrls } from '../../../features/chunked-download.js';
import { isMseSupported, detectCodecFromInitSegment, buildMimeFromCodecString, createMsePlayer, isValidMseInitSegment, parseInitTimescales, parseMoofTiming } from '../../../features/mse-player.js';
import { mergeInitSegments } from '../../../features/mp4-remuxer.js';
import { renderPdfViewer, cleanupPdfViewer } from '../viewers/pdf-viewer.js';
import { openImageViewer, cleanupImageViewer } from '../viewers/image-viewer.js';
import { openVideoViewer, cleanupVideoViewer } from '../viewers/video-viewer.js';
import { escapeHtml, fmtSize, escapeSelector } from '../ui-utils.js';
import { isDownloadBusy, startDownload, updateDownloadProgress, endDownload } from '../../../features/transfer-progress.js';

export class MediaHandlingController extends BaseController {
    constructor(deps) {
        super(deps);
    }

    /**
     * Show modal loading state.
     */
    _showModalLoading(text) {
        if (typeof this.deps.showModalLoading === 'function') {
            this.deps.showModalLoading(text);
            return;
        }
        // Fallback: open modal manually
        const modalEl = document.getElementById('modal');
        const title = document.getElementById('modalTitle');
        const body = document.getElementById('modalBody');
        if (!modalEl || !title || !body) return;
        modalEl.classList.add('loading-modal');
        title.textContent = text || '載入中…';
        body.innerHTML = '<div class="loading-wrap"><div class="progress-bar" style="width:100%;"><div id="loadingBar" class="progress-inner" style="width:0%;"></div></div><div id="loadingText" class="loading-text"></div></div>';
        this.deps.openPreviewModal?.();
    }

    _updateLoadingModal(state) {
        if (typeof this.deps.updateLoadingModal === 'function') {
            this.deps.updateLoadingModal(state);
            return;
        }
        // Fallback: update DOM directly
        const bar = document.getElementById('loadingBar');
        if (bar && typeof state.percent === 'number') {
            bar.style.width = `${Math.min(Math.max(state.percent, 0), 100)}%`;
        }
        const label = document.getElementById('loadingText');
        if (label && typeof state.text === 'string') {
            label.textContent = state.text;
        }
    }

    /**
     * Update the video overlay DOM in-place without a full re-render.
     */
    _updateVideoOverlayUI(msgId, media) {
        const messagesList = this.elements?.messagesList || document.querySelector('.messages-list');
        if (!messagesList) return;
        const selector = `.message-bubble[data-message-id="${escapeSelector(msgId)}"] .message-file`;
        const wrapper = messagesList.querySelector(selector);
        if (!wrapper) return;
        const renderer = this.deps.getMessageRenderer?.();
        if (renderer && typeof renderer.renderVideoOverlay === 'function') {
            renderer.renderVideoOverlay(wrapper, media, msgId);
        }
    }

    /**
     * Download and play a video inline using MSE streaming.
     * ALL videos use chunked upload with segment-aligned chunks.
     * Each downloaded chunk is a complete fMP4 segment → appendBuffer directly to MSE.
     *
     * No blob is stored in memory — playback streams chunk by chunk.
     * Only one download at a time (enforced by transfer-progress lock).
     */
    async downloadVideoInline(media, msgId) {
        if (!media?.chunked || !media.baseKey || !media.manifestEnvelope) {
            this.deps.showToast?.('影片資料不完整，無法播放');
            return;
        }
        return this.downloadChunkedVideoInline(media, msgId);
    }

    /**
     * Download a chunked video and play via MSE streaming.
     *
     * Each chunk is a complete fMP4 segment (init segment or moof+mdat pair)
     * that can be directly appended to MSE SourceBuffer.
     *
     * Flow:
     * 1. Download manifest → get chunk metadata
     * 2. Download chunk 0 (init segment) → detect codec → init MSE → append
     * 3. Stream remaining chunks → append each to SourceBuffer
     * 4. Playback starts as soon as first media segment is buffered
     */
    async downloadChunkedVideoInline(media, msgId) {
        if (!media || !media.baseKey || !media.manifestEnvelope) return;
        if (media._videoState === 'downloading') return;

        if (isDownloadBusy()) {
            this.deps.showToast?.('目前有檔案正在下載，請稍候再試');
            return;
        }

        // Check MSE support
        if (!isMseSupported()) {
            this.deps.showToast?.('此瀏覽器不支援影片串流播放');
            return;
        }

        media._videoState = 'downloading';
        media._videoProgress = 0;
        this._updateVideoOverlayUI(msgId, media);

        const downloadAbort = new AbortController();
        startDownload(media.name || '影片', () => {
            try { downloadAbort.abort(); } catch {}
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);
            endDownload();
        });

        let msePlayer = null;
        let blobUrl = null; // For blob-URL fallback when MSE init fails

        // Chunk cache: stores all downloaded chunks as Blobs (disk-backed)
        // for seek-triggered re-append after buffer eviction.
        const chunkCache = []; // index → Blob
        let seekCleanup = null; // cleanup function for seek handler

        // Step 1: Open fullscreen video viewer immediately
        const viewer = openVideoViewer({
            name: media.name || '影片',
            size: media.size,
            onClose: () => {
                // User closed the viewer — abort download and release resources
                try { downloadAbort.abort(); } catch {}
                if (seekCleanup) { try { seekCleanup(); } catch {} seekCleanup = null; }
                chunkCache.length = 0; // Release cached Blobs
                if (msePlayer) {
                    try { msePlayer.destroy(); } catch {}
                    msePlayer = null;
                }
                if (blobUrl) {
                    try { URL.revokeObjectURL(blobUrl); } catch {}
                    blobUrl = null;
                }
                try { video.src = ''; video.load(); } catch {}
                endDownload();
                media._videoState = 'idle';
                media._videoProgress = 0;
                this._updateVideoOverlayUI(msgId, media);
            }
        });

        const video = viewer.video;

        // [FIX] Create MSE player and call video.play() SYNCHRONOUSLY before
        // any await, while the user-gesture context from the tap is still valid.
        // On iOS (ManagedMediaSource), non-muted autoplay requires a gesture.
        // The manifest download below is async and would expire the gesture.
        const createPlayer = () => createMsePlayer({
            videoElement: video,
            onError: (err) => {
                console.warn('[mse-player] segment error (non-fatal):', err?.message || err);
            }
        });
        msePlayer = createPlayer();
        viewer.setMsePlayer(msePlayer);
        const mseOpenPromise = msePlayer.open(); // Sets video.src synchronously
        // Call play() immediately — gesture context still active.
        // The browser queues the play and starts when data arrives.
        video.play().catch(() => {});

        let manifest = null;
        try {
            // Step 2: Download and decrypt manifest (async — gesture context lost)
            media._videoProgress = 2;
            this._updateVideoOverlayUI(msgId, media);
            updateDownloadProgress(2);

            // Wait for MSE open, manifest download, AND first batch chunk URL
            // signing all in parallel. Prefetching chunk URLs eliminates the
            // ~100-200ms API round-trip that previously blocked after manifest parse.
            const PREFETCH_BATCH = 20;
            const prefetchIndices = Array.from({ length: PREFETCH_BATCH }, (_, i) => i);
            const [, downloadedManifest, prefetchedUrlMap] = await Promise.all([
                mseOpenPromise,
                downloadChunkedManifest({
                    baseKey: media.baseKey,
                    manifestEnvelope: media.manifestEnvelope,
                    abortSignal: downloadAbort.signal
                }),
                getChunkUrls({ baseKey: media.baseKey, chunkIndices: prefetchIndices, abortSignal: downloadAbort.signal })
                    .catch(() => new Map()) // non-fatal: streamChunks will re-fetch if needed
            ]);
            manifest = downloadedManifest;

            media._videoProgress = 5;
            this._updateVideoOverlayUI(msgId, media);
            updateDownloadProgress(5);

            viewer.updateChunkStats({ total: manifest.totalChunks || 0 });

            // Non-segment-aligned manifests cannot use MSE streaming.
            if (!manifest.segment_aligned || !manifest.tracks) {
                throw new Error('此影片格式不支援串流播放（非分段對齊）');
            }

            // Segment-aligned fMP4 — use MSE streaming with single muxed SourceBuffer.
            const manifestTracks = manifest.tracks;
            const numTracks = manifestTracks.length;
            const isLegacyMultiTrack = numTracks > 1;

            // Per-track timescale map (trackId → timescale) extracted from
            // the init segment. Needed to convert moof baseMediaDecodeTime
            // to seconds for the chunk time index.
            let timescaleMap = {};

            // Chunk time index: chunkTimeIndex[chunkCacheIndex] = { trackId, startTime, duration }
            // Built during initial streaming by parsing each moof's tfdt/trun.
            // Used by seek re-append for precise chunk→time mapping (no guessing).
            const chunkTimeIndex = [];

            let mseInitialized = false;
            let firstMediaAppended = false;
            let consecutiveErrors = 0;
            const MAX_CONSECUTIVE_ERRORS = 5;
            const initChunks = [];
            let streamingComplete = false;
            let userPaused = false; // true when user explicitly pauses via UI

            // Detect user-initiated pauses via the video-viewer's togglePlay
            // intent flag. This replaces the old click-correlation approach
            // which was too broad — any click on the overlay (seekbar, stats,
            // rotate) within 500ms of a browser-initiated pause was mis-
            // classified as a user pause, suppressing auto-resume.
            const onPauseEvent = () => {
                if (streamingComplete || video.ended) return;
                // Check if the video-viewer flagged this as user-initiated
                if (viewer.userPaused) {
                    userPaused = true;
                    return;
                }
                // Browser-initiated pause during streaming — auto-resume after
                // a brief delay so the browser finishes processing whatever
                // triggered the pause (e.g. durationchange, buffer update).
                if (!userPaused) {
                    setTimeout(() => {
                        if (streamingComplete || userPaused || video.ended) return;
                        if (video.paused && !viewer.userPaused && video.readyState >= 2) {
                            console.info('[mse] auto-resuming browser-initiated pause');
                            video.play().catch(() => {});
                        }
                    }, 50);
                }
            };
            const onPlayEvent = () => { userPaused = false; };
            video.addEventListener('pause', onPauseEvent);
            video.addEventListener('play', onPlayEvent);

            // Direct durationchange handler: immediate resume attempt when
            // MediaSource.duration grows incrementally (each segment append
            // extends the timeline) and some browsers pause the video.
            const onDurationChange = () => {
                if (streamingComplete || userPaused || video.ended) return;
                if (video.paused && video.readyState >= 2) {
                    video.play().catch(() => {});
                }
            };
            video.addEventListener('durationchange', onDurationChange);

            // Watchdog: safety net for pauses not covered by the above handlers
            // (e.g. readyState was < 2 at durationchange time but data arrived
            // shortly after). Polls every 200ms.
            const playbackWatchdog = setInterval(() => {
                if (streamingComplete || !mseInitialized || video.ended) return;
                if (userPaused) return;
                if (video.paused && video.readyState >= 2) {
                    video.play().catch(() => {});
                }
            }, 200);

            // Hide buffering overlay only when the video actually has frames
            // (not just when MSE accepts data — that doesn't guarantee decodability).
            const onCanPlay = () => {
                if (!firstMediaAppended) {
                    firstMediaAppended = true;
                    viewer.hideBuffering();
                    // Ensure playback starts — autoplay may have been blocked.
                    // Do NOT use a mute/unmute hack: on mobile browsers,
                    // video.muted=false without a user gesture is silently ignored,
                    // which permanently kills audio. Instead, if autoplay fails,
                    // let the video stay paused — the center play button is visible
                    // and the user can tap to play with a fresh gesture + audio.
                    // The watchdog will also retry play() periodically.
                    if (video.paused && !userPaused) {
                        video.play().catch(() => {
                            // Autoplay blocked — video stays paused, play button visible.
                        });
                    }
                }
            };
            video.addEventListener('canplay', onCanPlay, { once: true });
            // [FIX] Backup: 'loadeddata' fires earlier than 'canplay' on some
            // iOS versions. Use it as additional trigger for hideBuffering/play.
            video.addEventListener('loadeddata', onCanPlay, { once: true });

            const tryInitMse = async (initData, primaryMimeCodec) => {
                const codecs = [];
                // [FIX] Prioritize manifest codec — it's the most authoritative
                // source with the exact profile/level string from the original
                // file. This avoids costly retry cycles where the wrong codec
                // (e.g. H.264) is tried first for HEVC data, causing
                // readyState=ended → destroy/recreate player → download aborts.
                if (primaryMimeCodec) codecs.push(primaryMimeCodec);
                const detected = detectCodecFromInitSegment(initData, 'muxed');
                if (detected && !codecs.includes(detected)) {
                    codecs.push(detected);
                }
                // Standard fallback codecs — try broader profile/level combos
                const fallbackCodecs = [
                    'avc1.42E01E,mp4a.40.2',  // H.264 Baseline + AAC
                    'avc1.4D401E,mp4a.40.2',  // H.264 Main + AAC
                    'avc1.64001E,mp4a.40.2',  // H.264 High + AAC (lower level)
                    'avc1.42E01E',             // H.264 Baseline (video only)
                ];
                for (const cs of fallbackCodecs) {
                    const mime = buildMimeFromCodecString(cs);
                    if (mime && !codecs.includes(mime)) codecs.push(mime);
                }
                if (codecs.length === 0) {
                    throw new Error('無法偵測影片編碼格式');
                }

                let decodeErrors = 0;
                for (let attempt = 0; attempt < codecs.length; attempt++) {
                    const codec = codecs[attempt];
                    try {
                        if (attempt > 0) {
                            console.warn(`[mse] init append failed with ${codecs[attempt - 1]}, retrying with ${codec}`);
                            try { msePlayer.destroy(); } catch {}
                            video.src = '';
                            video.load();
                            msePlayer = createPlayer();
                            viewer.setMsePlayer(msePlayer);
                            await msePlayer.open();
                            // Re-register canplay listener (original {once:true} is lost)
                            video.addEventListener('canplay', () => {
                                if (!firstMediaAppended) {
                                    firstMediaAppended = true;
                                    viewer.hideBuffering();
                                    if (video.paused) video.play().catch(() => {});
                                }
                            }, { once: true });
                            // Re-establish playback intent for user-gesture context
                            video.play().catch(() => {});
                        }
                        msePlayer.addSourceBuffer('muxed', codec);
                        await msePlayer.appendChunk('muxed', initData);
                        console.info(`[mse] init succeeded with ${codec}`);
                        return;
                    } catch (err) {
                        console.warn(`[mse] init attempt ${attempt + 1}/${codecs.length} failed (${codec}):`, err?.message);
                        // Detect decode errors (readyState transitions to "ended").
                        // If 2+ consecutive decode errors occur, the issue is with
                        // the data format, not the codec — bail out early instead
                        // of trying all remaining codecs.
                        if (err?.message?.includes('readyState=ended')) {
                            decodeErrors++;
                            if (decodeErrors >= 2) {
                                console.warn('[mse] data format incompatible with MSE (consecutive decode errors), bailing out');
                                throw err;
                            }
                        }
                        if (attempt === codecs.length - 1) throw err;
                    }
                }
            };

            // Step 3: Stream chunks via MSE (with blob-URL fallback)
            // Downloads are decoupled from MSE appends — fire-and-forget with
            // backpressure prevents MMS endstreaming pause from blocking downloads.
            let chunksReceived = 0;
            let bytesReceived = 0;
            let useBlobFallback = false;
            const blobParts = []; // Collects ALL chunks when blob fallback is active

            const inflightAppends = new Set();
            const MAX_INFLIGHT = 15;
            let appendError = null;
            let mseAbandoned = false; // set when voluntarily switching to blob mid-stream

            // Buffer health check: save first few chunks so we can switch to
            // blob fallback if MSE accepts data but the decoder can't handle it
            // (e.g. wrong codec detected, HEVC on non-HEVC-MSE browser, etc.).
            const BUFFER_HEALTH_SEGMENTS = 4;
            const savedForFallback = [];
            let mediaSegmentsSent = 0;
            let bufferHealthPassed = false;

            for await (const { data, index } of streamChunks({
                baseKey: media.baseKey,
                manifest,
                manifestEnvelope: media.manifestEnvelope,
                abortSignal: downloadAbort.signal,
                prefetchedUrlMap,
                onProgress: ({ percent }) => {
                    const adjusted = 5 + Math.round(percent * 0.9);
                    media._videoProgress = Math.min(95, adjusted);
                    this._updateVideoOverlayUI(msgId, media);
                    updateDownloadProgress(media._videoProgress);
                }
            })) {
                // Check if a previous append triggered a fatal error
                if (appendError) throw appendError;

                chunksReceived++;
                bytesReceived += (data?.byteLength || 0);
                viewer.updateChunkStats({ received: chunksReceived, bytes: bytesReceived });

                // Cache every chunk as a Blob (disk-backed) for seek re-append.
                // Browsers store Blobs >~64KB on disk, so this doesn't add heap pressure.
                chunkCache[index] = new Blob([data]);

                // Blob fallback mode: collect all chunks for later concatenation
                if (useBlobFallback) {
                    blobParts.push(data);
                    continue;
                }

                const isInitSegment = index < numTracks;

                if (isInitSegment) {
                    let initData = data;
                    let primaryMime = null;

                    if (isLegacyMultiTrack) {
                        initChunks.push(data);
                        if (initChunks.length < numTracks) continue;
                        initData = mergeInitSegments(initChunks);
                        const manifestCodec = manifestTracks.map(t => t.codec).filter(Boolean).join(',');
                        primaryMime = manifestCodec ? buildMimeFromCodecString(manifestCodec) : null;
                    } else {
                        const track = manifestTracks[0];
                        primaryMime = track.codec ? buildMimeFromCodecString(track.codec) : null;
                    }

                    // Validate fMP4 format: mvex box is required for MSE.
                    // Regular MP4 (no mvex) plays via blob URL but not MSE.
                    if (!isValidMseInitSegment(initData)) {
                        console.warn('[video] init segment missing mvex box (not fMP4), skipping MSE → blob fallback');
                        useBlobFallback = true;
                        blobParts.push(initData);
                        try { msePlayer.destroy(); } catch {}
                        msePlayer = null;
                        continue;
                    }

                    try {
                        await tryInitMse(initData, primaryMime);
                        mseInitialized = true;
                        savedForFallback.push(initData); // keep for potential blob fallback

                        // Extract per-track timescales from init segment (moov → trak → mdhd).
                        // These are needed to convert moof baseMediaDecodeTime to seconds.
                        timescaleMap = parseInitTimescales(initData);

                        // Set MediaSource.duration upfront to prevent incremental
                        // durationchange events that cause auto-pause on some browsers.
                        if (manifest.duration && msePlayer) {
                            console.info('[video] setting duration upfront:', manifest.duration, 's');
                            msePlayer.setDuration(manifest.duration);
                        } else {
                            console.warn('[video] no manifest.duration — duration will grow incrementally',
                                { duration: manifest.duration, hasMsePlayer: !!msePlayer });
                        }
                    } catch (initErr) {
                        // MSE init failed after all retries — switch to blob fallback
                        console.warn('[video] MSE init failed, switching to blob-URL fallback:', initErr?.message);
                        useBlobFallback = true;
                        blobParts.push(initData);
                        try { msePlayer.destroy(); } catch {}
                        msePlayer = null;
                        continue;
                    }
                } else {
                    if (!mseInitialized) continue;

                    // Build chunk time index: parse moof to get startTime + trackId.
                    // This runs during initial streaming (data is still a Uint8Array)
                    // so there's no extra blob→arrayBuffer cost.
                    const timing = parseMoofTiming(data, timescaleMap);
                    chunkTimeIndex[index] = timing; // null if parse failed (harmless)

                    // Save for potential blob fallback until health check passes
                    if (!bufferHealthPassed) {
                        savedForFallback.push(data);
                    }

                    // Fire-and-forget: don't block downloads waiting for MSE appends.
                    // This is critical for MMS (iOS Safari) where endstreaming pauses
                    // the append queue — blocking here would stall all chunk downloads.
                    const p = msePlayer.appendChunk('muxed', data).then(() => {
                        if (mseAbandoned) return;
                        consecutiveErrors = 0;
                    }, (appendErr) => {
                        if (mseAbandoned) return;
                        consecutiveErrors++;
                        console.warn(`[mse] segment ${index} append failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, appendErr?.message);
                        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            appendError = new Error('MSE 串流持續失敗');
                            try { downloadAbort.abort(); } catch {}
                        }
                    });
                    inflightAppends.add(p);
                    p.finally(() => inflightAppends.delete(p));
                    mediaSegmentsSent++;

                    // Buffer health check: after N segments, verify the video decoder
                    // is actually producing output. If MSE accepted data but the buffer
                    // is empty (codec mismatch, HEVC on non-HEVC browser, etc.),
                    // abandon MSE and switch to blob-URL fallback.
                    if (!bufferHealthPassed && mediaSegmentsSent === BUFFER_HEALTH_SEGMENTS) {
                        // Wait for pending appends to settle (with safety timeout)
                        if (inflightAppends.size > 0) {
                            const healthWait = new Promise(r => setTimeout(r, 3_000));
                            await Promise.race([Promise.allSettled([...inflightAppends]), healthWait]);
                        }
                        const hasBuffer = video.buffered?.length > 0;
                        const hasMeta = video.readyState >= 1;
                        if (!hasBuffer && !hasMeta) {
                            console.warn(`[video] MSE buffer empty after ${mediaSegmentsSent} segments `
                                + `(readyState=${video.readyState}), switching to blob fallback`);
                            mseAbandoned = true;
                            appendError = null;
                            consecutiveErrors = 0;
                            inflightAppends.clear();
                            blobParts.push(...savedForFallback);
                            savedForFallback.length = 0;
                            useBlobFallback = true;
                            try { msePlayer.destroy(); } catch {}
                            msePlayer = null;
                            mseInitialized = false;
                            continue;
                        } else {
                            bufferHealthPassed = true;
                            savedForFallback.length = 0; // free memory
                        }
                    }

                    // Backpressure: if too many appends in-flight, wait for one to settle.
                    // Safety timeout prevents permanent deadlock if all appends are stuck
                    // (e.g. eviction hang, MMS endstreaming pause with no resume).
                    if (inflightAppends.size >= MAX_INFLIGHT) {
                        const BACKPRESSURE_TIMEOUT = 10_000;
                        const timeout = new Promise(r => setTimeout(r, BACKPRESSURE_TIMEOUT));
                        await Promise.race([Promise.race(inflightAppends), timeout]);
                    }
                }
            }

            // Check for deferred append errors (skip if we voluntarily abandoned MSE)
            if (appendError && !mseAbandoned) throw appendError;

            // Streaming complete — disable watchdog so user pause works normally
            streamingComplete = true;
            clearInterval(playbackWatchdog);
            video.removeEventListener('durationchange', onDurationChange);
            video.removeEventListener('pause', onPauseEvent);
            video.removeEventListener('play', onPlayEvent);

            if (useBlobFallback) {
                // All chunks collected — create blob URL and play natively
                console.info(`[video] blob fallback: ${blobParts.length} parts, ${bytesReceived} bytes`);
                const blob = new Blob(blobParts, { type: manifest.contentType || 'video/mp4' });
                blobParts.length = 0; // Release references

                blobUrl = URL.createObjectURL(blob);
                video.src = blobUrl;
                video.load();

                video.addEventListener('canplay', () => viewer.hideBuffering(), { once: true });
                try { await video.play(); } catch { /* autoplay may be blocked */ }
            } else if (msePlayer) {
                // Wait for all in-flight appends to settle before signaling EOS
                if (inflightAppends.size > 0) {
                    await Promise.allSettled(inflightAppends);
                }
                if (appendError) throw appendError;
                await msePlayer.endOfStream();

                // Log chunk time index summary for diagnostics
                {
                    const validEntries = chunkTimeIndex.filter(Boolean);
                    if (validEntries.length > 0) {
                        const first = validEntries[0];
                        const last = validEntries[validEntries.length - 1];
                        console.info(`[video-seek] chunkTimeIndex: ${validEntries.length} entries, ` +
                            `range ${first.startTime.toFixed(1)}s–${(last.startTime + last.duration).toFixed(1)}s, ` +
                            `trackIds: ${[...new Set(validEntries.map(e => e.trackId))].join(',')}`);
                    } else {
                        console.warn('[video-seek] chunkTimeIndex: 0 valid entries — seek re-append will not work');
                    }
                }

                // ── Seek-aware re-append ──
                // All chunks are now cached as Blobs. Set up a handler that
                // re-appends chunks from cache when the user seeks to an
                // evicted (unbuffered) region.
                if (chunkCache.length > 0) {
                    seekCleanup = this._setupSeekReappend({
                        video, viewer, msePlayer, chunkCache, numTracks, chunkTimeIndex
                    });
                }
            }

            endDownload();
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);

        } catch (err) {
            // Clean up watchdog and listeners
            streamingComplete = true;
            clearInterval(playbackWatchdog);
            try {
                video.removeEventListener('durationchange', onDurationChange);
                video.removeEventListener('pause', onPauseEvent);
                video.removeEventListener('play', onPlayEvent);
            } catch {}

            // Release seek handler and chunk cache
            if (seekCleanup) { try { seekCleanup(); } catch {} seekCleanup = null; }
            chunkCache.length = 0;

            // Release MSE resources
            if (msePlayer) {
                try { msePlayer.destroy(); } catch {}
                msePlayer = null;
            }
            if (blobUrl) {
                try { URL.revokeObjectURL(blobUrl); } catch {}
                blobUrl = null;
            }
            try { video.src = ''; video.load(); } catch {}

            if (err?.name === 'AbortError' || (err instanceof DOMException && err.message === 'aborted')) {
                endDownload();
                // Viewer was already closed by onClose callback or user action
                return;
            }

            console.error('[video] MSE playback failed:', err?.message);

            endDownload();
            media._videoState = 'idle';
            media._videoProgress = 0;
            this._updateVideoOverlayUI(msgId, media);
            viewer.destroy();
            this.deps.showToast?.(`影片播放失敗：${err?.message || err}`);
        }
    }

    /**
     * Set up seek-aware re-append for MSE playback.
     *
     * After all chunks are downloaded and endOfStream() is called, the MSE
     * buffer may have been partially evicted. When the user seeks to an
     * evicted region, this handler re-appends the relevant chunks from the
     * disk-backed Blob cache so playback can resume at the seek position.
     *
     * @returns {Function} cleanup — call to remove all event listeners
     */
    _setupSeekReappend({ video, viewer, msePlayer, chunkCache, numTracks, chunkTimeIndex }) {
        let reappending = false;
        let seekTimer = null;
        let destroyed = false;
        let pendingSeekTime = null; // Track seek that arrived during re-append

        /**
         * Find chunk indices whose time range overlaps [seekTime - margin, seekTime + margin].
         * Uses the precise chunkTimeIndex built during initial streaming.
         * Returns a sorted array of chunk cache indices.
         */
        const findChunksForTime = (seekTime, margin = 1.0) => {
            const lo = seekTime - margin;
            const hi = seekTime + margin;
            const indices = [];
            for (let i = numTracks; i < chunkCache.length; i++) {
                const t = chunkTimeIndex[i];
                if (!t) continue;
                const segEnd = t.startTime + t.duration;
                // Overlaps if segment start < hi AND segment end > lo
                if (t.startTime < hi && segEnd > lo) {
                    indices.push(i);
                }
            }
            return indices;
        };

        /**
         * Read specific chunk blobs and append them to MSE.
         */
        const appendChunks = async (indices) => {
            if (!indices.length) return;
            const BATCH = 8;
            let appendedCount = 0;
            for (let b = 0; b < indices.length; b += BATCH) {
                if (destroyed || !msePlayer) break;
                // Safety: re-resume and reset queues before each batch in case
                // something paused or stuck them despite endstreaming suppression.
                msePlayer.resetQueuesForSeek();
                const batch = indices.slice(b, b + BATCH);
                const blobReads = [];
                for (const idx of batch) {
                    if (!chunkCache[idx]) {
                        console.warn(`[video-seek] chunkCache[${idx}] is empty`);
                        continue;
                    }
                    blobReads.push(chunkCache[idx].arrayBuffer());
                }
                if (blobReads.length === 0) continue;
                const bufs = await Promise.all(blobReads.map(async (p) => new Uint8Array(await p)));
                // Append sequentially to avoid queue ordering issues
                for (const data of bufs) {
                    if (destroyed || !msePlayer) break;
                    try {
                        await msePlayer.appendChunk('muxed', data);
                        appendedCount++;
                    } catch (err) {
                        console.warn('[video-seek] append error:', err?.message);
                    }
                }
            }
            console.info(`[video-seek] appendChunks done: ${appendedCount}/${indices.length} appended`);
        };

        const doReappend = async (seekTime) => {
            if (destroyed || !msePlayer) return;
            if (reappending) {
                // Another re-append in progress — remember this seek for later
                pendingSeekTime = seekTime;
                return;
            }

            const dur = video.duration;
            if (!dur || !isFinite(dur) || dur <= 0) return;

            // Check if there's enough buffer AHEAD of the seek position.
            // A simple isTimeBuffered(seekTime) with tolerance can return true
            // even when seekTime is at the very edge of the buffer — there's
            // technically "buffered" data at that point, but not enough ahead
            // for continued playback. Require at least 0.5s of buffer ahead.
            const hasEnoughBuffer = (() => {
                try {
                    const buf = video.buffered;
                    for (let i = 0; i < buf.length; i++) {
                        if (seekTime >= buf.start(i) - 0.1 && seekTime <= buf.end(i) - 0.5) {
                            return true; // seekTime is well inside this range (not at edge)
                        }
                    }
                } catch {}
                return false;
            })();
            if (hasEnoughBuffer) return;

            reappending = true;
            viewer.showBuffering('載入中…');

            try {
                // Disable eviction during re-append to protect freshly-appended data
                msePlayer.setEvictionEnabled(false);

                // CRITICAL (MMS fix): Suppress the endstreaming handler during
                // re-append. On iOS Safari MMS, endstreaming can fire at any time
                // (e.g. when the browser decides it has "enough" data from the old
                // buffer regions), which pauses all queues mid-re-append. This
                // causes most chunks to never actually get appended, leaving the
                // buffer at the wrong position.
                msePlayer.setSuppressEndStreaming(true);

                // On MMS (iOS Safari), after endOfStream() the SourceBuffer may
                // not process appendBuffer() calls until the browser fires
                // 'startstreaming'. Wait briefly for this event before appending.
                await msePlayer.prepareForSeekAppend();

                // Force-reset all SourceBuffer queues: abort any stuck operations,
                // clear the `appending` flag (which can stay stuck if updateend was
                // missed after endOfStream on MMS), unpause, and kick processQueue.
                // Without this, the queue deadlocks and no chunks are appended.
                msePlayer.resetQueuesForSeek();

                // Use precise chunk time index to find exactly which chunks
                // cover the seek position. Start with ±5s margin to ensure
                // enough data AHEAD for continuous playback (not just at the
                // exact seek point), and widen if needed.
                let margin = 5.0;
                let indices = findChunksForTime(seekTime, margin);

                // Progressively widen until we find chunks (handles edge cases
                // where segment boundaries don't align perfectly)
                while (indices.length === 0 && margin <= 30) {
                    margin += 3;
                    indices = findChunksForTime(seekTime, margin);
                }

                // Log chunk timing details for diagnostics
                if (indices.length > 0) {
                    const timingInfo = indices.map(i => {
                        const t = chunkTimeIndex[i];
                        return t ? `[${i}]${t.startTime.toFixed(1)}-${(t.startTime + t.duration).toFixed(1)}s` : `[${i}]null`;
                    }).join(', ');
                    console.info(`[video-seek] seek=${seekTime.toFixed(1)}s ±${margin}s → ${indices.length} chunks: ${timingInfo}`);
                } else {
                    console.warn(`[video-seek] no chunks found for ${seekTime.toFixed(1)}s ±${margin}s (index count: ${chunkTimeIndex.filter(Boolean).length})`);
                }

                // Safety timeout: cap total re-append time.
                const REAPPEND_TIMEOUT = 5_000;
                const timeoutPromise = new Promise(r => setTimeout(r, REAPPEND_TIMEOUT));
                await Promise.race([appendChunks(indices), timeoutPromise]);

                // If still not buffered after precise chunks, widen further
                if (!destroyed && msePlayer && !msePlayer.isTimeBuffered(seekTime)) {
                    const widerIndices = findChunksForTime(seekTime, margin + 10)
                        .filter(i => !indices.includes(i));
                    if (widerIndices.length > 0) {
                        console.info(`[video-seek] widening: +${widerIndices.length} chunks`);
                        await Promise.race([appendChunks(widerIndices), timeoutPromise]);
                    }
                }

                // Log post-append buffer state
                if (!destroyed && msePlayer) {
                    const buffered = msePlayer.isTimeBuffered(seekTime);
                    const ranges = [];
                    try {
                        const buf = video.buffered;
                        for (let i = 0; i < buf.length; i++) {
                            ranges.push(`${buf.start(i).toFixed(1)}-${buf.end(i).toFixed(1)}`);
                        }
                    } catch {}
                    console.info(`[video-seek] post-append: buffered@${seekTime.toFixed(1)}s=${buffered}, ranges=[${ranges.join(', ')}]`);
                }

                // Re-signal end of stream so the browser knows the full
                // timeline. appendBuffer() transitions readyState from
                // 'ended' → 'open'; we must transition back to 'ended'
                // so the seekbar/duration remain correct.
                if (!destroyed && msePlayer) {
                    await msePlayer.endOfStream();
                }
            } catch (err) {
                console.warn('[video-seek] re-append failed:', err?.message);
            } finally {
                // Restore endstreaming handling and re-enable eviction
                if (msePlayer) {
                    msePlayer.setSuppressEndStreaming(false);
                    msePlayer.setEvictionEnabled(true);
                }
                reappending = false;

                // Resume playback after re-append. The initial streaming's
                // auto-resume watchdog was already cleared (streamingComplete),
                // so without an explicit play() the video stays paused after
                // seeking to an evicted region.
                if (!destroyed && video.paused && !viewer.userPaused) {
                    video.play().catch(() => {});
                }

                // ALWAYS hide spinner before potentially recursing.
                // Previously, the pendingSeekTime branch returned early
                // and the recursive doReappend could return early too
                // (hasEnoughBuffer=true), leaving the overlay stuck.
                viewer.hideBuffering();

                // If another seek arrived during this re-append, process it now
                if (pendingSeekTime !== null && !destroyed) {
                    const nextTime = pendingSeekTime;
                    pendingSeekTime = null;
                    doReappend(nextTime);
                }
            }
        };

        // Debounced seek handler — waits for drag to settle before re-appending.
        // Also cancels any pending onWaiting trigger to avoid double re-append.
        const onSeek = (seekTime) => {
            if (seekTimer) clearTimeout(seekTimer);
            if (waitingReappendTimer) { clearTimeout(waitingReappendTimer); waitingReappendTimer = null; }
            seekTimer = setTimeout(() => doReappend(seekTime), 250);
        };

        // Register via the viewer's callback system
        viewer.onSeeking(onSeek);

        // Also handle 'waiting' event: video stalled at end of buffered range
        // (e.g. user watched past our re-appended window). Debounce to avoid
        // double-triggering with onSeek — the seeking event often fires right
        // before waiting, and we don't want two concurrent re-appends.
        let waitingReappendTimer = null;
        const onWaiting = () => {
            if (destroyed || reappending || !msePlayer) return;
            // If a seek-triggered re-append is already scheduled, skip
            if (seekTimer) return;
            if (waitingReappendTimer) return;
            waitingReappendTimer = setTimeout(() => {
                waitingReappendTimer = null;
                if (!destroyed && !reappending && msePlayer) {
                    doReappend(video.currentTime);
                }
            }, 300);
        };
        video.addEventListener('waiting', onWaiting);

        // Return cleanup function
        return () => {
            destroyed = true;
            if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; }
            if (waitingReappendTimer) { clearTimeout(waitingReappendTimer); waitingReappendTimer = null; }
            video.removeEventListener('waiting', onWaiting);
        };
    }

    /**
     * Open media preview modal.
     */
    async openMediaPreview(media) {
        if (!media) return;
        try {
            const displayName = media.name || '附件';
            let result = null;

            if (media.chunked && media.baseKey && media.manifestEnvelope) {
                // Chunked file (large non-video files uploaded via chunked path)
                this._showModalLoading('下載加密檔案中…');
                this._updateLoadingModal({ percent: 5, text: '取得解密資訊中…' });
                const manifest = await downloadChunkedManifest({
                    baseKey: media.baseKey,
                    manifestEnvelope: media.manifestEnvelope
                });
                this._updateLoadingModal({ percent: 10, text: '下載加密分片中…' });
                result = await downloadAllChunks({
                    baseKey: media.baseKey,
                    manifest,
                    manifestEnvelope: media.manifestEnvelope,
                    onProgress: ({ percent: pct }) => {
                        if (Number.isFinite(pct)) {
                            const mapped = 10 + Math.round(pct * 0.85);
                            this._updateLoadingModal({ percent: mapped, text: `下載加密分片中… ${pct}%` });
                        }
                    }
                });
                this._updateLoadingModal({ percent: 98, text: '組裝檔案中…' });
            } else if (media.objectKey && media.envelope) {
                this._showModalLoading('下載加密檔案中…');
                result = await downloadAndDecrypt({
                    key: media.objectKey,
                    envelope: media.envelope,
                    messageKeyB64: media.messageKey_b64 || media.message_key_b64 || null,
                    onStatus: ({ stage, loaded, total }) => {
                        if (stage === 'sign') {
                            this._updateLoadingModal({ percent: 5, text: '取得下載授權中…' });
                        } else if (stage === 'download-start') {
                            this._updateLoadingModal({ percent: 10, text: '下載加密檔案中…' });
                        } else if (stage === 'download') {
                            const pct = total && total > 0 ? Math.round((loaded / total) * 100) : null;
                            const percent = pct != null ? Math.min(95, Math.max(15, pct)) : 45;
                            const text = pct != null
                                ? `下載加密檔案中… ${pct}% (${fmtSize(loaded)} / ${fmtSize(total)})`
                                : `下載加密檔案中… (${fmtSize(loaded)})`;
                            this._updateLoadingModal({ percent, text });
                        } else if (stage === 'decrypt') {
                            this._updateLoadingModal({ percent: 98, text: '解密檔案中…' });
                        }
                    }
                });
            } else if (media.localUrl) {
                this._showModalLoading(`準備 ${displayName}…`);
                const response = await fetch(media.localUrl);
                if (!response.ok) throw new Error('讀取本機預覽失敗');
                const blob = await response.blob();
                result = {
                    blob,
                    contentType: media.contentType || blob.type || 'application/octet-stream',
                    name: displayName
                };
            } else {
                throw new Error('無法預覽：無效的檔案來源');
            }

            await this.renderMediaPreviewModal({
                blob: result.blob,
                contentType: result.contentType || media.contentType || 'application/octet-stream',
                name: result.name || displayName
            });
        } catch (err) {
            console.error('Media preview error', err);
            this.deps.closePreviewModal?.();
            this.deps.showToast?.(`附件預覽失敗：${err?.message || err}`);
        }
    }

    /**
     * Render the actual preview modal content.
     */
    async renderMediaPreviewModal({ blob, contentType, name }) {
        const modalEl = document.getElementById('modal');
        const body = document.getElementById('modalBody');
        const title = document.getElementById('modalTitle');

        if (!modalEl || !body || !title) {
            this.deps.closePreviewModal?.();
            this.deps.showToast?.('無法顯示附件預覽');
            return;
        }

        cleanupPdfViewer();

        // Clear all modal classes
        const classesToRemove = [
            'loading-modal', 'progress-modal', 'folder-modal', 'upload-modal',
            'confirm-modal', 'nickname-modal', 'avatar-modal',
            'avatar-preview-modal', 'settings-modal'
        ];
        modalEl.classList.remove(...classesToRemove);

        body.innerHTML = '';
        const resolvedName = name || '附件';
        title.textContent = resolvedName;
        title.setAttribute('title', resolvedName);

        const url = URL.createObjectURL(blob);

        const downloadBtn = document.getElementById('modalDownload');
        if (downloadBtn) {
            downloadBtn.style.display = 'none';
            downloadBtn.onclick = null;
        }

        const container = document.createElement('div');
        container.className = 'preview-wrap';
        const wrap = document.createElement('div');
        wrap.className = 'viewer';
        container.appendChild(wrap);
        body.appendChild(container);

        const ct = (contentType || '').toLowerCase();

        const openModal = () => this.deps.openPreviewModal?.();
        const closeModal = () => this.deps.closePreviewModal?.();
        const showConfirm = this.deps.showConfirmModal;

        if (ct === 'application/pdf' || ct.startsWith('application/pdf')) {
            const handled = await renderPdfViewer({
                url,
                name: resolvedName,
                modalApi: { openModal, closeModal, showConfirmModal: showConfirm }
            });
            if (handled) {
                this.deps.openPreviewModal?.();
                return;
            }

            const msg = document.createElement('div');
            msg.className = 'preview-message';
            msg.innerHTML = `PDF 無法內嵌預覽，將直接下載。<br/><br/><a class="primary" href="${url}" download="${escapeHtml(resolvedName)}">下載檔案</a>`;
            wrap.appendChild(msg);
        } else if (ct.startsWith('image/')) {
            // Use full-screen image viewer instead of basic modal
            closeModal?.();
            const onSendToChat = async (editedFile) => {
                const messageSending = this.deps.controllers?.messageSending;
                if (messageSending) {
                    await messageSending.handleComposerFileSelection({ target: { files: [editedFile] } });
                }
            };
            openImageViewer({
                url,
                blob,
                name: resolvedName,
                contentType: ct,
                source: 'chat',
                onSendToChat,
                onClose: () => {
                    try { URL.revokeObjectURL(url); } catch {}
                }
            });
            return;
        } else if (ct.startsWith('video/')) {
            const video = document.createElement('video');
            video.src = url;
            video.controls = true;
            video.playsInline = true;
            video.autoplay = true;
            wrap.appendChild(video);
            // Revoke blob URL when modal closes to free memory
            const videoCleanup = () => {
                try { URL.revokeObjectURL(url); } catch {}
                video.src = '';
                video.load();
            };
            const obs = new MutationObserver(() => {
                if (!modalEl.classList.contains('active') || modalEl.style.display === 'none') {
                    videoCleanup();
                    obs.disconnect();
                }
            });
            obs.observe(modalEl, { attributes: true, attributeFilter: ['class', 'style'] });
        } else if (ct.startsWith('audio/')) {
            const audio = document.createElement('audio');
            audio.src = url;
            audio.controls = true;
            wrap.appendChild(audio);
        } else if (ct.startsWith('text/')) {
            try {
                const textContent = await blob.text();
                const pre = document.createElement('pre');
                pre.textContent = textContent;
                wrap.appendChild(pre);
            } catch {
                const msg = document.createElement('div');
                msg.className = 'preview-message';
                msg.textContent = '無法顯示文字內容。';
                wrap.appendChild(msg);
            }
        } else {
            const message = document.createElement('div');
            message.style.textAlign = 'center';
            message.innerHTML = `無法預覽此類型（${escapeHtml(contentType || '未知')}）。<br/><br/>`;
            const link = document.createElement('a');
            link.href = url;
            link.download = resolvedName;
            link.textContent = '下載檔案';
            link.className = 'primary';
            message.appendChild(link);
            wrap.appendChild(message);
        }

        this.deps.openPreviewModal?.();
    }
}
