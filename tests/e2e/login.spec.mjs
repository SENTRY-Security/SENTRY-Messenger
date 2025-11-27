import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { performLogin, startWebServer, stopWebServer, ensureDir, E2E_ARTIFACT_DIR } from './utils.mjs';

const INITIAL_PASSWORD = 'test1234';
const UPDATED_PASSWORD = 'test1234-change';
const SCREENSHOT_PATH = path.join(E2E_ARTIFACT_DIR, 'login', 'change-password-success.png');

let serverProc;
test.beforeAll(async () => {
  serverProc = await startWebServer();
});

test.afterAll(async () => {
  await stopWebServer(serverProc);
});

test('login flow supports password change and re-login (reload enforces logout)', async ({ page }) => {
  page.on('console', msg => {
    // eslint-disable-next-line no-console
    console.log('[console]', msg.type(), msg.text());
  });

  const uidHex = generateUidHex();
  await performLogin(page, { password: INITIAL_PASSWORD, uidHex });
  await changePasswordThroughSettings(page, {
    currentPassword: INITIAL_PASSWORD,
    newPassword: UPDATED_PASSWORD,
    screenshotPath: SCREENSHOT_PATH
  });
  await logoutFromApp(page);

  // 以新密碼重新登入驗證成功
  await performLogin(page, { password: UPDATED_PASSWORD, uidHex });

  // 將密碼改回預設值，避免污染後續測試帳號
  await changePasswordThroughSettings(page, {
    currentPassword: UPDATED_PASSWORD,
    newPassword: INITIAL_PASSWORD
  });
  await logoutFromApp(page);

  // 再次使用原密碼登入，確保流程恢復
  await performLogin(page, { password: INITIAL_PASSWORD, uidHex });
  await expect(page.locator('#nav-drive')).toBeVisible();
  await ensureAutoLogoutDisabled(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForURL('**/pages/logout.html', { timeout: 20000 });
});

function generateUidHex() {
  return randomBytes(7).toString('hex').toUpperCase();
}

async function changePasswordThroughSettings(page, { currentPassword, newPassword, screenshotPath }) {
  await page.waitForSelector('#btnUserMenu', { timeout: 5000 });
  await page.locator('#btnUserMenu').click();
  await page.waitForSelector('[data-action="settings"]', { timeout: 5000 });
  await page.click('[data-action="settings"]');
  const settingsModal = page.locator('.modal.settings-modal');
  await expect(settingsModal).toBeVisible();

  const changeBtn = page.locator('#settingsChangePassword');
  await expect(changeBtn).toBeVisible();
  await changeBtn.click();

  const changeModal = page.locator('.modal.change-password-modal');
  await expect(changeModal).toBeVisible();
  await page.fill('#currentPassword', currentPassword);
  await page.fill('#newPassword', newPassword);
  await page.fill('#confirmPassword', newPassword);
  await page.click('#changePasswordSubmit');

  const status = page.locator('#changePasswordStatus');
  await expect(status).toContainText('密碼已更新', { timeout: 20000 });

  if (screenshotPath) {
    await ensureDir(path.dirname(screenshotPath));
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }

  await changeModal.waitFor({ state: 'hidden', timeout: 7000 });
  const closeBtn = page.locator('#settingsClose');
  if (await closeBtn.isVisible()) {
    await closeBtn.click();
  }
  await settingsModal.waitFor({ state: 'hidden', timeout: 5000 });
}

async function logoutFromApp(page) {
  await page.evaluate(() => document.getElementById('nav-drive')?.click());
  await page.waitForSelector('#btnUserMenu', { timeout: 5000 });
  await page.locator('#btnUserMenu').click();
  await page.waitForSelector('[data-action="logout"]', { timeout: 5000 });
  await page.click('[data-action="logout"]');
  await page.waitForURL('**/pages/logout.html', { timeout: 20000 });
}

async function ensureAutoLogoutDisabled(page) {
  await page.waitForSelector('#btnUserMenu', { timeout: 5000 });
  await page.locator('#btnUserMenu').click();
  await page.waitForSelector('[data-action="settings"]', { timeout: 5000 });
  await page.click('[data-action="settings"]');
  const settingsModal = page.locator('.modal.settings-modal');
  await expect(settingsModal).toBeVisible();
  const autoLogoutToggle = page.locator('#settingsAutoLogout');
  if (await autoLogoutToggle.isChecked()) {
    await autoLogoutToggle.click();
    await expect(autoLogoutToggle).toBeDisabled({ timeout: 1000 });
    await expect(autoLogoutToggle).toBeEnabled({ timeout: 10000 });
  }
  await expect(autoLogoutToggle).not.toBeChecked();
  const closeBtn = page.locator('#settingsClose');
  if (await closeBtn.isVisible()) {
    await closeBtn.click();
  }
  await settingsModal.waitFor({ state: 'hidden', timeout: 7000 });
  const menu = page.locator('#userMenuDropdown');
  if (await menu.isVisible()) {
    await page.locator('#btnUserMenu').click().catch(() => {});
  }
}
