import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const FAKE_AUDIO_PATH = path.resolve('tests/assets/fake-audio.wav');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  reporter: 'list',
  workers: 1,
  globalSetup: './tests/e2e/global-setup.mjs',
  projects: [
    {
      name: 'chromium',
      testMatch: ['tests/e2e/login-smoke.spec.mjs'],
      use: {
        ...devices['Desktop Chrome'],
        headless: true
      }
    },
    {
      name: 'webkit-mobile',
      use: {
        ...devices['iPhone 13 Pro'],
        headless: true
      },
      testIgnore: ['tests/e2e/call-audio.spec.mjs']
    },
    {
      name: 'chromium-call',
      testMatch: ['tests/e2e/call-audio.spec.mjs'],
      use: {
        ...devices['Pixel 5'],
        headless: true,
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            `--use-file-for-fake-audio-capture=${FAKE_AUDIO_PATH}`
          ]
        }
      }
    }
  ]
});
