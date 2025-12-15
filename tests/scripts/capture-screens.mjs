#!/usr/bin/env node
// Capture key UI screenshots for the login/app flow.

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startWebServer, stopWebServer, performLogin } from '../e2e/utils.mjs';
import { setupFriendConversation } from './lib/friends-flow.mjs';

const ORIGIN_API = (process.env.ORIGIN_API || 'http://127.0.0.1:3000').replace(/\/$/, '');

const OUTPUT_DIR = path.resolve('artifacts/screenshots');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function captureScreens() {
  await ensureDir(OUTPUT_DIR);

  const server = await startWebServer();

  const { userA, userB, conversation } = await setupFriendConversation({
    origin: ORIGIN_API,
    messageFromA: 'hello from user A',
    messageFromB: 'reply from user B'
  });

  const browser = await chromium.launch();
  const viewport = { width: 1440, height: 900 };

  const contextA = await browser.newContext({ viewport });
  const pageA = await contextA.newPage();

  try {
    await performLogin(pageA, { password: userA.password, uidHex: userA.uidHex });
    await pageA.waitForTimeout(1000);
    await pageA.screenshot({ path: path.join(OUTPUT_DIR, '01_app_drive.png'), fullPage: true });

    await pageA.evaluate(() => document.getElementById('nav-contacts')?.click());
    await pageA.waitForSelector('.contact-item', { timeout: 10000 });
    await pageA.waitForTimeout(500);
    await pageA.screenshot({ path: path.join(OUTPUT_DIR, '02_contacts_friend.png'), fullPage: true });

    await pageA.locator('.contact-item').first().click();
    await pageA.waitForSelector('#messagesList li', { timeout: 10000 });
    await pageA.waitForTimeout(500);
    await pageA.screenshot({ path: path.join(OUTPUT_DIR, '03_messages_thread_userA.png'), fullPage: true });

    await pageA.evaluate(() => document.getElementById('nav-drive')?.click());
    await pageA.waitForTimeout(500);
    await pageA.evaluate(() => document.getElementById('btnUserMenu')?.click());
    await pageA.evaluate(() => document.querySelector('[data-action="settings"]')?.click());
    await pageA.waitForTimeout(800);
    await pageA.screenshot({ path: path.join(OUTPUT_DIR, '04_settings_modal.png'), fullPage: true });

    await pageA.evaluate(() => document.getElementById('settingsClose')?.click());
    await contextA.close();

    const contextB = await browser.newContext({ viewport });
    const pageB = await contextB.newPage();
    await performLogin(pageB, { password: userB.password, uidHex: userB.uidHex });
    await pageB.waitForTimeout(1000);
    await pageB.evaluate(() => document.getElementById('nav-messages')?.click());
    await pageB.waitForTimeout(400);
    const firstThread = pageB.locator('.conversation-item').first();
    await firstThread.click();
    await pageB.waitForSelector('#messagesList li', { timeout: 10000 });
    await pageB.waitForTimeout(500);
    await pageB.screenshot({ path: path.join(OUTPUT_DIR, '05_messages_thread_userB.png'), fullPage: true });
    await contextB.close();
  } finally {
    await browser.close();
    await stopWebServer(server);
  }

  console.log(`Screenshots saved to ${OUTPUT_DIR}`);
}

captureScreens().catch((err) => {
  console.error('CAPTURE FAILED:', err?.message || err);
  process.exit(1);
});
