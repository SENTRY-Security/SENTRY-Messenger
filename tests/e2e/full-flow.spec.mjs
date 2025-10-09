import path from 'node:path';
import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { performLogin, startWebServer, stopWebServer, ensureDir, E2E_ARTIFACT_DIR, ORIGIN } from './utils.mjs';
import { setupFriendConversation } from '../../scripts/lib/friends-flow.mjs';

const SCREENSHOT_DIR = path.join(E2E_ARTIFACT_DIR, 'screens');

let serverProc;
let friendSetup;

test.beforeAll(async () => {
  await ensureDir(E2E_ARTIFACT_DIR);
  await ensureDir(SCREENSHOT_DIR);
  friendSetup = await setupFriendConversation({
    origin: ORIGIN,
    messageFromA: 'E2E bootstrap from user A',
    messageFromB: 'E2E bootstrap from user B'
  });
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
        updatedAt: nowTs
      }
    ]
  ]);
  await pageA.addInitScript((value) => {
    try { localStorage.setItem('contactSecrets-v1', value); } catch {}
  }, secretEntryForA);

  try {
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

    const secretEntryForB = JSON.stringify([
      [
        userA.uidHex,
        {
          inviteId: friendSetup.invite.inviteId,
          secret: friendSetup.invite.secret,
          role: 'guest',
          conversationToken: friendSetup.conversation.tokenB64,
          conversationId: friendSetup.conversation.conversationId,
          updatedAt: nowTs
        }
      ]
    ]);
    await pageB.addInitScript((value) => {
      try { localStorage.setItem('contactSecrets-v1', value); } catch {}
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
    const contactNameOnB = pageB.locator(`.contact-item[data-peer-uid="${userA.uidHex}"] .name-text`);
    // eslint-disable-next-line no-console
    console.log('[contact-text]', await contactNameOnB.textContent());
    await expect(contactNameOnB).toHaveText(newNickname, { timeout: 20000 });
    await capture(pageB, 'userB_contacts_nickname_refreshed');
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
    await pageB.waitForFunction((peerUid) => {
      const img = document.querySelector(`.contact-item[data-peer-uid="${peerUid}"] img`);
      return !!img;
    }, userA.uidHex, { timeout: 30000 });
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
    const messageFromALocatorB = pageB.locator('#messagesList .message-bubble', { hasText: messageFromA });
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

    const incomingOnA = pageA.locator('#messagesList .message-bubble', { hasText: messageFromB });
    await expect(incomingOnA).toBeVisible({ timeout: 20000 });
    await capture(pageA, 'messages_userA_received');
    await pageA.evaluate(async () => {
      document.getElementById('nav-messages')?.click();
      if (window.__refreshConversations) {
        await window.__refreshConversations();
      }
    });
    const conversationSnippetA = pageA.locator(`.conversation-item[data-peer="${userB.uidHex}"] .conversation-snippet`);
    // eslint-disable-next-line no-console
    console.log('[conversation-snippet-A]', await conversationSnippetA.textContent());
    await capture(pageA, 'messages_list_userA_after_reply');

    await pageA.evaluate(() => document.getElementById('messagesBackBtn')?.click());
    const convoDeleteBtn = pageA.locator(`.conversation-item[data-peer="${userB.uidHex}"] .item-delete`);
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

    await contactAfterConversationA.locator('.item-delete').click();
    await pageA.waitForSelector('#confirmOk', { timeout: 5000 });
    const contactDeleteReq = pageA.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/api/v1/friends/delete'));
    await pageA.click('#confirmOk');
    await contactDeleteReq.catch(() => {});
    await expect(pageA.locator(`.contact-item[data-peer-uid="${userB.uidHex}"]`)).toHaveCount(0, { timeout: 20000 });
    await capture(pageA, 'contacts_userA_deleted');

    await expect(pageB.locator(`.contact-item[data-peer-uid="${userA.uidHex}"]`)).toHaveCount(0, { timeout: 20000 });
    await capture(pageB, 'contacts_userB_deleted');

    await pageA.evaluate(() => document.getElementById('btnUserMenu')?.click());
    await pageA.waitForSelector('[data-action="logout"]', { timeout: 5000 });
    await pageA.click('[data-action="logout"]');
    await pageA.waitForURL('**/pages/login.html', { timeout: 20000 });
    await capture(pageA, 'userA_logged_out');
  } finally {
    await contextB.close();
  }
});
