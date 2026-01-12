import { test, expect } from '@playwright/test';

const baseUrl = (process.env.E2E_BASE_URL || 'http://localhost:8788').replace(/\/$/, '');
const loginUrl = `${baseUrl}/pages/login?e2e=1&api=http://localhost:3002`;
const TARGET_ENDPOINTS = [
  '/api/v1/mk/store',
  '/api/v1/auth/opaque/login-init',
  '/api/v1/auth/opaque/register-init',
  '/api/v1/auth/opaque/register-finish',
  '/api/v1/auth/opaque/login-finish'
];
const MAX_RESPONSES = 200;
const NETWORK_TAIL = 50;
const BODY_PREVIEW_LIMIT = 2048;

const findEndpointKey = (url) => TARGET_ENDPOINTS.find((endpoint) => url.includes(endpoint));
const safePathname = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

const formatLocation = (loc) => {
  if (!loc || !loc.url) return '';
  const line = typeof loc.lineNumber === 'number' ? `:${loc.lineNumber}` : '';
  const col = typeof loc.columnNumber === 'number' ? `:${loc.columnNumber}` : '';
  return `${loc.url}${line}${col}`;
};

const readBodyPreview = async (resp) => {
  try {
    const headers = typeof resp.headers === 'function' ? resp.headers() : {};
    const contentType = headers?.['content-type'] || headers?.['Content-Type'] || '';
    const raw = await resp.text();
    let bodyText = raw;
    if (contentType.includes('application/json')) {
      try {
        bodyText = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // keep raw bodyText if JSON parse fails
      }
    }
    const truncated = bodyText.length > BODY_PREVIEW_LIMIT
      ? `${bodyText.slice(0, BODY_PREVIEW_LIMIT)}\n<<truncated to ${BODY_PREVIEW_LIMIT} chars>>`
      : bodyText;
    return truncated;
  } catch (error) {
    return `<<failed to read body: ${error?.message || error}>>`;
  }
};

test.describe('login smoke (debug simulate)', () => {
  /** @type {{url:string, status:number, method:string, resource:string, pathname:string}[]} */
  let responses;
  /** @type {Map<string, {status:number, body:string, url:string}>} */
  let endpointBodies;
  /** @type {{text:string, location:string}[]} */
  let consoleErrors;
  /** @type {string[]} */
  let pageErrors;
  /** @type {Promise<void>[]} */
  let endpointBodyPromises;

  test.beforeEach(async ({ page }) => {
    responses = [];
    endpointBodies = new Map();
    consoleErrors = [];
    pageErrors = [];
    endpointBodyPromises = [];

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      consoleErrors.push({
        text: msg.text(),
        location: formatLocation(msg.location())
      });
    });

    page.on('pageerror', (error) => {
      const message = error?.stack || error?.message || String(error);
      pageErrors.push(message);
    });

    page.on('response', async (resp) => {
      try {
        const req = resp.request();
        const url = resp.url();
        responses.push({
          url,
          status: resp.status(),
          method: req.method(),
          resource: req.resourceType(),
          pathname: safePathname(url)
        });
        if (responses.length > MAX_RESPONSES) responses.shift();

        const endpointKey = findEndpointKey(url);
        if (!endpointKey) return;

        const capturePromise = (async () => {
          const body = await readBodyPreview(resp);
          endpointBodies.set(endpointKey, {
            status: resp.status(),
            body,
            url
          });
        })();
        endpointBodyPromises.push(capturePromise);
      } catch (err) {
        console.log(`response handler error: ${err?.message || err}`);
      }
    });
  });

  test.afterEach(async ({ page }, testInfo) => {
    const tracePath = testInfo.outputPath('trace.zip');
    await Promise.allSettled(endpointBodyPromises);

    if (testInfo.status === 'passed') return;

    const tail = responses.slice(-NETWORK_TAIL);
    console.log('--- current URL ---');
    try {
      console.log(page?.url() || '<no page url>');
    } catch (err) {
      console.log(`<<failed to read url: ${err?.message || err}>>`);
    }

    console.log('--- console errors ---');
    if (consoleErrors.length === 0) {
      console.log('none');
    } else {
      consoleErrors.forEach((entry, idx) => {
        const loc = entry.location ? ` @ ${entry.location}` : '';
        console.log(`${String(idx + 1).padStart(2, '0')}: ${entry.text}${loc}`);
      });
    }

    console.log('--- page errors ---');
    if (pageErrors.length === 0) {
      console.log('none');
    } else {
      pageErrors.forEach((msg, idx) => {
        console.log(`${String(idx + 1).padStart(2, '0')}: ${msg}`);
      });
    }

    console.log(`--- last ${tail.length} network responses ---`);
    tail.forEach((entry, idx) => {
      const hint = entry.url.includes('/api/v1/mk/store')
        ? '[mk/store]'
        : entry.url.includes('opaque')
          ? '[opaque]'
          : '';
      console.log(
        `${String(idx + 1).padStart(2, '0')}: ${entry.status} ${entry.method} ${entry.pathname} ${hint} ${entry.url}`
      );
    });

    console.log('--- endpoint bodies ---');
    TARGET_ENDPOINTS.forEach((endpoint) => {
      const bodyEntry = endpointBodies.get(endpoint);
      if (!bodyEntry) {
        console.log(`${endpoint}: no response captured`);
        return;
      }
      console.log(`${endpoint}: status=${bodyEntry.status} url=${bodyEntry.url}`);
      console.log(bodyEntry.body);
    });

    try {
      const screenshotPath = testInfo.outputPath('login-smoke-failure.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`screenshot: ${screenshotPath}`);
    } catch (err) {
      console.log(`screenshot failed: ${err?.message || err}`);
    }

    if (tracePath) {
      console.log(`trace: ${tracePath}`);
    } else {
      console.log('trace: <not captured - run with --trace=on to save trace.zip>');
    }
  });

  test('logs in via debug button and stores MK', async ({ page }) => {
    await page.goto(loginUrl, { waitUntil: 'networkidle' });

    await page.waitForFunction(() => !!window.debugSimulateLogin, { timeout: 15_000 });
    await page.evaluate(() => window.debugSimulateLogin());

    await page.waitForFunction(() => {
      const el = document.getElementById('sessionView');
      return !!el && typeof el.value === 'string' && el.value.length > 0;
    }, { timeout: 30_000 });

    const welcomeNext = page.locator('#welcomeNext');
    if (await welcomeNext.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await welcomeNext.click();
    }

    const password = `Pw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await page.locator('#pwd').fill(password);
    const confirmInput = page.locator('#pwdConfirm');
    if (await confirmInput.isVisible().catch(() => false)) {
      await confirmInput.fill(password);
    }

    const mkStoreResponsePromise = page.waitForResponse((resp) =>
      resp.url().includes('/api/v1/mk/store')
    );

    await page.locator('#btnUnlock').click();

    const mkStoreResponse = await mkStoreResponsePromise;
    expect(mkStoreResponse.ok(), `mk/store status=${mkStoreResponse.status()}`).toBeTruthy();

    await page.waitForURL(/\/pages\/app\.html/, { timeout: 60_000 });
    await page.waitForFunction(() => {
      try {
        const digest = sessionStorage.getItem('account_digest');
        return typeof digest === 'string' && digest.length > 0;
      } catch {
        return false;
      }
    }, { timeout: 10_000 });
  });
});
