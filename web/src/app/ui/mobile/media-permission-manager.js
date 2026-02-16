// Media (microphone) permission prompt management
//
// Usage:
//   const mgr = createMediaPermissionManager({ overlay, allowBtn, ... , deps: { log, showToast, ... } });
//   mgr.init();

import { getMicrophoneConstraintProfiles, isConstraintUnsatisfiedError, isAutomationEnvironment } from './browser-detection.js';

export function createMediaPermissionManager({
  overlay,
  allowBtn,
  allowLabel,
  skipBtn,
  debugBtn,
  statusEl,
  mediaPermissionKey,
  audioPermissionKey,
  deps
}) {
  const { log, showToast, sessionStore, resumeNotifyAudioContext, audioManager } = deps;

  let systemGranted = false;
  let activePrompt = null;
  let pollingTimer = null;
  let onChangeCleanup = null;
  let cachedMicStream = null;
  let finalized = false;

  // --- Internal helpers ---

  function setStatus(message = '', { success = false } = {}) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('success', !!message && success);
    if (!success) statusEl.classList.remove('success');
  }

  function hide() {
    if (!overlay) return;
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
    if (onChangeCleanup) { onChangeCleanup(); onChangeCleanup = null; }
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('media-permission-open');
    if (allowBtn) allowBtn.disabled = false;
    setStatus('');
  }

  function show() {
    if (!overlay) return;
    finalized = false;
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('media-permission-open');
    setStatus('');
    allowBtn?.focus?.();
  }

  function hasFlag() {
    if (typeof sessionStorage === 'undefined') return false;
    try { return sessionStorage.getItem(mediaPermissionKey) === 'granted'; } catch { return false; }
  }

  function markGranted() {
    if (typeof sessionStorage === 'undefined') return;
    try { sessionStorage.setItem(mediaPermissionKey, 'granted'); } catch { }
    try { sessionStorage.setItem(audioPermissionKey, 'granted'); } catch { }
  }

  function setButtonState() {
    if (!allowBtn || !allowLabel) return;
    allowBtn.classList.remove('state-confirm');
    allowBtn.disabled = false;
    allowLabel.textContent = '允許麥克風與鏡頭';
  }

  function stopStreamTracks(stream) {
    if (!stream?.getTracks) return;
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { }
    }
  }

  function isLiveStream(stream) {
    if (!stream?.getAudioTracks) return false;
    return stream.getAudioTracks().some((track) => track?.readyState === 'live');
  }

  function cacheStream(stream) {
    if (!isLiveStream(stream)) return null;
    if (cachedMicStream && cachedMicStream !== stream) {
      try { stopStreamTracks(cachedMicStream); } catch { }
    }
    cachedMicStream = stream;
    try { sessionStore.cachedMicrophoneStream = stream; } catch { }
    return cachedMicStream;
  }

  async function collectPermissionSignals() {
    const result = { permState: null, hasLabel: false };
    if (typeof navigator === 'undefined') return result;
    const { permissions, mediaDevices } = navigator;
    if (permissions?.query) {
      try { result.permState = (await permissions.query({ name: 'microphone' }))?.state || null; } catch { }
    }
    if (mediaDevices?.enumerateDevices) {
      try {
        const devices = await mediaDevices.enumerateDevices();
        result.hasLabel = Array.isArray(devices)
          && devices.some((device) => device.kind === 'audioinput' && device.label && device.label.trim());
      } catch { }
    }
    return result;
  }

  async function requestAccess({ timeoutMs = 5000 } = {}) {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('瀏覽器不支援媒體授權，請改用最新版 Safari / Chrome。');
    }
    const withTimeout = (promise, label) => Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${label || 'media'} timeout`)), timeoutMs);
      })
    ]);
    const videoConstraints = {
      facingMode: 'user',
      width: { ideal: 960 },
      height: { ideal: 540 },
      frameRate: { ideal: 30 }
    };
    const profiles = getMicrophoneConstraintProfiles();
    let lastError = null;
    let skipVideo = false;

    // Phase 1: try audio + video together so both permissions are granted
    // in a single browser prompt and the cached stream includes video tracks
    // for attachLocalMedia() to reuse later.
    for (let i = 0; i < profiles.length && !skipVideo; i += 1) {
      const audioConstraint = profiles[i].audio;
      try {
        const stream = await withTimeout(
          navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: videoConstraints }),
          'audio+video'
        );
        cacheStream(stream);
        return { audioGranted: true, videoGranted: true };
      } catch (err) {
        lastError = err;
        if (isConstraintUnsatisfiedError(err)) {
          log({ mediaPermissionConstraintRetry: { name: err?.name, message: err?.message, phase: 'audio+video', nextProfile: i < profiles.length - 1 } });
          continue;
        }
        // Video might be the issue (denied / not found) — fall through to audio-only
        skipVideo = true;
      }
    }

    // Phase 2: audio-only fallback — camera might be unavailable or denied
    for (let i = 0; i < profiles.length; i += 1) {
      const constraints = profiles[i];
      try {
        const audioStream = await withTimeout(navigator.mediaDevices.getUserMedia(constraints), 'audio');
        cacheStream(audioStream);
        log({ mediaPermissionVideoSkipped: { reason: lastError?.name || lastError?.message || 'unknown' } });
        return { audioGranted: true, videoGranted: false };
      } catch (err) {
        lastError = err;
        if (!isConstraintUnsatisfiedError(err)) throw err || new Error('需要授權麥克風才能繼續使用語音通話');
        log({ mediaPermissionConstraintRetry: { name: err?.name, message: err?.message, phase: 'audio-only', nextProfile: i < profiles.length - 1 } });
      }
    }
    throw lastError || new Error('需要授權麥克風才能繼續使用語音通話');
  }

  function describeError(err) {
    if (!err) return '授權失敗，請在瀏覽器或系統設定中允許麥克風與鏡頭。';
    const message = String(err?.message || '').toLowerCase();
    const name = (err.name || err.code || '').toLowerCase();
    if (name === 'overconstrainederror' || name === 'constraintnotsatisfiederror')
      return '已允許授權，但此裝置不支援進階音訊設定，請改用預設麥克風或稍後再試。';
    if (name === 'notallowederror' || name === 'securityerror')
      return '你已拒絕麥克風與鏡頭，請到瀏覽器或系統設定重新允許後再試。';
    if (name === 'notfounderror' || name === 'devicesnotfounderror')
      return '找不到可用的麥克風或鏡頭，請確認裝置已啟用。';
    if (name === 'notreadableerror' || name === 'trackstarterror')
      return '無法啟動麥克風或鏡頭，可能已被其他應用程式使用。';
    if (message.includes('timeout'))
      return '等待授權逾時，請確認瀏覽器有顯示授權提示或稍後再試。';
    return err?.message || '授權失敗，請稍後再試或檢查系統權限設定。';
  }

  async function warmUpAudio() {
    if (typeof window === 'undefined') return;
    try { await resumeNotifyAudioContext(); } catch { }
    try { await audioManager.loadBuffer?.(); } catch { }
    try {
      if (typeof Audio !== 'undefined') {
        const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=');
        audio.playsInline = true;
        await audio.play().catch(() => { });
        audio.pause();
        try { audio.src = ''; } catch { }
      }
    } catch { }
  }

  function playChime({ volume = 0.3 } = {}) {
    if (typeof Audio === 'undefined') return;
    try {
      const audio = new Audio('/assets/audio/click.mp3');
      audio.volume = Math.min(Math.max(volume, 0), 1);
      audio.playsInline = true;
      audio.muted = false;
      const cleanup = () => { try { audio.pause(); audio.src = ''; audio.load(); } catch { } };
      audio.play()
        ?.then(() => setTimeout(cleanup, 4000))
        .catch((err) => { log({ mediaPermissionChimeError: err?.message || err }); cleanup(); });
    } catch (err) {
      log({ mediaPermissionChimeInitError: err?.message || err });
    }
  }

  async function finalize({ warning = false, autoCloseDelayMs = 400, statusMessage, videoGranted } = {}) {
    if (finalized) return;
    finalized = true;
    // Audio warm-up in background — don't block UI (notify.wav fetch can take seconds)
    warmUpAudio().catch(() => {});
    markGranted();
    const mediaLabel = videoGranted ? '麥克風與鏡頭' : '麥克風';
    const msg = statusMessage !== undefined ? statusMessage
      : warning ? `${mediaLabel}授權已允許，若仍無法通話請在設定中重新測試。`
        : `${mediaLabel}已啟用，可立即使用語音${videoGranted ? '與視訊' : ''}通話。`;
    if (msg !== null) setStatus(msg, { success: true });
    if (allowBtn) allowBtn.disabled = false;
    setButtonState();
    systemGranted = false;
    const toastMsg = warning
      ? `${mediaLabel}已允許，但裝置暫時無法啟動；稍後可再嘗試通話。`
      : `已啟用${mediaLabel}，可使用語音${videoGranted ? '與視訊' : ''}通話`;
    showToast?.(toastMsg, { variant: warning ? 'warning' : 'success' });
    setTimeout(() => hide(), Math.max(0, Number(autoCloseDelayMs) || 0));
  }

  // --- Watcher ---

  function startPollingFallback() {
    if (pollingTimer) return;
    pollingTimer = setInterval(async () => {
      try {
        const { permState, hasLabel } = await collectPermissionSignals();
        if (permState === 'granted' || hasLabel) onDetected();
      } catch (err) { log({ mediaPermissionPollError: err?.message || err }); }
    }, 500);
  }

  async function onDetected() {
    await finalize({ warning: false, autoCloseDelayMs: 600, statusMessage: '已確認授權，稍後會自動關閉提示。' });
    log({ mediaPermission: 'detected-by-watcher' });
  }

  function startWatcher() {
    if (pollingTimer || onChangeCleanup) return;
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: 'microphone' })
        .then((status) => {
          if (status.state === 'granted') { onDetected(); return; }
          const handler = () => { if (status.state === 'granted') onDetected(); };
          status.addEventListener('change', handler);
          onChangeCleanup = () => { try { status.removeEventListener('change', handler); } catch { } };
        })
        .catch(() => startPollingFallback());
    } else {
      startPollingFallback();
    }
  }

  // --- Prompt flow ---

  async function startPrompt() {
    if (activePrompt) return;
    systemGranted = false;
    setStatus('請在系統視窗中按下「允許」。');
    log({ mediaPermission: 'requestUserMedia:start' });
    activePrompt = requestAccess({ timeoutMs: 8000 })
      .then(async (result) => {
        systemGranted = true;
        try {
          const mediaLabel = result?.videoGranted ? '麥克風與鏡頭' : '麥克風';
          await finalize({
            warning: false,
            autoCloseDelayMs: 600,
            statusMessage: `${mediaLabel}已啟用，稍後會自動關閉提示。`,
            videoGranted: !!result?.videoGranted
          });
          log({ mediaPermission: 'prompt-granted', videoGranted: !!result?.videoGranted });
        } catch (err) { log({ mediaPermissionPromptFinalizeError: err?.message || err }); }
      })
      .catch((err) => {
        log({ mediaPermissionError: err?.message || err });
        systemGranted = false;
        setStatus(describeError(err));
        showToast?.('授權失敗，請再試一次', { variant: 'warning' });
        if (allowBtn) allowBtn.disabled = false;
      })
      .finally(() => { activePrompt = null; });
  }

  async function handleGrant() {
    if (!overlay || !allowBtn) return;
    if (activePrompt) return;
    warmUpAudio();
    playChime({ volume: 0.3 });
    allowBtn.disabled = true;
    log({ mediaPermission: 'triggered' });
    startWatcher();
    await startPrompt();
  }

  // --- Public API ---

  function init() {
    if (!overlay) return;
    if (overlay.dataset.init === '1') return;
    overlay.dataset.init = '1';
    setButtonState();
    if (isAutomationEnvironment()) {
      markGranted();
      hide();
      warmUpAudio();
      return;
    }
    if (hasFlag()) {
      hide();
      warmUpAudio();
      return;
    }
    show();
    allowBtn?.addEventListener('click', handleGrant);
    skipBtn?.addEventListener('click', () => {
      warmUpAudio();
      try { sessionStorage.setItem(audioPermissionKey, 'granted'); } catch { }
      hide();
      setStatus('');
      systemGranted = false;
      setButtonState();
      showToast?.('未啟用麥克風，通話可能無法使用', { variant: 'warning' });
    });
    if (debugBtn && !debugBtn.dataset.init) {
      debugBtn.dataset.init = '1';
      debugBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        try {
          const perm = await navigator.permissions?.query?.({ name: 'microphone' }).catch(() => null);
          const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []);
          const hasLabel = Array.isArray(devices) && devices.some((d) => d.kind === 'audioinput' && d.label);
          const toastMessage = perm?.state === 'granted'
            ? '已授權麥克風權限'
            : `權限狀態：${perm?.state || 'unknown'} / Label: ${hasLabel ? '有' : '無'}`;
          showToast?.(toastMessage, { variant: perm?.state === 'granted' || hasLabel ? 'success' : 'warning' });
          log({ mediaPermissionDebugCheck: { perm: perm?.state, label: hasLabel, devicesLength: devices?.length || 0, toast: toastMessage } });
          if (perm?.state === 'granted' || hasLabel) {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              log({ mediaPermissionDebugStream: { tracks: stream?.getTracks?.().length || 0 } });
              setStatus('已確認授權並啟動麥克風，稍後會自動關閉提示。', { success: true });
              await finalize({ warning: false, autoCloseDelayMs: 1500, statusMessage: null });
              setTimeout(() => { try { stream?.getTracks?.().forEach((track) => track.stop()); } catch { } }, 500);
            } catch (err) { log({ mediaPermissionDebugStreamError: err?.message || err }); }
          }
        } catch (err) {
          showToast?.('無法取得權限狀態', { variant: 'warning' });
          log({ mediaPermissionDebugError: err?.message || err });
        }
      });
    }
  }

  return {
    init,
    hide,
    show,
    hasFlag,
    markGranted,
    warmUpAudio,
    playChime,
    stopStreamTracks,
    isLiveStream,
    cacheStream,
    getCachedStream: () => cachedMicStream
  };
}
