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

async function waitForRemoteAudioTrack(page, { timeout = 60000 } = {}) {
  await page.waitForFunction(() => {
    const audio = document.getElementById('callRemoteAudio');
    if (!audio || !audio.srcObject || typeof audio.srcObject.getAudioTracks !== 'function') return false;
    const tracks = audio.srcObject.getAudioTracks();
    return Array.isArray(tracks) && tracks.length > 0;
  }, null, { timeout });
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
      await captureScreen(caller.page, 'caller-in-call');
      await captureScreen(callee.page, 'callee-in-call');
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
