import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';

export const ORIGIN = process.env.E2E_ORIGIN_API || process.env.ORIGIN_API || 'http://127.0.0.1:3000';
export const WEB_PORT = Number(process.env.E2E_WEB_PORT || 8788);
export const ARTIFACTS_ROOT = path.resolve('artifacts');
export const E2E_ARTIFACT_DIR = path.join(ARTIFACTS_ROOT, 'e2e');

const normalizeAccountDigest = (digest) => {
  if (!digest) return null;
  const cleaned = String(digest).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned && cleaned.length === 64 ? cleaned : null;
};

export const buildContactSecretsKey = (accountDigest) => {
  const normalized = normalizeAccountDigest(accountDigest);
  return normalized ? `contactSecrets-v1:acct-${normalized}` : 'contactSecrets-v1';
};

export const buildContactSecretsLatestKey = (accountDigest) => {
  const normalized = normalizeAccountDigest(accountDigest);
  return normalized ? `contactSecrets-v1-latest:acct-${normalized}` : 'contactSecrets-v1-latest';
};

async function waitForHealthz(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume();
          res.once('end', () => (res.statusCode === 200 ? resolve() : reject(new Error('bad status'))));
        });
        req.on('error', reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('healthz timeout');
}

export async function startWebServer() {
  const proc = spawn(process.execPath, ['scripts/serve-web.mjs'], {
    env: { ...process.env, PORT: String(WEB_PORT), E2E_ORIGIN_API: ORIGIN },
    stdio: 'inherit'
  });
  await waitForHealthz(`http://localhost:${WEB_PORT}/__healthz`, 10000);
  return proc;
}

export async function stopWebServer(proc) {
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
  }
}

async function removeIfExists(targetPath) {
  if (!targetPath) return;
  const absPath = path.resolve(targetPath);
  try {
    await fs.rm(absPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export async function clearE2EArtifacts() {
  await Promise.all([
    removeIfExists(E2E_ARTIFACT_DIR),
    removeIfExists(path.join(ARTIFACTS_ROOT, 'screenshots')),
    removeIfExists('playwright-report'),
    removeIfExists('test-results')
  ]);
}

export async function ensureDir(targetPath) {
  if (!targetPath) return;
  const absPath = path.resolve(targetPath);
  await fs.mkdir(absPath, { recursive: true });
}

export async function performLogin(page, { password = 'test1234', accountDigest, uidHex, contactSecretsSnapshot } = {}) {
  const identityForSecrets = accountDigest || uidHex || null;
  const contactKey = buildContactSecretsKey(identityForSecrets);
  const latestKey = buildContactSecretsLatestKey(identityForSecrets);
  await page.addInitScript(() => {
    try {
      window.__DEBUG_CONTACT_SECRETS__ = true;
    } catch {}
  });
  if (contactSecretsSnapshot) {
    await page.addInitScript(({ snapshot, contactKey: key, latestKey: latest }) => {
      try {
        window.__LOGIN_SEED_LOCALSTORAGE = window.__LOGIN_SEED_LOCALSTORAGE || {};
        if (key) window.__LOGIN_SEED_LOCALSTORAGE[key] = snapshot;
        window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1'] = snapshot;
        if (latest) window.__LOGIN_SEED_LOCALSTORAGE[latest] = snapshot;
        window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1-latest'] = snapshot;
      } catch {}
    }, { snapshot: contactSecretsSnapshot, contactKey, latestKey });
  }
  await page.addInitScript(({ contactKey: key }) => {
    try {
      window.__LOGIN_SEED_LOCALSTORAGE = window.__LOGIN_SEED_LOCALSTORAGE || {};
      window.__LOGIN_SEED_LOCALSTORAGE['ntag424-sim:forceDebug'] = '1';
      const snapshot = (key && window.__LOGIN_SEED_LOCALSTORAGE[key]) || window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1'];
      if (snapshot) {
        if (key) localStorage.setItem(key, snapshot);
        localStorage.setItem('contactSecrets-v1', snapshot);
      } else {
        if (key) localStorage.removeItem(key);
        localStorage.removeItem('contactSecrets-v1');
      }
    } catch {}
  }, { contactKey });
  if (uidHex) {
    await page.addInitScript((uid) => {
      try {
        window.__LOGIN_SEED_LOCALSTORAGE = window.__LOGIN_SEED_LOCALSTORAGE || {};
        window.__LOGIN_SEED_LOCALSTORAGE['ntag424-sim:debug-kit'] = JSON.stringify({ uidHex: uid });
      } catch {}
    }, uidHex);
  } else {
    await page.addInitScript(() => {
      try { localStorage.removeItem('ntag424-sim:debug-kit'); } catch {}
    });
  }

  await page.goto(`http://localhost:${WEB_PORT}/pages/login.html`, { waitUntil: 'domcontentloaded' });

  const simBtn = page.locator('#btnSimDebug');
  await simBtn.waitFor({ state: 'visible' });
  await simBtn.click();

  await page.waitForFunction(() => {
    const el = document.getElementById('sessionView');
    return !!el && !!el.value && el.value.length > 0;
  }, null, { timeout: 15000 });

  const welcomeModal = page.locator('#welcomeModal');
  const hasWelcome = await welcomeModal.evaluate((n) => n && !n.classList.contains('hidden'));

  await page.fill('#pwd', password);
  if (hasWelcome) {
    await page.click('#welcomeNext');
    await page.fill('#pwdConfirm', password);
  }
  await expect(page.locator('#btnUnlock')).toBeEnabled();

  const closeModalIfPresent = async () => {
    const isShown = await page.evaluate(() => {
      const m = document.getElementById('loginModal');
      return !!(m && !m.classList.contains('hidden'));
    });
    if (!isShown) return;
    const closeBtn = page.locator('#loginModalClose');
    if (await closeBtn.isVisible()) {
      await closeBtn.click({ trial: false }).catch(() => {});
    } else {
      const backdrop = page.locator('#loginModalBackdrop');
      if (await backdrop.isVisible()) {
        await backdrop.click({ trial: false }).catch(() => {});
      }
    }
    await page.waitForTimeout(100);
  };
  await closeModalIfPresent();

  await page.click('#btnUnlock');

  try {
    await page.waitForURL('**/pages/app.html', { timeout: 30000 });
  } catch (e) {
    const outText = await page.locator('#out').textContent().catch(() => null);
    const modalText = await page.locator('#loginModalBody').textContent().catch(() => null);
    // eslint-disable-next-line no-console
    console.log('[debug] out=', outText);
    console.log('[debug] modal=', modalText);
    throw e;
  }

  await expect(page.locator('#nav-drive')).toBeVisible();

  const cleared = await page.evaluate(() => (
    sessionStorage.getItem('mk_b64') === null &&
    sessionStorage.getItem('account_digest') === null &&
    sessionStorage.getItem('account_token') === null
  ));
  expect(cleared).toBeTruthy();

  await page.evaluate(({ contactKey: key }) => {
    try {
      const snapshot = (key && localStorage.getItem(key)) || localStorage.getItem('contactSecrets-v1');
      if (snapshot) {
        window.__LOGIN_SEED_LOCALSTORAGE = window.__LOGIN_SEED_LOCALSTORAGE || {};
        if (key) window.__LOGIN_SEED_LOCALSTORAGE[key] = snapshot;
        window.__LOGIN_SEED_LOCALSTORAGE['contactSecrets-v1'] = snapshot;
      }
    } catch {}
  }, { contactKey });
}
