// Debug page for WebKit microphone permission behavior.

const overlay = document.getElementById('mediaPermissionOverlay');
const allowBtn = document.getElementById('mediaPermissionAllowBtn');
const skipBtn = document.getElementById('mediaPermissionSkipBtn');
const statusEl = document.getElementById('mediaPermissionStatus');
const openOverlayBtn = document.getElementById('openOverlayBtn');
const logEl = document.getElementById('log');

function logStep(message, extra) {
  const ts = new Date().toISOString();
  const line = extra ? `${ts} ${message} ${JSON.stringify(extra)}` : `${ts} ${message}`;
  if (logEl) {
    logEl.textContent += `${line}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

function setStatus(message, { success = false } = {}) {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.classList.toggle('success', success);
}

function showOverlay() {
  overlay.style.display = 'flex';
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('media-permission-open');
  setStatus('');
  allowBtn.disabled = false;
  allowBtn.classList.remove('loading');
}

function hideOverlay() {
  overlay.style.display = 'none';
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('media-permission-open');
}

async function warmUpAudio() {
  logStep('warmUpAudio:start');
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      await ctx.resume().catch(() => {});
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start?.(0);
      await ctx.close().catch(() => {});
      logStep('warmUpAudio:context ok');
    }
  } catch (err) {
    logStep('warmUpAudio:error', err?.message || err);
  }
  try {
    const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=');
    audio.muted = true;
    audio.playsInline = true;
    await audio.play().catch(() => {});
    audio.pause();
    logStep('warmUpAudio:inline audio ok');
  } catch (err) {
    logStep('warmUpAudio:inline audio error', err?.message || err);
  }
}

async function detectPermission() {
  const result = {
    granted: false,
    labelFound: false,
    permissionState: null
  };
  try {
    const query = await navigator.permissions?.query?.({ name: 'microphone' });
    result.permissionState = query?.state || null;
    if (query?.state === 'granted') result.granted = true;
  } catch (err) {
    logStep('permissions.query error', err?.message || err);
  }
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    if (Array.isArray(devices)) {
      const hasLabel = devices.some((device) => device.kind === 'audioinput' && device.label);
      result.labelFound = hasLabel;
      if (hasLabel) result.granted = true;
    }
  } catch (err) {
    logStep('enumerateDevices error', err?.message || err);
  }
  return result;
}

async function handleAllowClick() {
  allowBtn.disabled = true;
  allowBtn.classList.add('loading');
  setStatus('等待瀏覽器授權…');
  logStep('click:start');
  await warmUpAudio();
  let stream = null;
  try {
    const constraints = { audio: { echoCancellation: true, noiseSuppression: true } };
    logStep('getUserMedia:request', constraints);
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    logStep('getUserMedia:success');
    const perm = await detectPermission();
    logStep('permission snapshot', perm);
    setStatus('授權成功，overlay 將關閉。', { success: true });
    setTimeout(() => {
      hideOverlay();
      allowBtn.disabled = false;
      allowBtn.classList.remove('loading');
    }, 800);
  } catch (err) {
    logStep('getUserMedia:error', { name: err?.name, message: err?.message });
    setStatus(err?.message || '授權失敗，請再試一次。');
    allowBtn.disabled = false;
    allowBtn.classList.remove('loading');
  } finally {
    if (stream?.getTracks) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch {}
      }
    }
  }
}

function init() {
  if (!overlay || !allowBtn) {
    logStep('missing overlay elements');
    return;
  }
  showOverlay();
  allowBtn.addEventListener('click', () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('此瀏覽器不支援 getUserMedia。');
      return;
    }
    handleAllowClick();
  });
  skipBtn?.addEventListener('click', hideOverlay);
  openOverlayBtn?.addEventListener('click', showOverlay);
  logStep('ready');
}

window.addEventListener('load', init);
