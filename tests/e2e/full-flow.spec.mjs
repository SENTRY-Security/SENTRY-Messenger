import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { performLogin, startWebServer, stopWebServer, ensureDir, E2E_ARTIFACT_DIR, ORIGIN, buildContactSecretsKey } from './utils.mjs';
import { openConversationWithPeer } from './multi-account-helpers.mjs';
import { setupFriendConversation } from '../../scripts/lib/friends-flow.mjs';

const SCREENSHOT_DIR = path.join(E2E_ARTIFACT_DIR, 'screens');

let serverProc;
let friendSetup;

async function createSampleVideoFile(page) {
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0ea5e9';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(15);
    const supportedTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    let recorder = null;
    for (const type of supportedTypes) {
      if (!window.MediaRecorder) break;
      if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type)) {
        try {
          recorder = new MediaRecorder(stream, { mimeType: type });
          break;
        } catch {
          /* try next */
        }
      }
    }
    if (!recorder) {
      if (!window.MediaRecorder) throw new Error('MediaRecorder unsupported in browser');
      recorder = new MediaRecorder(stream);
    }
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.start();
    for (let i = 0; i < 6; i += 1) {
      ctx.fillStyle = `hsl(${i * 45}, 80%, 60%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#0f172a';
      ctx.font = '18px sans-serif';
      ctx.fillText(`Frame ${i + 1}`, 20, 50);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    const buffer = await blob.arrayBuffer();
    return {
      mimeType: recorder.mimeType || 'video/webm',
      bytes: Array.from(new Uint8Array(buffer))
    };
  });

  return {
    name: 'sample-video.webm',
    mimeType: result.mimeType,
    buffer: Buffer.from(result.bytes)
  };
}

function createSamplePdfFile() {
  const header = '%PDF-1.4\n';
  const objects = [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' },
    { num: 4, body: '<< /Length 72 >>\nstream\nBT /F1 18 Tf 40 140 Td (Chat Attachment Preview) Tj ET\nendstream' },
    { num: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }
  ];
  const offsets = ['0000000000 65535 f \n'];
  let offset = Buffer.byteLength(header, 'utf8');
  const objectSections = objects.map(({ num, body }) => {
    const serialized = `${num} 0 obj\n${body}\nendobj\n`;
    offsets.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
    offset += Buffer.byteLength(serialized, 'utf8');
    return serialized;
  });
  const objectContent = objectSections.join('');
  const xrefOffset = offset;
  const xref =
    `xref\n0 ${objects.length + 1}\n` +
    offsets.join('') +
    `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  const pdfString = header + objectContent + xref;
  return {
    name: 'sample.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdfString, 'utf8')
  };
}

test.beforeAll(async () => {
  await ensureDir(E2E_ARTIFACT_DIR);
  await ensureDir(SCREENSHOT_DIR);
  friendSetup = await setupFriendConversation({
    origin: ORIGIN,
    messageFromA: 'E2E bootstrap from user A',
    messageFromB: 'E2E bootstrap from user B'
  });
  // eslint-disable-next-line no-console
  console.log('[friendSetup conversation]', friendSetup?.conversation || null);
  serverProc = await startWebServer();
});

test.afterAll(async () => {
  await stopWebServer(serverProc);
});

test.describe.configure({ mode: 'serial' });

test('media preview screenshots only', async ({ page, browser }) => {
  test.setTimeout(240_000);
  if (!friendSetup) test.skip(true, 'friend setup failed');

  const { userA, userB } = friendSetup;
  const pageA = page;
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();

  const tapConsole = (targetPage, label) => {
    targetPage.on('console', (msg) => console.log(`[${label} console]`, msg.type(), msg.text())); // eslint-disable-line no-console
    targetPage.on('pageerror', (err) => console.log(`[${label} pageerror]`, err?.message || err)); // eslint-disable-line no-console
    targetPage.on('requestfailed', (request) => console.log(`[${label} requestfailed]`, request.method(), request.url(), request.failure()?.errorText)); // eslint-disable-line no-console
  };
  tapConsole(pageA, 'userA');
  tapConsole(pageB, 'userB');

  let step = 0;
  const capture = async (targetPage, label) => {
    step += 1;
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, '_');
    const fileName = `${String(step).padStart(2, '0')}_${safeLabel}.png`;
    await targetPage.screenshot({
      path: path.join(SCREENSHOT_DIR, fileName),
      fullPage: true
    });
  };

  const avatarFileAbsPath = path.resolve('tests/assets/avatar.png');
  const uploadFilePath = avatarFileAbsPath;
  const uploadFileName = 'avatar.png';
  const nowTs = Math.floor(Date.now() / 1000);
  const avatarFileBuffer = await fs.readFile(avatarFileAbsPath);
  const avatarFileDigest = crypto.createHash('sha256').update(avatarFileBuffer).digest('hex');

  const secretEntryForA = JSON.stringify([
    [
      userB.uidHex,
      {
        inviteId: friendSetup.invite.inviteId,
        secret: friendSetup.invite.secret,
        role: 'owner',
        conversationToken: friendSetup.conversation.tokenB64,
        conversationId: friendSetup.conversation.conversationId,
        conversationDrInit: friendSetup.conversation.drInit || null,
        updatedAt: nowTs
      }
    ]
  ]);
  const secretEntryForB = JSON.stringify([
    [
      userA.uidHex,
      {
        inviteId: friendSetup.invite.inviteId,
        secret: friendSetup.invite.secret,
        role: 'guest',
        conversationToken: friendSetup.conversation.tokenB64,
        conversationId: friendSetup.conversation.conversationId,
        conversationDrInit: friendSetup.conversation.drInit || null,
        updatedAt: nowTs
      }
    ]
  ]);

  const contactKeyA = buildContactSecretsKey(userA.uidHex);
  await pageA.addInitScript(({ value, contactKey }) => {
    try {
      window.__LOGIN_SEED_LOCALSTORAGE = window.__LOGIN_SEED_LOCALSTORAGE || {};
      if (contactKey) window.__LOGIN_SEED_LOCALSTORAGE[contactKey] = value;
      window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1'] = value;
    } catch {}
  }, { value: secretEntryForA, contactKey: contactKeyA });
  await performLogin(pageA, { password: userA.password, uidHex: userA.uidHex });
  await pageA.waitForTimeout(500);
  await pageA.evaluate(() => document.getElementById('nav-messages')?.click());

  const contactKeyB = buildContactSecretsKey(userB.uidHex);
  await pageB.addInitScript(({ value, contactKey }) => {
    try {
      window.__LOGIN_SEED_LOCALSTORAGE = window.__LOGIN_SEED_LOCALSTORAGE || {};
      if (contactKey) window.__LOGIN_SEED_LOCALSTORAGE[contactKey] = value;
      window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1'] = value;
    } catch {}
  }, { value: secretEntryForB, contactKey: contactKeyB });
  await performLogin(pageB, { password: userB.password, uidHex: userB.uidHex });
  await pageB.waitForTimeout(500);
  await pageB.evaluate(() => document.getElementById('nav-messages')?.click());

  await openConversationWithPeer(pageA, userB.uidHex);
  await openConversationWithPeer(pageB, userA.uidHex);
  await capture(pageB, 'messages_list_userB_initial');

  const samplePdf = createSamplePdfFile();
  let sampleVideo = null;
  try {
    sampleVideo = await createSampleVideoFile(pageA);
  } catch (err) {
    test.info().annotations.push({ type: 'video-skip', description: err?.message || err });
  }

  // 圖片附件
  const imageSignPutPromise = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/media/sign-put'));
  const imageSecurePostPromise = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/messages/secure'));
  await pageA.click('#composerAttach');
  await pageA.setInputFiles('#messageFileInput', uploadFilePath);
  await imageSignPutPromise;
  await imageSecurePostPromise;
  const outgoingImageBubbleA = pageA.locator('.message-bubble.message-me', { has: pageA.locator('.message-file-name', { hasText: uploadFileName }) }).last();
  await expect(outgoingImageBubbleA.locator('.message-file-preview-image')).toBeVisible({ timeout: 30000 });
  await capture(pageA, 'messages_userA_image_preview');
  const incomingImageBubbleB = pageB.locator('.message-bubble', { has: pageB.locator('.message-file-name', { hasText: uploadFileName }) }).last();
  await expect(incomingImageBubbleB.locator('.message-file-preview-image')).toBeVisible({ timeout: 30000 });
  await capture(pageB, 'messages_userB_image_preview');
  test.info().annotations.push({ type: 'image-digest', description: avatarFileDigest });

  // 影片附件
  if (sampleVideo) {
    const videoSignPutPromise = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/media/sign-put'));
    const videoSecurePostPromise = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/messages/secure'));
    await pageA.click('#composerAttach');
    await pageA.setInputFiles('#messageFileInput', {
      name: sampleVideo.name,
      mimeType: sampleVideo.mimeType,
      buffer: sampleVideo.buffer
    });
    await videoSignPutPromise;
    await videoSecurePostPromise;
    const outgoingVideoBubbleA = pageA.locator('.message-bubble.message-me', { has: pageA.locator('.message-file-name', { hasText: sampleVideo.name }) }).last();
    await expect(outgoingVideoBubbleA.locator('.message-file-preview-video')).toBeVisible({ timeout: 30000 });
    await capture(pageA, 'messages_userA_video_preview');
    const incomingVideoBubbleB = pageB.locator('.message-bubble', { has: pageB.locator('.message-file-name', { hasText: sampleVideo.name }) }).last();
    await expect(incomingVideoBubbleB.locator('.message-file-preview-video')).toBeVisible({ timeout: 30000 });
    await capture(pageB, 'messages_userB_video_preview');
  }

  // PDF 附件
  const pdfSignPutPromise = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/media/sign-put'));
  const pdfSecurePostPromise = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/messages/secure'));
  await pageA.click('#composerAttach');
  await pageA.setInputFiles('#messageFileInput', {
    name: samplePdf.name,
    mimeType: samplePdf.mimeType,
    buffer: samplePdf.buffer
  });
  await pdfSignPutPromise;
  await pdfSecurePostPromise;
  const outgoingPdfBubbleA = pageA.locator('.message-bubble.message-me', { has: pageA.locator('.message-file-name', { hasText: samplePdf.name }) }).last();
  await expect(outgoingPdfBubbleA.locator('.message-file-preview-pdf')).toBeVisible({ timeout: 30000 });
  await capture(pageA, 'messages_userA_pdf_preview');
  const incomingPdfBubbleB = pageB.locator('.message-bubble', { has: pageB.locator('.message-file-name', { hasText: samplePdf.name }) }).last();
  await expect(incomingPdfBubbleB.locator('.message-file-preview-pdf')).toBeVisible({ timeout: 30000 });
  await capture(pageB, 'messages_userB_pdf_preview');

  await contextB.close();
});
