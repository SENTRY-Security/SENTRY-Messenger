import { log } from '../../core/log.js';

export function createNotificationAudioManager({ permissionKey }) {
  const permissionKeyInternal = permissionKey;
  let audioCtx = null;
  let audioBuffer = null;
  let loadPromise = null;

  function getAudioContext() {
    if (typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioCtx) {
      try {
        audioCtx = new AudioCtx();
      } catch (err) {
        log({ audioCtxError: err?.message || err });
        audioCtx = null;
      }
    }
    return audioCtx;
  }

  async function resume() {
    const ctx = getAudioContext();
    if (!ctx) return null;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (err) {
        log({ audioResumeError: err?.message || err });
      }
    }
    return ctx;
  }

  async function loadBuffer() {
    if (audioBuffer) return audioBuffer;
    if (loadPromise) return loadPromise;
    const ctx = await resume();
    if (!ctx) return null;
    loadPromise = (async () => {
      try {
        const res = await fetch('/assets/audio/notify.wav');
        const arrayBuf = await res.arrayBuffer();
        const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
        audioBuffer = decoded;
        return audioBuffer;
      } catch (err) {
        log({ audioLoadError: err?.message || err });
        loadPromise = null;
        return null;
      }
    })();
    return loadPromise;
  }

  async function play() {
    try {
      const ctx = await resume();
      if (!ctx) return;
      const buffer = await loadBuffer();
      if (!buffer) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch (err) {
      log({ audioPlayError: err?.message || err });
    }
  }

  function hasPermission() {
    if (typeof sessionStorage === 'undefined') return false;
    try {
      return sessionStorage.getItem(permissionKeyInternal) === 'granted';
    } catch {
      return false;
    }
  }

  return {
    resume,
    play,
    loadBuffer,
    getAudioContext,
    hasPermission
  };
}
