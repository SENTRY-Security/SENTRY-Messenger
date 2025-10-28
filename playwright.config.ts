import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  reporter: 'list',
  workers: 1,
  globalSetup: './tests/e2e/global-setup.mjs',
  projects: [
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 5'],
        headless: true,
      }
    }
  ]
});
