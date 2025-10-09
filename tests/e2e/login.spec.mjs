import { test } from '@playwright/test';
import { performLogin, startWebServer, stopWebServer } from './utils.mjs';

let serverProc;
test.beforeAll(async () => {
  serverProc = await startWebServer();
});

test.afterAll(async () => {
  await stopWebServer(serverProc);
});

test('login flow redirects to app screen', async ({ page }) => {
  page.on('console', msg => {
    // eslint-disable-next-line no-console
    console.log('[console]', msg.type(), msg.text());
  });

  await performLogin(page);
});
