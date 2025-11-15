import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  reporter: 'list',
  workers: 1,
  globalSetup: './tests/e2e/global-setup.mjs',
  projects: [
    {
      name: 'webkit-mobile',
      use: {
        ...devices['iPhone 13 Pro'],
        headless: true
      }
    }
  ]
});
