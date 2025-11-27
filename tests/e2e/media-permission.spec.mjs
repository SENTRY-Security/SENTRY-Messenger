import { test, expect } from '@playwright/test';
import { startWebServer, stopWebServer } from './utils.mjs';

let serverProc;
test.beforeAll(async () => {
  serverProc = await startWebServer();
});

test.afterAll(async () => {
  await stopWebServer(serverProc);
});

test.describe('media permission debug page', () => {
  test('shows overlay and closes after simulated allow', async ({ page }) => {
    await page.goto('http://localhost:8788/pages/mic-test.html', { waitUntil: 'load' });
    const overlay = page.locator('#mediaPermissionOverlay');
    await expect(overlay).toBeVisible();
    const status = page.locator('#mediaPermissionStatus');
    await expect(status).toBeEmpty();

    await page.evaluate(() => {
      navigator.mediaDevices = navigator.mediaDevices || {};
      navigator.mediaDevices.getUserMedia = () => Promise.resolve({ getTracks: () => [] });
      navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
        { kind: 'audioinput', label: 'Mock Mic' }
      ]);
      navigator.permissions = {
        query: async () => ({ state: 'granted' })
      };
      window.AudioContext = function AudioContextMock() {
        this.resume = () => Promise.resolve();
        this.close = () => Promise.resolve();
        this.createBuffer = () => ({ });
        this.createBufferSource = () => ({
          connect: () => {},
          start: () => {}
        });
      };
    });

    await page.click('#mediaPermissionAllowBtn');
    await expect(status).toContainText('授權成功', { timeout: 5000 });
    await overlay.waitFor({ state: 'hidden', timeout: 5000 });
  });
});
