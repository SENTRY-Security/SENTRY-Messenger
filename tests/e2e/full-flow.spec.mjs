import path from 'node:path';
import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { performLogin, startWebServer, stopWebServer, ensureDir, E2E_ARTIFACT_DIR, ORIGIN } from './utils.mjs';
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
    const supportedTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    let recorder = null;
    for (const type of supportedTypes) {
      if (!window.MediaRecorder) break;
      if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type)) {
        try {
          recorder = new MediaRecorder(stream, { mimeType: type });
          break;
        } catch {
          // try next type
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

test('complete secure messaging journey with media and cleanup', async ({ page, browser }) => {
  if (!friendSetup) test.skip(true, 'friend setup failed');

  const { userA, userB } = friendSetup;
  const pageA = page;
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();

  const tapConsole = (targetPage, label) => {
    targetPage.on('console', (msg) => {
      // eslint-disable-next-line no-console
      console.log(`[${label} console]`, msg.type(), msg.text());
    });
    targetPage.on('pageerror', (err) => {
      // eslint-disable-next-line no-console
      console.log(`[${label} pageerror]`, err?.message || err);
    });
    targetPage.on('requestfailed', (request) => {
      // eslint-disable-next-line no-console
      console.log(`[${label} requestfailed]`, request.method(), request.url(), request.failure()?.errorText);
    });
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

  const newNickname = `自動測試-${Date.now()}`;
  // eslint-disable-next-line no-console
  console.log('[test-new-nickname]', newNickname);
  const avatarFileAbsPath = path.resolve('tests/assets/avatar.png');
  const uploadFilePath = avatarFileAbsPath;
  const uploadFileName = 'avatar.png';
  const messageFromA = `A訊息-${Date.now()}`;
  const messageFromB = `B訊息-${Date.now()}`;
  const nowTs = Math.floor(Date.now() / 1000);
  const avatarFileBase64 = (await fs.readFile(avatarFileAbsPath)).toString('base64');

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
  try {
    await pageA.addInitScript((value) => {
      try {
        window.__LOGIN_SEED_LOCALSTORAGE = window.__LOGIN_SEED_LOCALSTORAGE || {};
        window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1'] = value;
      } catch {}
    }, secretEntryForA);
    await performLogin(pageA, { password: userA.password, uidHex: userA.uidHex });
    await pageA.waitForTimeout(1000);
    await capture(pageA, 'userA_drive_initial');

    await pageA.evaluate(() => document.getElementById('nav-profile')?.click());
    await pageA.waitForSelector('#btnProfileNickEdit', { timeout: 15000 });
    await pageA.click('#btnProfileNickEdit');
    await pageA.waitForSelector('#nicknameInput', { timeout: 5000 });
    await pageA.fill('#nicknameInput', newNickname);
    const nicknameSave = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/messages'));
    const nicknameShare = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/friends/contact/share'));
    await pageA.click('#nicknameForm button[type="submit"]');
    await nicknameSave.catch(() => {});
    await nicknameShare.catch(() => {});
    await expect(pageA.locator('#profileNickname')).toHaveText(newNickname, { timeout: 15000 });
    await capture(pageA, 'userA_profile_nickname_updated');

    await pageA.evaluate(() => document.getElementById('nav-contacts')?.click());
    await pageA.waitForFunction((peerUid) => {
      const normalize = (value) => String(value || '').toUpperCase();
      const expected = normalize(peerUid);
      const items = Array.from(document.querySelectorAll('.contact-item'));
      if (!items.length) return null;
      for (const item of items) {
        const attr = normalize(item.getAttribute('data-peer-uid'));
        if (attr === expected) return true;
      }
      return false;
    }, userB.uidHex, { timeout: 20000 });
    await capture(pageA, 'userA_contacts_after_nickname');
    await pageA.evaluate(async (peerUid) => {
      const { ensureDrReceiverState } = await import('../app/features/dr-session.js');
      await ensureDrReceiverState({ peerUidHex: peerUid });
    }, userB.uidHex);

  const initiatorDrState = friendSetup.conversation.initiatorDrState || null;
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
        drState: initiatorDrState,
        drHistory: initiatorDrState ? [{ ts: nowTs, snapshot: initiatorDrState }] : [],
        drHistoryCursorTs: initiatorDrState ? nowTs : null,
        updatedAt: nowTs
      }
    ]
  ]);
    await pageB.addInitScript((value) => {
      try {
        window.__LOGIN_SEED_LOCALSTORAGE = window.__LOGIN_SEED_LOCALSTORAGE || {};
        window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1'] = value;
      } catch {}
    }, secretEntryForB);

    await performLogin(pageB, { password: userB.password, uidHex: userB.uidHex });
    await pageB.waitForTimeout(1000);
    await pageB.evaluate(async () => {
      document.getElementById('nav-contacts')?.click();
      if (window.__refreshContacts) {
        await window.__refreshContacts();
      }
    });
    const contactDump = await pageB.evaluate((peerUid) => {
      const state = typeof window.__getContactState === 'function' ? window.__getContactState() : [];
      return state.find((c) => String(c?.peerUid || '').toUpperCase() === String(peerUid).toUpperCase());
    }, userA.uidHex);
    // eslint-disable-next-line no-console
    console.log('[contact-state]', contactDump);
    await pageB.evaluate(async () => {
      document.getElementById('nav-messages')?.click();
      if (window.__refreshConversations) {
        await window.__refreshConversations();
      }
    });
    const drDebugInitB = await pageB.evaluate(async (peerUid) => {
      const { drState } = await import('../app/core/store.js');
      const state = drState(peerUid);
      const toB64 = (u8) => (u8 instanceof Uint8Array ? Array.from(u8) : null);
      return {
        rk: toB64(state.rk),
        ckS: toB64(state.ckS),
        ckR: toB64(state.ckR),
        Ns: state.Ns,
        Nr: state.Nr,
        PN: state.PN,
        myPub: toB64(state.myRatchetPub),
        their: toB64(state.theirRatchetPub),
        pendingSendRatchet: !!state.pendingSendRatchet
      };
    }, userA.uidHex);
    // eslint-disable-next-line no-console
    console.log('[dr-state-B-init]', drDebugInitB);
    const contactNameOnB = pageB.locator(`.contact-item[data-peer-uid="${userA.uidHex}"] .name-text`);
    await pageB.evaluate(async () => {
      if (typeof window.__refreshContacts === 'function') {
        await window.__refreshContacts();
      }
    });
    // eslint-disable-next-line no-console
    console.log('[contact-text]', await contactNameOnB.textContent());
    await expect(contactNameOnB).toHaveText(newNickname, { timeout: 20000 });
    await capture(pageB, 'userB_contacts_nickname_refreshed');
    await pageB.evaluate(async (peerUid) => {
      const { ensureDrReceiverState } = await import('../app/features/dr-session.js');
      await ensureDrReceiverState({ peerUidHex: peerUid });
    }, userA.uidHex);
    const conversationSnippetB = pageB.locator(`.conversation-item[data-peer="${userA.uidHex}"] .conversation-snippet`);
    await capture(pageB, 'messages_list_userB_initial');

    await pageA.evaluate(() => document.getElementById('nav-profile')?.click());
    await pageA.evaluate(async (avatarB64) => {
      const [{ uploadAvatar, saveProfile, normalizeNickname, generateRandomNickname }] = await Promise.all([
        import('../app/features/profile.js')
      ]);
      const { sessionStore } = await import('../app/ui/mobile/session-store.js');
      const binary = atob(avatarB64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const file = new File([bytes], 'avatar.png', { type: 'image/png' });
      const avatarMeta = await uploadAvatar({
        file,
        thumbDataUrl: 'data:image/png;base64,' + avatarB64,
        onProgress: () => {}
      });
      const now = Math.floor(Date.now() / 1000);
      const nickname = sessionStore.profileState?.nickname
        ? normalizeNickname(sessionStore.profileState.nickname) || sessionStore.profileState.nickname
        : generateRandomNickname();
      const next = {
        ...(sessionStore.profileState || {}),
        nickname,
        avatar: {
          ...avatarMeta,
          thumbDataUrl: avatarMeta.thumbDataUrl || ('data:image/png;base64,' + avatarB64)
        },
        updatedAt: now
      };
      const saved = await saveProfile(next).catch(() => next);
      sessionStore.profileState = saved || next;
      const img = document.getElementById('profileAvatarImg');
      if (img) img.src = sessionStore.profileState.avatar?.thumbDataUrl || img.src;
    }, avatarFileBase64);
    await pageA.evaluate(async () => {
      if (window.__shareController?.broadcastContactUpdate) {
        await window.__shareController.broadcastContactUpdate({ reason: 'avatar' });
      }
    });
    await pageA.waitForTimeout(500);
    await capture(pageA, 'userA_profile_avatar_updated');

    await pageB.evaluate(async () => {
      if (window.__refreshContacts) {
        await window.__refreshContacts();
      } else {
        document.getElementById('nav-drive')?.click();
        document.getElementById('nav-contacts')?.click();
      }
    });
    await pageB.evaluate((peerUid) => {
      const el = document.querySelector(`.contact-item[data-peer-uid="${peerUid}"]`);
      // eslint-disable-next-line no-console
      console.log('[contact-debug]', peerUid, el ? el.outerHTML : 'missing');
    }, userA.uidHex);
    await pageB.waitForTimeout(500);
    await capture(pageB, 'userB_contacts_avatar_refreshed');

    await pageA.evaluate(() => document.getElementById('nav-drive')?.click());
    await pageA.waitForSelector('#btnUploadOpen', { timeout: 5000 });
    await pageA.click('#btnUploadOpen');
    await pageA.waitForSelector('#uploadFileInput', { timeout: 5000 });
    await pageA.setInputFiles('#uploadFileInput', uploadFilePath);
    await pageA.click('#uploadForm button[type="submit"]');
    const uploadedFile = pageA.locator(`.file-item[data-name="${uploadFileName}"]`);
    await expect(uploadedFile).toBeVisible({ timeout: 30000 });
    await capture(pageA, 'drive_after_file_upload');
    await pageA.waitForFunction(() => {
      const modal = document.getElementById('modal');
      return !modal || modal.getAttribute('aria-hidden') === 'true' || modal.classList.contains('hidden');
    }, null, { timeout: 10000 });

    const objectKeys = await pageA.evaluate((name) => (
      Array.from(document.querySelectorAll(`.file-item[data-name="${name}"]`)).map((el) => el.dataset.key).filter(Boolean)
    ), uploadFileName);
    for (const key of objectKeys) {
      const didDelete = await pageA.evaluate(async ({ key }) => {
        if (!key) return false;
        if (typeof window.__deleteDriveObject === 'function') {
          return await window.__deleteDriveObject(key);
        }
        return false;
      }, { key });
      // eslint-disable-next-line no-console
      console.log('[drive-delete]', key, didDelete);
    }
    await expect.poll(async () => {
      await pageA.evaluate(async () => {
        if (typeof window.__refreshDrive === 'function') {
          await window.__refreshDrive();
        }
      });
      return await pageA.locator(`.file-item[data-name="${uploadFileName}"]`).count();
    }, { timeout: 30000, intervals: [500, 1000, 2000] }).toBe(0);
    await capture(pageA, 'drive_after_file_delete');

    await pageA.evaluate(() => document.getElementById('nav-messages')?.click());
    const conversationItemA = pageA.locator(`.conversation-item[data-peer="${userB.uidHex}"]`);
    await conversationItemA.waitFor({ state: 'visible', timeout: 20000 });
    await conversationItemA.click();
    await pageA.fill('#messageInput', messageFromA);
    const sendA = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/messages/secure'));
    await pageA.click('#messageSend');
    await sendA.catch(() => {});
    const messageBubbleA = pageA.locator('#messagesList .message-bubble', { hasText: messageFromA });
    await expect(messageBubbleA).toBeVisible({ timeout: 20000 });
    await capture(pageA, 'messages_userA_sent');

    await pageB.evaluate(() => document.getElementById('nav-messages')?.click());
    const conversationItemB = pageB.locator(`.conversation-item[data-peer="${userA.uidHex}"]`);
    await conversationItemB.waitFor({ state: 'visible', timeout: 20000 });
    await conversationItemB.click();
    const debugMessagesB = await pageB.evaluate(() => Array.from(document.querySelectorAll('#messagesList .message-bubble')).map((el) => el.textContent));
    // eslint-disable-next-line no-console
    console.log('[messagesList-before]', debugMessagesB);
    const messageFromALocatorB = pageB.locator('#messagesList .message-bubble', { hasText: messageFromA });
    const drDebugBeforeDecrypt = await pageB.evaluate(async (peerUid) => {
      const { drState } = await import('../app/core/store.js');
      const state = drState(peerUid);
      const toB64 = (u8) => (u8 instanceof Uint8Array ? Array.from(u8) : null);
      return {
        rk: toB64(state.rk),
        ckS: toB64(state.ckS),
        ckR: toB64(state.ckR),
        Ns: state.Ns,
        Nr: state.Nr,
        PN: state.PN,
        myPub: toB64(state.myRatchetPub),
        their: toB64(state.theirRatchetPub)
      };
    }, userA.uidHex);
    // eslint-disable-next-line no-console
    console.log('[dr-state-B-before-decrypt]', drDebugBeforeDecrypt);
    await expect(messageFromALocatorB).toBeVisible({ timeout: 20000 });
    await pageB.fill('#messageInput', messageFromB);
    const sendB = pageB.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/messages/secure'));
    await pageB.click('#messageSend');
    await sendB.catch(() => {});
    await expect(pageB.locator('#messagesList .message-bubble', { hasText: messageFromB })).toBeVisible({ timeout: 20000 });
    await capture(pageB, 'messages_userB_sent');
    await pageB.evaluate(async () => {
      if (window.__refreshConversations) {
        await window.__refreshConversations();
      }
    });
    // eslint-disable-next-line no-console
    console.log('[conversation-snippet-B]', await conversationSnippetB.textContent());
    await capture(pageB, 'messages_list_userB_after_reply');
    await capture(pageB, 'messages_list_userB_after_reply');

    const incomingOnA = pageA.locator('#messagesList .message-bubble.message-peer', { hasText: messageFromB });
    await expect(incomingOnA).toBeVisible({ timeout: 20000 });
    await capture(pageA, 'messages_userA_received');

    const additionalMessages = [
      { author: 'A', text: `A重登入測試-${Date.now()}-1` },
      { author: 'B', text: `B重登入測試-${Date.now()}-1` },
      { author: 'A', text: `A重登入測試-${Date.now()}-2` },
      { author: 'B', text: `B重登入測試-${Date.now()}-2` }
    ];
    const allMessageTexts = [messageFromA, messageFromB];

    const sendTextMessage = async ({ sender, receiver, text, label, receiverPeerUid, senderPeerUid }) => {
      await sender.fill('#messageInput', text);
      const responsePromise = sender.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/messages/secure'));
      await sender.click('#messageSend');
      await responsePromise.catch(() => {});
      await expect(sender.locator('#messagesList .message-bubble.message-me', { hasText: text })).toBeVisible({ timeout: 20000 });
      const senderState = await sender.evaluate(async (peerUid) => {
        const { drState } = await import('../app/core/store.js');
        const holder = drState(peerUid);
        const toB64 = (u8) => {
          if (!(u8 instanceof Uint8Array)) return null;
          let s = '';
          for (let i = 0; i < u8.length; i += 1) s += String.fromCharCode(u8[i]);
          return btoa(s);
        };
        return holder
          ? {
              hasRk: holder.rk instanceof Uint8Array,
              ckS: toB64(holder.ckS),
              ckR: toB64(holder.ckR),
              Ns: holder.Ns,
              Nr: holder.Nr,
              PN: holder.PN,
              myPub: toB64(holder.myRatchetPub),
              theirPub: toB64(holder.theirRatchetPub)
            }
          : null;
      }, senderPeerUid);
      // eslint-disable-next-line no-console
      console.log('[dr-state-after-send]', { text, senderPeerUid, state: senderState });
      const receiverState = await receiver.evaluate(async (peerUid) => {
        const { drState } = await import('../app/core/store.js');
        const holder = drState(peerUid);
        const toB64 = (u8) => {
          if (!(u8 instanceof Uint8Array)) return null;
          let s = '';
          for (let i = 0; i < u8.length; i += 1) s += String.fromCharCode(u8[i]);
          return btoa(s);
        };
        return holder
          ? {
              hasRk: holder.rk instanceof Uint8Array,
              ckS: toB64(holder.ckS),
              ckR: toB64(holder.ckR),
              Ns: holder.Ns,
              Nr: holder.Nr,
              PN: holder.PN,
              myPub: toB64(holder.myRatchetPub),
              theirPub: toB64(holder.theirRatchetPub)
            }
          : null;
      }, receiverPeerUid);
      // eslint-disable-next-line no-console
      console.log('[dr-state-before-message]', { text, receiverPeerUid, state: receiverState });
      await expect(receiver.locator('#messagesList .message-bubble.message-peer', { hasText: text })).toBeVisible({ timeout: 20000 });
      if (label) {
        await capture(sender, label);
      }
    };

    for (const [index, msg] of additionalMessages.entries()) {
      const fromA = msg.author === 'A';
      const senderPage = fromA ? pageA : pageB;
      const receiverPage = fromA ? pageB : pageA;
      await sendTextMessage({
        sender: senderPage,
        receiver: receiverPage,
        text: msg.text,
        label: `messages_additional_${msg.author}_${index + 1}`,
        receiverPeerUid: fromA ? userA.uidHex : userB.uidHex,
        senderPeerUid: fromA ? userB.uidHex : userA.uidHex
      });
      allMessageTexts.push(msg.text);
    }

    const uniqueMessageTexts = Array.from(new Set(allMessageTexts));
    const recentMessageTexts = uniqueMessageTexts.slice(-4);

    const verifyConversationPersistence = async ({
      targetPage,
      peerUid,
      messageTexts = [],
      attachmentNames = [],
      screenshotLabel
    }) => {
      const backBtn = targetPage.locator('#messagesBackBtn');
      try {
        if (await backBtn.isVisible()) {
          await backBtn.click();
          await targetPage.waitForTimeout(200);
        }
      } catch {}
      await targetPage.evaluate(() => document.getElementById('messagesBackBtn')?.click());
      await targetPage.waitForTimeout(200);
      await targetPage.evaluate(() => document.getElementById('nav-messages')?.click());
      const selector = `.conversation-item[data-peer="${peerUid}"]`;
      await targetPage.waitForFunction((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }, selector, { timeout: 20000 });
      await targetPage.evaluate(async ({ peer, selector: sel }) => {
        try {
          const pane = window.__messagesPane;
          if (pane?.setActiveConversation) {
            await pane.setActiveConversation(peer);
          } else {
            const el = document.querySelector(sel);
            el?.dispatchEvent(new Event('click', { bubbles: true }));
          }
          if (pane?.loadActiveConversationMessages) {
            await pane.loadActiveConversationMessages({ append: false, replay: true });
          }
        } catch (err) {
          console.log('[verifyConversationPersistence.loadConversation]', err?.message || err);
        }
      }, { peer: peerUid, selector });
      await targetPage.waitForTimeout(500);
      await targetPage.waitForTimeout(300);
      try {
        await targetPage.evaluate(async (peer) => {
          try {
            const mod = await import('../app/features/dr-session.js');
            if (mod?.ensureDrReceiverState) {
              await mod.ensureDrReceiverState({ peerUidHex: peer });
            }
          } catch (err) {
            console.log('[verifyConversationPersistence.ensureDrReceiverState]', err?.message || err);
          }
        }, peerUid);
      } catch {}
      await expect
        .poll(async () => targetPage.locator('#messagesList .message-bubble').count(), { timeout: 30000 })
        .toBeGreaterThan(0);
      if (Array.isArray(messageTexts)) {
        for (const text of messageTexts) {
          if (!text) continue;
          await expect(targetPage.locator('#messagesList .message-bubble', { hasText: text })).toBeVisible({ timeout: 30000 });
        }
      }
      if (Array.isArray(attachmentNames)) {
        for (const name of attachmentNames) {
          if (!name) continue;
          const fileBubble = targetPage.locator('.message-bubble', {
            has: targetPage.locator('.message-file-name', { hasText: name })
          }).last();
          await expect(fileBubble).toBeVisible({ timeout: 30000 });
        }
      }
      if (screenshotLabel) {
        await capture(targetPage, screenshotLabel);
      }
      await targetPage.evaluate(() => document.getElementById('messagesBackBtn')?.click());
      await targetPage.waitForTimeout(200);
    };

    const verifyContactNavigationLoadsConversation = async ({
      targetPage,
      peerUid,
      messageTexts = [],
      attachmentNames = [],
      screenshotLabel
    }) => {
      await targetPage.evaluate(() => document.getElementById('nav-contacts')?.click());
      await targetPage.waitForTimeout(300);
      const selector = `.contact-item[data-peer-uid="${peerUid}"]`;
      await targetPage.locator(selector).first().waitFor({ state: 'visible', timeout: 20000 });
      const contactItem = targetPage.locator(selector).first();
      await contactItem.scrollIntoViewIfNeeded();
      await contactItem.click();
      await targetPage.waitForTimeout(500);
      await expect
        .poll(async () => targetPage.locator('#messagesList .message-bubble').count(), { timeout: 30000 })
        .toBeGreaterThan(0);
      if (Array.isArray(messageTexts)) {
        for (const text of messageTexts) {
          if (!text) continue;
          await expect(targetPage.locator('#messagesList .message-bubble', { hasText: text })).toBeVisible({ timeout: 30000 });
        }
      }
      if (Array.isArray(attachmentNames)) {
        for (const name of attachmentNames) {
          if (!name) continue;
          const fileBubble = targetPage.locator('.message-bubble', {
            has: targetPage.locator('.message-file-name', { hasText: name })
          }).last();
          await expect(fileBubble).toBeVisible({ timeout: 30000 });
        }
      }
      if (screenshotLabel) {
        await capture(targetPage, screenshotLabel);
      }
      await targetPage.evaluate(() => document.getElementById('messagesBackBtn')?.click());
      await targetPage.waitForTimeout(200);
    };

    const logoutUser = async (targetPage, label) => {
      await targetPage.evaluate(() => document.getElementById('nav-drive')?.click());
      await targetPage.waitForTimeout(200);
      await targetPage.waitForSelector('#btnUserMenu', { timeout: 5000 });
      await targetPage.locator('#btnUserMenu').click();
      await targetPage.waitForSelector('[data-action="logout"]', { timeout: 5000 });
      await targetPage.click('[data-action="logout"]');
      await targetPage.waitForURL('**/pages/logout.html', { timeout: 20000 });
      await capture(targetPage, `${label}_logged_out_for_relogin`);
    };

    await logoutUser(pageA, 'userA');
    await logoutUser(pageB, 'userB');

    await performLogin(pageA, { password: userA.password, uidHex: userA.uidHex });
    await pageA.waitForTimeout(1000);
    await capture(pageA, 'userA_relogin_ready');
    await pageA.evaluate(() => document.getElementById('nav-messages')?.click());
    const conversationItemAAfterRelogin = pageA.locator(`.conversation-item[data-peer="${userB.uidHex}"]`);
    await conversationItemAAfterRelogin.waitFor({ state: 'visible', timeout: 30000 });
    await conversationItemAAfterRelogin.click();
    await pageA.waitForTimeout(500);
    const drStateInfoAfterReloginA = await pageA.evaluate(async (peerUid) => {
      const { drState } = await import('../app/core/store.js');
      const state = drState(peerUid);
      return {
        hasState: !!(state && state.rk && state.myRatchetPriv && state.myRatchetPub),
        Ns: state?.Ns ?? null,
        Nr: state?.Nr ?? null,
        PN: state?.PN ?? null
      };
    }, userB.uidHex);
    expect(drStateInfoAfterReloginA.hasState, `dr state missing after relogin (A): ${JSON.stringify(drStateInfoAfterReloginA)}`).toBeTruthy();
    for (const text of uniqueMessageTexts) {
      await expect(pageA.locator('#messagesList .message-bubble', { hasText: text })).toBeVisible({ timeout: 20000 });
    }
    await capture(pageA, 'messages_userA_after_relogin');

    await performLogin(pageB, { password: userB.password, uidHex: userB.uidHex });
    await pageB.waitForTimeout(1000);
    await capture(pageB, 'userB_relogin_ready');
    await pageB.evaluate(() => document.getElementById('nav-messages')?.click());
    const conversationItemBAfterRelogin = pageB.locator(`.conversation-item[data-peer="${userA.uidHex}"]`);
    await conversationItemBAfterRelogin.waitFor({ state: 'visible', timeout: 30000 });
    await conversationItemBAfterRelogin.click();
    await pageB.waitForTimeout(500);
    const drStateInfoAfterReloginB = await pageB.evaluate(async (peerUid) => {
      const { drState } = await import('../app/core/store.js');
      const state = drState(peerUid);
      return {
        hasState: !!(state && state.rk && state.myRatchetPriv && state.myRatchetPub),
        Ns: state?.Ns ?? null,
        Nr: state?.Nr ?? null,
        PN: state?.PN ?? null
      };
    }, userA.uidHex);
    expect(drStateInfoAfterReloginB.hasState, `dr state missing after relogin (B): ${JSON.stringify(drStateInfoAfterReloginB)}`).toBeTruthy();
    for (const text of uniqueMessageTexts) {
      await expect(pageB.locator('#messagesList .message-bubble', { hasText: text })).toBeVisible({ timeout: 20000 });
    }
    await capture(pageB, 'messages_userB_after_relogin');

    await pageA.evaluate(() => document.getElementById('nav-messages')?.click());

    const sampleVideo = await createSampleVideoFile(pageA);
    const samplePdf = createSamplePdfFile();

    // 圖片附件預覽
    const imageSignPut = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/media/sign-put'));
    const imageSecurePost = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/messages/secure'));
    await pageA.click('#composerAttach');
    await pageA.setInputFiles('#messageFileInput', uploadFilePath);
    await imageSignPut.catch(() => {});
    await imageSecurePost.catch(() => {});
    const outgoingImageBubbleA = pageA.locator('.message-bubble.message-me', { has: pageA.locator('.message-file-name', { hasText: uploadFileName }) }).last();
    await expect(outgoingImageBubbleA.locator('.message-file-preview-image')).toBeVisible({ timeout: 30000 });
    await capture(pageA, 'messages_userA_image_preview');

    const incomingImageBubbleB = pageB.locator('.message-bubble', { has: pageB.locator('.message-file-name', { hasText: uploadFileName }) }).last();
    await expect(incomingImageBubbleB.locator('.message-file-preview-image')).toBeVisible({ timeout: 30000 });
    await capture(pageB, 'messages_userB_image_preview');

    // 影片附件預覽
    const videoSignPut = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/media/sign-put'));
    const videoSecurePost = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/messages/secure'));
    await pageA.click('#composerAttach');
    await pageA.setInputFiles('#messageFileInput', {
      name: sampleVideo.name,
      mimeType: sampleVideo.mimeType,
      buffer: sampleVideo.buffer
    });
    await videoSignPut.catch(() => {});
    await videoSecurePost.catch(() => {});
    const outgoingVideoBubbleA = pageA.locator('.message-bubble.message-me', { has: pageA.locator('.message-file-name', { hasText: sampleVideo.name }) }).last();
    await expect(outgoingVideoBubbleA.locator('.message-file-preview-video')).toBeVisible({ timeout: 30000 });
    await capture(pageA, 'messages_userA_video_preview');

    const incomingVideoBubbleB = pageB.locator('.message-bubble', { has: pageB.locator('.message-file-name', { hasText: sampleVideo.name }) }).last();
    await expect(incomingVideoBubbleB.locator('.message-file-preview-video')).toBeVisible({ timeout: 30000 });
    await capture(pageB, 'messages_userB_video_preview');

    // PDF 附件預覽
    const pdfSignPut = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/media/sign-put'));
    const pdfSecurePost = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/messages/secure'));
    await pageA.click('#composerAttach');
    await pageA.setInputFiles('#messageFileInput', {
      name: samplePdf.name,
      mimeType: samplePdf.mimeType,
      buffer: samplePdf.buffer
    });
    await pdfSignPut.catch(() => {});
    await pdfSecurePost.catch(() => {});
    const outgoingPdfBubbleA = pageA.locator('.message-bubble.message-me', { has: pageA.locator('.message-file-name', { hasText: samplePdf.name }) }).last();
    await expect(outgoingPdfBubbleA.locator('.message-file-preview-pdf')).toBeVisible({ timeout: 30000 });
    await capture(pageA, 'messages_userA_pdf_preview');

    const incomingPdfBubbleB = pageB.locator('.message-bubble', { has: pageB.locator('.message-file-name', { hasText: samplePdf.name }) }).last();
    await expect(incomingPdfBubbleB.locator('.message-file-preview-pdf')).toBeVisible({ timeout: 30000 });
    await capture(pageB, 'messages_userB_pdf_preview');
    await verifyConversationPersistence({
      targetPage: pageB,
      peerUid: userA.uidHex,
      messageTexts: recentMessageTexts,
      attachmentNames: [samplePdf.name],
      screenshotLabel: 'messages_userB_persistence_check'
    });
    await verifyContactNavigationLoadsConversation({
      targetPage: pageB,
      peerUid: userA.uidHex,
      messageTexts: recentMessageTexts,
      attachmentNames: [samplePdf.name],
      screenshotLabel: 'messages_userB_contact_entry'
    });

    await pageA.evaluate(async () => {
      document.getElementById('nav-messages')?.click();
      if (window.__refreshConversations) {
        await window.__refreshConversations();
      }
    });
    const conversationSnippetA = pageA.locator(`.conversation-item[data-peer="${userB.uidHex}"] .conversation-snippet`);
    // eslint-disable-next-line no-console
    console.log('[conversation-snippet-A]', await conversationSnippetA.textContent());
    await expect(conversationSnippetA).toContainText(samplePdf.name, { timeout: 20000 });
    await capture(pageA, 'messages_list_userA_after_reply');
    await verifyConversationPersistence({
      targetPage: pageA,
      peerUid: userB.uidHex,
      messageTexts: recentMessageTexts,
      attachmentNames: [samplePdf.name],
      screenshotLabel: 'messages_userA_persistence_check'
    });
    await verifyContactNavigationLoadsConversation({
      targetPage: pageA,
      peerUid: userB.uidHex,
      messageTexts: recentMessageTexts,
      attachmentNames: [samplePdf.name],
      screenshotLabel: 'messages_userA_contact_entry'
    });

    await pageA.evaluate(() => document.getElementById('messagesBackBtn')?.click());
    const convoDeleteBtn = pageA.locator(`.conversation-item[data-peer="${userB.uidHex}"] .item-delete`);
    await pageA.evaluate((peerUid) => {
      try {
        if (window.__messagesPane?.showDeleteForPeer) {
          window.__messagesPane.showDeleteForPeer(peerUid);
        } else {
          document.dispatchEvent(new CustomEvent('contacts:show-delete', { detail: { peerUid } }));
        }
      } catch {}
    }, userB.uidHex);
    await convoDeleteBtn.waitFor({ state: 'visible', timeout: 20000 });
    await convoDeleteBtn.click();
    await pageA.waitForSelector('#confirmOk', { timeout: 5000 });
    const convoDeleteReq = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/friends/delete'));
    await pageA.click('#confirmOk');
    await convoDeleteReq.catch(() => {});
    await expect(pageA.locator(`.conversation-item[data-peer="${userB.uidHex}"]`)).toHaveCount(0, { timeout: 20000 });
    await capture(pageA, 'conversation_deleted_from_userA');

    await pageA.evaluate(() => document.getElementById('nav-contacts')?.click());
    const contactAfterConversationA = pageA.locator(`.contact-item[data-peer-uid="${userB.uidHex}"]`);
    await expect(contactAfterConversationA).toBeVisible({ timeout: 20000 });
    await capture(pageA, 'contacts_after_conversation_delete_userA');

    await pageB.evaluate(() => document.getElementById('nav-contacts')?.click());
    const contactAfterConversationB = pageB.locator(`.contact-item[data-peer-uid="${userA.uidHex}"]`);
    await expect(contactAfterConversationB).toBeVisible({ timeout: 20000 });
    await capture(pageB, 'contacts_after_conversation_delete_userB');

    const contactDeleteBtnA = contactAfterConversationA.locator('.item-delete');
    const deleteBtnCount = await contactDeleteBtnA.count();
    // eslint-disable-next-line no-console
    console.log('[debug] contactDeleteBtnCount', deleteBtnCount);
    await contactDeleteBtnA.click();
    await pageA.waitForSelector('#confirmOk', { timeout: 5000 });
    const contactDeleteReq = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/friends/delete'));
    await pageA.click('#confirmOk');
    await contactDeleteReq.catch(() => {});
    await expect(pageA.locator(`.contact-item[data-peer-uid="${userB.uidHex}"]`)).toHaveCount(0, { timeout: 20000 });
    await capture(pageA, 'contacts_userA_deleted');

    await expect(pageB.locator(`.contact-item[data-peer-uid="${userA.uidHex}"]`)).toHaveCount(0, { timeout: 20000 });
    await capture(pageB, 'contacts_userB_deleted');

    await pageA.evaluate(() => document.getElementById('nav-drive')?.click());
    await pageA.waitForTimeout(200);
    await pageA.locator('#btnUserMenu').click();
    await pageA.waitForSelector('[data-action="logout"]', { timeout: 5000 });
    await pageA.click('[data-action="logout"]');
    await pageA.waitForURL('**/pages/logout.html', { timeout: 20000 });
    await capture(pageA, 'userA_logged_out');
  } finally {
    await contextB.close();
  }
});
