import { test, expect } from '@playwright/test';
import { performLogin, startWebServer, stopWebServer, ensureDir, E2E_ARTIFACT_DIR, ORIGIN, buildContactSecretsKey, buildContactSecretsLatestKey } from './utils.mjs';
import { setupFriendConversation } from '../../scripts/lib/friends-flow.mjs';

let serverProc;
let friendSetup;

function buildContactSecretsSnapshot({ invite, conversation, userB }) {
  const peerUid = (userB?.uidHex || '').toUpperCase();
  const inviteId = invite?.inviteId || invite?.invite_id || null;
  const inviteSecret = invite?.secret || null;
  const role = 'owner';
  const token = conversation?.tokenB64 || conversation?.token_b64 || null;
  const conversationId = conversation?.conversationId || conversation?.conversation_id || null;
  const drInit = conversation?.drInit || conversation?.dr_init || null;
  if (!peerUid || !inviteId || !inviteSecret) return null;
  const entry = {
    peerUid,
    invite: {
      id: inviteId,
      secret: inviteSecret,
      role
    },
    conversation: {
      token,
      id: conversationId
    },
    meta: {
      updatedAt: Math.floor(Date.now() / 1000)
    }
  };
  if (drInit && typeof drInit === 'object') {
    entry.conversation.drInit = drInit;
  }
  const snapshot = {
    v: 1,
    generatedAt: Date.now(),
    entries: [entry]
  };
  return JSON.stringify(snapshot);
}

test.beforeAll(async () => {
  await ensureDir(E2E_ARTIFACT_DIR);
  friendSetup = await setupFriendConversation({ origin: ORIGIN });
  serverProc = await startWebServer();
});

test.afterAll(async () => {
  await stopWebServer(serverProc);
});

test('secure conversation ready on new device without prior messages', async ({ browser }) => {
  test.skip(!friendSetup, 'friend setup failed');
  const context = await browser.newContext();
  const page = await context.newPage();
  const { userA, userB } = friendSetup;

  const contactSecretSnapshot = buildContactSecretsSnapshot({
    invite: friendSetup.invite,
    conversation: friendSetup.conversation,
    userB
  });
  if (contactSecretSnapshot) {
    const contactKey = buildContactSecretsKey(userA.uidHex);
    const latestKey = buildContactSecretsLatestKey(userA.uidHex);
    await page.addInitScript(({ snapshot, contactKey: key, latestKey: latest }) => {
      window.__LOGIN_SEED_LOCALSTORAGE = window.__LOGIN_SEED_LOCALSTORAGE || {};
      if (key) window.__LOGIN_SEED_LOCALSTORAGE[key] = snapshot;
      window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1'] = snapshot;
      if (latest) window.__LOGIN_SEED_LOCALSTORAGE[latest] = snapshot;
      window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1-latest'] = snapshot;
      window.__LOGIN_SEED_LOCALSTORAGE.__CONTACT_SECRET_SOURCE = 'preseed';
    }, { snapshot: contactSecretSnapshot, contactKey, latestKey });
  }

  await performLogin(page, { uidHex: userA.uidHex, password: userA.password });

  await page.waitForFunction(() => {
    return typeof window !== 'undefined' &&
      window.__messagesPane &&
      typeof window.__messagesPane.setActiveConversation === 'function' &&
      typeof window.__messagesPane.getMessageState === 'function';
  }, null, { timeout: 15000 });

  await page.evaluate(async () => {
    try {
      if (typeof window.__refreshContacts === 'function') {
        await window.__refreshContacts();
      }
    } catch (err) {
      console.log('[bootstrap-test] refresh contacts failed', err?.message || err);
    }
  });

  await page.waitForFunction((peer) => {
    const pane = window.__messagesPane;
    if (!pane || typeof pane.ensureConversationIndex !== 'function') {
      return false;
    }
    const index = pane.ensureConversationIndex();
    if (!index || typeof index.forEach !== 'function') return false;
    let found = false;
    index.forEach((info) => {
      if (info && String(info.peerUid || '').toUpperCase() === peer) {
        found = true;
      }
    });
    return found;
  }, userB.uidHex, { timeout: 45000 });

  await page.evaluate(() => {
    try {
      window.__messagesPane?.syncConversationThreadsFromContacts?.();
      window.__messagesPane?.renderConversationList?.();
    } catch (err) {
      console.log('[bootstrap-test] sync conversation threads failed', err?.message || err);
    }
  });

  await page.evaluate(() => {
    const navContacts = document.getElementById('nav-contacts');
    if (navContacts) navContacts.click();
  });

  await page.waitForFunction(() => {
    const tab = document.getElementById('tab-contacts');
    if (!tab) return false;
    return window.getComputedStyle(tab).display !== 'none';
  }, null, { timeout: 15000 });

  const contactSelector = `#contactsList .contact-item[data-peer-uid="${userB.uidHex}"]`;
  await page.waitForSelector(contactSelector, { state: 'attached', timeout: 30000 });
  await page.waitForFunction((selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }, contactSelector, { timeout: 15000 });

  await page.click(contactSelector);

  await page.waitForFunction((peer) => {
    const pane = window.__messagesPane;
    if (!pane || typeof pane.getMessageState !== 'function') return false;
    const state = pane.getMessageState();
    if (!state) return false;
    return String(state.activePeerUid || '').toUpperCase() === peer;
  }, userB.uidHex, { timeout: 30000 });

  let pendingObserved = false;
  try {
    const phase = await page.waitForFunction(() => {
      const status = document.getElementById('messagesStatus');
      const input = document.getElementById('messageInput');
      const sendBtn = document.getElementById('messageSend');
      if (!status || !input || !sendBtn) return undefined;
      const statusText = (status.textContent || '').trim();
      if (statusText === '正在建立安全對話…' &&
        input.placeholder === '正在建立安全對話…' &&
        input.disabled &&
        sendBtn.disabled) {
        return 'pending';
      }
      if (statusText === '' &&
        input.placeholder === '輸入訊息…' &&
        !input.disabled &&
        !sendBtn.disabled) {
        return 'ready';
      }
      return undefined;
    }, null, { timeout: 15000 });
    pendingObserved = phase === 'pending';
  } catch {
    pendingObserved = false;
  }

  if (pendingObserved) {
    await page.waitForFunction(() => {
      const modal = document.getElementById('modal');
      if (!modal) return false;
      if (!modal.classList.contains('security-modal')) return false;
      if (modal.getAttribute('aria-hidden') === 'true') return false;
      return window.getComputedStyle(modal).display !== 'none';
    }, null, { timeout: 15000 });
  }

  await page.waitForFunction(() => {
    const status = document.getElementById('messagesStatus');
    const input = document.getElementById('messageInput');
    const sendBtn = document.getElementById('messageSend');
    if (!status || !input || !sendBtn) return false;
    const statusText = (status.textContent || '').trim();
    return statusText === '' &&
      input.placeholder === '輸入訊息…' &&
      !input.disabled &&
      !sendBtn.disabled;
  }, null, { timeout: 45000 });

  if (pendingObserved) {
    await page.waitForFunction(() => {
      const modal = document.getElementById('modal');
      if (!modal) return true;
      if (!modal.classList.contains('security-modal')) return true;
      if (modal.getAttribute('aria-hidden') === 'true') return true;
      return window.getComputedStyle(modal).display === 'none';
    }, null, { timeout: 20000 });
  }

  const testMessage = 'bootstrap device hello';
  await page.fill('#messageInput', testMessage);
  await page.click('#messageSend');

  await expect(page.locator('#messagesList .message-bubble', { hasText: testMessage })).toBeVisible({ timeout: 30000 });

  await context.close();
});
