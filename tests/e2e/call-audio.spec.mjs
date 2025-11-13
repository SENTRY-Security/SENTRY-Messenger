import crypto from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  performLogin,
  startWebServer,
  stopWebServer,
  ensureDir,
  E2E_ARTIFACT_DIR,
  WEB_PORT
} from './utils.mjs';
import {
  tapConsole,
  openContactsTab,
  openShareModalAndGenerateInvite,
  acceptInviteViaScan,
  waitForContactCard,
  openConversationWithPeer,
  waitForSecureConversationReady,
  dismissToasts,
  disableTopbarPointerEvents
} from './multi-account-helpers.mjs';

const FAKE_AUDIO_PATH = path.resolve('tests/assets/fake-audio.wav');
const APP_ORIGIN = `http://localhost:${WEB_PORT}`;
const CALL_ARTIFACT_DIR = path.join(E2E_ARTIFACT_DIR, 'call-audio');

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${FAKE_AUDIO_PATH}`
    ]
  }
});

test.describe.configure({ mode: 'serial' });

let serverProc;

test.beforeAll(async () => {
  await ensureDir(E2E_ARTIFACT_DIR);
  await ensureDir(CALL_ARTIFACT_DIR);
  serverProc = await startWebServer();
});

test.afterAll(async () => {
  await stopWebServer(serverProc);
});

async function createAccount(browser, label) {
  const uidHex = crypto.randomBytes(7).toString('hex').toUpperCase();
  const password = `call-${crypto.randomBytes(4).toString('hex')}`;
  const context = await browser.newContext();
  await context.grantPermissions(['microphone'], { origin: APP_ORIGIN });
  const page = await context.newPage();
  tapConsole(page, label);
  await performLogin(page, { uidHex, password });
  await openContactsTab(page);
  return { label, uidHex, password, context, page };
}

async function waitForOverlayStatus(page, regex, { timeout = 45000 } = {}) {
  const overlay = page.locator('#callOverlay');
  await expect(overlay).toBeVisible({ timeout });
  await expect(page.locator('#callOverlay .call-status-label')).toHaveText(regex, { timeout });
}

async function waitForSecureLabel(page, regex, { timeout = 60000 } = {}) {
  const label = page.locator('#callOverlay .call-secure-label');
  await expect(label).toHaveText(regex, { timeout });
}

async function waitForInCallAndTimer(page, { timeout = 60000 } = {}) {
  // overlay may still顯示「正在接通…」在加密完成前，但計時器啟動代表已進入通話中。
  await waitForOverlayStatus(page, /通話中|正在接通/, { timeout });
  const timerLabel = page.locator('#callOverlay .call-timer-label');
  await expect(timerLabel).toBeVisible({ timeout });
  await expect.poll(async () => {
    const text = await timerLabel.textContent();
    return text && /^\d{2}:\d{2}$/.test(text) ? text : null;
  }, { timeout, message: 'call timer never started' }).not.toBeNull();
}

async function waitForCallDuration(page, minSeconds = 3, { timeout = 60000 } = {}) {
  const required = Math.max(0, minSeconds);
  await page.waitForFunction((seconds) => {
    const label = document.querySelector('#callOverlay .call-timer-label');
    if (!label) return false;
    const text = (label.textContent || '').trim();
    if (!/^\d{2}:\d{2}$/.test(text)) return false;
    const [mm, ss] = text.split(':').map((part) => Number(part));
    if (!Number.isFinite(mm) || !Number.isFinite(ss)) return false;
    return mm * 60 + ss >= seconds;
  }, required, { timeout });
}

async function waitForRemoteAudioTrack(page, { timeout = 60000 } = {}) {
  await page.waitForFunction(() => {
    const audio = document.getElementById('callRemoteAudio');
    if (!audio || !audio.srcObject || typeof audio.srcObject.getAudioTracks !== 'function') return false;
    const tracks = audio.srcObject.getAudioTracks();
    return tracks && typeof tracks.length === 'number' && tracks.length > 0;
  }, null, { timeout });
}

async function sampleRemoteAudioAmplitude(page) {
  return page.evaluate(async () => {
    const audio = document.getElementById('callRemoteAudio');
    if (!audio) return { ready: false, reason: 'missing-element' };
    const stream = audio.srcObject;
    if (!stream || typeof stream.getAudioTracks !== 'function') return { ready: false, reason: 'missing-stream' };
    const tracks = stream.getAudioTracks();
    if (!tracks.length) return { ready: false, reason: 'missing-track' };
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return { ready: false, reason: 'missing-context' };
    if (!audio.__codexAudioCtx) {
      audio.__codexAudioCtx = new AudioContextCtor();
    }
    const ctx = audio.__codexAudioCtx;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { await ctx.resume(); } catch {}
    }
    const needsRewire = !audio.__codexAnalyser || audio.__codexAnalyserStream !== stream;
    if (needsRewire) {
      try { audio.__codexAudioSource?.disconnect(); } catch {}
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      audio.__codexAudioSource = source;
      audio.__codexAnalyser = analyser;
      audio.__codexAnalyserStream = stream;
      audio.__codexAnalyserBuffer = new Uint8Array(analyser.fftSize);
    }
    const analyser = audio.__codexAnalyser;
    const buffer = audio.__codexAnalyserBuffer || new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buffer);
    let maxDeviation = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const deviation = Math.abs((buffer[i] - 128) / 128);
      if (deviation > maxDeviation) {
        maxDeviation = deviation;
      }
    }
    return { ready: true, amplitude: maxDeviation };
  });
}

async function waitForRemoteAudioSignal(page, label, {
  timeout = 60000,
  minAmplitude = 0.02,
  requiredConsecutive = 3,
  sampleIntervalMs = 500
} = {}) {
  await waitForRemoteAudioTrack(page, { timeout });
  const deadline = Date.now() + timeout;
  let consecutive = 0;
  let lastAmplitude = 0;
  while (Date.now() < deadline) {
    const result = await sampleRemoteAudioAmplitude(page);
    if (result.ready && typeof result.amplitude === 'number' && result.amplitude >= minAmplitude) {
      consecutive += 1;
      lastAmplitude = result.amplitude;
      if (consecutive >= requiredConsecutive) {
        test.info().annotations.push({
          type: 'audio-signal',
          description: `${label} amplitude=${lastAmplitude.toFixed(3)}`
        });
        return lastAmplitude;
      }
    } else {
      consecutive = 0;
    }
    await page.waitForTimeout(sampleIntervalMs);
  }
  throw new Error(`未偵測到 ${label} 的遠端音訊訊號 (>= ${minAmplitude})`);
}

async function ensureOverlayHidden(page, { timeout = 20000 } = {}) {
  await page.waitForFunction(() => {
    const overlay = document.getElementById('callOverlay');
    if (!overlay) return true;
    const hidden = overlay.classList.contains('hidden') || overlay.getAttribute('aria-hidden') === 'true';
    return hidden;
  }, null, { timeout });
}

async function captureScreen(page, label) {
  const safeLabel = label.replace(/[^a-z0-9-_]+/gi, '_').toLowerCase();
  const filePath = path.join(CALL_ARTIFACT_DIR, `${Date.now()}-${safeLabel}.png`);
  const buffer = await page.screenshot({ path: filePath, fullPage: true });
  await test.info().attach(label, { body: buffer, contentType: 'image/png' });
  return filePath;
}

test('encrypted audio call with fake media stream', async ({ browser }) => {
  test.setTimeout(300_000);
  const caller = await createAccount(browser, 'caller');
  const callee = await createAccount(browser, 'callee');

  const cleanup = async () => {
    await Promise.allSettled([
      caller.context?.close(),
      callee.context?.close()
    ]);
  };

  try {
    await test.step('建立好友關係', async () => {
      const { encoded } = await openShareModalAndGenerateInvite(caller.page);
      await acceptInviteViaScan(callee.page, encoded);
      await waitForContactCard(caller.page, callee.uidHex);
      await waitForContactCard(callee.page, caller.uidHex);
    });

    await test.step('雙方進入同一對話並建立安全會話', async () => {
      await openConversationWithPeer(caller.page, callee.uidHex);
      await dismissToasts(caller.page);
      await waitForSecureConversationReady(caller.page, callee.uidHex);
      await openConversationWithPeer(callee.page, caller.uidHex);
      await dismissToasts(callee.page);
      await waitForSecureConversationReady(callee.page, caller.uidHex);

      await expect(caller.page.locator('#messagesCallBtn')).toBeEnabled({ timeout: 10000 });
      await captureScreen(caller.page, 'caller-ready');
      await captureScreen(callee.page, 'callee-ready');
    });

    await test.step('發起語音通話並等待來電', async () => {
      await openConversationWithPeer(caller.page, callee.uidHex);
      await waitForSecureConversationReady(caller.page, callee.uidHex);
      await dismissToasts(caller.page);
      await caller.page.locator('#messagesCallBtn').scrollIntoViewIfNeeded();
      const restoreTopbar = await disableTopbarPointerEvents(caller.page);
      try {
        await caller.page.click('#messagesCallBtn');
      } finally {
        await restoreTopbar();
      }
      await waitForOverlayStatus(caller.page, /撥號中/, { timeout: 30000 });
      await waitForOverlayStatus(callee.page, /來電中/, { timeout: 30000 });
      await captureScreen(caller.page, 'caller-dialing');
      await captureScreen(callee.page, 'callee-incoming');
    });

    await test.step('接聽並等候通話加密就緒', async () => {
      await callee.page.click('#callOverlay [data-call-action="accept"]');
      await waitForOverlayStatus(caller.page, /通話中|正在接通/, { timeout: 60000 });
    await waitForOverlayStatus(callee.page, /通話中|正在接通/, { timeout: 60000 });
    await waitForSecureLabel(caller.page, /端到端加密已啟動|加密金鑰/, { timeout: 60000 });
    await waitForSecureLabel(callee.page, /端到端加密已啟動|加密金鑰/, { timeout: 60000 });
    await waitForInCallAndTimer(caller.page);
    await waitForInCallAndTimer(callee.page);
    await waitForCallDuration(caller.page, 3);
    await waitForCallDuration(callee.page, 3);
    await captureScreen(caller.page, 'caller-in-call');
    await captureScreen(callee.page, 'callee-in-call');
  });

  await test.step('驗證雙方遠端音訊訊號', async () => {
      await waitForRemoteAudioSignal(caller.page, 'caller-receiving');
      await waitForRemoteAudioSignal(callee.page, 'callee-receiving');
    });

    await test.step('掛斷並確認介面恢復', async () => {
      await caller.page.click('#callOverlay [data-call-action="hangup"]');
      await ensureOverlayHidden(caller.page);
      await ensureOverlayHidden(callee.page);
      await captureScreen(caller.page, 'caller-call-ended');
      await captureScreen(callee.page, 'callee-call-ended');
    });
  } finally {
    await cleanup();
  }
});
