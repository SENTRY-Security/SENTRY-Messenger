import path from 'node:path';
import { expect } from '@playwright/test';
import { encodeFriendInvite } from '../../web/src/app/lib/invite.js';

export function tapConsole(page, label) {
  page.on('console', (msg) => {
    // eslint-disable-next-line no-console
    console.log(`[${label} console]`, msg.type(), msg.text());
  });
  page.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[${label} pageerror]`, err?.message || err);
  });
  page.on('requestfailed', (request) => {
    // eslint-disable-next-line no-console
    console.log(
      `[${label} requestfailed]`,
      request.method(),
      request.url(),
      request.failure()?.errorText
    );
  });
}

async function ensureNavBarVisible(page) {
  await page.evaluate(() => {
    const backBtn = document.getElementById('messagesBackBtn');
    if (!backBtn) return;
    const style = window.getComputedStyle(backBtn);
    if (style.display !== 'none' && style.visibility !== 'hidden') {
      backBtn.click();
    }
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const modal = document.getElementById('modal');
    if (modal && modal.classList.contains('security-modal')) {
      modal.style.display = 'none';
      modal.setAttribute('aria-hidden', 'true');
    }
  });
  await page.waitForFunction(() => {
    const modal = document.getElementById('modal');
    if (!modal) return true;
    const isSecurity = modal.classList.contains('security-modal');
    const hidden = modal.getAttribute('aria-hidden') === 'true' || window.getComputedStyle(modal).display === 'none';
    return !isSecurity || hidden;
  }, null, { timeout: 20000 });
}

export async function openContactsTab(page) {
  await ensureNavBarVisible(page);
  await page.locator('#nav-contacts').click();
  await page.waitForFunction(() => {
    const tab = document.getElementById('tab-contacts');
    if (!tab) return false;
    const style = window.getComputedStyle(tab);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }, null, { timeout: 15000 });
}

export async function openMessagesTab(page) {
  await ensureNavBarVisible(page);
  await page.locator('#nav-messages').click();
  await page.waitForFunction(() => {
    const tab = document.getElementById('tab-messages');
    if (!tab) return false;
    const style = window.getComputedStyle(tab);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }, null, { timeout: 15000 });
}

export async function openShareModalAndGenerateInvite(page) {
  await page.locator('#nav-profile').click();
  await page.waitForFunction(() => {
    const tab = document.getElementById('tab-profile');
    if (!tab) return false;
    const style = window.getComputedStyle(tab);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }, null, { timeout: 15000 });
  await page.locator('#btnShareModal').click();
  await page.waitForFunction(() => {
    const modal = document.getElementById('shareModal');
    return !!modal && modal.getAttribute('data-share-mode') === 'qr';
  }, null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const ctrl = window.__shareController;
    if (!ctrl || typeof ctrl.getCurrentInvite !== 'function') return null;
    const invite = ctrl.getCurrentInvite();
    if (!invite || !invite.inviteId || !invite.secret) return null;
    return invite;
  }, null, { timeout: 20000 });
  const invite = await page.evaluate(() => {
    const ctrl = window.__shareController;
    return ctrl.getCurrentInvite();
  });
  const encoded = encodeFriendInvite(invite);
  if (!encoded) {
    throw new Error('Failed to encode invite payload');
  }
  return { invite, encoded };
}

export async function acceptInviteViaScan(page, inviteString) {
  await page.evaluate(() => {
    const ctrl = window.__shareController;
    ctrl.openShareModal('scan');
  });
  await page.waitForFunction(() => {
    const modal = document.getElementById('shareModal');
    return !!modal && modal.getAttribute('data-share-mode') === 'scan';
  }, null, { timeout: 15000 });
  await page.evaluate(async (payload) => {
    const ctrl = window.__shareController;
    await ctrl.handleInviteScan(payload);
    ctrl.closeShareModal();
  }, inviteString);
  await page.waitForFunction(() => {
    const modal = document.getElementById('shareModal');
    if (!modal) return true;
    return modal.style.display === 'none' || modal.getAttribute('aria-hidden') === 'true';
  }, null, { timeout: 20000 });
}

export async function waitForContactCard(page, peerUid, options = {}) {
  const normalized = String(peerUid || '').toUpperCase();
  const selector = `#contactsList .contact-item[data-peer-uid="${normalized}"]`;
  await openContactsTab(page);
  await page.waitForSelector(selector, {
    state: 'visible',
    timeout: options.timeout ?? 30000
  });
}

export async function openConversationWithPeer(page, peerUid) {
  const normalized = String(peerUid || '').toUpperCase();
  const contactSelector = `#contactsList .contact-item[data-peer-uid="${normalized}"]`;
  await openContactsTab(page);
  await page.waitForSelector(contactSelector, { state: 'visible', timeout: 30000 });
  await page.click(contactSelector);
  await page.waitForFunction((peer) => {
    const pane = window.__messagesPane;
    if (!pane || typeof pane.getMessageState !== 'function') return false;
    const state = pane.getMessageState();
    if (!state) return false;
    return String(state.activePeerUid || '').toUpperCase() === peer;
  }, normalized, { timeout: 20000 });
}

export async function waitForSecureConversationReady(page, peerUid, options = {}) {
  const normalized = String(peerUid || '').toUpperCase();
  await page.waitForFunction((peer) => {
    const pane = window.__messagesPane;
    if (!pane || typeof pane.getMessageState !== 'function') return false;
    const state = pane.getMessageState();
    if (!state || String(state.activePeerUid || '').toUpperCase() !== peer) return false;
    const status = document.getElementById('messagesStatus');
    const input = document.getElementById('messageInput');
    const sendBtn = document.getElementById('messageSend');
    if (!status || !input || !sendBtn) return false;
    const statusText = (status.textContent || '').trim();
    return statusText === '' &&
      input.placeholder === '輸入訊息…' &&
      !input.disabled &&
      !sendBtn.disabled;
  }, normalized, { timeout: options.timeout ?? 45000 });
}

export async function dismissToasts(page) {
  const toast = page.locator('#appToast');
  if (!toast) return;
  const isVisible = await toast.isVisible().catch(() => false);
  if (isVisible) {
    await page.evaluate(() => {
      try {
        const toastEl = document.getElementById('appToast');
        toastEl?.classList?.remove?.('show');
      } catch {}
    }).catch(() => {});
  }
  await toast.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

export async function disableTopbarPointerEvents(page) {
  const applied = await page.evaluate(() => {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return false;
    if (!topbar.dataset.prevPointerEvents) {
      topbar.dataset.prevPointerEvents = topbar.style.pointerEvents || '';
    }
    topbar.style.pointerEvents = 'none';
    return true;
  }).catch(() => false);
  return async () => {
    if (!applied) return;
    await page.evaluate(() => {
      const topbar = document.querySelector('.topbar');
      if (!topbar) return;
      const prev = topbar.dataset.prevPointerEvents ?? '';
      topbar.style.pointerEvents = prev;
      delete topbar.dataset.prevPointerEvents;
    }).catch(() => {});
  };
}

export async function sendTextMessage(page, text) {
  await page.fill('#messageInput', text);
  await expect(page.locator('#messageSend')).toBeEnabled();
  await page.click('#messageSend');
}

export async function expectMessageBubble(page, text, options = {}) {
  const locator = page.locator('#messagesList .message-bubble', { hasText: text });
  await expect(locator).toBeVisible({ timeout: options.timeout ?? 20000 });
}

export async function sendFileAttachment(page, filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  await page.click('#composerAttach');
  const signPutPromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && response.url().includes('/api/v1/media/sign-put')
  ));
  const securePostPromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && response.url().includes('/api/v1/messages/secure')
  ));
  await page.setInputFiles('#messageFileInput', absolutePath);
  await Promise.all([signPutPromise, securePostPromise]);
  const fileName = options.fileName ?? path.basename(filePath);
  const bubble = page.locator('.message-bubble.message-me', {
    has: page.locator('.message-file-name', { hasText: fileName })
  }).last();
  await expect(bubble).toBeVisible({ timeout: options.timeout ?? 30000 });
}

export async function ensureModalClosed(page) {
  await page.evaluate(() => {
    const ctrl = window.__shareController;
    if (ctrl) ctrl.closeShareModal();
  });
}

export async function persistContactSecretsForRelogin(page) {
  return page.evaluate(() => {
    try {
      const uidHex = sessionStorage.getItem('uid_hex') || localStorage.getItem('uid_hex');
      const normalizedUid = uidHex ? uidHex.replace(/[^0-9A-Fa-f]/g, '').toUpperCase() : null;
      const contactKey = normalizedUid ? `contactSecrets-v1:uid-${normalizedUid}` : 'contactSecrets-v1';
      const latestKey = normalizedUid ? `contactSecrets-v1-latest:uid-${normalizedUid}` : 'contactSecrets-v1-latest';
      const snapshot = localStorage.getItem(contactKey) || localStorage.getItem('contactSecrets-v1');
      if (!snapshot) return null;
      window.__LOGIN_SEED_LOCALSTORAGE = window.__LOGIN_SEED_LOCALSTORAGE || {};
      window.__LOGIN_SEED_LOCALSTORAGE[contactKey] = snapshot;
      window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1'] = snapshot;
      window.__LOGIN_SEED_LOCALSTORAGE[latestKey] = snapshot;
      window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1-latest'] = snapshot;
      return snapshot;
    } catch (err) {
      console.warn('[multi-account-test] persist contact secrets failed', err);
      return null;
    }
  });
}
