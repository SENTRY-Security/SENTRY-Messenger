import { test, expect } from '@playwright/test';
import { performLogin, startWebServer, stopWebServer } from './utils.mjs';

let serverProc;
test.beforeAll(async () => {
  serverProc = await startWebServer();
});

test.afterAll(async () => {
  await stopWebServer(serverProc);
});

test('app navigation and settings interactions work', async ({ page }) => {
  await performLogin(page);

  // Verify default tab
  await expect(page.locator('#nav-drive')).toHaveClass(/active/);

  // Navigate to profile and ensure nickname loaded
  await page.evaluate(() => document.getElementById('nav-profile')?.click());
  const nickname = page.locator('#profileNickname');
  await expect(nickname).toBeVisible();
  await expect(nickname).not.toHaveText('……');

  // Navigate to contacts
  await page.evaluate(() => document.getElementById('nav-contacts')?.click());
  await expect(page.locator('#contactsList')).toBeVisible();

  // Navigate to messages
  await page.evaluate(() => document.getElementById('nav-messages')?.click());
  await expect(page.locator('#messagesEmpty')).toBeVisible();

  // Return to drive before opening user menu
  await page.evaluate(() => document.getElementById('nav-drive')?.click());
  await expect(page.locator('#nav-drive')).toHaveClass(/active/);

  // Open settings from user menu
  await page.evaluate(() => document.getElementById('btnUserMenu')?.click());
  await page.evaluate(() => document.querySelector('[data-action=\"settings\"]')?.click());
  const settingsModal = page.locator('.modal.settings-modal');
  await expect(settingsModal).toBeVisible();

  const showOnlineInput = page.locator('#settingsShowOnline');
  const autoLogoutInput = page.locator('#settingsAutoLogout');
  const initialShowOnline = await showOnlineInput.isChecked();
  const initialAutoLogout = await autoLogoutInput.isChecked();

  const expectSuccessfulSave = async (toggleAction) => {
    const responsePromise = page.waitForResponse((res) => res.url().includes('/api/v1/messages') && res.request().method() === 'POST');
    await toggleAction();
    const response = await responsePromise;
    expect(response.status(), `unexpected status ${response.status()} for ${response.url()}`).toBeGreaterThanOrEqual(200);
    expect(response.status(), `unexpected status ${response.status()} for ${response.url()}`).toBeLessThan(400);
  };

  await expectSuccessfulSave(() => showOnlineInput.click({ force: true }));
  await expectSuccessfulSave(() => autoLogoutInput.click({ force: true }));

  // Restore original state if changed
  const restoreTasks = [];
  const currentShowOnline = await showOnlineInput.isChecked();
  const currentAutoLogout = await autoLogoutInput.isChecked();
  if (currentShowOnline !== initialShowOnline) {
    restoreTasks.push(expectSuccessfulSave(() => showOnlineInput.click({ force: true })));
  }
  if (currentAutoLogout !== initialAutoLogout) {
    restoreTasks.push(expectSuccessfulSave(() => autoLogoutInput.click({ force: true })));
  }
  await Promise.all(restoreTasks);

  await page.click('#settingsClose');
  await expect(settingsModal).toBeHidden();
});
