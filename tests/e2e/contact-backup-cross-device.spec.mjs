import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  performLogin,
  startWebServer,
  stopWebServer
} from './utils.mjs';
import {
  tapConsole,
  openContactsTab,
  openShareModalAndGenerateInvite,
  acceptInviteViaScan,
  waitForContactCard,
  openConversationWithPeer,
  waitForSecureConversationReady,
  sendTextMessage,
  expectMessageBubble,
  ensureModalClosed
} from './multi-account-helpers.mjs';

const DEFAULT_PASSWORD = 'test1234';

let serverProc;
test.beforeAll(async () => {
  serverProc = await startWebServer();
});

test.afterAll(async () => {
  await stopWebServer(serverProc);
});

test.describe('contact secrets backup', () => {
  test('permits decrypting history after swapping devices/chips', async ({ browser }) => {
    test.setTimeout(240_000);

    const owner = createAccount('owner');
    const guest = createAccount('guest');

    const deviceA = await browser.newContext();
    const deviceB = await browser.newContext();
    const ownerPage = await deviceA.newPage();
    const guestPage = await deviceB.newPage();
    tapConsole(ownerPage, 'owner-initial');
    tapConsole(guestPage, 'guest-initial');

    await performLogin(ownerPage, { uidHex: owner.uidHex, password: owner.password });
    await performLogin(guestPage, { uidHex: guest.uidHex, password: guest.password });

    await establishFriendship(ownerPage, guestPage, owner, guest);

    const initialMessageFromOwner = `owner → guest ${Date.now()}`;
    const initialReplyFromGuest = `guest → owner ${Date.now()}`;

    await exchangeMessages(ownerPage, guestPage, owner, guest, initialMessageFromOwner, initialReplyFromGuest);

    await forceContactSecretsBackup(ownerPage, 'owner-initial-backup');
    await forceContactSecretsBackup(guestPage, 'guest-initial-backup');

    await logoutFromApp(ownerPage);
    await logoutFromApp(guestPage);
    await deviceA.close();
    await deviceB.close();

    const swappedDevice1 = await browser.newContext();
    const swappedDevice2 = await browser.newContext();
    const guestOnDevice1 = await swappedDevice1.newPage();
    const ownerOnDevice2 = await swappedDevice2.newPage();
    tapConsole(guestOnDevice1, 'guest-swapped');
    tapConsole(ownerOnDevice2, 'owner-swapped');

    await loginExpectingBackupFetch(guestOnDevice1, guest, 'guest-swapped');
    await verifyHistoryAfterSwap({
      page: guestOnDevice1,
      peer: owner,
      self: guest,
      expectMessage: initialMessageFromOwner
    });
    const resumedMessageFromGuest = `guest resumed ${Date.now()}`;
    await sendTextMessage(guestOnDevice1, resumedMessageFromGuest);
    await expectMessageBubble(guestOnDevice1, resumedMessageFromGuest, { timeout: 30000 });

    await loginExpectingBackupFetch(ownerOnDevice2, owner, 'owner-swapped');
    await verifyHistoryAfterSwap({
      page: ownerOnDevice2,
      peer: guest,
      self: owner,
      expectMessage: initialReplyFromGuest
    });
    await openConversationWithPeer(ownerOnDevice2, guest.uidHex);
    await expectMessageBubble(ownerOnDevice2, resumedMessageFromGuest, { timeout: 60000 });

    await swappedDevice1.close();
    await swappedDevice2.close();
  });
});

function createAccount(label) {
  return {
    label,
    uidHex: crypto.randomBytes(7).toString('hex').toUpperCase(),
    password: DEFAULT_PASSWORD
  };
}

async function establishFriendship(ownerPage, guestPage, owner, guest) {
  await openContactsTab(ownerPage);
  const { encoded } = await openShareModalAndGenerateInvite(ownerPage);
  await acceptInviteViaScan(guestPage, encoded);
  await waitForContactCard(ownerPage, guest.uidHex);
  await waitForContactCard(guestPage, owner.uidHex);
  await ensureModalClosed(ownerPage);
  await ensureModalClosed(guestPage);
}

async function exchangeMessages(ownerPage, guestPage, owner, guest, ownerMessage, guestReply) {
  await openConversationWithPeer(ownerPage, guest.uidHex);
  await waitForSecureConversationReady(ownerPage, guest.uidHex);
  await sendTextMessage(ownerPage, ownerMessage);
  await expectMessageBubble(ownerPage, ownerMessage);

  await openConversationWithPeer(guestPage, owner.uidHex);
  await waitForSecureConversationReady(guestPage, owner.uidHex);
  await expectMessageBubble(guestPage, ownerMessage);

  await sendTextMessage(guestPage, guestReply);
  await expectMessageBubble(guestPage, guestReply);

  await openConversationWithPeer(ownerPage, guest.uidHex);
  await expectMessageBubble(ownerPage, guestReply);
}

async function forceContactSecretsBackup(page, label) {
  const backupPromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().includes('/api/v1/contact-secrets/backup')
  , { timeout: 30000 });
  const result = await page.evaluate(async ({ reason }) => {
    const mod = await import('/app/features/contact-backup.js');
    return mod.triggerContactSecretsBackup(reason, { force: true });
  }, { reason: label });
  const response = await backupPromise;
  expect(result, `${label} backup should trigger`).toBeTruthy();
  expect(response.ok(), `${label} backup upload should succeed`).toBeTruthy();
}

async function logoutFromApp(page) {
  await page.evaluate(() => document.getElementById('nav-drive')?.click());
  await page.waitForSelector('#btnUserMenu', { timeout: 10000 });
  await page.locator('#btnUserMenu').click();
  await page.waitForSelector('[data-action="logout"]', { timeout: 5000 });
  await Promise.all([
    page.waitForURL('**/pages/logout.html', { timeout: 20000 }),
    page.click('[data-action="logout"]')
  ]);
}

async function loginExpectingBackupFetch(page, account, label) {
  const fetchPromise = page.waitForResponse((response) =>
    response.request().method() === 'GET' &&
    response.url().includes('/api/v1/contact-secrets/backup')
  , { timeout: 60000 });
  await performLogin(page, { uidHex: account.uidHex, password: account.password });
  const response = await fetchPromise;
  expect(response.ok(), `${label} should fetch remote backup successfully`).toBeTruthy();
}

async function verifyHistoryAfterSwap({ page, peer, self, expectMessage }) {
  await waitForContactCard(page, peer.uidHex);
  await openConversationWithPeer(page, peer.uidHex);
  await waitForSecureConversationReady(page, peer.uidHex, { timeout: 60000 });
  await expectMessageBubble(page, expectMessage, { timeout: 60000 });
}
